#!/usr/bin/env node
// Codex backend for the shared skill-eval case format. One app-server owns
// authentication for all cases and judges; only bounded read-only dynamic
// tools are exposed. No model-generated command, network call or write runs.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCases } from "./skill-evals-engine.mjs";
export { readTools, TOOLS } from "./skill-evals-tools.mjs";

export const DEFAULT_MODEL = "gpt-6.1-sol";
// Standard list prices, USD/1M tokens, verified 2026-11-06 against
// https://developers.openai.com/api/docs/models/gpt-6.1-sol . These are an
// experiment budget estimate, not subscription billing or remaining quota.
const PRICES = { "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 } };
// A subscription quota stop is a provider limit, not a grading failure: callers
// (e.g. LCARS) may rerun the same committed suite on another harness.
const PROVIDER_LIMIT =
  /\b(?:usage limit|rate limit|quota)\b|usageLimitExceeded|insufficient_quota/i;

export function codexTurnError(turn) {
  const detail = String(turn.error?.message ?? "")
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      "[redacted]",
    )
    .slice(0, 500);
  const error = Error(
    `Codex turn ${turn.status}${detail ? ": " + detail : ""}`,
  );
  const info = turn.error?.codexErrorInfo;
  if (
    PROVIDER_LIMIT.test(detail) ||
    PROVIDER_LIMIT.test(typeof info === "string" ? info : JSON.stringify(info ?? ""))
  )
    error.providerLimit = true;
  return error;
}

export function tokenCost(usage, model) {
  if (!PRICES[model])
    throw Error(`No reviewed cost estimate for Codex model ${model}`);
  if (
    !usage ||
    !["inputTokens", "cachedInputTokens", "outputTokens"].every(
      (k) => Number.isSafeInteger(usage[k]) && usage[k] >= 0,
    ) ||
    usage.cachedInputTokens > usage.inputTokens
  )
    throw Error("Codex did not report valid token usage");
  const p = PRICES[model];
  return (
    ((usage.inputTokens - usage.cachedInputTokens) * p.input +
      usage.cachedInputTokens * p.cached +
      usage.outputTokens * p.output) /
    1e6
  );
}
export function parseOptions(args) {
  const out = {
    model: DEFAULT_MODEL,
    judgeModel: DEFAULT_MODEL,
    concurrency: 1,
    threshold: 1,
    maxCostUsd: 12,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i],
      v = () => {
        if (++i >= args.length) throw Error(`${a} needs a value`);
        return args[i];
      };
    if (a === "--model") out.model = v();
    else if (a === "--judge-model") out.judgeModel = v();
    else if (a === "--max-cost-usd") out.maxCostUsd = Number(v());
    else if (a === "-j" || a === "--concurrency") out.concurrency = Number(v());
    else if (a === "--threshold") out.threshold = Number(v());
    else if (a === "--case") out.case = v();
    else if (a === "--ablation") {
      if (v() !== "none")
        throw Error("Codex evals currently support --ablation none only");
    } else if (a === "--keep-temp") {
      /* all traces are retained by the shared history */
    } else throw Error(`Unsupported Codex eval option: ${a}`);
  }
  for (const m of [out.model, out.judgeModel])
    if (!PRICES[m])
      throw Error(`No reviewed cost estimate for Codex model ${m}`);
  if (
    !Number.isFinite(out.maxCostUsd) ||
    out.maxCostUsd <= 0 ||
    !Number.isInteger(out.concurrency) ||
    out.concurrency < 1 ||
    out.concurrency > 2 ||
    !Number.isFinite(out.threshold) ||
    out.threshold < 0 ||
    out.threshold > 1
  )
    throw Error("Invalid Codex budget, concurrency (1-2), or threshold");
  return out;
}
export class CodexClient {
  constructor({ env = process.env, start = spawn } = {}) {
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 0;
    // Caller supplies authentication in CODEX_HOME. An empty config is
    // required: never inherit workstation hooks, plugins or MCP servers.
    if (!env.CODEX_HOME || existsSync(path.join(env.CODEX_HOME, "config.toml")))
      throw Error(
        "Codex evals require a dedicated CODEX_HOME containing auth only, without config.toml",
      );
    const flags = [
      "view_image",
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "multi_agent",
      "computer_use",
      "image_generation",
      "goals",
      "hooks",
      "memories",
      "skill_search",
      "browser_use",
      "in_app_browser",
    ];
    const cleanEnv = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "CODEX_HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
      ]
        .filter((k) => env[k] !== undefined)
        .map((k) => [k, env[k]]),
    );
    this.child = start(
      "codex",
      [
        "app-server",
        ...flags.flatMap((f) => ["-c", `features.${f}=false`]),
        "-c",
        'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "mcp_servers={}",
        "-c",
        "features.skip_host_skill_discovery=true",
      ],
      { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdin.on("error", () => this.fail(Error("Codex transport closed")));
    this.child.stderr.resume(); // credential-bearing provider diagnostics never reach reports
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(Error("Invalid Codex protocol response"));
        return;
      }
      try { this.message(message); }
      catch (error) { this.fail(error); }
    });
    this.child.on("error", () =>
      this.fail(Error("Could not start Codex app-server")),
    );
    this.child.on("exit", () => this.fail(Error("Codex app-server exited")));
  }
  send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  request(method, params) {
    if (this.dead || this.child.exitCode !== null) return Promise.reject(Error("Codex app-server is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Codex ${method} timed out`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const t of this.turns.values()) t.reject(error);
    this.turns.clear();
  }
  message(m) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(Error(`Codex request rejected (${m.error.code})`));
      else p.resolve(m.result);
      return;
    }
    const t = this.turns.get(m.params?.threadId);
    if (m.id !== undefined) {
      if (m.method !== "item/tool/call" || !t) {
        this.send({
          id: m.id,
          error: { code: -32601, message: "Unsupported eval request" },
        });
        return;
      }
      const { tool, arguments: args } = m.params;
      let output,
        success = true,
        event;
      try {
        if (++t.calls > t.maxCalls)
          throw Error("Eval tool-call limit exceeded");
        output = t.tools.call(tool, args);
        event = { tool, arguments: args, output };
      } catch (e) {
        output = e.message;
        success = false;
        event = { tool, arguments: args, error: output };
      }
      t.record(event);
      this.send({
        id: m.id,
        result: {
          contentItems: [{ type: "inputText", text: output }],
          success,
        },
      });
      if (t.calls > t.maxCalls) {
        t.reject(Error("Eval tool-call limit exceeded"));
        this.request("turn/interrupt", {
          threadId: t.threadId,
          turnId: t.turnId,
        }).catch(() => {});
      }
    } else if (
      t &&
      m.method === "item/completed" &&
      m.params.item?.type === "agentMessage"
    )
      t.answer = m.params.item.text;
    else if (t && m.method === "thread/tokenUsage/updated")
      t.usage = m.params.tokenUsage.total;
    else if (t && m.method === "turn/completed") {
      if (m.params.turn.status !== "completed")
        t.reject(codexTurnError(m.params.turn));
      else
        t.resolve({ answer: t.answer ?? "", trace: t.trace, usage: t.usage });
    }
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "repo-skill-evals", version: "1" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  async run({
    cwd,
    model,
    prompt,
    tools,
    instructions,
    maxCalls = 8,
    timeout = 600,
    outputSchema,
    evidenceFile,
  }) {
    if (evidenceFile) writeFileSync(evidenceFile, "", { mode: 0o600 });
    const response = await this.request("thread/start", {
      cwd,
      model,
      modelProvider: "openai",
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
      dynamicTools: tools?.definitions ?? [],
      allowProviderModelFallback: false,
    });
    if (response.model !== model)
      throw Error("Codex resolved a different model");
    const threadId = response.thread.id;
    let timer;
    const trace = [];
    try {
      const done = new Promise((resolve, reject) => {
        this.turns.set(threadId, {
          threadId,
          resolve,
          reject,
          tools,
          trace,
          record(event) {
            trace.push(event);
            if (evidenceFile)
              appendFileSync(evidenceFile, JSON.stringify(event) + "\n");
          },
          maxCalls,
          calls: 0,
        });
        timer = setTimeout(
          () => reject(Error("Codex eval timed out")),
          timeout * 1000,
        );
      });
      // Consume early process failure while the start acknowledgement is in flight.
      done.catch(() => {});
      const turn = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        effort: "low",
        ...(outputSchema ? { outputSchema } : {}),
      });
      this.turns.get(threadId).turnId = turn.turn.id;
      return await done;
    } catch (error) {
      // Keep the actual failed call sequence before the turn is discarded.
      // Provider failures remain errors, with unknown total cost and no score.
      error.trace = [...trace];
      error.answer = this.turns.get(threadId)?.answer;
      error.usage = this.turns.get(threadId)?.usage;
      if (evidenceFile)
        appendFileSync(
          evidenceFile,
          JSON.stringify({ error: error.message, usage: error.usage }) + "\n",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      this.turns.delete(threadId);
      if (!this.dead && this.child.exitCode === null) await this.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }
  async close() {
    if (this.child.exitCode !== null) {
      this.lines.close();
      return;
    }
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.lines.close();
  }
}
export async function evaluate(plugin, resultsFile, options, dependencies = {}) {
  return evaluateCases(plugin, resultsFile, options, { createClient: () => new CodexClient(), cost: tokenCost, provider: "codex", ...dependencies });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [plugin, file, ...args] = process.argv.slice(2);
  try {
    process.exitCode = await evaluate(plugin, file, parseOptions(args));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

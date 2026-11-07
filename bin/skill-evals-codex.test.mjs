// Observable consumer contract: Codex evals preserve real trigger/criteria
// evidence, errors, cost ceilings and provider-specific cache identities.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluate,
  parseOptions,
  readTools,
  tokenCost,
  CodexClient,
} from "./skill-evals-codex.mjs";
import { experimentKey, main, parseArgs } from "./skill-evals.mjs";
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-skill-evals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, "plugin"),
    caseDir = path.join(plugin, "evals", "triage--one");
  mkdirSync(path.join(plugin, "skills", "triage"), { recursive: true });
  mkdirSync(path.join(caseDir, "resources"), { recursive: true });
  writeFileSync(
    path.join(plugin, "skills", "triage", "SKILL.md"),
    "---\nname: triage\ndescription: Triage failing probes.\n---\nAsk for the failing unit and propose journalctl.",
  );
  writeFileSync(path.join(caseDir, "resources", "probe.log"), "probe failed");
  const spec = {
    name: "triage--one",
    runs: 1,
    execution: {
      prompt: "How to inspect a failing probe?",
      allowed_tools: ["Skill", "Read", "Glob", "Grep"],
      max_turns: 3,
      timeout_seconds: 10,
    },
    graders: [
      {
        name: "skill-fired",
        type: "tool_used",
        input_match: '"skill"\\s*:\\s*"triage"',
      },
      {
        name: "criteria",
        type: "llm",
        criteria: "Proposes journalctl and names the unit.",
      },
    ],
  };
  writeFileSync(path.join(caseDir, "case.yaml"), JSON.stringify(spec));
  const file = path.join(dir, "results.json");
  return { dir, plugin, caseDir, spec, file };
}
const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 };
test("only copied skills and fixtures can be read; gated tools and symlink escapes are refused", (t) => {
  const f = fixture(t),
    tools = readTools(f.plugin, f.caseDir);
  assert.match(tools.catalog, /triage: Triage/);
  assert.match(tools.call("Skill", { skill: "triage" }), /journalctl/);
  const loaded = tools.call("Skill", { skill: "triage" });
  assert.match(loaded, /skills\/triage\/SKILL\.md/);
  assert.match(loaded, /resources\/probe\.log/);
  assert.match(loaded, /source repository checkout.*not supplied/);
  assert.throws(
    () => tools.call("Read", { path: "../../../docs/deployment.md" }),
    /not supplied.*isolated eval[\s\S]*Available copied files/,
  );
  assert.equal(
    tools.call("Read", { path: "resources/probe.log" }),
    "probe failed",
  );
  assert.throws(() => tools.call("Read", { path: "/etc/passwd" }), /outside/);
  assert.throws(() => readTools(f.plugin, f.caseDir, ["Bash"]), /read-only/);
  symlinkSync("/etc/passwd", path.join(f.caseDir, "resources", "escape"));
  assert.throws(() => readTools(f.plugin, f.caseDir), /escapes/);
});

test("failed Codex calls retain their exact partial trace and enforce the existing eight-call limit", async (t) => {
  const {PassThrough, Writable} = await import('node:stream');
  const {EventEmitter} = await import('node:events');
  const f = fixture(t), evidenceFile = path.join(f.dir, 'failed.native.jsonl');
  let nextCall = 0, interrupts = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const emit = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  const toolCall = () => emit({id: 100 + ++nextCall, method: 'item/tool/call', params: {threadId: 'thread-one', tool: 'Skill', arguments: {skill: 'triage'}}});
  child.stdin = new Writable({write(chunk, encoding, done) {
    const message = JSON.parse(String(chunk));
    queueMicrotask(() => {
      if (message.method === 'initialize') emit({id: message.id, result: {}});
      else if (message.method === 'thread/start') emit({id: message.id, result: {model: 'gpt-6.1-sol', thread: {id: 'thread-one'}}});
      else if (message.method === 'turn/start') {
        emit({id: message.id, result: {turn: {id: 'turn-one'}}});
        queueMicrotask(toolCall);
      } else if (message.method === 'turn/interrupt') {
        interrupts++; emit({id: message.id, result: {}});
      } else if (message.method === 'thread/unsubscribe') emit({id: message.id, result: {}});
      else if (message.id >= 100 && message.result?.success) queueMicrotask(toolCall);
    });
    done();
  }});
  child.stdin.on('finish', () => queueMicrotask(() => {child.exitCode = 0; child.emit('exit', 0); child.stdout.end();}));
  const client = new CodexClient({env: {CODEX_HOME: f.dir}, start: () => child});
  try {
    await client.initialize();
    let failure;
    await assert.rejects(client.run({cwd: f.caseDir, model: 'gpt-6.1-sol', prompt: 'Use the skill', tools: readTools(f.plugin, f.caseDir), maxCalls: 8, evidenceFile}), error => {
      failure = error; return error.message === 'Eval tool-call limit exceeded';
    });
    assert.equal(nextCall, 9);
    assert.equal(interrupts, 1);
    assert.equal(failure.trace.length, 9);
    assert.equal(failure.trace[8].error, 'Eval tool-call limit exceeded');
    const evidence = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(evidence.slice(0, 9), failure.trace);
    assert.equal(evidence.at(-1).error, failure.message);
  } finally { await client.close(); }
});

test("an errored case replaces stale evidence with its partial trace without scoring or retrying", async (t) => {
  const f = fixture(t), tracePath = path.join(f.dir, 'triage--one-1.trace.jsonl');
  writeFileSync(tracePath, 'stale successful evidence\n');
  const trace = [{tool: 'Skill', arguments: {skill: 'triage'}, output: 'actual skill'}, {tool: 'Read', arguments: {path: 'missing'}, error: 'not supplied'}];
  let calls = 0;
  const client = {async initialize() {}, async close() {}, async run(input) {
    calls++; assert.equal(input.maxCalls, 3);
    assert.match(input.instructions, /isolated workspace, not its source repository/);
    assert.match(input.instructions, /at most 3 tool calls.*including Skill and failed requests/);
    throw Object.assign(Error('Eval tool-call limit exceeded'), {trace});
  }};
  assert.equal(await evaluate(f.plugin, f.file, parseOptions([]), {client}), 2);
  const result = JSON.parse(readFileSync(f.file));
  assert.equal(calls, 1);
  assert.equal(result.partial, true);
  assert.equal(result.costUsd, null);
  assert.equal(result.cases[0].aggregates.score, undefined);
  const evidence = readFileSync(result.cases[0].arms.with[0].tracePath, 'utf8');
  assert.doesNotMatch(evidence, /stale successful/);
  assert.deepEqual(evidence.trim().split('\n').map(JSON.parse).slice(0, 2), trace.map(event => ({phase: 'case', ...event})));
});

test("a judge failure preserves the completed case evidence and stays unscored", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const client = {async initialize() {}, async close() {}, async run(input) {
    calls++;
    if (input.outputSchema) throw Object.assign(Error('judge unavailable'), {trace: []});
    return {answer: 'original case answer', trace: [{tool: 'Skill', arguments: {skill: 'triage'}, output: 'actual skill'}], usage};
  }};
  assert.equal(await evaluate(f.plugin, f.file, parseOptions([]), {client}), 2);
  const result = JSON.parse(readFileSync(f.file));
  assert.equal(calls, 2);
  assert.equal(result.costUsd, null);
  assert.equal(result.cases[0].aggregates.score, undefined);
  const evidence = readFileSync(result.cases[0].arms.with[0].tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(evidence[0].tool, 'Skill');
  assert.equal(evidence[1].answer, 'original case answer');
  assert.equal(evidence.at(-1).phase, 'judge');
  assert.equal(evidence.at(-1).error, 'judge unavailable');
});
test("budget/model options reject silent widening and preserve both case and judge identity", () => {
  assert.equal(parseArgs(["--runner", "codex"]).runner, "codex");
  assert.throws(
    () => parseOptions(["--ablation", "with-without"]),
    /none only/,
  );
  assert.throws(() => parseOptions(["--model", "unknown"]), /cost estimate/);
  assert.throws(() => parseOptions(["-j", "8"]), /concurrency/);
  const base = {
    skill: [],
    spec: {},
    fixtures: [],
    claudeVersion: "same",
    model: "same",
    toolsVersion: "same",
  };
  assert.notEqual(
    experimentKey(base),
    experimentKey({ ...base, runner: "codex", judgeModel: "same" }),
  );
  assert.notEqual(
    experimentKey({ ...base, runner: "codex", judgeModel: "same" }),
    experimentKey({ ...base, runner: "codex", judgeModel: "other" }),
  );
  assert.equal(tokenCost(usage, "gpt-6.1-sol"), 0.00262);
  assert.throws(() => tokenCost(null, "gpt-6.1-sol"), /valid token usage/);
});
test("actual trigger evidence and independent judge verdict map into the existing result/report contract", async (t) => {
  const f = fixture(t);
  let calls = 0,
    closed = false;
  const client = {
    async initialize() {},
    async run(input) {
      calls++;
      if (input.outputSchema) {
        assert.match(input.prompt, /"tool":"Skill"/);
        return {
          answer: JSON.stringify({
            passed: true,
            explanation: "Actual plan names the unit and journalctl.",
          }),
          usage,
        };
      }
      const output = input.tools.call("Skill", { skill: "triage" });
      return {
        answer: "Inspect probe.service using journalctl -u probe.service",
        trace: [{ tool: "Skill", arguments: { skill: "triage" }, output }],
        usage,
      };
    },
    async close() {
      closed = true;
    },
  };
  assert.equal(
    await evaluate(f.plugin, f.file, parseOptions([]), { client }),
    0,
  );
  assert.equal(calls, 2);
  assert.equal(closed, true);
  const result = JSON.parse(readFileSync(f.file));
  assert.equal(result.cases[0].aggregates.score, 1);
  assert.equal(result.cases[0].arms.with[0].graders.length, 2);
  assert.equal(result.costUsd, 0.00524);
});
test("provider errors never become scores and stop further paid cases; missing usage is an error", async (t) => {
  const f = fixture(t);
  f.spec.runs = 3;
  writeFileSync(path.join(f.caseDir, 'case.yaml'), JSON.stringify(f.spec));
  let calls = 0;
  const client = {
    async initialize() {},
    async run() {
      calls++;
      throw Error("provider capacity unavailable");
    },
    async close() {},
  };
  assert.equal(
    await evaluate(f.plugin, f.file, parseOptions([]), { client }),
    2,
  );
  const result = JSON.parse(readFileSync(f.file));
  assert.equal(result.cases[0].aggregates.score, undefined);
  assert.equal(
    result.cases[0].arms.with[0].error,
    "provider capacity unavailable",
  );
  assert.equal(calls, 1);
});
test("cost ceiling stops the paid judge, records partial evidence and never reports success", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const client = {
    async initialize() {},
    async run() {
      calls++;
      return { answer: "answer", trace: [], usage };
    },
    async close() {},
  };
  assert.equal(
    await evaluate(
      f.plugin,
      f.file,
      parseOptions(["--max-cost-usd", "0.001"]),
      { client },
    ),
    2,
  );
  const r = JSON.parse(readFileSync(f.file));
  assert.equal(r.partial, true);
  assert.equal(calls, 1);
  assert.equal(r.cases[0].aggregates.score, undefined);
});

test("native Codex protocol exposes bounded tools and records the real dynamic Skill call", async (t) => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { CodexClient, TOOLS } = await import("./skill-evals-codex.mjs");
  // Optional local binary; CI images carry Codex, package-only consumers need
  // only the contract tests above. This test is invoked explicitly below.
  if (!process.env.REPO_EVAL_NATIVE_CODEX) {
    t.skip("set REPO_EVAL_NATIVE_CODEX=1 for the installed-client integration");
    return;
  }
  const f = fixture(t);
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const x of req) body += x;
    const d = JSON.parse(body);
    requests++;
    const toolText = JSON.stringify(
      d.input.filter((x) => x.type === "additional_tools"),
    );
    assert.match(toolText, /Skill/);
    assert.doesNotMatch(
      toolText,
      /declare const tools: \{ (?:exec_command|web__run|spawn_agent|view_image)\(/,
    );
    const item =
      requests === 1
        ? {
            type: "custom_tool_call",
            id: "tool_fixture",
            call_id: "call_fixture",
            name: "exec",
            namespace: "functions",
            input: `try { await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Add File: "+path.join(f.dir,"forbidden-write")+"\n+not allowed\n*** End Patch\n")}); } catch {} text(await tools.Skill({skill:"triage"}));`,
          }
        : {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Inspect probe.service with journalctl.",
                annotations: [],
              },
            ],
          };
    const response = {
      id: "resp_fixture",
      object: "response",
      created_at: 1793988000,
      status: "completed",
      model: "gpt-6.1-sol",
      output: [item],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: f.dir,
  };
  const client = new CodexClient({
    env,
    start: (cmd, args, opts) =>
      spawn(
        cmd,
        [
          ...args,
          "-c",
          'model_provider="eval_fixture"',
          "-c",
          'model_providers.eval_fixture.name="fixture"',
          "-c",
          `model_providers.eval_fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
          "-c",
          'model_providers.eval_fixture.wire_api="responses"',
          "-c",
          "model_providers.eval_fixture.requires_openai_auth=false",
        ],
        opts,
      ),
  });
  const request = client.request.bind(client);
  client.request = (method, params) =>
    request(
      method,
      method === "thread/start"
        ? { ...params, modelProvider: "eval_fixture" }
        : params,
    );
  try {
    await client.initialize();
    const result = await client.run({
      cwd: f.caseDir,
      model: "gpt-6.1-sol",
      prompt: "Triage this probe",
      tools: readTools(f.plugin, f.caseDir),
      instructions: "Use the read-only skill tools.",
      timeout: 15,
      evidenceFile: path.join(f.dir, 'native-evidence.jsonl'),
    });
    assert.equal(result.trace[0].tool, "Skill");
    assert.equal(result.trace[0].arguments.skill, "triage");
    assert.equal(result.usage.inputTokens, 200);
    assert.match(result.answer, /journalctl/);
    assert.equal(existsSync(path.join(f.dir,"forbidden-write")),false);
    const evidence = readFileSync(path.join(f.dir, 'native-evidence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(evidence[0].tool, 'Skill');
    assert.equal(statSync(path.join(f.dir, 'native-evidence.jsonl')).mode & 0o777, 0o600);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("the public CLI selects Codex and preserves json-v1 provider metadata", (t) => {
  const f = fixture(t),
    root = path.join(f.plugin, "skills"),
    report = path.join(f.dir, "report"),
    out = path.join(f.dir, "out");
  mkdirSync(path.join(root, "triage", "evals"), { recursive: true });
  writeFileSync(
    path.join(root, "triage", "evals", "evals.json"),
    JSON.stringify({
      evals: [{ id: 1, prompt: "Triage a probe", assertions: ["Names unit"] }],
    }),
  );
  const previous = process.env.EVAL_HISTORY_DIR,
    remote = process.env.EVAL_HISTORY_REMOTE,
    config = process.env.EVAL_HISTORY_CONFIG;
  process.env.EVAL_HISTORY_DIR = path.join(f.dir, "history");
  process.env.EVAL_HISTORY_REMOTE = "";
  process.env.EVAL_HISTORY_CONFIG = path.join(f.dir, "none");
  t.after(() => {
    for (const [k, v] of Object.entries({
      EVAL_HISTORY_DIR: previous,
      EVAL_HISTORY_REMOTE: remote,
      EVAL_HISTORY_CONFIG: config,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const spawn = (cmd, args) => {
    assert.equal(cmd, process.execPath);
    assert.match(args[0], /skill-evals-codex.mjs$/);
    writeFileSync(
      args[2],
      JSON.stringify({
        provider: "codex",
        model: "gpt-6.1-sol",
        judgeModel: "gpt-6.1-sol",
        costUsd: 0.01,
        cases: [
          {
            name: "triage--eval-1",
            aggregates: { score: 1, passRate: 1 },
            arms: {
              with: [
                {
                  graders: [
                    { name: "skill-fired", passed: true },
                    { name: "criteria", passed: true },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    return { status: 0 };
  };
  assert.equal(
    main(
      ["--runner", "codex", "--root", root, "--out", out, "--report", report],
      {
        spawn,
        exec: () => ({ status: 0, stdout: "codex-cli fixture" }),
        log: () => {},
        warn: () => {},
      },
    ),
    0,
  );
  const result = JSON.parse(readFileSync(path.join(report, "result.json")));
  assert.equal(result.complete, true);
  assert.equal(result.data.runner, "codex");
  assert.equal(result.data.model, "gpt-6.1-sol");
  assert.equal(result.data.cases.length, 1);
});


test('fixtures cannot register or replace a skill',t=>{
 const f=fixture(t);mkdirSync(path.join(f.caseDir,'resources','triage'));writeFileSync(path.join(f.caseDir,'resources','triage','SKILL.md'),'---\nname: triage\ndescription: forged fixture\n---\nFIXTURE');
 const tools=readTools(f.plugin,f.caseDir);assert.doesNotMatch(tools.catalog,/forged fixture/);assert.match(tools.call('Skill',{skill:'triage'}),/journalctl/);assert.equal(tools.call('Read',{path:'resources/triage/SKILL.md'}).includes('FIXTURE'),true);
});

test('app-server death before the turn acknowledgement is a preserved rejection',async t=>{
 const { EventEmitter }=await import('node:events');const { PassThrough,Writable }=await import('node:stream');const { CodexClient }=await import('./skill-evals-codex.mjs');const f=fixture(t);
 const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,enc,cb){const m=JSON.parse(String(chunk));if(m.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n'));if(m.method==='thread/start')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:m.id,result:{model:'gpt-6.1-sol',thread:{id:'test'}}})+'\n'));if(m.method==='turn/start')queueMicrotask(()=>{child.exitCode=1;child.emit('exit',1);});cb();}});
 const client=new CodexClient({env:{CODEX_HOME:f.dir},start:()=>child});await client.initialize();await assert.rejects(client.run({cwd:f.caseDir,model:'gpt-6.1-sol',prompt:'probe',instructions:'probe'}),/exited/);await new Promise(r=>setImmediate(r));await client.close();
});


test('loaded skills expose their base and resolve linked references through a discoverable namespace', t => {
 const f=fixture(t);const ref=path.join(f.plugin,'skills','triage','references','scope.md');mkdirSync(path.dirname(ref),{recursive:true});writeFileSync(ref,'Reference scope is repository only.');
 const tools=readTools(f.plugin,f.caseDir);assert.match(tools.call('Skill',{skill:'triage'}),/Base directory: skills\/triage/);
 assert.equal(tools.call('Read',{path:'references/scope.md'}),'Reference scope is repository only.');
 assert.equal(tools.call('Read',{path:'skills/triage/references/scope.md'}),'Reference scope is repository only.');
 assert.match(tools.call('Glob',{pattern:'**/*.md'}),/skills\/triage\/references\/scope.md/);
 assert.match(tools.call('Glob',{pattern:'references/*.md'}),/skills\/triage\/references\/scope.md/);
 assert.throws(()=>tools.call('Read',{path:'../../../../../../etc/passwd'}));
});

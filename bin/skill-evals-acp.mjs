#!/usr/bin/env node
// Native OpenCode, Goose and Antigravity execution through stable ACP v1.
// Native authentication stays with the caller. No eval document chooses it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { evaluateCases } from './skill-evals-engine.mjs';

export const HARNESSES = ['opencode', 'goose', 'antigravity'];
export function nativeBinary(harness, env = process.env) {
  return env[`REPO_EVAL_${harness.toUpperCase()}_BINARY`] || (harness === 'antigravity' ? 'agy' : harness);
}
export function nativeConfiguration(harness, env = process.env) {
  const endpoint = value => { if (!value) return null; const url = new URL(value); return url.origin + url.pathname; };
  if (harness === 'opencode') return Object.entries(JSON.parse(env.REPO_EVAL_OPENCODE_PROVIDER || '{}')).map(([id, p]) => ({ id, npm: p.npm ?? null, endpoint: endpoint(p.options?.baseURL), models: Object.keys(p.models ?? {}).sort() }));
  if (harness === 'goose') return { provider: env.GOOSE_PROVIDER ?? null, endpoint: endpoint(env.LITELLM_HOST ?? env.OPENAI_HOST) };
  return null;
}
export function parseOptions(args) {
  const out = { concurrency: 1, threshold: 1, maxCostUsd: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], value = () => { if (++i === args.length) throw Error(`${a} needs a value`); return args[i]; };
    if (a === '--model') out.model = value();
    else if (a === '--judge-model') out.judgeModel = value();
    else if (a === '--max-cost-usd') out.maxCostUsd = Number(value());
    else if (a === '--threshold') out.threshold = Number(value());
    else if (a === '--case') out.case = value();
    else if (a === '-j' || a === '--concurrency') out.concurrency = Number(value());
    else if (a === '--ablation') { if (value() !== 'none') throw Error('Native ACP evals support --ablation none only'); }
    else if (a !== '--keep-temp') throw Error(`Unsupported native eval option: ${a}`);
  }
  if (!out.model) throw Error('Native ACP evals require an explicit --model');
  out.judgeModel ??= out.model;
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 2 || !Number.isFinite(out.threshold) || out.threshold < 0 || out.threshold > 1 || (out.maxCostUsd !== null && (!Number.isFinite(out.maxCostUsd) || out.maxCostUsd <= 0))) throw Error('Invalid native eval options');
  return out;
}
export function nativeCost(usage) {
  const cost = usage?.cost;
  // ACP's used/size fields describe context occupancy, not billable tokens.
  if (!cost || cost.currency !== 'USD') return null;
  if (!Number.isFinite(cost.amount) || cost.amount < 0) throw Error('Invalid native USD usage');
  return cost.amount;
}
const cleanEnvironment = env => Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'].filter(k => env[k] !== undefined).map(k => [k, env[k]]));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

// Only fresh configuration is exposed. Provider configuration is supplied by
// the caller; credentials may use native environment references, never argv.
export function prepareNative(harness, root, env = process.env) {
  if (!HARNESSES.includes(harness)) throw Error('Unknown native ACP harness');
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const childEnv = { ...cleanEnvironment(env), HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache') };
  let command, args, cleanup = () => {};
  if (harness === 'opencode') {
    command = nativeBinary(harness, env);
    args = ['acp', '--pure', '--cwd', workspace];
    const provider = env.REPO_EVAL_OPENCODE_PROVIDER ? JSON.parse(env.REPO_EVAL_OPENCODE_PROVIDER) : {};
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider, plugin: [], instructions: [], skills: [], autoupdate: false, share: 'disabled', permission: { '*': 'deny', 'eval_*': 'allow' }, agent: { build: { permission: { '*': 'deny', 'eval_*': 'allow' } } } });
    childEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    childEnv.OPENCODE_DISABLE_CLAUDE_CODE = 'true';
    childEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true';
    // Explicit caller allowlist: no ambient credentials or runtime hooks.
    for (const key of (env.REPO_EVAL_OPENCODE_ENV || '').split(',').filter(Boolean)) {
      if (!/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|HOST|URL)$/.test(key) || key.startsWith('OPENCODE_')) throw Error('Invalid OpenCode provider environment name');
      if (env[key] !== undefined) childEnv[key] = env[key];
    }
  } else if (harness === 'goose') {
    command = nativeBinary(harness, env);
    args = ['acp'];
    childEnv.GOOSE_PATH_ROOT = root;
    childEnv.GOOSE_MODE = 'approve';
    childEnv.GOOSE_DISABLE_SESSION_NAMING = 'true';
    const config = path.join(root, 'config');
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.yaml'), 'extensions: {}\nGOOSE_MODE: approve\n', { mode: 0o600 });
    writeJson(path.join(config, 'permission.yaml'), { user: { always_allow: ['eval__Skill', 'eval__Read', 'eval__Glob', 'eval__Grep'], ask_before: [], never_allow: [] } });
    for (const key of ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'LITELLM_HOST', 'LITELLM_API_KEY', 'OPENAI_HOST', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) if (env[key] !== undefined) childEnv[key] = env[key];
  } else {
    command = nativeBinary(harness, env);
    const nativeApp = path.resolve(env.REPO_EVAL_ANTIGRAVITY_AUTH_DIR || path.join(env.HOME, '.gemini', 'antigravity-cli'));
    if (!existsSync(nativeApp)) throw Error('Antigravity requires its caller-owned native login directory');
    const gemini = path.join(root, 'gemini');
    mkdirSync(gemini);
    // Preserve the native directory owner and its atomic rotating-auth writes.
    // A fresh Gemini root excludes global MCP/plugins/hooks/customizations.
    symlinkSync(nativeApp, path.join(gemini, 'antigravity-cli'), 'dir');
    const settings = mkdtempSync(path.join(nativeApp, '.repo-eval-'));
    cleanup = () => rmSync(settings, { recursive: true, force: true });
    writeJson(path.join(settings, 'settings.json'), { toolPermission: 'strict', permissions: { ask: ['read_file(*)'], deny: ['write_file(*)', 'command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)'], allow: ['mcp(eval/*)'] } });
    childEnv.HOME = env.HOME;
    args = ['acp', '--process-per-session', '--disable-telemetry', '--include-default-customizations=false', '--gemini-dir', gemini, '--app-data-dir', 'antigravity-cli', '--cli_dir_name', path.basename(settings), '--log-file', path.join(root, 'native.log')];
  }
  return { command, args, env: childEnv, workspace, cleanup };
}

// Antigravity spills long MCP results to its own output files. Authorize only
// an exact copy of a result already produced by this case's bounded tools;
// ordinary native reads and every native write/shell/network action stay denied.
export function authorizeArtifactRead(call, root, sessionId, toolTrace) {
  try {
    if (!sessionId || call.kind !== 'read' || typeof call.rawInput?.Path !== 'string') return false;
    const base = realpathSync(path.join(root, 'gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated'));
    const file = realpathSync(path.resolve(root, 'workspace', call.rawInput.Path));
    const relative = path.relative(base, file);
    if (!/^steps\/\d+\/output\.txt$/.test(relative) || !statSync(file).isFile() || statSync(file).size > 65536 || statSync(toolTrace).size > 16 * 1024 * 1024) return false;
    const content = readFileSync(file, 'utf8');
    return readFileSync(toolTrace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).some(event => event.type === 'tool.call' && event.result === content);
  } catch { return false; }
}

export class AcpClient {
  constructor(harness, { env = process.env, start = spawn } = {}) { this.harness = harness; this.env = env; this.start = start; }
  async initialize() {}
  async close() {}
  async run({ plugin, cwd, allowed, model, prompt, instructions, tools, maxCalls = 8, timeout = 600, outputSchema, metadataOnly = false, evidenceFile }) {
    const root = mkdtempSync(path.join(tmpdir(), 'repo-eval-acp-'));
    let prepared, child, sessionId, stopTimer, spawnError, watched;
    const trace = [], chunks = [], nativeCalls = new Map();
    const record = event => { trace.push(event); if (evidenceFile) appendFileSync(evidenceFile, JSON.stringify(event) + '\n', { mode: 0o600 }); };
    let usage = null, init, session, phase = 'configuration';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(Error('Native eval timed out')), timeout * 1000);
    try {
      prepared = prepareNative(this.harness, root, this.env);
      const toolTrace = evidenceFile ? `${evidenceFile}.tools` : path.join(root, 'tools.jsonl'), configFile = path.join(root, 'tools.json');
      // Previous evidence is archived by the caller before --out is reused.
      // Never import an earlier invocation's tool loads or exhausted limits.
      writeFileSync(toolTrace, '', { mode: 0o600 });
      if (evidenceFile) writeFileSync(evidenceFile, '', { mode: 0o600 });
      writeJson(configFile, { plugin, caseDir: cwd, allowed, maxCalls, tracePath: toolTrace });
      watched = toolTrace;
      watchFile(toolTrace, { interval: 100, persistent: false }, () => {
        try {
          if (statSync(toolTrace).size > 16 * 1024 * 1024 || readFileSync(toolTrace, 'utf8').split('\n').filter(Boolean).some(line => JSON.parse(line).type === 'limit.exceeded')) abort.abort(Error('Eval tool-call limit exceeded'));
        } catch {}
      });
      child = this.start(prepared.command, prepared.args, { cwd: prepared.workspace, env: prepared.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => { spawnError = error; abort.abort(); });
      child.stdin.on('error', () => abort.abort());
      child.stderr.resume(); // Never forward native provider/auth diagnostics.
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      const onAbort = () => kill('SIGTERM');
      abort.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await client({ name: 'repo-skill-evals', version: '1' })
          .onRequest(methods.client.session.requestPermission, async ({ params }) => {
            const call = { ...nativeCalls.get(params.toolCall.toolCallId), ...params.toolCall };
            const option = params.options.find(x => x.kind === 'allow_once');
            if (option && this.harness === 'antigravity' && authorizeArtifactRead(call, root, sessionId, toolTrace)) {
              record({ event: 'native.artifact.read', path: call.rawInput.Path });
              return { outcome: { outcome: 'selected', optionId: option.optionId } };
            }
            record({ event: 'native.permission.denied', kind: call.kind, inputKeys: Object.keys(call.rawInput ?? {}), knownIdentity: nativeCalls.has(params.toolCall.toolCallId) });
            return { outcome: { outcome: 'cancelled' } };
          })
          .onNotification(methods.client.session.update, ({ params: { update } }) => {
            if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) nativeCalls.set(update.toolCallId, { ...nativeCalls.get(update.toolCallId), ...update });
            record({ event: 'acp.update', type: update.sessionUpdate, ...(update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' ? { text: update.content.text } : {}) });
            if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') chunks.push(update.content.text);
            if (update.sessionUpdate === 'usage_update') usage = { ...update };
          })
          .connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
            const request = (method, params) => ctx.request(method, params, { signal: abort.signal });
            phase = 'initialization';
            init = await request(methods.agent.initialize, { protocolVersion: 1, clientInfo: { name: 'repo-skill-evals', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
            phase = 'session authentication and tools';
            session = await request(methods.agent.session.new, { cwd: prepared.workspace, mcpServers: tools ? [{ name: 'eval', command: process.execPath, args: [fileURLToPath(new URL('./skill-evals-mcp.mjs', import.meta.url)), configFile], env: [] }] : [] });
            sessionId = session.sessionId;
            record({ event: 'native.session', harness: this.harness, version: init.agentInfo?.version, sessionId });
            const current = session.models?.currentModelId ?? session.configOptions?.find(x => x.category === 'model')?.currentValue;
            // Model switching uses only a model advertised by this native peer.
            if (!metadataOnly && current !== model) {
              const selector = session.configOptions?.find(option => option.category === 'model' && option.options?.some(value => value.value === model));
              if (!selector) throw Error('Requested model is not advertised through a stable native selector');
              const selected = await request(methods.agent.session.setConfigOption, { sessionId, configId: selector.id, value: model });
              if (selected.configOptions?.find(x => x.id === selector.id)?.currentValue !== model) throw Error('Requested model is not advertised through a stable native selector');
            }
            const transportInstructions = this.harness === 'antigravity' && tools ? '\nIf Antigravity stores a long MCP result in an output.txt artifact, read that exact result with its native file-reading tool. Only current-session artifacts whose contents match an observed eval-tool result can be approved; other host files remain denied. Do not repeatedly reload or grep the same skill to recover a spilled result.' : '';
            const text = `${instructions}${transportInstructions}\n${outputSchema ? `Return JSON matching this schema: ${JSON.stringify(outputSchema)}\n` : ''}\n${prompt}`;
            phase = 'model inference';
            const result = metadataOnly ? { stopReason: 'end_turn' } : await request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
            if (result.stopReason !== 'end_turn') throw Error(`Native eval stopped: ${result.stopReason}`);
            if (existsSync(toolTrace)) for (const line of readFileSync(toolTrace, 'utf8').trim().split('\n').filter(Boolean)) {
              const event = JSON.parse(line);
              if (event.type === 'limit.exceeded') throw Error('Eval tool-call limit exceeded');
              if (event.type === 'tool.call') trace.push({ tool: event.tool, arguments: event.arguments, output: event.result });
              else if (event.type === 'tool.denied') trace.push({ tool: event.tool, error: event.reason });
            }
            if (init.agentCapabilities?.sessionCapabilities?.close) await request(methods.agent.session.close, { sessionId });
          });
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
        child.stdin.end(); kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null && !spawnError) {
          stopTimer = setTimeout(() => kill('SIGKILL'), 2000);
          await once(child, 'exit').catch(() => {});
        }
      }
      if (!metadataOnly && !chunks.join('').trim()) throw Error('Native eval returned no final response');
      return { answer: chunks.join(''), trace, usage, native: { harness: this.harness, version: init.agentInfo?.version, model: session.models?.currentModelId, models: session.models?.availableModels?.map(x => x.modelId), configOptions: session.configOptions, sessionId } };
    } catch (error) {
      // ACP errors can embed credential-bearing provider diagnostics.
      if (abort.signal.aborted && abort.signal.reason?.message === 'Eval tool-call limit exceeded') throw abort.signal.reason;
      if (/model is not advertised|tool-call limit|Native eval (timed out|stopped|returned)/.test(error.message)) throw error;
      throw Error(`Native ${this.harness} failed during ${phase}`);
    } finally {
      clearTimeout(timer); clearTimeout(stopTimer);
      if (watched) unwatchFile(watched);
      prepared?.cleanup(); rmSync(root, { recursive: true, force: true });
    }
  }
}
export async function evaluate(harness, plugin, file, options, dependencies = {}) {
  return evaluateCases(plugin, file, options, { createClient: () => new AcpClient(harness), cost: nativeCost, provider: harness, ...dependencies });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [harness, plugin, file, ...args] = process.argv.slice(2);
  try { process.exitCode = await evaluate(harness, plugin, file, parseOptions(args)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

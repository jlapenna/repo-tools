import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractReferencedRepoPaths,
  isEphemeralFact,
  main,
  resolveHindsightConnection,
} from '../plugins/repo-tools/scripts/repo-hindsight-dream.mjs';

function captureLogs(fn) {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    })
    .then((result) => ({
      result,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    }));
}

test('resolveHindsightConnection resolves checkout basename from origin remote and redacts tokens', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hindsight-dream-cfg-'));
  try {
    const checkoutDir = path.join(tmp, 'checkout');
    mkdirSync(checkoutDir, { recursive: true });
    execFileSync('git', ['init', checkoutDir], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', checkoutDir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'],
      { stdio: 'ignore' },
    );
    const cfgPath = path.join(tmp, 'coding-agent.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiUrl: 'https://memory.example.test/',
        apiToken: 'super-secret-token-value',
        bankIdTemplate: 'team::{gitProject}',
      }),
    );

    const conn = resolveHindsightConnection({
      cwd: checkoutDir,
      env: { HINDSIGHT_CONFIG: cfgPath },
      home: tmp,
    });
    assert.equal(conn.bankId, 'team::widgets');
    assert.equal(conn.apiUrl, 'https://memory.example.test');
    assert.equal(conn.gitInfo.remoteSlug, 'acme/widgets');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractReferencedRepoPaths and isEphemeralFact classify paths and review noise accurately', () => {
  const paths = extractReferencedRepoPaths(
    'Updated `apps/console/src/lib/runs-router.ts` and `.lcars/jobs/onduty-daily/job.yaml` in jlapenna/agent-lcars.',
  );
  assert.deepEqual(paths.sort(), [
    '.lcars/jobs/onduty-daily/job.yaml',
    'apps/console/src/lib/runs-router.ts',
  ]);

  assert.equal(
    isEphemeralFact({
      text: 'PR acme/widgets#42 was APPROVED with 0 findings (bugs: 0, guardrails: 0) after a 2-pass review.',
      tags: ['mode:review', 'source:chat'],
      document_id: 'conversation:abc',
    }),
    true,
  );

  assert.equal(
    isEphemeralFact({
      text: 'PR #42 must never bypass the ruleset check because merge queues require exact head SHA matching.',
      tags: ['mode:review', 'source:chat'],
      document_id: 'conversation:abc',
    }),
    false,
  );
});

test('CLI end-to-end against mock Hindsight API enforces curation guards and reconciles cleanly', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hindsight-dream-e2e-'));
  const repoDir = path.join(tmp, 'widgets');
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src/live.ts'), 'export const ok = true;\n');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'],
    { stdio: 'ignore' },
  );

  const secretToken = 'hs_live_secret_token_987654321';
  const state = {
    recovered: 0,
    consolidated: 0,
    refreshed: [],
    retained: [],
    deletedDocs: [],
    deletedPages: [],
    deletedModels: [],
    memories: new Map([
      [
        'mem-missing-path',
        {
          id: 'mem-missing-path',
          fact_type: 'world',
          state: 'valid',
          document_id: 'gitlog:widgets',
          proof_count: 2,
          updated_at: new Date().toISOString(),
          tags: ['source:git'],
          text: 'Legacy auth lived in src/retired-auth.ts before removal.',
        },
      ],
      [
        'mem-ephemeral',
        {
          id: 'mem-ephemeral',
          fact_type: 'experience',
          state: 'valid',
          document_id: 'conversation:rev1',
          proof_count: 1,
          updated_at: new Date().toISOString(),
          tags: ['source:chat', 'mode:review'],
          text: 'The agent completed a bugs review for PR #99 and reported 0 findings.',
        },
      ],
      [
        'mem-dup-1',
        {
          id: 'mem-dup-1',
          fact_type: 'world',
          state: 'valid',
          document_id: 'conversation:c1',
          proof_count: 3,
          updated_at: new Date().toISOString(),
          tags: ['source:chat'],
          text: 'Worktree cleanup in src/live.ts requires running repo-prune-merged-worktrees from outside the target checkout directory.',
        },
      ],
      [
        'mem-dup-2',
        {
          id: 'mem-dup-2',
          fact_type: 'world',
          state: 'valid',
          document_id: 'conversation:c2',
          proof_count: 1,
          updated_at: new Date().toISOString(),
          tags: ['source:chat'],
          text: 'Worktree cleanup in src/live.ts always requires running repo-prune-merged-worktrees outside the target checkout directory.',
        },
      ],
      [
        'obs-derived',
        {
          id: 'obs-derived',
          fact_type: 'observation',
          state: 'valid',
          source_memory_ids: ['mem-missing-path'],
          text: 'Derived observation about src/retired-auth.ts.',
        },
      ],
    ]),
    documents: new Map([
      ['gitlog:widgets', { id: 'gitlog:widgets', memory_unit_count: 10, updated_at: '2026-11-27T00:00:00Z' }],
      ['gitlog:checkout', { id: 'gitlog:checkout', memory_unit_count: 8, updated_at: '2026-11-26T00:00:00Z' }],
      ['conversation:ses_dream_self', { id: 'conversation:ses_dream_self', memory_unit_count: 2, updated_at: '2026-11-27T01:00:00Z' }],
      ['conversation:user_chat', { id: 'conversation:user_chat', memory_unit_count: 4, updated_at: '2026-11-27T01:00:00Z' }],
    ]),
    models: new Map([
      [
        'mm-core-decisions',
        {
          id: 'mm-core-decisions',
          name: 'Key decisions and rationale',
          is_page: true,
          is_stale: true,
          last_refreshed_at: '2026-11-26T00:00:00Z',
          last_refresh_failed_at: '2026-11-26T12:00:00Z',
          source_query: 'What are the key decisions?',
          content: '# Decisions\nOld content',
          tags: ['knowledge:decision'],
        },
      ],
      [
        'mm-shipped-init',
        {
          id: 'mm-shipped-init',
          name: 'Shipped OAuth migration (#101)',
          is_page: true,
          is_stale: true,
          last_refreshed_at: '2026-11-10T00:00:00Z',
          last_refresh_failed_at: null,
          source_query: 'Track OAuth migration #101',
          content: '# Shipped OAuth migration',
          tags: ['knowledge:feature-work'],
        },
      ],
    ]),
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secretToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: `bad token ${secretToken}` }));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const prefix = '/v1/default/banks/agent-lcars%3A%3Awidgets';
    if (!url.pathname.startsWith(prefix)) {
      send(404, { detail: `unexpected path ${url.pathname}` });
      return;
    }
    const sub = url.pathname.slice(prefix.length);

    if (req.method === 'GET' && sub === '/stats') {
      send(200, {
        total_nodes: state.memories.size,
        total_documents: state.documents.size,
        total_links: 12,
        nodes_by_fact_type: { world: 3, experience: 1, observation: 1 },
        total_observations: 1,
        pending_consolidation: 1,
        failed_consolidation: state.recovered ? 0 : 2,
        paused_mental_models: 1,
      });
      return;
    }
    if (req.method === 'GET' && sub === '/observations/scopes') {
      send(200, { scopes: [{ tags: [], count: 1 }] });
      return;
    }
    if (req.method === 'GET' && sub === '/pages/tree') {
      send(200, {
        roots: [
          { id: 'kp-core', kind: 'page', name: 'Key decisions and rationale', mental_model_id: 'mm-core-decisions' },
          { id: 'kp-init', kind: 'page', name: 'Shipped OAuth migration (#101)', mental_model_id: 'mm-shipped-init' },
        ],
      });
      return;
    }
    if (req.method === 'GET' && sub === '/mental-models') {
      send(200, { items: [...state.models.values()], total: state.models.size });
      return;
    }
    if (sub.startsWith('/mental-models/')) {
      const rest = sub.slice('/mental-models/'.length);
      if (req.method === 'POST' && rest.endsWith('/refresh')) {
        const mmId = decodeURIComponent(rest.slice(0, -'/refresh'.length));
        state.refreshed.push({ mmId, body });
        send(200, { operation_id: `op-refresh-${mmId}` });
        return;
      }
      const mmId = decodeURIComponent(rest);
      if (req.method === 'GET') {
        const mm = state.models.get(mmId);
        if (!mm) return send(404, {});
        send(200, mm);
        return;
      }
      if (req.method === 'DELETE') {
        state.models.delete(mmId);
        state.deletedModels.push(mmId);
        send(200, { success: true });
        return;
      }
    }
    if (req.method === 'DELETE' && sub.startsWith('/pages/nodes/')) {
      const pageId = decodeURIComponent(sub.slice('/pages/nodes/'.length));
      state.deletedPages.push(pageId);
      send(200, {});
      return;
    }
    if (req.method === 'GET' && sub === '/documents') {
      const q = url.searchParams.get('q') || '';
      const items = [...state.documents.values()].filter((d) => !q || d.id.includes(q));
      send(200, { items, total: items.length, limit: 50, offset: 0 });
      return;
    }
    if (sub.startsWith('/documents/')) {
      const docId = decodeURIComponent(sub.slice('/documents/'.length));
      if (req.method === 'GET') {
        const doc = state.documents.get(docId);
        if (!doc) return send(404, {});
        send(200, doc);
        return;
      }
      if (req.method === 'DELETE') {
        if (!state.documents.has(docId)) return send(404, {});
        state.documents.delete(docId);
        state.deletedDocs.push(docId);
        send(200, { success: true, document_id: docId, memory_units_deleted: 2, message: 'ok' });
        return;
      }
    }
    if (req.method === 'GET' && sub === '/memories/list') {
      const ftype = url.searchParams.get('type');
      const st = url.searchParams.get('state');
      const items = [...state.memories.values()].filter(
        (m) => (!ftype || m.fact_type === ftype) && (!st || m.state === st),
      );
      send(200, { items, total: items.length, limit: 100, offset: 0 });
      return;
    }
    if (req.method === 'POST' && sub === '/memories') {
      state.retained.push(body);
      send(200, { success: true, bank_id: 'agent-lcars::widgets', items_count: body.items.length, async: false });
      return;
    }
    if (sub.startsWith('/memories/')) {
      const memId = decodeURIComponent(sub.slice('/memories/'.length));
      const mem = state.memories.get(memId);
      if (!mem) return send(404, {});
      if (req.method === 'GET') {
        send(200, mem);
        return;
      }
      if (req.method === 'PATCH') {
        Object.assign(mem, body);
        send(200, mem);
        return;
      }
    }
    if (req.method === 'POST' && sub === '/consolidation/recover') {
      state.recovered += 1;
      send(200, { recovered: 2 });
      return;
    }
    if (req.method === 'POST' && sub === '/consolidate') {
      state.consolidated += 1;
      send(200, { operation_id: 'op-consolidate-1', deduplicated: false });
      return;
    }
    if (req.method === 'GET' && sub.startsWith('/operations/')) {
      const opId = decodeURIComponent(sub.slice('/operations/'.length));
      send(200, { operation_id: opId, status: 'completed' });
      return;
    }
    send(404, { detail: `unhandled ${req.method} ${sub}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const cfgPath = path.join(tmp, 'coding-agent.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}`,
      apiToken: secretToken,
      bankIdTemplate: 'agent-lcars::{gitProject}',
    }),
  );
  const env = { HINDSIGHT_CONFIG: cfgPath };

  try {
    // 1. Candidates surfaces missing path, ephemeral fact, near-duplicate, and duplicate gitlog
    const candRun = await captureLogs(() =>
      main(['candidates', '--cwd', repoDir, '--session-id', 'ses_dream_self', '--json'], env),
    );
    assert.equal(candRun.result, 0, candRun.stderr);
    const cand = JSON.parse(candRun.stdout);
    assert.deepEqual(cand.duplicateGitlogs.map((d) => d.id), ['gitlog:checkout']);
    assert.equal(cand.claimsWithMissingPaths.length, 1);
    assert.equal(cand.claimsWithMissingPaths[0].id, 'mem-missing-path');
    assert.deepEqual(cand.claimsWithMissingPaths[0].missingPaths, ['src/retired-auth.ts']);
    assert.equal(cand.ephemeralFacts.length, 1);
    assert.equal(cand.ephemeralFacts[0].id, 'mem-ephemeral');
    assert.equal(cand.nearDuplicates.length, 1);
    assert.equal(cand.initiativePages.length, 1);

    // 2. Guard: cannot invalidate a derived observation directly
    const obsGuard = await captureLogs(() =>
      main(['invalidate-memory', '--cwd', repoDir, '--id', 'obs-derived', '--reason', 'stale'], env),
    );
    assert.equal(obsGuard.result, 2);
    assert.match(obsGuard.stderr, /derived observation/);

    // 3. Invalidate raw contradicted memory
    const invRun = await captureLogs(() =>
      main(
        ['invalidate-memory', '--cwd', repoDir, '--id', 'mem-missing-path', '--reason', 'Removed in HEAD; replaced by src/live.ts'],
        env,
      ),
    );
    assert.equal(invRun.result, 0, invRun.stderr);
    assert.equal(state.memories.get('mem-missing-path').state, 'invalidated');

    // 4. Upsert deterministic correction note
    const retainRun = await captureLogs(() =>
      main(
        [
          'retain-doc',
          '--cwd',
          repoDir,
          '--kind',
          'correction',
          '--slug',
          'auth-module-path',
          '--title',
          'Auth module path',
          '--knowledge-tag',
          'knowledge:component',
          '--text',
          'src/retired-auth.ts was removed; live checks live in src/live.ts.',
        ],
        env,
      ),
    );
    assert.equal(retainRun.result, 0, retainRun.stderr);
    assert.equal(state.retained.length, 1);
    assert.equal(state.retained[0].items[0].document_id, 'dream:correction:auth-module-path');
    assert.equal(state.retained[0].items[0].update_mode, 'replace');

    // 5. Guard: delete-doc refuses canonical gitlog and arbitrary user chat, allows gitlog:checkout
    const refuseCanonical = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'gitlog:widgets', '--reason', 'nope'], env),
    );
    assert.equal(refuseCanonical.result, 2);
    const refuseUserChat = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'conversation:user_chat', '--reason', 'nope'], env),
    );
    assert.equal(refuseUserChat.result, 2);
    const allowCheckoutGitlog = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'gitlog:checkout', '--reason', 'duplicate checkout seed'], env),
    );
    assert.equal(allowCheckoutGitlog.result, 0, allowCheckoutGitlog.stderr);
    assert.deepEqual(state.deletedDocs, ['gitlog:checkout']);

    // 6. Guard: retire-page refuses core taxonomy page, allows shipped initiative page
    const refuseCore = await captureLogs(() =>
      main(['retire-page', '--cwd', repoDir, '--id', 'mm-core-decisions', '--reason', 'never'], env),
    );
    assert.equal(refuseCore.result, 2);
    assert.match(refuseCore.stderr, /Refusing to retire core taxonomy page/);

    const allowInit = await captureLogs(() =>
      main(['retire-page', '--cwd', repoDir, '--id', 'mm-shipped-init', '--reason', 'Merged in #101'], env),
    );
    assert.equal(allowInit.result, 0, allowInit.stderr);
    assert.deepEqual(state.deletedPages, ['kp-init']);
    assert.deepEqual(state.deletedModels, ['mm-shipped-init']);

    // 7. Reconcile cleans self-session doc, recovers failed consolidations, consolidates, and full-refreshes failed core page
    const recRun = await captureLogs(() =>
      main(
        ['reconcile', '--cwd', repoDir, '--session-id', 'ses_dream_self', '--refresh-stale', '--wait-seconds', '5'],
        env,
      ),
    );
    assert.equal(recRun.result, 0, recRun.stderr);
    const rec = JSON.parse(recRun.stdout);
    assert.equal(rec.actions.selfSessionDeleted, true);
    assert.equal(state.recovered, 1);
    assert.equal(state.consolidated, 1);
    assert.equal(state.refreshed.length, 1);
    assert.equal(state.refreshed[0].mmId, 'mm-core-decisions');
    assert.deepEqual(state.refreshed[0].body, { mode: 'full' });

    // 8. Token redaction on server 401
    const badCfg = path.join(tmp, 'bad.json');
    writeFileSync(
      badCfg,
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}`,
        apiToken: 'wrong-token-value-123456',
        bankId: 'agent-lcars::widgets',
      }),
    );
    const badRun = await captureLogs(() =>
      main(['status', '--cwd', repoDir], { HINDSIGHT_CONFIG: badCfg }),
    );
    assert.equal(badRun.result, 1);
    assert.doesNotMatch(badRun.stderr, /wrong-token-value-123456/);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveHindsightConnection enforces layered disabled precedence and optInOnly / optInPaths fail-closed', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hindsight-dream-privacy-'));
  try {
    const allowedRepo = path.join(tmp, 'work', 'allowed-repo');
    const blockedRepo = path.join(tmp, 'work', 'blocked-repo');
    const privateRepo = path.join(tmp, 'private', 'secret-repo');
    const mappedRepo = path.join(tmp, 'mapped', 'client-app');
    for (const dir of [allowedRepo, blockedRepo, privateRepo, mappedRepo]) {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', dir], { stdio: 'ignore' });
    }

    const cfgPath = path.join(tmp, 'coding-agent.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiToken: 'cloud-token-123456',
        disabled: true,
        paths: {
          '~/work': { disabled: false },
          '~/private': { disabled: true },
        },
        banks: {
          'coding-agent::blocked-repo': { disabled: true },
          'coding-agent::secret-repo': { disabled: false },
        },
      }),
    );

    // Top-level disabled: true overridden by paths.<prefix>.disabled: false
    const allowedConn = resolveHindsightConnection({
      cwd: allowedRepo,
      env: { HINDSIGHT_CONFIG: cfgPath },
      home: tmp,
    });
    assert.equal(allowedConn.bankId, 'coding-agent::allowed-repo');

    // banks.<id>.disabled: true overrides paths.<prefix>.disabled: false
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: blockedRepo,
          env: { HINDSIGHT_CONFIG: cfgPath },
          home: tmp,
        }),
      /disabled/i,
    );

    // banks.<id>.disabled: false overrides paths.<prefix>.disabled: true
    const secretOverride = resolveHindsightConnection({
      cwd: privateRepo,
      env: { HINDSIGHT_CONFIG: cfgPath },
      home: tmp,
    });
    assert.equal(secretOverride.bankId, 'coding-agent::secret-repo');

    // paths.<prefix>.disabled: true fails closed when top-level disabled is unset
    const pathDisabledCfg = path.join(tmp, 'path-disabled.json');
    writeFileSync(
      pathDisabledCfg,
      JSON.stringify({
        apiToken: 'cloud-token-123456',
        paths: {
          '~/private': { disabled: true },
        },
      }),
    );
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: privateRepo,
          env: { HINDSIGHT_CONFIG: pathDisabledCfg },
          home: tmp,
        }),
      /disabled/i,
    );

    // File disabled: false overrides HINDSIGHT_DISABLED=true env fallback
    const envFallbackCfg = path.join(tmp, 'env-fallback.json');
    writeFileSync(
      envFallbackCfg,
      JSON.stringify({
        apiToken: 'cloud-token-123456',
        disabled: false,
      }),
    );
    const envOverridden = resolveHindsightConnection({
      cwd: allowedRepo,
      env: { HINDSIGHT_CONFIG: envFallbackCfg, HINDSIGHT_DISABLED: 'true' },
      home: tmp,
    });
    assert.equal(envOverridden.bankId, 'coding-agent::allowed-repo');

    // optInOnly fails closed outside optInPaths and mapPathToBank (even with bare bankId or path section)
    const optInCfg = path.join(tmp, 'opt-in.json');
    writeFileSync(
      optInCfg,
      JSON.stringify({
        apiToken: 'cloud-token-123456',
        bankId: 'global-bank',
        optInOnly: true,
        optInPaths: ['~/work'],
        mapPathToBank: {
          '~/mapped': 'client-bank',
        },
        paths: {
          '~/private': { optInOnly: false },
        },
      }),
    );
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: privateRepo,
          env: { HINDSIGHT_CONFIG: optInCfg },
          home: tmp,
        }),
      /optInOnly/,
    );
    const optedInWork = resolveHindsightConnection({
      cwd: allowedRepo,
      env: { HINDSIGHT_CONFIG: optInCfg },
      home: tmp,
    });
    assert.equal(optedInWork.bankId, 'global-bank');
    const optedInMapped = resolveHindsightConnection({
      cwd: mappedRepo,
      env: { HINDSIGHT_CONFIG: optInCfg },
      home: tmp,
    });
    assert.equal(optedInMapped.bankId, 'client-bank');

    // Env fallback for HINDSIGHT_OPT_IN_ONLY / HINDSIGHT_OPT_IN_PATHS
    const emptyCfg = path.join(tmp, 'empty.json');
    writeFileSync(emptyCfg, JSON.stringify({ apiToken: 'cloud-token-123456' }));
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: privateRepo,
          env: {
            HINDSIGHT_CONFIG: emptyCfg,
            HINDSIGHT_OPT_IN_ONLY: 'true',
            HINDSIGHT_OPT_IN_PATHS: '~/work',
          },
          home: tmp,
        }),
      /optInOnly/,
    );
    const envOptedIn = resolveHindsightConnection({
      cwd: allowedRepo,
      env: {
        HINDSIGHT_CONFIG: emptyCfg,
        HINDSIGHT_OPT_IN_ONLY: '1',
        HINDSIGHT_OPT_IN_PATHS: '~/other, ~/work',
      },
      home: tmp,
    });
    assert.equal(envOptedIn.bankId, 'coding-agent::allowed-repo');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveHindsightConnection and CLI support daemon mode, unauthenticated self-hosted, and prevent cross-origin token leakage', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hindsight-dream-modes-'));
  const ossRepo = path.join(tmp, 'oss', 'widgets');
  const workRepo = path.join(tmp, 'work', 'widgets');
  for (const dir of [ossRepo, workRepo]) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
  }

  const seenAuthHeaders = [];
  const server = http.createServer((req, res) => {
    seenAuthHeaders.push(req.headers.authorization ?? null);
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/stats')) {
      return send(200, { total_nodes: 0, total_documents: 0, total_links: 0 });
    }
    if (url.pathname.endsWith('/observations/scopes')) return send(200, { scopes: [] });
    if (url.pathname.endsWith('/pages/tree')) return send(200, { roots: [] });
    if (url.pathname.endsWith('/mental-models')) return send(200, { items: [] });
    if (url.pathname.endsWith('/documents')) return send(200, { items: [], total: 0 });
    if (url.pathname.endsWith('/memories/list')) return send(200, { items: [], total: 0 });
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // 1. Mixed Cloud + per-directory daemon config routes ~/oss to 127.0.0.1:<port> without inheriting Cloud token
    const mixedCfg = path.join(tmp, 'mixed.json');
    writeFileSync(
      mixedCfg,
      JSON.stringify({
        apiToken: 'cloud-secret-token-999',
        paths: {
          '~/oss': { serverMode: 'daemon', apiPort: port },
        },
      }),
    );

    const ossConn = resolveHindsightConnection({
      cwd: ossRepo,
      env: { HINDSIGHT_CONFIG: mixedCfg },
      home: tmp,
    });
    assert.equal(ossConn.serverMode, 'daemon');
    assert.equal(ossConn.apiUrl, `http://127.0.0.1:${port}`);
    assert.equal(ossConn.apiToken, '');

    const workConn = resolveHindsightConnection({
      cwd: workRepo,
      env: { HINDSIGHT_CONFIG: mixedCfg },
      home: tmp,
    });
    assert.equal(workConn.serverMode, 'cloud');
    assert.equal(workConn.apiUrl, 'https://api.hindsight.vectorize.io');
    assert.equal(workConn.apiToken, 'cloud-secret-token-999');

    // Run status against local daemon port and verify zero Authorization headers sent
    seenAuthHeaders.length = 0;
    const daemonStatus = await captureLogs(() =>
      main(['status', '--cwd', ossRepo, '--json'], { HINDSIGHT_CONFIG: mixedCfg, HOME: tmp }),
    );
    assert.equal(daemonStatus.result, 0, daemonStatus.stderr);
    assert.ok(seenAuthHeaders.length > 0);
    assert.ok(seenAuthHeaders.every((h) => h === null), `expected no Authorization header, got ${JSON.stringify(seenAuthHeaders)}`);

    // 2. Unauthenticated self-hosted config (no serverMode, no apiToken) works and omits Authorization header
    const selfHostedCfg = path.join(tmp, 'self-hosted.json');
    writeFileSync(
      selfHostedCfg,
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}`,
      }),
    );
    seenAuthHeaders.length = 0;
    const selfHostedStatus = await captureLogs(() =>
      main(['status', '--cwd', workRepo, '--json'], { HINDSIGHT_CONFIG: selfHostedCfg, HOME: tmp }),
    );
    assert.equal(selfHostedStatus.result, 0, selfHostedStatus.stderr);
    assert.ok(seenAuthHeaders.length > 0);
    assert.ok(seenAuthHeaders.every((h) => h === null));

    // 3. Env fallback HINDSIGHT_SERVER_MODE=daemon defaults to port 9077
    const defaultDaemonConn = resolveHindsightConnection({
      cwd: workRepo,
      env: { HINDSIGHT_CONFIG: path.join(tmp, 'missing.json'), HINDSIGHT_SERVER_MODE: 'daemon' },
      home: tmp,
    });
    assert.equal(defaultDaemonConn.apiUrl, 'http://127.0.0.1:9077');
    assert.equal(defaultDaemonConn.apiToken, '');

    // 4. Cloud target with no token still fails with exit 2
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: workRepo,
          env: {
            HINDSIGHT_CONFIG: path.join(tmp, 'missing.json'),
            HINDSIGHT_TOKEN_FILE: path.join(tmp, 'missing-token'),
          },
          home: tmp,
        }),
      /No Hindsight API token found for Cloud/,
    );

    // 5. Cross-origin path apiUrl override clears inherited Cloud token instead of forwarding it
    const crossOriginCfg = path.join(tmp, 'cross-origin.json');
    writeFileSync(
      crossOriginCfg,
      JSON.stringify({
        apiToken: 'cloud-secret-token-999',
        paths: {
          '~/oss': { apiUrl: `http://127.0.0.1:${port}` },
        },
      }),
    );
    const crossConn = resolveHindsightConnection({
      cwd: ossRepo,
      env: { HINDSIGHT_CONFIG: crossOriginCfg },
      home: tmp,
    });
    assert.equal(crossConn.apiUrl, `http://127.0.0.1:${port}`);
    assert.equal(crossConn.apiToken, '');

    // 6. Removed --api-url CLI flag is rejected with exit 2 and makes zero HTTP requests
    seenAuthHeaders.length = 0;
    const apiUrlFlagRun = await captureLogs(() =>
      main(['status', '--cwd', workRepo, '--api-url', `http://127.0.0.1:${port}`], {
        HINDSIGHT_CONFIG: mixedCfg,
        HOME: tmp,
      }),
    );
    assert.equal(apiUrlFlagRun.result, 2);
    assert.match(apiUrlFlagRun.stderr, /Unknown argument: --api-url/);
    assert.equal(seenAuthHeaders.length, 0);

    // 7. Implicit self-hosted apiUrl overridden by serverMode: "cloud" resets to Cloud and never leaks Cloud token to self-hosted
    const implicitSelfHostedToCloudCfg = path.join(tmp, 'self-hosted-to-cloud.json');
    writeFileSync(
      implicitSelfHostedToCloudCfg,
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}`,
        apiToken: 'self-hosted-secret-token',
        paths: {
          '~/work': { serverMode: 'cloud', apiToken: 'cloud-override-token' },
          '~/oss': { serverMode: 'cloud' },
        },
      }),
    );

    const cloudWithTokenConn = resolveHindsightConnection({
      cwd: workRepo,
      env: { HINDSIGHT_CONFIG: implicitSelfHostedToCloudCfg },
      home: tmp,
    });
    assert.equal(cloudWithTokenConn.serverMode, 'cloud');
    assert.equal(cloudWithTokenConn.apiUrl, 'https://api.hindsight.vectorize.io');
    assert.equal(cloudWithTokenConn.apiToken, 'cloud-override-token');

    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: ossRepo,
          env: { HINDSIGHT_CONFIG: implicitSelfHostedToCloudCfg },
          home: tmp,
        }),
      /No Hindsight API token found for Cloud/,
    );

    // Env HINDSIGHT_API_URL overridden by file { serverMode: "cloud" } without token resets to Cloud and fails closed
    const envToCloudCfg = path.join(tmp, 'env-to-cloud.json');
    writeFileSync(envToCloudCfg, JSON.stringify({ serverMode: 'cloud' }));
    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: workRepo,
          env: {
            HINDSIGHT_CONFIG: envToCloudCfg,
            HINDSIGHT_API_URL: `http://127.0.0.1:${port}`,
            HINDSIGHT_API_TOKEN: 'self-hosted-env-token',
            HINDSIGHT_TOKEN_FILE: path.join(tmp, 'missing-token'),
          },
          home: tmp,
        }),
      /No Hindsight API token found for Cloud/,
    );

    // Lower layer pairing explicit serverMode: "cloud" with custom apiUrl still resets to Cloud on higher serverMode: "cloud"
    const explicitCloudCustomUrlCfg = path.join(tmp, 'cloud-custom-url-reset.json');
    writeFileSync(
      explicitCloudCustomUrlCfg,
      JSON.stringify({
        serverMode: 'cloud',
        apiUrl: `http://127.0.0.1:${port}`,
        apiToken: 'custom-origin-token',
        paths: {
          '~/work': { serverMode: 'cloud', apiToken: 'cloud-override-token' },
          '~/oss': { serverMode: 'cloud' },
        },
      }),
    );
    const resetWithTokenConn = resolveHindsightConnection({
      cwd: workRepo,
      env: { HINDSIGHT_CONFIG: explicitCloudCustomUrlCfg },
      home: tmp,
    });
    assert.equal(resetWithTokenConn.serverMode, 'cloud');
    assert.equal(resetWithTokenConn.apiUrl, 'https://api.hindsight.vectorize.io');
    assert.equal(resetWithTokenConn.apiToken, 'cloud-override-token');

    assert.throws(
      () =>
        resolveHindsightConnection({
          cwd: ossRepo,
          env: { HINDSIGHT_CONFIG: explicitCloudCustomUrlCfg },
          home: tmp,
        }),
      /No Hindsight API token found for Cloud/,
    );
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gitlog duplicate detection and delete-doc protect sibling repos on shared banks and sole gitlog:checkout seeds', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hindsight-dream-gitlog-'));
  const repoDir = path.join(tmp, 'backend');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });

  const docs = new Map([
    ['gitlog:checkout', { id: 'gitlog:checkout', memory_unit_count: 8, updated_at: '2026-11-26T00:00:00Z' }],
    ['gitlog:frontend', { id: 'gitlog:frontend', memory_unit_count: 15, updated_at: '2026-11-26T00:00:00Z' }],
  ]);
  const deletedDocs = [];

  const server = http.createServer((req, res) => {
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    const prefix = '/v1/default/banks/team%3A%3Ashared';
    const sub = url.pathname.slice(prefix.length);
    if (req.method === 'GET' && sub === '/stats') return send(200, { total_nodes: 2, total_documents: docs.size });
    if (req.method === 'GET' && sub === '/observations/scopes') return send(200, { scopes: [] });
    if (req.method === 'GET' && sub === '/pages/tree') return send(200, { roots: [] });
    if (req.method === 'GET' && sub === '/mental-models') return send(200, { items: [] });
    if (req.method === 'GET' && sub === '/memories/list') return send(200, { items: [], total: 0 });
    if (req.method === 'GET' && sub === '/documents') {
      const q = url.searchParams.get('q') || '';
      const items = [...docs.values()].filter((d) => !q || d.id.includes(q));
      return send(200, { items, total: items.length });
    }
    if (sub.startsWith('/documents/')) {
      const docId = decodeURIComponent(sub.slice('/documents/'.length));
      if (req.method === 'GET') {
        const doc = docs.get(docId);
        return doc ? send(200, doc) : send(404, {});
      }
      if (req.method === 'DELETE') {
        if (!docs.has(docId)) return send(404, {});
        docs.delete(docId);
        deletedDocs.push(docId);
        return send(200, { success: true });
      }
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const cfgPath = path.join(tmp, 'coding-agent.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}`,
      bankId: 'team::shared',
    }),
  );
  const env = { HINDSIGHT_CONFIG: cfgPath, HOME: tmp };

  try {
    // 1. When canonical gitlog:backend is absent, even gitlog:checkout is NOT flagged or deletable
    const candNoCanonical = await captureLogs(() =>
      main(['candidates', '--cwd', repoDir, '--json'], env),
    );
    assert.equal(candNoCanonical.result, 0, candNoCanonical.stderr);
    assert.deepEqual(JSON.parse(candNoCanonical.stdout).duplicateGitlogs, []);

    const refuseSoleCheckout = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'gitlog:checkout', '--reason', 'stale'], env),
    );
    assert.equal(refuseSoleCheckout.result, 2);
    assert.match(refuseSoleCheckout.stderr, /while canonical "gitlog:backend" is absent/);
    assert.equal(docs.has('gitlog:checkout'), true);

    // 2. Once canonical gitlog:backend exists, ONLY generic checkout/workspace aliases are duplicates; sibling gitlog:frontend is protected
    docs.set('gitlog:backend', { id: 'gitlog:backend', memory_unit_count: 20, updated_at: '2026-11-27T00:00:00Z' });
    docs.set('gitlog:workspace', { id: 'gitlog:workspace', memory_unit_count: 5, updated_at: '2026-11-26T00:00:00Z' });

    const candWithCanonical = await captureLogs(() =>
      main(['candidates', '--cwd', repoDir, '--json'], env),
    );
    assert.equal(candWithCanonical.result, 0, candWithCanonical.stderr);
    assert.deepEqual(
      JSON.parse(candWithCanonical.stdout).duplicateGitlogs.map((d) => d.id).sort(),
      ['gitlog:checkout', 'gitlog:workspace'],
    );

    const refuseSibling = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'gitlog:frontend', '--reason', 'nope'], env),
    );
    assert.equal(refuseSibling.result, 2);
    assert.equal(docs.has('gitlog:frontend'), true);

    const allowAlias = await captureLogs(() =>
      main(['delete-doc', '--cwd', repoDir, '--id', 'gitlog:workspace', '--reason', 'duplicate alias'], env),
    );
    assert.equal(allowAlias.result, 0, allowAlias.stderr);
    assert.deepEqual(deletedDocs, ['gitlog:workspace']);

    // Explicit --allow-other-gitlog permits confirmed non-alias deletion when canonical exists
    const allowExplicitSibling = await captureLogs(() =>
      main(
        ['delete-doc', '--cwd', repoDir, '--id', 'gitlog:frontend', '--allow-other-gitlog', '--reason', 'retired repo'],
        env,
      ),
    );
    assert.equal(allowExplicitSibling.result, 0, allowExplicitSibling.stderr);
    assert.deepEqual(deletedDocs, ['gitlog:workspace', 'gitlog:frontend']);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

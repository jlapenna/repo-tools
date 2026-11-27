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

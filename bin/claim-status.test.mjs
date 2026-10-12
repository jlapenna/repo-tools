import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, fetchIssueState, heartbeat, parseDuration, parseMarker, parseTarget, renderMarker } from './claim-status.mjs';

const script = fileURLToPath(new URL('./claim-status.mjs', import.meta.url));
const target = { owner: 'acme', repo: 'app', number: 42 };
const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const opts = { now: NOW, staleAfterMs: 60 * 60_000, prStaleAfterMs: 24 * 3_600_000 };
const pr = (over = {}) => ({ url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: true, headRefName: 'work/42', updatedAt: ago(5), title: 'wip', body: '', ...over });
const comment = (body, over = {}) => ({ id: 1, url: 'https://github.com/acme/app/issues/42#c1', body, createdAt: ago(10), updatedAt: ago(10), author: 'bot', ...over });
const state = (over = {}) => ({ state: 'OPEN', pullRequests: [], comments: [], ...over });

test('parses targets and durations', () => {
  assert.deepEqual(parseTarget('acme/app#42'), target);
  assert.throws(() => parseTarget('acme/app 42'));
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('60m'), 3_600_000);
  assert.equal(parseDuration('45'), 45 * 60_000);
  assert.equal(parseDuration('2d'), 2 * 86_400_000);
  assert.throws(() => parseDuration('soon'));
});

test('marker round-trips through render and parse', () => {
  const body = renderMarker({ owner: 'https://claude.ai/code/session_x', branch: 'feat/a', lastActive: '2026-10-12T11:55:00Z', note: 'adopting' });
  assert.deepEqual(parseMarker(body), { owner: 'https://claude.ai/code/session_x', branch: 'feat/a', 'last-active': '2026-10-12T11:55:00Z' });
  assert.equal(parseMarker('no marker here'), undefined);
});

test('no evidence is free', () => {
  assert.equal(classify(state(), target, opts).status, 'free');
});

test('a closed issue is closed regardless of claims', () => {
  assert.equal(classify(state({ state: 'CLOSED', pullRequests: [pr({ closing: true })] }), target, opts).status, 'closed');
});

test('an open linked draft PR is a live claim', () => {
  const result = classify(state({ pullRequests: [pr({ closing: true })] }), target, opts);
  assert.equal(result.status, 'live');
  assert.equal(result.evidence[0].kind, 'pull-request');
  assert.equal(result.evidence[0].draft, true);
});

test('a cross-referencing PR counts only when it names the issue with a reference keyword', () => {
  const mention = pr({ body: 'see also #42 for background' });
  assert.equal(classify(state({ pullRequests: [mention] }), target, opts).status, 'free');
  for (const body of ['Refs #42', 'Closes acme/app#42', 'fixes: #42', 'Resolves #42']) {
    assert.equal(classify(state({ pullRequests: [pr({ body })] }), target, opts).status, 'live', body);
  }
  assert.equal(classify(state({ pullRequests: [pr({ body: 'Refs #420' })] }), target, opts).status, 'free');
});

test('closed and merged PRs are not claims', () => {
  assert.equal(classify(state({ pullRequests: [pr({ closing: true, state: 'MERGED' })] }), target, opts).status, 'free');
});

test('an untouched PR goes stale and names the branch to adopt', () => {
  const result = classify(state({ pullRequests: [pr({ closing: true, updatedAt: ago(25 * 60) })] }), target, opts);
  assert.equal(result.status, 'stale');
  assert.equal(result.adoptBranch, 'work/42');
});

test('a fresh heartbeat is live; an old one is stale', () => {
  const fresh = comment(renderMarker({ owner: 'session-a', branch: 'feat/x', lastActive: ago(20) }));
  assert.equal(classify(state({ comments: [fresh] }), target, opts).status, 'live');
  const old = comment(renderMarker({ owner: 'session-a', branch: 'feat/x', lastActive: ago(90) }));
  const result = classify(state({ comments: [old] }), target, opts);
  assert.equal(result.status, 'stale');
  assert.equal(result.adoptBranch, 'feat/x');
});

test('the newest heartbeat wins over older ones', () => {
  const old = comment(renderMarker({ owner: 'a', lastActive: ago(300) }), { id: 1 });
  const fresh = comment(renderMarker({ owner: 'b', lastActive: ago(5) }), { id: 2 });
  const result = classify(state({ comments: [old, fresh] }), target, opts);
  assert.equal(result.status, 'live');
  assert.equal(result.evidence.find((e) => e.kind === 'heartbeat').owner, 'b');
});

// The 2026-10-11 incident: a takeover comment three hours old with no PR read
// as live to one session and abandoned to another. Without a heartbeat it now
// ages out on the same threshold for everyone.
test('unmarked legacy takeover comments age out on the stale threshold', () => {
  const takeover = 'Session takeover: Claude Code subagent; worktree /home/x/w1a; branch refactor/a.';
  assert.equal(classify(state({ comments: [comment(takeover, { createdAt: ago(30) })] }), target, opts).status, 'live');
  assert.equal(classify(state({ comments: [comment(takeover, { createdAt: ago(180) })] }), target, opts).status, 'stale');
  const cloud = 'Interactive maintainer session is implementing this now (worktree refactor-6093).';
  assert.equal(classify(state({ comments: [comment(cloud, { createdAt: ago(10) })] }), target, opts).status, 'live');
  assert.equal(classify(state({ comments: [comment('LGTM, thanks!')] }), target, opts).status, 'free');
});

test('a live PR keeps the claim live even when comments are old', () => {
  const old = comment(renderMarker({ owner: 'a', lastActive: ago(600) }));
  assert.equal(classify(state({ pullRequests: [pr({ closing: true })], comments: [old] }), target, opts).status, 'live');
});

const fakeIssue = (comments = []) => JSON.stringify({ data: { repository: { issue: {
  state: 'OPEN',
  closedByPullRequestsReferences: { nodes: [pr()] },
  timelineItems: { nodes: [{ source: pr({ url: 'https://github.com/acme/app/pull/8', body: 'Refs #42' }) }, { source: {} }] },
  comments: { nodes: comments.map((c) => ({ databaseId: c.id, url: c.url, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: { login: c.author } })) },
} } } });

test('fetchIssueState merges closing and cross-referenced PRs', () => {
  const data = fetchIssueState(target, () => fakeIssue());
  assert.equal(data.pullRequests.length, 2);
  assert.equal(data.pullRequests[0].closing, true);
});

test('heartbeat creates a marker, then refreshes the same comment', () => {
  const calls = [];
  const runFor = (comments) => (args, input) => {
    calls.push({ args, input });
    if (args[1] === 'user') return 'me\n';
    if (args[1] === 'graphql') return fakeIssue(comments);
    return 'https://github.com/acme/app/issues/42#c9\n';
  };
  const first = heartbeat(target, { owner: 'session-a', branch: 'feat/x' }, { run: runFor([]), now: new Date(NOW) });
  assert.equal(first.updated, false);
  const post = calls.at(-1);
  assert.deepEqual(post.args.slice(0, 4), ['api', '-X', 'POST', 'repos/acme/app/issues/42/comments']);
  assert.equal(parseMarker(JSON.parse(post.input).body)['last-active'], '2026-10-12T12:00:00Z');

  calls.length = 0;
  const mine = comment(renderMarker({ owner: 'session-a', lastActive: ago(50) }), { id: 77, author: 'me' });
  const someoneElse = comment(renderMarker({ owner: 'session-a', lastActive: ago(5) }), { id: 78, author: 'other' });
  const second = heartbeat(target, { owner: 'session-a' }, { run: runFor([mine, someoneElse]), now: new Date(NOW) });
  assert.equal(second.updated, true);
  assert.deepEqual(calls.at(-1).args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/acme/app/issues/comments/77']);
});

test('heartbeat requires an owner label', () => {
  assert.throws(() => heartbeat(target, {}, { run: () => '' }), /--owner/);
});

test('CLI rejects bad usage with exit 2', () => {
  const none = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  const bad = spawnSync(process.execPath, [script, 'acme/app#1', '--frobnicate'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--heartbeat/);
});

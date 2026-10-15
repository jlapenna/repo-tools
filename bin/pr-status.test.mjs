// Runs repo-pr-status end to end against a fake `gh` that serves recorded
// GraphQL shapes, so each result state and exit code is checked through the
// real command line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./pr-status.mjs', import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), 'pr-status-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const check = (name, status, conclusion, isRequired = true) => ({ __typename: 'CheckRun', name, status, conclusion, isRequired });

function pullRequest(overrides = {}) {
  const { contexts = [check('verify', 'COMPLETED', 'SUCCESS')], threads = [], commitOid = HEAD, ...pr } = overrides;
  return {
    number: 7,
    state: 'OPEN',
    isDraft: false,
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: { mergeMethod: 'SQUASH' },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
    commits: { nodes: [{ commit: { oid: commitOid, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: contexts } } } }] },
    ...pr,
  };
}

const ghPath = path.join(tmp, 'gh');
writeFileSync(
  ghPath,
  `#!/usr/bin/env bash
case "$1 $2" in
  'repo view') echo 'owner/repo' ;;
  'pr view') [ "$3" = --repo ] && echo 8 || echo 7 ;;
  'api graphql')
    [ -n "$GH_FAIL" ] && { echo "$GH_FAIL" >&2; exit 1; }
    printf '%s\n' "$@" >"$GH_ARGS"
    cat "$GH_BODY" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(ghPath, 0o755);

function run(body, { args = ['--json', '7'], env = {} } = {}) {
  const bodyPath = path.join(tmp, 'body.json');
  writeFileSync(bodyPath, typeof body === 'string' ? body : JSON.stringify(body));
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, GH_BODY: bodyPath, GH_ARGS: path.join(tmp, 'args'), ...env },
  });
  return { status: result.status, stdout: result.stdout, json: args.includes('--json') ? JSON.parse(result.stdout) : undefined };
}
const prBody = (overrides) => ({ data: { repository: { pullRequest: pullRequest(overrides) } } });

test('green, mergeable, armed PR is ready at its head', () => {
  const { status, json } = run(prBody());
  assert.equal(status, 0);
  assert.equal(json.state, 'ready');
  assert.equal(json.head, HEAD);
  assert.deepEqual(json.reasons, []);
  assert.deepEqual(json.requiredChecks, { total: 1, passed: 1, pending: 0, failed: [] });
});

test('pending required checks wait; optional checks are ignored', () => {
  const contexts = [check('verify', 'IN_PROGRESS', null), check('optional lint', 'COMPLETED', 'FAILURE', false)];
  const { status, json } = run(prBody({ contexts, mergeStateStatus: 'BLOCKED' }));
  assert.equal(status, 0);
  assert.equal(json.state, 'waiting');
  assert.deepEqual(json.reasons, ['checks-pending:1', 'merge-state:BLOCKED']);
});

test('failed or cancelled required checks block with one-token names', () => {
  const contexts = [
    check('E2E Tests', 'COMPLETED', 'FAILURE'),
    check('verify', 'COMPLETED', 'CANCELLED'),
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', isRequired: true },
  ];
  const { status, json } = run(prBody({ contexts, mergeStateStatus: 'BLOCKED' }));
  assert.equal(status, 2);
  assert.equal(json.state, 'blocked');
  assert.equal(json.reasons[0], 'checks-failed:E2E_Tests,verify,ci/legacy');
});

test('conflicting PR is blocked as dirty', () => {
  const { status, json } = run(prBody({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
  assert.equal(status, 2);
  assert.deepEqual(json.reasons, ['dirty']);
});

test('unresolved review threads block a green PR', () => {
  const threads = [{ isResolved: true }, { isResolved: false }, { isResolved: false }];
  const { status, json } = run(prBody({ threads, mergeStateStatus: 'BLOCKED' }));
  assert.equal(status, 2);
  assert.deepEqual(json.reasons, ['unresolved-threads:2', 'merge-state:BLOCKED']);
  assert.equal(json.unresolvedThreads, 2);
});

test('green PR without auto-merge is blocked, with a human summary', () => {
  const { status, stdout } = run(prBody({ autoMergeRequest: null }), { args: ['7'] });
  assert.equal(status, 2);
  assert.match(stdout, /^PR #7 owner\/repo @ aaaaaaaaaaaa: BLOCKED auto-merge-unarmed\n/);
  assert.match(stdout, /required checks 1\/1 passed, 0 pending, 0 failed; merge MERGEABLE\/CLEAN; auto-merge unarmed; unresolved threads 0/);
});

test('merged PRs succeed and closed PRs need attention', () => {
  assert.equal(run(prBody({ state: 'MERGED' })).json.state, 'merged');
  const closed = run(prBody({ state: 'CLOSED' }));
  assert.equal(closed.status, 2);
  assert.deepEqual(closed.json.reasons, ['closed-unmerged']);
});

test('checks from a stale commit are indeterminate, not green', () => {
  const { status, json } = run(prBody({ commitOid: 'b'.repeat(40) }));
  assert.equal(status, 3);
  assert.equal(json.state, 'indeterminate');
  assert.match(json.error, /not for head/);
});

test('GitHub API and GraphQL errors are indeterminate', () => {
  const graphqlError = run({ data: { repository: null }, errors: [{ message: 'rate limited' }] });
  assert.equal(graphqlError.status, 3);
  assert.deepEqual(graphqlError.json, { repo: null, pr: 7, state: 'indeterminate', error: 'GraphQL: rate limited' });

  const apiError = run(prBody(), { env: { GH_FAIL: 'HTTP 502' } });
  assert.equal(apiError.status, 3);
  assert.match(apiError.json.error, /HTTP 502/);

  assert.equal(run('not json').status, 3);
  assert.equal(run({ data: { repository: { pullRequest: null } } }).status, 3);
});

test('current-branch PR is used when no number is given', () => {
  const { status, json } = run(prBody(), { args: ['--json'] });
  assert.equal(status, 0);
  assert.equal(json.repo, 'owner/repo');
  assert.equal(json.pr, 7);
});

test('--repo without a number resolves the PR in that repository, sending names as strings', () => {
  const { status, json } = run(prBody({ number: 8 }), { args: ['--json', '--repo', 'org/123'] });
  assert.equal(status, 0);
  assert.equal(json.repo, 'org/123');
  const args = readFileSync(path.join(tmp, 'args'), 'utf8').split('\n');
  assert.deepEqual(args.slice(2, 8), ['-f', 'owner=org', '-f', 'name=123', '-F', 'pr=8']);
});

test('rejects unknown arguments', () => {
  assert.equal(run(prBody(), { args: ['--watch'] }).status, 64);
});

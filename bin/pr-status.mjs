#!/usr/bin/env node
// One-shot, read-only pull request status: the actionable state of a PR at its
// current head, from a single GraphQL read. `repo-watch-prs` remains the
// lifecycle monitor; this answers "what does this PR need right now?" once.
//
// Usage: repo-pr-status [--json] [--repo OWNER/NAME] [PR]
//   PR defaults to the pull request for the current branch.
//
// Result states and exit codes (stable contract):
//   merged         0  the PR has merged
//   ready          0  required checks green, mergeable, auto-merge armed
//   waiting        0  nothing to fix yet (checks pending, mergeability or
//                     protection still settling)
//   blocked        2  needs action; see reasons
//   closed         2  closed without merging
//   indeterminate  3  GitHub could not answer; never treat as success
//   usage error    64
//
// Reasons are whitespace-free tokens shared with repo-watch-prs where they
// overlap: checks-failed:<names>, checks-pending:<n>, dirty,
// unresolved-threads:<n>, auto-merge-unarmed, draft, behind,
// mergeability-unknown, merge-state:<STATE>, closed-unmerged.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUERY = `query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      number state isDraft headRefOid mergeable mergeStateStatus
      autoMergeRequest { mergeMethod }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
      commits(last: 1) { nodes { commit { oid
        statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $pr) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $pr) }
        } } }
      } } }
    }
  }
}`;

const EXIT = { merged: 0, ready: 0, waiting: 0, blocked: 2, closed: 2, indeterminate: 3 };
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

class Indeterminate extends Error {}

function bucket(context) {
  if (context.__typename === 'StatusContext') {
    if (context.state === 'SUCCESS') return 'pass';
    return context.state === 'PENDING' || context.state === 'EXPECTED' ? 'pending' : 'fail';
  }
  if (context.status !== 'COMPLETED') return 'pending';
  return PASS.has(context.conclusion) ? 'pass' : 'fail';
}

// Classify a GraphQL pullRequest node. Throws Indeterminate when the evidence
// is incomplete or not tied to the current head.
export function classify(pr) {
  if (!pr) throw new Indeterminate('pull request not found');
  const head = pr.commits?.nodes?.[0]?.commit;
  if (!head || head.oid !== pr.headRefOid) {
    throw new Indeterminate(`check evidence is not for head ${pr.headRefOid}`);
  }
  const contexts = head.statusCheckRollup?.contexts;
  if (contexts?.pageInfo?.hasNextPage || pr.reviewThreads.pageInfo.hasNextPage) {
    throw new Indeterminate('more than 100 checks or review threads; refusing a partial answer');
  }
  const required = (contexts?.nodes ?? []).filter((c) => c.isRequired);
  const failed = required.filter((c) => bucket(c) === 'fail').map((c) => c.name ?? c.context);
  const pending = required.filter((c) => bucket(c) === 'pending').length;
  const unresolved = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;
  const autoMerge = pr.autoMergeRequest ? pr.autoMergeRequest.mergeMethod : null;

  const result = {
    pr: pr.number,
    head: pr.headRefOid,
    state: '',
    reasons: [],
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    autoMerge,
    requiredChecks: { total: required.length, passed: required.length - failed.length - pending, pending, failed },
    unresolvedThreads: unresolved,
  };
  if (pr.state === 'MERGED') return { ...result, state: 'merged' };
  if (pr.state === 'CLOSED') return { ...result, state: 'closed', reasons: ['closed-unmerged'] };

  const blocked = [];
  if (failed.length) blocked.push(`checks-failed:${failed.map((n) => n.replace(/[\s,]+/g, '_')).join(',')}`);
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') blocked.push('dirty');
  if (unresolved) blocked.push(`unresolved-threads:${unresolved}`);
  if (pr.isDraft) blocked.push('draft');
  if (!autoMerge) blocked.push('auto-merge-unarmed');

  const waiting = [];
  if (pending) waiting.push(`checks-pending:${pending}`);
  if (pr.mergeable === 'UNKNOWN') waiting.push('mergeability-unknown');
  if (pr.mergeStateStatus === 'BEHIND') waiting.push('behind');
  else if (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'DIRTY'].includes(pr.mergeStateStatus)) {
    waiting.push(`merge-state:${pr.mergeStateStatus}`);
  }

  if (blocked.length) return { ...result, state: 'blocked', reasons: [...blocked, ...waiting] };
  if (waiting.length) return { ...result, state: 'waiting', reasons: waiting };
  return { ...result, state: 'ready' };
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim().split('\n')[0];
    throw new Indeterminate(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`);
  }
}

export function status({ repo, number }) {
  const nameWithOwner = repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const prNumber = number ?? Number(gh(['pr', 'view', '--json', 'number', '--jq', '.number']));
  const [owner, name] = nameWithOwner.split('/');
  const raw = gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${prNumber}`, '-f', `query=${QUERY}`]);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Indeterminate('GitHub returned non-JSON output');
  }
  if (body.errors?.length) throw new Indeterminate(`GraphQL: ${body.errors[0].message}`);
  return { repo: nameWithOwner, ...classify(body.data?.repository?.pullRequest) };
}

function summary(r) {
  if (r.state === 'indeterminate') return `PR #${r.pr ?? '?'}: INDETERMINATE ${r.error}`;
  const checks = r.requiredChecks;
  return [
    `PR #${r.pr} ${r.repo} @ ${r.head.slice(0, 12)}: ${r.state.toUpperCase()}${r.reasons.length ? ` ${r.reasons.join(' ')}` : ''}`,
    `  required checks ${checks.passed}/${checks.total} passed, ${checks.pending} pending, ${checks.failed.length} failed;` +
      ` merge ${r.mergeable}/${r.mergeState}; auto-merge ${r.autoMerge ?? 'unarmed'}; unresolved threads ${r.unresolvedThreads}`,
  ].join('\n');
}

function main(argv) {
  let json = false;
  let repo;
  let number;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--repo' && /^[\w.-]+\/[\w.-]+$/.test(argv[i + 1] ?? '')) repo = argv[++i];
    else if (/^\d+$/.test(arg) && number === undefined) number = Number(arg);
    else {
      process.stderr.write('usage: repo-pr-status [--json] [--repo OWNER/NAME] [PR]\n');
      return 64;
    }
  }
  let result;
  try {
    result = status({ repo, number });
  } catch (error) {
    if (!(error instanceof Indeterminate)) throw error;
    result = { repo: repo ?? null, pr: number ?? null, state: 'indeterminate', error: error.message };
  }
  process.stdout.write(`${json ? JSON.stringify(result) : summary(result)}\n`);
  return EXIT[result.state];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

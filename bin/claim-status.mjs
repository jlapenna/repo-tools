#!/usr/bin/env node
// Report whether someone is live on a GitHub issue, using only GitHub state.
//
// Every session that decides "is this claim stale?" must see the same
// evidence. A worktree on one workstation is invisible to a cloud session, and
// a takeover comment says nothing about whether its author is still running,
// so both used to be read by eye and both failed (jlapenna/agent-lcars#2502:
// three parties implemented the same eight issues at once).
//
// A claim is live when either:
// - an open pull request is linked to the issue (closing reference, or a
//   `Refs`/`Closes`/`Fixes`/`Resolves` line naming it) and was updated within
//   --pr-stale-after (default 24h). A draft PR is the strongest claim: it is
//   visible to every executor and survives its author dying; or
// - the newest `work-claim:v1` marker comment has a `last-active` within
//   --stale-after (default 60m). Claimants refresh it with --heartbeat.
// Unmarked legacy takeover comments ("Session takeover", "implementing this
// now") count only while younger than --stale-after.
//
// Only trusted authors can claim: repository owners, members and
// collaborators, plus bot logins named with --trust-bot or the comma-separated
// REPO_CLAIM_TRUSTED_BOTS. Anyone else's PRs and comments are ignored, so a
// drive-by comment cannot block an issue. A PR's activity is its head commit
// date, not updatedAt, which any commenter can bump. A marker's last-active never counts
// as later than the comment's own last edit, so a forged future timestamp
// cannot keep a claim alive. A PR in another repository must name the issue
// as owner/repo#N; its bare #N means an issue in its own repository.
//
// Statuses: closed, live, stale (claim evidence exists but is old; adopt the
// listed branch instead of starting over), free (no claim evidence).
//
// Usage:
//   repo-claim-status <owner/repo#N> [--json] [--stale-after 60m] [--pr-stale-after 24h] [--trust-bot <login>]...
//   repo-claim-status <owner/repo#N> --heartbeat --owner <label> [--branch <name>] [--note <text>]
// Exit codes (check mode): 0 free or closed, 10 live, 11 stale, 2 usage, 1 error.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKER = /<!--\s*work-claim:v1\b([^>]*)-->/;
const LEGACY = /session takeover|implementing this now|taking (this|it) over|^\s*claim(ed|ing)?\b/im;
const EXIT = { free: 0, closed: 0, live: 10, stale: 11 };
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function trusted(author, association, trustedBots = []) {
  return TRUSTED.has(association) || trustedBots.includes(author ?? '');
}

export function parseDuration(text) {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(String(text).trim());
  if (!match) throw new Error(`bad duration: ${text} (use e.g. 90s, 60m, 24h, 2d)`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 'm'];
  return Number(match[1]) * unit * 1000;
}

export function parseTarget(text) {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text ?? '');
  if (!match) throw new Error(`expected <owner/repo#N>, got: ${text}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export function parseMarker(body) {
  const match = MARKER.exec(body ?? '');
  if (!match) return undefined;
  const fields = {};
  for (const [, key, value] of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) fields[key] = value;
  return fields;
}

export function renderMarker({ owner, branch, lastActive, note }) {
  const quote = (value) => String(value).replaceAll('"', "'");
  const attrs = [`owner="${quote(owner)}"`];
  if (branch) attrs.push(`branch="${quote(branch)}"`);
  attrs.push(`last-active="${lastActive}"`);
  const lines = [`Work claim: **${owner}** is active on this issue${branch ? ` (branch \`${branch}\`)` : ''}. Last active ${lastActive}.`];
  if (note) lines.push('', note);
  lines.push('', `<!-- work-claim:v1 ${attrs.join(' ')} -->`);
  return lines.join('\n');
}

function referencesIssue(body, target, sameRepo) {
  const qualified = `${target.owner}/${target.repo}`.replace(/[.]/g, '\\.');
  const ref = `${sameRepo ? `(?:${qualified})?` : qualified}#${target.number}\\b`;
  return new RegExp(`\\b(?:refs?|closes?|closed|fix(?:es|ed)?|resolves?|resolved)[:\\s]+${ref}`, 'i').test(body ?? '');
}

// Pure classification over fetched GitHub state; `data` is the shape returned
// by fetchIssueState. Kept separate so tests need no network.
export function classify(data, target, { now = Date.now(), staleAfterMs = 3_600_000, prStaleAfterMs = 86_400_000, trustedBots = [] } = {}) {
  if (data.state === 'CLOSED') return { status: 'closed', evidence: [{ kind: 'issue', detail: 'issue is closed' }] };
  const evidence = [];
  const seen = new Set();
  for (const pr of data.pullRequests) {
    if (pr.state !== 'OPEN' || seen.has(pr.url) || !trusted(pr.author, pr.authorAssociation, trustedBots)) continue;
    const sameRepo = (pr.repository ?? `${target.owner}/${target.repo}`).toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase();
    if (!pr.closing && !referencesIssue(`${pr.title}\n${pr.body}`, target, sameRepo)) continue;
    seen.add(pr.url);
    const activeAt = pr.headCommittedAt ?? pr.updatedAt;
    const ageMs = now - Date.parse(activeAt);
    evidence.push({
      kind: 'pull-request',
      live: ageMs <= prStaleAfterMs,
      url: pr.url,
      branch: pr.headRefName,
      draft: pr.isDraft,
      lastActive: activeAt,
      detail: `${pr.isDraft ? 'draft ' : ''}PR ${pr.url} on ${pr.headRefName}, last commit ${activeAt}`,
    });
  }
  let newestMarker;
  for (const comment of data.comments) {
    if (!trusted(comment.author, comment.authorAssociation, trustedBots)) continue;
    const marker = parseMarker(comment.body);
    if (marker) {
      const claimed = Date.parse(marker['last-active'] ?? '');
      const edited = Date.parse(comment.updatedAt);
      const lastActive = new Date(Number.isNaN(claimed) ? edited : Math.min(claimed, edited)).toISOString();
      if (!newestMarker || Date.parse(lastActive) > Date.parse(newestMarker.lastActive)) {
        newestMarker = { comment, marker, lastActive };
      }
    } else if (LEGACY.test(comment.body ?? '')) {
      evidence.push({
        kind: 'legacy-comment',
        live: now - Date.parse(comment.createdAt) <= staleAfterMs,
        url: comment.url,
        lastActive: comment.createdAt,
        detail: `unmarked claim comment by ${comment.author} at ${comment.createdAt} (no heartbeat)`,
      });
    }
  }
  if (newestMarker) {
    const { comment, marker, lastActive } = newestMarker;
    evidence.push({
      kind: 'heartbeat',
      live: now - Date.parse(lastActive) <= staleAfterMs,
      url: comment.url,
      owner: marker.owner,
      branch: marker.branch,
      lastActive,
      detail: `work-claim by ${marker.owner ?? comment.author}${marker.branch ? ` on ${marker.branch}` : ''}, last active ${lastActive}`,
    });
  }
  const status = evidence.some((item) => item.live) ? 'live' : evidence.length ? 'stale' : 'free';
  const adopt = evidence.find((item) => item.kind === 'pull-request')?.branch ?? newestMarker?.marker.branch;
  return { status, evidence, ...(status === 'stale' && adopt ? { adoptBranch: adopt } : {}) };
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
}

const PR = 'url state isDraft headRefName updatedAt title body authorAssociation author{login} repository{nameWithOwner} commits(last:1){nodes{commit{committedDate}}}';
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){
  state
  closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{${PR}}}
  timelineItems(last:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){nodes{
    ... on CrossReferencedEvent{source{... on PullRequest{${PR}}}}
    ... on ConnectedEvent{subject{... on PullRequest{${PR}}}}}}
  comments(last:100){nodes{databaseId url body createdAt updatedAt authorAssociation author{login}}}}}}`;

export function fetchIssueState(target, run = gh) {
  const raw = run(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${target.owner}`, '-F', `repo=${target.repo}`, '-F', `number=${target.number}`]);
  const issue = JSON.parse(raw).data?.repository?.issue;
  if (!issue) throw new Error(`issue not found: ${target.owner}/${target.repo}#${target.number}`);
  const flat = ({ commits, ...pr }) => ({ ...pr, author: pr.author?.login, repository: pr.repository?.nameWithOwner, headCommittedAt: commits?.nodes?.[0]?.commit?.committedDate });
  const closing = issue.closedByPullRequestsReferences.nodes.map((pr) => ({ ...flat(pr), closing: true }));
  const linked = issue.timelineItems.nodes.map((node) => node.source ?? node.subject).filter((pr) => pr?.url).map(flat);
  return {
    state: issue.state,
    pullRequests: [...closing, ...linked],
    comments: issue.comments.nodes.map((c) => ({ id: c.databaseId, url: c.url, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: c.author?.login, authorAssociation: c.authorAssociation })),
  };
}

export function heartbeat(target, { owner, branch, note }, { run = gh, now = new Date() } = {}) {
  if (!owner) throw new Error('--heartbeat needs --owner <label> (a session URL or name others can recognize)');
  const login = run(['api', 'user', '--jq', '.login']).trim();
  const data = fetchIssueState(target, run);
  const mine = data.comments.filter((c) => c.author === login && parseMarker(c.body)?.owner === owner).at(-1);
  const body = renderMarker({ owner, branch, note, lastActive: now.toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const path = mine
    ? `repos/${target.owner}/${target.repo}/issues/comments/${mine.id}`
    : `repos/${target.owner}/${target.repo}/issues/${target.number}/comments`;
  const out = run(['api', '-X', mine ? 'PATCH' : 'POST', path, '--input', '-', '--jq', '.html_url'], JSON.stringify({ body }));
  return { url: out.trim(), updated: Boolean(mine) };
}

function parseArgs(argv) {
  const envBots = (process.env.REPO_CLAIM_TRUSTED_BOTS ?? '').split(',').map((b) => b.trim()).filter(Boolean);
  const opts = { json: false, heartbeat: false, staleAfter: '60m', prStaleAfter: '24h', trustedBots: envBots };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--json') opts.json = true;
    else if (arg === '--heartbeat') opts.heartbeat = true;
    else if (arg === '--owner') opts.owner = value();
    else if (arg === '--branch') opts.branch = value();
    else if (arg === '--note') opts.note = value();
    else if (arg === '--stale-after') opts.staleAfter = value();
    else if (arg === '--pr-stale-after') opts.prStaleAfter = value();
    else if (arg === '--trust-bot') opts.trustedBots.push(value());
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!opts.help && rest.length !== 1) throw new Error('expected exactly one <owner/repo#N>');
  return { ...opts, target: rest[0] };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`repo-claim-status: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${readUsage()}\n`);
    return 0;
  }
  const target = parseTarget(opts.target);
  if (opts.heartbeat) {
    const result = heartbeat(target, opts);
    process.stdout.write(opts.json ? `${JSON.stringify(result)}\n` : `${result.updated ? 'refreshed' : 'created'} ${result.url}\n`);
    return 0;
  }
  const result = classify(fetchIssueState(target), target, {
    staleAfterMs: parseDuration(opts.staleAfter),
    prStaleAfterMs: parseDuration(opts.prStaleAfter),
    trustedBots: opts.trustedBots,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.status}\n`);
    for (const item of result.evidence) process.stdout.write(`  ${item.live ? 'live ' : 'stale'} ${item.detail}\n`);
    if (result.adoptBranch) process.stdout.write(`  adopt: continue on ${result.adoptBranch} instead of starting a new branch\n`);
  }
  return EXIT[result.status];
}

function readUsage() {
  return 'usage: repo-claim-status <owner/repo#N> [--json] [--stale-after 60m] [--pr-stale-after 24h] [--trust-bot <login>]...\n' +
    '       repo-claim-status <owner/repo#N> --heartbeat --owner <label> [--branch <name>] [--note <text>]';
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`repo-claim-status: ${error.message}\n`);
    process.exitCode = 1;
  }
}

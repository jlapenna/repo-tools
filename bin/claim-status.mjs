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
//   --pr-stale-after (default 4h). A draft PR is the strongest claim: it is
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
// date clamped to updatedAt: commenters can bump updatedAt and committers can
// forge committedDate, but neither alone can extend a claim. A marker's last-active never counts
// as later than the comment's own last edit, so a forged future timestamp
// cannot keep a claim alive. A PR in another repository must name the issue
// as owner/repo#N; its bare #N means an issue in its own repository.
//
// Statuses: closed, live, stale (claim evidence exists but is old; adopt the
// listed branch instead of starting over), free (no claim evidence). With
// --self, the output adds the caller's next action (see nextAction). Pass
// your session label (the heartbeat --owner) and your branch; interactive
// sessions often share one login, so pass a login only when it identifies
// this executor alone (a fleet bot whose prior attempts are its own).
//
// Usage:
//   repo-claim-status <owner/repo#N> [--json] [--stale-after 60m] [--pr-stale-after 4h] [--trust-bot <login>]... [--self <login-or-owner>]...
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
export function classify(data, target, { now = Date.now(), staleAfterMs = 3_600_000, prStaleAfterMs = 4 * 3_600_000, trustedBots = [] } = {}) {
  if (data.state === 'CLOSED') return { status: 'closed', evidence: [{ kind: 'issue', detail: 'issue is closed' }] };
  const evidence = [];
  const seen = new Set();
  for (const pr of data.pullRequests) {
    if (pr.state !== 'OPEN' || seen.has(pr.url) || !trusted(pr.author, pr.authorAssociation, trustedBots)) continue;
    const sameRepo = (pr.repository ?? `${target.owner}/${target.repo}`).toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase();
    if (!pr.closing && !referencesIssue(`${pr.title}\n${pr.body}`, target, sameRepo)) continue;
    seen.add(pr.url);
    // committedDate is client-set and can be forged into the future; updatedAt
    // is server-set and moves on every push. The earlier of the two is the
    // latest moment the author provably pushed, and a comment-only bump of
    // updatedAt cannot raise it past the real commit.
    const committed = Date.parse(pr.headCommittedAt ?? '');
    const updated = Date.parse(pr.updatedAt);
    const activeAt = new Date(Number.isNaN(committed) ? updated : Math.min(committed, updated)).toISOString();
    const ageMs = now - Date.parse(activeAt);
    evidence.push({
      kind: 'pull-request',
      live: ageMs <= prStaleAfterMs,
      author: pr.author,
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
        author: comment.author,
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
      author: comment.author,
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

// What a would-be claimant should do, given who it is. `self` lists the
// caller's GitHub logins and heartbeat owner labels.
// - proceed: nothing to respect; claim with an early draft PR or heartbeat.
// - continue-own: every live claim is the caller's own (a prior attempt).
// - adopt: the claim is stale; continue on its branch instead of a new one,
//   and --heartbeat at once so a resuming previous owner stands down.
// - stand-down: someone else is live; coordinate, do not start parallel work.
// - none: the issue is closed.
export function nextAction(result, self = []) {
  const mine = new Set(self.map((name) => name.toLowerCase()));
  // A heartbeat names its session, so only its owner label makes it mine. Many
  // sessions push as one login, so a PR is mine by author or by my branch.
  const isMine = (item) => {
    const names = item.kind === 'heartbeat' ? [item.owner] : [item.author, item.branch];
    return names.some((name) => name && mine.has(name.toLowerCase()));
  };
  if (result.status === 'closed') return { action: 'none' };
  if (result.status === 'free') return { action: 'proceed' };
  if (result.status === 'live') {
    const foreign = result.evidence.filter((item) => item.live && !isMine(item));
    if (foreign.length === 0) {
      const own = result.evidence.find((item) => item.live && item.branch);
      return { action: 'continue-own', ...(own ? { branch: own.branch } : {}) };
    }
    return { action: 'stand-down', liveClaims: foreign.map((item) => item.url) };
  }
  return result.adoptBranch ? { action: 'adopt', branch: result.adoptBranch } : { action: 'proceed' };
}

// Report gh failures by gh's own message, not the (long) command line.
export function ghError(error) {
  const stderr = String(error?.stderr ?? '').trim().split('\n').filter(Boolean);
  return new Error(stderr.at(-1)?.replace(/^gh:\s*/, '') || error?.message || 'gh failed');
}

function gh(args, input) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw ghError(error);
  }
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
  let raw;
  try {
    raw = run(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${target.owner}`, '-F', `repo=${target.repo}`, '-F', `number=${target.number}`]);
  } catch (error) {
    if (/Could not resolve to an Issue/.test(error.message)) {
      throw new Error(`${target.owner}/${target.repo}#${target.number} is not an issue (a pull request number, or it does not exist); claims are checked on the issue a PR references`);
    }
    throw error;
  }
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
  const opts = { json: false, heartbeat: false, staleAfter: '60m', prStaleAfter: '4h', trustedBots: envBots, self: [] };
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
    else if (arg === '--self') opts.self.push(value());
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
  const next = opts.self.length ? nextAction(result, opts.self) : undefined;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(next ? { ...result, next } : result)}\n`);
  } else {
    process.stdout.write(`${result.status}\n`);
    for (const item of result.evidence) process.stdout.write(`  ${item.live ? 'live ' : 'stale'} ${item.detail}\n`);
    if (result.adoptBranch) process.stdout.write(`  adopt: continue on ${result.adoptBranch} instead of starting a new branch\n`);
    if (next) process.stdout.write(`next: ${next.action}${next.branch ? ` ${next.branch}` : ''}${next.liveClaims ? ` (${next.liveClaims.join(', ')})` : ''}\n`);
  }
  return EXIT[result.status];
}

function readUsage() {
  return 'usage: repo-claim-status <owner/repo#N> [--json] [--stale-after 60m] [--pr-stale-after 4h] [--trust-bot <login>]... [--self <login-or-owner>]...\n' +
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

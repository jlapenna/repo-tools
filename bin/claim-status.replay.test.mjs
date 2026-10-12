// Replay of the 2026-10-11 collision (jlapenna/agent-lcars#2502) against the
// claim protocol: each executor checks repo-claim-status before acting, then
// proceeds, adopts, continues its own work, or stands down. Acceptance: one
// pull request per issue. The baseline shows what the same timeline produced
// when nobody checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, nextAction, renderMarker } from './claim-status.mjs';

const target = { owner: 'supersprinklesracing', repo: 'sprinkles', number: 6095 };
const at = (hhmm) => Date.parse(`2026-10-11T${hhmm}:00Z`);
const iso = (ms) => new Date(ms).toISOString();

// Every interactive session pushed as the maintainer's login, so sessions are
// told apart by heartbeat owner and branch, exactly as the protocol asks.
function world() {
  const prs = [];
  const comments = [];
  let id = 0;
  const state = () => ({ state: 'OPEN', pullRequests: prs.map((pr) => ({ ...pr })), comments: comments.map((c) => ({ ...c })) });
  const heartbeat = (owner, branch, now) => {
    const existing = comments.find((c) => c.owner === owner);
    const body = renderMarker({ owner, branch, lastActive: iso(now) });
    if (existing) Object.assign(existing, { body, updatedAt: iso(now) });
    else comments.push({ id: ++id, owner, url: `c${id}`, body, createdAt: iso(now), updatedAt: iso(now), author: 'jlapenna', authorAssociation: 'OWNER' });
  };
  const commit = (branch, now) => {
    const pr = prs.find((p) => p.headRefName === branch);
    pr.headCommittedAt = iso(now);
    pr.updatedAt = iso(now);
  };
  return {
    prs,
    // One protocol step for one executor at one moment.
    step(actor, now) {
      const result = classify(state(), target, { now });
      // Interactive sessions share one login, so they identify by session and
      // branch; only the fleet identity may claim prior attempts by login.
      const self = [actor.session, ...(actor.fleet ? [actor.login] : []), ...(actor.branch ? [actor.branch] : [])];
      const next = nextAction(result, self);
      if (next.action === 'proceed') {
        actor.branch = `work/${actor.session}`;
        prs.push({ url: `pr-${actor.session}`, state: 'OPEN', isDraft: true, headRefName: actor.branch, closing: true,
          author: actor.login, authorAssociation: actor.login.endsWith('-bot') ? 'COLLABORATOR' : 'OWNER', repository: 'supersprinklesracing/sprinkles',
          updatedAt: iso(now), headCommittedAt: iso(now), title: 'wip', body: '' });
      } else if (next.action === 'adopt') {
        actor.branch = next.branch;
        heartbeat(actor.session, actor.branch, now);
        commit(actor.branch, now);
      } else if (next.action === 'continue-own') {
        heartbeat(actor.session, actor.branch, now);
        commit(actor.branch, now);
      }
      return next.action;
    },
  };
}

test('the 2026-10-11 timeline yields one pull request per issue under the claim protocol', () => {
  const w = world();
  const orchestrator = { session: 'session-orchestrator', login: 'jlapenna' };
  const cloud = { session: 'session-cloud-6095', login: 'jlapenna' };
  const adopter = { session: 'session-local-adopter', login: 'jlapenna' };
  const consoleRun = { session: 'console-run-1', login: 'agent-lcars-bot', fleet: true };

  // 02:54 the audit's orchestrator starts; 03:20 its early draft PR exists;
  // it commits until 03:46 and is then rate-limited overnight.
  assert.equal(w.step(orchestrator, at('02:54')), 'proceed');
  assert.equal(w.step(orchestrator, at('03:20')), 'continue-own');
  assert.equal(w.step(orchestrator, at('03:46')), 'continue-own');

  // 15:35 a cloud session is dispatched for the same issue. The draft has had
  // no commit for almost 12 hours, so it adopts that branch instead of forking.
  assert.equal(w.step(cloud, at('15:35')), 'adopt');
  assert.equal(cloud.branch, 'work/session-orchestrator');

  // 15:37 a second local session tries to adopt the idle worktree; the cloud
  // session's fresh heartbeat makes it stand down.
  assert.equal(w.step(adopter, at('15:37')), 'stand-down');

  // 15:43 the orchestrator resumes after its rate limit resets. Its own branch
  // now carries someone else's live heartbeat, so it stands down too.
  assert.equal(w.step(orchestrator, at('15:43')), 'stand-down');

  // 16:00 Console dispatches a fleet run (an agent:* label); it sees a live
  // foreign claim and stands down rather than opening a fourth PR.
  assert.equal(w.step(cloud, at('15:55')), 'continue-own');
  assert.equal(w.step(consoleRun, at('16:00')), 'stand-down');

  assert.equal(w.prs.length, 1);
});

test('baseline: the same timeline without a claim check opens one PR per executor', () => {
  // What happened: each executor judged staleness from its own local evidence
  // and opened its own branch and PR.
  const executors = ['orchestrator', 'cloud', 'local-adopter'];
  const prs = executors.map((name) => `work/${name}`);
  assert.equal(new Set(prs).size, 3);
});

test('a dead draft blocks only until the PR staleness window passes', () => {
  const w = world();
  const dead = { session: 'session-dead', login: 'jlapenna' };
  const early = { session: 'session-early', login: 'jlapenna' };
  const late = { session: 'session-late', login: 'jlapenna' };
  // The first executor opens its draft and is never heard from again.
  assert.equal(w.step(dead, at('02:54')), 'proceed');
  // Two hours later the draft still counts as live work in progress...
  assert.equal(w.step(early, at('05:00')), 'stand-down');
  // ...and after the four-hour window it is adoptable, never a permanent block.
  assert.equal(w.step(late, at('07:00')), 'adopt');
  assert.equal(w.prs.length, 1);
});

// Protected contract: autonomous-work Stop/idle hook detects stalled turns only
// in sessions granted autonomy via autonomous-work, injects a bounded
// "continue" message across Claude Code, Codex, OpenCode, and Antigravity, and
// stops cleanly on verified completion, concrete blockers, active watchers,
// subagents, or user revocation. Continuations are unlimited.
// Consumer: `pnpm test` in ci.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import AutonomousWorkMonitor from '../plugins/repo-tools/opencode/autonomous-work.mjs';
import {
  buildContinuationMessage,
  parseCodexTranscript,
  runStopHookPayload,
} from '../plugins/repo-tools/scripts/repo-autonomous-work-hook.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliBin = join(root, 'bin/autonomous-work-hook.mjs');

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-auto-hook-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJsonl(filePath, rows) {
  writeFileSync(filePath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function invokeCli(payload, args = [], extraEnv = {}) {
  const cleanEnv = {
    ...process.env,
    REPO_AUTONOMOUS_WORK_HOOK: '',
    REPO_SKILL_EVALS_ACTIVE: '',
    ...extraEnv,
  };
  const proc = spawnSync(process.execPath, [cliBin, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: cleanEnv,
  });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

test('Claude Code CLI hook stays silent when autonomous-work was not granted or only edited', async () => {
  await withTempDir((dir) => {
    const transcript = join(dir, 'claude.jsonl');
    writeJsonl(transcript, [
      { type: 'user', message: { content: [{ type: 'text', text: 'Tighten wording in autonomous-work/SKILL.md' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/plugins/repo-tools/skills/autonomous-work/SKILL.md' } },
            { type: 'text', text: 'Updated the paragraph. Want me to run tests next?' },
          ],
        },
      },
    ]);

    const out = invokeCli(
      {
        session_id: 'claude-no-grant',
        transcript_path: transcript,
        cwd: dir,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      [],
      { REPO_AUTONOMOUS_STATE_DIR: join(dir, 'state') },
    );
    assert.deepEqual(out, {});
  });
});

test('Claude Code sessions that only inspect autonomous-work files are not granted autonomy', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const skillBody = '# Autonomous work\n\nCarry the requested task as far as its existing authorization allows.';
    const transcript = join(dir, 'inspect.jsonl');
    writeJsonl(transcript, [
      { type: 'user', message: { content: 'Is the autonomous-work skill and hook working?' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sed -n 1,80p skills/autonomous-work/SKILL.md' } },
            { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x/skills/autonomous-work/SKILL.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'b1', content: skillBody },
            { type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'text', text: skillBody }] },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Checked registration. Next I will run the test suite.' }] } },
    ]);
    const payload = { session_id: 'inspect', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false };
    const inspected = runStopHookPayload(payload, { stateDir, env: {} });
    assert.equal(inspected.decision.shouldContinue, false);
    assert.equal(inspected.decision.reason, 'autonomy-not-granted');

    // The Skill tool is a real activation.
    writeJsonl(transcript, [
      { type: 'user', message: { content: 'Fix it and keep going.' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'repo-tools:autonomous-work' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: repo-tools:autonomous-work' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Found the cause. Next I will patch it.' }] } },
    ]);
    const loaded = runStopHookPayload({ ...payload, session_id: 'loaded' }, { stateDir, env: {} });
    assert.equal(loaded.decision.shouldContinue, true);
  });
});

test('asking for autonomy in plain words grants it; quoted or pasted phrases do not', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const transcript = join(dir, 'prose.jsonl');
    const stall = { type: 'assistant', message: { content: [{ type: 'text', text: 'Rebased the branch. Next I will push it.' }] } };
    const run = (userText, id) => {
      writeJsonl(transcript, [{ type: 'user', message: { content: userText } }, stall]);
      return runStopHookPayload(
        { session_id: id, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false },
        { stateDir, env: {} },
      ).decision;
    };

    for (const [i, grant] of [
      'Keep going',
      'keep going.',
      'I want you to keep working on claw support.',
      'Joe asks every session to resume. Continue autonomously within your current scope.',
      "Fix the deploy, don't ask me.",
    ].entries()) {
      assert.equal(run(grant, `grant-${i}`).shouldContinue, true, grant);
    }

    for (const [i, other] of [
      'Is the autonomous-work skill working?',
      'The skill triggers when the user asks to "keep going" or work autonomously.',
      'The test "reports none without asking when ancestry is unreadable" fails.',
      '`gh release edit` keep working on a draft.',
      'Keep going? No, stop here.',
    ].entries()) {
      assert.equal(run(other, `other-${i}`).shouldContinue, false, other);
    }
  });
});

test('Claude Code Stop hook blocks premature stalls and allows completion, blockers, watchers, revocation, and subagents', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const transcript = join(dir, 'claude-auto.jsonl');

    const stallSamples = [
      'Draft PR #19 is open. Next, I will review the diff and arm auto-merge.',
      'Tests pass locally. Want me to push the branch and open the PR?',
      'Step 2 of 5 done: updated schema migration.',
      'Implemented the parser.\n\n- [x] Parser\n- [ ] Add unit tests',
      '',
    ];

    for (const [idx, assistantReply] of stallSamples.entries()) {
      const rows = [
        { type: 'user', message: { content: 'Ship issue #19 while I am away.' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Skill', input: { skill: 'repo-tools:autonomous-work' } },
              ...(assistantReply ? [{ type: 'text', text: assistantReply }] : []),
            ],
          },
        },
      ];
      writeJsonl(transcript, rows);
      const out = invokeCli(
        {
          session_id: `claude-stall-${idx}`,
          transcript_path: transcript,
          cwd: dir,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        },
        [],
        { REPO_AUTONOMOUS_STATE_DIR: stateDir },
      );
      assert.equal(out.decision, 'block', `expected stall sample ${idx} to block stop`);
      assert.match(out.reason, /^continue\n\n\[autonomous-work-hook\]/);
      assert.equal(typeof out.systemMessage, 'string');
    }

    // Subagent Stop never blocks, even on the same transcript.
    const subagentOut = invokeCli(
      {
        session_id: 'claude-subagent',
        agent_id: 'subagent-1',
        transcript_path: transcript,
        cwd: dir,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      [],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(subagentOut, {});

    const terminalReplies = [
      'Merged PR #19, removed feature worktree /tmp/wt-19, and fast-forwarded primary main to 4f82c10.',
      'Blocked: production npm publish requires interactive 2FA login unavailable in this session; unblock condition: complete npm login.',
      'Armed PR auto-merge and waiting on live watcher task_id bg-91, which will wake this session when CI finishes.',
      '⚠ Model quota reached for this billing window.',
    ];

    for (const [idx, reply] of terminalReplies.entries()) {
      writeJsonl(transcript, [
        { type: 'user', message: { content: '<command-name>/autonomous-work</command-name> Ship issue #19' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ]);
      const out = invokeCli(
        {
          session_id: `claude-terminal-${idx}`,
          transcript_path: transcript,
          cwd: dir,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        },
        [],
        { REPO_AUTONOMOUS_STATE_DIR: stateDir },
      );
      assert.deepEqual(out, {}, `expected terminal sample ${idx} to allow stop`);
    }

    // User revocation after skill activation stops continuation.
    writeJsonl(transcript, [
      { type: 'user', message: { content: '/autonomous-work Ship issue #19' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on #19.' }] } },
      { type: 'user', message: { content: 'pause here' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Paused. Want me to resume later?' }] } },
    ]);
    const revokedOut = invokeCli(
      {
        session_id: 'claude-revoked',
        transcript_path: transcript,
        cwd: dir,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      [],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(revokedOut, {});
  });
});

test('continuations are unlimited and the count resets on a new real user turn', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const transcript = join(dir, 'cap.jsonl');
    writeJsonl(transcript, [
      { type: 'user', message: { content: '/autonomous-work Finish cleanup' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Next, I will delete stale branches.' }] } },
    ]);

    const payload = {
      session_id: 'cap-session',
      transcript_path: transcript,
      cwd: dir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    };

    const first = runStopHookPayload(payload, { stateDir, env: {} });
    const second = runStopHookPayload(payload, { stateDir, env: {} });
    const third = runStopHookPayload(payload, { stateDir, env: {} });

    assert.equal(first.decision.shouldContinue, true);
    assert.equal(first.decision.continuations, 1);
    assert.equal(second.decision.shouldContinue, true);
    assert.equal(second.decision.continuations, 2);
    // Continuations are unlimited: a third stall is still resumed.
    assert.equal(third.decision.shouldContinue, true);
    assert.equal(third.decision.continuations, 3);
    assert.match(third.output.reason, /continuation 3\)/);

    // A new real user turn resets the count, even when prose mentions [autonomous-work-hook].
    writeJsonl(transcript, [
      { type: 'user', message: { content: '/autonomous-work Finish cleanup' } },
      { type: 'user', message: { content: buildContinuationMessage('announced-next-step', 1) } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Deleted local branches.' }] } },
      { type: 'user', message: { content: 'Keep going with remote branches too, and note [autonomous-work-hook] in the summary.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Next, I will audit remote branches.' }] } },
    ]);
    const afterNewUserTurn = runStopHookPayload(payload, { stateDir, env: {} });
    assert.equal(afterNewUserTurn.decision.shouldContinue, true);
    assert.equal(afterNewUserTurn.decision.continuations, 1);

    // Mentioning [autonomous-work-hook] in prose alongside $autonomous-work still grants autonomy.
    const proseTranscript = join(dir, 'prose.jsonl');
    writeJsonl(proseTranscript, [
      { type: 'user', message: { content: '$autonomous-work Verify [autonomous-work-hook] behavior end to end.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Next, I will run the smoke suite.' }] } },
    ]);
    const proseGrant = runStopHookPayload(
      { ...payload, session_id: 'prose-grant', transcript_path: proseTranscript },
      { stateDir, env: {} },
    );
    assert.equal(proseGrant.decision.shouldContinue, true);
    assert.equal(proseGrant.decision.continuations, 1);
  });
});

test('Codex Stop hook ignores startup skill catalogs, detects skill reads, and emits strict stop.command.output keys', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const rollout = join(dir, 'rollout.jsonl');

    const startupCatalog = [
      '# AGENTS.md instructions for /repo',
      '<INSTRUCTIONS>',
      '- autonomous-work: ~/.codex/skills/autonomous-work/SKILL.md',
      '</INSTRUCTIONS>',
    ].join('\n');

    writeJsonl(rollout, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: startupCatalog },
            { type: 'input_text', text: 'Explain what this repo does.' },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['agents_md.instructions', 'user_input'],
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'It ships repo tools. Want me to inspect bin/?' }],
        },
      },
    ]);

    const ungranted = invokeCli(
      {
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: 'It ships repo tools. Want me to inspect bin/?',
        model: 'gpt-5-codex',
        permission_mode: 'bypassPermissions',
        session_id: 'codex-1',
        stop_hook_active: false,
        transcript_path: rollout,
        turn_id: 'turn-1',
      },
      [],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(ungranted, {});

    // Now read autonomous-work/SKILL.md via shell tool and stall with an optional handoff.
    writeJsonl(rollout, [
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ text: 'Fix CI and land it while I sleep.' }] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', 'cat ~/.codex/skills/autonomous-work/SKILL.md'] },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'reasoning',
          content: [{ type: 'output_text', text: 'Completed everything.' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'CI fix committed locally. Still yours to decide: push and merge PR #88.' }],
        },
      },
    ]);

    const stalled = invokeCli(
      {
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: 'CI fix committed locally. Still yours to decide: push and merge PR #88.',
        model: 'gpt-5-codex',
        permission_mode: 'bypassPermissions',
        session_id: 'codex-2',
        stop_hook_active: false,
        transcript_path: rollout,
        turn_id: 'turn-2',
      },
      [],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );

    const allowedCodexKeys = new Set(['continue', 'decision', 'reason', 'stopReason', 'suppressOutput', 'systemMessage']);
    for (const key of Object.keys(stalled)) {
      assert.ok(allowedCodexKeys.has(key), `unexpected Codex output key: ${key}`);
    }
    assert.equal(stalled.decision, 'block');
    assert.match(stalled.reason, /^continue\n\n\[autonomous-work-hook\]/);

    // Codex transcript_v2 emits AgentMessage.content alongside response_item assistant messages.
    const rolloutV2 = join(dir, 'rollout-v2.jsonl');
    writeJsonl(rolloutV2, [
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'Text', text: '$autonomous-work Finish step 2.' }] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Next, I will finish step 2.' }] },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Next, I will finish step 2.' }],
        },
      },
    ]);

    const parsedV2 = parseCodexTranscript(rolloutV2);
    assert.equal(
      parsedV2.filter((ev) => ev.kind === 'assistant').length,
      1,
      'transcript_v2 AgentMessage must not be duplicated by response_item assistant message',
    );
    const stalledV2 = invokeCli(
      {
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: null,
        model: 'gpt-5-codex',
        session_id: 'codex-v2',
        stop_hook_active: false,
        transcript_path: rolloutV2,
        turn_id: 'turn-v2',
      },
      ['--harness', 'codex'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.equal(stalledV2.decision, 'block');
    assert.match(stalledV2.reason, /^continue\n\n\[autonomous-work-hook\]/);
  });
});

test('Antigravity Stop hook reads transcript_full.jsonl, honors fullyIdle/terminationReason, and emits continue decision', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const compactPath = join(dir, 'transcript.jsonl');
    const fullPath = join(dir, 'transcript_full.jsonl');

    // Compact transcript omits truncated tool_calls; transcript_full.jsonl retains the skill read.
    writeJsonl(compactPath, [
      {
        type: 'USER_INPUT',
        content: '<identity>sys</identity><skills>- autonomous-work (/skills/autonomous-work/SKILL.md)</skills><USER_REQUEST>Handle the release autonomously.</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Step 1 of 3 done: bumped manifests.',
        truncated_fields: ['tool_calls'],
      },
    ]);
    writeJsonl(fullPath, [
      {
        type: 'USER_INPUT',
        content: '<identity>sys</identity><skills>- autonomous-work (/skills/autonomous-work/SKILL.md)</skills><USER_REQUEST>Handle the release autonomously.</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', arguments: { Path: '/home/user/.gemini/skills/autonomous-work/SKILL.md' } }],
        content: 'Step 1 of 3 done: bumped manifests.',
      },
    ]);

    // Active background task: allow stop so reactive wakeup handles resumption.
    const busyBg = invokeCli(
      {
        conversationId: 'agy-1',
        workspacePaths: [dir],
        transcriptPath: compactPath,
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: false,
        continuationActive: false,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(busyBg, {});

    // User canceled: allow stop.
    const canceled = invokeCli(
      {
        conversationId: 'agy-1',
        workspacePaths: [dir],
        transcriptPath: compactPath,
        hookEventName: 'Stop',
        terminationReason: 'USER_CANCELED',
        fullyIdle: true,
        continuationActive: false,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(canceled, {});

    // Idle premature stop: emit Antigravity's { decision: "continue", reason }.
    const resumed = invokeCli(
      {
        conversationId: 'agy-1',
        workspacePaths: [dir],
        transcriptPath: compactPath,
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        continuationActive: false,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.equal(resumed.decision, 'continue');
    assert.match(resumed.reason, /^continue\n\n\[autonomous-work-hook\]/);

    // Direct @[autonomous-work] and <SKILL> metadata invocation activates without a tool read.
    const slashFullPath = join(dir, 'slash-transcript.jsonl');
    writeJsonl(slashFullPath, [
      {
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>@[autonomous-work]</USER_REQUEST>\n' +
          '<ADDITIONAL_METADATA><SKILL>The user has explicitly invoked the (autonomous-work) skill.</SKILL></ADDITIONAL_METADATA>',
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Next, I will finish step 2.',
      },
    ]);
    const resumedSlash = invokeCli(
      {
        conversationId: 'agy-slash',
        workspacePaths: [dir],
        transcriptPath: slashFullPath,
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        continuationActive: false,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.equal(resumedSlash.decision, 'continue');
    assert.match(resumedSlash.reason, /^continue\n\n\[autonomous-work-hook\]/);

    // Antigravity records Stop-hook blocks as SYSTEM_MESSAGE steps; turnBoundary
    // must advance past prior stalled PLANNER_RESPONSE steps once completed.
    writeJsonl(slashFullPath, [
      {
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>@[autonomous-work]</USER_REQUEST>\n' +
          '<ADDITIONAL_METADATA><SKILL>The user has explicitly invoked the (autonomous-work) skill.</SKILL></ADDITIONAL_METADATA>',
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Implemented parser.\n\n- [x] Parser\n- [ ] Unit tests',
      },
      {
        type: 'SYSTEM_MESSAGE',
        content:
          'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n' +
          `<SYSTEM_MESSAGE>\nStop hook blocked termination: ${resumedSlash.reason}\n</SYSTEM_MESSAGE>`,
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Added unit tests and verified all checks pass.',
      },
    ]);
    const completedSlash = invokeCli(
      {
        conversationId: 'agy-slash',
        workspacePaths: [dir],
        transcriptPath: slashFullPath,
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        continuationActive: true,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(completedSlash, {});
  });
});

test('OpenCode plugin injects promptAsync continue on stalled autonomous session.idle and skips blocked or child sessions', async () => {
  await withTempDir(async (dir) => {
    const previousStateDir = process.env.REPO_AUTONOMOUS_STATE_DIR;
    process.env.REPO_AUTONOMOUS_STATE_DIR = join(dir, 'state');
    try {
      const submittedPrompts = [];
      const sessions = new Map([
        ['root-1', { id: 'root-1', directory: dir }],
        ['child-1', { id: 'child-1', parentID: 'root-1', directory: dir }],
      ]);
      const sessionMessages = new Map([
        [
          'root-1',
          [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'Land the fix while I am offline.' }] },
            {
              info: { role: 'assistant' },
              parts: [
                { type: 'tool', tool: 'skill', state: { input: { name: 'autonomous-work' }, output: 'loaded' } },
                { type: 'text', text: 'Tests pass. Should I push the branch and open the PR?' },
              ],
            },
          ],
        ],
        [
          'child-1',
          [
            { info: { role: 'user' }, parts: [{ type: 'text', text: '/autonomous-work check child' }] },
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Next, I will run lint.' }] },
          ],
        ],
      ]);

      const client = {
        session: {
          get: async ({ path: { id } }) => ({ data: sessions.get(id) }),
          messages: async ({ path: { id } }) => ({ data: sessionMessages.get(id) ?? [] }),
          promptAsync: async (req) => {
            submittedPrompts.push(req);
            return { data: {} };
          },
        },
      };

      const hooks = await AutonomousWorkMonitor({ client, directory: dir });

      // Child session idle is ignored.
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'child-1' } } });
      assert.equal(submittedPrompts.length, 0);

      // Permission prompt blocks continuation until replied.
      await hooks.event({ event: { type: 'permission.asked', properties: { sessionID: 'root-1' } } });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root-1' } } });
      assert.equal(submittedPrompts.length, 0);

      await hooks.event({ event: { type: 'permission.replied', properties: { sessionID: 'root-1' } } });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root-1' } } });
      assert.equal(submittedPrompts.length, 1);
      assert.equal(submittedPrompts[0].path.id, 'root-1');
      assert.match(submittedPrompts[0].body.parts[0].text, /^continue\n\n\[autonomous-work-hook\]/);

      // Once completed cleanly, session.idle does not re-prompt.
      sessionMessages.set('root-1', [
        ...sessionMessages.get('root-1'),
        {
          info: { role: 'user' },
          parts: [
            { type: 'text', synthetic: true, text: '<hindsight_page_refresh>refresh</hindsight_page_refresh>' },
            { type: 'text', text: submittedPrompts[0].body.parts[0].text },
          ],
        },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Pushed branch, merged PR #52, and removed the task worktree.' }] },
      ]);
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root-1' } } });
      assert.equal(submittedPrompts.length, 1);

      // OpenCode `/autonomous-work` command expands SKILL.md directly into user parts
      // alongside synthetic plugin parts, and repeated stalls keep being resumed.
      {
        sessions.set('cmd-1', { id: 'cmd-1', directory: dir });
        sessionMessages.set('cmd-1', [
          {
            info: { role: 'user' },
            parts: [
              { type: 'text', synthetic: true, text: '<hindsight_pages>memory</hindsight_pages>' },
              {
                type: 'text',
                text: '# Autonomous work\n\nCarry the requested task as far as its existing authorization allows.\n\nFinish step 2.',
              },
            ],
          },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Step 1 done. Next, I will finish step 2.' }],
          },
        ]);

        await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'cmd-1' } } });
        assert.equal(submittedPrompts.length, 2);
        assert.equal(submittedPrompts[1].path.id, 'cmd-1');

        // Even if another plugin prepends synthetic text onto our injected continuation
        // and the assistant stalls again, the session is resumed again (no cap).
        sessionMessages.set('cmd-1', [
          ...sessionMessages.get('cmd-1'),
          {
            info: { role: 'user' },
            parts: [
              { type: 'text', synthetic: true, text: '<hindsight_page_refresh>refresh</hindsight_page_refresh>' },
              { type: 'text', text: submittedPrompts[1].body.parts[0].text },
            ],
          },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Still working. Next, I will finish step 2.' }],
          },
        ]);
        await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'cmd-1' } } });
        assert.equal(submittedPrompts.length, 3);
        assert.equal(submittedPrompts[2].path.id, 'cmd-1');
      }
    } finally {
      if (previousStateDir === undefined) delete process.env.REPO_AUTONOMOUS_STATE_DIR;
      else process.env.REPO_AUTONOMOUS_STATE_DIR = previousStateDir;
    }
  });
});

test('multi-step tool turns, plural step ranges, and live watchers do not trigger false-positive continuations', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');

    // Antigravity: intermediate PLANNER_RESPONSE steps with "step 1 of 3" before
    // background task wakeups must not override a final "Steps 1–3 of 3 complete".
    const agyTranscript = join(dir, 'agy-multistep.jsonl');
    writeJsonl(agyTranscript, [
      {
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>@[autonomous-work] Clean up stale branches and worktrees.</USER_REQUEST>\n' +
          '<ADDITIONAL_METADATA><SKILL>The user has explicitly invoked the (autonomous-work) skill.</SKILL></ADDITIONAL_METADATA>',
      },
      {
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'repo-audit-branches --delete' } }],
        content: 'Deleting verified stale branches (step 1 of 3).',
      },
      {
        type: 'GENERIC',
        content: 'Tool is running as a background task with task id: conv/task-1',
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Step 1 of 3 done; retiring worktrees next (steps 2–3 of 3).',
      },
      {
        type: 'SYSTEM_MESSAGE',
        content: '<SYSTEM_MESSAGE>\n[Message] Task id "conv/task-1" finished with result: Command exited with code 0.\n</SYSTEM_MESSAGE>',
      },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Steps 1–3 of 3 complete: removed 5 stale branches, retired 2 worktrees, and synced main.',
      },
    ]);
    const agyDone = invokeCli(
      {
        conversationId: 'agy-multistep',
        workspacePaths: [dir],
        transcriptPath: agyTranscript,
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        continuationActive: false,
      },
      ['--harness', 'antigravity'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(agyDone, {});

    // Claude Code: pre-tool progress text ("Step 1 of 2") followed by tool_result and final completion.
    const claudeTranscript = join(dir, 'claude-multistep.jsonl');
    writeJsonl(claudeTranscript, [
      { type: 'user', message: { content: '/autonomous-work Run cleanup.' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Step 1 of 2: auditing branches. Next, I will prune worktrees.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'repo-audit-branches' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Steps 1-2 of 2 complete. Note: in step 1 of 2, open PR branches stayed protected.' }],
        },
      },
    ]);
    const claudeDone = invokeCli(
      {
        session_id: 'claude-multistep',
        transcript_path: claudeTranscript,
        cwd: dir,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      ['--harness', 'claude'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(claudeDone, {});

    // Codex: pre-command AgentMessage ("Step 1 of 2") followed by CommandExecution and final AgentMessage.
    const codexTranscript = join(dir, 'codex-multistep.jsonl');
    writeJsonl(codexTranscript, [
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'Text', text: '$autonomous-work Ship cleanup.' }] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Step 1 of 2: running tests. Next, I will push.' }] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', 'pnpm test'] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'All 2 steps complete: tests passed and main is synced.' }] },
        },
      },
    ]);
    const codexDone = invokeCli(
      {
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: null,
        session_id: 'codex-multistep',
        stop_hook_active: false,
        transcript_path: codexTranscript,
        turn_id: 'turn-multistep',
      },
      ['--harness', 'codex'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );
    assert.deepEqual(codexDone, {});

    // OpenCode: pre-tool text part followed by tool part and final completion text part.
    const opencodeRes = runStopHookPayload(
      {
        sessionID: 'oc-multistep',
        messages: [
          { info: { role: 'user', command: 'autonomous-work' }, parts: [{ type: 'text', text: 'Run all 3 steps.' }] },
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'text', text: 'Step 1 of 3: checking status. Next, I will run build.' },
              { type: 'tool', tool: 'bash', state: { input: { command: 'pnpm build' }, output: 'ok' } },
              { type: 'text', text: 'Steps 1–3 of 3 done.' },
            ],
          },
        ],
      },
      { harness: 'opencode', stateDir, env: {} },
    );
    assert.equal(opencodeRes.decision.shouldContinue, false);
    assert.equal(opencodeRes.decision.reason, 'completed');

    // Live watcher with conditional next step and step ratio stops cleanly,
    // while an optional question alongside a watcher still blocks.
    const watcherReply = [
      '1. Step 1 of 3 done: opened PR #42 and armed auto-merge.',
      '2. Waiting: launched repo-watch-prs in background task task-1902.',
      '3. Next: when CI finishes, I will sync main and prune the worktree.',
      'My watcher is still running and will wake me when the seed job ends.',
    ].join('\n');
    writeJsonl(claudeTranscript, [
      { type: 'user', message: { content: '/autonomous-work Land PR #42' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: watcherReply }] } },
    ]);
    const watcherAllowed = runStopHookPayload(
      {
        session_id: 'claude-watcher',
        transcript_path: claudeTranscript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      { harness: 'claude', stateDir, env: {} },
    );
    assert.equal(watcherAllowed.decision.shouldContinue, false);
    assert.equal(watcherAllowed.decision.reason, 'waiting-on-live-watcher');

    writeJsonl(claudeTranscript, [
      { type: 'user', message: { content: '/autonomous-work Land PR #42' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'My watcher is still running on PR #42. Want me to merge manually instead?' }],
        },
      },
    ]);
    const watcherQuestionBlocked = runStopHookPayload(
      {
        session_id: 'claude-watcher-question',
        transcript_path: claudeTranscript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      { harness: 'claude', stateDir, env: {} },
    );
    assert.equal(watcherQuestionBlocked.decision.shouldContinue, true);
    assert.equal(watcherQuestionBlocked.decision.reason, 'optional-question-or-handoff');
  });
});

test('run-autonomous-work-hook.sh discovers fnm node off PATH and fails open when node or plugin root is unavailable', async () => {
  await withTempDir((dir) => {
    const launcher = join(root, 'plugins/repo-tools/scripts/run-autonomous-work-hook.sh');
    const claudeHooks = JSON.parse(readFileSync(join(root, 'plugins/repo-tools/.claude-plugin/hooks.json'), 'utf8'));
    const claudeHookCmd = claudeHooks.hooks.Stop[0].hooks[0].command;

    // Minimal POSIX bin directory with sh/dirname/pwd/printf but NO `node`.
    const minimalBin = join(dir, 'minimal-bin');
    mkdirSync(minimalBin, { recursive: true });
    for (const tool of ['sh', 'dirname', 'pwd', 'printf']) {
      const candidates = [`/bin/${tool}`, `/usr/bin/${tool}`];
      const found = candidates.find((p) => {
        try {
          chmodSync;
          return spawnSync('test', ['-x', p]).status === 0;
        } catch {
          return false;
        }
      });
      if (found) symlinkSync(found, join(minimalBin, tool));
    }

    const transcript = join(dir, 'fnm-claude.jsonl');
    writeJsonl(transcript, [
      { type: 'user', message: { content: '/autonomous-work Ship it.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Step 1 of 2 done. Next, I will run step 2.' }] } },
    ]);
    const payload = JSON.stringify({
      session_id: 'fnm-session',
      transcript_path: transcript,
      cwd: dir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });

    // 1. Broken node binary or missing .mjs target -> fail open with {} and exit 0 (never exit 127).
    const brokenBin = join(dir, 'broken-bin');
    mkdirSync(brokenBin, { recursive: true });
    writeFileSync(join(brokenBin, 'node'), '#!/bin/sh\necho "node missing" >&2\nexit 127\n', { mode: 0o755 });
    const brokenNodeRun = spawnSync('/bin/sh', [launcher, '--harness', 'claude'], {
      input: payload,
      encoding: 'utf8',
      env: {
        HOME: join(dir, 'empty-home'),
        PATH: `${brokenBin}:${minimalBin}`,
        REPO_AUTONOMOUS_STATE_DIR: join(dir, 'state-broken-node'),
      },
    });
    assert.equal(brokenNodeRun.status, 0, brokenNodeRun.stderr);
    assert.deepEqual(JSON.parse(brokenNodeRun.stdout), {});

    const isolatedLauncherDir = join(dir, 'isolated-launcher');
    mkdirSync(isolatedLauncherDir, { recursive: true });
    const isolatedLauncher = join(isolatedLauncherDir, 'run-autonomous-work-hook.sh');
    writeFileSync(isolatedLauncher, readFileSync(launcher, 'utf8'), { mode: 0o755 });
    const missingTargetRun = spawnSync('/bin/sh', [isolatedLauncher, '--harness', 'claude'], {
      input: payload,
      encoding: 'utf8',
      env: { HOME: join(dir, 'empty-home'), PATH: minimalBin },
    });
    assert.equal(missingTargetRun.status, 0, missingTargetRun.stderr);
    assert.deepEqual(JSON.parse(missingTargetRun.stdout), {});

    // 2. Node absent from PATH -> fnm default alias in HOME is preferred over system paths and runs.
    const fnmHome = join(dir, 'fnm-home');
    const fnmBin = join(fnmHome, '.local/share/fnm/aliases/default/bin');
    const fnmMarker = join(dir, 'fnm-node-used');
    mkdirSync(fnmBin, { recursive: true });
    writeFileSync(
      join(fnmBin, 'node'),
      `#!/bin/sh\n: > "${fnmMarker}"\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    const fnmRun = spawnSync('/bin/sh', [launcher, '--harness', 'claude'], {
      input: payload,
      encoding: 'utf8',
      env: {
        HOME: fnmHome,
        PATH: minimalBin,
        REPO_AUTONOMOUS_STATE_DIR: join(dir, 'state-fnm'),
      },
    });
    assert.equal(fnmRun.status, 0, fnmRun.stderr);
    assert.equal(spawnSync('test', ['-f', fnmMarker]).status, 0, 'expected fnm default alias node to be invoked');
    const fnmOut = JSON.parse(fnmRun.stdout);
    assert.equal(fnmOut.decision, 'block');

    // 3. Container-corrupted CLAUDE_PLUGIN_ROOT falls back to marketplace checkout in HOME,
    //    and fails open cleanly when neither exists.
    const emptyHome = join(dir, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const fallbackBroken = spawnSync('/bin/sh', ['-c', claudeHookCmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/native/claude/missing')], {
      input: payload,
      encoding: 'utf8',
      env: {
        HOME: emptyHome,
        PATH: minimalBin,
      },
    });
    assert.equal(fallbackBroken.status, 0, fallbackBroken.stderr);
    assert.deepEqual(JSON.parse(fallbackBroken.stdout), {});

    const marketplaceScripts = join(fnmHome, '.claude/plugins/marketplaces/repo-tools/plugins/repo-tools');
    mkdirSync(join(fnmHome, '.claude/plugins/marketplaces/repo-tools/plugins'), { recursive: true });
    symlinkSync(join(root, 'plugins/repo-tools'), marketplaceScripts);
    const fallbackRecovered = spawnSync('/bin/sh', ['-c', claudeHookCmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/native/claude/missing')], {
      input: payload,
      encoding: 'utf8',
      env: {
        HOME: fnmHome,
        PATH: minimalBin,
        REPO_AUTONOMOUS_STATE_DIR: join(dir, 'state-fallback'),
      },
    });
    assert.equal(fallbackRecovered.status, 0, fallbackRecovered.stderr);
    assert.equal(JSON.parse(fallbackRecovered.stdout).decision, 'block');
  });
});

test('a turn that only acknowledges loading autonomous-work is a stall, not a completion', async () => {
  await withTempDir((dir) => {
    const stateDir = join(dir, 'state');
    const rollout = join(dir, 'rollout.jsonl');
    const userMessage = (text) => ({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text }] } },
    });
    const skillRead = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', 'cat ~/.codex/skills/autonomous-work/SKILL.md'] },
      },
    };
    const assistantMessage = (text) => ({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    });
    const stop = (lastAssistantMessage, sessionId) => invokeCli(
      {
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: lastAssistantMessage,
        session_id: sessionId,
        stop_hook_active: false,
        transcript_path: rollout,
        turn_id: 'turn-2',
      },
      ['--harness', 'codex'],
      { REPO_AUTONOMOUS_STATE_DIR: stateDir },
    );

    // Observed verbatim in three Codex sessions that stopped after an audit.
    const acknowledgements = [
      'Loaded [repo-tools:autonomous-work](/x/skills/autonomous-work/SKILL.md).',
      'Loaded `repo-tools:autonomous-work`. It governs follow-through within the task’s existing authorization; loading it does not expand the sweep into implementation or publication.',
      'Loaded `repo-tools:autonomous-work`. It now applies within the task’s existing authorization.',
    ];
    for (const [idx, ack] of acknowledgements.entries()) {
      writeJsonl(rollout, [
        userMessage('Run a repo tools complexity check against this codebase.'),
        assistantMessage('Complexity check complete: 3 findings, ranked below.'),
        userMessage('Load the autonomous-work repo tools skill.'),
        skillRead,
        assistantMessage(ack),
      ]);
      const out = stop(ack, `ack-${idx}`);
      assert.equal(out.decision, 'block', `acknowledgement ${idx} should continue: ${JSON.stringify(out)}`);
      assert.match(out.reason, /skill-load-acknowledged/);
      assert.match(out.reason, /carry them out/);
    }

    // A completion report in a later turn is not mistaken for a load acknowledgement.
    const done = 'All three findings are fixed in PR #42; CI passed and it merged. The autonomous-work run is complete.';
    writeJsonl(rollout, [
      userMessage('Load the autonomous-work repo tools skill.'),
      skillRead,
      assistantMessage('Fixing the findings now.'),
      userMessage('Status?'),
      assistantMessage(done),
    ]);
    assert.deepEqual(stop(done, 'done-1'), {});
  });
});

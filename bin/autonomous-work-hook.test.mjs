// Protected contract: autonomous-work Stop/idle hook detects stalled turns only
// in sessions granted autonomy via autonomous-work, injects a bounded
// "continue" message across Claude Code, Codex, OpenCode, and Antigravity, and
// stops cleanly on verified completion, concrete blockers, active watchers,
// subagents, user revocation, or the per-turn continuation cap.
// Consumer: `pnpm test` in ci.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    REPO_AUTONOMOUS_MAX_CONTINUATIONS: '',
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

test('per-user-turn continuation cap prevents infinite loops and resets on a new real user turn', async () => {
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

    const first = runStopHookPayload(payload, { stateDir, maxContinuations: 2, env: {} });
    const second = runStopHookPayload(payload, { stateDir, maxContinuations: 2, env: {} });
    const third = runStopHookPayload(payload, { stateDir, maxContinuations: 2, env: {} });

    assert.equal(first.decision.shouldContinue, true);
    assert.equal(first.decision.continuations, 1);
    assert.equal(second.decision.shouldContinue, true);
    assert.equal(second.decision.continuations, 2);
    assert.equal(third.decision.shouldContinue, false);
    assert.equal(third.decision.reason, 'max-continuations-reached');

    // A new real user turn resets the budget, even when prose mentions [autonomous-work-hook].
    writeJsonl(transcript, [
      { type: 'user', message: { content: '/autonomous-work Finish cleanup' } },
      { type: 'user', message: { content: buildContinuationMessage('announced-next-step', 1, 2) } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Deleted local branches.' }] } },
      { type: 'user', message: { content: 'Keep going with remote branches too, and note [autonomous-work-hook] in the summary.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Next, I will audit remote branches.' }] } },
    ]);
    const afterNewUserTurn = runStopHookPayload(payload, { stateDir, maxContinuations: 2, env: {} });
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
      { stateDir, maxContinuations: 2, env: {} },
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
      // alongside synthetic plugin parts, and continuation caps still hold.
      const prevMax = process.env.REPO_AUTONOMOUS_MAX_CONTINUATIONS;
      process.env.REPO_AUTONOMOUS_MAX_CONTINUATIONS = '1';
      try {
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
        // and the assistant stalls again, maxContinuations=1 prevents a second prompt.
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
        assert.equal(submittedPrompts.length, 2);
      } finally {
        if (prevMax === undefined) delete process.env.REPO_AUTONOMOUS_MAX_CONTINUATIONS;
        else process.env.REPO_AUTONOMOUS_MAX_CONTINUATIONS = prevMax;
      }
    } finally {
      if (previousStateDir === undefined) delete process.env.REPO_AUTONOMOUS_STATE_DIR;
      else process.env.REPO_AUTONOMOUS_STATE_DIR = previousStateDir;
    }
  });
});

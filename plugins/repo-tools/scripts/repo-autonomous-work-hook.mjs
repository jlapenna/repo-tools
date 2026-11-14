#!/usr/bin/env node
// Lifecycle Stop / idle hook for sessions granted autonomy via the
// autonomous-work skill. Supports Claude Code, Codex, OpenCode, and
// Antigravity from one shared, dependency-free ESM implementation.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_MARKER = '[autonomous-work-hook]';
export const DEFAULT_MAX_CONTINUATIONS = 3;

const SKILL_PATH_RE = /(?:^|[\s"'`(=:/\\])autonomous-work[\\/]SKILL\.md(?=$|[\s"'`):])/i;
const SKILL_WRITE_TOOL_RE = /^(?:write|edit|multiedit|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|apply_patch|notebookedit|notebook_edit)$/i;
const SKILL_WRITE_CMD_RE = /\b(?:git\s+(?:add|diff|checkout|rm|mv)|rm|mv|cp|tee|sed\s+-i|perl\s+-[a-z]*i)\b/i;
const SLASH_OR_DOLLAR_SKILL_RE = /(?:<command-name>\s*\/(?:repo-tools:)?autonomous-work\s*<\/command-name>|(?:^|\s)[/$](?:repo-tools:)?autonomous-work(?=$|\s|[.,:;!?)]))/i;
const CODEX_SKILL_BLOCK_RE = /<skill>\s*<name>(?:repo-tools:)?autonomous-work<\/name>/i;
const SKILL_BODY_SIGNATURE_RE = /^#\s+Autonomous work\b[\s\S]{0,400}\bCarry the requested task as far as its existing authorization allows\./m;

const USER_STOP_DIRECTIVE_RE = new RegExp(
  [
    String.raw`^\s*\/?(?:stop|pause|cancel|abort|quit|exit|wait|hold\s+on)[.!]?\s*$`,
    String.raw`\b(?:stop|pause|cancel)\s+(?:autonomous|working|here|now|execution|the\s+task)\b`,
    String.raw`\b(?:do\s+not|don't)\s+continue(?:\s+autonomously)?\b`,
    String.raw`\bwait\s+for\s+(?:me|my\s+(?:approval|input|confirmation|go-ahead))\b`,
  ].join('|'),
  'i',
);

const PROVIDER_LIMIT_RE = /(?:⚠[^\n]*quota\s+reached|\b(?:quota\s+exceeded|insufficient_quota|usage\s+limit\s+exceeded|rate\s+limit\s+exceeded|out\s+of\s+credits|credit\s+balance\s+is\s+too\s+low|billing\s+hard\s+limit)\b)/i;

const CONCRETE_BLOCKER_RE = new RegExp(
  [
    String.raw`(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:blocked|blocker|blocking\s+issue|status\s*:\s*blocked)\*{0,2}\s*:`,
    String.raw`\bunblock\s+condition\b`,
    String.raw`\bcannot\s+(?:proceed|continue|complete)\s+(?:without|until|because)\b`,
    String.raw`\bblocked\s+(?:on|by|pending)\s+(?:missing|unavailable|required|human|user|maintainer|external|interactive|manual|enforced)\b`,
    String.raw`\bawaiting\s+(?:maintainer|upstream|human|external)\s+(?:review|approval|merge|credentials?|access)\b`,
    String.raw`\brequires?\s+(?:an?\s+)?(?:interactive\s+login|manual\s+approval|enforced\s+approval|unavailable\s+credentials?|user-only\s+credentials?|physical\s+access)\b`,
  ].join('|'),
  'i',
);

const LIVE_WATCHER_RE = /\b(?:live\s+watcher|background\s+(?:watcher|task|job|monitor)|armed\s+watcher|will\s+wake\s+this\s+(?:session|turn)|watching\s+[^\n]{0,80}\b(?:pid|task[_\s-]?id|run[_\s-]?id)\b)/i;

const ANNOUNCED_NEXT_STEP_RE = new RegExp(
  [
    String.raw`(?:^|\n)\s*(?:[-*\d.)]+\s*)?\*{0,2}next(?:\s+(?:step|action|up))?\*{0,2}\s*:\s*(?:i\s+will|i'll|we\s+will|run|check|verify|update|fix|test|commit|push|open|merge|clean|inspect|implement|deploy|retry|address|resolve)\b`,
    String.raw`\b(?:next,?\s+i\s+(?:will|am\s+going\s+to)|next\s+i'll|now\s+i\s+(?:will|am\s+going\s+to)|now\s+i'll|i\s+will\s+now|i'll\s+now|let\s+me\s+now|now\s+let's|proceeding\s+to|moving\s+on\s+to)\s+[a-z]`,
  ].join('|'),
  'i',
);

const OPTIONAL_HANDOFF_RE = new RegExp(
  [
    String.raw`\b(?:want|would\s+you\s+like)\s+me\s+to\b`,
    String.raw`\b(?:should|shall)\s+i\s+(?:proceed|continue|go\s+ahead|run|merge|push|commit|update|fix|implement|clean\s+up|open|create|apply|delete)\b`,
    String.raw`\bdo\s+you\s+want\s+(?:me\s+to|to\s+proceed|to\s+continue)\b`,
    String.raw`\blet\s+me\s+know\s+if\s+you(?:'d\s+like|\s+want|\s+prefer)\b`,
    String.raw`\bready\s+(?:for\s+me\s+)?to\s+(?:proceed|continue|merge|push|ship)\s*\?`,
    String.raw`\b(?:your\s+call|needs\s+your\s+decision|left\s+for\s+you|next\s+action\s+for\s+you|still\s+yours\s+to\s+decide)\b`,
  ].join('|'),
  'i',
);

const UNFINISHED_SECTION_RE = /(?:^|\n)\s*(?:#{1,4}\s*|\*{1,2})(?:in\s+progress|remaining(?:\s+(?:work|steps|items|tasks))?|still\s+to\s+do|pending\s+(?:work|steps|actions)|todo)(?:\*{1,2})?\s*:?\s*\n+\s*(?:[-*\d.)]+\s+)(?!none\b|nothing\b|n\/a\b)/i;
const UNCHECKED_BOX_RE = /(?:^|\n)\s*[-*]\s+\[\s\]\s+\S/;
const STEP_PROGRESS_RE = /\bstep\s+(\d+)\s+of\s+(\d+)\b/gi;

function readJsonlLines(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function isSkillName(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().replace(/^[/$]/, '');
  return trimmed === 'autonomous-work' || trimmed.endsWith(':autonomous-work');
}

function isSkillReadCall(toolName, rawArgs) {
  const tool = String(toolName ?? '').trim();
  if (!tool || SKILL_WRITE_TOOL_RE.test(tool)) return false;

  if (/^(?:skill|use_skill|activate_skill)$/i.test(tool)) {
    if (typeof rawArgs === 'string') return isSkillName(rawArgs);
    if (rawArgs && typeof rawArgs === 'object') {
      return isSkillName(rawArgs.skill ?? rawArgs.name ?? rawArgs.skill_name);
    }
  }

  let candidate = '';
  if (typeof rawArgs === 'string') {
    candidate = rawArgs;
  } else if (rawArgs && typeof rawArgs === 'object') {
    const commandValue = rawArgs.command ?? rawArgs.CommandLine ?? rawArgs.cmd;
    if (Array.isArray(commandValue)) {
      candidate = commandValue.join(' ');
    } else if (typeof commandValue === 'string') {
      candidate = commandValue;
    } else {
      for (const key of ['file_path', 'filePath', 'path', 'Path', 'AbsolutePath', 'target_file']) {
        if (typeof rawArgs[key] === 'string') {
          candidate = rawArgs[key];
          break;
        }
      }
    }
  }

  if (!candidate || !SKILL_PATH_RE.test(candidate)) return false;
  if (/^(?:bash|sh|exec|exec_command|run_command|shell)$/i.test(tool) && SKILL_WRITE_CMD_RE.test(candidate)) {
    return false;
  }
  return true;
}

function classifyUserText(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return null;
  if (text.includes(HOOK_MARKER)) {
    return { kind: 'continuation', text };
  }
  return {
    kind: 'user',
    text,
    activatesSkill: SLASH_OR_DOLLAR_SKILL_RE.test(text) || CODEX_SKILL_BLOCK_RE.test(text),
  };
}

export function parseClaudeTranscript(transcriptPath) {
  const events = [];
  for (const rawLine of readJsonlLines(transcriptPath)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.isSidechain === true || parsed.isCompactSummary === true) continue;

    const content = parsed.message?.content;
    if (parsed.type === 'user') {
      if (parsed.isMeta === true) {
        const metaText = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
            : '';
        if (SKILL_BODY_SIGNATURE_RE.test(metaText)) {
          events.push({ kind: 'skill', name: 'autonomous-work' });
        }
        continue;
      }

      const texts = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
                : '';
            if (SKILL_BODY_SIGNATURE_RE.test(resultText)) {
              events.push({ kind: 'skill', name: 'autonomous-work' });
            }
          }
        }
      }

      const classified = classifyUserText(texts.join('\n'));
      if (classified) {
        if (classified.activatesSkill) events.push({ kind: 'skill', name: 'autonomous-work' });
        events.push({ kind: classified.kind, text: classified.text });
      }
    } else if (parsed.type === 'assistant' && Array.isArray(content)) {
      const texts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text.trim());
        } else if (block.type === 'tool_use' && isSkillReadCall(block.name, block.input)) {
          events.push({ kind: 'skill', name: 'autonomous-work' });
        }
      }
      if (texts.length > 0) {
        events.push({ kind: 'assistant', text: texts.join('\n') });
      }
    }
  }
  return events;
}

const CODEX_STARTUP_KINDS = new Set([
  'agents_md.instructions',
  'environments.instructions',
  'environments.environment_context',
  'plugins.recommendations',
  'plugins.usage_instructions',
]);

function isCodexStartupText(text) {
  const s = text.trim();
  if (/^#\s*AGENTS\.md instructions(?: for [^\n]*)?\n/.test(s)) {
    return s.includes('<INSTRUCTIONS>') && s.includes('</INSTRUCTIONS>');
  }
  return /^<(?:recommended_plugins|environment_context)>[\s\S]*<\/(?:recommended_plugins|environment_context)>$/.test(s);
}

function extractCodexContentText(content, passthroughKinds) {
  if (!Array.isArray(content)) return '';
  if (
    Array.isArray(passthroughKinds) &&
    passthroughKinds.length === content.length &&
    passthroughKinds.every((k) => typeof k === 'string')
  ) {
    return content
      .filter((_, idx) => !CODEX_STARTUP_KINDS.has(passthroughKinds[idx]))
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return content
    .filter((item) => item && typeof item.text === 'string' && !isCodexStartupText(item.text))
    .map((item) => item.text)
    .join('\n');
}

export function parseCodexTranscript(transcriptPath) {
  const rawObjects = [];
  for (const rawLine of readJsonlLines(transcriptPath)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rawObjects.push(parsed);
    } catch {
      continue;
    }
  }

  const hasUserEvents = rawObjects.some(
    (line) => line.type === 'event_msg' && line.payload?.type === 'item_completed' && line.payload.item?.type === 'UserMessage',
  );

  const events = [];
  for (const line of rawObjects) {
    if (line.type === 'event_msg' && line.payload?.type === 'item_completed') {
      const item = line.payload.item ?? {};
      if (item.type === 'UserMessage') {
        const text = extractCodexContentText(item.content);
        const classified = classifyUserText(text);
        if (classified) {
          if (classified.activatesSkill) events.push({ kind: 'skill', name: 'autonomous-work' });
          events.push({ kind: classified.kind, text: classified.text });
        }
      } else if (item.type === 'McpToolCall') {
        let args = item.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep raw */ }
        }
        if (isSkillReadCall(item.tool, args)) {
          events.push({ kind: 'skill', name: 'autonomous-work' });
        }
      } else if (item.type === 'CommandExecution') {
        if (isSkillReadCall('exec_command', { command: item.command })) {
          events.push({ kind: 'skill', name: 'autonomous-work' });
        }
      } else if (item.type === 'AgentMessage' && typeof item.text === 'string' && item.text.trim()) {
        events.push({ kind: 'assistant', text: item.text.trim() });
      }
      continue;
    }

    if (line.type !== 'response_item' || !line.payload || typeof line.payload !== 'object') continue;
    const p = line.payload;
    if (p.type === 'message') {
      if (p.role === 'assistant') {
        if (p.channel === 'analysis' || p.channel === 'reasoning' || p.phase === 'analysis' || p.phase === 'reasoning') {
          continue;
        }
        const text = extractCodexContentText(p.content).trim();
        if (text) events.push({ kind: 'assistant', text });
      } else if (p.role === 'user' && !hasUserEvents) {
        const text = extractCodexContentText(
          p.content,
          p.internal_chat_message_metadata_passthrough?.content_item_kinds,
        );
        const classified = classifyUserText(text);
        if (classified) {
          if (classified.activatesSkill) events.push({ kind: 'skill', name: 'autonomous-work' });
          events.push({ kind: classified.kind, text: classified.text });
        }
      }
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') {
      const rawInput = p.type === 'function_call' ? p.arguments : p.input;
      let parsedInput = rawInput;
      if (typeof rawInput === 'string') {
        try { parsedInput = JSON.parse(rawInput); } catch { /* keep raw string */ }
      }
      if (isSkillReadCall(p.name, parsedInput)) {
        events.push({ kind: 'skill', name: 'autonomous-work' });
      }
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.output === 'string') {
      if (SKILL_BODY_SIGNATURE_RE.test(p.output)) {
        events.push({ kind: 'skill', name: 'autonomous-work' });
      }
    }
  }
  return events;
}

function resolveAntigravityTranscriptPath(transcriptPath) {
  if (!transcriptPath) return transcriptPath;
  if (transcriptPath.endsWith('/transcript.jsonl') || transcriptPath.endsWith('\\transcript.jsonl')) {
    const fullCandidate = join(dirname(transcriptPath), 'transcript_full.jsonl');
    if (existsSync(fullCandidate)) return fullCandidate;
  }
  return transcriptPath;
}

function unwrapAntigravityUserText(raw) {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
  if (match) return match[1].trim();
  // Exclude system prompt envelopes when <USER_REQUEST> is absent.
  if (raw.includes('<identity>') && raw.includes('</skills>')) return '';
  return raw.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim();
}

export function parseAntigravityTranscript(transcriptPath) {
  const resolvedPath = resolveAntigravityTranscriptPath(transcriptPath);
  const events = [];
  for (const rawLine of readJsonlLines(resolvedPath)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;

    const kind = step.type ?? step.role ?? step.message?.role;
    const rawContent = String(step.content ?? step.text ?? step.message?.content ?? '');

    if (kind === 'USER_INPUT' || kind === 'user') {
      const clean = unwrapAntigravityUserText(rawContent);
      const classified = classifyUserText(clean);
      if (classified) {
        if (classified.activatesSkill) events.push({ kind: 'skill', name: 'autonomous-work' });
        events.push({ kind: classified.kind, text: classified.text });
      }
      continue;
    }

    if (kind === 'PLANNER_RESPONSE' || kind === 'assistant' || kind === 'model') {
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const args = call.arguments ?? call.args ?? call.input;
        let parsedArgs = args;
        if (typeof args === 'string') {
          try { parsedArgs = JSON.parse(args); } catch { /* keep raw */ }
        }
        if (isSkillReadCall(call.name, parsedArgs)) {
          events.push({ kind: 'skill', name: 'autonomous-work' });
        }
      }
      if (rawContent.trim()) {
        events.push({ kind: 'assistant', text: rawContent.trim() });
      }
      continue;
    }

    if (rawContent.includes(HOOK_MARKER)) {
      events.push({ kind: 'continuation', text: rawContent.trim() });
    }
  }
  return events;
}

export function parseOpenCodeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const events = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const role = entry.info?.role ?? entry.role;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];

    if (role === 'user') {
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      const classified = classifyUserText(text);
      if (classified) {
        if (classified.activatesSkill) events.push({ kind: 'skill', name: 'autonomous-work' });
        events.push({ kind: classified.kind, text: classified.text });
      }
    } else if (role === 'assistant') {
      const texts = [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        } else if (part.type === 'tool') {
          const toolName = part.tool ?? part.name;
          const toolInput = part.state?.input ?? part.input ?? part.args;
          const toolOutput = part.state?.output ?? part.output ?? '';
          if (isSkillReadCall(toolName, toolInput) || SKILL_BODY_SIGNATURE_RE.test(String(toolOutput))) {
            events.push({ kind: 'skill', name: 'autonomous-work' });
          }
        }
      }
      if (texts.length > 0) {
        events.push({ kind: 'assistant', text: texts.join('\n') });
      }
    }
  }
  return events;
}

function tailWindow(text, maxChars = 900) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}

function hasIncompleteStepRatio(text) {
  STEP_PROGRESS_RE.lastIndex = 0;
  let match;
  let latest = null;
  while ((match = STEP_PROGRESS_RE.exec(text)) !== null) {
    const current = Number.parseInt(match[1], 10);
    const total = Number.parseInt(match[2], 10);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      latest = { current, total };
    }
  }
  return latest !== null && latest.current < latest.total;
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

export function classifyAssistantStop(assistantText) {
  const raw = String(assistantText ?? '').trim();
  if (!raw) {
    return { stalled: true, reason: 'empty-turn' };
  }

  if (PROVIDER_LIMIT_RE.test(raw)) {
    return { stalled: false, reason: 'provider-limit' };
  }

  const prose = stripCodeBlocks(raw).trim();
  if (!prose) {
    return { stalled: true, reason: 'code-only-turn' };
  }

  const closing = tailWindow(prose);
  const hasConcreteBlocker = CONCRETE_BLOCKER_RE.test(prose);
  const hasLiveWatcher = LIVE_WATCHER_RE.test(closing);

  if (ANNOUNCED_NEXT_STEP_RE.test(closing)) {
    return { stalled: true, reason: 'announced-next-step' };
  }

  if (hasLiveWatcher && !OPTIONAL_HANDOFF_RE.test(closing)) {
    return { stalled: false, reason: 'waiting-on-live-watcher' };
  }

  if (OPTIONAL_HANDOFF_RE.test(closing) && !hasConcreteBlocker) {
    return { stalled: true, reason: 'optional-question-or-handoff' };
  }

  const nonEmptyLines = prose.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = nonEmptyLines.at(-1) ?? '';
  if (lastLine.endsWith('?') && !hasConcreteBlocker) {
    return { stalled: true, reason: 'trailing-question' };
  }

  if (!hasConcreteBlocker) {
    if (hasIncompleteStepRatio(prose)) {
      return { stalled: true, reason: 'unfinished-step-progress' };
    }
    if (UNCHECKED_BOX_RE.test(prose) || UNFINISHED_SECTION_RE.test(prose)) {
      return { stalled: true, reason: 'unfinished-progress' };
    }
  }

  if (hasConcreteBlocker) {
    return { stalled: false, reason: 'concrete-blocker' };
  }

  return { stalled: false, reason: 'completed' };
}

function defaultStateDir(env = process.env) {
  if (env.REPO_AUTONOMOUS_STATE_DIR) return env.REPO_AUTONOMOUS_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'repo-tools', 'autonomous-work-hook');
}

function stateFilePath(stateDir, harness, sessionId) {
  const digest = createHash('sha256').update(`${harness}:${sessionId}`).digest('hex').slice(0, 32);
  return join(stateDir, `${harness}-${digest}.json`);
}

function readSessionState(stateDir, harness, sessionId) {
  if (!sessionId) return null;
  const file = stateFilePath(stateDir, harness, sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSessionState(stateDir, harness, sessionId, data) {
  if (!sessionId) return;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = stateFilePath(stateDir, harness, sessionId);
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    // State persistence is a safety belt; never fail the host session on I/O errors.
  }
}

export function buildContinuationMessage(reason, continuationNumber, maxContinuations) {
  return [
    'continue',
    '',
    `${HOOK_MARKER} Stalled turn detected (${reason}; continuation ${continuationNumber}/${maxContinuations}). ` +
      'Autonomy was granted via autonomous-work: execute the next authorized in-scope step now instead of stopping on an announced action, partial status update, or optional question. ' +
      'Stop only when the requested outcome is verified complete, a live watcher will wake this session, or every remaining action has an exact blocker and unblock condition.',
  ].join('\n');
}

export function evaluateConversation({
  harness,
  sessionId,
  events,
  lastAssistantMessage,
  autonomousGrantedHint = false,
  continuationActiveHint = false,
  maxContinuations = DEFAULT_MAX_CONTINUATIONS,
  stateDir,
}) {
  let skillIndex = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind === 'skill' && events[i].name === 'autonomous-work') {
      skillIndex = i;
    }
  }

  if (skillIndex === -1 && !autonomousGrantedHint) {
    return { shouldContinue: false, reason: 'autonomy-not-granted' };
  }

  let lastRealUserIndex = -1;
  let lastRealUserText = '';
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind === 'user') {
      lastRealUserIndex = i;
      lastRealUserText = events[i].text;
    }
  }

  if (lastRealUserIndex > skillIndex && USER_STOP_DIRECTIVE_RE.test(lastRealUserText)) {
    return { shouldContinue: false, reason: 'user-revoked-autonomy' };
  }

  let transcriptContinuations = 0;
  for (let i = Math.max(0, lastRealUserIndex + 1); i < events.length; i += 1) {
    if (events[i].kind === 'continuation') {
      transcriptContinuations += 1;
    }
  }

  const userFingerprint = createHash('sha256')
    .update(`${lastRealUserIndex}:${lastRealUserText}`)
    .digest('hex')
    .slice(0, 16);

  const saved = stateDir && sessionId ? readSessionState(stateDir, harness, sessionId) : null;
  const savedContinuations = saved?.userFingerprint === userFingerprint && Number.isInteger(saved.continuations)
    ? saved.continuations
    : 0;

  const priorContinuations = Math.max(
    transcriptContinuations,
    savedContinuations,
    continuationActiveHint ? 1 : 0,
  );

  if (priorContinuations >= maxContinuations) {
    return { shouldContinue: false, reason: 'max-continuations-reached', continuations: priorContinuations };
  }

  let effectiveAssistantText = typeof lastAssistantMessage === 'string' && lastAssistantMessage.trim()
    ? lastAssistantMessage.trim()
    : '';
  if (!effectiveAssistantText) {
    const turnBoundary = Math.max(
      lastRealUserIndex,
      events.findLastIndex((ev) => ev.kind === 'continuation'),
    );
    const assistantChunks = [];
    for (let i = turnBoundary + 1; i < events.length; i += 1) {
      if (events[i].kind === 'assistant') assistantChunks.push(events[i].text);
    }
    effectiveAssistantText = assistantChunks.join('\n').trim();
  }

  const classification = classifyAssistantStop(effectiveAssistantText);
  if (!classification.stalled) {
    return { shouldContinue: false, reason: classification.reason, continuations: priorContinuations };
  }

  const nextContinuation = priorContinuations + 1;
  if (stateDir && sessionId) {
    writeSessionState(stateDir, harness, sessionId, {
      userFingerprint,
      continuations: nextContinuation,
      updatedAt: new Date().toISOString(),
    });
  }

  const message = buildContinuationMessage(classification.reason, nextContinuation, maxContinuations);
  const systemMessage = `${HOOK_MARKER} Resuming stalled autonomous-work session (${classification.reason}, ${nextContinuation}/${maxContinuations}).`;

  return {
    shouldContinue: true,
    reason: classification.reason,
    continuations: nextContinuation,
    message,
    systemMessage,
  };
}

function parseMaxContinuations(env = process.env) {
  const raw = env.REPO_AUTONOMOUS_MAX_CONTINUATIONS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONTINUATIONS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CONTINUATIONS;
}

function isHookDisabled(env = process.env) {
  const flag = String(env.REPO_AUTONOMOUS_WORK_HOOK ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return true;
  if (env.REPO_SKILL_EVALS_ACTIVE === '1') return true;
  return false;
}

export function detectHarness(payload, harnessHint) {
  const normalizedHint = String(harnessHint ?? '').trim().toLowerCase();
  if (normalizedHint === 'agy' || normalizedHint === 'antigravity') return 'antigravity';
  if (normalizedHint === 'claude' || normalizedHint === 'claude-code') return 'claude';
  if (normalizedHint === 'codex') return 'codex';
  if (normalizedHint === 'opencode') return 'opencode';

  if (payload && typeof payload === 'object') {
    if ('conversationId' in payload || 'hookEventName' in payload || 'workspacePaths' in payload) {
      return 'antigravity';
    }
    if (Array.isArray(payload.messages) && ('sessionID' in payload || 'info' in payload)) {
      return 'opencode';
    }
    if ('turn_id' in payload) return 'codex';
  }
  return 'claude';
}

export function formatHookOutput(harness, decision) {
  if (!decision.shouldContinue) {
    return {};
  }
  if (harness === 'antigravity') {
    return {
      decision: 'continue',
      reason: decision.message,
    };
  }
  if (harness === 'opencode') {
    return {
      decision: 'continue',
      reason: decision.message,
      systemMessage: decision.systemMessage,
    };
  }
  // Claude Code and Codex share the Stop block wire contract.
  return {
    decision: 'block',
    reason: decision.message,
    systemMessage: decision.systemMessage,
  };
}

export function runStopHookPayload(payload, options = {}) {
  const env = options.env ?? process.env;
  const harness = detectHarness(payload, options.harness);
  if (isHookDisabled(env) || !payload || typeof payload !== 'object') {
    return { harness, decision: { shouldContinue: false, reason: 'disabled-or-empty' }, output: {} };
  }

  const maxContinuations = options.maxContinuations ?? parseMaxContinuations(env);
  const stateDir = options.stateDir ?? defaultStateDir(env);

  if (harness === 'antigravity') {
    if (payload.hookEventName && payload.hookEventName !== 'Stop') {
      return { harness, decision: { shouldContinue: false, reason: 'non-stop-event' }, output: {} };
    }
    if (payload.fullyIdle === false) {
      return { harness, decision: { shouldContinue: false, reason: 'background-tasks-active' }, output: {} };
    }
    if (payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') {
      return { harness, decision: { shouldContinue: false, reason: `terminal:${payload.terminationReason}` }, output: {} };
    }

    const events = parseAntigravityTranscript(payload.transcriptPath);
    const decision = evaluateConversation({
      harness,
      sessionId: payload.conversationId,
      events,
      continuationActiveHint: Boolean(payload.continuationActive),
      maxContinuations,
      stateDir,
    });
    return { harness, decision, output: formatHookOutput(harness, decision) };
  }

  if (harness === 'opencode') {
    if (payload.blocked === true || payload.isSubagent === true || payload.info?.parentID) {
      return { harness, decision: { shouldContinue: false, reason: 'blocked-or-subagent' }, output: {} };
    }
    let messages = payload.messages;
    if (!Array.isArray(messages) && typeof payload.transcript_path === 'string' && existsSync(payload.transcript_path)) {
      try {
        const exported = JSON.parse(readFileSync(payload.transcript_path, 'utf8'));
        messages = exported?.messages;
      } catch {
        messages = [];
      }
    }
    const events = parseOpenCodeMessages(messages);
    const decision = evaluateConversation({
      harness,
      sessionId: payload.sessionID ?? payload.session_id ?? payload.info?.id,
      events,
      autonomousGrantedHint: Boolean(payload.autonomousActivated),
      maxContinuations,
      stateDir,
    });
    return { harness, decision, output: formatHookOutput(harness, decision) };
  }

  // Claude Code or Codex
  if (payload.hook_event_name && payload.hook_event_name !== 'Stop') {
    return { harness, decision: { shouldContinue: false, reason: 'non-stop-event' }, output: {} };
  }
  if (payload.agent_id || payload.agent_transcript_path) {
    return { harness, decision: { shouldContinue: false, reason: 'subagent' }, output: {} };
  }

  const events = harness === 'codex'
    ? parseCodexTranscript(payload.transcript_path)
    : parseClaudeTranscript(payload.transcript_path);

  const decision = evaluateConversation({
    harness,
    sessionId: payload.session_id,
    events,
    lastAssistantMessage: payload.last_assistant_message,
    continuationActiveHint: Boolean(payload.stop_hook_active),
    maxContinuations,
    stateDir,
  });

  return { harness, decision, output: formatHookOutput(harness, decision) };
}

function parseCliArgs(argv) {
  let harness;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--harness' && i + 1 < argv.length) {
      harness = argv[++i];
    } else if (arg.startsWith('--harness=')) {
      harness = arg.slice('--harness='.length);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`usage: repo-autonomous-work-hook [--harness claude|codex|opencode|antigravity]`);
    }
  }
  return { harness, help: false };
}

export function main(argv = process.argv.slice(2)) {
  let parsedArgs;
  try {
    parsedArgs = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (parsedArgs.help) {
    process.stdout.write('usage: repo-autonomous-work-hook [--harness claude|codex|opencode|antigravity]\n');
    return 0;
  }

  let rawInput = '';
  try {
    rawInput = readFileSync(0, 'utf8');
  } catch {
    rawInput = '';
  }

  if (!rawInput.trim()) {
    process.stdout.write('{}\n');
    return 0;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.stdout.write('{}\n');
    return 0;
  }

  const { output } = runStopHookPayload(payload, { harness: parsedArgs.harness });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  process.exitCode = main();
}

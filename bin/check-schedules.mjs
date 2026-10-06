#!/usr/bin/env node
// Reject periodic schedules that fire more often than hourly unless an
// adjacent comment justifies them:
//
//   # schedule-justification: <why polling at this cadence is the right design>
//
// A frequent timer or cron is usually a sign the design should react to an
// event instead of polling for it. This check makes every sub-hourly schedule
// an explicit, reviewed decision, and keeps the repository's inventory of them
// greppable (`git grep schedule-justification`).
//
// Checked declarations:
// - systemd timers (`*.timer`, `*.timer.j2`, and `[Timer]` sections embedded in
//   YAML/Jinja files such as Ansible `copy: content:` blocks): OnUnitActiveSec,
//   OnUnitInactiveSec, and OnCalendar, including several OnCalendar entries
//   that together fire more than once an hour.
// - GitHub Actions `on.schedule[].cron` in .github/workflows.
// - Kubernetes CronJob `schedule` (YAML documents with `kind: CronJob`).
//
// A value that cannot be evaluated (for example a Jinja or Helm expression)
// also needs a justification: the check cannot prove it is hourly or slower.
// The justification is the contiguous comment block directly above the line,
// or a trailing YAML comment on the line itself. systemd has no trailing
// comments, so timer justifications go on the line above.
//
// Usage: repo-check-schedules [--list] [file ...]
// With no file arguments every tracked file (git ls-files) is checked, so the
// inventory stays complete; with arguments only those files are. --list prints
// every sub-hourly schedule with its justification instead of failing.
// Dependency-free so it runs as a pre-commit `unsupported_script` hook.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 3600;
const JUSTIFICATION = /schedule-justification:[ \t]*(\S.*?)\s*(?:#\}|\*\/)?\s*$/;
const TIMER_FILE = /\.timer(\.j2)?$/;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const EMBEDDING = /\.(ya?ml|j2|tpl)$/;
const COMMENT = /^\s*(#|;|\{#|\/\/)/;
const TEMPLATE = /\{\{|\{%|\$\{/;

// ---------------------------------------------------------------------------
// Value evaluation. Each returns one of:
//   { kind: 'interval', seconds }           a monotonic period
//   { kind: 'calendar', hours, minute, second }  fires once per matching hour
//   { kind: 'subhourly', detail }           fires more than once an hour
//   { kind: 'once' }                        not periodic (e.g. @reboot)
//   { kind: 'unknown', detail }             cannot be evaluated statically

const SYSTEMD_UNITS = [
  [/^(us|usec)$/, 1e-6],
  [/^(ms|msec)$/, 1e-3],
  [/^(s|sec|second|seconds)?$/, 1],
  [/^(m|min|minute|minutes)$/, 60],
  [/^(h|hr|hour|hours)$/, HOUR],
  [/^(d|day|days)$/, 86400],
  [/^(w|week|weeks)$/, 7 * 86400],
  [/^(M|month|months)$/, 30.44 * 86400],
  [/^(y|year|years)$/, 365.25 * 86400],
];

// systemd.time(7) time span: "5min", "1h 30min", "90" (seconds), "2min30s".
export function parseTimespan(value) {
  const text = value.trim();
  if (!text || TEMPLATE.test(text)) return undefined;
  if (text === 'infinity') return Infinity;
  let seconds = 0;
  const pattern = /(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/gy;
  let match;
  let consumed = 0;
  while ((match = pattern.exec(text))) {
    const unit = SYSTEMD_UNITS.find(([re]) => re.test(match[2]));
    if (!unit) return undefined;
    seconds += Number(match[1]) * unit[1];
    consumed = pattern.lastIndex;
    while (text[pattern.lastIndex] === ' ') pattern.lastIndex++;
  }
  return consumed === text.length || text.slice(consumed).trim() === '' ? seconds : undefined;
}

// Go time.ParseDuration subset used by `@every` (k8s): "5m", "1h30m", "90s".
function parseGoDuration(text) {
  const units = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: HOUR };
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== text) return undefined;
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * units[unit], 0);
}

function range(from, to, step = 1) {
  const values = [];
  for (let v = from; v <= to; v += step) values.push(v);
  return values;
}

// One calendar or cron field over [min, max]. Returns a Set, or undefined when
// the field uses syntax this check does not model.
function expandField(field, min, max, { rangeSep, stepFromStartRuns }) {
  const values = new Set();
  for (const item of field.split(',')) {
    const [base, stepText] = item.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let from;
    let to;
    if (base === '*') {
      [from, to] = [min, max];
    } else if (base.includes(rangeSep)) {
      [from, to] = base.split(rangeSep).map((n) => Math.floor(Number(n)));
    } else {
      from = Math.floor(Number(base));
      to = stepText === undefined || !stepFromStartRuns ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max) return undefined;
    for (const v of range(from, to, step)) values.add(v);
  }
  return values;
}

function fromFields(hours, minutes, seconds, source) {
  if (!hours || !minutes || !seconds) return { kind: 'unknown', detail: `cannot evaluate "${source}"` };
  if (minutes.size > 1 || seconds.size > 1) {
    return { kind: 'subhourly', detail: `"${source}" matches ${minutes.size * seconds.size} times an hour` };
  }
  return { kind: 'calendar', hours, minute: [...minutes][0], second: [...seconds][0] };
}

const CALENDAR_SHORTHANDS = {
  minutely: 'subhourly',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
  quarterly: '*-01,04,07,10-01 00:00:00',
  semiannually: '*-01,07-01 00:00:00',
  yearly: '*-01-01 00:00:00',
  annually: '*-01-01 00:00:00',
};

// systemd.time(7) calendar event. Only the time of day decides whether an
// expression fires more than once an hour; weekday, date, and time zone only
// thin out which hours match.
export function parseCalendar(value) {
  const text = value.trim();
  if (TEMPLATE.test(text)) return { kind: 'unknown', detail: `cannot evaluate "${text}"` };
  const shorthand = CALENDAR_SHORTHANDS[text.toLowerCase()];
  if (shorthand === 'subhourly') return { kind: 'subhourly', detail: `"${text}" fires every minute` };
  const spec = shorthand ?? text;
  const time = spec.split(/\s+/).find((token) => token.includes(':')) ?? '00:00:00';
  const [h, m, s = '00', extra] = time.split(':');
  if (extra !== undefined || m === undefined) return { kind: 'unknown', detail: `cannot evaluate "${text}"` };
  const options = { rangeSep: '..', stepFromStartRuns: true };
  return fromFields(
    expandField(h, 0, 23, options),
    expandField(m, 0, 59, options),
    expandField(s, 0, 59, options),
    text,
  );
}

const CRON_MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// Five-field cron as used by GitHub Actions and Kubernetes CronJob.
export function parseCron(value) {
  const text = value.trim().replace(/^(CRON_TZ|TZ)=\S+\s+/, '');
  if (TEMPLATE.test(text)) return { kind: 'unknown', detail: `cannot evaluate "${text}"` };
  if (text === '@reboot') return { kind: 'once' };
  const every = /^@every\s+(\S+)$/.exec(text);
  if (every) {
    const seconds = parseGoDuration(every[1]);
    return seconds === undefined ? { kind: 'unknown', detail: `cannot evaluate "${text}"` } : { kind: 'interval', seconds };
  }
  const fields = (CRON_MACROS[text] ?? text).split(/\s+/);
  if (fields.length !== 5) return { kind: 'unknown', detail: `"${text}" is not a five-field cron expression` };
  const options = { rangeSep: '-', stepFromStartRuns: true };
  return fromFields(
    expandField(fields[1], 0, 23, options),
    expandField(fields[0], 0, 59, options),
    new Set([0]),
    text,
  );
}

// ---------------------------------------------------------------------------
// Declaration discovery. Each finding: { line, label, verdict, group }.
// Entries sharing a group (one [Timer] section, one workflow schedule list,
// one CronJob document) are also checked together: two hourly crons at :00 and
// :30 are a half-hourly schedule.

function unquote(text) {
  const trimmed = text.trim();
  const match = /^(['"])(.*)\1$/.exec(trimmed);
  return match ? match[2] : trimmed;
}

const stripYamlComment = (text) => text.replace(/\s+#.*$/, '');
const indentOf = (line) => line.length - line.trimStart().length;

function timerEntries(lines) {
  const entries = [];
  let section = '';
  let group = 0;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      group++;
      return;
    }
    if (section !== 'Timer') return;
    const directive = /^(OnUnitActiveSec|OnUnitInactiveSec|OnCalendar)\s*=\s*(.*)$/.exec(trimmed);
    if (!directive || !directive[2].trim()) return;
    const [, key, value] = directive;
    let verdict;
    if (key === 'OnCalendar') {
      verdict = parseCalendar(value);
    } else {
      const seconds = parseTimespan(value);
      verdict = seconds === undefined ? { kind: 'unknown', detail: `cannot evaluate "${value.trim()}"` } : { kind: 'interval', seconds };
    }
    entries.push({ line: i, label: `${key}=${value.trim()}`, verdict, group: `timer:${group}`, comments: 'above' });
  });
  return entries;
}

function workflowEntries(lines) {
  const entries = [];
  lines.forEach((line, i) => {
    const key = /^(\s*)schedule\s*:(.*)$/.exec(stripYamlComment(line));
    if (!key) return;
    const inline = key[2].trim();
    if (inline) {
      for (const match of inline.matchAll(/cron\s*:\s*(['"])(.*?)\1/g)) {
        entries.push({ line: i, label: `cron: '${match[2]}'`, verdict: parseCron(match[2]), group: `schedule:${i}` });
      }
      return;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || COMMENT.test(lines[j])) continue;
      if (indentOf(lines[j]) <= key[1].length) break;
      const cron = /^\s*-?\s*cron\s*:\s*(.*)$/.exec(lines[j]);
      if (!cron) continue;
      const value = unquote(stripYamlComment(cron[1]));
      entries.push({ line: j, label: `cron: '${value}'`, verdict: parseCron(value), group: `schedule:${i}` });
    }
  });
  return entries;
}

function cronJobEntries(lines) {
  const entries = [];
  let start = 0;
  const flush = (end) => {
    const doc = lines.slice(start, end);
    if (doc.some((line) => /^kind\s*:\s*['"]?CronJob['"]?\s*(#.*)?$/.test(line))) {
      doc.forEach((line, offset) => {
        const schedule = /^\s+schedule\s*:\s*(.+)$/.exec(line);
        if (!schedule) return;
        const value = unquote(stripYamlComment(schedule[1]));
        entries.push({ line: start + offset, label: `schedule: '${value}'`, verdict: parseCron(value), group: `cronjob:${start}` });
      });
    }
    start = end + 1;
  };
  lines.forEach((line, i) => {
    if (/^---/.test(line)) flush(i);
  });
  flush(lines.length);
  return entries;
}

export function scheduleEntries(text, file) {
  const lines = text.split('\n');
  const entries = [];
  if (TIMER_FILE.test(file) || (EMBEDDING.test(file) && lines.some((line) => line.trim() === '[Timer]'))) {
    entries.push(...timerEntries(lines));
  }
  if (WORKFLOW.test(file)) entries.push(...workflowEntries(lines));
  if (/\.(ya?ml|j2|tpl)$/.test(file) && /^kind\s*:\s*['"]?CronJob/m.test(text)) entries.push(...cronJobEntries(lines));
  for (const entry of entries) entry.justification = justificationFor(lines, entry);
  return entries;
}

function justificationFor(lines, entry) {
  if (entry.comments !== 'above') {
    const trailing = /\s#(.*)$/.exec(lines[entry.line]);
    const match = trailing && JUSTIFICATION.exec(trailing[1]);
    if (match) return match[1];
  }
  for (let i = entry.line - 1; i >= 0 && COMMENT.test(lines[i]); i--) {
    const match = JUSTIFICATION.exec(lines[i]);
    if (match) return match[1];
  }
  return undefined;
}

function describe(seconds) {
  if (seconds % HOUR === 0) return `${seconds / HOUR}h`;
  if (seconds % 60 === 0) return `${seconds / 60}min`;
  return `${seconds}s`;
}

// Why an entry (alone, or together with others in its group) fires more than
// once an hour, or cannot be shown not to. Undefined means it is hourly or
// slower.
function frequencyProblem(entry, group) {
  const { verdict } = entry;
  if (verdict.kind === 'unknown') return `${verdict.detail}; cannot show it fires hourly or less often`;
  if (verdict.kind === 'subhourly') return verdict.detail;
  if (verdict.kind === 'interval' && verdict.seconds < HOUR) return `fires every ${describe(verdict.seconds)}`;
  if (verdict.kind !== 'calendar') return undefined;
  const other = group.find(
    (candidate) =>
      candidate !== entry &&
      candidate.verdict.kind === 'calendar' &&
      (candidate.verdict.minute !== verdict.minute || candidate.verdict.second !== verdict.second) &&
      [...candidate.verdict.hours].some((hour) => verdict.hours.has(hour)),
  );
  return other ? `together with ${other.label} (line ${other.line + 1}) fires more than once in the same hour` : undefined;
}

export function findings(text, file = '<file>') {
  const entries = scheduleEntries(text, file);
  return entries.flatMap((entry) => {
    const group = entries.filter((candidate) => candidate.group === entry.group);
    const problem = frequencyProblem(entry, group);
    if (!problem) return [];
    // A combined group needs one justification among its participants.
    const justification = entry.justification ?? group.find((candidate) => candidate.justification && problem.includes(candidate.label))?.justification;
    return [{ file, line: entry.line + 1, label: entry.label, problem, justification }];
  });
}

export function violations(text, file = '<file>') {
  return findings(text, file)
    .filter((finding) => !finding.justification)
    .map(
      (finding) =>
        `${finding.file}:${finding.line}: ${finding.label} ${finding.problem}. A schedule more frequent than hourly ` +
          `usually means the design should react to an event instead of polling. If this cadence is deliberate, ` +
          `add an adjacent "# schedule-justification: <reason>" comment.`,
    );
}

// ---------------------------------------------------------------------------

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20 })
      .split('\0')
      .filter(Boolean);
  } catch {
    console.error('repo-check-schedules: not a git checkout; pass the files to check.');
    process.exit(2);
  }
}

const candidate = (file) => TIMER_FILE.test(file) || WORKFLOW.test(file) || EMBEDDING.test(file);

function main(args) {
  const list = args.includes('--list');
  const named = args.filter((arg) => arg !== '--list').map((arg) => path.relative('.', arg).split(path.sep).join('/'));
  const files = (named.length ? named : trackedFiles()).filter((file) => candidate(file) && existsSync(file));

  const all = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return list ? findings(text, file) : violations(text, file);
  });
  if (list) {
    for (const finding of all) {
      console.log(`${finding.file}:${finding.line}: ${finding.label} (${finding.problem})\n  justification: ${finding.justification ?? 'MISSING'}`);
    }
    return all.some((finding) => !finding.justification) ? 1 : 0;
  }
  for (const message of all) console.error(message);
  return all.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

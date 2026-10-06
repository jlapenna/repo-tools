import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findings, parseCalendar, parseCron, parseTimespan, violations } from './check-schedules.mjs';

const script = fileURLToPath(new URL('./check-schedules.mjs', import.meta.url));
const timer = (body) => `[Unit]\nDescription=x\n\n[Timer]\n${body}\n\n[Install]\nWantedBy=timers.target\n`;
const workflow = (schedule) => `name: w\non:\n  schedule:\n${schedule}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;

test('parses systemd time spans', () => {
  assert.equal(parseTimespan('30s'), 30);
  assert.equal(parseTimespan('5min'), 300);
  assert.equal(parseTimespan('5m'), 300);
  assert.equal(parseTimespan('1h 30min'), 5400);
  assert.equal(parseTimespan('2min30s'), 150);
  assert.equal(parseTimespan('90'), 90);
  assert.equal(parseTimespan('1d'), 86400);
  assert.equal(parseTimespan('24h'), 86400);
  assert.equal(parseTimespan('1M') > 86400 * 28, true);
  assert.equal(parseTimespan('{{ interval }}'), undefined);
  assert.equal(parseTimespan('5 parsecs'), undefined);
});

test('classifies calendar events by how often they fire within an hour', () => {
  for (const sub of ['*:0/5', '*:*', '*-*-* *:00/15:00', 'minutely', '*:00,30', '*-*-* 09:00:*', 'Mon..Fri *-*-* 09..17:0/10']) {
    assert.equal(parseCalendar(sub).kind, 'subhourly', sub);
  }
  for (const ok of ['hourly', 'daily', '*-*-* *:00:00', '*-*-* 06,18:30:00', 'Sun *-*-* 05:00:00', 'Mon..Fri *-*-* 09:00:00 America/Los_Angeles', '*-*-* 0/2:15']) {
    assert.equal(parseCalendar(ok).kind, 'calendar', ok);
  }
  assert.equal(parseCalendar('{{ when }}').kind, 'unknown');
});

test('classifies cron expressions', () => {
  for (const sub of ['*/5 * * * *', '* * * * *', '0,30 * * * *', '0-10 9 * * *', 'CRON_TZ=UTC */15 * * * *']) {
    assert.equal(parseCron(sub).kind, 'subhourly', sub);
  }
  for (const ok of ['17 9 * * *', '0 * * * *', '17 4 * * 1', '0 */2 * * *', '@hourly', '@daily']) {
    assert.equal(parseCron(ok).kind, 'calendar', ok);
  }
  assert.deepEqual(parseCron('@every 5m'), { kind: 'interval', seconds: 300 });
  assert.equal(parseCron('@reboot').kind, 'once');
  assert.equal(parseCron('{{ .Values.schedule }}').kind, 'unknown');
  assert.equal(parseCron('0 0 * * * *').kind, 'unknown');
});

test('flags sub-hourly timers and accepts hourly or slower ones', () => {
  for (const body of ['OnBootSec=1m\nOnUnitActiveSec=1m', 'OnUnitInactiveSec=10m', 'OnCalendar=*:0/5', 'OnUnitActiveSec={{ every }}']) {
    const found = violations(timer(body), 'x.timer');
    assert.equal(found.length, 1, body);
    assert.match(found[0], /^x\.timer:\d+: On\w+=\S+ .*schedule-justification/);
  }
  for (const body of ['OnBootSec=30s', 'OnUnitActiveSec=1h', 'OnUnitInactiveSec=1d', 'OnCalendar=*-*-* *:00:00', 'OnCalendar=']) {
    assert.deepEqual(violations(timer(body), 'x.timer'), [], body);
  }
  // Directives outside [Timer] are not schedules.
  assert.deepEqual(violations('[Service]\nOnUnitActiveSec=1m\n', 'x.timer'), []);
});

test('several calendar entries that share an hour are checked together', () => {
  const found = violations(timer('OnCalendar=*-*-* *:00:00\nOnCalendar=*-*-* *:30:00'), 'x.timer.j2');
  assert.equal(found.length, 2);
  assert.match(found[0], /together with OnCalendar=\*-\*-\* \*:30:00/);
  assert.deepEqual(violations(timer('OnCalendar=Mon..Fri *-*-* 09:00:00\nOnCalendar=Mon..Fri *-*-* 17:00:00'), 'x.timer'), []);
  // One justification covers the combination.
  const justified = timer('# schedule-justification: two half-hourly windows\nOnCalendar=*-*-* *:00:00\nOnCalendar=*-*-* *:30:00');
  assert.deepEqual(violations(justified, 'x.timer'), []);
});

test('a justification is the adjacent comment block, never a distant one', () => {
  const above = timer('OnBootSec=1m\n# Probe each minute.\n# schedule-justification: the alert pages after 2m\nOnUnitActiveSec=1m');
  assert.deepEqual(violations(above, 'x.timer'), []);
  assert.equal(findings(above, 'x.timer')[0].justification, 'the alert pages after 2m');

  const detached = timer('# schedule-justification: stale\nOnBootSec=1m\nOnUnitActiveSec=1m');
  assert.equal(violations(detached, 'x.timer').length, 1);
  const blank = timer('# schedule-justification: stale\n\nOnUnitActiveSec=1m');
  assert.equal(violations(blank, 'x.timer').length, 1);
  const empty = timer('# schedule-justification:\nOnUnitActiveSec=1m');
  assert.equal(violations(empty, 'x.timer').length, 1);
  // systemd has no trailing comments; that text would be part of the value.
  assert.equal(violations(timer('OnUnitActiveSec=1m # schedule-justification: no'), 'x.timer').length, 1);
  // Jinja comments work in templated timers.
  assert.deepEqual(violations(timer('{# schedule-justification: templated reason #}\nOnUnitActiveSec=1m'), 'x.timer.j2'), []);
});

test('finds timers embedded in YAML, such as Ansible copy content', () => {
  const playbook = [
    '- name: Install units',
    '  ansible.builtin.copy:',
    '    content: |',
    '      [Unit]',
    '      Description=x',
    '      [Timer]',
    '      OnBootSec=5m',
    '      OnUnitActiveSec=15m',
    '',
  ].join('\n');
  const found = violations(playbook, 'ansible/deploy.yml');
  assert.equal(found.length, 1);
  assert.match(found[0], /^ansible\/deploy\.yml:8: OnUnitActiveSec=15m fires every 15min/);
  const justified = playbook.replace('      OnUnitActiveSec', '      # schedule-justification: storage fills within an hour\n      OnUnitActiveSec');
  assert.deepEqual(violations(justified, 'ansible/deploy.yml'), []);
  // Markdown examples are documentation, not declarations.
  assert.deepEqual(violations('[Timer]\nOnUnitActiveSec=1m\n', 'docs/x.md'), []);
});

test('flags sub-hourly GitHub Actions schedules only under on.schedule', () => {
  assert.deepEqual(violations(workflow("    - cron: '17 9 * * *'"), '.github/workflows/w.yml'), []);
  const found = violations(workflow("    - cron: '*/5 * * * *'"), '.github/workflows/w.yml');
  assert.equal(found.length, 1);
  assert.match(found[0], /^\.github\/workflows\/w\.yml:4: cron: '\*\/5 \* \* \* \*' "\*\/5 \* \* \* \*" matches 12 times an hour/);

  assert.deepEqual(violations(workflow("    - cron: '*/5 * * * *' # schedule-justification: queue drain"), '.github/workflows/w.yml'), []);
  assert.deepEqual(
    violations(workflow("    # schedule-justification: queue drain\n    - cron: \"*/5 * * * *\""), '.github/workflows/w.yml'),
    [],
  );
  assert.equal(violations(workflow("    - cron: '0 * * * *'\n    - cron: '30 * * * *'"), '.github/workflows/w.yml').length, 2);
  assert.equal(violations("on:\n  schedule: [{cron: '*/10 * * * *'}]\n", '.github/workflows/w.yml').length, 1);

  // A workflow_dispatch input that happens to be called cron is not a schedule.
  const input = "on:\n  workflow_dispatch:\n    inputs:\n      cron:\n        default: '*/5 * * * *'\n";
  assert.deepEqual(violations(input, '.github/workflows/w.yml'), []);
  // Only workflow files carry GitHub schedules.
  assert.deepEqual(violations(workflow("    - cron: '*/5 * * * *'"), 'other/w.yml'), []);
});

test('flags sub-hourly Kubernetes CronJobs per document', () => {
  const manifest = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'data:',
    '  schedule: "*/1 * * * *"',
    '---',
    'apiVersion: batch/v1',
    'kind: CronJob',
    'spec:',
    '  schedule: "*/10 * * * *"',
    '  jobTemplate: {}',
    '---',
    'kind: CronJob',
    'spec:',
    "  schedule: '@daily'",
    '',
  ].join('\n');
  const found = violations(manifest, 'k8s/jobs.yaml');
  assert.equal(found.length, 1);
  assert.match(found[0], /^k8s\/jobs\.yaml:9: schedule: '\*\/10/);
  assert.equal(violations('kind: CronJob\nspec:\n  schedule: "{{ .Values.every }}"\n', 'chart/cron.yaml').length, 1);
});

test('regressions from review: YAML layouts, line endings, drop-ins, resets', () => {
  const w = '.github/workflows/w.yml';
  // A block sequence at its key's own indent.
  assert.equal(violations("on:\n  schedule:\n  - cron: '*/5 * * * *'\njobs: {}\n", w).length, 1);
  assert.deepEqual(violations("on:\n  schedule:\n  - cron: '17 9 * * *'\n  workflow_dispatch:\n    inputs:\n      cron:\n        default: '*/5 * * * *'\n", w), []);
  // Inline maps as list items, and a flow list starting on the next line.
  assert.equal(violations("on:\n  schedule:\n    - {cron: '*/5 * * * *'}\n", w).length, 1);
  assert.equal(violations("on:\n  schedule: [\n    {cron: '*/5 * * * *'}\n  ]\n", w).length, 1);
  // CRLF and a byte-order mark.
  assert.equal(violations("on:\r\n  schedule:\r\n    - cron: '*/5 * * * *'\r\n", w).length, 1);
  assert.equal(violations("apiVersion: batch/v1\r\nkind: CronJob\r\nspec:\r\n  schedule: '*/5 * * * *'\r\n", 'k.yaml').length, 1);
  assert.equal(violations("\uFEFFkind: CronJob\nspec:\n  schedule: '*/5 * * * *'\n", 'k.yaml').length, 1);
  assert.equal(violations(timer('OnUnitActiveSec=5m').replaceAll('\n', '\r\n'), 'x.timer').length, 1);
  // A CronJob nested in a List.
  assert.equal(violations("kind: List\nitems:\n  - kind: CronJob\n    spec:\n      schedule: '*/5 * * * *'\n", 'k.yaml').length, 1);
  // systemd drop-ins that change a packaged timer.
  assert.equal(violations('[Timer]\nOnCalendar=\nOnCalendar=*:0/5\n', 'etc/foo.timer.d/override.conf').length, 1);
  assert.equal(violations('[Timer]\nOnCalendar=*:0/5\n', 'roles/x/templates/foo.timer.d/10-fast.conf.j2').length, 1);
  // An empty assignment resets earlier values of that setting only.
  assert.deepEqual(violations(timer('OnCalendar=*:00\nOnCalendar=\nOnCalendar=*:30'), 'x.timer'), []);
  assert.equal(violations(timer('OnUnitActiveSec=5m\nOnCalendar='), 'x.timer').length, 1);
  // Entries in different hours that still fire less than an hour apart.
  assert.equal(violations(workflow("    - cron: '50 */2 * * *'\n    - cron: '10 1-23/2 * * *'"), w).length, 2);
  assert.equal(violations(timer('OnCalendar=*-*-* 23:50\nOnCalendar=*-*-* 00:20'), 'x.timer').length, 2);
  assert.deepEqual(violations(workflow("    - cron: '0 9 * * *'\n    - cron: '0 10 * * *'"), w), []);
});

test('an empty Jinja or C-style justification is still empty', () => {
  assert.equal(violations(timer('{# schedule-justification: #}\nOnUnitActiveSec=5min'), 'x.timer.j2').length, 1);
  assert.equal(violations(timer('{# schedule-justification:#}\nOnUnitActiveSec=5min'), 'x.timer.j2').length, 1);
  assert.equal(violations('kind: CronJob\nspec:\n  /* schedule-justification: */\n  schedule: "*/5 * * * *"\n', 'k.yaml').length, 1);
  assert.equal(findings(timer('{# schedule-justification: real reason #}\nOnUnitActiveSec=5min'), 'x.timer.j2')[0].justification, 'real reason');
});

test('CLI checks every tracked file by default and only named files otherwise', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'schedules-'));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(path.join(root, 'units'));
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    writeFileSync(path.join(root, 'units/daily.timer'), timer('OnCalendar=daily'));
    writeFileSync(path.join(root, '.github/workflows/w.yml'), workflow("    - cron: '17 9 * * *'"));
    execFileSync('git', ['add', '.'], { cwd: root });
    assert.equal(run().status, 0);

    writeFileSync(path.join(root, 'units/fast.timer'), timer('OnUnitActiveSec=5m'));
    // Untracked files are not part of the inventory until they are added.
    assert.equal(run().status, 0);
    execFileSync('git', ['add', '.'], { cwd: root });
    const all = run();
    assert.equal(all.status, 1);
    assert.match(all.stderr, /^units\/fast\.timer:5: OnUnitActiveSec=5m fires every 5min/);

    // A tracked symlink to a directory is not a file to read.
    mkdirSync(path.join(root, 'dir'));
    symlinkSync('dir', path.join(root, 'link.yml'));
    execFileSync('git', ['add', 'link.yml'], { cwd: root });
    assert.equal(run().status, 1);
    assert.doesNotMatch(run().stderr, /EISDIR/);

    // Named files restrict the check.
    assert.equal(run('units/daily.timer', 'README.md').status, 0);
    assert.equal(run('units/fast.timer').status, 1);

    const list = run('--list');
    assert.equal(list.status, 1);
    assert.match(list.stdout, /units\/fast\.timer:5: OnUnitActiveSec=5m \(fires every 5min\)\n {2}justification: MISSING/);

    writeFileSync(path.join(root, 'units/fast.timer'), timer('# schedule-justification: test fixture\nOnUnitActiveSec=5m'));
    assert.equal(run().status, 0);
    assert.match(run('--list').stdout, /justification: test fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

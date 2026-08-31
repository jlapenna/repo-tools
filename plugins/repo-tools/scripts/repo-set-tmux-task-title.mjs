#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tmux = process.env.TMUX_BIN || 'tmux';
const pane = process.env.TMUX_PANE;

if (!process.env.TMUX || !pane) {
  process.exit(0);
}

const runTmux = (args) => execFileSync(tmux, args, { encoding: 'utf8' });
const current = runTmux(['display-message', '-p', '-t', pane, '#{@user_title}']).trim();

if (current) {
  process.exit(0);
}

let prompt = '';
try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
} catch {
  process.exit(0);
}

prompt = prompt.replace(/\s+/g, ' ').trim();
const issueMatch = prompt.match(/#(\d+)/);
const title = issueMatch
  ? `${issueMatch[1]} ${prompt.slice(issueMatch.index + issueMatch[0].length).replace(/^[\s:;,.!?-]+/, '')}`.trim()
  : prompt;

if (!title) {
  process.exit(0);
}

runTmux(['set-window-option', '-t', pane, '@user_title', title.slice(0, 52)]);
runTmux(['set-window-option', '-t', pane, 'automatic-rename', 'on']);

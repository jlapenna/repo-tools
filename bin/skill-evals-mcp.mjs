#!/usr/bin/env node
// The same bounded tools used by Codex, exposed to other native harnesses.
import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readTools } from './skill-evals-tools.mjs';

const [configuration] = process.argv.slice(2);
const { plugin, caseDir, tracePath, allowed, maxCalls } = JSON.parse(readFileSync(configuration, 'utf8'));
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 200) throw Error('Invalid eval tool limit');
const tools = readTools(plugin, caseDir, allowed);
let calls = 0;
const record = event => appendFileSync(tracePath, JSON.stringify(event) + '\n', { mode: 0o600 });
serveStdio(() => {
  const server = new McpServer({ name: 'repo-skill-evals', version: '1.0.0' });
  for (const definition of tools.definitions) {
    const key = definition.inputSchema.required[0];
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: z.strictObject({ [key]: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async args => {
      try {
        if (++calls > maxCalls) {
          record({ type: 'limit.exceeded', limit: 'tool-calls' });
          throw Error('Eval tool-call limit exceeded');
        }
        const result = tools.call(definition.name, args);
        record({ type: 'tool.call', tool: definition.name, arguments: args, result });
        if (definition.name === 'Skill') record({ type: 'skill.loaded', skill: args.skill });
        return { content: [{ type: 'text', text: result }] };
      } catch (error) {
        record({ type: 'tool.denied', tool: definition.name, reason: error.message });
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
});

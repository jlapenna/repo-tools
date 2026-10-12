import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('always-loaded agent context stays compact', async () => {
  const agents = await read('AGENTS.md');
  assert.ok(Buffer.byteLength(agents) <= 14 * 1024);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { Linter } from 'eslint';

import {
  fleetBaseline,
  fleetEslintPlugin,
  noServerOnlyImportsInClientName,
  useServerActionsOnlyName,
} from '../index.mjs';

test('consumer config can register the shared plugin and enforce server actions', () => {
  const linter = new Linter();
  const messages = linter.verify(
    "'use server';\nexport const answer = 42;",
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        plugins: { fleet: fleetEslintPlugin },
        rules: { [`fleet/${useServerActionsOnlyName}`]: 'error' },
      },
    ],
    { filename: 'page.ts' },
  );

  assert.equal(messages.length, 1);
  assert.deepEqual(
    messages.map(({ messageId }) => messageId),
    ['misplacedDirective'],
  );
});

test('fleet baseline exposes one config surface and rejects incomplete injection', () => {
  assert.ok(fleetEslintPlugin.rules[noServerOnlyImportsInClientName]);
  assert.throws(() => fleetBaseline({}), /needs both/);
  const [base, commonJsOverride] = fleetBaseline({
    simpleImportSort: {},
    unusedImports: {},
  });
  assert.equal(base.rules['simple-import-sort/imports'], 'error');
  assert.equal(commonJsOverride.rules['no-restricted-syntax'], 'off');
});

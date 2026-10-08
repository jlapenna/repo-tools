import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const preset = read('./renovate-preset.json');
const local = read('./renovate.json');

const findRule = (rules, expected) =>
  rules.find((rule) => {
    const { description, ...rest } = rule;
    try {
      assert.deepStrictEqual(rest, expected.rule);
      return description?.includes(expected.descriptionIncludes);
    } catch {
      return false;
    }
  });

test('uses grouped automerge instead of a hosted-run schedule to control update noise', () => {
  assert.equal(preset.schedule, undefined);
  assert.ok(
    findRule(preset.packageRules, {
      descriptionIncludes: 'Group and automerge',
      rule: {
        matchUpdateTypes: ['minor', 'patch', 'digest'],
        groupName: 'all non-major dependencies',
        groupSlug: 'all-minor-patch',
        automerge: true,
        automergeType: 'pr',
      },
    }),
  );
});

test('blocks only the known-incompatible TypeScript 7 line for every consumer', () => {
  assert.ok(
    findRule(preset.packageRules, {
      descriptionIncludes: 'TypeScript 7',
      rule: { matchPackageNames: ['typescript'], allowedVersions: '<7 || >=8' },
    }),
  );
});

test('blocks the @swc/core range above known-good 1.16.2 through proven-bad 1.16.13', () => {
  assert.ok(
    findRule(preset.packageRules, {
      descriptionIncludes: '@swc/core 1.16.12 and 1.16.13',
      rule: {
        matchPackageNames: ['@swc/core'],
        allowedVersions: '<1.16.3 || >1.16.13',
      },
    }),
  );
});

test("gives every pnpm 11 consumer pnpm's 24-hour release-age policy", () => {
  assert.ok(
    findRule(preset.packageRules, {
      descriptionIncludes: 'minimumReleaseAge',
      rule: { matchManagers: ['npm'], minimumReleaseAge: '1 day' },
    }),
  );
});

test("bounds Node memory for pnpm artifact updates inside Mend's recommended range", () => {
  // Integer MiB; Mend recommends 1.5-2.5 GB for pnpm/yarn repos that hit
  // hosted timeout or kernel-out-of-memory limits.
  const value = preset.toolSettings?.nodeMaxMemory;
  assert.ok(Number.isInteger(value) && value >= 1536 && value <= 2560);
});

test('this repository consumes the preset it publishes', () => {
  assert.ok(local.extends.includes('github>jlapenna/repo-tools//renovate-preset'));
});

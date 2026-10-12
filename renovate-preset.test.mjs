import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const preset = JSON.parse(
  readFileSync(new URL("./renovate-preset.json", import.meta.url), "utf8"),
);
const rules = preset.packageRules;
const nonMajorTypes = ["minor", "patch", "digest"];

test("non-major updates, including 0.x minors, automerge", () => {
  const rule = rules.find((r) => r.groupSlug === "all-minor-patch");
  assert.ok(rule, "grouped non-major rule exists");
  assert.deepEqual(
    [...rule.matchUpdateTypes].sort(),
    [...nonMajorTypes].sort(),
  );
  assert.equal(rule.automerge, true);
  for (const key of [
    "matchCurrentVersion",
    "matchCurrentValue",
    "matchIsBreaking",
  ]) {
    assert.equal(
      rule[key],
      undefined,
      `${key} would carve 0.x or breaking-classified updates out of automerge`,
    );
  }
});

test("no rule disables automerge for non-major update types", () => {
  for (const rule of rules) {
    if (rule.automerge !== false) continue;
    const types = rule.matchUpdateTypes ?? [];
    assert.ok(
      types.length > 0,
      `automerge:false rule must be scoped by update type: ${rule.description}`,
    );
    for (const type of types) {
      assert.ok(
        !nonMajorTypes.includes(type),
        `rule disables automerge for ${type}: ${rule.description}`,
      );
    }
  }
});

test("major updates open as drafts without automerge", () => {
  const rule = rules.find((r) => r.matchUpdateTypes?.includes("major"));
  assert.equal(rule?.draftPR, true);
  assert.equal(rule?.automerge, false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
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

// Evaluate only the age rule's documented manager/name/source selectors, so
// examples exercise the configured exemption scope rather than pinning strings.
function releaseAgeFor({ packageName, sourceUrl, manager = "npm" }) {
  let age;
  for (const rule of rules) {
    if (rule.minimumReleaseAge === undefined) continue;
    if (rule.matchManagers && !rule.matchManagers.includes(manager)) continue;
    if (
      rule.matchPackageNames &&
      !rule.matchPackageNames.some((pattern) =>
        matchesGlob(packageName, pattern),
      )
    )
      continue;
    if (
      rule.matchSourceUrls &&
      (!sourceUrl ||
        !rule.matchSourceUrls.some((pattern) =>
          matchesGlob(sourceUrl, pattern),
        ))
    )
      continue;
    age = rule.minimumReleaseAge;
  }
  return age;
}

test("first-party releases bypass age by publisher, source, or image namespace", () => {
  const cases = [
    { packageName: "jlapenna/repo-tools" },
    { packageName: "@jlapenna/repo-tools" },
    { packageName: "@jlapenna/fleet-runtime" },
    { packageName: "@supersprinklesracing/shared" },
    {
      packageName: "published-unscoped",
      sourceUrl: "https://github.com/jlapenna/published-unscoped",
    },
    {
      packageName: "published-unscoped",
      sourceUrl: "https://github.com/supersprinklesracing/published-unscoped",
    },
    { packageName: "ghcr.io/jlapenna/runner", manager: "dockerfile" },
    { packageName: "docker.io/jlapenna/runner", manager: "dockerfile" },
    {
      packageName: "docker-registry.lan.jlapenna.net/homelab-runner",
      manager: "dockerfile",
    },
    {
      packageName: "us-central1-docker.pkg.dev/agent-lcars/images/runner",
      manager: "dockerfile",
    },
    { packageName: "local/runner", manager: "dockerfile" },
  ];
  for (const dependency of cases) {
    assert.equal(
      releaseAgeFor(dependency),
      "0 days",
      JSON.stringify(dependency),
    );
  }
});

test("third-party npm releases retain the default even in a first-party consumer", () => {
  for (const dependency of [
    { packageName: "react", sourceUrl: "https://github.com/facebook/react" },
    { packageName: "@nx/devkit", sourceUrl: "https://github.com/nrwl/nx" },
    { packageName: "@jlapenna-lookalike/pkg" },
    { packageName: "jlapenna-lookalike/repo-tools" },
    {
      packageName: "unrelated",
      sourceUrl: "https://github.com/jlapenna-lookalike/unrelated",
    },
  ]) {
    assert.equal(
      releaseAgeFor(dependency),
      "1 day",
      JSON.stringify(dependency),
    );
  }
});

test("Renovate age values use its duration-string schema, not pnpm numbers", () => {
  for (const rule of rules) {
    if (
      rule.minimumReleaseAge !== undefined &&
      rule.minimumReleaseAge !== null
    ) {
      assert.equal(typeof rule.minimumReleaseAge, "string");
    }
  }
});

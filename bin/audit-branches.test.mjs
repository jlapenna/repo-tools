import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("named cleanup isolates the selected branch and reports refused deletion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-scope-test-"));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: bin + ":" + process.env.PATH };
  const run = (...args) => execFileSync(args[0], args.slice(1), {
    cwd: repo, env, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const script = fileURLToPath(new URL("./audit-branches.sh", import.meta.url));
  const refuses = (...args) => assert.throws(() => run("bash", script, ...args),
    (error) => Number.isInteger(error.status) && error.status !== 0);
  try {
    run("git", "init", "--bare", remote);
    run("git", "init", "-b", "main");
    run("git", "config", "user.name", "Fixture");
    run("git", "config", "user.email", "fixture@example.invalid");
    run("git", "commit", "--allow-empty", "-m", "base");
    const base = run("git", "rev-parse", "HEAD");
    run("git", "remote", "add", "origin", remote);
    for (const branch of ["selected", "other"]) run("git", "branch", branch);
    run("git", "push", "origin", "main", "selected", "other");
    fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\ncase "$1" in\napi) echo "[[]]";;\npr) echo "[]";;\n*) exit 2;;\nesac\n', { mode: 0o755 });

    run("bash", script, "--branch", "selected", "--delete");
    assert.throws(() => run("git", "rev-parse", "refs/heads/selected"));
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/selected"), base);
    run("git", "branch", "selected", base);
    run("bash", script, "--branch", "selected", "--delete-remote");
    assert.throws(() => run("git", "--git-dir", remote, "rev-parse", "refs/heads/selected"));
    run("bash", script, "--branch", "selected", "--delete-remote");
    assert.equal(run("git", "rev-parse", "refs/heads/selected"), base);
    assert.equal(run("git", "rev-parse", "refs/heads/other"), base);
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/other"), base);

    // A still-checked-out merged branch is retained, with a refusal status.
    run("git", "push", "origin", "selected");
    // A missing tracking ref is not proof that the live branch is absent.
    run("git", "update-ref", "-d", "refs/remotes/origin/selected");
    refuses("--branch", "selected", "--delete-remote");
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/selected"), base);
    run("git", "fetch", "origin");
    run("git", "worktree", "add", path.join(root, "occupied"), "selected");
    refuses("--branch", "selected", "--delete-remote");
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/selected"), base);

    // Unmerged work and the base branch remain protected under a selector.
    run("git", "switch", "-c", "unmerged");
    fs.writeFileSync(path.join(repo, "work"), "unmerged\n");
    run("git", "add", "work");
    run("git", "commit", "-m", "unmerged");
    const unmerged = run("git", "rev-parse", "HEAD");
    run("git", "switch", "main");
    run("git", "push", "origin", "unmerged");
    refuses("--branch", "unmerged", "--delete-remote");
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/unmerged"), unmerged);
    refuses("--branch", "main", "--delete-remote");
    refuses("--branch", "", "--delete-remote");
    refuses("--branch", "HEAD", "--delete-remote");
    refuses("--branch", "--delete-remote");
    refuses("--branch", "invalid name", "--delete-remote");
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/main"), base);
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/other"), base);

    // Ownership appearing between audit and apply must also report refusal.
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
case "$1" in
api)
  if test -f '${root}/queried'; then
    echo '[[{"head":{"ref":"other"}}]]'
  else
    touch '${root}/queried'; echo '[[]]'
  fi;;
pr) echo '[]';;
*) exit 2;;
esac
`, { mode: 0o755 });
    refuses("--branch", "other", "--delete-remote");
    assert.equal(run("git", "--git-dir", remote, "rev-parse", "refs/heads/other"), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote cleanup succeeds after auto-deletion but fails when the remote is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-auto-delete-test-"));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: bin + ":" + process.env.PATH,
  };
  const run = (...args) => execFileSync(args[0], args.slice(1), {
    cwd: repo, env, encoding: "utf8", timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    run("git", "init", "--bare", remote);
    run("git", "init", "-b", "main");
    run("git", "config", "user.name", "Fixture");
    run("git", "config", "user.email", "fixture@example.invalid");
    run("git", "commit", "--allow-empty", "-m", "base");
    const base = run("git", "rev-parse", "HEAD");
    run("git", "remote", "add", "origin", remote);
    run("git", "push", "-u", "origin", "main", `${base}:refs/heads/landed`);
    // Model GitHub's auto-deletion without refreshing the local tracking ref.
    run("git", "--git-dir", remote, "update-ref", "-d", "refs/heads/landed");
    assert.equal(run("git", "rev-parse", "refs/remotes/origin/landed"), base);
    fs.writeFileSync(path.join(repo, ".git/hooks/pre-push"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\ncase "$1" in\napi) echo "[[]]";;\npr) echo "[]";;\n*) exit 2;;\nesac\n', { mode: 0o755 });
    const script = fileURLToPath(new URL("./audit-branches.sh", import.meta.url));
    run("bash", script, "--base", "main", "--delete-remote");
    assert.equal(run("git", "ls-remote", "--heads", "origin", "refs/heads/landed"), "");

    // A lookup failure is unknown state, not proof the branch is absent.
    fs.renameSync(remote, remote + ".offline");
    assert.throws(() => run("bash", script, "--base", "main", "--delete-remote"));
    assert.equal(run("git", "rev-parse", "refs/remotes/origin/landed"), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup retains closed, gone, reused, open and checked-out work; deletes proven merged heads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-audit-test-"));
  const repo = path.join(root, "repo"),
    remote = path.join(root, "remote.git"),
    bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: bin + ":" + process.env.PATH,
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "--bare", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    const tips = {};
    for (const branch of [
      "closed",
      "gone",
      "reused",
      "squashed",
      "open",
      "checked-out",
    ]) {
      git("switch", "-c", branch, base);
      fs.writeFileSync(path.join(repo, branch), "unique work\n");
      git("add", branch);
      git("commit", "-m", branch);
      tips[branch] = git("rev-parse", "HEAD");
    }
    git("switch", "main");
    git("merge", "--squash", "squashed");
    git("commit", "-m", "land squash");
    const squash = git("rev-parse", "HEAD");
    git("branch", "landed", base);
    git("config", "branch.gone.remote", "origin");
    git("config", "branch.gone.merge", "refs/heads/missing");
    git("worktree", "add", path.join(root, "occupied"), "checked-out");
    const historyFile = path.join(root, "merged-prs.json");
    fs.writeFileSync(historyFile, JSON.stringify([
      {headRefName: "squashed", headRefOid: tips.squashed, mergeCommit: {oid: squash}},
      {headRefName: "reused", headRefOid: base, mergeCommit: {oid: squash}},
      ...Array.from({length: 998}, (_, index) => ({headRefName: `historic-${index}`, headRefOid: base, mergeCommit: {oid: squash}})),
    ]));
    assert.ok(fs.statSync(historyFile).size > 131072, "realistic 1000-PR history exceeds a single OS argument");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\n[ -z "$FAIL_GH" ] || exit 1\ncase "$1" in\napi) printf '%s\\n' '[[],[{"head":{"ref":"open"}}]]';;\npr) cat '${historyFile}';;\n*) exit 2;;\nesac\n`,
      { mode: 0o755 },
    );
    const script = fileURLToPath(new URL("./audit-branches.sh", import.meta.url));
    assert.throws(() => execFileSync("bash", [script, "--delete"], {
      cwd: repo, env: {...env, FAIL_GH: "1"}, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(git("rev-parse", "landed"), base, "even ancestor branches survive missing ownership evidence");
    execFileSync("bash", [script, "--base", "main", "--delete"], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const remaining = git("branch", "--format=%(refname:short)").split("\n");
    for (const name of ["closed", "gone", "reused", "open", "checked-out"])
      assert.ok(remaining.includes(name), `${name} must be retained`);
    assert.ok(!remaining.includes("squashed"));
    assert.ok(!remaining.includes("landed"));

    // A deletion is still a push: installed hooks must be able to reject it.
    git("push", "origin", `${base}:refs/heads/landed-remote`);
    fs.writeFileSync(
      path.join(repo, ".git/hooks/pre-push"),
      "#!/bin/sh\nexit 17\n",
      { mode: 0o755 },
    );
    assert.throws(() =>
      execFileSync("bash", [script, "--base", "main", "--delete-remote"], {
        cwd: repo,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(
      git("--git-dir", remote, "rev-parse", "refs/heads/landed-remote"),
      base,
    );

    // A concurrent push AND fetch must not replace the audited deletion lease.
    fs.unlinkSync(path.join(repo, ".git/hooks/pre-push"));
    git("push", "origin", `${base}:refs/heads/a-trigger`, `${base}:refs/heads/z-raced`);
    git("push", "origin", "closed"); // Make the unmerged object available remotely.
    fs.writeFileSync(
      path.join(repo, ".git/hooks/pre-push"),
      `#!/bin/sh\nwhile read -r local_ref local_oid remote_ref remote_oid; do\n  if [ "$remote_ref" = refs/heads/a-trigger ]; then\n    git --git-dir '${remote}' update-ref refs/heads/z-raced '${tips.closed}'\n    git update-ref refs/remotes/origin/z-raced '${tips.closed}'\n  fi\ndone\n`,
      { mode: 0o755 },
    );
    assert.throws(() =>
      execFileSync("bash", [script, "--base", "main", "--delete-remote"], {
        cwd: repo,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(
      git("--git-dir", remote, "rev-parse", "refs/heads/z-raced"),
      tips.closed,
      "new unmerged work must survive even if a concurrent fetch refreshes tracking refs",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup abandons only old branches that never had a PR", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-no-pr-test-"));
  const repo = path.join(root, "repo"),
    bin = path.join(root, "bin"),
    prs = path.join(root, "prs");
  for (const dir of [repo, bin, prs]) fs.mkdirSync(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: bin + ":" + process.env.PATH,
  };
  const git = (args, extraEnv = {}) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const old = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["commit", "--allow-empty", "-m", "base"]);
    const branches = {
      "old-no-pr": old,
      "old-closed-pr": old,
      "old-upstream-pr": old,
      "old-occupied": old,
      "old-pushed-elsewhere": old,
      "young-no-pr": undefined,
    };
    for (const [branch, date] of Object.entries(branches)) {
      git(["switch", "-c", branch, "main"]);
      fs.writeFileSync(path.join(repo, branch), "unmerged work\n");
      git(["add", branch]);
      git(["commit", "-m", branch], date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {});
    }
    git(["switch", "main"]);
    // An old commit under a freshly created branch is recent work.
    git(["branch", "fresh-on-old-commit", "old-no-pr"]);
    git(["config", "branch.old-upstream-pr.remote", "origin"]);
    git(["config", "branch.old-upstream-pr.merge", "refs/heads/published-name"]);
    git(["worktree", "add", path.join(root, "occupied"), "old-occupied"]);
    // Pushed under another name with a PR there, with no upstream configured.
    git(["update-ref", "refs/remotes/origin/renamed-on-push", "old-pushed-elsewhere"]);
    // Any PR, in any state, for the branch or its upstream name keeps it.
    for (const name of ["old-closed-pr", "published-name", "renamed-on-push"])
      fs.writeFileSync(path.join(prs, name), "");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
[ -z "$FAIL_HEAD" ] || [ "$3" != --head ] || exit 1
case "$1 $2" in
"api "*) printf '%s\\n' '[[]]';;
"pr list") if [ "$3" = --head ]; then if [ -e '${prs}'/"$4" ]; then echo 1; else echo 0; fi; else echo '[]'; fi;;
*) exit 2;;
esac
`,
      { mode: 0o755 },
    );
    const script = fileURLToPath(new URL("./audit-branches.sh", import.meta.url));
    const run = (args, extraEnv = {}) =>
      execFileSync("bash", [script, ...args], {
        cwd: repo,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const branchesLeft = () => git(["branch", "--format=%(refname:short)"]).split("\n");

    run(["--delete"]);
    assert.ok(branchesLeft().includes("old-no-pr"), "the age rule is opt-in");
    run(["--delete", "--no-pr-days", "3"], { FAIL_HEAD: "1" });
    assert.ok(branchesLeft().includes("old-no-pr"), "a failed PR lookup is not absence");

    const report = run(["--delete", "--no-pr-days", "3"]);
    assert.match(report, /^SAFE\tlocal\told-no-pr\t[0-9a-f]+\tabandoned:no-pr-3d$/m);
    const left = branchesLeft();
    assert.ok(!left.includes("old-no-pr"));
    for (const name of ["old-closed-pr", "old-upstream-pr", "old-pushed-elsewhere", "old-occupied", "young-no-pr", "fresh-on-old-commit"])
      assert.ok(left.includes(name), `${name} must be retained`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup deletes a branch only at its closed PR's exact head, and only on request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-closed-pr-test-"));
  const repo = path.join(root, "repo"),
    remote = path.join(root, "remote.git"),
    bin = path.join(root, "bin");
  for (const dir of [repo, bin]) fs.mkdirSync(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: bin + ":" + process.env.PATH,
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--bare", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "base");
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    const heads = {};
    for (const branch of ["at-closed-head", "moved-after-close", "reopened", "fork-named"]) {
      git("switch", "-c", branch, "main");
      fs.writeFileSync(path.join(repo, branch), "unmerged work\n");
      git("add", branch);
      git("commit", "-m", branch);
      heads[branch] = git("rev-parse", "HEAD");
    }
    // Pushed again after its PR closed: that commit exists only on the branch.
    git("switch", "moved-after-close");
    fs.writeFileSync(path.join(repo, "later"), "later work\n");
    git("add", "later");
    git("commit", "-m", "later");
    git("switch", "main");
    git("push", "origin", "at-closed-head", "moved-after-close", "reopened", "fork-named");
    git("fetch", "origin");
    const closed = JSON.stringify(
      Object.entries(heads).map(([name, oid], number) => ({
        number: number + 1,
        headRefName: name,
        headRefOid: oid,
        // A fork's PR with this branch's name and tip restores into the fork.
        isCrossRepository: name === "fork-named",
      })),
    );
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
case "$1 $2 $3 $4" in
"api "*) printf '%s\\n' '[[{"head":{"ref":"reopened"}}]]';;
"pr list --state closed") [ -z "$FAIL_CLOSED" ] || exit 1; printf '%s\\n' '${closed}';;
"pr list "*) echo '[]';;
*) exit 2;;
esac
`,
      { mode: 0o755 },
    );
    const script = fileURLToPath(new URL("./audit-branches.sh", import.meta.url));
    const run = (args, extraEnv = {}) =>
      execFileSync("bash", [script, ...args], {
        cwd: repo,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const onRemote = () => git("--git-dir", remote, "branch", "--format=%(refname:short)").split("\n");

    run(["--delete-remote"]);
    assert.ok(onRemote().includes("at-closed-head"), "the closed-PR rule is opt-in");
    assert.throws(() => run(["--delete-remote", "--closed-pr-heads"], { FAIL_CLOSED: "1" }));
    assert.ok(onRemote().includes("at-closed-head"), "a failed closed-PR lookup is not recoverability");

    const report = run(["--delete-remote", "--closed-pr-heads"]);
    assert.match(report, /^SAFE\tremote\tat-closed-head\t[0-9a-f]+\trecoverable:closed-pr-1$/m);
    assert.match(report, /^KEEP\tremote\tmoved-after-close\t[0-9a-f]+\tunverified:unmerged$/m);
    assert.match(report, /^KEEP\tremote\treopened\t[0-9a-f]+\topen-pr$/m);
    assert.match(report, /^KEEP\tremote\tfork-named\t[0-9a-f]+\tunverified:unmerged$/m);
    const left = onRemote();
    assert.ok(!left.includes("at-closed-head"));
    for (const name of ["moved-after-close", "reopened", "fork-named"]) assert.ok(left.includes(name), `${name} must be retained`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

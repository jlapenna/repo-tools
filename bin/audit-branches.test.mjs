import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\n[ -z "$FAIL_GH" ] || exit 1\ncase "$1" in\napi) printf '%s\\n' '[[],[{"head":{"ref":"open"}}]]';;\npr) printf '%s\\n' '[{"headRefName":"squashed","headRefOid":"${tips.squashed}","mergeCommit":{"oid":"${squash}"}},{"headRefName":"reused","headRefOid":"${base}","mergeCommit":{"oid":"${squash}"}}]';;\n*) exit 2;;\nesac\n`,
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

#!/usr/bin/env node
// Mint a short-lived GitHub App installation token for a repository.
//
// Interactive agent sessions run `gh` and `git` under the human maintainer's
// credentials, so everything they create -- issues, pull requests, comments,
// labels -- is attributed to that person with nothing marking it as an agent's
// work. This mints the same kind of token CI already uses, so an agent's
// GitHub writes carry the App's bot identity instead.
//
// Nothing durable is stored. The App private key is fetched on demand (usually
// from a secret manager, via GITHUB_APP_PRIVATE_KEY_COMMAND) and the resulting
// installation token lasts an hour, so a host needs no long-lived credential
// on disk and there is nothing to rotate here.
//
// Configuration, all by environment:
//   GITHUB_APP_CLIENT_ID            required; the App's client id (a public value)
//   GITHUB_APP_PRIVATE_KEY          the PEM itself, or
//   GITHUB_APP_PRIVATE_KEY_COMMAND  a shell command that prints the PEM
//   GITHUB_API_BASE                 override the API root (tests, GHES)
//   REPO_TOOLS_TOKEN_CACHE_DIR      override the cache location
//
// Usage:
//   repo-github-app-token [--repo owner/name] [--json] [--refresh]
//
//   GH_TOKEN="$(repo-github-app-token)" gh pr create ...

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// Re-minting on every call would add a round trip to each `git push`, since a
// credential helper invokes this per operation. Reuse a cached token until it
// is close enough to expiry that a slow operation could outlive it.
const RENEW_BEFORE_MS = 5 * 60 * 1000;

function fail(message) {
  process.stderr.write(`repo-github-app-token: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { repo: null, json: false, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      args.repo = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--refresh") {
      args.refresh = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: repo-github-app-token [--repo owner/name] [--json] [--refresh]\n",
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

// `git remote get-url` is the only repository input, so a caller that is not
// inside a checkout must pass --repo rather than get a confusing API error.
function detectRepo() {
  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail('not inside a git repository with an "origin" remote; pass --repo');
  }
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!match) fail(`could not read owner/name from origin url: ${url}`);
  return `${match[1]}/${match[2]}`;
}

function readPrivateKey() {
  const direct = process.env.GITHUB_APP_PRIVATE_KEY;
  if (direct && direct.trim() !== "") return direct;

  const command = process.env.GITHUB_APP_PRIVATE_KEY_COMMAND;
  if (!command) {
    fail(
      "set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_COMMAND (a command that prints the PEM)",
    );
  }
  let value;
  try {
    value = execFileSync("sh", ["-c", command], {
      encoding: "utf8",
      // The key must never reach a log, so the command's own stderr is the
      // only channel that survives; its stdout goes straight into memory.
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    fail("GITHUB_APP_PRIVATE_KEY_COMMAND failed");
  }
  if (value.trim() === "")
    fail("GITHUB_APP_PRIVATE_KEY_COMMAND printed nothing");
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createAppJwt(clientId, privateKey, now = Date.now()) {
  // Backdate to absorb clock skew between this host and GitHub; GitHub
  // rejects a JWT whose iat is in its future.
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: clientId, iat: issuedAt, exp: issuedAt + 600 }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

function cacheDir() {
  const override = process.env.REPO_TOOLS_TOKEN_CACHE_DIR;
  if (override) return override;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && fs.existsSync(runtime) ? runtime : os.tmpdir();
  return path.join(base, "repo-tools-github-app-token");
}

function cachePath(repo) {
  // The repo is attacker-irrelevant but does contain a slash; hash it so the
  // cache stays one flat directory of fixed-width names.
  const digest = crypto.createHash("sha256").update(repo).digest("hex");
  return path.join(cacheDir(), `${digest.slice(0, 32)}.json`);
}

function readCache(repo) {
  try {
    const raw = fs.readFileSync(cachePath(repo), "utf8");
    const entry = JSON.parse(raw);
    if (
      typeof entry?.token !== "string" ||
      typeof entry?.expiresAt !== "string"
    ) {
      return null;
    }
    const remaining = Date.parse(entry.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining < RENEW_BEFORE_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(repo, entry) {
  const file = cachePath(repo);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write private then rename, so a concurrent reader never sees a
    // half-written token and the token is never briefly world-readable.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A token that cannot be cached is still a usable token. Callers get
    // slower mints rather than a failure.
  }
}

async function githubJson(url, { token, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "repo-github-app-token",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed?.message ?? text.slice(0, 200);
    fail(`${method} ${url} failed with ${response.status}: ${detail}`);
  }
  return parsed;
}

async function mint(repo) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId) fail("set GITHUB_APP_CLIENT_ID to the App client id");
  const apiBase = (
    process.env.GITHUB_API_BASE ?? "https://api.github.com"
  ).replace(/\/+$/, "");
  const jwt = createAppJwt(clientId, readPrivateKey());

  // Resolve the installation from the repository rather than taking an
  // installation id as configuration: one App covers several accounts, and a
  // hard-coded id silently mints a token for the wrong one.
  const installation = await githubJson(
    `${apiBase}/repos/${repo}/installation`,
    { token: jwt },
  );
  if (!installation?.id) fail(`no App installation covers ${repo}`);

  const [, name] = repo.split("/");
  const minted = await githubJson(
    `${apiBase}/app/installations/${installation.id}/access_tokens`,
    {
      token: jwt,
      method: "POST",
      // Scope the token to the one repository asked for, so a token minted
      // for a docs change cannot write to every repo in the installation.
      body: { repositories: [name] },
    },
  );
  if (!minted?.token) fail(`installation ${installation.id} returned no token`);
  return { token: minted.token, expiresAt: minted.expires_at, repo };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? detectRepo();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    fail(`expected owner/name, got: ${repo}`);

  let entry = args.refresh ? null : readCache(repo);
  if (!entry) {
    entry = await mint(repo);
    writeCache(repo, entry);
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ repo, expiresAt: entry.expiresAt, token: entry.token })}\n`,
    );
  } else {
    process.stdout.write(`${entry.token}\n`);
  }
}

await main();

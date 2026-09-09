#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$ROOT/bin/github-app-token.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true' EXIT

# A throwaway App key. The mock API verifies the JWT against its public half,
# so a broken signing change fails here rather than only against real GitHub.
node -e '
const {generateKeyPairSync} = require("node:crypto");
const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
require("node:fs").writeFileSync(process.argv[1], privateKey.export({type:"pkcs8",format:"pem"}));
require("node:fs").writeFileSync(process.argv[2], publicKey.export({type:"spki",format:"pem"}));
' "$tmpdir/key.pem" "$tmpdir/key.pub"

requests="$tmpdir/requests.log"
: >"$requests"

cat >"$tmpdir/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const log = process.env.REQUEST_LOG;
const publicKey = fs.readFileSync(process.env.PUBLIC_KEY, 'utf8');
let expiresAt = process.env.EXPIRES_AT;
let counter = 0;

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  fs.appendFileSync(log, `${req.method} ${req.url} ${body}\n`);

  // Every call must present a JWT this App actually signed.
  const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const [header, payload, signature] = jwt.split('.');
  const valid =
    signature &&
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  if (!valid) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'bad jwt' }));
    return;
  }

  if (req.url === '/repos/acme/widgets/installation') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 4242 }));
    return;
  }
  if (req.url === '/app/installations/4242/access_tokens') {
    counter += 1;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: `ghs_minted_${counter}`, expires_at: expiresAt }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'not found' }));
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
});
EOF

start_server() {
  : >"$requests"
  rm -f "$tmpdir/port"
  EXPIRES_AT="$1" REQUEST_LOG="$requests" PUBLIC_KEY="$tmpdir/key.pub" \
    PORT_FILE="$tmpdir/port" node "$tmpdir/server.mjs" &
  server_pid=$!
  for _ in $(seq 1 100); do
    [ -s "$tmpdir/port" ] && break
    sleep 0.05
  done
  [ -s "$tmpdir/port" ] || { echo "FAIL: mock server did not start" >&2; exit 1; }
}

run() {
  GITHUB_APP_CLIENT_ID=Iv1testclientid \
    GITHUB_APP_PRIVATE_KEY_COMMAND="cat $tmpdir/key.pem" \
    GITHUB_API_BASE="http://127.0.0.1:$(cat "$tmpdir/port")" \
    REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache" \
    "$script" --repo acme/widgets "$@"
}

far_future="$(node -e 'console.log(new Date(Date.now()+3600e3).toISOString())')"
start_server "$far_future"

# Mints a token and prints it bare, so `GH_TOKEN="$(...)"` works.
out="$(run)"
[ "$out" = "ghs_minted_1" ] || { echo "FAIL: expected minted token, got '$out'" >&2; exit 1; }

# The token is scoped to the one repository, not the whole installation.
grep -F '"repositories":["widgets"]' "$requests" >/dev/null \
  || { echo "FAIL: token request was not scoped to the repository" >&2; exit 1; }

# A second call reuses the cache instead of paying another round trip --
# a credential helper runs this on every push.
before="$(grep -c access_tokens "$requests")"
out="$(run)"
after="$(grep -c access_tokens "$requests")"
[ "$out" = "ghs_minted_1" ] || { echo "FAIL: cached call returned '$out'" >&2; exit 1; }
[ "$before" = "$after" ] || { echo "FAIL: cached call re-minted" >&2; exit 1; }

# --refresh bypasses the cache.
out="$(run --refresh)"
[ "$out" = "ghs_minted_2" ] || { echo "FAIL: --refresh returned '$out'" >&2; exit 1; }

# The cached token is not readable by other users.
mode="$(find "$tmpdir/cache" -type f -exec stat -c '%a' {} + | sort -u)"
[ "$mode" = "600" ] || { echo "FAIL: cache mode is '$mode', expected 600" >&2; exit 1; }

# --json exposes the expiry so a caller can decide when to re-mint.
node -e '
const parsed = JSON.parse(process.argv[1]);
if (parsed.repo !== "acme/widgets") throw new Error("repo missing from --json");
if (!parsed.token.startsWith("ghs_")) throw new Error("token missing from --json");
if (Number.isNaN(Date.parse(parsed.expiresAt))) throw new Error("expiresAt not a date");
' "$(run --json)"

# Configuration also reaches the command through git config, so it works in a
# shell that never sourced a profile -- an agent's tool shell, which is the
# population this command exists for and the one the environment misses.
cat >"$tmpdir/gitconfig" <<EOF
[repo-tools]
	githubAppClientId = Iv1configclientid
	githubAppPrivateKeyCommand = cat $tmpdir/key.pem
EOF

if ! out="$(env -u GITHUB_APP_CLIENT_ID -u GITHUB_APP_PRIVATE_KEY \
  -u GITHUB_APP_PRIVATE_KEY_COMMAND \
  GIT_CONFIG_GLOBAL="$tmpdir/gitconfig" GIT_CONFIG_SYSTEM=/dev/null \
  GITHUB_API_BASE="http://127.0.0.1:$(cat "$tmpdir/port")" \
  REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache-config" \
  "$script" --repo acme/widgets)"; then
  echo "FAIL: git config alone should be enough to mint" >&2
  exit 1
fi
[ "${out#ghs_minted_}" != "$out" ] \
  || { echo "FAIL: git config mint returned '$out'" >&2; exit 1; }

# The environment still wins where both are set. The git config value here is a
# command that fails, so a mint proves which source was consulted.
cat >"$tmpdir/gitconfig-bad" <<'EOF'
[repo-tools]
	githubAppClientId = Iv1shouldnotbeused
	githubAppPrivateKeyCommand = false
EOF
if ! out="$(GITHUB_APP_CLIENT_ID=Iv1testclientid \
  GITHUB_APP_PRIVATE_KEY_COMMAND="cat $tmpdir/key.pem" \
  GIT_CONFIG_GLOBAL="$tmpdir/gitconfig-bad" GIT_CONFIG_SYSTEM=/dev/null \
  GITHUB_API_BASE="http://127.0.0.1:$(cat "$tmpdir/port")" \
  REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache-env-wins" \
  "$script" --repo acme/widgets)"; then
  echo "FAIL: environment should take precedence over git config" >&2
  exit 1
fi
[ "${out#ghs_minted_}" != "$out" ] \
  || { echo "FAIL: env-precedence mint returned '$out'" >&2; exit 1; }

# A repository cannot supply either value. Repository-local config is
# attacker-shaped input -- a .git directory travels inside a checkout, an
# archive or a build artifact -- and the key command is executed, so reading
# the local scope would make standing in a directory enough to run arbitrary
# code. This is the exploit that shipped in #56, as an assertion.
mkdir -p "$tmpdir/hostile"
(
  cd "$tmpdir/hostile"
  git init -q .
  git config repo-tools.githubAppClientId Iv1attackerclientid
  git config repo-tools.githubAppPrivateKeyCommand "touch $tmpdir/pwned; echo x"
)
(
  cd "$tmpdir/hostile"
  env -u GITHUB_APP_CLIENT_ID -u GITHUB_APP_PRIVATE_KEY \
    -u GITHUB_APP_PRIVATE_KEY_COMMAND \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GITHUB_API_BASE="http://127.0.0.1:$(cat "$tmpdir/port")" \
    REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache-hostile" \
    "$script" --repo acme/widgets >/dev/null 2>&1
) && { echo "FAIL: hostile repository config should not satisfy configuration" >&2; exit 1; }
[ -e "$tmpdir/pwned" ] \
  && { echo "FAIL: repository-local key command was executed" >&2; exit 1; }

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true

# A token already inside the renewal window is re-minted rather than handed out
# close to expiry, where a slow push would fail mid-operation.
start_server "$(node -e 'console.log(new Date(Date.now()+60e3).toISOString())')"
rm -rf "$tmpdir/cache"
run >/dev/null
out="$(run)"
[ "$out" = "ghs_minted_2" ] || { echo "FAIL: near-expiry token was reused, got '$out'" >&2; exit 1; }

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true

# Misconfiguration fails loudly instead of falling back to the human's own
# credentials, which is the whole failure this command exists to prevent.
# `env -u` is load-bearing: a configured host exports GITHUB_APP_* from its
# shell profile, so without it these cases inherit real configuration and stop
# testing the misconfiguration they name. CI has no such profile, so the
# failure only ever appears on the machines that actually use the tool.
# GIT_CONFIG_GLOBAL/SYSTEM are load-bearing for the same reason now that git
# config is a source: a host configured that way would otherwise supply the
# value these cases are asserting is absent.
if env -u GITHUB_APP_CLIENT_ID -u GITHUB_APP_PRIVATE_KEY \
  GITHUB_APP_PRIVATE_KEY_COMMAND="cat $tmpdir/key.pem" \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache2" \
  "$script" --repo acme/widgets >/dev/null 2>"$tmpdir/err"; then
  echo "FAIL: missing GITHUB_APP_CLIENT_ID should exit non-zero" >&2
  exit 1
fi
grep -q GITHUB_APP_CLIENT_ID "$tmpdir/err" \
  || { echo "FAIL: error should name the missing variable" >&2; exit 1; }

if env -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_PRIVATE_KEY_COMMAND \
  GITHUB_APP_CLIENT_ID=Iv1testclientid \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  REPO_TOOLS_TOKEN_CACHE_DIR="$tmpdir/cache2" \
  "$script" --repo acme/widgets >/dev/null 2>"$tmpdir/err2"; then
  echo "FAIL: missing private key should exit non-zero" >&2
  exit 1
fi
grep -q GITHUB_APP_PRIVATE_KEY "$tmpdir/err2" \
  || { echo "FAIL: error should name the private key variables" >&2; exit 1; }

echo "github-app-token: all assertions passed"

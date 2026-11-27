#!/usr/bin/env node
// Runtime-neutral CLI for Hindsight repository memory dreaming: auditing,
// updating contradicted facts against current source, compacting duplicate or
// ephemeral noise and completed initiative pages, evolving durable synthesis
// notes, and reconciling consolidation + knowledge-page refreshes.
//
// Zero external dependencies so it runs identically from an installed package,
// a bundled plugin directory, or a standalone Node checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_TAXONOMY_PAGES = new Set([
  'component map',
  'core concepts',
  'conventions and patterns',
  'key decisions and rationale',
  'initiatives and enhancements',
]);

export const GENERIC_GITLOG_ALIAS_IDS = new Set([
  'gitlog:checkout',
  'gitlog:workspace',
]);

const DEFAULT_CLOUD_API_URL = 'https://api.hindsight.vectorize.io';
const DEFAULT_DAEMON_PORT = 9077;
const VALID_SERVER_MODES = new Set(['cloud', 'self-hosted', 'daemon']);

const VALID_DREAM_KINDS = new Set([
  'correction',
  'evolution',
  'initiative-outcome',
]);

const VALID_KNOWLEDGE_TAGS = new Set([
  'knowledge:component',
  'knowledge:concept',
  'knowledge:convention',
  'knowledge:decision',
  'knowledge:feature-work',
]);

const EPHEMERAL_PATTERNS = [
  /\bsubmitted an approve review\b/i,
  /\bwas approved with 0 findings\b/i,
  /\bcompleted a (?:bugs|guardrails) review .*?\b0 findings\b/i,
  /\bguardrails audit report was sent .*?\b0 findings\b/i,
  /\bsquash auto-merge remains armed\b/i,
  /\barmed squash auto-merge for pr\b/i,
  /\breview verdict:?\s*approve\b.*?\b0 (?:blocking )?(?:findings|defects)\b/i,
];

const DURABLE_SIGNAL_PATTERNS = [
  /\b(?:must|never|always|invariant|because|root cause|contract|policy|deprecated|retired|replaced by)\b/i,
];

class DreamError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function expandHome(inputPath, home = homedir()) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/')) return path.join(home, inputPath.slice(2));
  return inputPath;
}

function redactSecret(text, secret) {
  let out = String(text ?? '');
  if (secret && secret.length >= 6) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1[REDACTED]',
  );
}

function tryGit(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function resolveGitRepositoryInfo(cwd) {
  const resolvedCwd = path.resolve(cwd);
  const topLevel = tryGit(resolvedCwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel) {
    return {
      isGit: false,
      rootDir: resolvedCwd,
      mainCheckoutDir: resolvedCwd,
      gitProject: path.basename(resolvedCwd),
      remoteSlug: '',
    };
  }
  const commonDirRaw = tryGit(resolvedCwd, ['rev-parse', '--git-common-dir']);
  const commonDir = commonDirRaw
    ? path.resolve(resolvedCwd, commonDirRaw)
    : path.join(topLevel, '.git');
  const mainCheckoutDir =
    path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const remoteUrl = tryGit(resolvedCwd, ['config', '--get', 'remote.origin.url']);
  let remoteSlug = '';
  if (remoteUrl) {
    const cleaned = remoteUrl.replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = /[:/]([^/:]+\/[^/:]+)$/.exec(cleaned);
    if (match) remoteSlug = match[1];
  }
  let gitProject = path.basename(mainCheckoutDir).replace(/\.git$/i, '');
  if (
    (gitProject === 'checkout' || gitProject === 'workspace') &&
    remoteSlug.includes('/')
  ) {
    gitProject = remoteSlug.split('/')[1];
  }
  return {
    isGit: true,
    rootDir: topLevel,
    mainCheckoutDir,
    gitProject,
    remoteSlug,
  };
}

function parseEnvBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const norm = String(value).trim().toLowerCase();
  if (norm === 'true' || norm === '1') return true;
  if (norm === 'false' || norm === '0') return false;
  return undefined;
}

function parseApiPort(raw, sourceLabel) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new DreamError(
      `Invalid Hindsight apiPort "${raw}" in ${sourceLabel} (expected integer 1-65535).`,
      2,
    );
  }
  return num;
}

function parseServerMode(raw, sourceLabel) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const norm = String(raw).trim().toLowerCase();
  if (!VALID_SERVER_MODES.has(norm)) {
    throw new DreamError(
      `Invalid Hindsight serverMode "${raw}" in ${sourceLabel} (expected cloud, self-hosted, or daemon).`,
      2,
    );
  }
  return norm;
}

function pathMatchesPrefix(targetPath, rawPrefix, home) {
  const prefix = path.resolve(expandHome(rawPrefix, home));
  if (targetPath === prefix) return { matched: true, length: prefix.length };
  const withSep = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
  if (targetPath.startsWith(withSep)) return { matched: true, length: prefix.length };
  return { matched: false, length: -1 };
}

function normalizeUrl(rawUrl, sourceLabel) {
  const cleaned = String(rawUrl || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`);
    }
    return { url: cleaned, origin: parsed.origin, hostname: parsed.hostname };
  } catch (error) {
    throw new DreamError(
      `Invalid Hindsight apiUrl "${rawUrl}" in ${sourceLabel}: ${error.message}`,
      2,
    );
  }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function resolveHindsightConnection({
  cwd = process.cwd(),
  env = process.env,
  home = env.HOME || homedir(),
  bankOverride,
} = {}) {
  const configPath = expandHome(
    env.HINDSIGHT_CONFIG || path.join(home, '.hindsight', 'coding-agent.json'),
    home,
  );
  let fileCfg = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileCfg = parsed;
      }
    } catch (error) {
      throw new DreamError(
        `Failed to parse Hindsight config at ${configPath}: ${error.message}`,
        2,
      );
    }
  }

  const gitInfo = resolveGitRepositoryInfo(cwd);
  let resolveWorktrees = true;
  const envResolveWorktrees = parseEnvBool(env.HINDSIGHT_RESOLVE_WORKTREES);
  if (envResolveWorktrees !== undefined) resolveWorktrees = envResolveWorktrees;
  if (typeof fileCfg.resolveWorktrees === 'boolean') {
    resolveWorktrees = fileCfg.resolveWorktrees;
  }
  const matchTarget = resolveWorktrees
    ? gitInfo.mainCheckoutDir
    : path.resolve(cwd);

  let mappedBank = '';
  if (fileCfg.mapPathToBank && typeof fileCfg.mapPathToBank === 'object') {
    let bestLen = -1;
    for (const [rawPrefix, targetBank] of Object.entries(fileCfg.mapPathToBank)) {
      if (typeof targetBank !== 'string' || !targetBank) continue;
      const match = pathMatchesPrefix(matchTarget, rawPrefix, home);
      if (match.matched && match.length > bestLen) {
        bestLen = match.length;
        mappedBank = targetBank;
      }
    }
  }

  const template =
    fileCfg.bankIdTemplate ||
    env.HINDSIGHT_BANK_ID_TEMPLATE ||
    'coding-agent::{gitProject}';
  const expandTemplate = (tpl) =>
    String(tpl)
      .replaceAll('{gitProject}', gitInfo.gitProject)
      .replaceAll('{project}', path.basename(path.resolve(cwd)))
      .replaceAll('{channel}', env.HINDSIGHT_CHANNEL_ID || '')
      .replaceAll('{user}', env.HINDSIGHT_USER_ID || '');

  const dynamicBankId =
    typeof fileCfg.dynamicBankId === 'boolean'
      ? fileCfg.dynamicBankId
      : parseEnvBool(env.HINDSIGHT_DYNAMIC_BANK_ID);

  let resolvedBank =
    bankOverride ||
    mappedBank ||
    (dynamicBankId === true
      ? expandTemplate(template)
      : fileCfg.bankId || env.HINDSIGHT_BANK_ID || expandTemplate(template));

  let pathOverrides = {};
  if (fileCfg.paths && typeof fileCfg.paths === 'object') {
    let bestLen = -1;
    for (const [rawPrefix, section] of Object.entries(fileCfg.paths)) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
      const match = pathMatchesPrefix(matchTarget, rawPrefix, home);
      if (match.matched && match.length > bestLen) {
        bestLen = match.length;
        pathOverrides = section;
      }
    }
  }

  const bankSection =
    fileCfg.banks && typeof fileCfg.banks === 'object'
      ? fileCfg.banks[resolvedBank] || {}
      : {};

  // Evaluate disabled across the full precedence chain:
  // defaults < env < file < paths.<prefix> < banks.<resolvedBankId>
  let disabled = false;
  const envDisabled = parseEnvBool(env.HINDSIGHT_DISABLED);
  if (envDisabled !== undefined) disabled = envDisabled;
  if (typeof fileCfg.disabled === 'boolean') disabled = fileCfg.disabled;
  if (typeof pathOverrides.disabled === 'boolean') disabled = pathOverrides.disabled;
  if (typeof bankSection.disabled === 'boolean') disabled = bankSection.disabled;
  if (disabled) {
    throw new DreamError(
      `Hindsight is disabled for "${resolvedBank}" in configuration (${configPath} or HINDSIGHT_DISABLED).`,
      2,
    );
  }

  // Enforce optInOnly / optInPaths fail-closed (paths.<prefix> does not override approval).
  let optInOnly = false;
  const envOptInOnly = parseEnvBool(env.HINDSIGHT_OPT_IN_ONLY);
  if (envOptInOnly !== undefined) optInOnly = envOptInOnly;
  if (typeof fileCfg.optInOnly === 'boolean') optInOnly = fileCfg.optInOnly;
  if (optInOnly) {
    const envOptInPaths = env.HINDSIGHT_OPT_IN_PATHS
      ? String(env.HINDSIGHT_OPT_IN_PATHS)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    const optInPaths = Array.isArray(fileCfg.optInPaths)
      ? fileCfg.optInPaths.filter((entry) => typeof entry === 'string' && entry.trim())
      : envOptInPaths || [];
    const optedInByPath = optInPaths.some(
      (rawPrefix) => pathMatchesPrefix(matchTarget, rawPrefix, home).matched,
    );
    if (!mappedBank && !optedInByPath) {
      throw new DreamError(
        `Hindsight optInOnly is enabled and "${matchTarget}" does not match optInPaths or mapPathToBank.`,
        2,
      );
    }
  }

  if (typeof bankSection.bank === 'string' && bankSection.bank && !bankOverride) {
    resolvedBank = bankSection.bank;
  }

  // Resolve serverMode, apiPort, apiUrl, and apiToken across the same layered precedence
  // without leaking credentials across origins or into local daemon mode.
  const layers = [
    {
      label: 'environment',
      serverMode: parseServerMode(env.HINDSIGHT_SERVER_MODE, 'HINDSIGHT_SERVER_MODE'),
      apiPort: parseApiPort(env.HINDSIGHT_API_PORT, 'HINDSIGHT_API_PORT'),
      apiUrl: env.HINDSIGHT_API_URL ? String(env.HINDSIGHT_API_URL).trim() : undefined,
      apiToken:
        env.HINDSIGHT_API_TOKEN !== undefined && env.HINDSIGHT_API_TOKEN !== ''
          ? String(env.HINDSIGHT_API_TOKEN)
          : undefined,
      isEnvFallback: true,
      isSubSection: false,
    },
    {
      label: configPath,
      serverMode: parseServerMode(fileCfg.serverMode, `${configPath} (serverMode)`),
      apiPort: parseApiPort(fileCfg.apiPort, `${configPath} (apiPort)`),
      apiUrl:
        typeof fileCfg.apiUrl === 'string' && fileCfg.apiUrl.trim()
          ? fileCfg.apiUrl.trim()
          : undefined,
      apiToken: typeof fileCfg.apiToken === 'string' ? fileCfg.apiToken : undefined,
      isEnvFallback: false,
      isSubSection: false,
    },
    {
      label: `${configPath} (paths override)`,
      serverMode: parseServerMode(
        pathOverrides.serverMode,
        `${configPath} (paths.serverMode)`,
      ),
      apiPort: parseApiPort(pathOverrides.apiPort, `${configPath} (paths.apiPort)`),
      apiUrl:
        typeof pathOverrides.apiUrl === 'string' && pathOverrides.apiUrl.trim()
          ? pathOverrides.apiUrl.trim()
          : undefined,
      apiToken:
        typeof pathOverrides.apiToken === 'string'
          ? pathOverrides.apiToken
          : undefined,
      isEnvFallback: false,
      isSubSection: true,
    },
    {
      label: `${configPath} (banks override)`,
      serverMode: parseServerMode(
        bankSection.serverMode,
        `${configPath} (banks.serverMode)`,
      ),
      apiPort: parseApiPort(bankSection.apiPort, `${configPath} (banks.apiPort)`),
      apiUrl:
        typeof bankSection.apiUrl === 'string' && bankSection.apiUrl.trim()
          ? bankSection.apiUrl.trim()
          : undefined,
      apiToken:
        typeof bankSection.apiToken === 'string' ? bankSection.apiToken : undefined,
      isEnvFallback: false,
      isSubSection: true,
    },
  ];

  const defaultCloud = normalizeUrl(DEFAULT_CLOUD_API_URL, 'default');
  let serverMode = 'cloud';
  let apiPort = DEFAULT_DAEMON_PORT;
  let effectiveUrl = defaultCloud.url;
  let effectiveOrigin = defaultCloud.origin;
  let effectiveHostname = defaultCloud.hostname;
  let apiToken = '';
  let tokenBoundToOrigin = false;
  let explicitlyClearedToken = false;
  let endpointOverriddenInSubSection = false;

  for (const layer of layers) {
    const prevOrigin = effectiveOrigin;
    const prevMode = serverMode;
    const hasUrl = layer.apiUrl !== undefined;
    const hasMode = layer.serverMode !== undefined;
    const hasPort = layer.apiPort !== undefined;
    const hasToken = layer.apiToken !== undefined;

    if (hasPort) apiPort = layer.apiPort;
    if (hasMode) serverMode = layer.serverMode;

    if (hasMode && serverMode === 'daemon') {
      const parsed = normalizeUrl(`http://127.0.0.1:${apiPort}`, layer.label);
      effectiveUrl = parsed.url;
      effectiveOrigin = parsed.origin;
      effectiveHostname = parsed.hostname;
    } else if (hasUrl) {
      const parsed = normalizeUrl(layer.apiUrl, layer.label);
      effectiveUrl = parsed.url;
      effectiveOrigin = parsed.origin;
      effectiveHostname = parsed.hostname;
      if (!hasMode) {
        serverMode =
          parsed.origin === defaultCloud.origin ? 'cloud' : 'self-hosted';
      }
    } else if (serverMode === 'daemon' && hasPort) {
      const parsed = normalizeUrl(`http://127.0.0.1:${apiPort}`, layer.label);
      effectiveUrl = parsed.url;
      effectiveOrigin = parsed.origin;
      effectiveHostname = parsed.hostname;
    } else if (
      hasMode &&
      serverMode === 'cloud' &&
      (prevMode !== 'cloud' || effectiveOrigin !== defaultCloud.origin)
    ) {
      effectiveUrl = defaultCloud.url;
      effectiveOrigin = defaultCloud.origin;
      effectiveHostname = defaultCloud.hostname;
    }

    const originChanged = effectiveOrigin !== prevOrigin;
    const switchedToDaemon = serverMode === 'daemon' && prevMode !== 'daemon';

    if (serverMode === 'daemon') {
      apiToken = '';
      tokenBoundToOrigin = false;
    } else if (hasToken) {
      apiToken = layer.apiToken;
      explicitlyClearedToken = layer.apiToken === '';
      tokenBoundToOrigin = !(layer.isEnvFallback && !hasUrl && !hasMode);
    } else if (
      originChanged &&
      (tokenBoundToOrigin || layer.isSubSection)
    ) {
      apiToken = '';
      tokenBoundToOrigin = false;
    }

    if (layer.isSubSection && (originChanged || switchedToDaemon)) {
      endpointOverriddenInSubSection = true;
    }
  }

  const isCloudTarget =
    serverMode === 'cloud' && effectiveOrigin === defaultCloud.origin;

  if (
    !apiToken &&
    !explicitlyClearedToken &&
    serverMode !== 'daemon' &&
    !endpointOverriddenInSubSection
  ) {
    const explicitTokenFile = env.HINDSIGHT_TOKEN_FILE;
    const tokenFile =
      explicitTokenFile ||
      (!isLoopbackHostname(effectiveHostname)
        ? '/run/hindsight/hindsight-api-token'
        : '');
    if (tokenFile && existsSync(tokenFile)) {
      apiToken = readFileSync(tokenFile, 'utf8').replace(/[\r\n]+/g, '');
    }
  }

  if (!apiToken && isCloudTarget) {
    throw new DreamError(
      `No Hindsight API token found for Cloud (${effectiveUrl}) in ${configPath}, HINDSIGHT_API_TOKEN, or HINDSIGHT_TOKEN_FILE.`,
      2,
    );
  }

  return {
    apiUrl: effectiveUrl,
    apiToken,
    serverMode,
    bankId: resolvedBank,
    configPath,
    gitInfo,
  };
}

function createHindsightClient({ apiUrl, apiToken, bankId, timeoutMs = 45000 }) {
  const encodedBank = encodeURIComponent(bankId);
  const bankBase = `/v1/default/banks/${encodedBank}`;

  async function request(method, apiPath, { query, body, allow404 = false } = {}) {
    const url = new URL(`${apiUrl}${apiPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    const headers = {
      Accept: 'application/json',
    };
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
    }
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DreamError(
        `Hindsight ${method} ${apiPath} transport failed: ${redactSecret(error.message, apiToken)}`,
      );
    }
    if (allow404 && response.status === 404) return null;
    const raw = await response.text();
    if (!response.ok) {
      throw new DreamError(
        `Hindsight ${method} ${apiPath} failed (HTTP ${response.status}): ${redactSecret(raw.slice(0, 600), apiToken)}`,
      );
    }
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  return {
    bankBase,
    get: (subPath, opts) => request('GET', `${bankBase}${subPath}`, opts),
    post: (subPath, opts) => request('POST', `${bankBase}${subPath}`, opts),
    patch: (subPath, opts) => request('PATCH', `${bankBase}${subPath}`, opts),
    del: (subPath, opts) => request('DELETE', `${bankBase}${subPath}`, opts),
  };
}

function flattenPageTree(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.kind === 'page' || node.mental_model_id) {
      out.push(node);
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      flattenPageTree(node.children, out);
    }
  }
  return out;
}

export function isCoreTaxonomyPage(name) {
  return CORE_TAXONOMY_PAGES.has(String(name || '').trim().toLowerCase());
}

export function normalizeTokens(text) {
  const cleaned = String(text || '')
    .replace(/REF-ID:\s*\S+/gi, ' ')
    .replace(/\|\s*When:\s*[^|]+/gi, ' ')
    .replace(/\|\s*Involving:\s*[^|]+/gi, ' ')
    .toLowerCase();
  const words = cleaned.match(/[a-z0-9_./#-]{3,}/g) || [];
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'were', 'are',
    'has', 'have', 'had', 'into', 'only', 'when', 'than', 'then', 'also',
    'not', 'its', 'use', 'uses', 'used', 'using', 'via',
  ]);
  return new Set(words.filter((w) => !stop.has(w)));
}

export function tokenJaccard(setA, setB) {
  if (setA.size < 5 || setB.size < 5) return 0;
  let inter = 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const tok of smaller) {
    if (larger.has(tok)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function isEphemeralFact(item) {
  const text = String(item.text || '');
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const matchesRoutine = EPHEMERAL_PATTERNS.some((re) => re.test(text));
  if (!matchesRoutine) return false;
  if (DURABLE_SIGNAL_PATTERNS.some((re) => re.test(text)) && text.length > 260) {
    return false;
  }
  const isReviewOrChat =
    tags.includes('mode:review') ||
    tags.includes('source:chat') ||
    String(item.document_id || '').startsWith('conversation:');
  return isReviewOrChat;
}

const FILE_EXT_RE =
  /\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|sh|ya?ml|json|toml|tf|hcl|md|sql|css|astro)$/i;

export function extractReferencedRepoPaths(text) {
  const matches =
    String(text || '').match(
      /(?:^|[\s`'"(])((?:\.[a-zA-Z0-9_-]+\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9_./-]+)(?=$|[\s`'",.:;)])/g,
    ) || [];
  const paths = new Set();
  for (const raw of matches) {
    const cleaned = raw
      .trim()
      .replace(/^[`'"(]+/, '')
      .replace(/[`'",.:;)]+$/, '');
    if (
      !cleaned ||
      cleaned.startsWith('http') ||
      cleaned.startsWith('//') ||
      cleaned.includes('...') ||
      cleaned.includes('*') ||
      cleaned.startsWith('origin/') ||
      cleaned.startsWith('refs/') ||
      cleaned.startsWith('v1/')
    ) {
      continue;
    }
    const segs = cleaned.split('/');
    if (segs.length === 2 && !FILE_EXT_RE.test(cleaned) && !cleaned.startsWith('.')) {
      // Avoid mistaking GitHub owner/repo slugs or MIME-like pairs for paths.
      continue;
    }
    if (
      FILE_EXT_RE.test(cleaned) ||
      cleaned.startsWith('.github/') ||
      cleaned.startsWith('.lcars/') ||
      cleaned.startsWith('.agents/')
    ) {
      paths.add(cleaned);
    }
  }
  return [...paths];
}

function extractIssueNumbers(text) {
  const nums = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[\s(#])#([1-9][0-9]{0,5})\b/g)) {
    nums.add(Number(m[1]));
  }
  return [...nums];
}

async function fetchPagesOverview(client) {
  const [treeRes, mmRes] = await Promise.all([
    client.get('/pages/tree', { allow404: true }),
    client.get('/mental-models', { query: { limit: 100 } }),
  ]);
  const pageNodes = flattenPageTree(treeRes?.roots || []);
  const pageByMm = new Map();
  for (const node of pageNodes) {
    if (node.mental_model_id) pageByMm.set(node.mental_model_id, node);
  }
  const models = Array.isArray(mmRes?.items) ? mmRes.items : [];
  const enriched = [];
  for (const m of models) {
    const detail = await client.get(`/mental-models/${encodeURIComponent(m.id)}`, {
      allow404: true,
    });
    const pageNode = pageByMm.get(m.id);
    const content = detail?.content || '';
    enriched.push({
      mentalModelId: m.id,
      pageId: pageNode?.id || null,
      name: m.name,
      isCoreTaxonomy: isCoreTaxonomyPage(m.name),
      isPage: Boolean(m.is_page ?? detail?.is_page ?? pageNode),
      tags: m.tags || detail?.tags || [],
      chars: content.length,
      isStale: Boolean(m.is_stale ?? detail?.is_stale),
      lastRefreshedAt: detail?.last_refreshed_at ?? m.last_refreshed_at ?? null,
      lastFullRefreshedAt: detail?.last_full_refreshed_at ?? null,
      lastMemorySeenAt: detail?.last_memory_seen_at ?? null,
      lastRefreshFailedAt:
        detail?.last_refresh_failed_at ?? m.last_refresh_failed_at ?? null,
      triggerMode: detail?.trigger?.mode || null,
      refreshCron: detail?.trigger?.refresh_cron || null,
      sourceQuery: detail?.source_query || m.source_query || '',
      referencedIssues: extractIssueNumbers(
        `${m.name}\n${detail?.source_query || ''}`,
      ),
    });
  }
  return enriched;
}

async function inspectGitlogDocuments(client, canonicalRepoName) {
  const res = await client.get('/documents', {
    query: { q: 'gitlog:', limit: 50 },
  });
  const gitlogs = (res?.items || []).filter((d) =>
    String(d.id || '').startsWith('gitlog:'),
  );
  const canonicalId = `gitlog:${canonicalRepoName}`;
  const hasCanonical = gitlogs.some((d) => d.id === canonicalId);
  const duplicateGitlogs = hasCanonical
    ? gitlogs.filter(
        (d) => d.id !== canonicalId && GENERIC_GITLOG_ALIAS_IDS.has(d.id),
      )
    : [];
  return { canonicalId, hasCanonical, allGitlogs: gitlogs, duplicateGitlogs };
}

async function cmdStatus(conn, client, opts) {
  const [stats, scopes, invalidated, failedCons, pendingCons, pages, gitlogInfo] =
    await Promise.all([
      client.get('/stats'),
      client.get('/observations/scopes', { allow404: true }),
      client.get('/memories/list', { query: { state: 'invalidated', limit: 1 } }),
      client.get('/memories/list', {
        query: { consolidation_state: 'failed', limit: 1 },
      }),
      client.get('/memories/list', {
        query: { consolidation_state: 'pending', limit: 1 },
      }),
      fetchPagesOverview(client),
      inspectGitlogDocuments(client, conn.gitInfo.gitProject),
    ]);

  let selfSessionDoc = null;
  if (opts.sessionId) {
    selfSessionDoc = await client.get(
      `/documents/${encodeURIComponent(`conversation:${opts.sessionId}`)}`,
      { allow404: true },
    );
  }

  const result = {
    bankId: conn.bankId,
    apiUrl: conn.apiUrl,
    repository: {
      gitProject: conn.gitInfo.gitProject,
      remoteSlug: conn.gitInfo.remoteSlug || null,
      rootDir: conn.gitInfo.rootDir,
    },
    stats: {
      totalNodes: stats.total_nodes ?? 0,
      totalDocuments: stats.total_documents ?? 0,
      totalLinks: stats.total_links ?? 0,
      nodesByFactType: stats.nodes_by_fact_type || {},
      totalObservations: stats.total_observations ?? 0,
      invalidatedMemories: invalidated?.total ?? 0,
      pendingConsolidation:
        stats.pending_consolidation ?? pendingCons?.total ?? 0,
      failedConsolidation: stats.failed_consolidation ?? failedCons?.total ?? 0,
      pendingOperations: stats.pending_operations ?? 0,
      failedOperations: stats.failed_operations ?? 0,
      pausedMentalModels: stats.paused_mental_models ?? 0,
      lastConsolidatedAt: stats.last_consolidated_at || null,
      lastMemoryWriteAt: stats.last_memory_write_at || null,
    },
    observationScopes: scopes?.scopes || [],
    gitlogs: {
      canonicalId: gitlogInfo.canonicalId,
      hasCanonical: gitlogInfo.hasCanonical,
      allIds: gitlogInfo.allGitlogs.map((d) => ({
        id: d.id,
        memoryUnitCount: d.memory_unit_count,
        updatedAt: d.updated_at,
      })),
      duplicateIds: gitlogInfo.duplicateGitlogs.map((d) => d.id),
    },
    selfSessionDocument: selfSessionDoc
      ? {
          id: selfSessionDoc.id,
          memoryUnitCount: selfSessionDoc.memory_unit_count,
        }
      : null,
    pages: {
      core: pages.filter((p) => p.isCoreTaxonomy),
      initiatives: pages.filter((p) => !p.isCoreTaxonomy),
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`Bank: ${result.bankId} (${result.apiUrl})`);
  console.log(
    `Nodes: ${result.stats.totalNodes} (world=${result.stats.nodesByFactType.world ?? 0}, experience=${result.stats.nodesByFactType.experience ?? 0}, observation=${result.stats.nodesByFactType.observation ?? 0}, invalidated=${result.stats.invalidatedMemories})`,
  );
  console.log(
    `Documents: ${result.stats.totalDocuments} | Consolidation pending=${result.stats.pendingConsolidation} failed=${result.stats.failedConsolidation} | Paused pages=${result.stats.pausedMentalModels}`,
  );
  if (result.gitlogs.duplicateIds.length > 0) {
    console.log(
      `Duplicate gitlog documents: ${result.gitlogs.duplicateIds.join(', ')} (canonical: ${result.gitlogs.canonicalId}, present=${result.gitlogs.hasCanonical})`,
    );
  }
  console.log(
    `Core pages (${result.pages.core.length}): ` +
      result.pages.core
        .map(
          (p) =>
            `${p.name} [${p.mentalModelId}, ${p.chars}c, stale=${p.isStale}${p.lastRefreshFailedAt ? ', FAILED' : ''}]`,
        )
        .join('; '),
  );
  console.log(`Initiative/extra pages (${result.pages.initiatives.length}):`);
  for (const p of result.pages.initiatives) {
    console.log(
      `  - ${p.name} (mm=${p.mentalModelId}, page=${p.pageId ?? 'none'}, ${p.chars}c, stale=${p.isStale}${p.lastRefreshFailedAt ? `, failed=${p.lastRefreshFailedAt}` : ''})`,
    );
  }
  return 0;
}

async function cmdCandidates(conn, client, opts) {
  const limit = Math.min(Math.max(Number(opts.limit || 250), 20), 1000);
  const days = opts.days !== undefined ? Number(opts.days) : 14;
  const startDate =
    opts.since ||
    (Number.isFinite(days) && days > 0
      ? new Date(Date.now() - days * 86400 * 1000).toISOString()
      : undefined);

  const [worldRes, expRes, pages, gitlogInfo] = await Promise.all([
    client.get('/memories/list', {
      query: {
        type: 'world',
        state: 'valid',
        ...(startDate ? { time_field: 'updated_at', start_date: startDate } : {}),
        limit,
      },
    }),
    client.get('/memories/list', {
      query: {
        type: 'experience',
        state: 'valid',
        ...(startDate ? { time_field: 'updated_at', start_date: startDate } : {}),
        limit,
      },
    }),
    fetchPagesOverview(client),
    inspectGitlogDocuments(client, conn.gitInfo.gitProject),
  ]);

  const rawMemories = [
    ...(worldRes?.items || []),
    ...(expRes?.items || []),
  ].filter(
    (m) =>
      !opts.sessionId || m.document_id !== `conversation:${opts.sessionId}`,
  );

  const ephemeralFacts = [];
  const nearDuplicates = [];
  const verifiableClaims = [];

  const tokenized = rawMemories.map((m) => ({
    item: m,
    tokens: normalizeTokens(m.text),
  }));

  const seenPairs = new Set();
  for (let i = 0; i < tokenized.length; i += 1) {
    const a = tokenized[i];
    if (isEphemeralFact(a.item)) {
      ephemeralFacts.push({
        id: a.item.id,
        factType: a.item.fact_type,
        documentId: a.item.document_id,
        tags: a.item.tags || [],
        text: a.item.text,
      });
    }

    const refs = extractReferencedRepoPaths(a.item.text);
    const issues = extractIssueNumbers(a.item.text);
    if (refs.length > 0 || issues.length > 0) {
      const missingPaths = conn.gitInfo.isGit
        ? refs.filter(
            (rel) => !existsSync(path.join(conn.gitInfo.rootDir, rel)),
          )
        : [];
      if (missingPaths.length > 0 || refs.length > 0) {
        verifiableClaims.push({
          id: a.item.id,
          factType: a.item.fact_type,
          documentId: a.item.document_id,
          proofCount: a.item.proof_count ?? 1,
          updatedAt: a.item.updated_at || a.item.mentioned_at || null,
          referencedPaths: refs,
          missingPaths,
          referencedIssues: issues,
          text: a.item.text,
        });
      }
    }

    for (let j = i + 1; j < tokenized.length; j += 1) {
      const b = tokenized[j];
      const sim = tokenJaccard(a.tokens, b.tokens);
      if (sim >= 0.72) {
        const key = [a.item.id, b.item.id].sort().join(':');
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          nearDuplicates.push({
            similarity: Number(sim.toFixed(3)),
            first: {
              id: a.item.id,
              factType: a.item.fact_type,
              documentId: a.item.document_id,
              proofCount: a.item.proof_count ?? 1,
              updatedAt: a.item.updated_at || null,
              text: a.item.text,
            },
            second: {
              id: b.item.id,
              factType: b.item.fact_type,
              documentId: b.item.document_id,
              proofCount: b.item.proof_count ?? 1,
              updatedAt: b.item.updated_at || null,
              text: b.item.text,
            },
          });
        }
      }
    }
  }

  verifiableClaims.sort(
    (a, b) =>
      b.missingPaths.length - a.missingPaths.length ||
      b.proofCount - a.proofCount,
  );
  nearDuplicates.sort((a, b) => b.similarity - a.similarity);

  const report = {
    bankId: conn.bankId,
    windowStart: startDate || null,
    scannedMemories: rawMemories.length,
    duplicateGitlogs: gitlogInfo.duplicateGitlogs.map((d) => ({
      id: d.id,
      memoryUnitCount: d.memory_unit_count,
      canonicalId: gitlogInfo.canonicalId,
      hasCanonical: gitlogInfo.hasCanonical,
    })),
    ephemeralFacts: ephemeralFacts.slice(0, 60),
    nearDuplicates: nearDuplicates.slice(0, 40),
    claimsWithMissingPaths: verifiableClaims
      .filter((c) => c.missingPaths.length > 0)
      .slice(0, 40),
    verifiablePathClaims: verifiableClaims
      .filter((c) => c.missingPaths.length === 0)
      .slice(0, 40),
    initiativePages: pages.filter((p) => !p.isCoreTaxonomy),
    corePages: pages.filter((p) => p.isCoreTaxonomy),
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(
    `Dream candidates for ${report.bankId} (scanned ${report.scannedMemories} memories since ${report.windowStart || 'beginning'}):`,
  );
  console.log(`- Duplicate gitlog docs: ${report.duplicateGitlogs.length}`);
  console.log(`- Ephemeral review/status facts: ${report.ephemeralFacts.length}`);
  console.log(`- Near-duplicate fact pairs: ${report.nearDuplicates.length}`);
  console.log(
    `- Claims citing missing repo paths: ${report.claimsWithMissingPaths.length}`,
  );
  console.log(
    `- Other verifiable path claims: ${report.verifiablePathClaims.length}`,
  );
  console.log(`- Initiative/extra pages: ${report.initiativePages.length}`);
  for (const c of report.claimsWithMissingPaths.slice(0, 15)) {
    console.log(
      `  [missing-path] ${c.id} missing=${c.missingPaths.join(',')} :: ${c.text.slice(0, 140)}`,
    );
  }
  for (const e of report.ephemeralFacts.slice(0, 15)) {
    console.log(`  [ephemeral] ${e.id} (${e.documentId}) :: ${e.text.slice(0, 140)}`);
  }
  for (const d of report.nearDuplicates.slice(0, 10)) {
    console.log(
      `  [dup sim=${d.similarity}] ${d.first.id} <-> ${d.second.id} :: ${d.first.text.slice(0, 120)}`,
    );
  }
  return 0;
}

async function cmdReadMemory(_conn, client, opts) {
  if (!opts.id) throw new DreamError('read-memory requires --id <memory-id>', 2);
  const mem = await client.get(`/memories/${encodeURIComponent(opts.id)}`);
  console.log(JSON.stringify(mem, null, 2));
  return 0;
}

async function cmdListMemories(_conn, client, opts) {
  const res = await client.get('/memories/list', {
    query: {
      type: opts.type,
      q: opts.q,
      state: opts.state,
      tags: opts.tag ? [opts.tag] : undefined,
      ...(opts.since ? { time_field: 'updated_at', start_date: opts.since } : {}),
      limit: opts.limit || 50,
      offset: opts.offset || 0,
    },
  });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(`Total matching memories: ${res.total ?? 0} (showing ${(res.items || []).length})`);
  for (const item of res.items || []) {
    console.log(
      `- ${item.id} [${item.fact_type}/${item.state}] doc=${item.document_id ?? 'none'} proof=${item.proof_count ?? 1}: ${String(item.text || '').replace(/\s+/g, ' ').slice(0, 180)}`,
    );
  }
  return 0;
}

async function resolvePageOrModel(client, identifier) {
  const pages = await fetchPagesOverview(client);
  const needle = String(identifier || '').trim();
  const lower = needle.toLowerCase();
  const match = pages.find(
    (p) =>
      p.mentalModelId === needle ||
      p.pageId === needle ||
      p.name.trim().toLowerCase() === lower,
  );
  if (!match) {
    throw new DreamError(
      `No page or mental model found matching "${identifier}".`,
      2,
    );
  }
  const detail = await client.get(
    `/mental-models/${encodeURIComponent(match.mentalModelId)}`,
  );
  return { meta: match, detail };
}

async function cmdReadPage(_conn, client, opts) {
  if (!opts.id) throw new DreamError('read-page requires --id <id-or-name>', 2);
  const { meta, detail } = await resolvePageOrModel(client, opts.id);
  const payload = { ...meta, content: detail.content || '' };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  console.log(
    `# ${meta.name} (mm=${meta.mentalModelId}, page=${meta.pageId ?? 'none'}, stale=${meta.isStale}, failed=${meta.lastRefreshFailedAt ?? 'none'})`,
  );
  console.log(`Query: ${meta.sourceQuery}\n`);
  console.log(payload.content);
  return 0;
}

async function cmdInvalidateMemory(_conn, client, opts) {
  if (!opts.id) throw new DreamError('invalidate-memory requires --id <memory-id>', 2);
  const reason = String(opts.reason || '').trim();
  if (!reason) {
    throw new DreamError(
      'invalidate-memory requires a non-empty --reason explaining the verified contradiction, supersession, or compaction target.',
      2,
    );
  }
  const existing = await client.get(`/memories/${encodeURIComponent(opts.id)}`);
  if (existing.fact_type === 'observation') {
    throw new DreamError(
      `Memory ${opts.id} is a derived observation; invalidate or update its raw source memories (${(existing.source_memory_ids || []).join(', ') || 'world/experience'}) instead so Hindsight prunes observations cleanly.`,
      2,
    );
  }
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          action: 'invalidate-memory',
          id: opts.id,
          previousState: existing.state,
          reason,
          text: existing.text,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const updated = await client.patch(`/memories/${encodeURIComponent(opts.id)}`, {
    body: { state: 'invalidated', reason },
  });
  console.log(
    JSON.stringify({
      action: 'invalidate-memory',
      id: opts.id,
      state: 'invalidated',
      reason,
      updated,
    }),
  );
  return 0;
}

async function cmdUpdateMemory(_conn, client, opts) {
  if (!opts.id) throw new DreamError('update-memory requires --id <memory-id>', 2);
  const text = String(opts.text || '').trim();
  if (!text) {
    throw new DreamError('update-memory requires non-empty --text.', 2);
  }
  const existing = await client.get(`/memories/${encodeURIComponent(opts.id)}`);
  if (existing.fact_type === 'observation') {
    throw new DreamError(
      `Memory ${opts.id} is a derived observation; update its raw source memories instead.`,
      2,
    );
  }
  const body = {
    text,
    ...(opts.context !== undefined ? { context: opts.context } : {}),
  };
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          action: 'update-memory',
          id: opts.id,
          before: existing.text,
          after: text,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const updated = await client.patch(`/memories/${encodeURIComponent(opts.id)}`, {
    body,
  });
  console.log(
    JSON.stringify({
      action: 'update-memory',
      id: opts.id,
      updated,
    }),
  );
  return 0;
}

async function cmdRetainDoc(conn, client, opts) {
  const kind = String(opts.kind || '').trim();
  if (!VALID_DREAM_KINDS.has(kind)) {
    throw new DreamError(
      `retain-doc --kind must be one of: ${[...VALID_DREAM_KINDS].join(', ')}`,
      2,
    );
  }
  const slug = String(opts.slug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    throw new DreamError(
      'retain-doc --slug must match ^[a-z0-9][a-z0-9-]{1,79}$ (kebab-case topic slug).',
      2,
    );
  }
  const title = String(opts.title || '').trim();
  if (!title) throw new DreamError('retain-doc requires --title <title>.', 2);

  let bodyText = opts.text;
  if (opts.textFile) {
    bodyText = readFileSync(opts.textFile, 'utf8');
  }
  bodyText = String(bodyText || '').trim();
  if (!bodyText) {
    throw new DreamError(
      'retain-doc requires non-empty --text or --text-file.',
      2,
    );
  }
  if (opts.knowledgeTag && !VALID_KNOWLEDGE_TAGS.has(opts.knowledgeTag)) {
    throw new DreamError(
      `retain-doc --knowledge-tag must be one of: ${[...VALID_KNOWLEDGE_TAGS].join(', ')}`,
      2,
    );
  }

  const documentId = `dream:${kind}:${slug}`;
  const prefix =
    kind === 'correction' && !/^correction:/i.test(title)
      ? `Correction: ${title}`
      : title;
  const content = `# ${prefix}\n\n${bodyText}`;
  const tags = [
    'source:dream',
    `dream:${kind}`,
    ...(conn.gitInfo.remoteSlug ? [`repo:${conn.gitInfo.remoteSlug}`] : []),
    ...(opts.knowledgeTag ? [opts.knowledgeTag] : []),
  ];

  const retainBody = {
    async: false,
    items: [
      {
        document_id: documentId,
        content,
        context: `Verified repository memory ${kind} (${conn.gitInfo.remoteSlug || conn.gitInfo.gitProject})`,
        strategy: 'document',
        update_mode: 'replace',
        observation_scopes: 'shared',
        tags,
        metadata: {
          dream_kind: kind,
          dream_slug: slug,
          repository: conn.gitInfo.remoteSlug || conn.gitInfo.gitProject,
        },
      },
    ],
  };

  if (opts.dryRun) {
    console.log(
      JSON.stringify({ dryRun: true, action: 'retain-doc', documentId, retainBody }, null, 2),
    );
    return 0;
  }

  const res = await client.post('/memories', { body: retainBody });
  console.log(
    JSON.stringify({
      action: 'retain-doc',
      documentId,
      tags,
      result: res,
    }),
  );
  return 0;
}

async function cmdDeleteDoc(conn, client, opts) {
  const docId = String(opts.id || '').trim();
  if (!docId) throw new DreamError('delete-doc requires --id <document-id>.', 2);
  const reason = String(opts.reason || '').trim();
  if (!reason) throw new DreamError('delete-doc requires --reason <text>.', 2);

  const canonicalGitlog = `gitlog:${conn.gitInfo.gitProject}`;
  if (docId === canonicalGitlog) {
    throw new DreamError(
      `Refusing to delete canonical gitlog seed "${canonicalGitlog}".`,
      2,
    );
  }

  const isSelfSession =
    Boolean(opts.sessionId) && docId === `conversation:${opts.sessionId}`;
  const isDreamDoc = docId.startsWith('dream:');
  const isGenericDuplicateGitlog =
    docId !== canonicalGitlog && GENERIC_GITLOG_ALIAS_IDS.has(docId);
  const isAllowedOtherGitlog =
    Boolean(opts.allowOtherGitlog) &&
    docId.startsWith('gitlog:') &&
    docId !== canonicalGitlog;
  const isAllowedEphemeral =
    Boolean(opts.allowEphemeralDoc) && docId.startsWith('conversation:');

  if (
    !isSelfSession &&
    !isDreamDoc &&
    !isGenericDuplicateGitlog &&
    !isAllowedOtherGitlog &&
    !isAllowedEphemeral
  ) {
    throw new DreamError(
      `Refusing to delete document "${docId}": only generic duplicate gitlog aliases (gitlog:checkout, gitlog:workspace — or another non-canonical gitlog:* with --allow-other-gitlog) alongside canonical "${canonicalGitlog}", dream:* notes, self-session transcripts (--session-id), or explicitly confirmed ephemeral conversation:* documents (--allow-ephemeral-doc) may be deleted. Use invalidate-memory for individual stale facts.`,
      2,
    );
  }

  if (isGenericDuplicateGitlog || isAllowedOtherGitlog) {
    const canonical = await client.get(
      `/documents/${encodeURIComponent(canonicalGitlog)}`,
      { allow404: true },
    );
    if (!canonical) {
      throw new DreamError(
        `Refusing to delete "${docId}" while canonical "${canonicalGitlog}" is absent.`,
        2,
      );
    }
  }

  if (opts.dryRun) {
    console.log(
      JSON.stringify({ dryRun: true, action: 'delete-doc', id: docId, reason }, null, 2),
    );
    return 0;
  }

  const res = await client.del(`/documents/${encodeURIComponent(docId)}`, {
    allow404: true,
  });
  console.log(
    JSON.stringify({
      action: 'delete-doc',
      id: docId,
      reason,
      deleted: res !== null,
      result: res,
    }),
  );
  return 0;
}

async function cmdRetirePage(_conn, client, opts) {
  if (!opts.id) throw new DreamError('retire-page requires --id <page-or-mm-id>.', 2);
  const reason = String(opts.reason || '').trim();
  if (!reason) throw new DreamError('retire-page requires --reason <text>.', 2);

  const { meta } = await resolvePageOrModel(client, opts.id);
  if (meta.isCoreTaxonomy) {
    throw new DreamError(
      `Refusing to retire core taxonomy page "${meta.name}" (${meta.mentalModelId}). Core pages are permanent; refresh or evolve their backing facts instead.`,
      2,
    );
  }

  if (opts.dryRun) {
    console.log(
      JSON.stringify({ dryRun: true, action: 'retire-page', page: meta, reason }, null, 2),
    );
    return 0;
  }

  const actions = [];
  if (meta.pageId) {
    await client.del(`/pages/nodes/${encodeURIComponent(meta.pageId)}`, {
      allow404: true,
    });
    actions.push(`deleted page node ${meta.pageId}`);
  }
  await client.del(`/mental-models/${encodeURIComponent(meta.mentalModelId)}`, {
    allow404: true,
  });
  actions.push(`deleted mental model ${meta.mentalModelId}`);

  console.log(
    JSON.stringify({
      action: 'retire-page',
      name: meta.name,
      mentalModelId: meta.mentalModelId,
      pageId: meta.pageId,
      reason,
      steps: actions,
    }),
  );
  return 0;
}

async function waitOperations(client, opIds, deadlineMs) {
  const settled = {};
  const pending = new Set(opIds.filter(Boolean));
  while (pending.size > 0 && Date.now() < deadlineMs) {
    for (const id of [...pending]) {
      const statusRes = await client.get(`/operations/${encodeURIComponent(id)}`, {
        allow404: true,
      });
      const st = statusRes?.status || 'not_found';
      settled[id] = st;
      if (
        st === 'completed' ||
        st === 'failed' ||
        st === 'cancelled' ||
        st === 'not_found'
      ) {
        pending.delete(id);
      }
    }
    if (pending.size > 0 && Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, Math.min(2000, deadlineMs - Date.now())));
    }
  }
  for (const id of pending) {
    settled[id] = settled[id] || 'pending';
  }
  return settled;
}

async function cmdReconcile(_conn, client, opts) {
  const waitSeconds = Math.max(0, Number(opts.waitSeconds ?? 180));
  const maxRefreshes = Math.max(0, Number(opts.maxRefreshes ?? 3));
  const deadlineMs = Date.now() + waitSeconds * 1000;
  const actions = {
    selfSessionDeleted: false,
    recoveredConsolidation: null,
    consolidationOperation: null,
    pageRefreshes: [],
    operationStatuses: {},
  };

  if (opts.sessionId && !opts.dryRun) {
    const selfDocId = `conversation:${opts.sessionId}`;
    const deleted = await client.del(
      `/documents/${encodeURIComponent(selfDocId)}`,
      { allow404: true },
    );
    actions.selfSessionDeleted = deleted !== null;
  }

  const statsBefore = await client.get('/stats');
  if ((statsBefore.failed_consolidation ?? 0) > 0) {
    if (!opts.dryRun) {
      actions.recoveredConsolidation = await client.post(
        '/consolidation/recover',
      );
    } else {
      actions.recoveredConsolidation = { dryRun: true };
    }
  }

  const needsConsolidate =
    Boolean(opts.forceConsolidate) ||
    (statsBefore.pending_consolidation ?? 0) > 0 ||
    (statsBefore.failed_consolidation ?? 0) > 0;

  if (needsConsolidate) {
    if (!opts.dryRun) {
      const cons = await client.post('/consolidate', { body: {} });
      actions.consolidationOperation = cons?.operation_id || null;
      if (actions.consolidationOperation && waitSeconds > 0) {
        const consStatus = await waitOperations(
          client,
          [actions.consolidationOperation],
          deadlineMs,
        );
        Object.assign(actions.operationStatuses, consStatus);
      }
    } else {
      actions.consolidationOperation = 'dry-run';
    }
  }

  const pages = await fetchPagesOverview(client);
  const fullRequested = new Set(opts.fullRefresh || []);
  const refreshQueue = [];

  for (const p of pages) {
    const explicitFull =
      fullRequested.has(p.mentalModelId) ||
      (p.pageId && fullRequested.has(p.pageId)) ||
      fullRequested.has(p.name);
    if (explicitFull) {
      refreshQueue.push({ page: p, mode: 'full', reason: 'explicit' });
    }
  }

  for (const p of pages) {
    if (refreshQueue.some((q) => q.page.mentalModelId === p.mentalModelId)) continue;
    if (p.isCoreTaxonomy && p.lastRefreshFailedAt) {
      refreshQueue.push({ page: p, mode: 'full', reason: 'clear-failed-core' });
    }
  }

  if (opts.refreshStale) {
    for (const p of pages) {
      if (refreshQueue.some((q) => q.page.mentalModelId === p.mentalModelId)) continue;
      if (p.isCoreTaxonomy && p.isStale) {
        refreshQueue.push({ page: p, mode: null, reason: 'stale-core' });
      }
    }
    for (const p of pages) {
      if (refreshQueue.some((q) => q.page.mentalModelId === p.mentalModelId)) continue;
      if (!p.isCoreTaxonomy && (p.isStale || p.lastRefreshFailedAt)) {
        refreshQueue.push({
          page: p,
          mode: p.lastRefreshFailedAt ? 'full' : null,
          reason: p.lastRefreshFailedAt ? 'clear-failed-initiative' : 'stale-initiative',
        });
      }
    }
  }

  const selectedRefreshes = refreshQueue.slice(0, maxRefreshes);
  const refreshOpIds = [];
  for (const item of selectedRefreshes) {
    if (opts.dryRun) {
      actions.pageRefreshes.push({
        mentalModelId: item.page.mentalModelId,
        name: item.page.name,
        mode: item.mode || 'default',
        reason: item.reason,
        operationId: 'dry-run',
      });
      continue;
    }
    const body = item.mode === 'full' ? { mode: 'full' } : {};
    const res = await client.post(
      `/mental-models/${encodeURIComponent(item.page.mentalModelId)}/refresh`,
      { body },
    );
    const opId = res?.operation_id || null;
    if (opId) refreshOpIds.push(opId);
    actions.pageRefreshes.push({
      mentalModelId: item.page.mentalModelId,
      name: item.page.name,
      mode: item.mode || 'default',
      reason: item.reason,
      operationId: opId,
    });
  }

  if (refreshOpIds.length > 0 && Date.now() < deadlineMs) {
    const refreshStatuses = await waitOperations(client, refreshOpIds, deadlineMs);
    Object.assign(actions.operationStatuses, refreshStatuses);
  }

  const statsAfter = opts.dryRun ? statsBefore : await client.get('/stats');
  const output = {
    dryRun: Boolean(opts.dryRun),
    actions,
    statsBefore: {
      totalNodes: statsBefore.total_nodes ?? 0,
      totalObservations: statsBefore.total_observations ?? 0,
      pendingConsolidation: statsBefore.pending_consolidation ?? 0,
      failedConsolidation: statsBefore.failed_consolidation ?? 0,
      pausedMentalModels: statsBefore.paused_mental_models ?? 0,
    },
    statsAfter: {
      totalNodes: statsAfter.total_nodes ?? 0,
      totalObservations: statsAfter.total_observations ?? 0,
      pendingConsolidation: statsAfter.pending_consolidation ?? 0,
      failedConsolidation: statsAfter.failed_consolidation ?? 0,
      pausedMentalModels: statsAfter.paused_mental_models ?? 0,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  return 0;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const opts = {
    cwd: process.cwd(),
    fullRefresh: [],
  };
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case '--cwd':
        opts.cwd = path.resolve(args.shift() || '');
        break;
      case '--bank':
        opts.bank = args.shift();
        break;
      case '--json':
        opts.json = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--since':
        opts.since = args.shift();
        break;
      case '--days':
        opts.days = args.shift();
        break;
      case '--limit':
        opts.limit = args.shift();
        break;
      case '--offset':
        opts.offset = args.shift();
        break;
      case '--id':
        opts.id = args.shift();
        break;
      case '--type':
        opts.type = args.shift();
        break;
      case '--q':
        opts.q = args.shift();
        break;
      case '--state':
        opts.state = args.shift();
        break;
      case '--tag':
        opts.tag = args.shift();
        break;
      case '--reason':
        opts.reason = args.shift();
        break;
      case '--text':
        opts.text = args.shift();
        break;
      case '--text-file':
        opts.textFile = args.shift();
        break;
      case '--context':
        opts.context = args.shift();
        break;
      case '--kind':
        opts.kind = args.shift();
        break;
      case '--slug':
        opts.slug = args.shift();
        break;
      case '--title':
        opts.title = args.shift();
        break;
      case '--knowledge-tag':
        opts.knowledgeTag = args.shift();
        break;
      case '--session-id':
        opts.sessionId = args.shift();
        break;
      case '--allow-ephemeral-doc':
        opts.allowEphemeralDoc = true;
        break;
      case '--allow-other-gitlog':
        opts.allowOtherGitlog = true;
        break;
      case '--refresh-stale':
        opts.refreshStale = true;
        break;
      case '--force-consolidate':
        opts.forceConsolidate = true;
        break;
      case '--full-refresh':
        opts.fullRefresh.push(args.shift());
        break;
      case '--max-refreshes':
        opts.maxRefreshes = args.shift();
        break;
      case '--wait-seconds':
        opts.waitSeconds = args.shift();
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new DreamError(`Unknown argument: ${flag}`, 2);
    }
  }
  return { command, opts };
}

const USAGE = `Usage: repo-hindsight-dream <command> [options]

Commands:
  status              Inspect bank counts, consolidation health, gitlog seeds, and pages
  candidates          Surface duplicate gitlogs, ephemeral noise, near-duplicates, path claims, and initiative pages
  list-memories       Query memories (--type, --q, --state, --tag, --since, --limit, --offset)
  read-memory         Read one memory unit (--id <uuid>)
  read-page           Read one knowledge page / mental model (--id <mm-id|page-id|name>)
  invalidate-memory   Soft-retire a contradicted, duplicate, or ephemeral raw fact (--id <uuid> --reason <text>)
  update-memory       Update a raw fact's text in place (--id <uuid> --text <text> [--context <text>])
  retain-doc          Upsert a deterministic dream synthesis note (--kind <correction|evolution|initiative-outcome> --slug <slug> --title <title> --text <text>|--text-file <path>)
  delete-doc          Delete a duplicate gitlog seed, self-session transcript, or dream note (--id <doc-id> --reason <text>)
  retire-page         Delete a completed, misfiled, or broken non-core initiative page (--id <id> --reason <text>)
  reconcile           Clean self-session doc, recover failed consolidations, consolidate, and refresh pages

Common options:
  --cwd <dir>         Repository directory (default: current working directory)
  --bank <id>         Explicit Hindsight bank override
  --session-id <id>   Current agent session ID so dreaming excludes/cleans its own transcript
  --dry-run           Preview mutations without writing to Hindsight
  --json              Emit structured JSON output
`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return error.exitCode || 2;
  }
  const { command, opts } = parsed;
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    opts.help
  ) {
    console.log(USAGE);
    return command || opts.help ? 0 : 2;
  }

  let conn;
  try {
    conn = resolveHindsightConnection({
      cwd: opts.cwd,
      env,
      bankOverride: opts.bank,
    });
    const client = createHindsightClient(conn);
    switch (command) {
      case 'status':
        return await cmdStatus(conn, client, opts);
      case 'candidates':
        return await cmdCandidates(conn, client, opts);
      case 'list-memories':
        return await cmdListMemories(conn, client, opts);
      case 'read-memory':
        return await cmdReadMemory(conn, client, opts);
      case 'read-page':
        return await cmdReadPage(conn, client, opts);
      case 'invalidate-memory':
        return await cmdInvalidateMemory(conn, client, opts);
      case 'update-memory':
        return await cmdUpdateMemory(conn, client, opts);
      case 'retain-doc':
        return await cmdRetainDoc(conn, client, opts);
      case 'delete-doc':
        return await cmdDeleteDoc(conn, client, opts);
      case 'retire-page':
        return await cmdRetirePage(conn, client, opts);
      case 'reconcile':
        return await cmdReconcile(conn, client, opts);
      default:
        throw new DreamError(`Unknown subcommand: ${command}`, 2);
    }
  } catch (error) {
    const safeMsg = redactSecret(error.message || String(error), conn?.apiToken);
    console.error(`repo-hindsight-dream: ${safeMsg}`);
    return error.exitCode || 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

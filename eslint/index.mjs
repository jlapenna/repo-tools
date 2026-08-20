// eslint/src/fleet-baseline.mjs
var FLEET_RESTRICTED_SYNTAX = Object.freeze([
  {
    selector: "CallExpression[callee.name='require']",
    message: "Using require() is not allowed. Use ES static imports instead."
  },
  {
    selector: "ImportExpression",
    message: "Dynamic import() is not allowed. Use ES static imports instead."
  },
  {
    selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]",
    message: "Bare toLocale*String() depends on the runtime locale/timezone and causes hydration mismatches (React #418). Pin them, e.g. toLocaleDateString('en-US', { timeZone: 'UTC' })."
  },
  {
    selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='Identifier'][arguments.0.name='undefined']",
    message: "toLocale*String(undefined, \u2026) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale, e.g. 'en-US', and include a timeZone."
  },
  {
    selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='ArrayExpression'][arguments.0.elements.length=0]",
    message: "toLocale*String([], \u2026) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale, e.g. 'en-US', and include a timeZone."
  }
]);
var FLEET_UNUSED_VARS_OPTIONS = Object.freeze({
  args: "all",
  argsIgnorePattern: "^_",
  caughtErrors: "all",
  caughtErrorsIgnorePattern: "^_",
  destructuredArrayIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  ignoreRestSiblings: true
});
var SCRIPT_FILES = ["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"];
function fleetBaseline({ simpleImportSort, unusedImports }) {
  if (!simpleImportSort || !unusedImports) {
    throw new Error(
      "fleetBaseline() needs both the simple-import-sort and unused-imports plugin objects."
    );
  }
  return [
    {
      files: SCRIPT_FILES,
      plugins: {
        "simple-import-sort": simpleImportSort,
        "unused-imports": unusedImports
      },
      rules: {
        // `error`, not `warn`, on every one of these: a warning in a
        // repo whose lint task does not pass --max-warnings=0 is a rule
        // that never fails anything, and the two repos disagreed on which
        // half was which.
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
        // Superseded by unused-imports/no-unused-vars below, which reports
        // the same violations with an auto-fix for the import case.
        "@typescript-eslint/no-unused-vars": "off",
        "unused-imports/no-unused-imports": "error",
        "unused-imports/no-unused-vars": ["error", FLEET_UNUSED_VARS_OPTIONS],
        "no-restricted-syntax": ["error", ...FLEET_RESTRICTED_SYNTAX]
      }
    },
    {
      // A .cjs file is CommonJS by extension: require() is its only import
      // mechanism and dynamic import() its only way to reach an ESM module,
      // so the syntax bans are unsatisfiable ceremony there. Import-order
      // and unused-symbol hygiene above still apply. Both repos already
      // exempted .cjs this way (one explicitly, one by never globbing it),
      // avoiding unnecessary eslint-disable comments in consumer code.
      files: ["**/*.cjs"],
      rules: {
        "no-restricted-syntax": "off"
      }
    }
  ];
}

// eslint/src/rules/no-server-only-imports-in-client.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJson,
  readCachedProjectGraph,
  workspaceRoot as nxWorkspaceRoot
} from "@nx/devkit";
import { ESLintUtils } from "@typescript-eslint/utils";
var DEFAULT_WORKSPACE_ROOT = nxWorkspaceRoot;
var RULE_URL = fileURLToPath(import.meta.url);
var SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
];
var SAFE_SUBPATHS = /* @__PURE__ */ new Set(["browser", "client", "schema", "ui"]);
var IGNORED_DISCOVERY_DIRECTORIES = /* @__PURE__ */ new Set([
  "coverage",
  "dist",
  "node_modules",
  "tmp"
]);
function isMissingFileError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function readJsonIfExists(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return void 0;
    throw new Error(`Unable to read workspace configuration ${filePath}`, {
      cause: error
    });
  }
  try {
    return parseJson(source);
  } catch (error) {
    throw new Error(`Unable to parse workspace configuration ${filePath}`, {
      cause: error
    });
  }
}
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new Error(`Unable to inspect workspace configuration ${filePath}`, {
      cause: error
    });
  }
}
function resolveModuleFile(candidate) {
  const candidates = [candidate];
  const extension = path.extname(candidate);
  if (!extension) {
    candidates.push(
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) => candidate + sourceExtension
      )
    );
    candidates.push(
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) => path.join(candidate, `index${sourceExtension}`)
      )
    );
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const withoutExtension = candidate.slice(0, -extension.length);
    candidates.push(
      ...[".ts", ".tsx", ".mts", ".cts"].map(
        (sourceExtension) => withoutExtension + sourceExtension
      )
    );
  }
  for (const filePath of candidates) {
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`Unable to inspect workspace module ${filePath}`, {
          cause: error
        });
      }
    }
  }
  return void 0;
}
function hasServerOnlyMarker(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to inspect workspace module ${filePath}`, {
      cause: error
    });
  }
  return /(?:^|\n)\s*import\s+['"]server-only['"]\s*;?/.test(source) || /(?:^|\n)\s*assertNotBrowser\s*\(\s*\)\s*;?\s*(?:\n|$)/.test(source);
}
function isInside(parent, candidate) {
  const relative2 = path.relative(parent, candidate);
  return relative2 === "" || !relative2.startsWith("..") && !path.isAbsolute(relative2);
}
function discoverConfigurationDirectories(workspaceRoot) {
  const directories = /* @__PURE__ */ new Set();
  const stack = [workspaceRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect workspace directory ${directory}`, {
        cause: error
      });
    }
    if (directory !== workspaceRoot && entries.some(
      (entry) => entry.isFile() && (entry.name === "project.json" || entry.name === "package.json" || entry.name === "tsconfig.json")
    )) {
      directories.add(directory);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)) {
        continue;
      }
      stack.push(path.join(directory, entry.name));
    }
  }
  return [...directories];
}
function projectsFromFilesystem(workspaceRoot) {
  return discoverConfigurationDirectories(workspaceRoot).map((root) => {
    const project = readJsonIfExists(
      path.join(root, "project.json")
    );
    const packageJson = readJsonIfExists(
      path.join(root, "package.json")
    );
    const configuredRoot = project?.root ? path.resolve(workspaceRoot, project.root) : root;
    return {
      name: project?.name ?? packageJson?.name,
      root: configuredRoot,
      sourceRoot: project?.sourceRoot ? path.resolve(workspaceRoot, project.sourceRoot) : path.join(configuredRoot, "src"),
      tags: /* @__PURE__ */ new Set([
        ...packageJson?.nx?.tags ?? [],
        ...project?.tags ?? []
      ])
    };
  });
}
function discoverProjects(workspaceRoot) {
  if (path.resolve(workspaceRoot) === path.resolve(DEFAULT_WORKSPACE_ROOT)) {
    try {
      const graph = readCachedProjectGraph();
      return Object.values(graph.nodes).map((node) => ({
        name: node.name,
        root: path.resolve(workspaceRoot, node.data.root),
        sourceRoot: path.resolve(
          workspaceRoot,
          node.data.sourceRoot ?? node.data.root
        ),
        tags: new Set(node.data.tags ?? [])
      }));
    } catch {
    }
  }
  return projectsFromFilesystem(workspaceRoot);
}
function pathMappingsFromConfig(configPath, scopeRoot) {
  const config = readJsonIfExists(configPath);
  if (!config) return [];
  const rawPaths = config.compilerOptions?.paths;
  if (!rawPaths) return [];
  const baseDirectory = path.resolve(
    path.dirname(configPath),
    config.compilerOptions?.baseUrl ?? "."
  );
  return Object.entries(rawPaths).map(([alias, rawTargets]) => {
    if (!Array.isArray(rawTargets) || rawTargets.length === 0 || rawTargets.some((target) => typeof target !== "string")) {
      throw new Error(
        `Invalid tsconfig path mapping for ${alias} in ${configPath}`
      );
    }
    return {
      alias,
      baseDirectory,
      configPath,
      scopeRoot,
      targets: rawTargets
    };
  });
}
function discoverPathMappings(workspaceRoot, projects) {
  const baseConfig = path.join(workspaceRoot, "tsconfig.base.json");
  const rootConfig = fileExists(baseConfig) ? baseConfig : path.join(workspaceRoot, "tsconfig.json");
  const mappings = pathMappingsFromConfig(rootConfig, workspaceRoot);
  const seenConfigs = /* @__PURE__ */ new Set([rootConfig]);
  for (const project of projects) {
    const configPath = path.join(project.root, "tsconfig.json");
    if (seenConfigs.has(configPath)) continue;
    seenConfigs.add(configPath);
    mappings.push(...pathMappingsFromConfig(configPath, project.root));
  }
  return mappings;
}
function matchAlias(alias, source) {
  const star = alias.indexOf("*");
  if (star === -1) return source === alias ? "" : void 0;
  const prefix = alias.slice(0, star);
  const suffix = alias.slice(star + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return void 0;
  return source.slice(prefix.length, source.length - suffix.length);
}
function mappingRank(mapping) {
  return [
    mapping.scopeRoot.length,
    mapping.alias.includes("*") ? 0 : 1,
    mapping.alias.replaceAll("*", "").length
  ];
}
function compareRank(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
function resolveAlias(mappings, source, filename) {
  const matching = mappings.map((mapping) => ({
    mapping,
    wildcard: matchAlias(mapping.alias, source)
  })).filter(
    (candidate) => candidate.wildcard !== void 0 && isInside(candidate.mapping.scopeRoot, filename)
  );
  if (matching.length === 0) return { kind: "no-match" };
  const bestRank = matching.reduce(
    (best, candidate) => {
      const rank = mappingRank(candidate.mapping);
      return compareRank(rank, best) > 0 ? rank : best;
    },
    [0, 0, 0]
  );
  const bestMatches = matching.filter(
    (candidate) => compareRank(mappingRank(candidate.mapping), bestRank) === 0
  );
  for (const { mapping, wildcard } of bestMatches) {
    for (const target of mapping.targets) {
      const expanded = target.split("*").join(wildcard ?? "");
      const resolved = resolveModuleFile(
        path.resolve(mapping.baseDirectory, expanded)
      );
      if (resolved) return { kind: "resolved", filePath: resolved, mapping };
    }
  }
  const configs = [
    ...new Set(bestMatches.map(({ mapping }) => mapping.configPath))
  ].join(", ");
  return {
    kind: "unresolved",
    detail: `matches a workspace tsconfig alias, but its configured targets cannot be resolved (${configs})`
  };
}
function projectForPath(projects, filePath) {
  return projects.filter((project) => isInside(project.root, filePath)).sort((left, right) => right.root.length - left.root.length)[0];
}
function aliasPrefix(alias) {
  return alias.slice(0, alias.indexOf("*") === -1 ? void 0 : alias.indexOf("*")).replace(/\/$/u, "");
}
function addServerPrefix(prefixes, prefix) {
  const existing = prefixes.get(prefix.prefix);
  if (!existing) {
    prefixes.set(prefix.prefix, prefix);
    return;
  }
  if (existing.safeSubpathsRequireExplicitAlias && !prefix.safeSubpathsRequireExplicitAlias) {
    prefixes.set(prefix.prefix, prefix);
  }
}
function concreteMappingTarget(mapping) {
  if (mapping.alias.includes("*")) return void 0;
  for (const target of mapping.targets) {
    const resolved = resolveModuleFile(
      path.resolve(mapping.baseDirectory, target)
    );
    if (resolved) return resolved;
  }
  return void 0;
}
function discoverWorkspaceBoundaries(workspaceRoot) {
  const projects = discoverProjects(workspaceRoot);
  const mappings = discoverPathMappings(workspaceRoot, projects);
  const prefixes = /* @__PURE__ */ new Map();
  const exactAliases = new Set(
    mappings.filter((mapping) => !mapping.alias.includes("*")).map((mapping) => mapping.alias)
  );
  for (const project of projects) {
    if (!project.name) continue;
    const hasExplicitEnvironmentSplit = exactAliases.has(`${project.name}/server`) && (exactAliases.has(`${project.name}/browser`) || exactAliases.has(`${project.name}/client`));
    if (!project.tags.has("platform:server") && !hasExplicitEnvironmentSplit) {
      continue;
    }
    addServerPrefix(prefixes, {
      prefix: project.name,
      project,
      entryDirectory: project.sourceRoot,
      safeSubpathsRequireExplicitAlias: true
    });
  }
  for (const mapping of mappings) {
    const target = concreteMappingTarget(mapping);
    if (!target) continue;
    const project = projectForPath(projects, target);
    const isExplicitServerAlias = project?.name !== void 0 && mapping.alias === `${project.name}/server`;
    if (!isExplicitServerAlias && !hasServerOnlyMarker(target)) continue;
    const prefix = aliasPrefix(mapping.alias);
    addServerPrefix(prefixes, {
      prefix,
      project,
      entryDirectory: path.dirname(target),
      safeSubpathsRequireExplicitAlias: project?.name === prefix
    });
  }
  return {
    mappings,
    projects,
    serverPrefixes: [...prefixes.values()].sort(
      (left, right) => right.prefix.length - left.prefix.length
    )
  };
}
function hasUseClientDirective(programBody) {
  for (const node of programBody) {
    if (node.type !== "ExpressionStatement" || node.expression.type !== "Literal" || typeof node.expression.value !== "string") {
      return false;
    }
    if (node.expression.value === "use client") return true;
  }
  return false;
}
function isTypeOnly(node) {
  if (node.type === "ImportDeclaration" && node.importKind === "type") {
    return true;
  }
  if (node.type !== "ImportDeclaration" && node.exportKind === "type") {
    return true;
  }
  if (!("specifiers" in node)) return false;
  const { specifiers } = node;
  return specifiers.length > 0 && specifiers.every(
    (specifier) => "importKind" in specifier && specifier.importKind === "type" || "exportKind" in specifier && specifier.exportKind === "type"
  );
}
function firstPackageSubpath(source, packageName) {
  return source.slice(packageName.length + 1).split("/")[0];
}
function matchingServerPrefix(prefixes, source) {
  return prefixes.find(
    ({ prefix }) => source === prefix || source.startsWith(`${prefix}/`)
  );
}
function resolveServerSubpath(boundary, source) {
  if (source === boundary.prefix) {
    return resolveModuleFile(boundary.entryDirectory);
  }
  const subpath = source.slice(boundary.prefix.length + 1);
  return resolveModuleFile(path.join(boundary.entryDirectory, subpath));
}
var RULE_NAME = "no-server-only-imports-in-client";
function createRule(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const boundaries = discoverWorkspaceBoundaries(workspaceRoot);
  const markerCache = /* @__PURE__ */ new Map();
  function targetHasMarker(target) {
    if (!markerCache.has(target)) {
      markerCache.set(target, hasServerOnlyMarker(target));
    }
    return markerCache.get(target) ?? false;
  }
  function decideImport(source, filename) {
    if (source === "server-only") return { kind: "server-only" };
    const aliasResolution = resolveAlias(boundaries.mappings, source, filename);
    if (aliasResolution.kind === "unresolved") {
      return { kind: "configuration-error", detail: aliasResolution.detail };
    }
    let target = aliasResolution.kind === "resolved" ? aliasResolution.filePath : void 0;
    const serverBoundary = matchingServerPrefix(
      boundaries.serverPrefixes,
      source
    );
    if (serverBoundary) {
      if (!target) target = resolveServerSubpath(serverBoundary, source);
      if (!target) {
        return {
          kind: "configuration-error",
          detail: `matches server workspace project ${serverBoundary.prefix}, but its entry point cannot be resolved`
        };
      }
      if (targetHasMarker(target)) return { kind: "server-only" };
      if (source !== serverBoundary.prefix) {
        const firstSubpath = firstPackageSubpath(source, serverBoundary.prefix);
        if (SAFE_SUBPATHS.has(firstSubpath)) {
          return serverBoundary.safeSubpathsRequireExplicitAlias && aliasResolution.kind === "resolved" ? { kind: "safe" } : { kind: "server-only" };
        }
      }
      return { kind: "server-only" };
    }
    if (target) {
      if (targetHasMarker(target)) return { kind: "server-only" };
      const targetProject = projectForPath(boundaries.projects, target);
      if (targetProject?.tags.has("platform:server")) {
        return { kind: "server-only" };
      }
      return { kind: "safe" };
    }
    if (source.startsWith("@/")) {
      const sourceRootIndex = filename.lastIndexOf(`${path.sep}src${path.sep}`);
      if (sourceRootIndex === -1) {
        return {
          kind: "configuration-error",
          detail: "uses the app-local @/ alias outside a discoverable source root"
        };
      }
      const sourceRoot = filename.slice(0, sourceRootIndex + 5);
      target = resolveModuleFile(path.join(sourceRoot, source.slice(2)));
      if (!target) {
        return {
          kind: "configuration-error",
          detail: "uses the app-local @/ alias, but its target cannot be resolved"
        };
      }
      return targetHasMarker(target) ? { kind: "server-only" } : { kind: "safe" };
    }
    if (source.startsWith(".")) {
      target = resolveModuleFile(path.resolve(path.dirname(filename), source));
      if (target && targetHasMarker(target)) return { kind: "server-only" };
    }
    return { kind: "safe" };
  }
  return ESLintUtils.RuleCreator(() => RULE_URL)({
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description: "Disallow value imports of server-only modules in 'use client' files."
      },
      messages: {
        configurationError: "Workspace import '{{source}}' {{detail}}. Fix the Nx/tsconfig boundary configuration; unresolved workspace imports are not assumed browser-safe.",
        serverOnlyImport: "'{{source}}' is server-only and cannot enter a 'use client' module graph. Use `import type` for erased types, an explicit browser/client entry point, or move the server work behind a Server Component or Server Function."
      },
      schema: []
    },
    defaultOptions: [],
    create(context) {
      const { ast } = context.sourceCode;
      if (!hasUseClientDirective(ast.body)) return {};
      function check(node, sourceNode) {
        if (!sourceNode || typeof sourceNode.value !== "string") return;
        if (node && isTypeOnly(node)) return;
        const decision = decideImport(sourceNode.value, context.filename);
        if (decision.kind === "safe") return;
        if (decision.kind === "configuration-error") {
          context.report({
            node: sourceNode,
            messageId: "configurationError",
            data: { source: sourceNode.value, detail: decision.detail }
          });
          return;
        }
        context.report({
          node: sourceNode,
          messageId: "serverOnlyImport",
          data: { source: sourceNode.value }
        });
      }
      return {
        ImportDeclaration(node) {
          check(node, node.source);
        },
        ExportNamedDeclaration(node) {
          check(node, node.source);
        },
        ExportAllDeclaration(node) {
          check(node, node.source);
        },
        ImportExpression(node) {
          if (node.source.type === "Literal") check(void 0, node.source);
        }
      };
    }
  });
}
var rule = createRule();

// eslint/src/rules/use-server-actions-only.ts
import * as path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import {
  AST_NODE_TYPES,
  ESLintUtils as ESLintUtils2
} from "@typescript-eslint/utils";
var RULE_NAME2 = "use-server-actions-only";
var RULE_URL2 = fileURLToPath2(import.meta.url);
function useServerDirective(body) {
  for (const statement of body) {
    if (statement.type !== AST_NODE_TYPES.ExpressionStatement || statement.expression.type !== AST_NODE_TYPES.Literal || typeof statement.expression.value !== "string") {
      return void 0;
    }
    if (statement.expression.value === "use server") return statement;
  }
  return void 0;
}
function isActionModule(filename) {
  const basename2 = path2.basename(filename).toLowerCase();
  return /actions?\.[cm]?[jt]sx?$/.test(basename2) && !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(basename2);
}
function isTypeOnlyDeclaration(declaration) {
  return declaration.type === AST_NODE_TYPES.TSInterfaceDeclaration || declaration.type === AST_NODE_TYPES.TSTypeAliasDeclaration;
}
function isAsyncFunction(node) {
  return node !== null && (node.type === AST_NODE_TYPES.ArrowFunctionExpression || node.type === AST_NODE_TYPES.FunctionDeclaration || node.type === AST_NODE_TYPES.FunctionExpression) && node.async;
}
var rule2 = ESLintUtils2.RuleCreator(() => RULE_URL2)({
  name: RULE_NAME2,
  meta: {
    type: "problem",
    docs: {
      description: "Reserve file-level 'use server' for dedicated Server Function action modules."
    },
    messages: {
      asyncExportsOnly: "A file-level 'use server' directive makes every runtime export a Server Function. Export async functions directly, or move constants and helpers to an ordinary `server-only` module.",
      misplacedDirective: "File-level 'use server' is reserved for dedicated `*-action.ts`/`actions.ts` Server Function modules. Pages, layouts, and Server Components need no directive; ordinary server modules should import `server-only`.",
      noServerFunctions: "This 'use server' action module does not export an async Server Function."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(program) {
        const directive = useServerDirective(program.body);
        if (!directive) return;
        if (!isActionModule(context.filename)) {
          context.report({ node: directive, messageId: "misplacedDirective" });
          return;
        }
        let serverFunctionCount = 0;
        const reportInvalidExport = (node) => {
          context.report({ node, messageId: "asyncExportsOnly" });
        };
        for (const statement of program.body) {
          if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
            if (statement.exportKind === "type") continue;
            const { declaration } = statement;
            if (!declaration) {
              const runtimeSpecifiers = statement.specifiers.filter(
                (specifier) => specifier.exportKind !== "type"
              );
              runtimeSpecifiers.forEach(reportInvalidExport);
              continue;
            }
            if (isTypeOnlyDeclaration(declaration)) continue;
            if (declaration.type === AST_NODE_TYPES.FunctionDeclaration) {
              if (isAsyncFunction(declaration)) serverFunctionCount += 1;
              else reportInvalidExport(declaration);
              continue;
            }
            if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
              for (const variable of declaration.declarations) {
                if (isAsyncFunction(variable.init)) serverFunctionCount += 1;
                else reportInvalidExport(variable);
              }
              continue;
            }
            reportInvalidExport(declaration);
            continue;
          }
          if (statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
            if (isAsyncFunction(statement.declaration))
              serverFunctionCount += 1;
            else reportInvalidExport(statement.declaration);
            continue;
          }
          if (statement.type === AST_NODE_TYPES.ExportAllDeclaration && statement.exportKind !== "type") {
            reportInvalidExport(statement);
          }
        }
        if (serverFunctionCount === 0) {
          context.report({ node: directive, messageId: "noServerFunctions" });
        }
      }
    };
  }
});

// eslint/src/index.ts
var fleetEslintPlugin = Object.freeze({
  rules: {
    [RULE_NAME]: rule,
    [RULE_NAME2]: rule2
  }
});
export {
  FLEET_RESTRICTED_SYNTAX,
  FLEET_UNUSED_VARS_OPTIONS,
  fleetBaseline,
  fleetEslintPlugin,
  RULE_NAME as noServerOnlyImportsInClientName,
  RULE_NAME2 as useServerActionsOnlyName
};

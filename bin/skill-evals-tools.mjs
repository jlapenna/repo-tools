// Shared read-only skill and fixture tools for native harness adapters.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const schema = (key) => ({
  type: "object",
  properties: { [key]: { type: "string" } },
  required: [key],
  additionalProperties: false,
});
export const TOOLS = [
  {
    type: "function",
    name: "Skill",
    description:
      "Load an available skill by its exact name and follow its instructions.",
    inputSchema: schema("skill"),
  },
  {
    type: "function",
    name: "Read",
    description:
      "Read a skill reference or eval fixture by path. Read-only; no other files are available.",
    inputSchema: schema("path"),
  },
  {
    type: "function",
    name: "Glob",
    description: "List available skill and fixture paths matching a glob.",
    inputSchema: schema("pattern"),
  },
  {
    type: "function",
    name: "Grep",
    description:
      "Search available skill references and fixtures for literal text.",
    inputSchema: schema("pattern"),
  },
];
function filesBelow(root) {
  if (!existsSync(root)) return [];
  const base = realpathSync(root),
    out = [];
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "evals"].includes(e.name)) continue;
      const p = path.join(dir, e.name),
        real = realpathSync(p);
      if (real !== base && !real.startsWith(base + path.sep))
        throw Error("Eval file escapes its allowed root");
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
      else throw Error("Eval files must be regular files or directories");
      if (out.length > 10000) throw Error("Too many eval fixture files");
    }
  }
  walk(base);
  return out;
}
export function readTools(
  plugin,
  caseDir,
  allowed = ["Skill", "Read", "Glob", "Grep"],
  { skills: withSkills = true } = {},
) {
  if (allowed.some((t) => !TOOLS.some((x) => x.name === t)))
    throw Error(
      "Skill evals support read-only Skill, Read, Glob and Grep tools only",
    );
  // The without-skill arm of an ablation sees only the case fixtures: no skill
  // catalog, files or Skill tool, so the same prompt measures the bare model.
  if (!withSkills && allowed.includes("Skill"))
    throw Error("The without-skill arm cannot offer the Skill tool");
  const available = [
    ...(withSkills ? filesBelow(path.join(plugin, "skills")) : []),
    ...filesBelow(path.join(caseDir, "resources")),
  ];
  const permitted = new Set(available.map((p) => realpathSync(p)));
  const aliases = new Map(available.map(p => [p.startsWith(path.join(plugin, 'skills')+path.sep) ? path.relative(plugin,p) : path.relative(caseDir,p),p]));
  let loadedSkill;
  const scope = () => {
    const names = [...aliases].filter(([alias, file]) => alias.startsWith('resources'+path.sep) || !loadedSkill || file.startsWith(path.dirname(loadedSkill.path)+path.sep)).map(([alias]) => alias);
    return `Available copied files for this skill and case:\n${names.slice(0,200).join('\n').slice(0,8192)}\n${names.length > 200 ? 'Use Glob to list further copied files.\n' : ''}The source repository checkout and live services are not supplied. If a referenced file is unavailable, describe the inspection as a plan using the supplied guidance.`;
  };
  const skills = new Map();
  const skillRoot = path.join(plugin, "skills");
  for (const p of available.filter((p) => p.startsWith(skillRoot+path.sep) && path.relative(skillRoot,p).split(path.sep).length === 2 && path.basename(p) === "SKILL.md")) {
    const text = readFileSync(p, "utf8"),
      m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text),
      metadata = m ? parse(m[1]) : {};
    skills.set(path.basename(path.dirname(p)), {
      path: p,
      description: String(metadata.description ?? ""),
      manualOnly: ["true", "yes", "on", "1"].includes(String(metadata["disable-model-invocation"] ?? "").toLowerCase()),
    });
  }
  const read = (p) => {
    const source = path.isAbsolute(p) ? p : aliases.get(p) ?? path.resolve(loadedSkill ? path.dirname(loadedSkill.path) : caseDir, p);
    let real;
    try { real = realpathSync(source); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      throw Error(`File is not supplied by this isolated eval.\n${scope()}`);
    }
    if (!permitted.has(real))
      throw Error("File is outside the eval skills and fixtures");
    const text = readFileSync(real, "utf8");
    if (Buffer.byteLength(text) > 65536) throw Error("Eval file exceeds 64KiB");
    return text;
  };
  return {
    catalog: [...skills]
      .filter(([, s]) => !s.manualOnly)
      .map(([name, s]) => `${name}: ${s.description}`)
      .join("\n"),
    definitions: TOOLS.filter((t) => allowed.includes(t.name)),
    call(name, args) {
      if (!allowed.includes(name))
        throw Error("Tool is not allowed by this eval case");
      if (name === "Skill") {
        const skill = skills.get(args.skill);
        if (!skill) throw Error("Unknown skill");
        loadedSkill = skill;
        return `Base directory: ${path.relative(plugin,path.dirname(skill.path))}\n\n${read(skill.path)}\n\n${scope()}`;
      }
      if (name === "Read") return read(args.path);
      if (typeof args.pattern !== "string" || args.pattern.length > 256)
        throw Error("Invalid search pattern");
      if (name === "Glob")
        return [...aliases].filter(([alias,file]) => path.matchesGlob(alias,args.pattern) || (loadedSkill && file.startsWith(path.dirname(loadedSkill.path)+path.sep) && path.matchesGlob(path.relative(path.dirname(loadedSkill.path),file),args.pattern))).slice(0,200).map(([alias])=>alias).join('\n');
      if (name === "Grep")
        return available
          .flatMap((p) =>
            read(p)
              .split("\n")
              .map((line, i) =>
                line.includes(args.pattern) ? `${p}:${i + 1}:${line}` : null,
              )
              .filter(Boolean),
          )
          .slice(0, 100)
          .join("\n")
          .slice(0, 65536);
      throw Error("Unknown tool");
    },
  };
}


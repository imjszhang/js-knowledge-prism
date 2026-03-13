/**
 * Output generation — the final pipeline stage.
 * Reads perspective (SCQA + Key Lines) + source materials (journal, groups),
 * applies a prompt template, calls LLM, and writes output files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { createHttpCaller } from "./process.mjs";
import {
  heading,
  listMdFiles,
  log as defaultLog,
  makePaths,
  parseKeyLineTable,
  read,
  stripCodeFences,
  warn as defaultWarn,
} from "./utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_TEMPLATES_DIR = join(__dirname, "..", "templates", "outputs", "prompts");
const BUILTIN_COMPONENTS_DIR = join(__dirname, "..", "templates", "outputs", "components");
const BUILTIN_TYPES_DIR = join(__dirname, "..", "templates", "outputs", "types");

// ---------------------------------------------------------------------------
// Include resolution — composable prompt components
// ---------------------------------------------------------------------------

/**
 * Resolve {{@include path}} directives in template text.
 * Lookup order: local components dir (knowledge-base), then builtin components.
 */
function resolveIncludes(text, localComponentsDir, maxDepth = 5) {
  if (maxDepth <= 0 || !text.includes("{{@include")) return text;
  return text.replace(/\{\{@include\s+([^}]+)\}\}/g, (match, rawPath) => {
    const p = rawPath.trim();
    if (localComponentsDir) {
      const localPath = join(localComponentsDir, p);
      if (existsSync(localPath)) {
        return resolveIncludes(readFileSync(localPath, "utf-8").trimEnd(), localComponentsDir, maxDepth - 1);
      }
    }
    const builtinPath = join(BUILTIN_COMPONENTS_DIR, p);
    if (existsSync(builtinPath)) {
      return resolveIncludes(readFileSync(builtinPath, "utf-8").trimEnd(), localComponentsDir, maxDepth - 1);
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// Output types — structural contracts for output categories
// ---------------------------------------------------------------------------

/**
 * Load a type definition by name.
 * Lookup: local types dir, then builtin types dir.
 */
export function loadType(typeName, baseDir) {
  const localTypesDir = join(baseDir, "outputs", "_templates", "types");
  const localPath = join(localTypesDir, `${typeName}.md`);
  if (existsSync(localPath)) {
    const { meta, body } = parseFrontmatter(readFileSync(localPath, "utf-8"));
    return { ...meta, body, path: localPath };
  }
  const builtinPath = join(BUILTIN_TYPES_DIR, `${typeName}.md`);
  if (existsSync(builtinPath)) {
    const { meta, body } = parseFrontmatter(readFileSync(builtinPath, "utf-8"));
    return { ...meta, body, path: builtinPath };
  }
  return null;
}

export function listTypes(baseDir) {
  const types = [];
  const seen = new Set();
  const isMd = (f) => f.endsWith(".md") && !f.startsWith("_");

  const localDir = join(baseDir, "outputs", "_templates", "types");
  if (existsSync(localDir)) {
    for (const f of readdirSync(localDir).filter(isMd)) {
      const name = f.replace(/\.md$/, "");
      types.push({ name, source: "local", path: join(localDir, f) });
      seen.add(name);
    }
  }

  if (existsSync(BUILTIN_TYPES_DIR)) {
    for (const f of readdirSync(BUILTIN_TYPES_DIR).filter(isMd)) {
      const name = f.replace(/\.md$/, "");
      if (!seen.has(name)) {
        types.push({ name, source: "builtin", path: join(BUILTIN_TYPES_DIR, f) });
      }
    }
  }

  return types;
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w][\w-]*):\s*(.+)$/);
    if (kv) {
      const val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[kv[1]] = val.slice(1, -1).split(",").map((s) => s.trim());
      } else if (val === "true" || val === "false") {
        meta[kv[1]] = val === "true";
      } else {
        meta[kv[1]] = val;
      }
    }
  }
  return { meta, body: m[2] };
}

function parseTemplateSections(body) {
  const sectionEnd = "\\n# (?:Unit Prompt|Skeleton Template|Review Prompt|Stage:)";
  const systemMatch = body.match(new RegExp(`# System Prompt\\s*\\n([\\s\\S]*?)(?=${sectionEnd}|$)`));
  const unitMatch = body.match(/# Unit Prompt\s*\n([\s\S]*?)(?=\n# (?:Skeleton Template|Review Prompt|Stage:)|$)/);
  const skeletonMatch = body.match(/# Skeleton Template\s*\n([\s\S]*?)(?=\n# (?:Review Prompt|Stage:)|$)/);
  const reviewMatch = body.match(/# Review Prompt\s*\n([\s\S]*?)(?=\n# Stage:|$)/);
  let skeletonBody = "";
  if (skeletonMatch) {
    const fenced = skeletonMatch[1].match(/```\s*\n([\s\S]*?)\n```/);
    skeletonBody = fenced ? fenced[1].trim() : skeletonMatch[1].trim();
  }

  const stageSections = {};
  const stagePattern = /# Stage:\s*(\S+)\s*\n([\s\S]*?)(?=\n# Stage:|\n# Review Prompt|$)/g;
  let sm;
  while ((sm = stagePattern.exec(body)) !== null) {
    stageSections[sm[1].trim()] = sm[2].trim();
  }

  return {
    systemPrompt: systemMatch ? systemMatch[1].trim() : "",
    unitPrompt: unitMatch ? unitMatch[1].trim() : "",
    skeletonTemplate: skeletonBody,
    reviewPrompt: reviewMatch ? reviewMatch[1].trim() : "",
    stageSections,
  };
}

export function loadTemplate(templateName, baseDir) {
  const localDir = join(baseDir, "outputs", "_templates");
  const localComponentsDir = join(localDir, "components");

  function loadFromPath(filePath) {
    const content = read(filePath);
    const { meta, body } = parseFrontmatter(content);
    const resolved = resolveIncludes(body, localComponentsDir);
    const sections = parseTemplateSections(resolved);
    let result = { ...meta, ...sections, path: filePath };

    if (meta.type) {
      const typeDef = loadType(meta.type, baseDir);
      if (typeDef) {
        const typeDefaults = { ...typeDef };
        delete typeDefaults.body;
        delete typeDefaults.path;
        result = { ...typeDefaults, ...result, typeDef };
      }
    }

    return result;
  }

  const localPath = join(localDir, `${templateName}.md`);
  if (existsSync(localPath)) return loadFromPath(localPath);

  const builtinPath = join(BUILTIN_TEMPLATES_DIR, `${templateName}.md`);
  if (existsSync(builtinPath)) return loadFromPath(builtinPath);

  return null;
}

export function listTemplates(baseDir) {
  const templates = [];
  const seen = new Set();
  const isMd = (f) => f.endsWith(".md") && !f.startsWith("_");

  const localDir = join(baseDir, "outputs", "_templates");
  if (existsSync(localDir)) {
    for (const f of readdirSync(localDir).filter(isMd)) {
      const name = f.replace(/\.md$/, "");
      templates.push({ name, source: "local", path: join(localDir, f) });
      seen.add(name);
    }
  }

  if (existsSync(BUILTIN_TEMPLATES_DIR)) {
    for (const f of readdirSync(BUILTIN_TEMPLATES_DIR).filter(isMd)) {
      const name = f.replace(/\.md$/, "");
      if (!seen.has(name)) {
        templates.push({ name, source: "builtin", path: join(BUILTIN_TEMPLATES_DIR, f) });
      }
    }
  }

  return templates;
}

// ---------------------------------------------------------------------------
// KL file parsing — extract journal and group references
// ---------------------------------------------------------------------------

export function parseKlContent(content) {
  const supportPoints = [];
  const journalRefs = [];
  const groupRefs = new Set();

  const journalPattern = /来源 journal[：:]\s*\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = journalPattern.exec(content)) !== null) {
    journalRefs.push({ name: m[1], relativePath: m[2] });
  }

  const groupPattern = /引用 groups[：:]\s*(.+)/g;
  while ((m = groupPattern.exec(content)) !== null) {
    for (const g of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      groupRefs.add(g);
    }
  }

  const spPattern = /^### (\d+\.\d+)[：:]\s*(.+)$/gm;
  while ((m = spPattern.exec(content)) !== null) {
    supportPoints.push({ id: m[1], thesis: m[2] });
  }

  return { supportPoints, journalRefs, groupRefs: [...groupRefs] };
}

// ---------------------------------------------------------------------------
// Source material resolution
// ---------------------------------------------------------------------------

function findGroupFile(groupsDir, g) {
  const exact = g.startsWith("G") ? `${g}.md` : `G${g.padStart(2, "0")}.md`;
  const exactPath = join(groupsDir, exact);
  if (existsSync(exactPath)) return exactPath;
  const prefix = g.startsWith("G") ? g : `G${g.padStart(2, "0")}`;
  const files = readdirSync(groupsDir).filter(
    (f) => f.startsWith(prefix + "-") && f.endsWith(".md"),
  );
  return files.length > 0 ? join(groupsDir, files[0]) : null;
}

/**
 * Build a mapping of group ID → actual filename for link post-processing.
 */
function buildGroupFilenameMap(groupsDir) {
  const map = new Map();
  if (!existsSync(groupsDir)) return map;
  for (const f of readdirSync(groupsDir)) {
    const m = f.match(/^(G\d+)/);
    if (m && f.endsWith(".md")) map.set(m[1], f);
  }
  return map;
}

function resolveJournalContent(klFilePath, journalRefs) {
  const contents = [];
  const klDir = dirname(klFilePath);

  for (const ref of journalRefs) {
    const absPath = resolve(klDir, ref.relativePath);
    if (existsSync(absPath)) {
      contents.push(`### ${ref.name}\n\n${readFileSync(absPath, "utf-8")}`);
    }
  }
  return contents;
}

/**
 * Fallback: if no journal refs found in KL file, try to find journals by date
 * directory (journal/YYYY-MM-DD/*.md).
 */
function resolveJournalByDate(journalDir, date) {
  const dateDir = join(journalDir, date);
  if (!existsSync(dateDir)) return [];
  const contents = [];
  for (const f of listMdFiles(dateDir)) {
    contents.push(`### ${f}\n\n${readFileSync(join(dateDir, f), "utf-8")}`);
  }
  return contents;
}

function resolveGroupContent(groupsDir, groupRefs) {
  const contents = [];
  for (const g of groupRefs) {
    const p = findGroupFile(groupsDir, g);
    if (p) {
      contents.push(`### ${g}\n\n${readFileSync(p, "utf-8")}`);
    }
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Post-processing: fix links in LLM output
// ---------------------------------------------------------------------------

/**
 * Fix structural links that LLM may have generated with wrong slugs.
 * - Group links: [Gxx](path/Gxx-wrong-slug.md) → correct actual filename
 * - KL links: [KLnn](path/KLnn-wrong.md) → correct actual filename
 * - Perspective dir: any remaining {{perspective_dir}} → actual value
 */
function fixOutputLinks(content, { groupFileMap, klFileMap, perspectiveDir, relToBase }) {
  let fixed = content;

  // Fix {{perspective_dir}} remnants
  fixed = fixed.replaceAll("{{perspective_dir}}", perspectiveDir);

  // Fix Group links: [Gxx](any-path/groups/Gxx-anything.md)
  fixed = fixed.replace(
    /\[(G\d+)\]\([^)]*\/groups\/G\d+[^)]*\.md\)/g,
    (match, gId) => {
      const actualFile = groupFileMap.get(gId);
      if (actualFile) return `[${gId}](${relToBase}/pyramid/analysis/groups/${actualFile})`;
      return match;
    },
  );

  // Fix standalone Group links without path: [Gxx](Gxx-anything.md)
  fixed = fixed.replace(
    /\[(G\d+)\]\(G\d+[^)]*\.md\)/g,
    (match, gId) => {
      const actualFile = groupFileMap.get(gId);
      if (actualFile) return `[${gId}](${relToBase}/pyramid/analysis/groups/${actualFile})`;
      return match;
    },
  );

  // Fix KL links: [KLnn](any-path/tree/KLnn-anything.md)
  fixed = fixed.replace(
    /\[(KL\d+)\]\([^)]*\/tree\/(KL\d+[^)]*\.md)\)/g,
    (match, klId, _klFile) => {
      const actualFile = klFileMap.get(klId);
      if (actualFile) {
        return `[${klId}](${relToBase}/pyramid/structure/${perspectiveDir}/tree/${actualFile})`;
      }
      return match;
    },
  );

  return fixed;
}

// ---------------------------------------------------------------------------
// Output file naming
// ---------------------------------------------------------------------------

function generateFilename(kl, template) {
  const naming = template.fileNaming || "sequence";

  switch (naming) {
    case "date": {
      if (kl.date) return `${kl.date}.md`;
      const dateMatch = kl.thesis.match(/\d{4}-\d{2}-\d{2}/);
      if (dateMatch) return `${dateMatch[0]}.md`;
      return `${kl.klId}.md`;
    }

    case "slug": {
      const slug = kl.thesis
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 50);
      return `${slug}.md`;
    }

    case "sequence":
    default: {
      const num = kl.klId.replace(/^KL/, "").padStart(2, "0");
      return `${num}.md`;
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildPrompt(unitPromptTemplate, vars) {
  let prompt = unitPromptTemplate;
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Run log — persist full prompt/response for tuning
// ---------------------------------------------------------------------------

function writeRunLog(logDir, entry) {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const prefix = entry.klId || "unknown";
  const filename = `${prefix}-${ts}.json`;
  writeFileSync(join(logDir, filename), JSON.stringify(entry, null, 2) + "\n", "utf-8");
  return filename;
}

// ---------------------------------------------------------------------------
// Ref-based content loading (for skeleton fill phase)
// ---------------------------------------------------------------------------

function readRefFile(baseDir, relPath) {
  if (!relPath) return "";
  const absPath = join(baseDir, relPath);
  if (!existsSync(absPath)) return "";
  return readFileSync(absPath, "utf-8");
}

function readRefFiles(baseDir, relPaths) {
  const contents = [];
  for (const p of relPaths) {
    const text = readRefFile(baseDir, p);
    if (text) {
      const name = p.split(/[/\\]/).pop();
      contents.push(`### ${name}\n\n${text}`);
    }
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Skeleton: reference path resolution (returns paths, not contents)
// ---------------------------------------------------------------------------

function resolveJournalPaths(klFilePath, journalRefs, journalDir, date) {
  const klDir = dirname(klFilePath);
  const paths = [];
  for (const ref of journalRefs) {
    const absPath = resolve(klDir, ref.relativePath);
    if (existsSync(absPath)) paths.push(absPath);
  }
  if (paths.length === 0 && date) {
    const dateDir = join(journalDir, date);
    if (existsSync(dateDir)) {
      for (const f of listMdFiles(dateDir)) {
        paths.push(join(dateDir, f));
      }
    }
  }
  return paths;
}

function resolveGroupPaths(groupsDir, groupRefs) {
  const paths = [];
  for (const g of groupRefs) {
    const p = findGroupFile(groupsDir, g);
    if (p) paths.push(p);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Skeleton frontmatter serialization (simple YAML subset)
// ---------------------------------------------------------------------------

function serializeSkeletonFrontmatter(meta) {
  const lines = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "object" && !Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const [k2, v2] of Object.entries(val)) {
        if (Array.isArray(v2)) {
          lines.push(`  ${k2}:`);
          for (const item of v2) lines.push(`    - ${item}`);
        } else {
          lines.push(`  ${k2}: ${v2}`);
        }
      }
    } else if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val) lines.push(`  - ${item}`);
    } else if (typeof val === "boolean") {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Skeleton frontmatter parsing (supports nested YAML used in refs)
// ---------------------------------------------------------------------------

function parseSkeletonFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const topKv = lines[i].match(/^([\w][\w-]*):\s*(.+)$/);
    if (topKv) {
      const val = topKv[2].trim();
      if (val === "true" || val === "false") {
        meta[topKv[1]] = val === "true";
      } else {
        meta[topKv[1]] = val;
      }
      i++;
      continue;
    }
    const topObj = lines[i].match(/^([\w][\w-]*):\s*$/);
    if (topObj) {
      const key = topObj[1];
      const sub = {};
      i++;
      while (i < lines.length && /^\s{2}\S/.test(lines[i])) {
        const subArr = lines[i].match(/^\s{2}([\w][\w-]*):\s*$/);
        if (subArr) {
          const arrKey = subArr[1];
          const items = [];
          i++;
          while (i < lines.length && /^\s{4}-\s/.test(lines[i])) {
            items.push(lines[i].replace(/^\s{4}-\s*/, "").trim());
            i++;
          }
          sub[arrKey] = items;
          continue;
        }
        const subKv = lines[i].match(/^\s{2}([\w][\w-]*):\s*(.+)$/);
        if (subKv) {
          sub[subKv[1]] = subKv[2].trim();
          i++;
          continue;
        }
        const subItem = lines[i].match(/^\s{2}-\s*(.+)$/);
        if (subItem) {
          if (!Array.isArray(meta[key])) meta[key] = [];
          meta[key].push(subItem[1].trim());
          i++;
          continue;
        }
        break;
      }
      if (Object.keys(sub).length > 0) meta[key] = sub;
      continue;
    }
    i++;
  }
  return { meta, body: m[2] };
}

// ---------------------------------------------------------------------------
// Skeleton generation
// ---------------------------------------------------------------------------

/**
 * Generate skeleton files for a perspective + template combination.
 * Skeletons contain verified reference paths and placeholder sections.
 *
 * @returns {{ success: boolean, message: string, results: Array, warnings: string[] }}
 */
export function generateSkeleton({
  baseDir,
  perspectiveDir,
  template: templateName,
  outputDir: outputDirOverride,
  klFilter,
  force = false,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const perspPath = join(paths.structureDir, perspectiveDir);

  if (!existsSync(perspPath)) {
    return { success: false, message: `视角目录不存在: ${perspectiveDir}` };
  }

  const template = loadTemplate(templateName, baseDir);
  if (!template) {
    return { success: false, message: `模板 "${templateName}" 未找到` };
  }
  if (!template.skeletonTemplate) {
    return { success: false, message: `模板 "${templateName}" 未定义 Skeleton Template 区段` };
  }

  const treePath = join(perspPath, "tree", "README.md");
  if (!existsSync(treePath)) {
    return { success: false, message: "tree/README.md 不存在" };
  }

  const treeContent = read(treePath);
  const keyLines = parseKeyLineTable(treeContent);
  if (keyLines.length === 0) {
    return { success: false, message: "未在 tree/README.md 中找到 Key Line" };
  }

  const scqaPath = join(perspPath, "scqa.md");
  const groupFileMap = buildGroupFilenameMap(paths.groupsDir);

  const outputDir = outputDirOverride || join(paths.outputsDir, templateName, perspectiveDir);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const relToBase = relative(outputDir, baseDir).replace(/\\/g, "/") || ".";
  const perspIdMatch = perspectiveDir.match(/^(P\d+)/);
  const perspectiveId = perspIdMatch ? perspIdMatch[1] : perspectiveDir;

  heading("Skeleton 生成");
  log(`模板: ${templateName}, 视角: ${perspectiveDir}`);
  const results = [];
  const warnings = [];

  function checkPath(absPath, label) {
    if (!existsSync(absPath)) {
      warnings.push(`${label}: ${relative(baseDir, absPath)}（路径不存在）`);
      return false;
    }
    return true;
  }

  const klsToProcess = klFilter
    ? keyLines.filter((kl) => klFilter.includes(kl.klId))
    : keyLines;

  log(`共 ${klsToProcess.length} 个 Key Line\n`);

  for (let i = 0; i < klsToProcess.length; i++) {
    const kl = klsToProcess[i];
    const outFilename = generateFilename(kl, template);
    const outPath = join(outputDir, outFilename);

    if (existsSync(outPath) && !force) {
      const existing = readFileSync(outPath, "utf-8");
      if (!existing.includes("（待生成）") && !existing.includes("（待")) {
        log(`[${i + 1}/${klsToProcess.length}] 跳过 ${outFilename}（已完成）`);
        results.push({ klId: kl.klId, file: outFilename, status: "skipped" });
        continue;
      }
    }

    const klFilePath = join(perspPath, "tree", kl.filename);
    const klContent = existsSync(klFilePath) ? read(klFilePath) : "";
    const parsed = parseKlContent(klContent);
    const allGroupRefs = [...new Set([...parsed.groupRefs, ...kl.groups])];

    const journalAbsPaths = resolveJournalPaths(klFilePath, parsed.journalRefs, paths.journalDir, kl.date);
    const groupAbsPaths = resolveGroupPaths(paths.groupsDir, allGroupRefs);

    checkPath(klFilePath, `${kl.klId} KL文件`);
    const scqaExists = existsSync(scqaPath);
    if (!scqaExists) warnings.push(`SCQA 文件不存在: scqa.md`);

    const refs = {
      kl: relative(baseDir, klFilePath).replace(/\\/g, "/"),
      scqa: scqaExists ? relative(baseDir, scqaPath).replace(/\\/g, "/") : null,
      journal: journalAbsPaths.map((p) => relative(baseDir, p).replace(/\\/g, "/")),
      groups: groupAbsPaths.map((p) => relative(baseDir, p).replace(/\\/g, "/")),
    };

    const klLink = `${relToBase}/pyramid/structure/${perspectiveDir}/tree/${kl.filename}`;
    const perspLink = `${relToBase}/pyramid/structure/${perspectiveDir}/`;

    const groupLinks = allGroupRefs
      .map((g) => {
        const actual = groupFileMap.get(g);
        return actual
          ? `[${g}](${relToBase}/pyramid/analysis/groups/${actual})`
          : `${g}（文件不存在）`;
      })
      .join(" · ");

    const refsSummaryLines = [];
    refsSummaryLines.push(`- KL 骨架: [${kl.filename}](${klLink})`);
    if (scqaExists) {
      refsSummaryLines.push(`- SCQA: [scqa.md](${relToBase}/pyramid/structure/${perspectiveDir}/scqa.md)`);
    }
    if (journalAbsPaths.length > 0) {
      const jLinks = journalAbsPaths.map((p) => {
        const rel = relative(outputDir, p).replace(/\\/g, "/");
        const name = p.split(/[/\\]/).pop();
        return `[${name}](${rel})`;
      });
      refsSummaryLines.push(`- Journal (${journalAbsPaths.length} 篇): ${jLinks.join(", ")}`);
    } else {
      refsSummaryLines.push("- Journal: （无）");
    }
    if (groupAbsPaths.length > 0) {
      const gLinks = allGroupRefs.map((g) => {
        const actual = groupFileMap.get(g);
        return actual
          ? `[${g}](${relToBase}/pyramid/analysis/groups/${actual})`
          : `${g}`;
      });
      refsSummaryLines.push(`- Groups (${groupAbsPaths.length} 个): ${gLinks.join(", ")}`);
    } else {
      refsSummaryLines.push("- Groups: （无）");
    }

    const skeletonVars = {
      kl_id: kl.klId,
      kl_date: kl.date || "",
      kl_thesis: kl.thesis,
      kl_index: String(i + 1),
      kl_filename: kl.filename,
      kl_link: klLink,
      perspective_id: perspectiveId,
      perspective_dir: perspectiveDir,
      perspective_link: perspLink,
      perspective_name: perspectiveDir.replace(/^P\d+-/, "").replace(/-/g, " "),
      group_links: groupLinks || "（无）",
      refs_summary: refsSummaryLines.join("\n"),
      rel_to_base: relToBase,
    };

    let body = template.skeletonTemplate;
    for (const [k, v] of Object.entries(skeletonVars)) {
      body = body.replaceAll(`{{${k}}}`, v);
    }

    const fm = serializeSkeletonFrontmatter({
      skeleton: true,
      template: templateName,
      perspective: perspectiveDir,
      kl: kl.klId,
      date: kl.date || null,
      refs,
    });

    const fileContent = `${fm}\n\n${body}\n`;
    writeFileSync(outPath, fileContent, "utf-8");
    log(`[${i + 1}/${klsToProcess.length}] ✓ ${outFilename}`);
    results.push({ klId: kl.klId, file: outFilename, status: "skeleton" });
  }

  const created = results.filter((r) => r.status === "skeleton").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  heading("Skeleton 完成");
  log(`创建: ${created}, 跳过: ${skipped}, 警告: ${warnings.length}`);
  for (const w of warnings) warn(w);

  return { success: true, message: `骨架完成: ${created} 创建, ${skipped} 跳过`, results, warnings };
}

// ---------------------------------------------------------------------------
// Skeleton parsing — read refs from skeleton frontmatter
// ---------------------------------------------------------------------------

/**
 * Parse a skeleton file and return its metadata + refs.
 * Detection: frontmatter skeleton:true flag OR body contains "（待生成）".
 * @returns {{ isSkeleton: boolean, meta: object, refs: object, body: string }}
 */
export function parseSkeleton(filePath, baseDir) {
  if (!existsSync(filePath)) return { isSkeleton: false, meta: {}, refs: {}, body: "" };
  const content = readFileSync(filePath, "utf-8");
  const { meta, body } = parseSkeletonFrontmatter(content);
  const isSkeleton = meta.skeleton === true || body.includes("（待生成）");
  if (!isSkeleton) return { isSkeleton: false, meta, refs: {}, body };
  const refs = meta.refs || {};
  return { isSkeleton: true, meta, refs, body };
}

// ---------------------------------------------------------------------------
// Skeleton validation
// ---------------------------------------------------------------------------

/**
 * Validate all refs declared in skeleton files under a given output directory.
 * @returns {{ success: boolean, message: string, files: Array }}
 */
export function validateSkeleton({
  baseDir,
  outputDir: outputDirOverride,
  template: templateName,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const outputDir = outputDirOverride || join(paths.outputsDir, templateName);

  if (!existsSync(outputDir)) {
    return { success: false, message: `输出目录不存在: ${outputDir}` };
  }

  heading("Skeleton 验证");

  const mdFiles = readdirSync(outputDir).filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "INDEX.md");
  const fileResults = [];
  let totalRefs = 0;
  let totalMissing = 0;

  for (const f of mdFiles) {
    const filePath = join(outputDir, f);
    const { isSkeleton, refs } = parseSkeleton(filePath, baseDir);
    if (!isSkeleton) continue;

    const missing = [];
    const valid = [];

    function checkRef(relPath, label) {
      if (!relPath) return;
      totalRefs++;
      const absPath = join(baseDir, relPath);
      if (existsSync(absPath)) {
        valid.push({ label, path: relPath });
      } else {
        missing.push({ label, path: relPath });
        totalMissing++;
      }
    }

    if (typeof refs.kl === "string") {
      checkRef(refs.kl, "KL");
    } else if (Array.isArray(refs.kl)) {
      refs.kl.forEach((p, idx) => checkRef(p, `KL[${idx}]`));
    }

    if (refs.scqa) checkRef(refs.scqa, "SCQA");

    if (Array.isArray(refs.journal)) {
      refs.journal.forEach((p, idx) => checkRef(p, `journal[${idx}]`));
    }
    if (Array.isArray(refs.groups)) {
      refs.groups.forEach((p, idx) => checkRef(p, `groups[${idx}]`));
    }

    const status = missing.length === 0 ? "ok" : "missing";
    if (missing.length > 0) {
      warn(`${f}: ${missing.length} 个引用缺失`);
      for (const m of missing) warn(`  ${m.label}: ${m.path}`);
    } else {
      log(`${f}: ${valid.length} 个引用全部有效`);
    }

    fileResults.push({ file: f, valid: valid.length, missing, status });
  }

  if (fileResults.length === 0) {
    log("未找到骨架文件");
    return { success: true, message: "未找到骨架文件", files: [] };
  }

  heading("验证完成");
  log(`文件: ${fileResults.length}, 总引用: ${totalRefs}, 缺失: ${totalMissing}`);

  return {
    success: true,
    message: `验证完成: ${fileResults.length} 文件, ${totalRefs} 引用, ${totalMissing} 缺失`,
    files: fileResults,
  };
}

// ---------------------------------------------------------------------------
// Fill cleanup — transform skeleton into final output
// ---------------------------------------------------------------------------

function cleanSkeletonForFinal(generatedContent, meta) {
  const refsMeta = meta.refs || {};
  const finalMeta = { ...meta };
  delete finalMeta.skeleton;
  finalMeta.refs = refsMeta;

  const fm = serializeSkeletonFrontmatter(finalMeta);
  let body = generatedContent;

  body = body.replace(/## 引用素材摘要\s*\n[\s\S]*?(?=\n## |\n---|\n$)/, "");
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  return `${fm}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Quality review — optional LLM-based post-generation check
// ---------------------------------------------------------------------------

/**
 * Run a quality review on generated content using the template's Review Prompt.
 * @returns {{ score: string, report: string }} or null if no review prompt defined
 */
export async function runReview({
  generatedContent,
  sourceVars,
  template,
  callAgent,
  log = defaultLog,
}) {
  const reviewTemplate = template.reviewPrompt;
  if (!reviewTemplate) return null;

  const vars = {
    ...sourceVars,
    generated_content: generatedContent,
    source_summary: [
      sourceVars.kl_content && `KL 骨架:\n${sourceVars.kl_content}`,
      sourceVars.journal_content && `Journal:\n${sourceVars.journal_content?.slice(0, 2000)}`,
      sourceVars.groups_content && `Groups:\n${sourceVars.groups_content?.slice(0, 2000)}`,
    ].filter(Boolean).join("\n\n---\n\n") || "（无源素材摘要）",
  };

  let reviewPrompt = reviewTemplate;
  for (const [key, value] of Object.entries(vars)) {
    if (value != null) reviewPrompt = reviewPrompt.replaceAll(`{{${key}}}`, value);
  }

  log("  审校中...");
  const report = await callAgent(reviewPrompt);
  const cleaned = stripCodeFences(report.trim());

  const scoreMatch = cleaned.match(/综合评分[：:]\s*(\d(?:\.\d)?)\s*\/\s*5/);
  const score = scoreMatch ? scoreMatch[1] : "?";

  return { score, report: cleaned };
}

// ---------------------------------------------------------------------------
// Multi-stage pipeline
// ---------------------------------------------------------------------------

/**
 * Run a multi-stage generation pipeline for a single MaterialSet.
 *
 * @param {object} opts
 * @param {string[]}  opts.stages       - ordered stage names from template frontmatter
 * @param {string[]}  opts.pauseAfter   - stage names after which to pause
 * @param {object}    opts.stageSections - map of stage name → prompt text
 * @param {string}    opts.systemPrompt - shared system prompt
 * @param {object}    opts.vars         - template variables from MaterialSet
 * @param {string}    opts.stagingDir   - directory for intermediate outputs
 * @param {string}    opts.startFrom    - stage name to resume from (null = start)
 * @param {function}  opts.callAgent
 * @param {function}  opts.log
 * @returns {{ content: string, stageResults: object[], paused: boolean, pausedAt: string|null }}
 */
export async function runPipeline({
  stages,
  pauseAfter = [],
  stageSections,
  systemPrompt,
  vars,
  stagingDir,
  startFrom,
  callAgent,
  log = defaultLog,
}) {
  if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });

  const stageResults = [];
  let prevOutput = "";
  let started = !startFrom;

  for (const stageName of stages) {
    if (!started) {
      const prevFile = join(stagingDir, `${stageName}.md`);
      if (existsSync(prevFile)) {
        prevOutput = readFileSync(prevFile, "utf-8");
      }
      if (stageName === startFrom) started = true;
      if (!started) continue;
    }

    const stagePrompt = stageSections[stageName];
    if (!stagePrompt) {
      log(`  [pipeline] 跳过 ${stageName}（无对应 Stage 区段）`);
      continue;
    }

    const stageVars = { ...vars, prev_stage_output: prevOutput };
    let prompt = stagePrompt;
    for (const [key, value] of Object.entries(stageVars)) {
      if (value != null) prompt = prompt.replaceAll(`{{${key}}}`, value);
    }

    const fullPrompt = systemPrompt
      ? `${buildPrompt(systemPrompt, stageVars)}\n\n---\n\n${prompt}`
      : prompt;

    log(`  [pipeline] ${stageName} 执行中...`);
    const t0 = Date.now();
    const result = await callAgent(fullPrompt);
    const output = stripCodeFences(result.trim());
    const durationMs = Date.now() - t0;

    const stagingFile = join(stagingDir, `${stageName}.md`);
    writeFileSync(stagingFile, output + "\n", "utf-8");
    log(`  [pipeline] ${stageName} 完成 (${durationMs}ms) → _staging/${stageName}.md`);

    stageResults.push({ stage: stageName, durationMs, outputChars: output.length });
    prevOutput = output;

    if (pauseAfter.includes(stageName)) {
      log(`  [pipeline] 在 ${stageName} 后暂停（使用 --stage 继续）`);
      return { content: output, stageResults, paused: true, pausedAt: stageName };
    }
  }

  return { content: prevOutput, stageResults, paused: false, pausedAt: null };
}

// ---------------------------------------------------------------------------
// Material resolution strategies — multi-granularity support
// ---------------------------------------------------------------------------

function buildGroupLinks(groupRefs, groupFileMap, relToBase) {
  return groupRefs
    .map((g) => {
      const actual = groupFileMap.get(g);
      return actual
        ? `[${g}](${relToBase}/pyramid/analysis/groups/${actual})`
        : `${g}（文件不存在）`;
    })
    .join(" · ");
}

/**
 * Resolve materials for per-kl split mode.
 * Returns one MaterialSet per Key Line (existing behavior).
 */
function resolvePerKlMaterials({
  klsToProcess, perspPath, perspectiveDir, perspectiveId,
  paths, baseDir, scqaContent, groupFileMap, relToBase,
  outputDir, template, force, log,
}) {
  const sets = [];
  for (let i = 0; i < klsToProcess.length; i++) {
    const kl = klsToProcess[i];
    const outFilename = generateFilename(kl, template);
    const outPath = join(outputDir, outFilename);

    const skeleton = existsSync(outPath) ? parseSkeleton(outPath, baseDir) : null;
    const useSkeleton = skeleton?.isSkeleton;
    const isDraft = skeleton?.meta?.draft === true;

    const hasExistingRefs = !useSkeleton && force && skeleton?.meta?.refs
      && (skeleton.meta.refs.kl || (skeleton.meta.refs.groups && skeleton.meta.refs.groups.length > 0));
    const useRefs = useSkeleton || hasExistingRefs;

    if (existsSync(outPath) && !force && !useSkeleton && !isDraft) {
      const existing = readFileSync(outPath, "utf-8");
      if (!existing.includes("（待") && !existing.includes("待提炼")) {
        log(`[${i + 1}/${klsToProcess.length}] 跳过 ${outFilename}（已完成）`);
        sets.push({ id: kl.klId, filename: outFilename, status: "skipped" });
        continue;
      }
    }

    let klContent, journalContents, groupContents, allGroupRefs;

    if (useRefs) {
      const refs = useSkeleton ? skeleton.refs : (skeleton.meta.refs || {});
      klContent = refs.kl ? readRefFile(baseDir, typeof refs.kl === "string" ? refs.kl : refs.kl) : `# ${kl.klId}: ${kl.thesis}`;
      journalContents = readRefFiles(baseDir, refs.journal || []);
      groupContents = readRefFiles(baseDir, refs.groups || []);
      allGroupRefs = (refs.groups || []).map((p) => {
        const m = p.match(/(G\d+)/);
        return m ? m[1] : p;
      });
      const label = useSkeleton ? "从骨架填充" : "从已有 refs 重新生成";
      log(`[${i + 1}/${klsToProcess.length}] ${kl.klId} → ${outFilename}（${label}）`);
      log(`  [refs] journal: ${journalContents.length} 篇, groups: ${groupContents.length} 个`);
    } else {
      const klFilePath = join(perspPath, "tree", kl.filename);
      klContent = existsSync(klFilePath) ? read(klFilePath) : `# ${kl.klId}: ${kl.thesis}`;
      const parsed = parseKlContent(klContent);
      journalContents = resolveJournalContent(klFilePath, parsed.journalRefs);
      if (journalContents.length === 0 && kl.date) {
        journalContents = resolveJournalByDate(paths.journalDir, kl.date);
      }
      allGroupRefs = [...new Set([...parsed.groupRefs, ...kl.groups])];
      groupContents = resolveGroupContent(paths.groupsDir, allGroupRefs);
      log(`[${i + 1}/${klsToProcess.length}] ${kl.klId} → ${outFilename}`);
      log(`  journal: ${journalContents.length} 篇, groups: ${groupContents.length} 个`);
    }

    const groupLinksForPrompt = buildGroupLinks(allGroupRefs, groupFileMap, relToBase);

    const vars = {
      kl_id: kl.klId,
      kl_thesis: kl.thesis,
      kl_date: kl.date || "",
      kl_filename: kl.filename,
      kl_content: klContent,
      journal_content: journalContents.length > 0
        ? journalContents.join("\n\n---\n\n")
        : "（无 journal 素材）",
      groups_content: groupContents.length > 0
        ? groupContents.join("\n\n---\n\n")
        : "（无 groups 素材）",
      group_links: groupLinksForPrompt,
      scqa_content: scqaContent,
      perspective_dir: perspectiveDir,
      perspective_id: perspectiveId,
      rel_to_base: relToBase,
      support_points: useSkeleton ? "" : (() => {
        const parsed = parseKlContent(klContent);
        return parsed.supportPoints.map((sp) => `- ${sp.id}: ${sp.thesis}`).join("\n");
      })(),
    };

    sets.push({
      id: kl.klId,
      filename: outFilename,
      vars,
      skeleton: useSkeleton ? skeleton : null,
      existingMeta: hasExistingRefs ? skeleton.meta : null,
      logContext: {
        klThesis: kl.thesis,
        klDate: kl.date || "",
        journalCount: journalContents.length,
        groupsCount: groupContents.length,
        groupRefs: allGroupRefs,
        fromSkeleton: !!useSkeleton,
        fromExistingRefs: !!hasExistingRefs,
      },
    });
  }
  return sets;
}

/**
 * Resolve materials for per-perspective split mode.
 * Returns a single MaterialSet aggregating the entire perspective.
 */
function resolvePerPerspectiveMaterials({
  keyLines, perspPath, perspectiveDir, perspectiveId,
  paths, baseDir, scqaContent, groupFileMap, relToBase,
  template, log,
}) {
  const allJournalContents = [];
  const allGroupRefsSet = new Set();
  const klSummaries = [];

  for (const kl of keyLines) {
    const klFilePath = join(perspPath, "tree", kl.filename);
    const klContent = existsSync(klFilePath) ? read(klFilePath) : "";
    const parsed = parseKlContent(klContent);

    const journalContents = resolveJournalContent(klFilePath, parsed.journalRefs);
    if (journalContents.length === 0 && kl.date) {
      journalContents.push(...resolveJournalByDate(paths.journalDir, kl.date));
    }
    allJournalContents.push(...journalContents);

    const groupRefs = [...new Set([...parsed.groupRefs, ...kl.groups])];
    for (const g of groupRefs) allGroupRefsSet.add(g);

    klSummaries.push(`- **${kl.klId}** (${kl.date || "无日期"}): ${kl.thesis}`);
  }

  const allGroupRefs = [...allGroupRefsSet];
  const groupContents = resolveGroupContent(paths.groupsDir, allGroupRefs);
  const groupLinksForPrompt = buildGroupLinks(allGroupRefs, groupFileMap, relToBase);

  const scqaAnswer = scqaContent.match(/## A\s*[-—]\s*.*\n+([\s\S]*?)(?=\n##|\n---|\n$)/);
  const perspectiveThesis = scqaAnswer ? scqaAnswer[1].trim() : perspectiveDir.replace(/^P\d+-/, "").replace(/-/g, " ");

  const naming = template.fileNaming || "slug";
  let filename;
  if (naming === "slug") {
    const slug = perspectiveDir.replace(/^P\d+-/, "").slice(0, 50);
    filename = `${slug}.md`;
  } else {
    filename = `${perspectiveDir}.md`;
  }

  log(`[per-perspective] ${perspectiveDir} → ${filename}`);
  log(`  KL: ${keyLines.length} 个, journal: ${allJournalContents.length} 篇, groups: ${groupContents.length} 个`);

  const vars = {
    perspective_dir: perspectiveDir,
    perspective_id: perspectiveId,
    perspective_thesis: perspectiveThesis,
    perspective_name: perspectiveDir.replace(/^P\d+-/, "").replace(/-/g, " "),
    scqa_content: scqaContent || "（无 SCQA）",
    all_kl_summaries: klSummaries.join("\n"),
    all_groups_content: groupContents.length > 0
      ? groupContents.join("\n\n---\n\n")
      : "（无 groups 素材）",
    journal_content: allJournalContents.length > 0
      ? allJournalContents.join("\n\n---\n\n")
      : "（无 journal 素材）",
    groups_content: groupContents.length > 0
      ? groupContents.join("\n\n---\n\n")
      : "（无 groups 素材）",
    group_links: groupLinksForPrompt,
    rel_to_base: relToBase,
    kl_count: String(keyLines.length),
  };

  return [{
    id: perspectiveDir,
    filename,
    vars,
    skeleton: null,
    logContext: {
      perspectiveDir,
      klCount: keyLines.length,
      journalCount: allJournalContents.length,
      groupsCount: groupContents.length,
      groupRefs: allGroupRefs,
    },
  }];
}

/**
 * Resolve materials for per-group split mode.
 * Returns one MaterialSet per group, with reverse-linked atoms and KLs.
 */
function resolvePerGroupMaterials({
  keyLines, perspPath, perspectiveDir, perspectiveId,
  paths, baseDir, scqaContent, groupFileMap, relToBase, log,
}) {
  const groupToKls = new Map();
  for (const kl of keyLines) {
    const klFilePath = join(perspPath, "tree", kl.filename);
    const klContent = existsSync(klFilePath) ? read(klFilePath) : "";
    const parsed = parseKlContent(klContent);
    const groupRefs = [...new Set([...parsed.groupRefs, ...kl.groups])];
    for (const g of groupRefs) {
      if (!groupToKls.has(g)) groupToKls.set(g, []);
      groupToKls.get(g).push(kl);
    }
  }

  const sets = [];
  const sortedGroups = [...groupToKls.keys()].sort();

  for (let i = 0; i < sortedGroups.length; i++) {
    const groupId = sortedGroups[i];
    const relatedKls = groupToKls.get(groupId);

    const groupFile = findGroupFile(paths.groupsDir, groupId);
    const groupContent = groupFile ? readFileSync(groupFile, "utf-8") : "";

    const klSummaries = relatedKls.map((kl) => `- **${kl.klId}** (${kl.date || "无日期"}): ${kl.thesis}`);

    const filename = `${groupId}.md`;
    log(`[${i + 1}/${sortedGroups.length}] ${groupId} → ${filename} (关联 ${relatedKls.length} 个 KL)`);

    const vars = {
      group_id: groupId,
      group_content: groupContent || "（无 group 内容）",
      related_kl_summaries: klSummaries.join("\n"),
      scqa_content: scqaContent || "（无 SCQA）",
      perspective_dir: perspectiveDir,
      perspective_id: perspectiveId,
      rel_to_base: relToBase,
      group_links: buildGroupLinks([groupId], groupFileMap, relToBase),
    };

    sets.push({
      id: groupId,
      filename,
      vars,
      skeleton: null,
      logContext: {
        groupId,
        relatedKlCount: relatedKls.length,
        perspectiveDir,
      },
    });
  }

  return sets;
}

/**
 * Resolve materials across multiple perspectives (cross-perspective).
 * Merges materials from several perspectives into a single output.
 */
function resolveCrossPerspectiveMaterials({
  perspectives, paths, baseDir, groupFileMap, relToBase, template, log,
}) {
  const allKlSummaries = [];
  const allJournalContents = [];
  const allGroupRefsSet = new Set();
  const scqaParts = [];

  for (const perspDir of perspectives) {
    const perspPath = join(paths.structureDir, perspDir);
    if (!existsSync(perspPath)) {
      log(`  [cross] 视角 ${perspDir} 不存在，跳过`);
      continue;
    }

    const scqaPath = join(perspPath, "scqa.md");
    if (existsSync(scqaPath)) {
      scqaParts.push(`### ${perspDir}\n\n${readFileSync(scqaPath, "utf-8")}`);
    }

    const treePath = join(perspPath, "tree", "README.md");
    if (!existsSync(treePath)) continue;
    const keyLines = parseKeyLineTable(read(treePath));

    for (const kl of keyLines) {
      allKlSummaries.push(`- **${kl.klId}** [${perspDir}] (${kl.date || "无日期"}): ${kl.thesis}`);
      const klFilePath = join(perspPath, "tree", kl.filename);
      const klContent = existsSync(klFilePath) ? read(klFilePath) : "";
      const parsed = parseKlContent(klContent);

      const journalContents = resolveJournalContent(klFilePath, parsed.journalRefs);
      if (journalContents.length === 0 && kl.date) {
        journalContents.push(...resolveJournalByDate(paths.journalDir, kl.date));
      }
      allJournalContents.push(...journalContents);

      for (const g of [...new Set([...parsed.groupRefs, ...kl.groups])]) {
        allGroupRefsSet.add(g);
      }
    }
  }

  const allGroupRefs = [...allGroupRefsSet];
  const groupContents = resolveGroupContent(paths.groupsDir, allGroupRefs);
  const groupLinksForPrompt = buildGroupLinks(allGroupRefs, groupFileMap, relToBase);

  const naming = template.fileNaming || "slug";
  const filename = naming === "slug" ? "cross-perspective.md" : `${perspectives.join("_")}.md`;

  log(`[cross-perspective] ${perspectives.join(", ")} → ${filename}`);
  log(`  KL: ${allKlSummaries.length} 个, journal: ${allJournalContents.length} 篇, groups: ${groupContents.length} 个`);

  const vars = {
    perspectives: perspectives.join(", "),
    perspective_count: String(perspectives.length),
    scqa_content: scqaParts.length > 0 ? scqaParts.join("\n\n---\n\n") : "（无 SCQA）",
    all_kl_summaries: allKlSummaries.join("\n"),
    journal_content: allJournalContents.length > 0
      ? allJournalContents.join("\n\n---\n\n") : "（无 journal 素材）",
    groups_content: groupContents.length > 0
      ? groupContents.join("\n\n---\n\n") : "（无 groups 素材）",
    all_groups_content: groupContents.length > 0
      ? groupContents.join("\n\n---\n\n") : "（无 groups 素材）",
    group_links: groupLinksForPrompt,
    rel_to_base: relToBase,
    kl_count: String(allKlSummaries.length),
  };

  return [{
    id: `cross:${perspectives.join("+")}`,
    filename,
    vars,
    skeleton: null,
    logContext: {
      perspectives,
      klCount: allKlSummaries.length,
      journalCount: allJournalContents.length,
      groupsCount: groupContents.length,
    },
  }];
}

/**
 * Resolve materials directly from analysis layer (groups or synthesis).
 * Bypasses the structure layer entirely.
 */
function resolveFromAnalysisMaterials({
  paths, baseDir, groupFileMap, relToBase, sourceConfig, template, log,
}) {
  const from = sourceConfig.from || "groups";
  const filter = sourceConfig.filter
    ? sourceConfig.filter.split(",").map((s) => s.trim())
    : null;

  if (from === "synthesis") {
    const synthesisPath = join(paths.analysisDir || join(baseDir, "pyramid", "analysis"), "synthesis.md");
    const synthesisContent = existsSync(synthesisPath) ? readFileSync(synthesisPath, "utf-8") : "";

    const filename = "synthesis.md";
    log(`[from-analysis] synthesis → ${filename}`);

    return [{
      id: "synthesis",
      filename,
      vars: {
        synthesis_content: synthesisContent || "（无 synthesis 内容）",
        rel_to_base: relToBase,
      },
      skeleton: null,
      logContext: { source: "synthesis" },
    }];
  }

  const groupsDir = paths.groupsDir;
  if (!existsSync(groupsDir)) {
    log("[from-analysis] groups 目录不存在");
    return [];
  }

  const allGroupFiles = readdirSync(groupsDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "README.md");
  const sets = [];

  for (const gFile of allGroupFiles.sort()) {
    const gMatch = gFile.match(/^(G\d+)/);
    if (!gMatch) continue;
    const groupId = gMatch[1];

    if (filter && !filter.includes(groupId)) continue;

    const groupContent = readFileSync(join(groupsDir, gFile), "utf-8");
    const filename = `${groupId}.md`;

    log(`[from-analysis] ${groupId} → ${filename}`);

    const vars = {
      group_id: groupId,
      group_content: groupContent,
      group_links: buildGroupLinks([groupId], groupFileMap, relToBase),
      rel_to_base: relToBase,
    };

    sets.push({
      id: groupId,
      filename,
      vars,
      skeleton: null,
      logContext: { source: "analysis", groupId },
    });
  }

  return sets;
}

// ---------------------------------------------------------------------------
// Main: runOutput
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string}   opts.baseDir
 * @param {string}   opts.perspectiveDir  - e.g. "P23-practice-diary"
 * @param {string}   opts.template        - template name, e.g. "practice-diary"
 * @param {string}   [opts.outputDir]     - override output directory
 * @param {string}   [opts.mode]          - "skeleton" | "validate" | "generate" (default)
 * @param {boolean}  [opts.autoWrite=true]
 * @param {boolean}  [opts.dryRun=false]
 * @param {boolean}  [opts.force=false]   - overwrite existing non-skeleton files
 * @param {string[]} [opts.klFilter]      - only process these KL IDs
 * @param {boolean}  [opts.saveLog=true]  - persist full prompt/response to _logs/
 * @param {object}   [opts.apiConfig]     - { model, temperature, maxTokens } for log metadata
 * @param {function} opts.callAgent       - (prompt: string) => Promise<string>
 * @param {function} [opts.log]
 * @param {function} [opts.warn]
 */
export async function runOutput({
  baseDir,
  perspectiveDir,
  perspectives,
  source,
  template: templateName,
  outputDir: outputDirOverride,
  mode,
  autoWrite = true,
  dryRun = false,
  force = false,
  review: enableReview = false,
  stage: startStage,
  klFilter,
  saveLog = true,
  apiConfig = {},
  callAgent,
  log = defaultLog,
  warn = defaultWarn,
}) {
  // --- Mode: skeleton ---
  if (mode === "skeleton") {
    return generateSkeleton({
      baseDir, perspectiveDir, template: templateName,
      outputDir: outputDirOverride, klFilter, force, log, warn,
    });
  }

  // --- Mode: validate ---
  if (mode === "validate") {
    return validateSkeleton({
      baseDir, outputDir: outputDirOverride, template: templateName, log, warn,
    });
  }

  // --- Mode: generate (default) ---
  const paths = makePaths(baseDir);
  const perspPath = perspectiveDir ? join(paths.structureDir, perspectiveDir) : null;

  if (perspPath && !existsSync(perspPath)) {
    return { success: false, message: `视角目录不存在: ${perspectiveDir}`, error: "PERSPECTIVE_NOT_FOUND" };
  }

  const template = loadTemplate(templateName, baseDir);
  if (!template) {
    const available = listTemplates(baseDir).map((t) => t.name).join(", ");
    return {
      success: false,
      message: `模板 "${templateName}" 未找到。可用模板: ${available || "无"}`,
      error: "TEMPLATE_NOT_FOUND",
    };
  }

  const split = template.split || "per-kl";
  heading("Output 生成");
  log(`模板: ${template.name || templateName} (${relative(baseDir, template.path) || template.path})`);
  log(`拆分: ${split}, 命名: ${template.fileNaming || "sequence"}`);

  const treePath = perspPath ? join(perspPath, "tree", "README.md") : null;
  if (treePath && !existsSync(treePath)) {
    return { success: false, message: "tree/README.md 不存在", error: "TREE_NOT_FOUND" };
  }

  const treeContent = treePath ? read(treePath) : "";
  const keyLines = treePath ? parseKeyLineTable(treeContent) : [];

  if (split === "per-kl" && keyLines.length === 0) {
    return { success: false, message: "未在 tree/README.md 中找到 Key Line", error: "NO_KEY_LINES" };
  }

  const scqaPath = perspPath ? join(perspPath, "scqa.md") : null;
  const scqaContent = scqaPath && existsSync(scqaPath) ? read(scqaPath) : "";

  const groupFileMap = buildGroupFilenameMap(paths.groupsDir);
  const klFileMap = new Map();
  for (const kl of keyLines) klFileMap.set(kl.klId, kl.filename);

  const outputDir = outputDirOverride || join(paths.outputsDir, templateName, perspectiveDir || "_global");
  if (autoWrite && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const logDir = saveLog ? join(outputDir, "_logs") : null;
  const relToBase = relative(outputDir, baseDir).replace(/\\/g, "/") || ".";
  const perspIdMatch = perspectiveDir ? perspectiveDir.match(/^(P\d+)/) : null;
  const perspectiveId = perspIdMatch ? perspIdMatch[1] : (perspectiveDir || "");

  // --- Resolve MaterialSets based on source/split strategy ---
  const sourceConfig = source || template.source;
  const sourceType = sourceConfig?.type;

  const klsToProcess = klFilter
    ? keyLines.filter((kl) => klFilter.includes(kl.klId))
    : keyLines;

  const sharedCtx = {
    keyLines, klsToProcess, perspPath, perspectiveDir, perspectiveId,
    paths, baseDir, scqaContent, groupFileMap, relToBase,
    outputDir, template, force, log,
  };

  let materialSets;
  if (sourceType === "cross-perspective") {
    const perspList = perspectives
      || sourceConfig.perspectives
      || (perspectiveDir ? [perspectiveDir] : []);
    materialSets = resolveCrossPerspectiveMaterials({
      perspectives: perspList, paths, baseDir, groupFileMap, relToBase, template, log,
    });
  } else if (sourceType === "analysis") {
    materialSets = resolveFromAnalysisMaterials({
      paths, baseDir, groupFileMap, relToBase, sourceConfig, template, log,
    });
  } else if (split === "per-perspective") {
    materialSets = resolvePerPerspectiveMaterials(sharedCtx);
  } else if (split === "per-group") {
    materialSets = resolvePerGroupMaterials(sharedCtx);
  } else {
    materialSets = resolvePerKlMaterials(sharedCtx);
  }

  log(`\n共 ${materialSets.length} 个产出单元\n`);

  // --- Generic generation loop over MaterialSets ---
  const results = [];

  for (const ms of materialSets) {
    const resultBase = { id: ms.id, klId: ms.id, file: ms.filename };

    if (ms.status === "skipped") {
      results.push({ ...resultBase, status: "skipped" });
      continue;
    }

    const outPath = join(outputDir, ms.filename);
    const useSkeleton = !!ms.skeleton;
    const usesPipeline = Array.isArray(template.stages) && template.stages.length > 0 && template.stageSections;

    if (dryRun) {
      const systemPrompt = buildPrompt(template.systemPrompt, ms.vars);
      const userPrompt = buildPrompt(template.unitPrompt, ms.vars);
      log(`  [dry-run] ${ms.id}: prompt ${(systemPrompt + userPrompt).length} chars${usesPipeline ? ` (pipeline: ${template.stages.join(" → ")})` : ""}`);
      if (logDir) {
        const logFile = writeRunLog(logDir, {
          timestamp: new Date().toISOString(),
          perspective: perspectiveDir,
          template: templateName,
          id: ms.id,
          ...apiConfig,
          durationMs: null,
          prompt: { system: systemPrompt, user: userPrompt, totalChars: systemPrompt.length + userPrompt.length },
          response: null,
          context: ms.logContext,
        });
        log(`  [dry-run] log: _logs/${logFile}`);
      }
      results.push({ ...resultBase, status: "dry-run" });
      continue;
    }

    let content;
    let durationMs;

    if (usesPipeline) {
      const stagingDir = join(outputDir, "_staging", ms.id);
      const t0 = Date.now();
      try {
        const pipeResult = await runPipeline({
          stages: template.stages,
          pauseAfter: template.pauseAfter || [],
          stageSections: template.stageSections,
          systemPrompt: template.systemPrompt,
          vars: ms.vars,
          stagingDir,
          startFrom: startStage || null,
          callAgent,
          log,
        });
        durationMs = Date.now() - t0;
        if (pipeResult.paused) {
          results.push({ ...resultBase, status: "paused", pausedAt: pipeResult.pausedAt });
          continue;
        }
        content = pipeResult.content;
      } catch (e) {
        warn(`  Pipeline 失败 (${ms.id}): ${e.message}`);
        results.push({ ...resultBase, status: "error", error: e.message });
        continue;
      }
    } else {
      const systemPrompt = buildPrompt(template.systemPrompt, ms.vars);
      const userPrompt = buildPrompt(template.unitPrompt, ms.vars);
      const t0 = Date.now();
      let generated;
      try {
        generated = await callAgent(`${systemPrompt}\n\n---\n\n${userPrompt}`);
      } catch (e) {
        warn(`  LLM 调用失败 (${ms.id}): ${e.message}`);
        results.push({ ...resultBase, status: "error", error: e.message });
        continue;
      }
      durationMs = Date.now() - t0;
      content = stripCodeFences(generated.trim());
    }

    content = fixOutputLinks(content, {
      groupFileMap, klFileMap, perspectiveDir: perspectiveDir || "", relToBase,
    });

    if (logDir) {
      const logFile = writeRunLog(logDir, {
        timestamp: new Date().toISOString(),
        perspective: perspectiveDir,
        template: templateName,
        id: ms.id,
        ...apiConfig,
        durationMs,
        pipeline: usesPipeline ? template.stages : undefined,
        response: { processedChars: content.length },
        context: ms.logContext,
      });
      log(`  log: _logs/${logFile}`);
    }

    if (autoWrite) {
      if (force && existsSync(outPath)) {
        const backupDir = join(outputDir, "_backups");
        if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
        const base = ms.filename.replace(/\.md$/, "");
        const backupPath = join(backupDir, `${base}-${ts}.md`);
        writeFileSync(backupPath, readFileSync(outPath, "utf-8"), "utf-8");
        log(`  备份: _backups/${base}-${ts}.md`);
      }

      if (useSkeleton) {
        content = cleanSkeletonForFinal(content, ms.skeleton.meta);
        writeFileSync(outPath, content, "utf-8");
      } else if (ms.existingMeta) {
        const fm = serializeSkeletonFrontmatter(ms.existingMeta);
        writeFileSync(outPath, `${fm}\n\n${content}\n`, "utf-8");
      } else {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const klDate = ms.vars?.kl_date;
        if (klDate && klDate === today) {
          const draftFm = `---\ndraft: true\ndate: ${klDate}\n---\n\n`;
          writeFileSync(outPath, draftFm + content + "\n", "utf-8");
        } else {
          writeFileSync(outPath, content + "\n", "utf-8");
        }
      }
      log(`  ✓ ${relative(baseDir, outPath)}`);
    }

    let reviewResult = null;
    if (enableReview && template.reviewPrompt && callAgent) {
      try {
        reviewResult = await runReview({
          generatedContent: content,
          sourceVars: ms.vars,
          template,
          callAgent,
          log,
        });
        if (reviewResult && autoWrite) {
          const reviewDir = join(outputDir, "_reviews");
          if (!existsSync(reviewDir)) mkdirSync(reviewDir, { recursive: true });
          const reviewFile = ms.filename.replace(/\.md$/, ".review.md");
          writeFileSync(join(reviewDir, reviewFile), reviewResult.report + "\n", "utf-8");
          log(`  审校: ${reviewResult.score}/5 → _reviews/${reviewFile}`);
        }
      } catch (e) {
        warn(`  审校失败 (${ms.id}): ${e.message}`);
      }
    }

    results.push({ ...resultBase, status: "generated", content, review: reviewResult });
  }

  const generated = results.filter((r) => r.status === "generated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  heading("Output 完成");
  log(`生成: ${generated}, 跳过: ${skipped}, 错误: ${errors}`);

  return {
    success: true,
    message: `完成: ${generated} 生成, ${skipped} 跳过, ${errors} 错误`,
    results,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism output [选项]

从视角生成面向读者的产出文件。

选项:
  --perspective <dir>  视角目录名（如 P23-practice-diary，逗号分隔多个）
  --template <name>    输出模板名（如 practice-diary, blog）
  --output-dir <dir>   输出目录（默认 outputs/<template>）
  --kl <id,...>        只处理指定 KL（逗号分隔，如 KL01,KL02）
  --source <type>      素材来源类型（analysis）
  --groups <ids>       指定 groups（逗号分隔，配合 --source analysis）
  --skeleton           只生成骨架文件（不调用 LLM）
  --validate           只验证已有骨架的引用有效性
  --dry-run            只预览，不调用模型
  --force              覆盖已存在的非骨架文件
  --review             生成后执行 LLM 审校（需模板定义 Review Prompt）
  --rewrite <style>    生成后自动执行风格改写（如 kzk-wechat）
  --stage <name>       从指定阶段开始执行（用于恢复暂停的多阶段流水线）
  --no-log             不保存执行日志（默认保存到 _logs/）
  --verbose            显示详细信息
  --list-templates     列出可用模板
  --list-types         列出可用产出类型
  -h, --help           显示帮助

两阶段流程:
  1. output --skeleton ...   生成骨架（含引用声明和占位符）
  2. 人工审查骨架文件
  3. output ...              检测骨架后从引用加载素材，调 LLM 填充

示例:
  js-knowledge-prism output --skeleton --perspective P23-practice-diary --template practice-diary
  js-knowledge-prism output --validate --perspective P23-practice-diary --template practice-diary
  js-knowledge-prism output --perspective P23-practice-diary --template practice-diary
  js-knowledge-prism output --perspective P23-practice-diary --template practice-diary --kl KL01,KL02
  js-knowledge-prism output --list-templates
`.trim();

export async function run(args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      perspective: { type: "string" },
      template: { type: "string" },
      "output-dir": { type: "string" },
      kl: { type: "string" },
      source: { type: "string" },
      groups: { type: "string" },
      skeleton: { type: "boolean", default: false },
      validate: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      rewrite: { type: "string" },
      stage: { type: "string" },
      "no-log": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "list-templates": { type: "boolean", default: false },
      "list-types": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { baseDir, config } = loadConfig();

  if (flags["list-templates"]) {
    const templates = listTemplates(baseDir);
    if (templates.length === 0) {
      console.log("没有可用的模板。");
      return;
    }
    console.log("\n可用模板:\n");
    for (const t of templates) {
      const tpl = loadTemplate(t.name, baseDir);
      console.log(`  ${t.name} (${t.source})`);
      if (tpl?.description) console.log(`    ${tpl.description}`);
      console.log(`    拆分: ${tpl?.split || "per-kl"}, 命名: ${tpl?.fileNaming || "sequence"}`);
      if (tpl?.type) console.log(`    类型: ${tpl.type}`);
      console.log();
    }
    return;
  }

  if (flags["list-types"]) {
    const types = listTypes(baseDir);
    if (types.length === 0) {
      console.log("没有可用的产出类型。");
      return;
    }
    console.log("\n可用产出类型:\n");
    for (const t of types) {
      const td = loadType(t.name, baseDir);
      console.log(`  ${t.name} (${t.source})`);
      if (td?.audience) console.log(`    读者: ${td.audience}`);
      console.log(`    拆分: ${td?.split || "per-kl"}, 命名: ${td?.fileNaming || "sequence"}`);
      console.log();
    }
    return;
  }

  let mode;
  if (flags.skeleton) mode = "skeleton";
  else if (flags.validate) mode = "validate";

  const isAnalysisSource = flags.source === "analysis";
  if (!isAnalysisSource && !flags.perspective) {
    if (!flags.template) {
      console.error("错误: 必须指定 --template\n");
      console.log(HELP);
      process.exit(1);
    }
    console.error("错误: 必须指定 --perspective（或使用 --source analysis）\n");
    console.log(HELP);
    process.exit(1);
  }
  if (!flags.template) {
    console.error("错误: 必须指定 --template\n");
    console.log(HELP);
    process.exit(1);
  }

  const perspList = flags.perspective ? flags.perspective.split(",").map((s) => s.trim()) : [];
  const perspectiveDir = perspList.length === 1 ? perspList[0] : perspList[0];
  const isMultiPerspective = perspList.length > 1;

  const klFilter = flags.kl ? flags.kl.split(",").map((s) => s.trim()) : undefined;

  if (mode === "skeleton") {
    return generateSkeleton({
      baseDir,
      perspectiveDir,
      template: flags.template,
      outputDir: flags["output-dir"],
      klFilter,
      force: flags.force,
    });
  }

  if (mode === "validate") {
    return validateSkeleton({
      baseDir,
      outputDir: flags["output-dir"],
      template: flags.template,
    });
  }

  const callAgent = createHttpCaller({
    baseUrl: config.api.baseUrl,
    apiKey: config.api.apiKey,
    model: config.api.model,
    temperature: config.process.temperature,
    maxTokens: config.process.maxTokens,
    timeoutMs: config.process.timeoutMs,
  });

  let sourceOpt;
  if (isAnalysisSource) {
    sourceOpt = { type: "analysis", from: "groups", filter: flags.groups || "" };
  } else if (isMultiPerspective) {
    sourceOpt = { type: "cross-perspective", perspectives: perspList };
  }

  const result = await runOutput({
    baseDir,
    perspectiveDir: isAnalysisSource ? undefined : perspectiveDir,
    perspectives: isMultiPerspective ? perspList : undefined,
    source: sourceOpt,
    template: flags.template,
    outputDir: flags["output-dir"],
    autoWrite: true,
    dryRun: flags["dry-run"],
    force: flags.force,
    review: flags.review,
    stage: flags.stage,
    saveLog: !flags["no-log"],
    apiConfig: {
      model: config.api.model,
      temperature: config.process.temperature,
      maxTokens: config.process.maxTokens,
    },
    klFilter,
    callAgent,
  });

  if (flags.rewrite && result?.results) {
    const generated = result.results.filter((r) => r.status === "generated");
    if (generated.length > 0) {
      const { runRewrite } = await import("./rewrite.mjs");
      const outputDir = flags["output-dir"]
        || join(baseDir, "outputs", flags.template, isAnalysisSource ? "_global" : perspectiveDir);
      heading("Post-output Rewrite");
      for (const r of generated) {
        const inputPath = join(outputDir, r.file);
        if (!existsSync(inputPath)) continue;
        await runRewrite({
          inputPath,
          rewriteName: flags.rewrite,
          baseDir,
          callAgent,
          force: flags.force,
          dryRun: flags["dry-run"],
        });
      }
    }
  }

  return result;
}

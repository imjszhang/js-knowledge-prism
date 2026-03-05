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
  const systemMatch = body.match(/# System Prompt\s*\n([\s\S]*?)(?=\n# Unit Prompt|$)/);
  const unitMatch = body.match(/# Unit Prompt\s*\n([\s\S]*?)$/);
  return {
    systemPrompt: systemMatch ? systemMatch[1].trim() : "",
    unitPrompt: unitMatch ? unitMatch[1].trim() : "",
  };
}

export function loadTemplate(templateName, baseDir) {
  const localDir = join(baseDir, "outputs", "_templates");
  const localPath = join(localDir, `${templateName}.md`);
  if (existsSync(localPath)) {
    const content = read(localPath);
    const { meta, body } = parseFrontmatter(content);
    const sections = parseTemplateSections(body);
    return { ...meta, ...sections, path: localPath };
  }

  const builtinPath = join(BUILTIN_TEMPLATES_DIR, `${templateName}.md`);
  if (existsSync(builtinPath)) {
    const content = read(builtinPath);
    const { meta, body } = parseFrontmatter(content);
    const sections = parseTemplateSections(body);
    return { ...meta, ...sections, path: builtinPath };
  }

  return null;
}

export function listTemplates(baseDir) {
  const templates = [];
  const seen = new Set();

  const localDir = join(baseDir, "outputs", "_templates");
  if (existsSync(localDir)) {
    for (const f of readdirSync(localDir).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(/\.md$/, "");
      templates.push({ name, source: "local", path: join(localDir, f) });
      seen.add(name);
    }
  }

  if (existsSync(BUILTIN_TEMPLATES_DIR)) {
    for (const f of readdirSync(BUILTIN_TEMPLATES_DIR).filter((f) => f.endsWith(".md"))) {
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

function parseKlContent(content) {
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
  const prefix = entry.klId || "whole";
  const filename = `${prefix}-${ts}.json`;
  writeFileSync(join(logDir, filename), JSON.stringify(entry, null, 2) + "\n", "utf-8");
  return filename;
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
  template: templateName,
  outputDir: outputDirOverride,
  autoWrite = true,
  dryRun = false,
  force = false,
  klFilter,
  saveLog = true,
  apiConfig = {},
  callAgent,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const perspPath = join(paths.structureDir, perspectiveDir);

  if (!existsSync(perspPath)) {
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

  heading("Output 生成");
  log(`模板: ${template.name || templateName} (${relative(baseDir, template.path) || template.path})`);
  log(`拆分: ${template.split || "per-kl"}, 命名: ${template.fileNaming || "sequence"}`);

  const treePath = join(perspPath, "tree", "README.md");
  if (!existsSync(treePath)) {
    return { success: false, message: "tree/README.md 不存在", error: "TREE_NOT_FOUND" };
  }

  const treeContent = read(treePath);
  const keyLines = parseKeyLineTable(treeContent);

  if (keyLines.length === 0) {
    return { success: false, message: "未在 tree/README.md 中找到 Key Line", error: "NO_KEY_LINES" };
  }

  const scqaPath = join(perspPath, "scqa.md");
  const scqaContent = existsSync(scqaPath) ? read(scqaPath) : "";

  // Build filename maps for link post-processing
  const groupFileMap = buildGroupFilenameMap(paths.groupsDir);
  const klFileMap = new Map();
  for (const kl of keyLines) klFileMap.set(kl.klId, kl.filename);

  const outputDir = outputDirOverride || join(paths.outputsDir, templateName);
  if (autoWrite && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const logDir = saveLog ? join(outputDir, "_logs") : null;

  const relToBase = relative(outputDir, baseDir).replace(/\\/g, "/") || ".";
  const perspIdMatch = perspectiveDir.match(/^(P\d+)/);
  const perspectiveId = perspIdMatch ? perspIdMatch[1] : perspectiveDir;

  const split = template.split || "per-kl";
  const results = [];

  if (split === "per-kl") {
    const klsToProcess = klFilter
      ? keyLines.filter((kl) => klFilter.includes(kl.klId))
      : keyLines;

    log(`\n共 ${klsToProcess.length} 个 Key Line 待处理\n`);

    for (let i = 0; i < klsToProcess.length; i++) {
      const kl = klsToProcess[i];
      const outFilename = generateFilename(kl, template);
      const outPath = join(outputDir, outFilename);

      if (existsSync(outPath) && !force) {
        const existing = readFileSync(outPath, "utf-8");
        if (!existing.includes("（待") && !existing.includes("待提炼")) {
          log(`[${i + 1}/${klsToProcess.length}] 跳过 ${outFilename}（已完成）`);
          results.push({ klId: kl.klId, file: outFilename, status: "skipped" });
          continue;
        }
      }

      log(`[${i + 1}/${klsToProcess.length}] ${kl.klId} → ${outFilename}`);

      const klFilePath = join(perspPath, "tree", kl.filename);
      const klContent = existsSync(klFilePath)
        ? read(klFilePath)
        : `# ${kl.klId}: ${kl.thesis}`;

      const parsed = parseKlContent(klContent);

      // Resolve journal: prefer explicit refs in KL, fallback to date directory
      let journalContents = resolveJournalContent(klFilePath, parsed.journalRefs);
      if (journalContents.length === 0 && kl.date) {
        journalContents = resolveJournalByDate(paths.journalDir, kl.date);
      }
      log(`  journal: ${journalContents.length} 篇`);

      const allGroupRefs = [...new Set([...parsed.groupRefs, ...kl.groups])];
      const groupContents = resolveGroupContent(paths.groupsDir, allGroupRefs);
      log(`  groups: ${groupContents.length} 个`);

      const groupLinksForPrompt = allGroupRefs
        .map((g) => {
          const actual = groupFileMap.get(g);
          return actual
            ? `[${g}](${relToBase}/pyramid/analysis/groups/${actual})`
            : `${g}（文件不存在）`;
        })
        .join(" · ");

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
        support_points: parsed.supportPoints.map((sp) => `- ${sp.id}: ${sp.thesis}`).join("\n"),
      };

      const systemPrompt = buildPrompt(template.systemPrompt, vars);
      const userPrompt = buildPrompt(template.unitPrompt, vars);

      const logContext = {
        klThesis: kl.thesis,
        klDate: kl.date || "",
        journalCount: journalContents.length,
        groupsCount: groupContents.length,
        groupRefs: allGroupRefs,
      };

      if (dryRun) {
        log(`  [dry-run] prompt: ${(systemPrompt + userPrompt).length} chars`);
        if (logDir) {
          const logFile = writeRunLog(logDir, {
            timestamp: new Date().toISOString(),
            perspective: perspectiveDir,
            template: templateName,
            klId: kl.klId,
            ...apiConfig,
            durationMs: null,
            prompt: { system: systemPrompt, user: userPrompt, totalChars: systemPrompt.length + userPrompt.length },
            response: null,
            context: logContext,
          });
          log(`  [dry-run] log: _logs/${logFile}`);
        }
        results.push({ klId: kl.klId, file: outFilename, status: "dry-run" });
        continue;
      }

      let generated;
      const t0 = Date.now();
      try {
        generated = await callAgent(`${systemPrompt}\n\n---\n\n${userPrompt}`);
      } catch (e) {
        warn(`  LLM 调用失败: ${e.message}`);
        results.push({ klId: kl.klId, file: outFilename, status: "error", error: e.message });
        continue;
      }
      const durationMs = Date.now() - t0;

      const content = fixOutputLinks(stripCodeFences(generated.trim()), {
        groupFileMap, klFileMap, perspectiveDir, relToBase,
      });

      if (logDir) {
        const logFile = writeRunLog(logDir, {
          timestamp: new Date().toISOString(),
          perspective: perspectiveDir,
          template: templateName,
          klId: kl.klId,
          ...apiConfig,
          durationMs,
          prompt: { system: systemPrompt, user: userPrompt, totalChars: systemPrompt.length + userPrompt.length },
          response: { raw: generated, processed: content, rawChars: generated.length, processedChars: content.length },
          context: logContext,
        });
        log(`  log: _logs/${logFile}`);
      }

      if (autoWrite) {
        writeFileSync(outPath, content + "\n", "utf-8");
        log(`  ✓ ${relative(baseDir, outPath)}`);
      }

      results.push({ klId: kl.klId, file: outFilename, status: "generated", content });
    }
  } else if (split === "whole") {
    const allKlContents = [];
    const allJournalContents = [];
    const allGroupRefs = new Set();

    for (const kl of keyLines) {
      const klFilePath = join(perspPath, "tree", kl.filename);
      if (existsSync(klFilePath)) {
        const klText = read(klFilePath);
        allKlContents.push(klText);
        const parsed = parseKlContent(klText);
        const journals = resolveJournalContent(klFilePath, parsed.journalRefs);
        if (journals.length === 0 && kl.date) {
          journals.push(...resolveJournalByDate(paths.journalDir, kl.date));
        }
        allJournalContents.push(...journals);
        for (const g of [...parsed.groupRefs, ...kl.groups]) allGroupRefs.add(g);
      }
    }

    const allGroupRefsList = [...allGroupRefs];
    const groupContents = resolveGroupContent(paths.groupsDir, allGroupRefsList);

    log(`素材: ${allKlContents.length} 个 KL, ${allJournalContents.length} 篇 journal, ${groupContents.length} 个 groups`);

    const wholeGroupLinks = allGroupRefsList
      .map((g) => {
        const actual = groupFileMap.get(g);
        return actual
          ? `[${g}](${relToBase}/pyramid/analysis/groups/${actual})`
          : `${g}（文件不存在）`;
      })
      .join(" · ");

    const vars = {
      kl_content: allKlContents.join("\n\n---\n\n"),
      journal_content: allJournalContents.length > 0
        ? allJournalContents.join("\n\n---\n\n")
        : "（无 journal 素材）",
      groups_content: groupContents.length > 0
        ? groupContents.join("\n\n---\n\n")
        : "（无 groups 素材）",
      group_links: wholeGroupLinks,
      scqa_content: scqaContent,
      perspective_dir: perspectiveDir,
      perspective_id: perspectiveId,
      rel_to_base: relToBase,
      tree_content: treeContent,
    };

    const slug = perspectiveDir.replace(/^P\d+-/, "");
    const outFilename = `${slug}.md`;
    const outPath = join(outputDir, outFilename);

    if (existsSync(outPath) && !force) {
      log(`跳过 ${outFilename}（已存在，用 --force 覆盖）`);
      results.push({ file: outFilename, status: "skipped" });
    } else {
      const systemPrompt = buildPrompt(template.systemPrompt, vars);
      const userPrompt = buildPrompt(template.unitPrompt, vars);

      const logContext = {
        klCount: allKlContents.length,
        journalCount: allJournalContents.length,
        groupsCount: groupContents.length,
        groupRefs: allGroupRefsList,
      };

      if (dryRun) {
        log(`[dry-run] prompt: ${(systemPrompt + userPrompt).length} chars`);
        if (logDir) {
          const logFile = writeRunLog(logDir, {
            timestamp: new Date().toISOString(),
            perspective: perspectiveDir,
            template: templateName,
            klId: null,
            ...apiConfig,
            durationMs: null,
            prompt: { system: systemPrompt, user: userPrompt, totalChars: systemPrompt.length + userPrompt.length },
            response: null,
            context: logContext,
          });
          log(`[dry-run] log: _logs/${logFile}`);
        }
        results.push({ file: outFilename, status: "dry-run" });
      } else {
        let generated;
        const t0 = Date.now();
        try {
          generated = await callAgent(`${systemPrompt}\n\n---\n\n${userPrompt}`);
        } catch (e) {
          warn(`LLM 调用失败: ${e.message}`);
          results.push({ file: outFilename, status: "error", error: e.message });
        }
        const durationMs = Date.now() - t0;

        if (generated) {
          const content = fixOutputLinks(stripCodeFences(generated.trim()), {
            groupFileMap, klFileMap, perspectiveDir, relToBase,
          });

          if (logDir) {
            const logFile = writeRunLog(logDir, {
              timestamp: new Date().toISOString(),
              perspective: perspectiveDir,
              template: templateName,
              klId: null,
              ...apiConfig,
              durationMs,
              prompt: { system: systemPrompt, user: userPrompt, totalChars: systemPrompt.length + userPrompt.length },
              response: { raw: generated, processed: content, rawChars: generated.length, processedChars: content.length },
              context: logContext,
            });
            log(`log: _logs/${logFile}`);
          }

          if (autoWrite) {
            writeFileSync(outPath, content + "\n", "utf-8");
            log(`✓ ${relative(baseDir, outPath)}`);
          }
          results.push({ file: outFilename, status: "generated", content });
        }
      }
    }
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
  --perspective <dir>  视角目录名（如 P23-practice-diary）
  --template <name>    输出模板名（如 practice-diary, blog）
  --output-dir <dir>   输出目录（默认 outputs/<template>）
  --kl <id,...>        只处理指定 KL（逗号分隔，如 KL01,KL02）
  --dry-run            只预览，不调用模型
  --force              覆盖已存在的非骨架文件
  --no-log             不保存执行日志（默认保存到 _logs/）
  --verbose            显示详细信息
  --list-templates     列出可用模板
  -h, --help           显示帮助

示例:
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
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-log": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "list-templates": { type: "boolean", default: false },
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
      console.log();
    }
    return;
  }

  if (!flags.perspective || !flags.template) {
    console.error("错误: 必须指定 --perspective 和 --template\n");
    console.log(HELP);
    process.exit(1);
  }

  const callAgent = createHttpCaller({
    baseUrl: config.api.baseUrl,
    apiKey: config.api.apiKey,
    model: config.api.model,
    temperature: config.process.temperature,
    maxTokens: config.process.maxTokens,
    timeoutMs: config.process.timeoutMs,
  });

  const klFilter = flags.kl ? flags.kl.split(",").map((s) => s.trim()) : undefined;

  return runOutput({
    baseDir,
    perspectiveDir: flags.perspective,
    template: flags.template,
    outputDir: flags["output-dir"],
    autoWrite: true,
    dryRun: flags["dry-run"],
    force: flags.force,
    saveLog: !flags["no-log"],
    apiConfig: {
      model: config.api.model,
      temperature: config.process.temperature,
      maxTokens: config.process.maxTokens,
    },
    klFilter,
    callAgent,
  });
}

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
// Key Line table parsing (handles both date-based and standard tables)
// ---------------------------------------------------------------------------

function parseKeyLineTable(treeContent) {
  const lines = treeContent.split("\n");
  const result = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|") || line.includes("---|---")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 6) continue;
    const col1 = parts[1];
    const col2 = parts[2];
    const col3 = parts[3] ?? "";
    const col4 = parts[4] ?? "";
    const col5 = parts[5] ?? "";
    if (!col1.startsWith("KL") || !col2) continue;

    const isDateBased = /^\d{4}-\d{2}-\d{2}$/.test(col2);
    const thesis = isDateBased ? col3 : col2;
    const groupsCol = isDateBased ? col4 : col3;
    const detailCol = isDateBased ? col5 : col4;
    const filenameCol = isDateBased ? col5 : (parts[5] ?? "");

    const filenameMatch = filenameCol.match(/(KL\d+[-\w]*\.md)/);
    const filename = filenameMatch
      ? filenameMatch[1]
      : filenameCol.includes(".md")
        ? filenameCol
        : `${col1}-expand.md`;

    result.push({
      klId: col1,
      date: isDateBased ? col2 : null,
      thesis,
      groups: groupsCol
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      filename,
    });
  }
  return result;
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

  const outputDir = outputDirOverride || join(paths.outputsDir, templateName);
  if (autoWrite && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

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

      const vars = {
        kl_id: kl.klId,
        kl_thesis: kl.thesis,
        kl_date: kl.date || "",
        kl_content: klContent,
        journal_content: journalContents.length > 0
          ? journalContents.join("\n\n---\n\n")
          : "（无 journal 素材）",
        groups_content: groupContents.length > 0
          ? groupContents.join("\n\n---\n\n")
          : "（无 groups 素材）",
        scqa_content: scqaContent,
        perspective_dir: perspectiveDir,
        support_points: parsed.supportPoints.map((sp) => `- ${sp.id}: ${sp.thesis}`).join("\n"),
      };

      const userPrompt = buildPrompt(template.unitPrompt, vars);

      if (dryRun) {
        log(`  [dry-run] prompt: ${userPrompt.length} chars`);
        results.push({ klId: kl.klId, file: outFilename, status: "dry-run" });
        continue;
      }

      let generated;
      try {
        generated = await callAgent(`${template.systemPrompt}\n\n---\n\n${userPrompt}`);
      } catch (e) {
        warn(`  LLM 调用失败: ${e.message}`);
        results.push({ klId: kl.klId, file: outFilename, status: "error", error: e.message });
        continue;
      }

      const content = stripCodeFences(generated.trim());

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

    const groupContents = resolveGroupContent(paths.groupsDir, [...allGroupRefs]);

    log(`素材: ${allKlContents.length} 个 KL, ${allJournalContents.length} 篇 journal, ${groupContents.length} 个 groups`);

    const vars = {
      kl_content: allKlContents.join("\n\n---\n\n"),
      journal_content: allJournalContents.length > 0
        ? allJournalContents.join("\n\n---\n\n")
        : "（无 journal 素材）",
      groups_content: groupContents.length > 0
        ? groupContents.join("\n\n---\n\n")
        : "（无 groups 素材）",
      scqa_content: scqaContent,
      perspective_dir: perspectiveDir,
      tree_content: treeContent,
    };

    const slug = perspectiveDir.replace(/^P\d+-/, "");
    const outFilename = `${slug}.md`;
    const outPath = join(outputDir, outFilename);

    if (existsSync(outPath) && !force) {
      log(`跳过 ${outFilename}（已存在，用 --force 覆盖）`);
      results.push({ file: outFilename, status: "skipped" });
    } else {
      const userPrompt = buildPrompt(template.unitPrompt, vars);

      if (dryRun) {
        log(`[dry-run] prompt: ${userPrompt.length} chars`);
        results.push({ file: outFilename, status: "dry-run" });
      } else {
        let generated;
        try {
          generated = await callAgent(`${template.systemPrompt}\n\n---\n\n${userPrompt}`);
        } catch (e) {
          warn(`LLM 调用失败: ${e.message}`);
          results.push({ file: outFilename, status: "error", error: e.message });
        }

        if (generated) {
          const content = stripCodeFences(generated.trim());
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
    klFilter,
    callAgent,
  });
}

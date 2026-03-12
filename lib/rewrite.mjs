/**
 * Rewrite engine — post-processing style transformation for output files.
 * Loads rewrite definitions, applies them to existing markdown content via LLM,
 * and writes results to _rewrites/<style>/ subdirectories.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { createHttpCaller } from "./process.mjs";
import {
  heading,
  listMdFiles,
  log as defaultLog,
  stripCodeFences,
  warn as defaultWarn,
} from "./utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_REWRITES_DIR = join(__dirname, "..", "templates", "outputs", "rewrites");
const BUILTIN_COMPONENTS_DIR = join(__dirname, "..", "templates", "outputs", "components");

const SOURCE_CONTEXT_MAX_CHARS = 3000;

// ---------------------------------------------------------------------------
// Include resolution (shared logic with output.mjs)
// ---------------------------------------------------------------------------

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
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w][\w-]*):\s*(.+)$/);
    if (kv) {
      const val = kv[2].trim();
      if (val === "true" || val === "false") {
        meta[kv[1]] = val === "true";
      } else if (val.startsWith("[") && val.endsWith("]")) {
        meta[kv[1]] = val.slice(1, -1).split(",").map((s) => s.trim());
      } else {
        meta[kv[1]] = val;
      }
    }
  }
  return { meta, body: m[2] };
}

// ---------------------------------------------------------------------------
// Rewrite definition loading
// ---------------------------------------------------------------------------

function parseRewriteSections(body) {
  const rewriteMatch = body.match(/# Rewrite Prompt\s*\n([\s\S]*?)(?=\n# Review Prompt|$)/);
  const reviewMatch = body.match(/# Review Prompt\s*\n([\s\S]*)$/);

  return {
    rewritePrompt: rewriteMatch ? rewriteMatch[1].trim() : "",
    reviewPrompt: reviewMatch ? reviewMatch[1].trim() : "",
  };
}

/**
 * Load a rewrite definition by name.
 * Lookup: local _templates/rewrites/ > builtin rewrites/
 */
export function loadRewrite(name, baseDir) {
  const localDir = join(baseDir, "outputs", "_templates", "rewrites");
  const localComponentsDir = join(baseDir, "outputs", "_templates", "components");

  function loadFromPath(filePath) {
    const content = readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(content);
    const resolved = resolveIncludes(body, localComponentsDir);
    const sections = parseRewriteSections(resolved);
    return { ...meta, ...sections, path: filePath };
  }

  const localPath = join(localDir, `${name}.md`);
  if (existsSync(localPath)) return loadFromPath(localPath);

  const builtinPath = join(BUILTIN_REWRITES_DIR, `${name}.md`);
  if (existsSync(builtinPath)) return loadFromPath(builtinPath);

  return null;
}

/**
 * List all available rewrite definitions.
 */
export function listRewrites(baseDir) {
  const rewrites = [];
  const seen = new Set();

  const localDir = join(baseDir, "outputs", "_templates", "rewrites");
  if (existsSync(localDir)) {
    for (const f of readdirSync(localDir).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(/\.md$/, "");
      rewrites.push({ name, source: "local", path: join(localDir, f) });
      seen.add(name);
    }
  }

  if (existsSync(BUILTIN_REWRITES_DIR)) {
    for (const f of readdirSync(BUILTIN_REWRITES_DIR).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(/\.md$/, "");
      if (!seen.has(name)) {
        rewrites.push({ name, source: "builtin", path: join(BUILTIN_REWRITES_DIR, f) });
      }
    }
  }

  return rewrites;
}

// ---------------------------------------------------------------------------
// Source context resolution — auto-load refs from output frontmatter
// ---------------------------------------------------------------------------

function parseOutputFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
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
    const topKv = lines[i].match(/^([\w][\w-]*):\s*(.+)$/);
    if (topKv) {
      const val = topKv[2].trim();
      if (val === "true" || val === "false") {
        meta[topKv[1]] = val === "true";
      } else {
        meta[topKv[1]] = val;
      }
    }
    i++;
  }
  return { meta, body: m[2] };
}

/**
 * Build source_context from output file's refs metadata.
 * Reads journal and groups files referenced in frontmatter, truncating to limit.
 */
function buildSourceContext(meta, baseDir) {
  const refs = meta.refs;
  if (!refs) return "";

  const parts = [];
  let totalChars = 0;

  const journalPaths = Array.isArray(refs.journal) ? refs.journal : [];
  for (const relPath of journalPaths) {
    if (totalChars >= SOURCE_CONTEXT_MAX_CHARS) break;
    const absPath = join(baseDir, relPath);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf-8");
    const remaining = SOURCE_CONTEXT_MAX_CHARS - totalChars;
    const snippet = content.length > remaining ? content.slice(0, remaining) + "\n...(截断)" : content;
    parts.push(`### ${basename(relPath)}\n\n${snippet}`);
    totalChars += snippet.length;
  }

  const groupPaths = Array.isArray(refs.groups) ? refs.groups : [];
  for (const relPath of groupPaths) {
    if (totalChars >= SOURCE_CONTEXT_MAX_CHARS) break;
    const absPath = join(baseDir, relPath);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf-8");
    const remaining = SOURCE_CONTEXT_MAX_CHARS - totalChars;
    const snippet = content.length > remaining ? content.slice(0, remaining) + "\n...(截断)" : content;
    parts.push(`### ${basename(relPath)}\n\n${snippet}`);
    totalChars += snippet.length;
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Core: runRewrite
// ---------------------------------------------------------------------------

/**
 * Rewrite a single file using a rewrite definition.
 *
 * @param {object} opts
 * @param {string}   opts.inputPath     - absolute path to the file to rewrite
 * @param {string}   opts.rewriteName   - rewrite definition name
 * @param {string}   opts.baseDir       - knowledge base root (for ref resolution)
 * @param {function} opts.callAgent     - (prompt) => Promise<string>
 * @param {string}   [opts.outputDir]   - override output directory
 * @param {boolean}  [opts.force=false] - overwrite existing rewrites
 * @param {boolean}  [opts.review=false]
 * @param {boolean}  [opts.dryRun=false]
 * @param {function} [opts.log]
 * @param {function} [opts.warn]
 * @returns {{ status: string, file: string, outputPath?: string, review?: object }}
 */
export async function runRewrite({
  inputPath,
  rewriteName,
  baseDir,
  callAgent,
  outputDir: outputDirOverride,
  force = false,
  review: enableReview = false,
  dryRun = false,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const rewriteDef = loadRewrite(rewriteName, baseDir);
  if (!rewriteDef) {
    const available = listRewrites(baseDir).map((r) => r.name).join(", ");
    return { status: "error", file: basename(inputPath), error: `改写定义 "${rewriteName}" 未找到。可用: ${available || "无"}` };
  }

  if (!rewriteDef.rewritePrompt) {
    return { status: "error", file: basename(inputPath), error: `改写定义 "${rewriteName}" 未包含 # Rewrite Prompt 区段` };
  }

  if (!existsSync(inputPath)) {
    return { status: "error", file: basename(inputPath), error: `输入文件不存在: ${inputPath}` };
  }

  const inputDir = dirname(inputPath);
  const filename = basename(inputPath);
  const rewriteDir = outputDirOverride || join(inputDir, "_rewrites", rewriteName);
  const outPath = join(rewriteDir, filename);

  if (existsSync(outPath) && !force) {
    const outMtime = statSync(outPath).mtimeMs;
    const inMtime = statSync(inputPath).mtimeMs;
    if (outMtime >= inMtime) {
      return { status: "skipped", file: filename, outputPath: outPath };
    }
  }

  const rawContent = readFileSync(inputPath, "utf-8");
  const { meta, body } = parseOutputFrontmatter(rawContent);
  const articleContent = body.trim();

  const sourceContext = baseDir ? buildSourceContext(meta, baseDir) : "";

  let prompt = rewriteDef.rewritePrompt;
  prompt = prompt.replaceAll("{{article_content}}", articleContent);
  prompt = prompt.replaceAll("{{source_context}}", sourceContext || "（无补充素材）");

  if (dryRun) {
    log(`[dry-run] ${filename}: prompt ${prompt.length} chars`);
    return { status: "dry-run", file: filename };
  }

  log(`  改写 ${filename} (${rewriteName})...`);
  const t0 = Date.now();
  let rewritten;
  try {
    rewritten = await callAgent(prompt);
  } catch (e) {
    warn(`  LLM 调用失败 (${filename}): ${e.message}`);
    return { status: "error", file: filename, error: e.message };
  }
  const durationMs = Date.now() - t0;
  rewritten = stripCodeFences(rewritten.trim());

  if (!existsSync(rewriteDir)) mkdirSync(rewriteDir, { recursive: true });
  writeFileSync(outPath, rewritten + "\n", "utf-8");
  log(`  -> ${relative(baseDir || inputDir, outPath)} (${durationMs}ms)`);

  let reviewResult = null;
  if (enableReview && rewriteDef.reviewPrompt && callAgent) {
    try {
      let reviewPrompt = rewriteDef.reviewPrompt;
      reviewPrompt = reviewPrompt.replaceAll("{{rewritten_content}}", rewritten);
      reviewPrompt = reviewPrompt.replaceAll("{{article_content}}", articleContent);

      log("  审校中...");
      const report = await callAgent(reviewPrompt);
      const cleaned = stripCodeFences(report.trim());

      const scoreMatch = cleaned.match(/综合评分[：:]\s*(\d(?:\.\d)?)\s*\/\s*5/);
      const score = scoreMatch ? scoreMatch[1] : "?";

      const reviewDir = join(rewriteDir, "_reviews");
      if (!existsSync(reviewDir)) mkdirSync(reviewDir, { recursive: true });
      const reviewFile = filename.replace(/\.md$/, ".review.md");
      writeFileSync(join(reviewDir, reviewFile), cleaned + "\n", "utf-8");
      log(`  审校: ${score}/5 -> _reviews/${reviewFile}`);

      reviewResult = { score, report: cleaned };
    } catch (e) {
      warn(`  审校失败 (${filename}): ${e.message}`);
    }
  }

  return { status: "rewritten", file: filename, outputPath: outPath, durationMs, review: reviewResult };
}

// ---------------------------------------------------------------------------
// Batch: runRewriteBatch
// ---------------------------------------------------------------------------

/**
 * Rewrite all .md files in a directory.
 *
 * @param {object} opts
 * @param {string}   opts.inputDir
 * @param {string}   opts.rewriteName
 * @param {string}   opts.baseDir
 * @param {function} opts.callAgent
 * @param {string}   [opts.outputDir]
 * @param {boolean}  [opts.force=false]
 * @param {boolean}  [opts.review=false]
 * @param {boolean}  [opts.dryRun=false]
 * @param {function} [opts.log]
 * @param {function} [opts.warn]
 * @returns {{ success: boolean, message: string, results: Array }}
 */
export async function runRewriteBatch({
  inputDir,
  rewriteName,
  baseDir,
  callAgent,
  outputDir: outputDirOverride,
  force = false,
  review = false,
  dryRun = false,
  log = defaultLog,
  warn = defaultWarn,
}) {
  if (!existsSync(inputDir)) {
    return { success: false, message: `目录不存在: ${inputDir}`, results: [] };
  }

  const excluded = new Set(["README.md", "INDEX.md"]);
  const mdFiles = readdirSync(inputDir)
    .filter((f) => f.endsWith(".md") && !excluded.has(f) && !f.endsWith(".review.md"))
    .sort();

  if (mdFiles.length === 0) {
    return { success: true, message: "目录中无可改写的 .md 文件", results: [] };
  }

  heading("Rewrite 批量改写");
  log(`风格: ${rewriteName}, 文件: ${mdFiles.length} 个`);

  const results = [];
  for (let i = 0; i < mdFiles.length; i++) {
    log(`[${i + 1}/${mdFiles.length}] ${mdFiles[i]}`);
    const result = await runRewrite({
      inputPath: join(inputDir, mdFiles[i]),
      rewriteName,
      baseDir,
      callAgent,
      outputDir: outputDirOverride,
      force,
      review,
      dryRun,
      log,
      warn,
    });
    results.push(result);
  }

  const rewritten = results.filter((r) => r.status === "rewritten").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  heading("Rewrite 完成");
  log(`改写: ${rewritten}, 跳过: ${skipped}, 错误: ${errors}`);

  return {
    success: true,
    message: `完成: ${rewritten} 改写, ${skipped} 跳过, ${errors} 错误`,
    results,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism rewrite [选项]

对已有 markdown 文件执行风格改写。

选项:
  --style <name>       改写风格名（必填，除非 --list-styles）
  --file <path>        改写单个文件
  --dir <path>         批量改写目录下所有 .md 文件
  --output-dir <dir>   自定义输出目录（默认 _rewrites/<style>/）
  --force              覆盖已存在的改写结果
  --review             执行改写后审校
  --dry-run            只预览，不调用模型
  --list-styles        列出可用改写定义
  -h, --help           显示帮助

示例:
  js-knowledge-prism rewrite --list-styles
  js-knowledge-prism rewrite --style kzk-wechat --file outputs/practice-diary/P23/2026-03-01.md
  js-knowledge-prism rewrite --style kzk-wechat --dir outputs/practice-diary/P23/
  js-knowledge-prism rewrite --style kzk-wechat --dir outputs/practice-diary/P23/ --review
`.trim();

export async function run(args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      style: { type: "string" },
      file: { type: "string" },
      dir: { type: "string" },
      "output-dir": { type: "string" },
      force: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "list-styles": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { baseDir, config } = loadConfig();

  if (flags["list-styles"]) {
    const rewrites = listRewrites(baseDir);
    if (rewrites.length === 0) {
      console.log("没有可用的改写定义。");
      return;
    }
    console.log("\n可用改写定义:\n");
    for (const r of rewrites) {
      const def = loadRewrite(r.name, baseDir);
      console.log(`  ${r.name} (${r.source})`);
      if (def?.description) console.log(`    ${def.description}`);
      if (def?.platform) console.log(`    平台: ${def.platform}`);
      console.log();
    }
    return;
  }

  if (!flags.style) {
    console.error("错误: 必须指定 --style（或使用 --list-styles 查看可用定义）\n");
    console.log(HELP);
    process.exit(1);
  }

  if (!flags.file && !flags.dir) {
    console.error("错误: 必须指定 --file 或 --dir\n");
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

  if (flags.file) {
    const inputPath = resolve(flags.file);
    const result = await runRewrite({
      inputPath,
      rewriteName: flags.style,
      baseDir,
      callAgent,
      outputDir: flags["output-dir"],
      force: flags.force,
      review: flags.review,
      dryRun: flags["dry-run"],
    });

    if (result.status === "error") {
      console.error(`错误: ${result.error}`);
      process.exit(1);
    }
    console.log(`${result.status}: ${result.file}`);
    return;
  }

  if (flags.dir) {
    const inputDir = resolve(flags.dir);
    return runRewriteBatch({
      inputDir,
      rewriteName: flags.style,
      baseDir,
      callAgent,
      outputDir: flags["output-dir"],
      force: flags.force,
      review: flags.review,
      dryRun: flags["dry-run"],
    });
  }
}

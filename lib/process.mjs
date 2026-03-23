import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { runAgentIndex } from "./agent-index.mjs";
import { loadConfig } from "./config.mjs";
import {
  extractTitle,
  heading,
  isPlaceholder,
  listCorpusFiles,
  listDateDirs,
  listMdFiles,
  listSeriesDirs,
  log as defaultLog,
  makePaths,
  parseAbbrevTable,
  read,
  stripCodeFences,
  warn as defaultWarn,
} from "./utils.mjs";

// ---------------------------------------------------------------------------
// HTTP caller (standalone, no openclaw dependency)
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `你是一个知识管理专家，擅长从技术文档中提取结构化知识。
请严格按照用户指令的格式输出，不要添加多余的解释。`;

function httpRequest(url, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Create a callAgent function backed by an OpenAI-compatible HTTP API.
 * Returns: (prompt: string) => Promise<string>
 */
export function createHttpCaller({
  baseUrl,
  apiKey,
  model,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  temperature = 0.3,
  maxTokens = 8192,
  timeoutMs = 1_800_000,
  log = defaultLog,
}) {
  return async function callAgent(prompt) {
    log(`调用模型 (prompt ${prompt.length} chars, model=${model})...`);

    const url = `${baseUrl}/chat/completions`;
    const payload = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    });

    const resp = await httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload,
      timeoutMs,
    );

    if (resp.status !== 200) {
      throw new Error(`API error ${resp.status}: ${resp.body.slice(0, 500)}`);
    }

    const json = JSON.parse(resp.body);
    const text = json.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(`Empty response: ${JSON.stringify(json).slice(0, 500)}`);
    }
    log(`模型返回 ${text.length} chars`);
    return text;
  };
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** Extract the 0-padded article number from a corpus filename (e.g. "0010-xxx.md" → "0010"). */
function extractArticleNum(filename) {
  const m = filename.match(/^(\d+)/);
  return m ? m[1] : null;
}

function discoverSources(paths, onlyFile, onlySeries) {
  const abbrevReadme = read(paths.atomsReadme);
  const { fileToAbbrev, usedAbbrevs } = parseAbbrevTable(abbrevReadme);
  const results = [];

  // --- Journal sources ---
  if (!onlySeries) {
    for (const dateDir of listDateDirs(paths.journalDir)) {
      const month = dateDir.slice(0, 7);
      const mdFiles = listMdFiles(join(paths.journalDir, dateDir));

      for (const mdFile of mdFiles) {
        const stem = mdFile.replace(/\.md$/, "");
        const journalPath = join(paths.journalDir, dateDir, mdFile);
        const atomMonthDir = join(paths.atomsDir, month);
        const atomPath = join(atomMonthDir, mdFile);

        if (onlyFile && mdFile !== onlyFile) continue;

        if (!existsSync(atomPath)) {
          const abbrev = fileToAbbrev.get(stem) || null;
          results.push({ type: "A", source: "journal", stem, journalPath, atomPath, atomMonthDir, dateDir, month, abbrev });
        } else if (isPlaceholder(atomPath)) {
          const abbrev = fileToAbbrev.get(stem) || null;
          results.push({ type: "B", source: "journal", stem, journalPath, atomPath, atomMonthDir, dateDir, month, abbrev });
        }
      }
    }
  }

  // --- Corpus sources ---
  for (const series of listSeriesDirs(paths.corpusDir)) {
    if (onlySeries && series !== onlySeries) continue;
    const seriesDir = join(paths.corpusDir, series);
    const atomSeriesDir = join(paths.atomsDir, `corpus-${series}`);
    const seriesAbbrev = fileToAbbrev.get(`corpus:${series}`) || null;

    for (const mdFile of listCorpusFiles(seriesDir)) {
      const stem = mdFile.replace(/\.md$/, "");
      const filePath = join(seriesDir, mdFile);
      const atomPath = join(atomSeriesDir, mdFile);
      const articleNum = extractArticleNum(mdFile);

      if (onlyFile && mdFile !== onlyFile) continue;

      if (!existsSync(atomPath)) {
        results.push({
          type: "A", source: "corpus", stem, journalPath: filePath,
          atomPath, atomMonthDir: atomSeriesDir,
          dateDir: `corpus/${series}`, month: `corpus-${series}`,
          abbrev: seriesAbbrev, series, articleNum,
        });
      } else if (isPlaceholder(atomPath)) {
        results.push({
          type: "B", source: "corpus", stem, journalPath: filePath,
          atomPath, atomMonthDir: atomSeriesDir,
          dateDir: `corpus/${series}`, month: `corpus-${series}`,
          abbrev: seriesAbbrev, series, articleNum,
        });
      }
    }
  }

  return { results, fileToAbbrev, usedAbbrevs };
}

/** Regex that matches both journal atom IDs (XX-01) and corpus atom IDs (XX-0010-01). */
const ATOM_ID_RE = /([A-Z]{2})-(?:\d{4}-)?\d{2}/;
const ATOM_ID_TABLE_RE_G = new RegExp(`\\|\\s*(${ATOM_ID_RE.source})\\s*\\|`, "g");

export function collectGroupedPrefixes(paths) {
  const prefixes = new Set();
  if (!existsSync(paths.groupsDir)) return prefixes;
  const groupFiles = listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G"));

  let abbrevMap = null;

  for (const f of groupFiles) {
    const content = read(join(paths.groupsDir, f));
    const matches = content.matchAll(ATOM_ID_TABLE_RE_G);
    for (const m of matches) prefixes.add(m[1].slice(0, 2));

    // Fallback: when atom IDs use a non-standard format (e.g. LLM-generated
    // "0001-CONSTITUTION-01" instead of "CN-0001-01"), resolve abbreviation
    // via the "来源" column cross-referenced with the abbrev mapping table.
    for (const line of content.split("\n")) {
      if (!line.startsWith("|") || line.includes("---|---")) continue;
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length < 2) continue;
      if (ATOM_ID_RE.test(cols[0])) continue;
      const source = cols[1];
      if (!source || !/\w/.test(source) || /^来源/.test(source)) continue;

      if (!abbrevMap) {
        const readme = existsSync(paths.atomsReadme) ? read(paths.atomsReadme) : "";
        abbrevMap = parseAbbrevTable(readme);
      }

      if (abbrevMap.fileToAbbrev.has(source)) {
        prefixes.add(abbrevMap.fileToAbbrev.get(source));
        continue;
      }

      // Source might be a file within a corpus series — scan corpus-* atom subdirs
      if (existsSync(paths.atomsDir)) {
        for (const sub of readdirSync(paths.atomsDir)) {
          if (!sub.startsWith("corpus-")) continue;
          if (existsSync(join(paths.atomsDir, sub, `${source}.md`))) {
            const series = sub.slice("corpus-".length);
            const seriesKey = `corpus:${series}`;
            if (abbrevMap.fileToAbbrev.has(seriesKey)) {
              prefixes.add(abbrevMap.fileToAbbrev.get(seriesKey));
            }
            break;
          }
        }
      }
    }
  }
  return prefixes;
}

/** Accept both YYYY-MM and corpus-* atom subdirectories. */
const ATOM_SUBDIR_RE = /^(\d{4}-\d{2}|corpus-.+)$/;

function collectAllAtomPaths(paths) {
  const atomPaths = [];
  if (!existsSync(paths.atomsDir)) return atomPaths;
  for (const sub of readdirSync(paths.atomsDir)) {
    const subDir = join(paths.atomsDir, sub);
    if (!statSync(subDir).isDirectory() || !ATOM_SUBDIR_RE.test(sub)) continue;
    for (const f of listMdFiles(subDir)) {
      const p = join(subDir, f);
      if (!isPlaceholder(p)) atomPaths.push(p);
    }
  }
  return atomPaths.toSorted((a, b) => a.localeCompare(b));
}

function collectUngroupedAtomPaths(paths) {
  const grouped = collectGroupedPrefixes(paths);
  return collectAllAtomPaths(paths).filter((p) => {
    const content = read(p);
    const m = content.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
    return m ? !grouped.has(m[1]) : true;
  });
}

function collectAllGroupPaths(paths) {
  if (!existsSync(paths.groupsDir)) return [];
  return listMdFiles(paths.groupsDir)
    .filter((f) => /^G\d+/.test(f))
    .toSorted()
    .map((f) => join(paths.groupsDir, f));
}

export function condensedGroupSummary(groupPath) {
  const content = read(groupPath);
  const titleMatch = content.match(/^#\s+(G\d+)[：:]\s*(.+)$/m);
  const gId = titleMatch ? titleMatch[1] : basename(groupPath, ".md").match(/^(G\d+)/)?.[1] || "G??";
  const thesis = titleMatch ? titleMatch[2].trim() : extractTitle(content);
  const atomIds = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([A-Z]{2}-(?:\d{4}-)?\d{2})\s*\|/);
    if (m) atomIds.push(m[1]);
  }
  return `**${gId}** — ${thesis}\n  Atoms: ${atomIds.join(", ") || "(无)"}`;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const ATOM_EXAMPLE = `# 个人知识库架构设计过程

> 来源：[../../../../journal/2026-02-22/knowledge-base-architecture-design.md](../../../../journal/2026-02-22/knowledge-base-architecture-design.md)
> 缩写：KA

## Atoms

| 编号  | 类型 | 内容                                                                                               | 原文定位                    |
| ----- | ---- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| KA-01 | 事实 | 积累了 20 篇按日期组织的原始学习笔记，适合记录过程但不适合教学或知识复用                           | 背景                        |
| KA-02 | 判断 | 按时间组织的文档存在四个问题：无阅读顺序、主题散落在时间线、深浅混杂、缺少中心论点                 | 问题分析                    |
| KA-03 | 事实 | 自上而下方法：从结论出发，用 SCQA 构造序言验证，逐层展开并保证 MECE，适用于结论清晰时              | 金字塔原理 > 自上而下       |`;

function buildAtomPrompt(entry, usedAbbrevs, paths) {
  const sourceContent = read(entry.journalPath);
  const sourceTitle = extractTitle(sourceContent);
  const isCorpus = entry.source === "corpus";

  // Build relative path from atom location back to source
  const relPath = isCorpus
    ? `../../../../corpus/${entry.series}/${basename(entry.journalPath)}`
    : `../../../../journal/${entry.dateDir}/${basename(entry.journalPath)}`;

  // Abbreviation instruction differs for corpus vs journal
  let abbrevInstruction = "";
  if (isCorpus) {
    if (entry.abbrev) {
      const numPrefix = entry.articleNum || "0000";
      abbrevInstruction = `
## 缩写

该系列的缩写为：**${entry.abbrev}**，本文编号为 ${numPrefix}。
请使用 ${entry.abbrev}-${numPrefix}-01, ${entry.abbrev}-${numPrefix}-02, ... 作为 atom 编号。
`;
    } else {
      const taken = [...usedAbbrevs].toSorted((a, b) => a.localeCompare(b)).join(", ");
      const numPrefix = entry.articleNum || "0000";
      abbrevInstruction = `
## 缩写分配

请为此系列（${entry.series}）分配一个 2 字母大写缩写。
已使用的缩写（不可重复）：${taken}
请选择一个有意义且未被占用的缩写。在输出的第二行 "> 缩写：XX" 处填入。
本文编号为 ${numPrefix}，atom 编号格式为 XX-${numPrefix}-01, XX-${numPrefix}-02, ...
`;
    }
  } else if (entry.abbrev) {
    abbrevInstruction = `
## 缩写

该 journal 的缩写为：**${entry.abbrev}**，请使用 ${entry.abbrev}-01, ${entry.abbrev}-02, ... 作为编号。
`;
  } else {
    const taken = [...usedAbbrevs].toSorted((a, b) => a.localeCompare(b)).join(", ");
    abbrevInstruction = `
## 缩写分配

请为这篇 journal 分配一个 2 字母大写缩写（用于 atom 编号前缀）。
已使用的缩写（不可重复）：${taken}
请选择一个有意义且未被占用的缩写。在输出的第二行 "> 缩写：XX" 处填入。
`;
  }

  // Series context injection for corpus
  let seriesContext = "";
  if (isCorpus && paths) {
    const seriesMetaPath = join(paths.corpusDir, entry.series, "_series.md");
    if (existsSync(seriesMetaPath)) {
      seriesContext += `\n## 系列概述\n\n${read(seriesMetaPath)}\n`;
    }
    const allFiles = listCorpusFiles(join(paths.corpusDir, entry.series));
    const idx = allFiles.indexOf(basename(entry.journalPath));
    if (idx >= 0) {
      const prevFile = idx > 0 ? allFiles[idx - 1] : null;
      const nextFile = idx < allFiles.length - 1 ? allFiles[idx + 1] : null;
      seriesContext += `\n## 系列上下文\n\n- 当前文章在系列中的位置：第 ${idx + 1} / ${allFiles.length} 篇\n`;
      if (prevFile) seriesContext += `- 上一篇：${prevFile}\n`;
      if (nextFile) seriesContext += `- 下一篇：${nextFile}\n`;
    }
  }

  const sourceLabel = isCorpus ? "文章" : "journal";

  return `你是一个知识库助手。你的任务是从下方的${sourceLabel}原文中提取信息单元（atoms）。

## 输出要求

请直接输出完整的 atom markdown 文件内容（不要包裹在代码块中）。严格遵循以下格式：

1. 第一行：# [${sourceLabel}的标题]
2. 空行后：> 来源：[相对路径链接](相对路径链接)
3. 紧接：> 缩写：XX
4. 空行后：## Atoms
5. 然后是 atom 表格

## Atom 提取规则

- 每个 atom 是不可再拆的最小信息单元
- 类型只能是：事实、步骤、经验、判断
  - 事实：客观存在的概念、定义、架构描述
  - 步骤：具体的操作方法、命令、配置过程
  - 经验：踩坑记录、最佳实践、非显而易见的发现
  - 判断：主观评估、可行性结论、取舍决策
- "内容"列用一句话简明描述该知识点
- "原文定位"列写出在${sourceLabel}中的章节名
- 编号从 01 开始递增
${abbrevInstruction}
## 参考范例（仅展示前几行）

${ATOM_EXAMPLE}

## 本次提取的${sourceLabel}信息

- 标题：${sourceTitle}
- 来源路径：${relPath}
- 日期目录：${entry.dateDir}
${seriesContext}
## ${sourceLabel}原文

${sourceContent}
`;
}

function condensedAtomSummary(atomPath) {
  const content = read(atomPath);
  const title = extractTitle(content);
  const abbrevMatch = content.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
  const abbrev = abbrevMatch ? abbrevMatch[1] : "??";
  const rows = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([A-Z]{2}-(?:\d{4}-)?\d{2})\s*\|[^|]*\|\s*([^|]+?)\s*\|/);
    if (m) rows.push(`- ${m[1]}: ${m[2].trim()}`);
  }
  return `**${abbrev}** (${basename(atomPath, ".md")}) — ${title}\n${rows.join("\n")}`;
}

function findMaxGroupNum(paths) {
  const groupFiles = listMdFiles(paths.groupsDir).filter((f) => /^G\d+/.test(f));
  let max = 0;
  for (const f of groupFiles) {
    const m = f.match(/^G(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function buildGroupsPrompt(paths, newAtomPaths, autoWrite) {
  const newAtomsContent = newAtomPaths.map((p) => condensedAtomSummary(p)).join("\n\n");
  const groupsIndex = read(paths.groupsIndex);
  const maxG = findMaxGroupNum(paths);
  const today = new Date().toISOString().slice(0, 10);

  if (!autoWrite) {
    return `你是一个知识库助手。以下是刚提取的新 atoms 文件，以及现有的分组（groups）结构。

## 任务

请分析新 atoms，给出分组建议：
1. 哪些新 atoms 应归入哪些现有 group？（列出 atom 编号 → group 编号）
2. 是否需要新建 group？如果需要，给出编号（接着 G${String(maxG).padStart(2, "0")} 继续）、观点句和包含的 atoms。
3. 是否有现有 group 需要拆分或合并？

请用中文回答，用表格或列表清晰列出建议。

## 现有分组

${groupsIndex}

## 新提取的 Atoms

${newAtomsContent}
`;
  }

  return `你是一个知识库助手。以下是待归组的 atoms 和现有分组索引。

## 任务

分析新 atoms，执行分组更新。输出必须使用下面的分隔符格式，脚本将自动解析并写入文件。

### 操作类型

1. **新建 group**：如果新 atoms 形成了与现有 group 都不匹配的新主题，创建新 group。编号从 G${String(maxG + 1).padStart(2, "0")} 开始。
2. **更新现有 group**：如果新 atoms 应归入现有 group，输出该 group 的完整更新后内容（包含旧 atoms + 新 atoms）。
3. **不归组的 atoms**：如果某些 atoms 暂时无法归组，在 CHANGELOG 中注明。

### 输出格式（严格遵守，不要添加任何额外文字）

对每个新建或更新的 group，输出一个块：

\`\`\`
=== GROUP: G12-topic-slug.md ===
（完整的 group 文件内容，遵循下方模板）
=== END ===
\`\`\`

所有 group 块输出完毕后，输出 INDEX 更新块：

\`\`\`
=== INDEX_ROWS ===
（只输出新增或修改的行，每行格式与 INDEX.md 表格一致）
| G12 | 观点句 | atom数量 | 来源月份跨度 |
=== END ===
\`\`\`

最后输出 CHANGELOG 块：

\`\`\`
=== CHANGELOG ===
| ${today} | 操作描述 | 原因说明 |
=== END ===
\`\`\`

### Group 文件模板

\`\`\`markdown
# GXX: [一句有态度的观点句]

> 一句有态度的判断句，概括这组信息单元说明了什么。

## 包含的 Atoms

| 编号  | 来源                     | 内容摘要 |
| ----- | ------------------------ | -------- |
| XX-01 | source-file-stem         | ...      |

## 组内逻辑顺序

说明 atoms 的排列逻辑（时间顺序 / 结构顺序 / 程度顺序）。
\`\`\`

### 规则

- 每个 group 的观点句必须是一句有态度的判断句
- "来源"列填来源文件名（不含 .md），journal 或 corpus 均可
- 更新现有 group 时，保留原有的所有 atoms，在表格末尾追加新 atoms
- atom 数量统计必须准确
- 来源月份跨度包括所有 atom 的来源月份

## 现有分组 INDEX

${groupsIndex}

## 待归组的 Atoms

${newAtomsContent}
`;
}

function buildSynthesisPrompt(paths, groupPaths, autoWrite, { incremental = false } = {}) {
  const synthesisContent = read(paths.synthesisPath);
  const groupsIndex = read(paths.groupsIndex);
  const groupsSummary = groupPaths.map((p) => condensedGroupSummary(p)).join("\n\n");
  const today = new Date().toISOString().slice(0, 10);

  const scopeLabel = incremental ? "本轮新增/更新的 Groups" : "全部 Groups";
  const scopeNote = incremental
    ? "\n注意：以下仅列出本轮新增或更新的 groups。请在现有候选基础上**增量评估**，不要丢弃已有候选。\n"
    : "";

  if (!autoWrite) {
    return `你是一个知识库助手。以下是当前的 synthesis（顶层观点候选列表）和 groups 观点句摘要。

## 任务

请评估：
1. 现有顶层观点候选是否仍然准确？
2. groups 的观点句是否支持现有候选，还是暗示需要新增/修改候选？
3. 候选间的关系描述是否需要更新？

请用中文回答，给出具体建议。如果无需修改，简要说明即可。

## 当前 Synthesis

${synthesisContent}

## 当前分组 INDEX

${groupsIndex}
${scopeNote}
## ${scopeLabel}摘要

${groupsSummary}
`;
  }

  return `你是一个知识库助手。请基于 groups 观点句更新 synthesis.md 文件。

## 任务

1. 评估现有顶层观点候选是否仍然准确
2. 判断 groups 的观点句是否支持现有候选，或需要新增/修改/升级候选
3. 更新候选间的关系描述
4. 在修订记录表中追加今天（${today}）的变更条目

## 输出要求

直接输出完整的、更新后的 synthesis.md 文件内容（不要用代码块包裹）。

保持文件的现有结构不变：
- # 收敛（Synthesis）标题和说明
- ## 顶层观点候选 表格
- ### 待成熟候选 表格（如适用）
- ## 候选间的关系
- 视角索引链接
- ## 修订记录 表格

### 规则

- 只在有充分证据时才新增/升级/修改候选
- 保持 S1, S2, ... 编号连续
- 待成熟候选用 S*（如 S7*）标记
- 当待成熟候选获得第二个 group 支撑时，升级为正式候选
- 如果没有需要修改的地方，输出原文即可（仍需追加修订记录说明"无变更"）
- 修订记录的日期格式为 YYYY-MM-DD

## 当前 synthesis.md 完整内容

${synthesisContent}

## 当前分组 INDEX

${groupsIndex}
${scopeNote}
## ${scopeLabel}摘要

${groupsSummary}
`;
}

// ---------------------------------------------------------------------------
// Output parsers and writers
// ---------------------------------------------------------------------------

function extractAbbrevFromOutput(output) {
  const m = output.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
  return m ? m[1] : null;
}

export function generateAbbrevCandidates(stem) {
  const words = stem.split(/[-_]+/).filter(Boolean);
  const uppers = words.map((w) => w[0].toUpperCase()).filter((c) => /[A-Z]/.test(c));
  const candidates = [];

  for (let i = 0; i < uppers.length; i++) {
    for (let j = i + 1; j < uppers.length; j++) {
      candidates.push(uppers[i] + uppers[j]);
    }
  }

  for (const w of words) {
    const u = w.toUpperCase();
    if (u.length >= 2 && /^[A-Z]+$/.test(u.slice(0, 2))) candidates.push(u.slice(0, 2));
  }

  for (let i = 0; i < uppers.length; i++) {
    for (const w of words) {
      const consonants = w.toUpperCase().match(/[BCDFGHJKLMNPQRSTVWXYZ]/g) || [];
      for (const c of consonants) {
        if (uppers[i] + c !== candidates[0]) candidates.push(uppers[i] + c);
      }
    }
  }

  return [...new Set(candidates)];
}

export function resolveAbbrevConflict(stem, usedAbbrevs) {
  for (const candidate of generateAbbrevCandidates(stem)) {
    if (!usedAbbrevs.has(candidate)) return candidate;
  }
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const ab = String.fromCharCode(a) + String.fromCharCode(b);
      if (!usedAbbrevs.has(ab)) return ab;
    }
  }
  return null;
}

export function replaceAbbrevInOutput(output, oldAbbrev, newAbbrev) {
  return output
    .replace(
      new RegExp(`(>\\s*缩写[：:]\\s*)${oldAbbrev}`, "g"),
      `$1${newAbbrev}`,
    )
    .replace(
      new RegExp(`\\b${oldAbbrev}-(\\d{2,4}-\\d{2}|\\d{2})\\b`, "g"),
      (_, tail) => `${newAbbrev}-${tail}`,
    );
}

function validateAtomOutput(output) {
  const issues = [];
  if (!output.match(/^#\s+/m)) issues.push("缺少标题行（# ...）");
  if (!output.match(/>\s*来源[：:]/)) issues.push("缺少来源行（> 来源：...）");
  if (!output.includes("## Atoms")) issues.push("缺少 ## Atoms 标题");
  if (!output.includes("| 编号")) issues.push("缺少 atom 表格");
  if (!output.match(/\|\s*[A-Z]{2}-(?:\d{4}-)?\d{2}\s*\|/)) issues.push("未找到任何 atom 行（如 XX-01 或 XX-0010-01）");
  return issues;
}

function parseGroupsOutput(raw) {
  const result = { groups: [], indexRows: [], changelog: [] };

  const groupRegex = /=== GROUP: (\S+\.md) ===([\s\S]*?)(?:=== END ===)/g;
  let m;
  while ((m = groupRegex.exec(raw)) !== null) {
    result.groups.push({ filename: m[1].trim(), content: m[2].trim() });
  }

  const indexMatch = raw.match(/=== INDEX_ROWS ===([\s\S]*?)(?:=== END ===)/);
  if (indexMatch) {
    result.indexRows = indexMatch[1].trim().split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  }

  const changelogMatch = raw.match(/=== CHANGELOG ===([\s\S]*?)(?:=== END ===)/);
  if (changelogMatch) {
    result.changelog = changelogMatch[1].trim().split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  }

  return result;
}

function writeGroupsOutput(paths, parsed, log) {
  let written = 0;
  let updated = 0;
  const touchedPaths = [];

  for (const g of parsed.groups) {
    const gPath = join(paths.groupsDir, g.filename);
    const isNew = !existsSync(gPath);
    writeFileSync(gPath, g.content + "\n", "utf-8");
    touchedPaths.push(gPath);
    if (isNew) { written++; log(`✓ 新建 ${g.filename}`); }
    else { updated++; log(`✓ 更新 ${g.filename}`); }
  }

  if (parsed.indexRows.length > 0 || parsed.changelog.length > 0) {
    let index = read(paths.groupsIndex);

    if (parsed.indexRows.length > 0) {
      const changelogHeadingIdx = index.indexOf("## 变更日志");
      if (changelogHeadingIdx >= 0) {
        const tableSection = index.slice(0, changelogHeadingIdx);
        const lastPipeIdx = tableSection.lastIndexOf("|");
        if (lastPipeIdx >= 0) {
          const insertAfterNewline = tableSection.indexOf("\n", lastPipeIdx);
          const insertPos = insertAfterNewline >= 0 ? insertAfterNewline : tableSection.length;

          const newRows = parsed.indexRows.filter((row) => {
            const gNumMatch = row.match(/\|\s*(G\d+)\s*\|/);
            if (!gNumMatch) return false;
            return !index.includes(gNumMatch[1] + " ");
          });

          const updatedRows = parsed.indexRows.filter((row) => {
            const gNumMatch = row.match(/\|\s*(G\d+)\s*\|/);
            if (!gNumMatch) return false;
            return index.includes(gNumMatch[1] + " ");
          });

          for (const uRow of updatedRows) {
            const gNumMatch = uRow.match(/\|\s*(G\d+)\s*\|/);
            if (gNumMatch) {
              const oldRowRegex = new RegExp(`^\\|\\s*${gNumMatch[1]}\\s*\\|.*$`, "m");
              index = index.replace(oldRowRegex, uRow.trim());
            }
          }

          if (newRows.length > 0) {
            index = index.slice(0, insertPos) + "\n" + newRows.join("\n") + index.slice(insertPos);
          }
        }
      }
    }

    if (parsed.changelog.length > 0) {
      const trimmed = index.trimEnd();
      index = trimmed + "\n" + parsed.changelog.join("\n") + "\n";
    }

    writeFileSync(paths.groupsIndex, index, "utf-8");
    log(`✓ 已更新 INDEX.md (${parsed.indexRows.length} 行索引, ${parsed.changelog.length} 行日志)`);
  }

  return { written, updated, touchedPaths };
}

// ---------------------------------------------------------------------------
// runPipeline — programmatic API (callable from plugins)
// ---------------------------------------------------------------------------

/**
 * Run the pyramid processing pipeline programmatically.
 *
 * @param {object} opts
 * @param {string}   opts.baseDir    - Knowledge prism root directory
 * @param {object}   opts.config     - Config object (needs config.process.batchSize)
 * @param {function} opts.callAgent  - (prompt: string) => Promise<string>
 * @param {boolean}  [opts.dryRun=false]
 * @param {boolean}  [opts.autoWrite=false]
 * @param {number}   [opts.maxStage=3]
 * @param {string}   [opts.onlyFile]
 * @param {boolean}  [opts.verbose=false]
 * @param {function} [opts.log]
 * @param {function} [opts.warn]
 * @returns {Promise<{atomsProcessed: number, groupsWritten: number, groupsUpdated: number, synthesisUpdated: boolean}>}
 */
export async function runPipeline({
  baseDir,
  config,
  callAgent,
  dryRun = false,
  autoWrite = false,
  maxStage = 3,
  onlyFile,
  onlySeries,
  verbose = false,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const summary = { atomsProcessed: 0, groupsWritten: 0, groupsUpdated: 0, synthesisUpdated: false };

  // --- Atom writer helpers (need baseDir & paths in closure) ---

  function registerAbbrev(stem, abbrev, month) {
    const readme = read(paths.atomsReadme);
    const stemCell = stem.length > 37 ? `${stem.slice(0, 34)}...` : stem.padEnd(37);
    const newRow = `| ${abbrev}   | ${stemCell} | ${month} |`;
    const lines = readme.split("\n");
    let inFence = false;
    let inAbbrevSection = false;
    let lastDataRowIdx = -1;
    let separatorAfterHeaderIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("```")) { inFence = !inFence; continue; }
      if (inFence) continue;

      if (/^##\s+.*缩写映射/.test(line)) {
        inAbbrevSection = true;
        lastDataRowIdx = -1;
        separatorAfterHeaderIdx = -1;
        continue;
      }
      if (inAbbrevSection && /^##\s+/.test(line)) {
        break;
      }
      if (!inAbbrevSection) continue;

      if (/^\|\s*[-]{2,}/.test(line) && /\|/.test(line)) {
        separatorAfterHeaderIdx = i;
        continue;
      }
      if (/^\|\s*[A-Z]{2}\s*\|/.test(line)) {
        lastDataRowIdx = i;
      }
    }

    const insertAfter =
      lastDataRowIdx >= 0 ? lastDataRowIdx : separatorAfterHeaderIdx;
    if (insertAfter < 0) {
      warn("无法定位缩写映射表末尾，请手动添加缩写");
      return;
    }
    lines.splice(insertAfter + 1, 0, newRow);
    writeFileSync(paths.atomsReadme, lines.join("\n"), "utf-8");
    log(`已在 atoms/README.md 注册缩写 ${abbrev} → ${stem}`);
  }

  async function processAtom(entry, usedAbbrevs) {
    // Corpus 系列缩写在首篇写入 README 后才可查；discover 阶段只读一次 README，故每篇处理前刷新映射
    if (entry.source === "corpus" && !entry.abbrev && existsSync(paths.atomsReadme)) {
      const { fileToAbbrev } = parseAbbrevTable(read(paths.atomsReadme));
      const seriesKey = `corpus:${entry.series}`;
      if (fileToAbbrev.has(seriesKey)) entry.abbrev = fileToAbbrev.get(seriesKey);
    }

    const prompt = buildAtomPrompt(entry, usedAbbrevs, paths);

    if (verbose) {
      log(`--- Prompt 预览 (${prompt.length} 字符) ---`);
      log(prompt.slice(0, 500));
      log("...");
    }

    if (dryRun) {
      log(`[dry-run] 将调用模型处理 ${entry.stem}`);
      log(`[dry-run] Prompt 长度: ${prompt.length} 字符`);
      return null;
    }

    log("调用模型...");
    let output;
    try {
      output = await callAgent(prompt);
    } catch (err) {
      warn(`调用失败: ${err.message?.slice(0, 200)}`);
      return null;
    }

    output = stripCodeFences(output.trim());

    const issues = validateAtomOutput(output);
    if (issues.length > 0) {
      warn(`输出格式校验失败:\n    ${issues.join("\n    ")}`);
      warn("跳过写入，原始输出:");
      log(output.slice(0, 1000));
      return null;
    }

    let abbrev = entry.abbrev;
    if (abbrev) {
      // Ensure model output uses the designated abbreviation
      const modelAbbrev = extractAbbrevFromOutput(output);
      if (modelAbbrev && modelAbbrev !== abbrev) {
        output = replaceAbbrevInOutput(output, modelAbbrev, abbrev);
      }
    } else {
      abbrev = extractAbbrevFromOutput(output);
      if (!abbrev) { warn("模型输出中未找到缩写，跳过"); return null; }
      if (usedAbbrevs.has(abbrev)) {
        const alt = resolveAbbrevConflict(entry.stem, usedAbbrevs);
        if (!alt) { warn(`模型生成的缩写 ${abbrev} 已被占用且无法自动分配替代缩写，跳过`); return null; }
        warn(`模型生成的缩写 ${abbrev} 已被占用，自动替换为 ${alt}`);
        output = replaceAbbrevInOutput(output, abbrev, alt);
        abbrev = alt;
      }
    }

    if (!existsSync(entry.atomMonthDir)) mkdirSync(entry.atomMonthDir, { recursive: true });

    writeFileSync(entry.atomPath, output + "\n", "utf-8");
    log(`✓ 已写入 ${relative(baseDir, entry.atomPath)}`);

    if (entry.type === "A" && !entry.abbrev) {
      const regKey = entry.source === "corpus" ? `corpus:${entry.series}` : entry.stem;
      registerAbbrev(regKey, abbrev, entry.month);
      usedAbbrevs.add(abbrev);
    }

    return { abbrev, atomPath: entry.atomPath };
  }

  // --- Main pipeline ---

  heading("金字塔增量处理");
  log(`配置: stage=${maxStage}, dry-run=${dryRun}, auto-write=${autoWrite}`);
  log(`根目录: ${baseDir}`);

  // Stage 1
  heading("阶段 1: 发现未处理的素材");
  const { results, usedAbbrevs } = discoverSources(paths, onlyFile, onlySeries);

  if (results.length === 0) {
    log("所有素材已处理完毕，无待处理条目。");
    if (maxStage < 2) return summary;
  }

  log(`发现 ${results.length} 个待处理条目:\n`);
  log("  类型  | 来源              | 文件名");
  log("  ----- | ----------------- | ------");
  for (const r of results) {
    log(`  ${r.type === "A" ? "新建" : "填充"}  | ${r.dateDir.padEnd(17)} | ${r.stem}.md`);
  }
  log("");

  const newAtomPaths = [];

  if (maxStage >= 1 && results.length > 0) {
    heading("阶段 1: 提取 Atoms");
    for (let i = 0; i < results.length; i++) {
      const entry = results[i];
      log(`\n[${i + 1}/${results.length}] ${entry.type === "A" ? "新建" : "填充"}: ${entry.stem}.md`);
      const result = await processAtom(entry, usedAbbrevs);
      if (result) newAtomPaths.push(result.atomPath);
    }
    summary.atomsProcessed = newAtomPaths.length;
    log(`\n阶段 1 完成: ${newAtomPaths.length}/${results.length} 个 atom 文件已处理`);
  }

  let atomPathsForGrouping = newAtomPaths;
  if (maxStage >= 2 && newAtomPaths.length === 0) {
    atomPathsForGrouping = collectUngroupedAtomPaths(paths);
    if (atomPathsForGrouping.length > 0) {
      log(`\n无新 atoms，使用 ${atomPathsForGrouping.length} 个未归组 atom 文件进行阶段 2/3`);
    }
  }

  // Stage 2
  let stage2GroupPaths = [];
  if (maxStage >= 2 && atomPathsForGrouping.length > 0) {
    heading(autoWrite ? "阶段 2: Groups 分组自动更新" : "阶段 2: Groups 分组建议");

    const BATCH_SIZE = config.process.batchSize;
    const batches = [];
    for (let i = 0; i < atomPathsForGrouping.length; i += BATCH_SIZE) {
      batches.push(atomPathsForGrouping.slice(i, i + BATCH_SIZE));
    }
    log(`共 ${atomPathsForGrouping.length} 个 atom 文件，分 ${batches.length} 批处理（每批 ${BATCH_SIZE}）`);

    let totalWritten = 0;
    let totalUpdated = 0;
    const newGroupPaths = [];

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      log(`\n--- 批次 ${bi + 1}/${batches.length} (${batch.map((p) => basename(p, ".md")).join(", ")}) ---`);

      const prompt = buildGroupsPrompt(paths, batch, autoWrite);
      if (verbose) log(`Prompt 长度: ${prompt.length} 字符`);

      if (dryRun) {
        log(`[dry-run] Prompt 长度: ${prompt.length} 字符`);
        continue;
      }

      log("调用模型...");
      try {
        const output = await callAgent(prompt);
        if (autoWrite) {
          const cleaned = stripCodeFences(output.trim());
          const parsed = parseGroupsOutput(cleaned);
          if (parsed.groups.length === 0 && parsed.indexRows.length === 0) {
            warn("模型未输出任何 group 块，打印原始输出供参考：");
            log(cleaned.slice(0, 2000));
          } else {
            const { written, updated, touchedPaths } = writeGroupsOutput(paths, parsed, log);
            totalWritten += written;
            totalUpdated += updated;
            newGroupPaths.push(...touchedPaths);
          }
        } else {
          log("\n--- 分组建议 ---\n");
          log(output);
        }
      } catch (err) {
        warn(`批次 ${bi + 1} 调用失败: ${err.message?.slice(0, 200)}`);
      }
    }

    summary.groupsWritten = totalWritten;
    summary.groupsUpdated = totalUpdated;

    if (autoWrite) {
      log(`\n阶段 2 完成: ${totalWritten} 个新 group, ${totalUpdated} 个更新`);
    } else if (!dryRun) {
      log("\n--- 建议结束（请人工审核后手动更新 groups 文件）---");
    }

    // Pass newGroupPaths to stage 3 (closure variable used below)
    stage2GroupPaths = newGroupPaths;
  } else if (maxStage >= 2 && atomPathsForGrouping.length === 0) {
    log("\n无 atom 文件，跳过阶段 2");
  }

  // Stage 3: use groups (not atoms) as synthesis input
  const allGroupPaths = collectAllGroupPaths(paths);
  const synthesisGroupPaths = stage2GroupPaths.length > 0 ? stage2GroupPaths : allGroupPaths;
  const isIncremental = stage2GroupPaths.length > 0;

  if (maxStage >= 3 && allGroupPaths.length > 0) {
    heading(autoWrite ? "阶段 3: Synthesis 自动更新" : "阶段 3: Synthesis 检查建议");
    if (isIncremental) {
      log(`增量模式: 基于本轮 ${synthesisGroupPaths.length} 个新增/更新 group 更新 synthesis`);
    } else {
      log(`全量模式: 基于全部 ${synthesisGroupPaths.length} 个 group 更新 synthesis`);
    }

    const prompt = buildSynthesisPrompt(paths, synthesisGroupPaths, autoWrite, { incremental: isIncremental });
    if (dryRun) {
      log(`[dry-run] 将调用模型 ${autoWrite ? "自动更新" : "检查"} synthesis`);
      log(`[dry-run] Prompt 长度: ${prompt.length} 字符`);
    } else {
      log(`Prompt 长度: ${prompt.length} 字符`);
      log("调用模型...");
      try {
        const output = await callAgent(prompt);
        if (autoWrite) {
          const cleaned = stripCodeFences(output.trim());
          if (!cleaned.includes("# 收敛") || !cleaned.includes("## 顶层观点候选")) {
            warn("模型输出不像有效的 synthesis.md，打印原始输出供参考：");
            log(cleaned.slice(0, 2000));
          } else {
            writeFileSync(paths.synthesisPath, cleaned + "\n", "utf-8");
            log(`✓ 已更新 ${relative(baseDir, paths.synthesisPath)}`);
            summary.synthesisUpdated = true;
          }
        } else {
          log("\n--- Synthesis 检查建议 ---\n");
          log(output);
          log("\n--- 建议结束（请人工审核后手动更新 synthesis.md）---");
        }
      } catch (err) {
        warn(`调用失败: ${err.message?.slice(0, 200)}`);
      }
    }
  } else if (maxStage >= 3 && allGroupPaths.length === 0) {
    log("\n无 group 文件，跳过阶段 3");
  }

  // --- Agent index (SKILL.md + CONTEXT.md) ---
  if (!dryRun) {
    try {
      heading("更新 Agent 检索索引");
      runAgentIndex({ baseDir, config, log, warn });
    } catch (err) {
      warn(`Agent 索引生成失败: ${err.message?.slice(0, 200)}`);
    }
  }

  heading("处理完毕");
  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point (backward-compatible)
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism process [选项]

金字塔增量处理：自动从 journal/corpus 提取 atoms，更新 groups 和 synthesis。

选项:
  --dry-run            只显示待处理列表和 prompt 预览，不调用模型
  --auto-write         阶段 2/3 自动写入文件（默认只输出建议到终端）
  --stage <1|2|3>      只执行到指定阶段（默认 3）
                         1 = 提取 atoms
                         2 = + groups 更新
                         3 = + synthesis 更新
  --file <filename>    只处理指定文件（不含路径，如 skills-guide.md）
  --series <name>      只处理指定 corpus 系列（如 水库正本系列）
  --verbose            显示完整 prompt 和模型原始响应
  -h, --help           显示帮助
`.trim();

export async function run(args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "auto-write": { type: "boolean", default: false },
      stage: { type: "string", default: "3" },
      file: { type: "string" },
      series: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { baseDir, config } = loadConfig();

  const callAgent = createHttpCaller({
    baseUrl: config.api.baseUrl,
    apiKey: config.api.apiKey,
    model: config.api.model,
    temperature: config.process.temperature,
    maxTokens: config.process.maxTokens,
    timeoutMs: config.process.timeoutMs,
  });

  return runPipeline({
    baseDir,
    config,
    callAgent,
    dryRun: flags["dry-run"],
    autoWrite: flags["auto-write"],
    maxStage: Number(flags.stage),
    onlyFile: flags.file,
    onlySeries: flags.series,
    verbose: flags.verbose,
  });
}

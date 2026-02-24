import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import {
  extractTitle,
  heading,
  isPlaceholder,
  listDateDirs,
  listMdFiles,
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

function discoverJournals(paths, onlyFile) {
  const abbrevReadme = read(paths.atomsReadme);
  const { fileToAbbrev, usedAbbrevs } = parseAbbrevTable(abbrevReadme);
  const results = [];

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
        results.push({ type: "A", stem, journalPath, atomPath, atomMonthDir, dateDir, month, abbrev: null });
      } else if (isPlaceholder(atomPath)) {
        const abbrev = fileToAbbrev.get(stem) || null;
        results.push({ type: "B", stem, journalPath, atomPath, atomMonthDir, dateDir, month, abbrev });
      }
    }
  }

  return { results, fileToAbbrev, usedAbbrevs };
}

function collectGroupedPrefixes(paths) {
  const prefixes = new Set();
  if (!existsSync(paths.groupsDir)) return prefixes;
  const groupFiles = listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G"));
  for (const f of groupFiles) {
    const content = read(join(paths.groupsDir, f));
    const matches = content.matchAll(/\|\s*([A-Z]{2})-\d{2}\s*\|/g);
    for (const m of matches) prefixes.add(m[1]);
  }
  return prefixes;
}

function collectAllAtomPaths(paths) {
  const atomPaths = [];
  if (!existsSync(paths.atomsDir)) return atomPaths;
  for (const sub of readdirSync(paths.atomsDir)) {
    const subDir = join(paths.atomsDir, sub);
    if (!statSync(subDir).isDirectory() || !/^\d{4}-\d{2}$/.test(sub)) continue;
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

function buildAtomPrompt(entry, usedAbbrevs) {
  const journalContent = read(entry.journalPath);
  const journalTitle = extractTitle(journalContent);
  const relPath = `../../../../journal/${entry.dateDir}/${basename(entry.journalPath)}`;

  let abbrevInstruction = "";
  if (entry.type === "A") {
    const taken = [...usedAbbrevs].toSorted((a, b) => a.localeCompare(b)).join(", ");
    abbrevInstruction = `
## 缩写分配

请为这篇 journal 分配一个 2 字母大写缩写（用于 atom 编号前缀）。
已使用的缩写（不可重复）：${taken}
请选择一个有意义且未被占用的缩写。在输出的第二行 "> 缩写：XX" 处填入。
`;
  } else {
    abbrevInstruction = `
## 缩写

该 journal 的缩写为：**${entry.abbrev}**，请使用 ${entry.abbrev}-01, ${entry.abbrev}-02, ... 作为编号。
`;
  }

  return `你是一个知识库助手。你的任务是从下方的 journal 原文中提取信息单元（atoms）。

## 输出要求

请直接输出完整的 atom markdown 文件内容（不要包裹在代码块中）。严格遵循以下格式：

1. 第一行：# [journal 的标题]
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
- "原文定位"列写出在 journal 中的章节名
- 编号从 01 开始递增
${abbrevInstruction}
## 参考范例（仅展示前几行）

${ATOM_EXAMPLE}

## 本次提取的 journal 信息

- 标题：${journalTitle}
- 来源路径：${relPath}
- 日期目录：${entry.dateDir}

## journal 原文

${journalContent}
`;
}

function condensedAtomSummary(atomPath) {
  const content = read(atomPath);
  const title = extractTitle(content);
  const abbrevMatch = content.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
  const abbrev = abbrevMatch ? abbrevMatch[1] : "??";
  const rows = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([A-Z]{2}-\d{2})\s*\|[^|]*\|\s*([^|]+?)\s*\|/);
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
- "来源"列填 journal 文件名（不含 .md）
- 更新现有 group 时，保留原有的所有 atoms，在表格末尾追加新 atoms
- atom 数量统计必须准确
- 来源月份跨度包括所有 atom 的来源月份

## 现有分组 INDEX

${groupsIndex}

## 待归组的 Atoms

${newAtomsContent}
`;
}

function buildSynthesisPrompt(paths, allAtomPaths, autoWrite) {
  const synthesisContent = read(paths.synthesisPath);
  const groupsIndex = read(paths.groupsIndex);
  const newAtomsContent = allAtomPaths.map((p) => condensedAtomSummary(p)).join("\n\n");
  const today = new Date().toISOString().slice(0, 10);

  if (!autoWrite) {
    return `你是一个知识库助手。以下是当前的 synthesis（顶层观点候选列表）和新提取的 atoms。

## 任务

请评估：
1. 现有顶层观点候选是否仍然准确？
2. 新 atoms 是否支持现有候选，还是暗示需要新增/修改候选？
3. 候选间的关系描述是否需要更新？

请用中文回答，给出具体建议。如果无需修改，简要说明即可。

## 当前 Synthesis

${synthesisContent}

## 当前分组 INDEX（含最新 groups）

${groupsIndex}

## 新提取的 Atoms

${newAtomsContent}
`;
  }

  return `你是一个知识库助手。请基于新 atoms 和当前 groups 更新 synthesis.md 文件。

## 任务

1. 评估现有顶层观点候选是否仍然准确
2. 判断新 atoms 是否支持现有候选，或需要新增/修改/升级候选
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

## 当前分组 INDEX（含最新 groups）

${groupsIndex}

## 新提取的 Atoms

${newAtomsContent}
`;
}

// ---------------------------------------------------------------------------
// Output parsers and writers
// ---------------------------------------------------------------------------

function extractAbbrevFromOutput(output) {
  const m = output.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
  return m ? m[1] : null;
}

function validateAtomOutput(output) {
  const issues = [];
  if (!output.match(/^#\s+/m)) issues.push("缺少标题行（# ...）");
  if (!output.includes("> 来源：")) issues.push("缺少来源行（> 来源：...）");
  if (!output.includes("## Atoms")) issues.push("缺少 ## Atoms 标题");
  if (!output.includes("| 编号")) issues.push("缺少 atom 表格");
  if (!output.match(/\|\s*[A-Z]{2}-\d{2}\s*\|/)) issues.push("未找到任何 atom 行（如 XX-01）");
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

  for (const g of parsed.groups) {
    const gPath = join(paths.groupsDir, g.filename);
    const isNew = !existsSync(gPath);
    writeFileSync(gPath, g.content + "\n", "utf-8");
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

  return { written, updated };
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
  verbose = false,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const summary = { atomsProcessed: 0, groupsWritten: 0, groupsUpdated: 0, synthesisUpdated: false };

  // --- Atom writer helpers (need baseDir & paths in closure) ---

  function registerAbbrev(stem, abbrev, month) {
    const readme = read(paths.atomsReadme);
    const newRow = `| ${abbrev}   | ${stem.padEnd(37)} | ${month} |`;
    const lastPipeLineIdx = readme.lastIndexOf("| ");
    if (lastPipeLineIdx < 0) {
      warn("无法定位缩写映射表末尾，请手动添加缩写");
      return;
    }
    const insertPos = readme.indexOf("\n", lastPipeLineIdx);
    const updated = readme.slice(0, insertPos) + "\n" + newRow + readme.slice(insertPos);
    writeFileSync(paths.atomsReadme, updated, "utf-8");
    log(`已在 atoms/README.md 注册缩写 ${abbrev} → ${stem}`);
  }

  async function processAtom(entry, usedAbbrevs) {
    const prompt = buildAtomPrompt(entry, usedAbbrevs);

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
    if (entry.type === "A") {
      abbrev = extractAbbrevFromOutput(output);
      if (!abbrev) { warn("模型输出中未找到缩写，跳过"); return null; }
      if (usedAbbrevs.has(abbrev)) { warn(`模型生成的缩写 ${abbrev} 已被占用，跳过`); return null; }
    }

    if (!existsSync(entry.atomMonthDir)) mkdirSync(entry.atomMonthDir, { recursive: true });

    writeFileSync(entry.atomPath, output + "\n", "utf-8");
    log(`✓ 已写入 ${relative(baseDir, entry.atomPath)}`);

    if (entry.type === "A") {
      registerAbbrev(entry.stem, abbrev, entry.month);
      usedAbbrevs.add(abbrev);
    }

    return { abbrev, atomPath: entry.atomPath };
  }

  // --- Main pipeline ---

  heading("金字塔增量处理");
  log(`配置: stage=${maxStage}, dry-run=${dryRun}, auto-write=${autoWrite}`);
  log(`根目录: ${baseDir}`);

  // Stage 1
  heading("阶段 1: 发现未处理的 journal");
  const { results, usedAbbrevs } = discoverJournals(paths, onlyFile);

  if (results.length === 0) {
    log("所有 journal 已处理完毕，无待处理条目。");
    if (maxStage < 2) return summary;
  }

  log(`发现 ${results.length} 个待处理条目:\n`);
  log("  类型  | 日期       | 文件名");
  log("  ----- | ---------- | ------");
  for (const r of results) {
    log(`  ${r.type === "A" ? "新建" : "填充"}  | ${r.dateDir} | ${r.stem}.md`);
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
            const { written, updated } = writeGroupsOutput(paths, parsed, log);
            totalWritten += written;
            totalUpdated += updated;
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
  } else if (maxStage >= 2 && atomPathsForGrouping.length === 0) {
    log("\n无 atom 文件，跳过阶段 2");
  }

  // Stage 3
  const allAtomPaths = collectAllAtomPaths(paths);
  const synthesisAtoms = allAtomPaths.length > 0 ? allAtomPaths : atomPathsForGrouping;

  if (maxStage >= 3 && synthesisAtoms.length > 0) {
    heading(autoWrite ? "阶段 3: Synthesis 自动更新" : "阶段 3: Synthesis 检查建议");

    const prompt = buildSynthesisPrompt(paths, synthesisAtoms, autoWrite);
    if (dryRun) {
      log(`[dry-run] 将调用模型 ${autoWrite ? "自动更新" : "检查"} synthesis`);
      log(`[dry-run] Prompt 长度: ${prompt.length} 字符`);
    } else {
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
  } else if (maxStage >= 3 && synthesisAtoms.length === 0) {
    log("\n无 atom 文件，跳过阶段 3");
  }

  heading("处理完毕");
  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point (backward-compatible)
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism process [选项]

金字塔增量处理：自动从 journal 提取 atoms，更新 groups 和 synthesis。

选项:
  --dry-run            只显示待处理列表和 prompt 预览，不调用模型
  --auto-write         阶段 2/3 自动写入文件（默认只输出建议到终端）
  --stage <1|2|3>      只执行到指定阶段（默认 3）
                         1 = 提取 atoms
                         2 = + groups 更新
                         3 = + synthesis 更新
  --file <filename>    只处理指定 journal（不含路径，如 skills-guide.md）
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
    verbose: flags.verbose,
  });
}

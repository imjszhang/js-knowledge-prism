import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { getStatus } from "./status.mjs";
import {
  extractTitle,
  heading,
  listPerspectiveDirs,
  log as defaultLog,
  makePaths,
  parseKeyLineTable,
  read,
  warn as defaultWarn,
  writeIfChanged,
} from "./utils.mjs";

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: m[2] };
}

function parseYamlField(frontmatter, field) {
  if (!frontmatter) return null;
  const re = new RegExp(`^${field}:\\s*(?:"([^"]*?)"|'([^']*?)'|(.+))$`, "m");
  const m = frontmatter.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]).trim();
}

/**
 * Merge auto-generated frontmatter with existing user-customised fields.
 * Preserves any fields the user added manually (e.g. metadata.openclaw.emoji).
 */
function mergeFrontmatter(existingFm, generatedFm) {
  if (!existingFm) return generatedFm;

  const generated = new Map();
  for (const line of generatedFm.split("\n")) {
    const m = line.match(/^(\w[\w-]*):/);
    if (m) generated.set(m[1], true);
  }

  const extra = [];
  let skip = false;
  for (const line of existingFm.split("\n")) {
    const topLevel = line.match(/^(\w[\w-]*):/);
    if (topLevel) {
      skip = generated.has(topLevel[1]);
      if (!skip) extra.push(line);
    } else if (!skip) {
      extra.push(line);
    }
  }

  if (extra.length === 0) return generatedFm;
  return generatedFm + "\n" + extra.join("\n");
}

// ---------------------------------------------------------------------------
// Table extraction helpers
// ---------------------------------------------------------------------------

function extractTableSection(content, headingText) {
  const lines = content.split("\n");
  let inSection = false;
  let headerFound = false;
  const rows = [];

  for (const line of lines) {
    if (line.match(new RegExp(`^##\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))) {
      inSection = true;
      continue;
    }
    if (inSection && line.match(/^##\s+/)) break;
    if (!inSection) continue;

    if (line.includes("---|---")) {
      headerFound = true;
      continue;
    }
    if (!headerFound && line.startsWith("|")) {
      rows.push(line);
      continue;
    }
    if (headerFound && line.startsWith("|")) {
      rows.push(line);
    }
  }
  return rows;
}

function extractFullTable(content, headingText) {
  const lines = content.split("\n");
  let inSection = false;
  let foundTable = false;
  const tableLines = [];

  for (const line of lines) {
    if (line.match(new RegExp(`^##\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))) {
      inSection = true;
      continue;
    }
    if (inSection && line.match(/^#{2,}\s+/)) break;
    if (!inSection) continue;

    if (line.startsWith("|")) {
      tableLines.push(line);
      foundTable = true;
    } else if (foundTable && line.trim() === "") {
      break;
    }
  }
  return tableLines.join("\n");
}

// ---------------------------------------------------------------------------
// SCQA extraction
// ---------------------------------------------------------------------------

function extractScqaSummary(scqaContent) {
  const sections = { S: "", C: "", Q: "", A: "" };
  const labels = {
    "S - 情境": "S", "S -": "S", Situation: "S",
    "C - 冲突": "C", "C -": "C", Complication: "C",
    "Q - 疑问": "Q", "Q -": "Q", Question: "Q",
    "A - 答案": "A", "A -": "A", Answer: "A",
  };

  let currentKey = null;
  for (const line of scqaContent.split("\n")) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      currentKey = null;
      for (const [prefix, key] of Object.entries(labels)) {
        if (headingMatch[1].includes(prefix)) {
          currentKey = key;
          break;
        }
      }
      continue;
    }

    if (currentKey && !sections[currentKey] && line.trim() && !line.startsWith("#") && !line.startsWith("（待填充）")) {
      sections[currentKey] = line.trim();
    }
  }

  return sections;
}

function extractReaderSummary(scqaContent) {
  const lines = scqaContent.split("\n");
  let inReaderTable = false;
  const fields = {};

  for (const line of lines) {
    if (line.match(/^##\s+目标读者/)) { inReaderTable = true; continue; }
    if (inReaderTable && line.match(/^##\s+/)) break;
    if (!inReaderTable) continue;

    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (m && !m[1].includes("---")) {
      const key = m[1].trim();
      const val = m[2].trim();
      if (key !== "维度" && key !== "描述") {
        fields[key] = val;
      }
    }
  }

  const role = fields["角色"] || "";
  const need = fields["核心诉求"] || "";
  if (!role && !need) return "";
  return need ? `${role} | 核心诉求：${need}` : role;
}

// ---------------------------------------------------------------------------
// generateSkillMd
// ---------------------------------------------------------------------------

/**
 * Generate SKILL.md content for a knowledge prism directory.
 * Pure extraction — no LLM, no network.
 *
 * @param {string} baseDir - Knowledge prism root
 * @param {{ name?: string }} [config] - Optional config with name
 * @returns {string} Full SKILL.md content
 */
export function generateSkillMd(baseDir, config) {
  const paths = makePaths(baseDir);
  const name = config?.name || basename(baseDir);
  const status = getStatus(baseDir);

  // --- Build description from synthesis candidates ---
  const topics = [];
  if (existsSync(paths.synthesisPath)) {
    const syn = read(paths.synthesisPath);
    const rows = extractTableSection(syn, "顶层观点候选");
    for (const row of rows) {
      const m = row.match(/^\|\s*S\d+\s*\|\s*(.+?)\s*\|/);
      if (m) topics.push(m[1].replace(/\s*\|.*$/, "").trim());
    }
  }

  const topicSummary = topics.length > 0
    ? topics.map((t) => t.length > 30 ? t.slice(0, 30) + "…" : t).join("；")
    : "内容构建中";

  const description = `${name} — 结构化知识体系，覆盖：${topicSummary}。${status.totalPerspectives} 个视角、${status.totalGroups} 个分组，可按需检索。`;

  // --- Preserve user-customised frontmatter fields ---
  let existingFm = null;
  if (existsSync(paths.skillMd)) {
    const existing = read(paths.skillMd);
    const parsed = parseFrontmatter(existing);
    existingFm = parsed.frontmatter;
  }

  const generatedFm = [
    `name: "${name}"`,
    `description: "${description}"`,
    "version: 1.0.0",
    "metadata:",
    "  openclaw:",
    '    emoji: "🔬"',
    "    requires:",
    "      skills:",
    "        - js-knowledge-prism",
  ].join("\n");

  const frontmatter = mergeFrontmatter(existingFm, generatedFm);

  // --- Body ---
  const bodyParts = [];
  bodyParts.push(`# 知识地图\n`);
  bodyParts.push(`> ${status.totalJournals}篇journal, ${status.totalAtoms}个atoms, ${status.totalGroups}个groups, ${status.totalPerspectives}个视角\n`);

  // Synthesis
  if (existsSync(paths.synthesisPath)) {
    const table = extractFullTable(read(paths.synthesisPath), "顶层观点候选");
    if (table) {
      bodyParts.push("## 顶层观点\n");
      bodyParts.push(table + "\n");
    }
  }

  // Groups
  if (existsSync(paths.groupsIndex)) {
    const table = extractFullTable(read(paths.groupsIndex), "分组总览");
    if (table) {
      bodyParts.push("## 分组索引\n");
      bodyParts.push(table + "\n");
    }
  }

  // Perspectives with CONTEXT.md links
  if (existsSync(paths.structureIndex)) {
    const indexContent = read(paths.structureIndex);
    const perspDirs = listPerspectiveDirs(paths.structureDir);

    bodyParts.push("## 视角索引\n");

    const tableLines = extractFullTable(indexContent, "视角总览");
    if (tableLines) {
      const lines = tableLines.split("\n");
      const augmented = [];
      for (const line of lines) {
        const pMatch = line.match(/^\|\s*(P\d+)\s*\|/);
        if (pMatch) {
          const pId = pMatch[1];
          const dir = perspDirs.find((d) => d.startsWith(pId));
          const ctxLink = dir ? `[CONTEXT.md](pyramid/structure/${dir}/CONTEXT.md)` : "—";
          augmented.push(line.replace(/\|\s*$/, `| ${ctxLink} |`));
        } else if (line.includes("----")) {
          augmented.push(line.replace(/\|\s*$/, "| ---- |"));
        } else {
          augmented.push(line.replace(/\|\s*$/, "| 上下文 |"));
        }
      }
      bodyParts.push(augmented.join("\n") + "\n");
    }
  }

  // Outputs
  if (existsSync(paths.outputsIndex)) {
    const table = extractFullTable(read(paths.outputsIndex), "产出总览");
    if (table) {
      bodyParts.push("## 产出索引\n");
      bodyParts.push(table + "\n");
    }
  }

  bodyParts.push("## 检索指引\n");
  bodyParts.push("1. 根据上方索引定位相关视角或分组");
  bodyParts.push("2. 阅读对应视角的 CONTEXT.md 获取 SCQA 摘要和 Key Line 列表");
  bodyParts.push("3. 按需深入阅读 atom/KL/group 具体文件获取完整论述\n");

  return `---\n${frontmatter}\n---\n\n${bodyParts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// generateContext
// ---------------------------------------------------------------------------

/**
 * Generate CONTEXT.md content for a perspective directory.
 *
 * @param {string} perspectiveDir - Absolute path to PXX-xxx directory
 * @returns {string} Full CONTEXT.md content
 */
export function generateContext(perspectiveDir) {
  const dirName = basename(perspectiveDir);
  const pMatch = dirName.match(/^(P\d+)-(.+)/);
  const pId = pMatch ? pMatch[1] : dirName;
  const pSlug = pMatch ? pMatch[2] : dirName;

  const scqaPath = join(perspectiveDir, "scqa.md");
  const treePath = join(perspectiveDir, "tree", "README.md");

  let perspectiveName = pSlug.replace(/-/g, " ");
  let readerSummary = "";
  let scqa = { S: "", C: "", Q: "", A: "" };

  if (existsSync(scqaPath)) {
    const scqaContent = read(scqaPath);

    const nameMatch = scqaContent.match(/>\s*所属视角[：:]\s*(.+)/);
    if (nameMatch) {
      const raw = nameMatch[1].trim();
      perspectiveName = raw.replace(/^P\d+\s*-\s*/, "").replace(/-/g, " ");
    }

    scqa = extractScqaSummary(scqaContent);
    readerSummary = extractReaderSummary(scqaContent);
  }

  const questionText = scqa.Q || "（待填充）";
  const summary = `${pId} ${perspectiveName}：${questionText}`;

  // Key Lines
  let klTable = "";
  if (existsSync(treePath)) {
    const treeContent = read(treePath);
    const klEntries = parseKeyLineTable(treeContent);
    if (klEntries.length > 0) {
      const rows = [
        "| 序号 | 论点 | 引用 Groups | 展开文件 |",
        "| ---- | ---- | ----------- | -------- |",
      ];
      for (const kl of klEntries) {
        rows.push(`| ${kl.klId} | ${kl.thesis} | ${kl.groups.join(", ")} | ${kl.filename} |`);
      }
      klTable = rows.join("\n");
    }
  }

  // Frontmatter
  const frontmatter = [
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    "read_when:",
    `  - 需要了解 ${pId} ${perspectiveName} 的核心论点和结构时`,
    `  - 需要判断是否深入阅读该视角的完整内容时`,
  ].join("\n");

  // Body
  const bodyParts = [];
  bodyParts.push(`# ${pId} ${perspectiveName}\n`);

  if (readerSummary) {
    bodyParts.push("## 读者\n");
    bodyParts.push(readerSummary + "\n");
  }

  bodyParts.push("## SCQA 摘要\n");
  bodyParts.push(`- **S**: ${scqa.S || "（待填充）"}`);
  bodyParts.push(`- **C**: ${scqa.C || "（待填充）"}`);
  bodyParts.push(`- **Q**: ${scqa.Q || "（待填充）"}`);
  bodyParts.push(`- **A**: ${scqa.A || "（待填充）"}\n`);

  if (klTable) {
    bodyParts.push("## Key Lines\n");
    bodyParts.push(klTable + "\n");
  }

  bodyParts.push("## 深入阅读\n");
  bodyParts.push("- SCQA 完整设计：[scqa.md](scqa.md)");
  bodyParts.push("- 金字塔全树：[tree/README.md](tree/README.md)");
  bodyParts.push("- MECE 验证：[validation.md](validation.md)\n");

  return `---\n${frontmatter}\n---\n\n${bodyParts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// runAgentIndex — programmatic API
// ---------------------------------------------------------------------------

/**
 * Generate SKILL.md and all CONTEXT.md files for a knowledge prism.
 *
 * @param {object} opts
 * @param {string}   opts.baseDir
 * @param {object}   [opts.config]
 * @param {function} [opts.log]
 * @param {function} [opts.warn]
 * @returns {{ skillMdWritten: boolean, contextCount: number }}
 */
export function runAgentIndex({
  baseDir,
  config,
  log = defaultLog,
  warn = defaultWarn,
}) {
  const paths = makePaths(baseDir);
  const result = { skillMdWritten: false, contextCount: 0 };

  // Generate SKILL.md
  const skillContent = generateSkillMd(baseDir, config);
  if (writeIfChanged(paths.skillMd, skillContent)) {
    log(`✓ 已更新 SKILL.md`);
    result.skillMdWritten = true;
  } else {
    log(`  SKILL.md 无变更，跳过`);
  }

  // Generate CONTEXT.md for each perspective
  const perspDirs = listPerspectiveDirs(paths.structureDir);
  for (const dir of perspDirs) {
    const perspPath = join(paths.structureDir, dir);
    const ctxContent = generateContext(perspPath);
    const ctxPath = join(perspPath, "CONTEXT.md");
    if (writeIfChanged(ctxPath, ctxContent)) {
      log(`✓ 已更新 ${dir}/CONTEXT.md`);
      result.contextCount++;
    } else {
      log(`  ${dir}/CONTEXT.md 无变更，跳过`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism agent-index [选项]

生成 Agent 检索索引：根级 SKILL.md（知识地图）+ 各视角 CONTEXT.md（决策摘要）。
纯确定性提取，不调用 LLM。

选项:
  -h, --help    显示帮助
`.trim();

export async function run(args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { baseDir, config } = loadConfig();

  heading("生成 Agent 检索索引");
  defaultLog(`根目录: ${baseDir}`);

  const result = runAgentIndex({ baseDir, config });

  heading("生成完毕");
  defaultLog(`SKILL.md: ${result.skillMdWritten ? "已更新" : "跳过"}`);
  defaultLog(`CONTEXT.md: ${result.contextCount} 个视角`);
}

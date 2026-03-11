/**
 * Date-driven KL strategy: detect new journal dates not yet registered as
 * Key Lines, find their group associations, and append KL rows to tree/README.md.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  listDateDirs,
  listMdFiles,
  parseAbbrevTable,
  parseKeyLineTable,
  stripCodeFences,
} from "./utils.mjs";

function readSafe(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Atom abbreviation → Group mapping
// ---------------------------------------------------------------------------

/**
 * Scan all group .md files and build a Map<atomAbbrev, Set<groupId>>.
 * Each group file's "包含的 Atoms" table has rows like `| XX-01 | source | ... |`.
 */
export function buildAbbrevToGroupsMap(groupsDir) {
  const map = new Map();
  if (!existsSync(groupsDir)) return map;

  const files = readdirSync(groupsDir).filter(
    (f) => /^G\d+/.test(f) && f.endsWith(".md"),
  );

  for (const file of files) {
    const gMatch = file.match(/^(G\d+)/);
    if (!gMatch) continue;
    const gId = gMatch[1];

    const content = readSafe(join(groupsDir, file));
    const atomHits = [...content.matchAll(/\|\s*([A-Z]{2})-\d+\s*\|/g)];
    const abbrevs = new Set(atomHits.map((m) => m[1]));

    for (const abbrev of abbrevs) {
      if (!map.has(abbrev)) map.set(abbrev, new Set());
      map.get(abbrev).add(gId);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// New-date detection
// ---------------------------------------------------------------------------

/**
 * Compare journal date directories against registered KL dates and return
 * only those that (a) are new and (b) have at least one processed atom.
 *
 * @returns {{ date: string, journalFiles: string[], atomAbbrevs: string[] }[]}
 */
export function detectNewDates(paths, perspectiveDir) {
  const treePath = join(paths.structureDir, perspectiveDir, "tree", "README.md");
  const treeContent = readSafe(treePath);
  const existingDates = new Set(
    parseKeyLineTable(treeContent)
      .map((kl) => kl.date)
      .filter(Boolean),
  );

  const journalDates = listDateDirs(paths.journalDir);
  const { fileToAbbrev } = parseAbbrevTable(readSafe(paths.atomsReadme));

  const results = [];
  for (const date of journalDates) {
    if (existingDates.has(date)) continue;

    const journalFiles = listMdFiles(join(paths.journalDir, date)).map((f) =>
      f.replace(/\.md$/, ""),
    );
    const abbrevs = journalFiles.map((f) => fileToAbbrev.get(f)).filter(Boolean);

    if (abbrevs.length > 0) {
      results.push({ date, journalFiles, atomAbbrevs: abbrevs });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Group lookup
// ---------------------------------------------------------------------------

/** Collect all group IDs that reference any of the given atom abbreviations. */
export function findGroupsForDate(abbrevToGroups, atomAbbrevs) {
  const groups = new Set();
  for (const abbrev of atomAbbrevs) {
    const gs = abbrevToGroups.get(abbrev);
    if (gs) for (const g of gs) groups.add(g);
  }
  return [...groups].sort(
    (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10),
  );
}

// ---------------------------------------------------------------------------
// LLM prompt for KL topic title
// ---------------------------------------------------------------------------

const TOPIC_SYSTEM = `你是知识管理专家。根据当天关联的 Groups 标题，生成一个简洁的日记主题标题。
只输出标题文本本身（含"第 N 天："前缀），不要其他解释。
格式：第 N 天：<主题关键词概括>
示例：第 38 天：Output Cron 可靠性优化`;

// ---------------------------------------------------------------------------
// Append new KL rows
// ---------------------------------------------------------------------------

/**
 * Append date-driven KL rows to tree/README.md for each new date.
 *
 * @param {{ paths, perspectiveDir: string, newDates: Array, callAgent: Function, abbrevToGroups: Map }} opts
 * @returns {{ success: boolean, message: string, newKlIds: string[] }}
 */
export async function appendDateKls({
  paths,
  perspectiveDir,
  newDates,
  callAgent,
  abbrevToGroups,
}) {
  const treePath = join(paths.structureDir, perspectiveDir, "tree", "README.md");
  if (!existsSync(treePath)) {
    return { success: false, message: `tree/README.md 不存在: ${treePath}`, newKlIds: [] };
  }

  let treeContent = readSafe(treePath);
  const existingKls = parseKeyLineTable(treeContent);

  let nextNum =
    existingKls.length > 0
      ? Math.max(...existingKls.map((kl) => parseInt(kl.klId.replace("KL", ""), 10))) + 1
      : 1;

  const firstDate = existingKls.find((kl) => kl.date)?.date;
  const firstMs = firstDate ? new Date(firstDate).getTime() : null;

  const newKlIds = [];

  for (const { date, atomAbbrevs } of newDates) {
    const groups = findGroupsForDate(abbrevToGroups, atomAbbrevs);
    if (groups.length === 0) continue;

    const klId = `KL${String(nextNum).padStart(2, "0")}`;
    const filename = `${klId}-${date}.md`;

    const dayNum = firstMs
      ? Math.round((new Date(date).getTime() - firstMs) / 86_400_000) + 1
      : nextNum;

    const groupTitles = [];
    for (const gId of groups) {
      const gFiles = readdirSync(paths.groupsDir).filter(
        (f) => f.startsWith(`${gId}-`) && f.endsWith(".md"),
      );
      if (gFiles.length > 0) {
        const heading = readSafe(join(paths.groupsDir, gFiles[0]))
          .split("\n")
          .find((l) => l.startsWith("# "));
        if (heading) groupTitles.push(heading.replace(/^#\s*/, "").replace(`${gId}: `, ""));
      }
    }

    let topic;
    try {
      const prompt = [
        TOPIC_SYSTEM,
        "\n---\n",
        `日期: ${date}`,
        `Day: 第 ${dayNum} 天`,
        `关联 Groups:\n${groupTitles.map((t, i) => `- ${groups[i]}: ${t}`).join("\n")}`,
        "\n生成标题。",
      ].join("\n");
      topic = stripCodeFences((await callAgent(prompt)).trim());
    } catch {
      topic = `第 ${dayNum} 天：${date}`;
    }

    const row = `| ${klId} | ${date} | ${topic} | ${groups.join(", ")} | ${filename} |`;

    const lines = treeContent.split("\n");
    let insertIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\|\s*KL\d+\s*\|/.test(lines[i])) {
        insertIdx = i + 1;
        break;
      }
    }
    if (insertIdx < 0) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("---|---")) {
          insertIdx = i + 1;
          break;
        }
      }
    }
    if (insertIdx >= 0) {
      lines.splice(insertIdx, 0, row);
      treeContent = lines.join("\n");
    }

    newKlIds.push(klId);
    nextNum++;
  }

  if (newKlIds.length > 0) {
    writeFileSync(treePath, treeContent, "utf-8");
  }

  return {
    success: true,
    message:
      newKlIds.length > 0
        ? `追加了 ${newKlIds.length} 个日期 KL: ${newKlIds.join(", ")}`
        : "无新日期需要追加",
    newKlIds,
  };
}

// ---------------------------------------------------------------------------
// Stale KL detection (draft mechanism)
// ---------------------------------------------------------------------------

function getLatestMtime(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestMtime(fullPath));
    } else {
      latest = Math.max(latest, statSync(fullPath).mtimeMs);
    }
  }
  return latest;
}

/**
 * Detect today's KLs whose journal source materials have been updated
 * since the KL expand file was last written.
 *
 * @returns {string[]} klIds that need re-expansion
 */
export function detectStaleKls(paths, perspectiveDir) {
  const treePath = join(paths.structureDir, perspectiveDir, "tree", "README.md");
  const treeContent = readSafe(treePath);
  const existingKls = parseKeyLineTable(treeContent);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const staleKlIds = [];
  for (const kl of existingKls) {
    if (kl.date !== today) continue;
    const expandPath = join(paths.structureDir, perspectiveDir, "tree", kl.filename);
    if (!existsSync(expandPath)) continue;
    const expandMtime = statSync(expandPath).mtimeMs;
    const journalDir = join(paths.journalDir, kl.date);
    if (!existsSync(journalDir)) continue;
    const journalMtime = getLatestMtime(journalDir);
    if (journalMtime > expandMtime) {
      staleKlIds.push(kl.klId);
    }
  }
  return staleKlIds;
}

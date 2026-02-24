import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import {
  isPlaceholder,
  listDateDirs,
  listMdFiles,
  makePaths,
  parseAbbrevTable,
  read,
} from "./utils.mjs";

/**
 * Collect structured status data for a knowledge prism instance.
 *
 * @param {string} baseDir - Knowledge prism root directory
 * @returns {{
 *   totalJournals: number,
 *   totalDates: number,
 *   totalAtoms: number,
 *   totalGroups: number,
 *   totalPerspectives: number,
 *   ungroupedCount: number,
 *   synthesisModified: string,
 *   unprocessed: Array<{dateDir: string, file: string}>
 * }}
 */
export function getStatus(baseDir) {
  const paths = makePaths(baseDir);

  let totalJournals = 0;
  const dateDirs = listDateDirs(paths.journalDir);
  const totalDates = dateDirs.length;
  for (const d of dateDirs) {
    totalJournals += listMdFiles(join(paths.journalDir, d)).length;
  }

  const unprocessed = [];
  if (existsSync(paths.atomsReadme)) {
    const { fileToAbbrev } = parseAbbrevTable(read(paths.atomsReadme));
    for (const dateDir of dateDirs) {
      const month = dateDir.slice(0, 7);
      for (const mdFile of listMdFiles(join(paths.journalDir, dateDir))) {
        const atomPath = join(paths.atomsDir, month, mdFile);
        if (!existsSync(atomPath) || isPlaceholder(atomPath)) {
          unprocessed.push({ dateDir, file: mdFile });
        }
      }
    }
  }

  let totalAtoms = 0;
  if (existsSync(paths.atomsDir)) {
    for (const sub of readdirSync(paths.atomsDir)) {
      const subDir = join(paths.atomsDir, sub);
      if (statSync(subDir).isDirectory() && /^\d{4}-\d{2}$/.test(sub)) {
        totalAtoms += listMdFiles(subDir).length;
      }
    }
  }

  let totalGroups = 0;
  if (existsSync(paths.groupsDir)) {
    totalGroups = listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G")).length;
  }

  let ungroupedCount = 0;
  if (existsSync(paths.groupsDir) && existsSync(paths.atomsDir)) {
    const groupedPrefixes = new Set();
    for (const f of listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G"))) {
      const content = read(join(paths.groupsDir, f));
      for (const m of content.matchAll(/\|\s*([A-Z]{2})-\d{2}\s*\|/g)) {
        groupedPrefixes.add(m[1]);
      }
    }
    for (const sub of readdirSync(paths.atomsDir)) {
      const subDir = join(paths.atomsDir, sub);
      if (!statSync(subDir).isDirectory() || !/^\d{4}-\d{2}$/.test(sub)) continue;
      for (const f of listMdFiles(subDir)) {
        const p = join(subDir, f);
        if (isPlaceholder(p)) continue;
        const content = read(p);
        const m = content.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
        if (m && !groupedPrefixes.has(m[1])) ungroupedCount++;
      }
    }
  }

  let totalPerspectives = 0;
  if (existsSync(paths.structureDir)) {
    totalPerspectives = readdirSync(paths.structureDir).filter(
      (d) => /^P\d+/.test(d) && statSync(join(paths.structureDir, d)).isDirectory(),
    ).length;
  }

  let synthesisModified = "—";
  if (existsSync(paths.synthesisPath)) {
    const stat = statSync(paths.synthesisPath);
    synthesisModified = stat.mtime.toISOString().slice(0, 10);
  }

  return {
    totalJournals,
    totalDates,
    totalAtoms,
    totalGroups,
    totalPerspectives,
    ungroupedCount,
    synthesisModified,
    unprocessed,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point (backward-compatible)
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism status [选项]

查看知识棱镜的处理状态。

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
  const status = getStatus(baseDir);

  console.log(`\n知识棱镜: ${config.name}`);
  console.log(`根目录: ${baseDir}\n`);

  console.log("  ┌─────────────────────────────────────────┐");
  console.log("  │            知识棱镜状态总览              │");
  console.log("  ├─────────────────────────────────────────┤");
  console.log(`  │  Journal 篇数        ${String(status.totalJournals).padStart(5)}              │`);
  console.log(`  │  Journal 日期目录     ${String(status.totalDates).padStart(5)}              │`);
  console.log(`  │  Atoms 文件           ${String(status.totalAtoms).padStart(5)}              │`);
  console.log(`  │  Groups 分组          ${String(status.totalGroups).padStart(5)}              │`);
  console.log(`  │  视角（Perspective）  ${String(status.totalPerspectives).padStart(5)}              │`);
  console.log("  ├─────────────────────────────────────────┤");
  console.log(`  │  待处理 Journal       ${String(status.unprocessed.length).padStart(5)}              │`);
  console.log(`  │  未归组 Atom 文件     ${String(status.ungroupedCount).padStart(5)}              │`);
  console.log(`  │  Synthesis 最后修改   ${status.synthesisModified.padStart(10)}         │`);
  console.log("  └─────────────────────────────────────────┘");

  if (status.unprocessed.length > 0) {
    console.log("\n  待处理的 Journal:\n");
    console.log("  日期       | 文件名");
    console.log("  ---------- | ------");
    for (const u of status.unprocessed) {
      console.log(`  ${u.dateDir} | ${u.file}`);
    }
    console.log(`\n  运行 npx js-knowledge-prism process 开始处理\n`);
  } else {
    console.log("\n  所有 journal 已处理完毕。\n");
  }
}

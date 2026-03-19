#!/usr/bin/env node

/**
 * One-time import script: copy articles from work_dir/md/ into corpus/ with
 * normalised filenames. Each series directory becomes a corpus series.
 *
 * Usage:
 *   node scripts/import-corpus.mjs <source-dir> <corpus-dir> [--dry-run]
 *
 * Example:
 *   node scripts/import-corpus.mjs d:/github/my/shuiku/work_dir/md d:/github/my/shuiku/corpus
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positionals = args.filter((a) => !a.startsWith("--"));

if (positionals.length < 2) {
  console.log("用法: node scripts/import-corpus.mjs <source-dir> <corpus-dir> [--dry-run]");
  process.exit(1);
}

const srcRoot = resolve(positionals[0]);
const destRoot = resolve(positionals[1]);

if (!existsSync(srcRoot)) {
  console.error(`源目录不存在: ${srcRoot}`);
  process.exit(1);
}

const SKIP_DIRS = new Set(["作废版"]);

// Patterns per series. Each returns { num, title } or null.
function parseZhengben(filename) {
  // "#1234 title.md" or "#0 title.md" — space or non-ASCII may follow the number
  const m = filename.match(/^#(\d+)\s*(.+)\.md$/);
  if (!m) return null;
  return { num: Number(m[1]), sub: null, title: m[2].trim() };
}

function parseFSeries(filename) {
  // "#F10 3 title.md" (sub-article) or "#F100 title.md" (standalone)
  // Also handles fullwidth chars right after number: "#F2730３＊２＝８.md"
  const mSub = filename.match(/^#F(\d+)\s+(\d+)\s+(.+)\.md$/);
  if (mSub) return { num: Number(mSub[1]), sub: Number(mSub[2]), title: mSub[3].trim() };
  const m = filename.match(/^#F(\d+)\s*(.+)\.md$/);
  if (m) return { num: Number(m[1]), sub: null, title: m[2].trim() };
  return null;
}

function parseDaodian(filename) {
  // "J01 title.md"
  const m1 = filename.match(/^J(\d+)\s+(.+)\.md$/);
  if (m1) return { num: Number(m1[1]), sub: null, title: m1[2].trim() };
  // "title #J1234.md" or "title%20#J1234.md"
  const m2 = filename.match(/^(.+?)\s*(?:%20)?#J(\d+)\.md$/);
  if (m2) return { num: Number(m2[2]), sub: null, title: m2[1].trim() };
  return null;
}

const SERIES_PARSERS = {
  "水库正本系列": parseZhengben,
  "水库F系列": parseFSeries,
  "道典正义": parseDaodian,
};

function sanitiseTitle(title) {
  return title
    .replace(/%20/g, " ")
    .replace(/[#'"]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[-]{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function buildDestName(parsed) {
  const pad = String(parsed.num).padStart(4, "0");
  const suffix = parsed.sub != null ? `.${parsed.sub}` : "";
  const title = sanitiseTitle(parsed.title);
  return `${pad}${suffix}-${title}.md`;
}

// Skip index/directory listing files
function isIndexFile(parsed) {
  return parsed.num === 0;
}

let total = 0;
let skipped = 0;
const skippedFiles = [];

for (const seriesName of readdirSync(srcRoot)) {
  const seriesPath = join(srcRoot, seriesName);
  if (!statSync(seriesPath).isDirectory()) continue;

  const parser = SERIES_PARSERS[seriesName];
  if (!parser) {
    console.log(`⚠ 未知系列 "${seriesName}"，跳过`);
    continue;
  }

  const destSeriesDir = join(destRoot, seriesName);
  if (!dryRun) mkdirSync(destSeriesDir, { recursive: true });

  console.log(`\n== ${seriesName} ==`);

  for (const file of readdirSync(seriesPath)) {
    const filePath = join(seriesPath, file);
    if (statSync(filePath).isDirectory()) {
      if (SKIP_DIRS.has(file)) {
        console.log(`  跳过子目录: ${file}/`);
      }
      continue;
    }
    if (!file.endsWith(".md")) continue;

    const parsed = parser(file);
    if (!parsed) {
      skippedFiles.push(`${seriesName}/${file}`);
      skipped++;
      continue;
    }
    if (isIndexFile(parsed)) {
      console.log(`  跳过索引: ${file}`);
      skipped++;
      continue;
    }

    const destName = buildDestName(parsed);
    const destPath = join(destSeriesDir, destName);

    if (dryRun) {
      console.log(`  ${file}\n    → ${destName}`);
    } else {
      cpSync(filePath, destPath);
    }
    total++;
  }

  // Generate _series.md skeleton
  const seriesMetaPath = join(destSeriesDir, "_series.md");
  if (!dryRun && !existsSync(seriesMetaPath)) {
    const count = readdirSync(destSeriesDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).length;
    writeFileSync(seriesMetaPath, `# ${seriesName}\n\n共 ${count} 篇。\n\n> 请补充系列概述：作者、时间跨度、核心主题等。\n`, "utf-8");
    console.log(`  ✓ 生成 _series.md`);
  }
}

console.log(`\n${dryRun ? "[dry-run] " : ""}完成: ${total} 篇已${dryRun ? "预览" : "复制"}, ${skipped} 篇跳过`);
if (skippedFiles.length > 0) {
  console.log(`\n无法解析的文件名（已跳过）:`);
  for (const f of skippedFiles) console.log(`  ${f}`);
}

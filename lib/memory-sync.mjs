/**
 * MemorySync — 将已注册知识库的高价值结构化知识汇聚到统一目录，
 * 桥接 OpenClaw memorySearch.extraPaths 实现跨库语义检索。
 *
 * 高价值层：groups (G*.md)、synthesis.md、CONTEXT.md、SKILL.md
 * 增量策略：基于源文件 mtime 对比，仅复制变更文件。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const SYNC_STATE_FILE = ".sync-state.json";

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "kb";
}

function loadSyncState(outputDir) {
  const p = join(outputDir, SYNC_STATE_FILE);
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {}
  return { lastSyncAt: null, files: {} };
}

function saveSyncState(outputDir, state) {
  writeFileSync(join(outputDir, SYNC_STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) return { bases: [] };
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return { bases: [] };
  }
}

/**
 * Collect high-value source files from a single knowledge base.
 * Returns array of { srcPath, destName }.
 */
function collectFiles(baseDir, kbSlug) {
  const results = [];

  // groups: pyramid/analysis/groups/G*.md (exclude INDEX.md)
  const groupsDir = join(baseDir, "pyramid", "analysis", "groups");
  if (existsSync(groupsDir)) {
    try {
      for (const f of readdirSync(groupsDir)) {
        if (f.startsWith("G") && f.endsWith(".md") && f !== "INDEX.md") {
          results.push({
            srcPath: join(groupsDir, f),
            destName: `${kbSlug}-${f}`,
          });
        }
      }
    } catch {}
  }

  // synthesis.md
  const synthesisPath = join(baseDir, "pyramid", "analysis", "synthesis.md");
  if (existsSync(synthesisPath)) {
    results.push({ srcPath: synthesisPath, destName: `${kbSlug}-synthesis.md` });
  }

  // structure/*/CONTEXT.md
  const structureDir = join(baseDir, "pyramid", "structure");
  if (existsSync(structureDir)) {
    try {
      for (const perspDir of readdirSync(structureDir)) {
        const ctxPath = join(structureDir, perspDir, "CONTEXT.md");
        if (existsSync(ctxPath)) {
          results.push({
            srcPath: ctxPath,
            destName: `${kbSlug}-${perspDir}-context.md`,
          });
        }
      }
    } catch {}
  }

  // SKILL.md
  const skillPath = join(baseDir, "SKILL.md");
  if (existsSync(skillPath)) {
    results.push({ srcPath: skillPath, destName: `${kbSlug}-SKILL.md` });
  }

  return results;
}

/**
 * Sync high-value Markdown from all registered knowledge bases into outputDir.
 *
 * @param {Object} opts
 * @param {string} opts.registryPath  Path to registry.json
 * @param {string} opts.outputDir     Unified export directory
 * @param {boolean} [opts.force]      Force full re-export
 * @returns {Promise<{synced: number, skipped: number, deleted: number, total: number}>}
 */
export function syncPrismToMemory({ registryPath, outputDir, force = false }) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const registry = loadRegistry(registryPath);
  const enabledBases = registry.bases.filter((b) => b.enabled !== false);

  const state = force ? { lastSyncAt: null, files: {} } : loadSyncState(outputDir);

  // Collect all expected dest files across all enabled knowledge bases
  const expectedFiles = new Map(); // destName -> srcPath

  for (const base of enabledBases) {
    if (!existsSync(base.baseDir)) continue;
    const slug = slugify(base.name || basename(base.baseDir));
    const files = collectFiles(base.baseDir, slug);
    for (const { srcPath, destName } of files) {
      expectedFiles.set(destName, srcPath);
    }
  }

  let synced = 0;
  let skipped = 0;

  for (const [destName, srcPath] of expectedFiles) {
    try {
      const srcStat = statSync(srcPath);
      const srcMtime = srcStat.mtimeMs;
      const prev = state.files[destName];

      if (prev && prev.mtime === srcMtime && prev.srcPath === srcPath) {
        skipped++;
        continue;
      }

      copyFileSync(srcPath, join(outputDir, destName));
      state.files[destName] = { mtime: srcMtime, srcPath };
      synced++;
    } catch {
      skipped++;
    }
  }

  // Clean up files that no longer have a source
  let deleted = 0;
  for (const destName of Object.keys(state.files)) {
    if (!expectedFiles.has(destName)) {
      try {
        const destPath = join(outputDir, destName);
        if (existsSync(destPath)) unlinkSync(destPath);
      } catch {}
      delete state.files[destName];
      deleted++;
    }
  }

  state.lastSyncAt = new Date().toISOString();
  saveSyncState(outputDir, state);

  return { synced, skipped, deleted, total: expectedFiles.size };
}

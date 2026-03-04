import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function log(msg) {
  console.log(`  ${msg}`);
}

export function heading(msg) {
  console.log(`\n${"=".repeat(60)}\n  ${msg}\n${"=".repeat(60)}`);
}

export function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function read(p) {
  return readFileSync(p, "utf-8");
}

/** List YYYY-MM-DD sub-dirs under a directory. */
export function listDateDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && statSync(join(dir, d)).isDirectory())
    .toSorted();
}

/** List .md files in a directory (non-recursive), excluding README.md and INDEX.md. */
export function listMdFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "INDEX.md",
  );
}

/** Extract the title (first # heading) from markdown content. */
export function extractTitle(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "(无标题)";
}

/** Check if an atom file is a placeholder (contains "（待提取）"). */
export function isPlaceholder(atomPath) {
  if (!existsSync(atomPath)) return false;
  return read(atomPath).includes("（待提取）");
}

/** Parse the abbreviation table from atoms/README.md into a Map<filename, abbrev>. */
export function parseAbbrevTable(readmeContent) {
  const map = new Map();
  const usedAbbrevs = new Set();
  for (const line of readmeContent.split("\n")) {
    const m = line.match(/^\|\s*([A-Z]{2})\s*\|\s*(\S+)\s*\|/);
    if (m) {
      map.set(m[2], m[1]);
      usedAbbrevs.add(m[1]);
    }
  }
  return { fileToAbbrev: map, usedAbbrevs };
}

/** Strip markdown code fences if model wrapped output in them. */
export function stripCodeFences(text) {
  const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m);
  if (fenceMatch) return fenceMatch[1];
  const fullMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```\s*$/);
  if (fullMatch) return fullMatch[1];
  return text;
}

// ---------------------------------------------------------------------------
// Key Line table parsing
// ---------------------------------------------------------------------------

/**
 * Parse the Key Line table from tree/README.md content.
 * Handles both standard and date-based table formats with any number of
 * intermediate columns. The last two content columns are always assumed to be
 * "Groups" and "Filename" (in that order).
 */
export function parseKeyLineTable(treeContent) {
  const lines = treeContent.split("\n");
  const result = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|") || line.includes("---|---")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 6) continue;

    const col1 = parts[1];
    if (!col1.startsWith("KL") || !parts[2]) continue;

    const isDateBased = /^\d{4}-\d{2}-\d{2}$/.test(parts[2]);
    const thesis = isDateBased ? parts[3] : parts[2];
    const date = isDateBased ? parts[2] : null;

    const groupsCol = parts[parts.length - 3];
    const filenameCol = parts[parts.length - 2];

    const filenameMatch = filenameCol.match(/(KL\d+[-\w]*\.md)/);
    const filename = filenameMatch
      ? filenameMatch[1]
      : filenameCol.includes(".md")
        ? filenameCol
        : `${col1}-expand.md`;

    result.push({
      klId: col1,
      date,
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
// Paths helper — build standard paths from a base directory
// ---------------------------------------------------------------------------

export function makePaths(baseDir) {
  return {
    journalDir: join(baseDir, "journal"),
    atomsDir: join(baseDir, "pyramid", "analysis", "atoms"),
    atomsReadme: join(baseDir, "pyramid", "analysis", "atoms", "README.md"),
    groupsDir: join(baseDir, "pyramid", "analysis", "groups"),
    groupsIndex: join(baseDir, "pyramid", "analysis", "groups", "INDEX.md"),
    synthesisPath: join(baseDir, "pyramid", "analysis", "synthesis.md"),
    structureDir: join(baseDir, "pyramid", "structure"),
    templateDir: join(baseDir, "pyramid", "structure", "_template"),
    structureIndex: join(baseDir, "pyramid", "structure", "INDEX.md"),
    outputsDir: join(baseDir, "outputs"),
  };
}

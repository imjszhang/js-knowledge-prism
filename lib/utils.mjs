import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** Write file only when content actually differs; returns true if written. */
export function writeIfChanged(filePath, content) {
  if (existsSync(filePath) && readFileSync(filePath, "utf-8") === content) {
    return false;
  }
  writeFileSync(filePath, content, "utf-8");
  return true;
}

/** List YYYY-MM-DD sub-dirs under a directory. */
export function listDateDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && statSync(join(dir, d)).isDirectory())
    .toSorted();
}

/** List .md files in a directory (non-recursive), excluding README.md, INDEX.md, SKILL.md, CONTEXT.md. */
export function listMdFiles(dir) {
  if (!existsSync(dir)) return [];
  const excluded = new Set(["README.md", "INDEX.md", "SKILL.md", "CONTEXT.md"]);
  return readdirSync(dir).filter((f) => f.endsWith(".md") && !excluded.has(f));
}

/** List series sub-dirs under the corpus directory (excludes _ prefixed dirs). */
export function listSeriesDirs(corpusDir) {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir)
    .filter((d) => !d.startsWith("_") && statSync(join(corpusDir, d)).isDirectory())
    .toSorted();
}

/** List .md files in a corpus series directory, excluding meta files like _series.md. */
export function listCorpusFiles(seriesDir) {
  if (!existsSync(seriesDir)) return [];
  return readdirSync(seriesDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md")
    .toSorted();
}

/** List PXX-* perspective directories under the structure dir. */
export function listPerspectiveDirs(structureDir) {
  if (!existsSync(structureDir)) return [];
  return readdirSync(structureDir)
    .filter((d) => /^P\d+/.test(d) && statSync(join(structureDir, d)).isDirectory())
    .toSorted();
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
  let inFence = false;
  for (const line of readmeContent.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
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
// Grouped-prefix detection (shared by status + process)
// ---------------------------------------------------------------------------

const ATOM_ID_RE = /([A-Z]{2})-(?:\d{4}-)?\d{2}/;
const ATOM_ID_TABLE_RE_G = new RegExp(`\\|\\s*(${ATOM_ID_RE.source})\\s*\\|`, "g");

/**
 * Scan all G*.md group files and return the set of 2-letter atom prefixes
 * that appear in any group table — either via standard `| XX-NN |` cells or
 * via a source-column fallback that resolves journal/corpus filenames through
 * the abbreviation mapping table in atoms/README.md.
 *
 * @param {{ groupsDir: string; atomsDir: string; atomsReadme: string }} paths
 * @returns {Set<string>}
 */
export function collectGroupedPrefixes(paths) {
  const prefixes = new Set();
  if (!existsSync(paths.groupsDir)) return prefixes;
  const groupFiles = listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G"));

  let abbrevMap = null;

  for (const f of groupFiles) {
    const content = read(join(paths.groupsDir, f));
    const matches = content.matchAll(ATOM_ID_TABLE_RE_G);
    for (const m of matches) prefixes.add(m[1].slice(0, 2));

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
    corpusDir: join(baseDir, "corpus"),
    atomsDir: join(baseDir, "pyramid", "analysis", "atoms"),
    atomsReadme: join(baseDir, "pyramid", "analysis", "atoms", "README.md"),
    groupsDir: join(baseDir, "pyramid", "analysis", "groups"),
    groupsIndex: join(baseDir, "pyramid", "analysis", "groups", "INDEX.md"),
    synthesisPath: join(baseDir, "pyramid", "analysis", "synthesis.md"),
    structureDir: join(baseDir, "pyramid", "structure"),
    templateDir: join(baseDir, "pyramid", "structure", "_template"),
    structureIndex: join(baseDir, "pyramid", "structure", "INDEX.md"),
    outputsDir: join(baseDir, "outputs"),
    outputsIndex: join(baseDir, "outputs", "INDEX.md"),
    skillMd: join(baseDir, "SKILL.md"),
  };
}

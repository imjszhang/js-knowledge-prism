import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makePaths,
  listDateDirs,
  listMdFiles,
  listSeriesDirs,
  listCorpusFiles,
  extractTitle,
  isPlaceholder,
  parseAbbrevTable,
  stripCodeFences,
} from "../lib/utils.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-test-"));
}

describe("makePaths", () => {
  it("returns all expected path keys including corpusDir", () => {
    const p = makePaths("/fake/base");
    assert.ok(p.journalDir.endsWith(join("fake", "base", "journal")));
    assert.ok(p.corpusDir.endsWith(join("fake", "base", "corpus")));
    assert.ok(p.atomsDir.endsWith(join("fake", "base", "pyramid", "analysis", "atoms")));
    assert.ok(p.groupsDir.endsWith(join("fake", "base", "pyramid", "analysis", "groups")));
    assert.ok(p.synthesisPath.endsWith(join("fake", "base", "pyramid", "analysis", "synthesis.md")));
    assert.ok(p.structureDir.endsWith(join("fake", "base", "pyramid", "structure")));
    assert.ok(p.outputsDir.endsWith(join("fake", "base", "outputs")));
  });
});

describe("listDateDirs", () => {
  it("returns empty for non-existent dir", () => {
    assert.deepEqual(listDateDirs("/nonexistent"), []);
  });

  it("lists only YYYY-MM-DD directories, sorted", () => {
    const tmp = makeTmpDir();
    try {
      mkdirSync(join(tmp, "2026-01-15"));
      mkdirSync(join(tmp, "2026-01-01"));
      mkdirSync(join(tmp, "not-a-date"));
      writeFileSync(join(tmp, "2026-02-01"), "file, not dir");
      const result = listDateDirs(tmp);
      assert.deepEqual(result, ["2026-01-01", "2026-01-15"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("listMdFiles", () => {
  it("returns empty for non-existent dir", () => {
    assert.deepEqual(listMdFiles("/nonexistent"), []);
  });

  it("lists .md files excluding README.md and INDEX.md", () => {
    const tmp = makeTmpDir();
    try {
      writeFileSync(join(tmp, "note.md"), "# Note");
      writeFileSync(join(tmp, "README.md"), "# README");
      writeFileSync(join(tmp, "INDEX.md"), "# INDEX");
      writeFileSync(join(tmp, "other.md"), "# Other");
      writeFileSync(join(tmp, "data.txt"), "text");
      const result = listMdFiles(tmp);
      assert.ok(result.includes("note.md"));
      assert.ok(result.includes("other.md"));
      assert.ok(!result.includes("README.md"));
      assert.ok(!result.includes("INDEX.md"));
      assert.ok(!result.includes("data.txt"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractTitle", () => {
  it("extracts first # heading", () => {
    assert.equal(extractTitle("# Hello World\nsome content"), "Hello World");
  });

  it("returns fallback for no heading", () => {
    assert.equal(extractTitle("no heading here"), "(无标题)");
  });
});

describe("isPlaceholder", () => {
  it("returns false for non-existent file", () => {
    assert.equal(isPlaceholder("/nonexistent/file.md"), false);
  });

  it("detects placeholder content", () => {
    const tmp = makeTmpDir();
    try {
      const p = join(tmp, "atom.md");
      writeFileSync(p, "# Atom\n\n（待提取）");
      assert.equal(isPlaceholder(p), true);

      writeFileSync(p, "# Atom\n\nReal content here");
      assert.equal(isPlaceholder(p), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("parseAbbrevTable", () => {
  it("parses abbreviation table from README content", () => {
    const content = [
      "| 缩写 | 文件名 |",
      "| ---- | ------ |",
      "| AB | note1.md |",
      "| CD | note2.md |",
    ].join("\n");
    const { fileToAbbrev, usedAbbrevs } = parseAbbrevTable(content);
    assert.equal(fileToAbbrev.get("note1.md"), "AB");
    assert.equal(fileToAbbrev.get("note2.md"), "CD");
    assert.ok(usedAbbrevs.has("AB"));
    assert.ok(usedAbbrevs.has("CD"));
  });

  it("returns empty for no matches", () => {
    const { fileToAbbrev } = parseAbbrevTable("no table here");
    assert.equal(fileToAbbrev.size, 0);
  });

  it("ignores table rows inside code fences", () => {
    const content = [
      "| AB | note1 |",
      "```markdown",
      "| CD | note2 |",
      "```",
      "| EF | note3 |",
    ].join("\n");
    const { fileToAbbrev, usedAbbrevs } = parseAbbrevTable(content);
    assert.equal(fileToAbbrev.size, 2);
    assert.ok(usedAbbrevs.has("AB"));
    assert.ok(!usedAbbrevs.has("CD"));
    assert.ok(usedAbbrevs.has("EF"));
  });
});

describe("stripCodeFences", () => {
  it("strips markdown code fences", () => {
    const input = "```markdown\n# Title\ncontent\n```";
    assert.equal(stripCodeFences(input), "# Title\ncontent");
  });

  it("strips md code fences", () => {
    const input = "```md\n# Title\n```";
    assert.equal(stripCodeFences(input), "# Title");
  });

  it("returns text unchanged if no fences", () => {
    assert.equal(stripCodeFences("plain text"), "plain text");
  });
});

describe("listSeriesDirs", () => {
  it("returns empty for non-existent dir", () => {
    assert.deepEqual(listSeriesDirs("/nonexistent"), []);
  });

  it("lists series directories, excluding _ prefixed", () => {
    const tmp = makeTmpDir();
    try {
      mkdirSync(join(tmp, "seriesA"));
      mkdirSync(join(tmp, "seriesB"));
      mkdirSync(join(tmp, "_internal"));
      writeFileSync(join(tmp, "file.md"), "not a dir");
      const result = listSeriesDirs(tmp);
      assert.deepEqual(result, ["seriesA", "seriesB"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("listCorpusFiles", () => {
  it("returns empty for non-existent dir", () => {
    assert.deepEqual(listCorpusFiles("/nonexistent"), []);
  });

  it("lists .md files excluding _series.md and README.md", () => {
    const tmp = makeTmpDir();
    try {
      writeFileSync(join(tmp, "0001-article.md"), "# A");
      writeFileSync(join(tmp, "0002-article.md"), "# B");
      writeFileSync(join(tmp, "_series.md"), "# Series");
      writeFileSync(join(tmp, "README.md"), "# README");
      writeFileSync(join(tmp, "data.txt"), "text");
      const result = listCorpusFiles(tmp);
      assert.deepEqual(result, ["0001-article.md", "0002-article.md"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

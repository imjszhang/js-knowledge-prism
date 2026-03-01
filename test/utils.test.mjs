import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  makePaths,
  listDateDirs,
  listMdFiles,
  extractTitle,
  isPlaceholder,
  parseAbbrevTable,
  stripCodeFences,
} from "../lib/utils.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-test-"));
}

describe("makePaths", () => {
  it("returns all expected path keys", () => {
    const p = makePaths("/fake/base");
    assert.equal(p.journalDir, "/fake/base/journal");
    assert.equal(p.atomsDir, "/fake/base/pyramid/analysis/atoms");
    assert.equal(p.groupsDir, "/fake/base/pyramid/analysis/groups");
    assert.equal(p.synthesisPath, "/fake/base/pyramid/analysis/synthesis.md");
    assert.equal(p.structureDir, "/fake/base/pyramid/structure");
    assert.equal(p.outputsDir, "/fake/base/outputs");
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

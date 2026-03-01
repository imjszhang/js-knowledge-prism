import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getStatus } from "../lib/status.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-status-test-"));
}

function scaffold(tmp) {
  const dirs = [
    "journal",
    "pyramid/analysis/atoms",
    "pyramid/analysis/groups",
    "pyramid/structure",
    "pyramid/structure/_template",
    "outputs",
  ];
  for (const d of dirs) {
    mkdirSync(join(tmp, d), { recursive: true });
  }
  writeFileSync(
    join(tmp, "pyramid/analysis/atoms/README.md"),
    "| 缩写 | 文件名 |\n| ---- | ------ |\n",
  );
  writeFileSync(
    join(tmp, "pyramid/analysis/synthesis.md"),
    "# Synthesis\n",
  );
  writeFileSync(
    join(tmp, "pyramid/analysis/groups/INDEX.md"),
    "# Groups Index\n",
  );
  writeFileSync(
    join(tmp, "pyramid/structure/INDEX.md"),
    "# Structure Index\n",
  );
}

describe("getStatus", () => {
  let tmpDirs = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("returns zeros for empty scaffold", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    const s = getStatus(tmp);
    assert.equal(s.totalJournals, 0);
    assert.equal(s.totalDates, 0);
    assert.equal(s.totalAtoms, 0);
    assert.equal(s.totalGroups, 0);
    assert.equal(s.totalPerspectives, 0);
    assert.equal(s.ungroupedCount, 0);
    assert.deepEqual(s.unprocessed, []);
  });

  it("counts journals and detects unprocessed", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    const dateDir = join(tmp, "journal/2026-03-01");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(join(dateDir, "note1.md"), "# Note 1");
    writeFileSync(join(dateDir, "note2.md"), "# Note 2");

    const s = getStatus(tmp);
    assert.equal(s.totalJournals, 2);
    assert.equal(s.totalDates, 1);
    assert.equal(s.unprocessed.length, 2);
    assert.equal(s.unprocessed[0].dateDir, "2026-03-01");
  });

  it("counts atoms and perspectives", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    const atomMonth = join(tmp, "pyramid/analysis/atoms/2026-03");
    mkdirSync(atomMonth, { recursive: true });
    writeFileSync(join(atomMonth, "note1.md"), "# Atom 1\n> 缩写: AB");
    writeFileSync(join(atomMonth, "note2.md"), "# Atom 2\n> 缩写: CD");

    const perspDir = join(tmp, "pyramid/structure/P01-test");
    mkdirSync(perspDir, { recursive: true });

    const s = getStatus(tmp);
    assert.equal(s.totalAtoms, 2);
    assert.equal(s.totalPerspectives, 1);
  });

  it("counts groups", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    writeFileSync(
      join(tmp, "pyramid/analysis/groups/G01-topic.md"),
      "# Group 1\n| AB-01 |\n",
    );
    writeFileSync(
      join(tmp, "pyramid/analysis/groups/G02-topic.md"),
      "# Group 2\n| CD-01 |\n",
    );

    const s = getStatus(tmp);
    assert.equal(s.totalGroups, 2);
  });
});

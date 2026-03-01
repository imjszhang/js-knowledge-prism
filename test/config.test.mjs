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

import { findConfigPath, CONFIG_FILENAME } from "../lib/config.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-cfg-test-"));
}

describe("findConfigPath", () => {
  let tmpDirs = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("finds config in same directory", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    writeFileSync(join(tmp, CONFIG_FILENAME), '{"name":"test"}');
    const result = findConfigPath(tmp);
    assert.equal(result, join(tmp, CONFIG_FILENAME));
  });

  it("finds config in parent directory", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    writeFileSync(join(tmp, CONFIG_FILENAME), '{"name":"test"}');
    const child = join(tmp, "sub");
    mkdirSync(child);
    const result = findConfigPath(child);
    assert.equal(result, join(tmp, CONFIG_FILENAME));
  });

  it("returns null when config not found", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const result = findConfigPath(tmp);
    assert.equal(result, null);
  });
});

describe("CONFIG_FILENAME", () => {
  it("is .knowledgeprism.json", () => {
    assert.equal(CONFIG_FILENAME, ".knowledgeprism.json");
  });
});

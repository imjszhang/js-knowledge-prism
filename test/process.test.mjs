import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createHttpCaller,
  generateAbbrevCandidates,
  resolveAbbrevConflict,
  replaceAbbrevInOutput,
} from "../lib/process.mjs";

describe("createHttpCaller", () => {
  it("returns a function", () => {
    const caller = createHttpCaller({
      baseUrl: "http://localhost:9999/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    assert.equal(typeof caller, "function");
  });

  it("rejects on connection error", async () => {
    const caller = createHttpCaller({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      apiKey: "test-key",
      timeoutMs: 2000,
      log: () => {},
    });

    await assert.rejects(
      () => caller("test system prompt", "test user prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("generateAbbrevCandidates", () => {
  it("generates candidates from hyphenated stem", () => {
    const candidates = generateAbbrevCandidates("js-eyes-project-creation");
    assert.ok(candidates.includes("JE"));
    assert.ok(candidates.includes("JP"));
    assert.ok(candidates.includes("JC"));
    assert.ok(candidates.includes("EP"));
    assert.ok(candidates.length > 3);
  });

  it("includes first-two-letter candidates from each word", () => {
    const candidates = generateAbbrevCandidates("knowledge-prism");
    assert.ok(candidates.includes("KP"));
    assert.ok(candidates.includes("KN"));
    assert.ok(candidates.includes("PR"));
  });

  it("returns no duplicates", () => {
    const candidates = generateAbbrevCandidates("aa-ab-ac");
    const unique = [...new Set(candidates)];
    assert.equal(candidates.length, unique.length);
  });
});

describe("resolveAbbrevConflict", () => {
  it("returns first unused candidate", () => {
    const used = new Set(["JE", "JP"]);
    const result = resolveAbbrevConflict("js-eyes-project-creation", used);
    assert.ok(result);
    assert.ok(!used.has(result));
    assert.equal(result.length, 2);
    assert.match(result, /^[A-Z]{2}$/);
  });

  it("falls back to brute-force when all candidates conflict", () => {
    const used = new Set();
    for (const c of generateAbbrevCandidates("js-eyes-project-creation")) {
      used.add(c);
    }
    const result = resolveAbbrevConflict("js-eyes-project-creation", used);
    assert.ok(result);
    assert.ok(!used.has(result));
  });

  it("returns null only when all 676 combinations are taken", () => {
    const allUsed = new Set();
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        allUsed.add(String.fromCharCode(a) + String.fromCharCode(b));
      }
    }
    const result = resolveAbbrevConflict("test", allUsed);
    assert.equal(result, null);
  });
});

describe("replaceAbbrevInOutput", () => {
  it("replaces abbreviation in header and atom IDs", () => {
    const input = [
      "# Test Title",
      "> 来源：[link](path)",
      "> 缩写：JE",
      "",
      "## Atoms",
      "| 编号 | 类型 | 内容 |",
      "| --- | --- | --- |",
      "| JE-01 | 事实 | something |",
      "| JE-02 | 步骤 | another |",
    ].join("\n");

    const result = replaceAbbrevInOutput(input, "JE", "XY");

    assert.ok(result.includes("> 缩写：XY"));
    assert.ok(result.includes("XY-01"));
    assert.ok(result.includes("XY-02"));
    assert.ok(!result.includes("JE-01"));
    assert.ok(!result.includes("JE-02"));
  });

  it("handles full-width colon in abbreviation line", () => {
    const input = "> 缩写：KP\n| KP-01 | 事实 | test |";
    const result = replaceAbbrevInOutput(input, "KP", "ZZ");
    assert.ok(result.includes("> 缩写：ZZ"));
    assert.ok(result.includes("ZZ-01"));
  });

  it("replaces 3-segment corpus atom IDs (XX-NNNN-NN)", () => {
    const input = [
      "> 缩写：SK",
      "| SK-0010-01 | 事实 | something |",
      "| SK-0010-02 | 判断 | another |",
    ].join("\n");
    const result = replaceAbbrevInOutput(input, "SK", "ZB");
    assert.ok(result.includes("> 缩写：ZB"));
    assert.ok(result.includes("ZB-0010-01"));
    assert.ok(result.includes("ZB-0010-02"));
    assert.ok(!result.includes("SK-0010-01"));
  });
});

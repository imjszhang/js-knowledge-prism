import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractGraph, analyzeGraph, generateGraphHtml } from "../lib/graph.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-graph-test-"));
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
  for (const d of dirs) mkdirSync(join(tmp, d), { recursive: true });

  writeFileSync(
    join(tmp, "pyramid/analysis/atoms/README.md"),
    "| 缩写 | 文件名                                  | 月份    |\n| ---- | --------------------------------------- | ------- |\n| AB   | note1                                   | 2026-03 |\n",
  );
  writeFileSync(
    join(tmp, "pyramid/analysis/synthesis.md"),
    "# 收敛（Synthesis）\n\n## 顶层观点候选\n\n| 编号 | 观点 | 置信度 | 支撑 Groups |\n| ---- | ---- | ------ | ----------- |\n| S1   | 测试观点 | 高     | G01         |\n\n## 修订记录\n",
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

describe("extractGraph", () => {
  let tmpDirs = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it("returns empty graph for empty scaffold", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    const graph = extractGraph(tmp);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(Array.isArray(graph.links));
    const synthNodes = graph.nodes.filter((n) => n.type === "synthesis");
    assert.equal(synthNodes.length, 1, "should find 1 synthesis candidate");
  });

  it("discovers journal nodes", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    mkdirSync(join(tmp, "journal/2026-03-01"), { recursive: true });
    writeFileSync(join(tmp, "journal/2026-03-01/note1.md"), "# My Note");

    const graph = extractGraph(tmp);
    const journals = graph.nodes.filter((n) => n.type === "journal");
    assert.equal(journals.length, 1);
    assert.ok(journals[0].name.includes("My Note"));
    assert.equal(journals[0].meta.date, "2026-03-01");
  });

  it("discovers atom nodes and journal->atom links", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    mkdirSync(join(tmp, "journal/2026-03-01"), { recursive: true });
    writeFileSync(join(tmp, "journal/2026-03-01/note1.md"), "# Note One");

    mkdirSync(join(tmp, "pyramid/analysis/atoms/2026-03"), { recursive: true });
    writeFileSync(
      join(tmp, "pyramid/analysis/atoms/2026-03/note1.md"),
      "# Note One\n\n> 来源：[Note One](../../../../journal/2026-03-01/note1.md)\n> 缩写：AB\n\n## Atoms\n\n| 编号  | 类型 | 内容 | 原文定位 |\n| ----- | ---- | ---- | -------- |\n| AB-01 | 事实 | 测试内容 | 章节1 |\n",
    );

    const graph = extractGraph(tmp);
    const atoms = graph.nodes.filter((n) => n.type === "atom");
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].meta.abbrev, "AB");

    const extractLinks = graph.links.filter((l) => l.type === "extract");
    assert.equal(extractLinks.length, 1);
    assert.ok(extractLinks[0].source.includes("journal/2026-03-01/note1.md"));
    assert.ok(extractLinks[0].target.includes("atoms/2026-03/note1.md"));
  });

  it("discovers group nodes and atom->group links", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    mkdirSync(join(tmp, "pyramid/analysis/atoms/2026-03"), { recursive: true });
    writeFileSync(
      join(tmp, "pyramid/analysis/atoms/2026-03/note1.md"),
      "# Note One\n\n> 来源：[x](y)\n> 缩写：AB\n\n## Atoms\n\n| 编号  | 类型 | 内容 | 原文定位 |\n| ----- | ---- | ---- | -------- |\n| AB-01 | 事实 | 测试 | 章节1 |\n| AB-02 | 步骤 | 测试 | 章节2 |\n",
    );
    writeFileSync(
      join(tmp, "pyramid/analysis/groups/G01-test.md"),
      "# G01: 测试分组\n\n| 编号  | 来源 | 内容摘要 |\n| ----- | ---- | -------- |\n| AB-01 | note1 | 测试 |\n| AB-02 | note1 | 测试 |\n",
    );

    const graph = extractGraph(tmp);
    const groups = graph.nodes.filter((n) => n.type === "group");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].meta.gId, "G01");
    assert.equal(groups[0].meta.atomCount, 2);

    const classifyLinks = graph.links.filter((l) => l.type === "classify");
    assert.equal(classifyLinks.length, 2);
  });

  it("discovers synthesis nodes and group->synthesis links", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    writeFileSync(
      join(tmp, "pyramid/analysis/groups/G01-test.md"),
      "# G01: 测试分组\n",
    );

    const graph = extractGraph(tmp);
    const synthesis = graph.nodes.filter((n) => n.type === "synthesis");
    assert.equal(synthesis.length, 1);
    assert.equal(synthesis[0].meta.sId, "S1");

    const supportLinks = graph.links.filter((l) => l.type === "support");
    assert.equal(supportLinks.length, 1);
  });

  it("discovers perspective nodes and synthesis->perspective links", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    scaffold(tmp);

    writeFileSync(
      join(tmp, "pyramid/analysis/groups/G01-test.md"),
      "# G01: 测试分组\n",
    );

    const perspDir = join(tmp, "pyramid/structure/P01-test-topic");
    mkdirSync(perspDir, { recursive: true });
    mkdirSync(join(perspDir, "tree"), { recursive: true });
    writeFileSync(
      join(perspDir, "tree/README.md"),
      "# Key Lines\n\n| 序号 | 论点 | Groups | 文件名 |\n| ---- | ---- | ------ | ------ |\n| KL01 | 测试论点 | G01 | KL01-test.md |\n",
    );

    const graph = extractGraph(tmp);
    const perspectives = graph.nodes.filter((n) => n.type === "perspective");
    assert.equal(perspectives.length, 1);
    assert.equal(perspectives[0].meta.pId, "P01");

    const structureLinks = graph.links.filter((l) => l.type === "structure");
    assert.equal(structureLinks.length, 1);
  });
});

describe("analyzeGraph", () => {
  it("computes stats for empty graph", () => {
    const stats = analyzeGraph({ nodes: [], links: [] });
    assert.equal(stats.totalNodes, 0);
    assert.equal(stats.totalLinks, 0);
    assert.equal(stats.orphanCount, 0);
    assert.equal(stats.coverage, 0);
    assert.deepEqual(stats.brokenLinks, []);
  });

  it("computes correct coverage and orphan count", () => {
    const nodes = [
      { id: "a", name: "A", type: "journal" },
      { id: "b", name: "B", type: "atom" },
      { id: "c", name: "C", type: "group" },
    ];
    const links = [{ source: "a", target: "b", type: "extract" }];

    const stats = analyzeGraph({ nodes, links });
    assert.equal(stats.totalNodes, 3);
    assert.equal(stats.totalLinks, 1);
    assert.equal(stats.orphanCount, 1);
    assert.equal(stats.coverage, 67);
    assert.equal(stats.orphanNodes[0].id, "c");
  });

  it("detects broken links", () => {
    const nodes = [{ id: "a", name: "A", type: "journal" }];
    const links = [{ source: "a", target: "missing", type: "extract" }];

    const stats = analyzeGraph({ nodes, links });
    assert.equal(stats.brokenLinks.length, 1);
    assert.equal(stats.brokenLinks[0].target, "missing");
  });

  it("computes type counts", () => {
    const nodes = [
      { id: "1", name: "J1", type: "journal" },
      { id: "2", name: "J2", type: "journal" },
      { id: "3", name: "A1", type: "atom" },
      { id: "4", name: "G1", type: "group" },
    ];

    const stats = analyzeGraph({ nodes, links: [] });
    assert.equal(stats.typeCounts.journal, 2);
    assert.equal(stats.typeCounts.atom, 1);
    assert.equal(stats.typeCounts.group, 1);
    assert.equal(stats.typeCounts.synthesis, 0);
  });
});

describe("generateGraphHtml", () => {
  let tmpDirs = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it("generates HTML file with injected data", () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);
    const outputPath = join(tmp, "graph.html");

    const graph = {
      nodes: [{ id: "test", name: "Test Node", type: "journal", path: "test.md", meta: {} }],
      links: [],
    };
    const stats = analyzeGraph(graph);

    generateGraphHtml(graph, stats, {
      outputPath,
      knowledgeBaseName: "Test KB",
      log: () => {},
    });

    assert.ok(existsSync(outputPath));
    const content = readFileSync(outputPath, "utf-8");
    assert.ok(content.includes("Test Node"), "should contain node name");
    assert.ok(content.includes("Test KB"), "should contain KB name");
    assert.ok(content.includes("d3"), "should reference d3");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSkillMd, generateContext, runAgentIndex } from "../lib/agent-index.mjs";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "kp-agent-idx-"));
}

function scaffoldKnowledgeBase(tmp, opts = {}) {
  const name = opts.name || "Test KB";

  writeFileSync(join(tmp, ".knowledgeprism.json"), JSON.stringify({ name }));

  mkdirSync(join(tmp, "journal"), { recursive: true });

  const atomsDir = join(tmp, "pyramid", "analysis", "atoms");
  mkdirSync(atomsDir, { recursive: true });
  writeFileSync(join(atomsDir, "README.md"), "# Atoms\n\n| 缩写 | journal 文件名 | 月份 |\n| ---- | ------------- | ---- |\n");

  const groupsDir = join(tmp, "pyramid", "analysis", "groups");
  mkdirSync(groupsDir, { recursive: true });
  writeFileSync(
    join(groupsDir, "INDEX.md"),
    [
      "# 分组索引",
      "",
      "## 分组总览",
      "",
      "| 编号 | 观点句 | atom 数量 | 来源月份跨度 |",
      "| ---- | ------ | --------- | ------------ |",
      "| G01 | 知识管理方法论是高效学习的关键。 | 10 | 2026-03 |",
      "| G02 | Agent 架构优化提升了工具调用效率。 | 8 | 2026-03 |",
      "",
      "## 变更日志",
      "",
      "| 日期 | 操作 | 说明 |",
      "| ---- | ---- | ---- |",
    ].join("\n"),
  );

  writeFileSync(
    join(tmp, "pyramid", "analysis", "synthesis.md"),
    [
      "# 收敛（Synthesis）",
      "",
      "## 顶层观点候选",
      "",
      "| 编号 | 候选观点 | 支撑 Groups | 状态 |",
      "| ---- | -------- | ----------- | ---- |",
      "| S1 | 知识棱镜将笔记转化为结构化知识。 | G01 | 待验证 |",
      "| S2 | Agent-First 架构优化工具调用。 | G02 | 待验证 |",
      "",
      "## 修订记录",
      "",
      "| 日期 | 变更摘要 |",
      "| ---- | -------- |",
    ].join("\n"),
  );

  const structDir = join(tmp, "pyramid", "structure");
  mkdirSync(structDir, { recursive: true });
  writeFileSync(
    join(structDir, "INDEX.md"),
    [
      "# 视角索引",
      "",
      "## 视角总览",
      "",
      "| 编号 | 视角名称 | 目标读者 | 核心疑问 | 状态 |",
      "| ---- | -------- | -------- | -------- | ---- |",
      "| P01  | [架构全景](P01-arch-overview/) | 架构师 | 如何构建高效架构 | 初始化 |",
      "",
      "## 变更日志",
      "",
      "| 日期 | 操作 | 说明 |",
      "| ---- | ---- | ---- |",
    ].join("\n"),
  );

  mkdirSync(join(structDir, "_template"), { recursive: true });

  const outputsDir = join(tmp, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  writeFileSync(
    join(outputsDir, "INDEX.md"),
    [
      "# 产出索引",
      "",
      "## 产出总览",
      "",
      "| 产出 | 格式 | 基于视角 | 状态 |",
      "| ---- | ---- | -------- | ---- |",
      "",
      "## 变更日志",
      "",
      "| 日期 | 操作 | 说明 |",
      "| ---- | ---- | ---- |",
    ].join("\n"),
  );

  return tmp;
}

function scaffoldPerspective(structDir, id, slug, opts = {}) {
  const dirName = `${id}-${slug}`;
  const perspDir = join(structDir, dirName);
  mkdirSync(perspDir, { recursive: true });
  mkdirSync(join(perspDir, "tree"), { recursive: true });

  writeFileSync(
    join(perspDir, "scqa.md"),
    opts.scqa ||
      [
        "# 序言设计（SCQA）",
        "",
        "> 所属视角：P01-arch-overview",
        "",
        "## 目标读者画像",
        "",
        "| 维度     | 描述 |",
        "| -------- | ---- |",
        "| 角色     | 架构师 |",
        "| 背景知识 | 熟悉软件架构 |",
        "| 核心诉求 | 如何构建以 AI Agent 为中心的架构 |",
        "",
        "## S - 情境（Situation）",
        "",
        "AI 技术正在快速发展并被集成到产品中。",
        "",
        "## C - 冲突（Complication）",
        "",
        "传统架构不适应 AI 需求，导致效率低下。",
        "",
        "## Q - 疑问（Question）",
        "",
        "如何设计以 AI Agent 为中心的架构？",
        "",
        "## A - 答案（Answer）",
        "",
        "采用 Agent-First 架构模式优化工具调用。",
      ].join("\n"),
  );

  writeFileSync(
    join(perspDir, "tree", "README.md"),
    opts.tree ||
      [
        "# 金字塔全树",
        "",
        "> 所属视角：P01-arch-overview",
        "",
        "## Key Line（顶层论点）",
        "",
        "| 序号 | 论点 | 逻辑顺序类型 | 引用 Groups | 详细展开 |",
        "| ---- | ---- | ------------ | ----------- | -------- |",
        "| KL01 | 知识管理方法论。 | 结构 | G01 | KL01-knowledge.md |",
        "| KL02 | Agent 架构优化。 | 结构 | G02 | KL02-agent.md |",
      ].join("\n"),
  );

  writeFileSync(join(perspDir, "validation.md"), "# 验证\n");

  return perspDir;
}

// ---------------------------------------------------------------------------
// generateSkillMd
// ---------------------------------------------------------------------------

describe("generateSkillMd", () => {
  it("generates valid SKILL.md with frontmatter", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes('name: "Test KB"'));
      assert.ok(content.includes("description:"));
      assert.ok(content.includes("js-knowledge-prism"));
      assert.ok(content.includes("# 知识地图"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts synthesis candidates into body", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.includes("## 顶层观点"));
      assert.ok(content.includes("S1"));
      assert.ok(content.includes("知识棱镜将笔记转化为结构化知识"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts groups index into body", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.includes("## 分组索引"));
      assert.ok(content.includes("G01"));
      assert.ok(content.includes("知识管理方法论"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts perspectives index with CONTEXT.md links", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      scaffoldPerspective(join(tmp, "pyramid", "structure"), "P01", "arch-overview");
      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.includes("## 视角索引"));
      assert.ok(content.includes("P01"));
      assert.ok(content.includes("CONTEXT.md"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes retrieval guide", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.includes("## 检索指引"));
      assert.ok(content.includes("CONTEXT.md"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves user-customised frontmatter fields", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);

      const existingSkill = [
        "---",
        'name: "Old Name"',
        'description: "old"',
        "version: 1.0.0",
        "metadata:",
        "  openclaw:",
        '    emoji: "🧠"',
        "    requires:",
        "      skills:",
        "        - js-knowledge-prism",
        "custom_field: my-value",
        "---",
        "",
        "# Old body",
      ].join("\n");
      writeFileSync(join(tmp, "SKILL.md"), existingSkill);

      const content = generateSkillMd(tmp, { name: "Test KB" });

      assert.ok(content.includes('name: "Test KB"'), "name should be updated");
      assert.ok(content.includes("custom_field: my-value"), "custom field should be preserved");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles empty knowledge base", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      // Remove synthesis to simulate minimal state
      const synPath = join(tmp, "pyramid", "analysis", "synthesis.md");
      rmSync(synPath);

      const content = generateSkillMd(tmp, { name: "Empty KB" });
      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes("# 知识地图"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// generateContext
// ---------------------------------------------------------------------------

describe("generateContext", () => {
  it("generates valid CONTEXT.md with read_when frontmatter", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P01", "arch-overview");

      const content = generateContext(perspDir);

      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes("summary:"));
      assert.ok(content.includes("read_when:"));
      assert.ok(content.includes("P01"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts SCQA summary from scqa.md", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P01", "arch-overview");

      const content = generateContext(perspDir);

      assert.ok(content.includes("AI 技术正在快速发展"));
      assert.ok(content.includes("传统架构不适应"));
      assert.ok(content.includes("如何设计以 AI Agent 为中心的架构"));
      assert.ok(content.includes("Agent-First 架构模式"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts reader summary", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P01", "arch-overview");

      const content = generateContext(perspDir);

      assert.ok(content.includes("架构师"));
      assert.ok(content.includes("核心诉求"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("extracts Key Lines from tree/README.md", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P01", "arch-overview");

      const content = generateContext(perspDir);

      assert.ok(content.includes("## Key Lines"));
      assert.ok(content.includes("KL01"));
      assert.ok(content.includes("KL02"));
      assert.ok(content.includes("G01"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes deep reading links", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P01", "arch-overview");

      const content = generateContext(perspDir);

      assert.ok(content.includes("[scqa.md](scqa.md)"));
      assert.ok(content.includes("[tree/README.md](tree/README.md)"));
      assert.ok(content.includes("[validation.md](validation.md)"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles unfilled SCQA (placeholder content)", () => {
    const tmp = makeTmpDir();
    try {
      const structDir = join(tmp, "pyramid", "structure");
      mkdirSync(structDir, { recursive: true });
      const perspDir = scaffoldPerspective(structDir, "P02", "empty-persp", {
        scqa: [
          "# 序言设计（SCQA）",
          "",
          "> 所属视角：P02-empty-persp",
          "",
          "## S - 情境（Situation）",
          "",
          "（待填充）",
          "",
          "## C - 冲突（Complication）",
          "",
          "（待填充）",
          "",
          "## Q - 疑问（Question）",
          "",
          "（待填充）",
          "",
          "## A - 答案（Answer）",
          "",
          "（待填充）",
        ].join("\n"),
        tree: [
          "# 金字塔全树",
          "",
          "## Key Line（顶层论点）",
          "",
          "| 序号 | 论点 | 逻辑顺序类型 | 引用 Groups | 详细展开 |",
          "| ---- | ---- | ------------ | ----------- | -------- |",
        ].join("\n"),
      });

      const content = generateContext(perspDir);

      assert.ok(content.includes("（待填充）"), "should show placeholders");
      assert.ok(!content.includes("## Key Lines"), "should skip empty KL table");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles missing scqa.md gracefully", () => {
    const tmp = makeTmpDir();
    try {
      const perspDir = join(tmp, "P03-no-scqa");
      mkdirSync(perspDir, { recursive: true });
      mkdirSync(join(perspDir, "tree"), { recursive: true });
      writeFileSync(join(perspDir, "tree", "README.md"), "# Empty tree\n");

      const content = generateContext(perspDir);

      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes("（待填充）"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runAgentIndex
// ---------------------------------------------------------------------------

describe("runAgentIndex", () => {
  it("generates both SKILL.md and CONTEXT.md files", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      scaffoldPerspective(join(tmp, "pyramid", "structure"), "P01", "arch-overview");

      const logs = [];
      const result = runAgentIndex({
        baseDir: tmp,
        config: { name: "Test KB" },
        log: (msg) => logs.push(msg),
        warn: () => {},
      });

      assert.equal(result.skillMdWritten, true);
      assert.equal(result.contextCount, 1);

      const skillContent = readFileSync(join(tmp, "SKILL.md"), "utf-8");
      assert.ok(skillContent.includes('name: "Test KB"'));

      const ctxContent = readFileSync(
        join(tmp, "pyramid", "structure", "P01-arch-overview", "CONTEXT.md"),
        "utf-8",
      );
      assert.ok(ctxContent.includes("read_when:"));
      assert.ok(ctxContent.includes("KL01"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles knowledge base with no perspectives", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);

      const result = runAgentIndex({
        baseDir: tmp,
        config: { name: "Empty" },
        log: () => {},
        warn: () => {},
      });

      assert.equal(result.skillMdWritten, true);
      assert.equal(result.contextCount, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles multiple perspectives", () => {
    const tmp = makeTmpDir();
    try {
      scaffoldKnowledgeBase(tmp);
      const structDir = join(tmp, "pyramid", "structure");
      scaffoldPerspective(structDir, "P01", "first");
      scaffoldPerspective(structDir, "P02", "second");

      const result = runAgentIndex({
        baseDir: tmp,
        config: { name: "Multi" },
        log: () => {},
        warn: () => {},
      });

      assert.equal(result.contextCount, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

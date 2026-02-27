/**
 * Fill perspective content: SCQA and Key Line stages.
 * Uses LLM (callAgent) to generate content from synthesis and groups.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makePaths, stripCodeFences } from "./utils.mjs";

const SCQA_SYSTEM = `你是一个结构化思维专家。根据 synthesis（顶层观点）和 groups（归组后的 atoms），生成一个视角的完整 SCQA。
输出完整的 scqa.md 文件内容，使用以下结构。填满每个部分。不要添加多余解释。

# 序言设计（SCQA）

> 所属视角：（填写视角名称）

## 目标读者画像

| 维度     | 描述                                |
| -------- | ----------------------------------- |
| 角色     | ...                                 |
| 背景知识 | ...                                 |
| 核心诉求 | ...                                 |

## S - 情境（Situation）

（2-4 句读者已认同的背景事实）

## C - 冲突（Complication）

（在上述情境下出现了什么变化、矛盾或痛点？）

## Q - 疑问（Question）

（冲突自然引发的核心问题，读者最想回答的一个问题）

## A - 答案（Answer）

（一句话：你的核心主张，金字塔的塔尖。需与 synthesis 顶层观点一致）

## 验证

- [ ] S 是否是读者已有的共识？
- [ ] C 是否自然地从 S 中产生？
- [ ] Q 是否是 C 的必然追问？
- [ ] A 是否直接回答 Q？
- [ ] A 是否与 synthesis 的顶层观点一致或有意调整？

---

## 修订记录

| 日期 | 变更摘要               |
| ---- | ---------------------- |
|      | （首次设计后开始记录） |`;

const KEYLINE_SYSTEM = `你是金字塔原理专家。根据 synthesis、groups INDEX 和塔尖（scqa 的 Answer），生成 Key Line 表格行。
只输出 Markdown 表格行（不要表头行）。每行格式：
| KLnn | <论点句> | 时间/结构/程度 | Gxx, Gyy | KLnn-slug.md |
使用 2-5 个 Key Line。从 synthesis 中选取支撑塔尖的观点，并引用对应 groups。slug 为短横线分隔的英文。`;

function readSafe(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function extractAnswer(scqaContent) {
  const m = scqaContent.match(/## A - 答案[\s\S]*?\n\n([\s\S]*?)(?=\n## |$)/);
  return (m?.[1] ?? "").trim();
}

/**
 * @param {{ baseDir: string; perspectiveDir: string; stage: "scqa" | "keyline"; autoWrite?: boolean; callAgent: (prompt: string) => Promise<string> }} opts
 * @returns {{ success: boolean; message: string; content?: string; error?: string }}
 */
export async function runFillPerspective({
  baseDir,
  perspectiveDir,
  stage,
  autoWrite = true,
  callAgent,
}) {
  const paths = makePaths(baseDir);
  const perspPath = join(paths.structureDir, perspectiveDir);

  if (!existsSync(perspPath)) {
    return { success: false, message: `视角目录不存在: ${perspPath}`, error: "PERSPECTIVE_NOT_FOUND" };
  }

  const synthesisPath = paths.synthesisPath;
  if (!existsSync(synthesisPath)) {
    return { success: false, message: `synthesis.md 不存在。请先运行 prism process。`, error: "SYNTHESIS_NOT_FOUND" };
  }

  const synthesis = readSafe(synthesisPath);
  const groupsIndex = readSafe(paths.groupsIndex);

  if (stage === "scqa") {
    const userPrompt = `## Synthesis
${synthesis}

## Groups INDEX
${groupsIndex}

生成完整 scqa.md。将「（填写视角名称）」替换为: ${perspectiveDir}`;

    let generated;
    try {
      generated = await callAgent(`${SCQA_SYSTEM}\n\n---\n\n${userPrompt}`);
    } catch (e) {
      const errMsg =
        e?.message ||
        (typeof e?.errors === "object" && e.errors?.length
          ? e.errors.map((x) => x?.message || x).join("; ")
          : null) ||
        e?.cause?.message ||
        String(e) ||
        "未知错误";
      return { success: false, message: `LLM 调用失败: ${errMsg}`, error: "LLM_ERROR" };
    }

    const content = stripCodeFences(generated.trim()).replace(
      /（填写视角名称）/g,
      perspectiveDir
    );

    const scqaPath = join(perspPath, "scqa.md");
    if (autoWrite) {
      writeFileSync(scqaPath, content, "utf-8");
    }

    return {
      success: true,
      message: autoWrite ? `SCQA 已写入 ${scqaPath}` : "SCQA 已生成（未写入）",
      content,
    };
  }

  if (stage === "keyline") {
    const scqaPath = join(perspPath, "scqa.md");
    const scqa = readSafe(scqaPath);
    const answer = extractAnswer(scqa) || "（未找到 Answer）";

    const userPrompt = `## 塔尖（scqa 的 Answer）
${answer}

## Synthesis
${synthesis}

## Groups INDEX
${groupsIndex}

生成 Key Line 表格行。只输出表格行，每行一个。`;

    let generated;
    try {
      generated = await callAgent(`${KEYLINE_SYSTEM}\n\n---\n\n${userPrompt}`);
    } catch (e) {
      const errMsg =
        e?.message ||
        (typeof e?.errors === "object" && e.errors?.length
          ? e.errors.map((x) => x?.message || x).join("; ")
          : null) ||
        e?.cause?.message ||
        String(e) ||
        "未知错误";
      return { success: false, message: `LLM 调用失败: ${errMsg}`, error: "LLM_ERROR" };
    }

    const rows = stripCodeFences(generated.trim())
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && !l.includes("---"))
      .join("\n");

    const tableBlock = `| 序号 | 论点       | 逻辑顺序类型   | 引用 Groups | 详细展开    |
| ---- | ---------- | -------------- | ----------- | ----------- |
${rows}`;

    const treePath = join(perspPath, "tree", "README.md");
    const existing = readSafe(treePath);

    const tableSection = `## 塔尖

> ${answer}

## Key Line（顶层论点）

塔尖下面的第一层支撑论点。每个论点回答读者看到塔尖后的下一层追问。

${tableBlock}

每个 Key Line 在本目录下有独立文件，承载该支的逐层展开。`;

    const updated = existing.replace(
      /## 塔尖[\s\S]*?每个 Key Line 在本目录下有独立文件[\s\S]*?逐层展开。/,
      tableSection
    );

    if (autoWrite) {
      writeFileSync(treePath, updated, "utf-8");
    }

    return {
      success: true,
      message: autoWrite ? `Key Line 表格已写入 ${treePath}` : "Key Line 已生成（未写入）",
      content: updated,
    };
  }

  return { success: false, message: `未知 stage: ${stage}`, error: "UNKNOWN_STAGE" };
}

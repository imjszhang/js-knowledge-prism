/**
 * Expand a Key Line into a full KLxx-xxx.md file.
 * Reads tree/README, referenced groups, calls LLM to generate support arguments.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makePaths, read } from "./utils.mjs";

function findGroupFile(groupsDir, g) {
  const exact = g.startsWith("G") ? `${g}.md` : `G${g.padStart(2, "0")}.md`;
  const exactPath = join(groupsDir, exact);
  if (existsSync(exactPath)) return exactPath;
  const prefix = g.startsWith("G") ? g : `G${g.padStart(2, "0")}`;
  const files = readdirSync(groupsDir).filter((f) => f.startsWith(prefix + "-") && f.endsWith(".md"));
  return files.length > 0 ? join(groupsDir, files[0]) : null;
}
import { stripCodeFences } from "./utils.mjs";

const EXPAND_KL_SYSTEM = `你是金字塔原理专家。根据 Key Line 论点、塔尖（上层论点）和引用的 groups 内容，生成 KL 文件正文。

输出完整 Markdown，结构如下：

# KLnn: [论点观点句 - 与输入一致]

> 所属视角：[视角名]
> 上层论点：塔尖

## 支撑论点

### n.1: [观点句]
- 逻辑顺序：时间/结构/程度
- 引用 atoms: XX-01, XX-02
- 引用 groups: Gxx

[1-2 句解释]

### n.2: [观点句]
...

## 论点间关系

[1-3 句说明子论点间的逻辑顺序：结构/时间/程度]`;

function parseKeyLineTable(treeContent) {
  const lines = treeContent.split("\n");
  const result = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|") || line.includes("---|---")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 6) continue;
    const col1 = parts[1];
    const col2 = parts[2];
    const col4 = parts[4] ?? "";
    const col5 = parts[5] ?? "";
    if (!col1.startsWith("KL") || !col2) continue;

    const filenameMatch = col5.match(/(KL\d+[-\w]*\.md)/);
    const filename = filenameMatch ? filenameMatch[1] : col5.includes(".md") ? col5 : `${col1}-expand.md`;

    result.push({
      klId: col1,
      thesis: col2,
      groups: col4
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      filename,
    });
  }
  return result;
}

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
 * @param {{ baseDir: string; perspectiveDir: string; klId: string; autoWrite?: boolean; callAgent: (prompt: string) => Promise<string> }} opts
 * @returns {{ success: boolean; message: string; content?: string; error?: string }}
 */
export async function runExpandKl({
  baseDir,
  perspectiveDir,
  klId,
  autoWrite = true,
  callAgent,
}) {
  const paths = makePaths(baseDir);
  const perspPath = join(paths.structureDir, perspectiveDir);

  const treePath = join(perspPath, "tree", "README.md");
  if (!existsSync(treePath)) {
    return { success: false, message: `tree/README.md 不存在: ${treePath}`, error: "TREE_NOT_FOUND" };
  }

  const treeContent = read(treePath);
  const keyLines = parseKeyLineTable(treeContent);

  const normalizedKlId = klId.startsWith("KL") ? klId.replace(/^KL(\d+).*/, "KL$1") : `KL${klId}`;

  const kl = keyLines.find(
    (k) =>
      k.klId === normalizedKlId ||
      k.klId === klId ||
      k.filename.startsWith(normalizedKlId)
  );

  if (!kl) {
    return {
      success: false,
      message: `Key Line ${klId} 未在 tree/README.md 中找到。可用: ${keyLines.map((k) => k.klId).join(", ")}`,
      error: "KL_NOT_FOUND",
    };
  }

  const scqaPath = join(perspPath, "scqa.md");
  const scqa = readSafe(scqaPath);
  const apex = extractAnswer(scqa) || "（未找到塔尖）";

  const groupContents = [];
  for (const g of kl.groups) {
    const p = findGroupFile(paths.groupsDir, g);
    if (p) {
      groupContents.push(`### ${g}\n${readSafe(p)}`);
    }
  }

  const userPrompt = `## Key Line 论点
${kl.thesis}

## 塔尖（上层论点）
${apex}

## 引用的 groups 内容
${groupContents.join("\n\n")}

生成 KL 文件。所属视角: ${perspectiveDir}`;

  let generated;
  try {
    generated = await callAgent(`${EXPAND_KL_SYSTEM}\n\n---\n\n${userPrompt}`);
  } catch (e) {
    return { success: false, message: `LLM 调用失败: ${e.message}`, error: "LLM_ERROR" };
  }

  const content = stripCodeFences(generated.trim());
  const fullContent = content.trimStart().startsWith("#")
    ? content.trim()
    : `# ${kl.klId}: ${kl.thesis}\n\n> 所属视角：${perspectiveDir}\n> 上层论点：塔尖\n\n${content.trim()}`;

  const klPath = join(perspPath, "tree", kl.filename);
  if (autoWrite) {
    writeFileSync(klPath, fullContent, "utf-8");
  }

  return {
    success: true,
    message: autoWrite ? `KL 文件已写入 ${klPath}` : "KL 内容已生成（未写入）",
    content: fullContent,
  };
}

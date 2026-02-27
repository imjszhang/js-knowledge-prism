import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { makePaths, read } from "./utils.mjs";

const HELP = `
用法: js-knowledge-prism new-perspective <slug> [选项]

从模板创建新的金字塔视角。

参数:
  slug    视角的简短英文描述（用于目录名，如 blog-post）

选项:
  --name <name>       视角的中文名称（默认使用 slug）
  --base-dir <dir>    知识库根目录（覆盖配置）
  -h, --help          显示帮助

示例:
  npx js-knowledge-prism new-perspective blog-post --name "博客文章"
`.trim();

/**
 * Create a new perspective skeleton. Callable from CLI or AI tool.
 * @param {{ baseDir: string; slug: string; name?: string }} opts
 * @returns {{ perspectiveDir: string; dirName: string; files: string[] } | { error: string }}
 */
export function runWithBaseDir({ baseDir, slug, name }) {
  const paths = makePaths(baseDir);

  if (!existsSync(paths.structureDir)) {
    return { error: `pyramid/structure/ 不存在于 ${baseDir}。请先运行 prism init。` };
  }

  // Determine next perspective number
  let maxNum = 0;
  for (const entry of readdirSync(paths.structureDir)) {
    const m = entry.match(/^P(\d+)/);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  const nextNum = String(maxNum + 1).padStart(2, "0");
  const dirName = `P${nextNum}-${slug}`;
  const perspDir = join(paths.structureDir, dirName);

  if (existsSync(perspDir)) {
    return { error: `视角 ${dirName} 已存在` };
  }

  if (!existsSync(paths.templateDir)) {
    return { error: "未找到 _template/ 目录。请确保知识棱镜已正确初始化。" };
  }

  cpSync(paths.templateDir, perspDir, { recursive: true });

  const perspectiveName = name || slug;

  // Update structure/INDEX.md
  if (existsSync(paths.structureIndex)) {
    let index = read(paths.structureIndex);
    const today = new Date().toISOString().slice(0, 10);

    const tableRow = `| P${nextNum}  | [${perspectiveName}](${dirName}/) | （待填写） | （待填写） | 初始化 |`;
    const changelogHeadingIdx = index.indexOf("## 变更日志");
    if (changelogHeadingIdx >= 0) {
      const tableSection = index.slice(0, changelogHeadingIdx);
      const lastPipeIdx = tableSection.lastIndexOf("|");
      if (lastPipeIdx >= 0) {
        const insertPos = tableSection.indexOf("\n", lastPipeIdx);
        if (insertPos >= 0) {
          index = index.slice(0, insertPos) + "\n" + tableRow + index.slice(insertPos);
        }
      }
    }

    const changelogRow = `| ${today} | 创建 ${dirName} | 从模板初始化新视角 |`;
    const trimmed = index.trimEnd();
    index = trimmed + "\n" + changelogRow + "\n";

    writeFileSync(paths.structureIndex, index, "utf-8");
  }

  return {
    perspectiveDir: perspDir,
    dirName,
    files: ["scqa.md", "validation.md", "tree/README.md"],
  };
}

export async function run(args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      "base-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const slug = positionals[0];
  if (!slug) {
    console.error("错误: 请指定视角 slug\n");
    console.log(HELP);
    process.exit(1);
  }

  let baseDir;
  if (flags["base-dir"]) {
    baseDir = flags["base-dir"];
  } else {
    try {
      ({ baseDir } = loadConfig());
    } catch (e) {
      console.error("错误:", e.message);
      process.exit(1);
    }
  }

  const result = runWithBaseDir({
    baseDir,
    slug,
    name: flags.name,
  });

  if (result.error) {
    console.error(`错误: ${result.error}`);
    process.exit(1);
  }

  const { perspectiveDir: perspDir, dirName } = result;
  console.log(`\n✓ 已创建视角: ${dirName}`);
  console.log(`  路径: ${perspDir}`);
  console.log(`
下一步:
  1. 编辑 ${dirName}/scqa.md 设计序言（读者画像 + S-C-Q-A）
  2. 审视 synthesis.md 的候选观点
  3. 展开 ${dirName}/tree/（金字塔全树）
  4. 完成 ${dirName}/validation.md（MECE 检查）
`);
}

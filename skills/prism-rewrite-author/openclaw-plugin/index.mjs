import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listRewrites, loadRewrite } from "../../../lib/rewrite.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

  function resolveBaseDir() {
    if (pluginCfg.baseDir) return pluginCfg.baseDir;
    if (api.config?.agents?.defaults?.workspace) return api.config.agents.defaults.workspace;
    return process.cwd();
  }

  function textResult(text) {
    return { content: [{ type: "text", text }] };
  }

  function resolveRewritesDir(baseDir, target) {
    if (target === "builtin") {
      return join(PROJECT_ROOT, "templates", "outputs", "rewrites");
    }
    const local = join(baseDir, "outputs", "_templates", "rewrites");
    if (!existsSync(local)) mkdirSync(local, { recursive: true });
    return local;
  }

  // ---- Tool: prism_scaffold_rewrite ----------------------------------------

  api.registerTool(
    {
      name: "prism_scaffold_rewrite",
      label: "Prism: Scaffold Rewrite Definition",
      description:
        "在知识库 outputs/_templates/rewrites/ 下生成一个新改写定义的骨架文件（frontmatter + 区段占位）。" +
        "纯文件操作，不调用 LLM。生成后需手动填写 Rewrite Prompt 内容。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "改写定义名（如 kzk-wechat），将作为文件名和 frontmatter name",
          },
          description: {
            type: "string",
            description: "改写定义用途描述（可选）",
          },
          platform: {
            type: "string",
            enum: ["wechat", "zhihu", "twitter", "generic"],
            description: "目标平台。默认 generic。",
          },
          preserveStructure: {
            type: "boolean",
            description: "是否保留原文章节结构。默认 false。",
          },
          preserveLinks: {
            type: "boolean",
            description: "是否保留 Markdown 链接。默认 true。",
          },
          preserveFrontmatter: {
            type: "boolean",
            description: "是否保留原文 frontmatter。默认 false。",
          },
          review: {
            type: "boolean",
            description: "是否包含 Review Prompt 区段。默认 false。",
          },
          target: {
            type: "string",
            enum: ["local", "builtin"],
            description: "写入目标。local（默认）写入知识库 _templates/rewrites/；builtin 写入项目内置目录（仅维护者使用）。",
          },
          baseDir: {
            type: "string",
            description: "知识库根目录。省略则使用插件配置。",
          },
        },
        required: ["name"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const rewriteName = params.name.replace(/\.md$/, "");

        const existing = listRewrites(baseDir);
        if (existing.some((r) => r.name === rewriteName)) {
          return textResult(`错误: 改写定义 "${rewriteName}" 已存在。请使用其他名称或直接编辑现有文件。`);
        }

        const platform = params.platform || "generic";
        const preserveStructure = params.preserveStructure ?? false;
        const preserveLinks = params.preserveLinks ?? true;
        const preserveFrontmatter = params.preserveFrontmatter ?? false;
        const includeReview = params.review ?? false;

        const fmLines = [
          "---",
          `name: ${rewriteName}`,
        ];
        if (params.description) fmLines.push(`description: ${params.description}`);
        fmLines.push(`platform: ${platform}`);
        fmLines.push(`preserveStructure: ${preserveStructure}`);
        fmLines.push(`preserveLinks: ${preserveLinks}`);
        fmLines.push(`preserveFrontmatter: ${preserveFrontmatter}`);
        fmLines.push("---");

        const sections = [];

        sections.push(
          "# Rewrite Prompt",
          "",
          "<!-- TODO: 定义改写助手角色 -->",
          "",
          "<!-- TODO: 编写风格规则（节奏、语气、措辞、叙事结构、格式、禁止项） -->",
          "",
        );

        if (preserveStructure) {
          sections.push(
            "硬性约束：保持原文的章节结构不变，只改写语言风格。",
            "",
          );
        }

        sections.push(
          "请按照上述风格，改写以下文章。保留所有核心信息和技术要点。",
          "",
          "## 原文",
          "",
          "{{article_content}}",
          "",
          "## 补充素材（如有）",
          "",
          "{{source_context}}",
          "",
        );

        if (includeReview) {
          sections.push(
            "# Review Prompt",
            "",
            "请审校以下改写结果的信息保留度。",
            "",
            "审校维度：",
            "1. 核心信息完整性：原文的所有核心技术要点是否保留",
            "2. 数据准确性：关键数据、命令、配置是否准确无误",
            "3. 无凭空杜撰：改写是否引入了原文没有的事实性信息",
            "4. 风格一致性：是否符合目标风格要求",
            "",
            "## 改写结果",
            "",
            "{{rewritten_content}}",
            "",
            "## 原文",
            "",
            "{{article_content}}",
            "",
          );
        }

        const content = fmLines.join("\n") + "\n\n" + sections.join("\n");

        const target = params.target || "local";
        const rewritesDir = resolveRewritesDir(baseDir, target);
        const outPath = join(rewritesDir, `${rewriteName}.md`);

        if (!existsSync(rewritesDir)) {
          mkdirSync(rewritesDir, { recursive: true });
        }

        writeFileSync(outPath, content, "utf-8");

        const nextSteps = [
          `改写定义骨架已生成: ${outPath}`,
          "",
          "下一步:",
          "1. 编辑 # Rewrite Prompt：填写角色定义、风格规则和禁止项",
          "2. 运行 dry-run 验证: npx js-knowledge-prism rewrite --style " + rewriteName + " --file <any.md> --dry-run",
        ];

        return textResult(nextSteps.join("\n"));
      },
    },
    { optional: true },
  );

  // ---- Tool: prism_import_rewrite ------------------------------------------

  api.registerTool(
    {
      name: "prism_import_rewrite",
      label: "Prism: Import Rewrite from Existing Prompt",
      description:
        "从已有的提示词文件自动提取内容，转换为标准的改写定义格式。" +
        "读取源文件的 Markdown 内容，包装成 frontmatter + # Rewrite Prompt 区段。",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "已有提示词文件的路径（.md 文件）",
          },
          name: {
            type: "string",
            description: "改写定义名（如 kzk-wechat）",
          },
          description: {
            type: "string",
            description: "改写定义用途描述（可选）",
          },
          platform: {
            type: "string",
            enum: ["wechat", "zhihu", "twitter", "generic"],
            description: "目标平台。默认 generic。",
          },
          preserveStructure: {
            type: "boolean",
            description: "是否保留原文章节结构。默认 false。",
          },
          preserveLinks: {
            type: "boolean",
            description: "是否保留 Markdown 链接。默认 true。",
          },
          target: {
            type: "string",
            enum: ["local", "builtin"],
            description: "写入目标。local（默认）或 builtin。",
          },
          baseDir: {
            type: "string",
            description: "知识库根目录。省略则使用插件配置。",
          },
        },
        required: ["sourcePath", "name"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const rewriteName = params.name.replace(/\.md$/, "");

        if (!existsSync(params.sourcePath)) {
          return textResult(`错误: 源文件不存在: ${params.sourcePath}`);
        }

        const existing = listRewrites(baseDir);
        if (existing.some((r) => r.name === rewriteName)) {
          return textResult(`错误: 改写定义 "${rewriteName}" 已存在。请使用其他名称。`);
        }

        const sourceContent = readFileSync(params.sourcePath, "utf-8");

        const platform = params.platform || "generic";
        const preserveStructure = params.preserveStructure ?? false;
        const preserveLinks = params.preserveLinks ?? true;

        const fmLines = [
          "---",
          `name: ${rewriteName}`,
        ];
        if (params.description) fmLines.push(`description: ${params.description}`);
        fmLines.push(`platform: ${platform}`);
        fmLines.push(`preserveStructure: ${preserveStructure}`);
        fmLines.push(`preserveLinks: ${preserveLinks}`);
        fmLines.push("preserveFrontmatter: false");
        fmLines.push("---");

        let promptBody = sourceContent;
        const fmMatch = sourceContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
        if (fmMatch) promptBody = fmMatch[1];

        const sections = [
          "# Rewrite Prompt",
          "",
          promptBody.trim(),
          "",
          "请按照上述风格，改写以下文章。保留所有核心信息和技术要点。输出完整的改写后文章。",
          "",
          "## 原文",
          "",
          "{{article_content}}",
          "",
          "## 补充素材（如有）",
          "",
          "{{source_context}}",
        ];

        const content = fmLines.join("\n") + "\n\n" + sections.join("\n") + "\n";

        const target = params.target || "local";
        const rewritesDir = resolveRewritesDir(baseDir, target);
        const outPath = join(rewritesDir, `${rewriteName}.md`);

        if (!existsSync(rewritesDir)) {
          mkdirSync(rewritesDir, { recursive: true });
        }

        writeFileSync(outPath, content, "utf-8");

        return textResult(
          `已从 ${params.sourcePath} 导入改写定义: ${outPath}\n\n` +
          "建议:\n" +
          "1. 审阅生成的定义，确认 Rewrite Prompt 内容完整\n" +
          "2. 如需审校功能，手动添加 # Review Prompt 区段\n" +
          "3. 运行 dry-run 验证: npx js-knowledge-prism rewrite --style " + rewriteName + " --file <any.md> --dry-run",
        );
      },
    },
    { optional: true },
  );
}

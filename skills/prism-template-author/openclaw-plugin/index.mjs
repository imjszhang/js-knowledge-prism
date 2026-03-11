import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listTemplates, listTypes, loadType } from "../../../lib/output.mjs";

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

  function resolvePromptsDir(baseDir, target) {
    if (target === "builtin") {
      return join(PROJECT_ROOT, "templates", "outputs", "prompts");
    }
    const local = join(baseDir, "outputs", "_templates");
    if (!existsSync(local)) mkdirSync(local, { recursive: true });
    return local;
  }

  function resolveComponentsDir(baseDir, target) {
    if (target === "builtin") {
      return join(PROJECT_ROOT, "templates", "outputs", "components");
    }
    const local = join(baseDir, "outputs", "_templates", "components");
    if (!existsSync(local)) mkdirSync(local, { recursive: true });
    return local;
  }

  // ---- Tool: prism_scaffold_template ----------------------------------------

  api.registerTool(
    {
      name: "prism_scaffold_template",
      label: "Prism: Scaffold Output Template",
      description:
        "在知识库 outputs/_templates/ 下生成一个新模板的骨架文件（frontmatter + 区段占位）。" +
        "纯文件操作，不调用 LLM。生成后需手动填写 prompt 内容。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "模板名（如 tutorial），将作为文件名和 frontmatter name",
          },
          description: {
            type: "string",
            description: "模板用途描述（可选）",
          },
          split: {
            type: "string",
            enum: ["per-kl", "per-perspective", "per-group"],
            description: "素材拆分策略。默认 per-kl。",
          },
          type: {
            type: "string",
            description: "关联的类型名（如 diary、blog）。省略则不关联类型。",
          },
          fileNaming: {
            type: "string",
            enum: ["date", "slug", "sequence"],
            description: "输出文件命名方式。默认跟随 type 或 sequence。",
          },
          stages: {
            type: "array",
            items: { type: "string" },
            description: "多阶段流水线名（如 [\"outline\", \"draft\", \"polish\"]）。省略则单阶段。",
          },
          pauseAfter: {
            type: "array",
            items: { type: "string" },
            description: "需暂停的阶段名（如 [\"outline\"]）。配合 stages 使用。",
          },
          review: {
            type: "boolean",
            description: "是否包含 Review Prompt 区段。默认 false。",
          },
          skeleton: {
            type: "boolean",
            description: "是否包含 Skeleton Template 区段。默认 false。",
          },
          source: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["cross-perspective", "analysis"] },
            },
            description: "素材来源配置（可选）。",
          },
          target: {
            type: "string",
            enum: ["local", "builtin"],
            description: "写入目标。local（默认）写入知识库 _templates/；builtin 写入项目内置目录（仅维护者使用）。",
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
        const templateName = params.name.replace(/\.md$/, "");

        const existing = listTemplates(baseDir);
        if (existing.some((t) => t.name === templateName)) {
          return textResult(`错误: 模板 "${templateName}" 已存在。请使用其他名称或直接编辑现有模板。`);
        }

        let typeDef = null;
        if (params.type) {
          typeDef = loadType(params.type, baseDir);
          if (!typeDef) {
            const available = listTypes(baseDir).map((t) => t.name).join(", ");
            return textResult(`错误: 类型 "${params.type}" 不存在。可用类型: ${available || "无"}`);
          }
        }

        const split = params.split || typeDef?.split || "per-kl";
        const fileNaming = params.fileNaming || typeDef?.fileNaming || "sequence";
        const stages = params.stages;
        const pauseAfter = params.pauseAfter;
        const includeReview = params.review ?? false;
        const includeSkeleton = params.skeleton ?? false;
        const source = params.source;

        const fmLines = [
          "---",
          `name: ${templateName}`,
        ];
        if (params.description) fmLines.push(`description: ${params.description}`);
        if (params.type) fmLines.push(`type: ${params.type}`);
        fmLines.push(`split: ${split}`);
        fmLines.push(`fileNaming: ${fileNaming}`);
        if (stages && stages.length > 0) {
          fmLines.push(`stages: [${stages.join(", ")}]`);
        }
        if (pauseAfter && pauseAfter.length > 0) {
          fmLines.push(`pauseAfter: [${pauseAfter.join(", ")}]`);
        }
        if (source) {
          fmLines.push(`source:`);
          fmLines.push(`  type: ${source.type}`);
        }
        fmLines.push("---");

        const sections = [];

        sections.push(
          "# System Prompt",
          "",
          "{{@include constraints.md}}",
          "",
          "<!-- TODO: 添加 persona 和 style 组件，如 -->",
          "<!-- {{@include persona/blogger.md}} -->",
          "<!-- {{@include style/narrative.md}} -->",
          "",
          "<!-- TODO: 定义输出格式 -->",
          "",
        );

        if (stages && stages.length > 0) {
          for (const stage of stages) {
            sections.push(
              `# Stage: ${stage}`,
              "",
              `<!-- TODO: 编写 ${stage} 阶段的用户提示 -->`,
              `<!-- 可使用 {{prev_stage_output}} 引用上阶段结果 -->`,
              "",
            );
          }
        } else {
          sections.push(
            "# Unit Prompt",
            "",
            `<!-- TODO: 编写用户提示，使用 ${split} 策略的变量 -->`,
            `<!-- 查阅 schema-reference.md 获取可用变量列表 -->`,
            "",
          );
        }

        if (includeSkeleton) {
          sections.push(
            "# Skeleton Template",
            "",
            "<!-- TODO: 定义骨架文件模板 -->",
            "<!-- 使用 Skeleton 专用变量：kl_id, kl_date, kl_thesis, kl_link 等 -->",
            "",
          );
        }

        if (includeReview) {
          sections.push(
            "# Review Prompt",
            "",
            "{{@include review/base.md}}",
            "",
            "## 待审校内容",
            "",
            "{{generated_content}}",
            "",
            "## 源素材摘要",
            "",
            "{{source_summary}}",
            "",
          );
        }

        const content = fmLines.join("\n") + "\n\n" + sections.join("\n");

        const target = params.target || "local";
        const promptsDir = resolvePromptsDir(baseDir, target);
        const outPath = join(promptsDir, `${templateName}.md`);

        if (!existsSync(promptsDir)) {
          mkdirSync(promptsDir, { recursive: true });
        }

        writeFileSync(outPath, content, "utf-8");

        const nextSteps = [
          `模板骨架已生成: ${outPath}`,
          "",
          "下一步:",
          "1. 编辑 System Prompt：添加 persona/style 组件和输出格式定义",
          stages?.length ? "2. 编辑各 Stage 区段：编写每阶段的用户提示" : "2. 编辑 Unit Prompt：使用变量注入素材并编写写作指令",
          "3. 运行 dry-run 验证: npx js-knowledge-prism output --perspective <dir> --template " + templateName + " --dry-run",
        ];

        return textResult(nextSteps.join("\n"));
      },
    },
    { optional: true },
  );

  // ---- Tool: prism_scaffold_component ---------------------------------------

  api.registerTool(
    {
      name: "prism_scaffold_component",
      label: "Prism: Scaffold Prompt Component",
      description:
        "在知识库 outputs/_templates/components/ 下生成一个新组件的占位文件。" +
        "用于创建 persona、style 等可复用 prompt 片段。纯文件操作。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "组件路径（如 persona/teacher.md 或 style/tutorial.md）",
          },
          content: {
            type: "string",
            description: "组件内容。省略则生成占位注释。",
          },
          target: {
            type: "string",
            enum: ["local", "builtin"],
            description: "写入目标。local（默认）写入知识库 _templates/components/；builtin 写入项目内置目录（仅维护者使用）。",
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
        const componentName = params.name.replace(/\.md$/, "") + ".md";
        const target = params.target || "local";

        const componentsDir = resolveComponentsDir(baseDir, target);
        const outPath = join(componentsDir, componentName);

        if (existsSync(outPath)) {
          return textResult(`错误: 组件 "${componentName}" 已存在。请直接编辑现有文件: ${outPath}`);
        }

        const parentDir = dirname(outPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        const body = params.content || `<!-- TODO: 编写 ${componentName} 组件内容 -->\n`;
        writeFileSync(outPath, body.endsWith("\n") ? body : body + "\n", "utf-8");

        return textResult(`组件已生成: ${outPath}\n\n在模板中通过 {{@include ${componentName}}} 引用。`);
      },
    },
    { optional: true },
  );
}

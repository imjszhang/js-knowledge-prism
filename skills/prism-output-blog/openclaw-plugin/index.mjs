import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { runOutput, listTemplates, loadTemplate } from "../../../lib/output.mjs";
import { createHttpCaller } from "../../../lib/process.mjs";

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

  function buildCallAgent() {
    const apiCfg = pluginCfg.api ?? {};
    const procCfg = pluginCfg.process ?? {};
    return createHttpCaller({
      baseUrl: apiCfg.baseUrl || "http://localhost:8888/v1",
      model: apiCfg.model || api.config?.agents?.defaults?.model?.primary || "default",
      apiKey: apiCfg.apiKey || "not-needed",
      temperature: procCfg.temperature ?? 0.3,
      maxTokens: procCfg.maxTokens ?? 8192,
      timeoutMs: procCfg.timeoutMs ?? 1_800_000,
      log: (msg) => api.logger.info(msg),
    });
  }

  function listReadyPerspectives(baseDir) {
    const structureDir = join(baseDir, "pyramid", "structure");
    if (!existsSync(structureDir)) return [];

    const perspectives = [];
    for (const d of readdirSync(structureDir)) {
      if (!/^P\d+/.test(d)) continue;
      const pDir = join(structureDir, d);
      if (!statSync(pDir).isDirectory()) continue;

      const scqaPath = join(pDir, "scqa.md");
      const treePath = join(pDir, "tree", "README.md");
      const hasScqa = existsSync(scqaPath) &&
        readFileSync(scqaPath, "utf-8").length > 100;
      const hasTree = existsSync(treePath) &&
        readFileSync(treePath, "utf-8").includes("| KL");

      if (hasScqa && hasTree) {
        perspectives.push({ dirName: d });
      }
    }
    return perspectives;
  }

  // ---- Tool: prism_blog_list_ready ------------------------------------------

  api.registerTool(
    {
      name: "prism_blog_list_ready",
      label: "Prism Blog: List Ready Perspectives",
      description:
        "列出已完成 SCQA 和 Key Line、可以生成博客文章的视角。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录。省略则使用插件配置。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const ready = listReadyPerspectives(baseDir);

        if (ready.length === 0) {
          return textResult("当前没有可生成博客的视角。请先填充 SCQA 和 Key Line。");
        }

        const lines = [
          `## 可生成博客的视角 (${ready.length} 个)`,
          "",
        ];
        for (const p of ready) {
          lines.push(`- **${p.dirName}**`);
        }
        lines.push("");
        lines.push('调用 prism_blog_generate 并传入 perspectiveDir 参数来生成文章。');

        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---- Tool: prism_blog_generate (delegates to runOutput) -------------------

  api.registerTool(
    {
      name: "prism_blog_generate",
      label: "Prism Blog: Generate Article",
      description:
        "从一个已完成的视角生成博客文章。使用通用 output 引擎 + blog 模板，将 SCQA + Key Line + journal 素材交给 LLM 生成完整文章。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录。省略则使用插件配置。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名，如 P01-knowledge-org",
          },
          force: {
            type: "boolean",
            description: "覆盖已存在的文件。默认 false。",
          },
        },
        required: ["perspectiveDir"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const logs = [];
        const warnings = [];

        const result = await runOutput({
          baseDir,
          perspectiveDir: params.perspectiveDir,
          template: "blog",
          autoWrite: true,
          dryRun: false,
          force: params.force ?? false,
          callAgent: buildCallAgent(),
          log: (msg) => logs.push(msg),
          warn: (msg) => warnings.push(msg),
        });

        if (!result.success) {
          return textResult(`错误: ${result.message}`);
        }

        const parts = [result.message];
        if (result.results?.length > 0) {
          const generated = result.results.find((r) => r.status === "generated");
          if (generated?.content) {
            const preview = generated.content.slice(0, 2000);
            parts.push("", preview);
            if (generated.content.length > 2000) parts.push("...");
          }
        }
        if (warnings.length > 0) {
          parts.push("", "警告:", ...warnings.map((w) => `  - ${w}`));
        }

        return textResult(parts.join("\n"));
      },
    },
    { optional: true },
  );
}

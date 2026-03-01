import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export default function register(api) {
  const pluginCfg = api.pluginConfig ?? {};

  function resolveBaseDir() {
    if (pluginCfg.baseDir) return pluginCfg.baseDir;
    if (api.config?.agents?.defaults?.workspace) return api.config.agents.defaults.workspace;
    return process.cwd();
  }

  function resolveOutputDir(baseDir) {
    return pluginCfg.outputDir
      ? pluginCfg.outputDir
      : join(baseDir, "outputs", "blog");
  }

  function textResult(text) {
    return { content: [{ type: "text", text }] };
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
        perspectives.push({
          dirName: d,
          scqaPath,
          treePath,
        });
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
        lines.push("调用 prism_blog_generate 并传入 perspectiveDir 参数来生成文章。");

        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---- Tool: prism_blog_generate --------------------------------------------

  api.registerTool(
    {
      name: "prism_blog_generate",
      label: "Prism Blog: Generate Article",
      description:
        "从一个已完成的视角生成博客文章草稿。读取 SCQA 和 Key Line，组装为带 frontmatter 的 Markdown 文章。",
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
          title: {
            type: "string",
            description: "文章标题（可选，默认从 SCQA 提取）",
          },
          autoWrite: {
            type: "boolean",
            description: "是否写入文件。默认 true。",
          },
        },
        required: ["perspectiveDir"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const structureDir = join(baseDir, "pyramid", "structure");
        const pDir = join(structureDir, params.perspectiveDir);

        if (!existsSync(pDir)) {
          return textResult(`错误: 视角目录不存在: ${params.perspectiveDir}`);
        }

        const scqaPath = join(pDir, "scqa.md");
        const treePath = join(pDir, "tree", "README.md");

        if (!existsSync(scqaPath)) {
          return textResult("错误: scqa.md 不存在，请先填充 SCQA。");
        }
        if (!existsSync(treePath)) {
          return textResult("错误: tree/README.md 不存在，请先填充 Key Line。");
        }

        const scqa = readFileSync(scqaPath, "utf-8");
        const tree = readFileSync(treePath, "utf-8");

        const titleMatch = scqa.match(/^#\s+(.+)$/m);
        const articleTitle = params.title || (titleMatch ? titleMatch[1] : params.perspectiveDir);

        const klSections = [];
        const treeDir = join(pDir, "tree");
        if (existsSync(treeDir)) {
          for (const f of readdirSync(treeDir).filter(f => f.startsWith("KL") && f.endsWith(".md"))) {
            const content = readFileSync(join(treeDir, f), "utf-8");
            klSections.push(content);
          }
        }

        const now = new Date().toISOString().slice(0, 10);
        const fmAuthor = pluginCfg.frontmatter?.author || "Author";
        const fmTags = pluginCfg.frontmatter?.tags || [];

        const parts = [
          "---",
          `title: "${articleTitle}"`,
          `date: ${now}`,
          `author: ${fmAuthor}`,
          `tags: [${fmTags.map(t => `"${t}"`).join(", ")}]`,
          "---",
          "",
          `# ${articleTitle}`,
          "",
          scqa.replace(/^#\s+.+\n/, "").trim(),
          "",
        ];

        if (klSections.length > 0) {
          for (const section of klSections) {
            parts.push(section.trim());
            parts.push("");
          }
        } else {
          parts.push("<!-- Key Line 展开文档将作为文章主体各节 -->");
          parts.push("");
          parts.push(tree.trim());
          parts.push("");
        }

        parts.push("---");
        parts.push("");
        parts.push(`*Generated from perspective ${params.perspectiveDir} on ${now}.*`);

        const article = parts.join("\n");

        if (params.autoWrite !== false) {
          const outDir = resolveOutputDir(baseDir);
          mkdirSync(outDir, { recursive: true });
          const slug = params.perspectiveDir.replace(/^P\d+-/, "");
          const outPath = join(outDir, `${slug}.md`);
          writeFileSync(outPath, article, "utf-8");

          return textResult(
            `已生成博客文章: ${outPath}\n\n${article.slice(0, 2000)}${article.length > 2000 ? "\n..." : ""}`,
          );
        }

        return textResult(article);
      },
    },
    { optional: true },
  );
}

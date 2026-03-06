import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHttpCaller, runPipeline } from "../lib/process.mjs";
import { getStatus } from "../lib/status.mjs";
import { listTemplates, loadTemplate, runOutput } from "../lib/output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function loadProjectDotEnv(envPath) {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
    }
  }
}

/**
 * Patch child_process.spawn / execFile to default windowsHide: true on Windows.
 *
 * OpenClaw's runCommandWithTimeout (src/process/exec.ts) spawns git, npm, etc.
 * without windowsHide, causing visible CMD windows on every call.
 * We patch the shared CJS module object so that all callers—including those
 * that imported spawn via ESM live bindings—pick up the default.
 */
function patchWindowsHide() {
  if (process.platform !== "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const cp = require("node:child_process");

    const _spawn = cp.spawn;
    cp.spawn = function patchedSpawn(cmd, args, opts) {
      if (args && typeof args === "object" && !Array.isArray(args)) {
        if (args.windowsHide === undefined) args.windowsHide = true;
        return _spawn.call(this, cmd, args);
      }
      if (!opts || typeof opts !== "object") opts = {};
      if (opts.windowsHide === undefined) opts.windowsHide = true;
      return _spawn.call(this, cmd, args, opts);
    };

    const _execFile = cp.execFile;
    cp.execFile = function patchedExecFile(file, args, opts, cb) {
      if (typeof args === "function") return _execFile.call(this, file, args);
      if (typeof opts === "function") {
        if (Array.isArray(args)) return _execFile.call(this, file, args, opts);
        if (args && typeof args === "object") {
          if (args.windowsHide === undefined) args.windowsHide = true;
        }
        return _execFile.call(this, file, args, opts);
      }
      if (opts && typeof opts === "object") {
        if (opts.windowsHide === undefined) opts.windowsHide = true;
      }
      return _execFile.call(this, file, args, opts, cb);
    };
  } catch {
    // Best-effort; swallow silently.
  }
}

patchWindowsHide();

export default function register(api) {
  // Load project-local .env (won't clobber existing env vars)
  loadProjectDotEnv(join(PROJECT_ROOT, ".env"));

  const pluginCfg = api.pluginConfig ?? {};

  function resolveBaseDir() {
    if (pluginCfg.baseDir) return pluginCfg.baseDir;
    if (api.config?.agents?.defaults?.workspace) return api.config.agents.defaults.workspace;
    return process.cwd();
  }

  function buildConfig() {
    return {
      process: {
        batchSize: pluginCfg.process?.batchSize ?? 5,
        temperature: pluginCfg.process?.temperature ?? 0.3,
        maxTokens: pluginCfg.process?.maxTokens ?? 8192,
        timeoutMs: pluginCfg.process?.timeoutMs ?? 1_800_000,
      },
    };
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

  // ---------------------------------------------------------------------------
  // CLI commands: openclaw prism {init|process|status|new-perspective}
  // ---------------------------------------------------------------------------

  api.registerCli(
    ({ program }) => {
      const prism = program
        .command("prism")
        .description("Knowledge Prism — 金字塔原理知识蒸馏工具");

      // --- prism init ---
      prism
        .command("init <dir>")
        .description("在目标目录初始化知识棱镜骨架")
        .option("--name <name>", "知识库名称")
        .action(async (dir, opts) => {
          const args = [dir];
          if (opts.name) args.push("--name", opts.name);
          const { run } = await import("../lib/init.mjs");
          await run(args);
        });

      // --- prism process ---
      prism
        .command("process")
        .description("金字塔增量处理（atoms → groups → synthesis）")
        .option("--dry-run", "只预览，不调用模型")
        .option("--auto-write", "阶段 2/3 自动写入文件")
        .option("--stage <n>", "只执行到指定阶段 (1/2/3)", "3")
        .option("--file <filename>", "只处理指定 journal")
        .option("--verbose", "显示完整 prompt")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .action(async (opts) => {
          const baseDir = opts.baseDir || resolveBaseDir();
          await runPipeline({
            baseDir,
            config: buildConfig(),
            callAgent: buildCallAgent(),
            dryRun: opts.dryRun || false,
            autoWrite: opts.autoWrite || false,
            maxStage: Number(opts.stage),
            onlyFile: opts.file,
            verbose: opts.verbose || false,
            log: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
          });
        });

      // --- prism status ---
      prism
        .command("status")
        .description("查看知识棱镜处理状态")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .option("--json", "以 JSON 格式输出")
        .action(async (opts) => {
          const baseDir = opts.baseDir || resolveBaseDir();
          const status = getStatus(baseDir);
          if (opts.json) {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(`\n知识棱镜根目录: ${baseDir}\n`);
            console.log(`  Journal: ${status.totalJournals} 篇 (${status.totalDates} 个日期目录)`);
            console.log(`  Atoms:   ${status.totalAtoms} 个文件`);
            console.log(`  Groups:  ${status.totalGroups} 个分组`);
            console.log(`  视角:    ${status.totalPerspectives} 个`);
            console.log(`  待处理:  ${status.unprocessed.length} 篇 journal`);
            console.log(`  未归组:  ${status.ungroupedCount} 个 atom`);
            console.log(`  Synthesis 最后修改: ${status.synthesisModified}\n`);
          }
        });

      // --- prism new-perspective ---
      prism
        .command("new-perspective <slug>")
        .description("从模板创建新视角")
        .option("--name <name>", "视角中文名称")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .action(async (slug, opts) => {
          const args = [slug];
          if (opts.name) args.push("--name", opts.name);
          const baseDirOpt = opts.baseDir ?? opts["base-dir"];
          if (baseDirOpt) args.push("--base-dir", baseDirOpt);
          const { run } = await import("../lib/new-perspective.mjs");
          await run(args);
        });

      // --- prism output ---
      prism
        .command("output")
        .description("从视角生成面向读者的产出（日记、博客等）")
        .option("--perspective <dir>", "视角目录名（如 P23-practice-diary）")
        .option("--template <name>", "输出模板名（如 practice-diary, blog）")
        .option("--output-dir <dir>", "输出目录（默认 outputs/<template>）")
        .option("--kl <ids>", "只处理指定 KL（逗号分隔）")
        .option("--skeleton", "只生成骨架文件（不调用 LLM）")
        .option("--validate", "只验证已有骨架的引用有效性")
        .option("--dry-run", "只预览，不调用模型")
        .option("--force", "覆盖已存在的非骨架文件")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .option("--list-templates", "列出可用模板")
        .action(async (opts) => {
          const baseDir = opts.baseDir || resolveBaseDir();

          if (opts.listTemplates) {
            const templates = listTemplates(baseDir);
            if (templates.length === 0) {
              console.log("没有可用的模板。");
              return;
            }
            console.log("\n可用模板:\n");
            for (const t of templates) {
              const tpl = loadTemplate(t.name, baseDir);
              console.log(`  ${t.name} (${t.source})`);
              if (tpl?.description) console.log(`    ${tpl.description}`);
              console.log(`    拆分: ${tpl?.split || "per-kl"}, 命名: ${tpl?.fileNaming || "sequence"}`);
              console.log();
            }
            return;
          }

          if (!opts.perspective || !opts.template) {
            console.error("错误: 必须指定 --perspective 和 --template");
            return;
          }

          let mode;
          if (opts.skeleton) mode = "skeleton";
          else if (opts.validate) mode = "validate";

          await runOutput({
            baseDir,
            perspectiveDir: opts.perspective,
            template: opts.template,
            outputDir: opts.outputDir,
            mode,
            autoWrite: true,
            dryRun: opts.dryRun || false,
            force: opts.force || false,
            klFilter: opts.kl ? opts.kl.split(",").map((s) => s.trim()) : undefined,
            callAgent: mode ? undefined : buildCallAgent(),
            log: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
          });
        });

      // --- prism agent-index ---
      prism
        .command("agent-index")
        .description("生成 Agent 检索索引（SKILL.md + CONTEXT.md）")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .action(async (opts) => {
          const baseDir = opts.baseDir || resolveBaseDir();
          const { runAgentIndex } = await import("../lib/agent-index.mjs");
          const result = runAgentIndex({
            baseDir,
            config: { name: pluginCfg.name },
            log: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
          });
          api.logger.info(`Agent 索引生成完毕: SKILL.md=${result.skillMdWritten}, CONTEXT.md=${result.contextCount}个`);
        });
    },
    { commands: ["prism"] },
  );

  // ---------------------------------------------------------------------------
  // AI Tools: knowledge_prism_process, knowledge_prism_status
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_process",
      label: "Knowledge Prism Process",
      description:
        "对知识库执行增量处理：从 journal 笔记中提取 atoms，归组为 groups，收敛为 synthesis。返回处理摘要。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          stage: {
            type: "number",
            description: "执行到哪个阶段：1=atoms, 2=+groups, 3=+synthesis。默认 3。",
            enum: [1, 2, 3],
          },
          autoWrite: {
            type: "boolean",
            description: "是否自动写入文件（阶段 2/3）。默认 true。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const maxStage = params.stage ?? 3;
        const autoWrite = params.autoWrite ?? true;

        const logs = [];
        const warnings = [];

        const summary = await runPipeline({
          baseDir,
          config: buildConfig(),
          callAgent: buildCallAgent(),
          dryRun: false,
          autoWrite,
          maxStage,
          verbose: false,
          log: (msg) => logs.push(msg),
          warn: (msg) => warnings.push(msg),
        });

        const parts = [
          `处理完成 (baseDir: ${baseDir})`,
          `- Atoms 处理: ${summary.atomsProcessed} 个`,
          `- Groups 新建: ${summary.groupsWritten}, 更新: ${summary.groupsUpdated}`,
          `- Synthesis 更新: ${summary.synthesisUpdated ? "是" : "否"}`,
        ];
        if (warnings.length > 0) {
          parts.push("", "警告:", ...warnings.map((w) => `  - ${w}`));
        }

        return { content: [{ type: "text", text: parts.join("\n") }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_status",
      label: "Knowledge Prism Status",
      description: "查询知识库当前状态：journal 总数、待处理数、atoms/groups/synthesis 统计。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const status = getStatus(baseDir);

        const lines = [
          `知识棱镜状态 (${baseDir})`,
          "",
          `Journal: ${status.totalJournals} 篇 (${status.totalDates} 个日期目录)`,
          `Atoms: ${status.totalAtoms} 个文件`,
          `Groups: ${status.totalGroups} 个分组`,
          `视角: ${status.totalPerspectives} 个`,
          `待处理 Journal: ${status.unprocessed.length} 篇`,
          `未归组 Atom: ${status.ungroupedCount} 个`,
          `Synthesis 最后修改: ${status.synthesisModified}`,
        ];

        if (status.unprocessed.length > 0) {
          lines.push("", "待处理列表:");
          for (const u of status.unprocessed) {
            lines.push(`  ${u.dateDir} / ${u.file}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_fill_perspective",
      label: "Knowledge Prism Fill Perspective",
      description:
        "填充视角内容：stage=scqa 生成 SCQA，stage=keyline 生成 Key Line 表格。基于 synthesis 和 groups，会覆盖现有内容。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名，如 P01-knowledge-org-methodology",
          },
          stage: {
            type: "string",
            enum: ["scqa", "keyline"],
            description: "scqa=填充 scqa.md，keyline=填充 tree/README 的 Key Line 表格",
          },
          autoWrite: {
            type: "boolean",
            description: "是否写入文件。默认 true。",
          },
        },
        required: ["perspectiveDir", "stage"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const { runFillPerspective } = await import("../lib/fill-perspective.mjs");
        const result = await runFillPerspective({
          baseDir,
          perspectiveDir: params.perspectiveDir,
          stage: params.stage,
          autoWrite: params.autoWrite ?? true,
          callAgent: buildCallAgent(),
        });

        if (!result.success) {
          return { content: [{ type: "text", text: `错误: ${result.message}` }] };
        }

        const preview = result.content
          ? result.content.slice(0, 1500) + (result.content.length > 1500 ? "\n..." : "")
          : "";
        const text = `${result.message}\n\n${preview}`.trim();

        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_new_perspective",
      label: "Knowledge Prism New Perspective",
      description: "创建新视角骨架（scqa.md、validation.md、tree/README.md）。Agent 在对话中直接创建，无需切换终端。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          slug: {
            type: "string",
            description: "视角的简短英文描述（用于目录名，如 deployment-guide）",
          },
          name: {
            type: "string",
            description: "视角中文名称（可选）",
          },
        },
        required: ["slug"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const { runWithBaseDir } = await import("../lib/new-perspective.mjs");
        const result = runWithBaseDir({
          baseDir,
          slug: params.slug,
          name: params.name,
        });

        if (result.error) {
          return { content: [{ type: "text", text: `错误: ${result.error}` }] };
        }

        const text = [
          `已创建视角: ${result.dirName}`,
          `路径: ${result.perspectiveDir}`,
          `文件: ${result.files.join(", ")}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_expand_kl",
      label: "Knowledge Prism Expand KL",
      description:
        "展开 Key Line 为完整 KLxx-xxx.md，含支撑论点、逻辑顺序、atoms/groups 引用。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名，如 P01-knowledge-org-methodology",
          },
          klId: {
            type: "string",
            description: "Key Line 编号，如 KL01 或 KL01-why-restructure",
          },
          autoWrite: {
            type: "boolean",
            description: "是否写入文件。默认 true。",
          },
        },
        required: ["perspectiveDir", "klId"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const { runExpandKl } = await import("../lib/expand-kl.mjs");
        const result = await runExpandKl({
          baseDir,
          perspectiveDir: params.perspectiveDir,
          klId: params.klId,
          autoWrite: params.autoWrite ?? true,
          callAgent: buildCallAgent(),
        });

        if (!result.success) {
          return { content: [{ type: "text", text: `错误: ${result.message}` }] };
        }

        const preview = result.content
          ? result.content.slice(0, 2000) + (result.content.length > 2000 ? "\n..." : "")
          : "";
        const text = `${result.message}\n\n${preview}`.trim();

        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tools: knowledge_prism_output, knowledge_prism_list_templates
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_output",
      label: "Knowledge Prism Output",
      description:
        "从视角生成面向读者的产出文件。支持三种模式：skeleton（生成骨架）、validate（验证骨架引用）、generate（默认，调 LLM 生成内容）。" +
        "推荐两阶段流程：先 skeleton 生成骨架审查引用，再 generate 填充内容。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名，如 P23-practice-diary",
          },
          template: {
            type: "string",
            description: "输出模板名，如 practice-diary, blog",
          },
          mode: {
            type: "string",
            enum: ["skeleton", "validate", "generate"],
            description: "执行模式：skeleton=生成骨架文件, validate=验证骨架引用, generate=调 LLM 生成内容（默认）。",
          },
          outputDir: {
            type: "string",
            description: "输出目录（可选，默认 outputs/<template>）",
          },
          klFilter: {
            type: "string",
            description: "只处理指定 KL，逗号分隔（如 KL01,KL02）。省略则处理全部。",
          },
          force: {
            type: "boolean",
            description: "覆盖已存在的非骨架文件。默认 false。",
          },
        },
        required: ["perspectiveDir", "template"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const logs = [];
        const warnings = [];
        const mode = params.mode || "generate";

        const result = await runOutput({
          baseDir,
          perspectiveDir: params.perspectiveDir,
          template: params.template,
          outputDir: params.outputDir,
          mode,
          autoWrite: true,
          dryRun: false,
          force: params.force ?? false,
          klFilter: params.klFilter
            ? params.klFilter.split(",").map((s) => s.trim())
            : undefined,
          callAgent: mode === "generate" ? buildCallAgent() : undefined,
          log: (msg) => logs.push(msg),
          warn: (msg) => warnings.push(msg),
        });

        if (!result.success) {
          return textResult(`错误: ${result.message}`);
        }

        const parts = [result.message];
        if (result.results) {
          for (const r of result.results) {
            const label = r.klId ? `${r.klId} → ${r.file}` : r.file;
            parts.push(`  ${r.status}: ${label}`);
          }
        }
        if (result.warnings?.length > 0) {
          parts.push("", "引用警告:", ...result.warnings.map((w) => `  - ${w}`));
        }
        if (warnings.length > 0) {
          parts.push("", "警告:", ...warnings.map((w) => `  - ${w}`));
        }

        return textResult(parts.join("\n"));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_list_templates",
      label: "Knowledge Prism: List Output Templates",
      description: "列出可用的输出模板（内置 + 知识库本地自定义模板）。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const templates = listTemplates(baseDir);

        if (templates.length === 0) {
          return textResult("没有可用的输出模板。");
        }

        const lines = [`## 可用模板 (${templates.length} 个)`, ""];
        for (const t of templates) {
          const tpl = loadTemplate(t.name, baseDir);
          lines.push(`- **${t.name}** (${t.source})`);
          if (tpl?.description) lines.push(`  ${tpl.description}`);
          lines.push(`  拆分: ${tpl?.split || "per-kl"}, 命名: ${tpl?.fileNaming || "sequence"}`);
          lines.push("");
        }
        lines.push("调用 knowledge_prism_output 并传入 template 参数来生成产出。");

        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tool: knowledge_prism_agent_index
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_agent_index",
      label: "Knowledge Prism: Generate Agent Index",
      description:
        "生成知识库的 Agent 检索索引：根级 SKILL.md（知识地图）和各视角的 CONTEXT.md（决策摘要）。纯确定性提取，不调用 LLM。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const { runAgentIndex } = await import("../lib/agent-index.mjs");

        const logs = [];
        const result = runAgentIndex({
          baseDir,
          config: { name: pluginCfg.name },
          log: (msg) => logs.push(msg),
          warn: (msg) => logs.push(`⚠ ${msg}`),
        });

        const lines = [
          `Agent 索引生成完毕 (${baseDir})`,
          `- SKILL.md: ${result.skillMdWritten ? "已更新" : "跳过"}`,
          `- CONTEXT.md: ${result.contextCount} 个视角`,
          "",
          ...logs,
        ];

        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Skill extension: constants
  // ---------------------------------------------------------------------------

  const PLUGIN_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const SKILL_ROOT = resolve(
    process.platform === "win32" ? PLUGIN_DIR.replace(/^\//, "") : PLUGIN_DIR,
    "..",
  );
  const DEFAULT_REGISTRY =
    "https://raw.githubusercontent.com/user/js-knowledge-prism/main/dist/skills.json";
  const skillsRegistryUrl = pluginCfg.skillsRegistryUrl || DEFAULT_REGISTRY;
  const skillsDir = pluginCfg.skillsDir
    ? resolve(pluginCfg.skillsDir)
    : join(SKILL_ROOT, "skills");

  // ---------------------------------------------------------------------------
  // Tool: knowledge_prism_discover_skills
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_discover_skills",
      label: "Knowledge Prism: Discover Skills",
      description:
        "查询扩展技能注册表，列出可安装的扩展技能。返回每个技能的 ID、名称、描述、版本和提供的 AI 工具列表。",
      parameters: {
        type: "object",
        properties: {
          registryUrl: {
            type: "string",
            description: "自定义注册表 URL（默认使用内置地址）",
          },
        },
      },
      async execute(_toolCallId, params) {
        const url = params.registryUrl || skillsRegistryUrl;
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const registry = await resp.json();

          if (!registry.skills || registry.skills.length === 0) {
            return textResult("当前没有可用的扩展技能。");
          }

          const lines = [
            `## 扩展技能 (${registry.skills.length} 个)`,
            `Parent: js-knowledge-prism v${registry.parentSkill?.version || "?"}`,
            "",
          ];

          for (const s of registry.skills) {
            const installed = existsSync(
              join(skillsDir, s.id, "openclaw-plugin"),
            );
            const status = installed ? "已安装" : "未安装";
            lines.push(`### ${s.emoji || ""} ${s.name} (${s.id}) — ${status}`);
            lines.push(`  ${s.description}`);
            lines.push(`  版本: ${s.version}`);
            if (s.tools && s.tools.length > 0) {
              lines.push(`  AI 工具: ${s.tools.join(", ")}`);
            }
            if (s.requires?.skills?.length > 0) {
              lines.push(`  依赖: ${s.requires.skills.join(", ")}`);
            }
            if (!installed) {
              lines.push(
                `  安装: 调用 knowledge_prism_install_skill 工具，参数 skillId="${s.id}"`,
              );
            }
            lines.push("");
          }

          return textResult(lines.join("\n"));
        } catch (err) {
          return textResult(`获取技能注册表失败 (${url}): ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // Tool: knowledge_prism_install_skill
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_install_skill",
      label: "Knowledge Prism: Install Skill",
      description:
        "下载并安装一个扩展技能。自动下载技能包、解压、安装依赖，并将插件路径注册到 OpenClaw 配置中。安装完成后需要重启 OpenClaw 才能使用新工具。",
      parameters: {
        type: "object",
        properties: {
          skillId: {
            type: "string",
            description: "要安装的技能 ID（如 'prism-output-blog'）",
          },
          force: {
            type: "boolean",
            description: "强制覆盖已有安装（默认 false）",
          },
        },
        required: ["skillId"],
      },
      async execute(_toolCallId, params) {
        const { skillId, force } = params;
        try {
          const resp = await fetch(skillsRegistryUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const registry = await resp.json();

          const skill = registry.skills?.find((s) => s.id === skillId);
          if (!skill) {
            const ids = (registry.skills || []).map((s) => s.id).join(", ");
            return textResult(
              `技能 "${skillId}" 未在注册表中找到。\n可用技能: ${ids || "无"}`,
            );
          }

          const targetDir = join(skillsDir, skillId);
          if (existsSync(targetDir) && !force) {
            return textResult(
              `技能 "${skillId}" 已安装在 ${targetDir}。\n如需重新安装，请设置 force=true。`,
            );
          }

          api.logger.info(`[prism] Downloading skill: ${skillId}`);
          const urls = [skill.downloadUrl];
          let zipBuffer = null;
          for (const dlUrl of urls) {
            const zipResp = await fetch(dlUrl);
            if (zipResp.ok) {
              zipBuffer = Buffer.from(await zipResp.arrayBuffer());
              break;
            }
            api.logger.warn(
              `[prism] Download failed (${dlUrl}): HTTP ${zipResp.status}`,
            );
          }
          if (!zipBuffer) throw new Error("Download failed for all URLs");

          const tmpDir = join(tmpdir(), `prism-skill-${Date.now()}`);
          mkdirSync(tmpDir, { recursive: true });
          const zipPath = join(tmpDir, `${skillId}.zip`);
          writeFileSync(zipPath, zipBuffer);

          if (existsSync(targetDir)) {
            rmSync(targetDir, { recursive: true, force: true });
          }
          mkdirSync(targetDir, { recursive: true });

          api.logger.info(`[prism] Extracting to ${targetDir}`);
          if (process.platform === "win32") {
            execSync(
              `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`,
              { windowsHide: true },
            );
          } else {
            execSync(`unzip -qo "${zipPath}" -d "${targetDir}"`);
          }

          const pkgJson = join(targetDir, "package.json");
          if (existsSync(pkgJson)) {
            api.logger.info(`[prism] Installing dependencies for ${skillId}`);
            try {
              execSync("npm install --production", {
                cwd: targetDir,
                stdio: "pipe",
                windowsHide: true,
              });
            } catch {
              execSync("npm install", {
                cwd: targetDir,
                stdio: "pipe",
                windowsHide: true,
              });
            }
          }

          rmSync(tmpDir, { recursive: true, force: true });

          const pluginPath = join(targetDir, "openclaw-plugin").replace(
            /\\/g,
            "/",
          );
          let configUpdated = false;

          const ocConfigPath = join(homedir(), ".openclaw", "openclaw.json");
          if (existsSync(ocConfigPath)) {
            try {
              const cfg = JSON.parse(readFileSync(ocConfigPath, "utf8"));
              if (!cfg.plugins) cfg.plugins = {};
              if (!cfg.plugins.load) cfg.plugins.load = {};
              if (!Array.isArray(cfg.plugins.load.paths))
                cfg.plugins.load.paths = [];
              if (!cfg.plugins.entries) cfg.plugins.entries = {};

              if (!cfg.plugins.load.paths.includes(pluginPath)) {
                cfg.plugins.load.paths.push(pluginPath);
              }
              if (!cfg.plugins.entries[skillId]) {
                cfg.plugins.entries[skillId] = { enabled: true };
              }

              writeFileSync(
                ocConfigPath,
                JSON.stringify(cfg, null, 2) + "\n",
                "utf8",
              );
              configUpdated = true;
            } catch (e) {
              api.logger.warn(
                `[prism] Could not update openclaw.json: ${e.message}`,
              );
            }
          }

          const lines = [
            `技能 "${skill.name}" (${skillId}) 安装成功！`,
            `  安装路径: ${targetDir}`,
            `  插件路径: ${pluginPath}`,
            `  提供工具: ${(skill.tools || []).join(", ")}`,
            "",
          ];

          if (configUpdated) {
            lines.push("已自动更新 ~/.openclaw/openclaw.json");
          } else {
            lines.push("需要手动添加到 ~/.openclaw/openclaw.json:");
            lines.push(`  plugins.load.paths 添加: "${pluginPath}"`);
            lines.push(
              `  plugins.entries 添加: "${skillId}": { "enabled": true }`,
            );
          }
          lines.push("");
          lines.push("请重启 OpenClaw 以加载新技能。");

          return textResult(lines.join("\n"));
        } catch (err) {
          return textResult(`安装技能 "${skillId}" 失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );
}

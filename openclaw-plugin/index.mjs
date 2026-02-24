import { createRequire } from "node:module";
import { createHttpCaller, runPipeline } from "../lib/process.mjs";
import { getStatus } from "../lib/status.mjs";

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
        .action(async (slug, opts) => {
          const args = [slug];
          if (opts.name) args.push("--name", opts.name);
          const { run } = await import("../lib/new-perspective.mjs");
          await run(args);
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
}

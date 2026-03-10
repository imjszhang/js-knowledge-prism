import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, createReadStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHttpCaller, runPipeline } from "../lib/process.mjs";
import { getStatus } from "../lib/status.mjs";
import { listTemplates, loadTemplate, runOutput } from "../lib/output.mjs";
import { extractGraph, analyzeGraph, generateGraphHtml, filterByPerspective } from "../lib/graph.mjs";

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
  // Memory sync config & shared helper
  // ---------------------------------------------------------------------------

  const memorySyncEnabled = pluginCfg.memorySyncEnabled ?? true;
  const memorySyncDir = pluginCfg.memorySyncDir
    ? resolve(pluginCfg.memorySyncDir)
    : join(PROJECT_ROOT, "work_dir", "memory-export");
  const memorySyncIntervalMinutes = pluginCfg.memorySyncIntervalMinutes ?? 15;

  /**
   * Fire-and-forget incremental memory sync.
   * Shared by background service, tool hooks, and CLI.
   */
  async function runPrismMemorySync({ force = false, logger } = {}) {
    try {
      const { syncPrismToMemory } = await import("../lib/memory-sync.mjs");
      return syncPrismToMemory({ registryPath: getRegistryPath(), outputDir: memorySyncDir, force });
    } catch (err) {
      if (logger) logger.error(`[prism] memory sync failed: ${err.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Registry helpers (multi-base registration for cron auto-processing)
  // ---------------------------------------------------------------------------

  function getRegistryDir() {
    const workspace =
      api.config?.agents?.defaults?.workspace ||
      api.config?.agents?.list?.[0]?.workspace ||
      process.cwd();
    return join(workspace, ".openclaw", "prism-processor");
  }

  function getRegistryPath() {
    return join(getRegistryDir(), "registry.json");
  }

  function loadRegistry() {
    const p = getRegistryPath();
    if (!existsSync(p)) return { bases: [] };
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return { bases: [] };
    }
  }

  function saveRegistry(data) {
    const dir = getRegistryDir();
    mkdirSync(dir, { recursive: true });
    const p = getRegistryPath();
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  }

  function normalizeBaseDir(dir) {
    return resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function findBaseIndex(registry, baseDir) {
    const norm = normalizeBaseDir(baseDir);
    return registry.bases.findIndex(
      (b) => normalizeBaseDir(b.baseDir) === norm,
    );
  }

  function readBaseName(baseDir) {
    const cfgPath = join(baseDir, ".knowledgeprism.json");
    if (!existsSync(cfgPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
      return raw.name || "Knowledge Prism";
    } catch {
      return "Knowledge Prism";
    }
  }

  // ---------------------------------------------------------------------------
  // Service: prism-memory-sync (background, enabled by default)
  // ---------------------------------------------------------------------------

  let memorySyncTimer = null;

  api.registerService({
    id: "prism-memory-sync",
    async start(ctx) {
      if (!memorySyncEnabled) {
        ctx.logger.info("[prism] memorySyncEnabled=false, skipping memory sync service");
        return;
      }

      ctx.logger.info(`[prism] Memory sync starting (dir=${memorySyncDir}, interval=${memorySyncIntervalMinutes}m)`);
      const result = runPrismMemorySync({ logger: ctx.logger });
      if (result) {
        ctx.logger.info(`[prism] Initial sync done: ${result.synced} synced, ${result.deleted} deleted, ${result.total} total`);
      }

      if (memorySyncIntervalMinutes > 0) {
        memorySyncTimer = setInterval(() => {
          const r = runPrismMemorySync({ logger: ctx.logger });
          if (r && (r.synced > 0 || r.deleted > 0)) {
            ctx.logger.info(`[prism] Periodic sync: ${r.synced} synced, ${r.deleted} deleted`);
          }
        }, memorySyncIntervalMinutes * 60_000);
      }
    },
    async stop(ctx) {
      if (memorySyncTimer) {
        clearInterval(memorySyncTimer);
        memorySyncTimer = null;
      }
      ctx.logger.info("[prism] Memory sync service stopped");
    },
  });

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

      // --- prism register ---
      prism
        .command("register <dir>")
        .description("注册知识库到自动处理列表")
        .action(async (dir) => {
          const absDir = resolve(dir);
          const name = readBaseName(absDir);
          if (!name) {
            console.error(`\n  错误: ${absDir} 下未找到 .knowledgeprism.json`);
            console.error(`  请先运行: openclaw prism init ${dir}\n`);
            return;
          }
          const registry = loadRegistry();
          const idx = findBaseIndex(registry, absDir);
          if (idx >= 0) {
            console.log(`\n  该知识库已注册: ${registry.bases[idx].name} (${normalizeBaseDir(absDir)})\n`);
            return;
          }
          registry.bases.push({
            baseDir: normalizeBaseDir(absDir),
            name,
            registeredAt: new Date().toISOString(),
            enabled: true,
            lastProcessedAt: null,
            lastSummary: null,
          });
          saveRegistry(registry);
          console.log(`\n  ✓ 已注册: ${name} (${normalizeBaseDir(absDir)})\n`);
        });

      // --- prism unregister ---
      prism
        .command("unregister <dir>")
        .description("从自动处理列表移除知识库")
        .action(async (dir) => {
          const absDir = resolve(dir);
          const registry = loadRegistry();
          const idx = findBaseIndex(registry, absDir);
          if (idx < 0) {
            console.log(`\n  该知识库未注册: ${normalizeBaseDir(absDir)}\n`);
            return;
          }
          const removed = registry.bases.splice(idx, 1)[0];
          saveRegistry(registry);
          console.log(`\n  ✓ 已移除: ${removed.name} (${normalizeBaseDir(absDir)})\n`);
        });

      // --- prism registered ---
      prism
        .command("registered")
        .description("查看所有已注册知识库")
        .option("--json", "以 JSON 格式输出")
        .option("--status", "同时显示各库最新处理状态")
        .action(async (opts) => {
          const registry = loadRegistry();
          if (registry.bases.length === 0) {
            console.log("\n  尚未注册任何知识库。");
            console.log("  运行 openclaw prism register <dir> 添加知识库。\n");
            return;
          }
          if (opts.json) {
            if (opts.status) {
              for (const base of registry.bases) {
                try {
                  if (base.enabled && existsSync(join(base.baseDir, ".knowledgeprism.json"))) {
                    base._status = getStatus(base.baseDir);
                  }
                } catch { /* skip */ }
              }
            }
            console.log(JSON.stringify(registry, null, 2));
            return;
          }
          const enabled = registry.bases.filter((b) => b.enabled).length;
          const disabled = registry.bases.length - enabled;
          console.log(`\n  已注册知识库（${enabled} 个启用${disabled ? ` / ${disabled} 个禁用` : ""}）\n`);
          for (let i = 0; i < registry.bases.length; i++) {
            const b = registry.bases[i];
            const flag = b.enabled ? "✓ 启用" : "⏸ 禁用";
            const lastTs = b.lastProcessedAt
              ? b.lastProcessedAt.replace("T", " ").slice(0, 16)
              : "从未";
            console.log(`  ${i + 1}. ${b.name} [${flag}]`);
            console.log(`     路径: ${b.baseDir}`);
            if (opts.status && b.enabled) {
              try {
                if (!existsSync(join(b.baseDir, ".knowledgeprism.json"))) {
                  console.log(`     状态: [路径无效]`);
                } else {
                  const st = getStatus(b.baseDir);
                  console.log(`     待处理: ${st.unprocessed.length} 篇 journal, 未归组: ${st.ungroupedCount} 个 atom`);
                }
              } catch (err) {
                console.log(`     状态: [读取失败] ${err.message}`);
              }
            }
            console.log(`     上次处理: ${lastTs}`);
            if (b.lastSummary) console.log(`     摘要: ${b.lastSummary}`);
            console.log();
          }
        });

      // --- prism setup-cron ---
      prism
        .command("setup-cron")
        .description("配置知识棱镜的 cron 定时任务（定时批量处理所有已注册知识库）")
        .option("--every <minutes>", "执行间隔（分钟）", String(pluginCfg.cron?.defaultInterval ?? 60))
        .option("--tz <timezone>", "时区（IANA）", pluginCfg.cron?.timezone ?? "Asia/Shanghai")
        .option("--remove", "移除定时任务")
        .action(async (opts) => {
          const JOB_NAME = "prism-auto-process";
          const openclawBin = process.argv[0];
          const openclawEntry = process.argv[1];

          function runOcCron(args) {
            return execFileSync(openclawBin, [openclawEntry, "cron", ...args], {
              encoding: "utf-8",
              timeout: 30_000,
            }).trim();
          }

          try {
            if (opts.remove) {
              const listJson = runOcCron(["list", "--json"]);
              const { jobs } = JSON.parse(listJson);
              const existing = jobs.find((j) => j.name === JOB_NAME);
              if (!existing) {
                console.log(`\n  未找到名为 "${JOB_NAME}" 的定时任务，无需移除。\n`);
                return;
              }
              runOcCron(["rm", existing.id]);
              console.log(`\n  ✓ 已移除定时任务 "${JOB_NAME}" (${existing.id})\n`);
              return;
            }

            const listJson = runOcCron(["list", "--json"]);
            const { jobs } = JSON.parse(listJson);
            const existing = jobs.find((j) => j.name === JOB_NAME);
            if (existing) {
              console.log(`\n  定时任务 "${JOB_NAME}" 已存在 (${existing.id})。`);
              console.log(`  如需重新配置，请先执行: openclaw prism setup-cron --remove\n`);
              return;
            }

            const minutes = parseInt(opts.every, 10);
            if (isNaN(minutes) || minutes < 1) {
              console.error("  错误: --every 必须为正整数（分钟）");
              return;
            }

            const cronExpr = `*/${minutes} * * * *`;
            const result = runOcCron([
              "add",
              "--name", JOB_NAME,
              "--cron", cronExpr,
              "--tz", opts.tz,
              "--session", "isolated",
              "--message", "执行 prism-processor 技能的定时处理流程：检查并处理所有已注册知识库。",
              "--thinking", "minimal",
              "--json",
            ]);

            const job = JSON.parse(result);
            console.log(`\n  ✓ 定时任务已创建`);
            console.log(`    名称: ${job.name}`);
            console.log(`    ID:   ${job.id}`);
            console.log(`    调度: 每 ${minutes} 分钟`);
            console.log(`    时区: ${opts.tz}\n`);
          } catch (err) {
            console.error(`  配置失败: ${err.message}`);
            if (err.stderr) console.error(err.stderr);
          }
        });

      // --- prism sync ---
      prism
        .command("sync")
        .description("手动同步知识库到 OpenClaw 记忆系统（memory_search）")
        .option("--force", "忽略增量缓存，全量重新导出")
        .option("--dir <path>", "自定义导出目录（覆盖插件配置）")
        .action(async (opts) => {
          const outDir = opts.dir ? resolve(opts.dir) : memorySyncDir;
          console.log(`\n  同步目标: ${outDir}`);
          console.log(`  注册表: ${getRegistryPath()}\n`);
          const result = runPrismMemorySync({ force: !!opts.force });
          if (result) {
            console.log(`  ✓ 同步完成`);
            console.log(`    复制: ${result.synced}, 跳过: ${result.skipped}, 删除: ${result.deleted}, 总计: ${result.total}\n`);
          } else {
            console.error("  ✗ 同步失败，请检查注册表和知识库路径\n");
          }
        });

      // --- prism graph ---
      prism
        .command("graph")
        .description("生成知识图谱可视化 HTML 文件")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .option("--output <path>", "输出文件路径（默认 <baseDir>/graph.html）")
        .option("--json", "额外输出原始 JSON 数据文件")
        .option("--perspective <id>", "只显示特定视角相关的子图")
        .action(async (opts) => {
          const baseDir = opts.baseDir || resolveBaseDir();
          const kbName = readBaseName(baseDir) || "Knowledge Prism";

          console.log(`\n  知识图谱生成`);
          console.log(`  根目录: ${baseDir}\n`);

          let graph = extractGraph(baseDir);

          if (opts.perspective) {
            graph = filterByPerspective(graph, opts.perspective);
            console.log(`  已过滤至视角: ${opts.perspective}`);
          }

          const stats = analyzeGraph(graph);

          console.log(`  节点: ${stats.totalNodes}, 链接: ${stats.totalLinks}`);
          for (const [type, count] of Object.entries(stats.typeCounts)) {
            if (count > 0) console.log(`    ${type}: ${count}`);
          }
          if (stats.orphanCount > 0) console.log(`  ⚠ 发现 ${stats.orphanCount} 个孤立节点`);
          if (stats.brokenLinks.length > 0) console.log(`  ⚠ 发现 ${stats.brokenLinks.length} 条断链`);

          const outputPath = opts.output || join(baseDir, "graph.html");
          generateGraphHtml(graph, stats, {
            outputPath,
            knowledgeBaseName: kbName,
            log: (msg) => console.log(`  ${msg}`),
          });

          if (opts.json) {
            const jsonPath = outputPath.replace(/\.html$/, ".json");
            writeFileSync(jsonPath, JSON.stringify({ ...graph, stats }, null, 2), "utf-8");
            console.log(`  ✓ 已生成 JSON 数据: ${jsonPath}`);
          }

          console.log();
        });
    },
    { commands: ["prism"] },
  );

  /**
   * Regenerate graph.html for a knowledge base (best-effort, never throws).
   */
  function regenerateGraph(baseDir) {
    try {
      const graph = extractGraph(baseDir);
      const stats = analyzeGraph(graph);
      const kbName = readBaseName(baseDir) || "Knowledge Prism";
      generateGraphHtml(graph, stats, {
        outputPath: join(baseDir, "graph.html"),
        knowledgeBaseName: kbName,
        log: () => {},
      });
    } catch (err) {
      api.logger.warn(`[prism] graph regeneration failed for ${baseDir}: ${err.message}`);
    }
  }

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

        regenerateGraph(baseDir);
        parts.push("", "✓ 知识图谱已自动更新");

        runPrismMemorySync({ logger: api.logger }).catch(() => {});
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

        runPrismMemorySync({ logger: api.logger }).catch(() => {});
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tool: knowledge_prism_graph
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_graph",
      label: "Knowledge Prism: Generate Graph",
      description:
        "生成知识库的知识图谱可视化 HTML 文件。图谱展示「日记 → 信息单元 → 分组 → 顶层观点 → 视角 → 产出」的完整引用链。" +
        "返回生成路径和统计摘要（节点数、边数、覆盖率、孤立节点、断链）。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspective: {
            type: "string",
            description: "只显示特定视角相关的子图（如 P01）。省略则生成完整图谱。",
          },
          outputJson: {
            type: "boolean",
            description: "是否额外输出 JSON 数据文件。默认 false。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const kbName = readBaseName(baseDir) || "Knowledge Prism";

        let graph = extractGraph(baseDir);

        if (params.perspective) {
          graph = filterByPerspective(graph, params.perspective);
        }

        const stats = analyzeGraph(graph);
        const outputPath = join(baseDir, "graph.html");

        generateGraphHtml(graph, stats, {
          outputPath,
          knowledgeBaseName: kbName,
          log: () => {},
        });

        if (params.outputJson) {
          const jsonPath = outputPath.replace(/\.html$/, ".json");
          writeFileSync(jsonPath, JSON.stringify({ ...graph, stats }, null, 2), "utf-8");
        }

        const parts = [
          `知识图谱已生成 (${baseDir})`,
          `文件: ${outputPath}`,
          "",
          `节点: ${stats.totalNodes}, 链接: ${stats.totalLinks}, 覆盖率: ${stats.coverage}%`,
        ];
        for (const [type, count] of Object.entries(stats.typeCounts)) {
          if (count > 0) parts.push(`  ${type}: ${count}`);
        }
        if (stats.orphanCount > 0) parts.push(`\n孤立节点: ${stats.orphanCount}`);
        if (stats.brokenLinks.length > 0) parts.push(`断链: ${stats.brokenLinks.length}`);
        if (params.perspective) parts.push(`\n已过滤至视角: ${params.perspective}`);
        if (params.outputJson) parts.push(`JSON 数据: ${outputPath.replace(/\.html$/, ".json")}`);

        return textResult(parts.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tools: knowledge_prism_register / unregister / list_registered
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_register",
      label: "Knowledge Prism: Register Knowledge Base",
      description:
        "注册知识库到自动处理列表，或更新已注册知识库的启用状态。" +
        "注册后可通过 cron 定时任务自动处理。传入 enabled=false 可暂停自动处理。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径（必须包含 .knowledgeprism.json）",
          },
          enabled: {
            type: "boolean",
            description: "是否启用自动处理。默认 true。传 false 可暂停处理而不移除注册。",
          },
        },
        required: ["baseDir"],
      },
      async execute(_toolCallId, params) {
        const absDir = resolve(params.baseDir);
        const enabled = params.enabled ?? true;
        const registry = loadRegistry();
        const idx = findBaseIndex(registry, absDir);

        if (idx >= 0) {
          registry.bases[idx].enabled = enabled;
          saveRegistry(registry);
          runPrismMemorySync({ logger: api.logger }).catch(() => {});
          return textResult(
            `已更新: ${registry.bases[idx].name} → enabled=${enabled}`,
          );
        }

        const name = readBaseName(absDir);
        if (!name) {
          return textResult(
            `错误: ${absDir} 下未找到 .knowledgeprism.json。请先初始化知识库。`,
          );
        }

        registry.bases.push({
          baseDir: normalizeBaseDir(absDir),
          name,
          registeredAt: new Date().toISOString(),
          enabled,
          lastProcessedAt: null,
          lastSummary: null,
        });
        saveRegistry(registry);
        runPrismMemorySync({ logger: api.logger }).catch(() => {});
        return textResult(`已注册: ${name} (${normalizeBaseDir(absDir)})`);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_unregister",
      label: "Knowledge Prism: Unregister Knowledge Base",
      description: "从自动处理列表中完全移除知识库。移除后 cron 不再处理该库。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "要移除的知识库根目录路径",
          },
        },
        required: ["baseDir"],
      },
      async execute(_toolCallId, params) {
        const absDir = resolve(params.baseDir);
        const registry = loadRegistry();
        const idx = findBaseIndex(registry, absDir);
        if (idx < 0) {
          return textResult(
            `该知识库未注册: ${normalizeBaseDir(absDir)}`,
          );
        }
        const removed = registry.bases.splice(idx, 1)[0];
        saveRegistry(registry);
        runPrismMemorySync({ logger: api.logger }).catch(() => {});
        return textResult(`已移除: ${removed.name} (${normalizeBaseDir(absDir)})`);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_list_registered",
      label: "Knowledge Prism: List Registered Bases",
      description:
        "列出所有已注册的知识库及其状态。可选显示各库的最新处理状态（待处理 journal 数等）。",
      parameters: {
        type: "object",
        properties: {
          showStatus: {
            type: "boolean",
            description: "是否同时查询并显示各库最新处理状态。默认 true。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const registry = loadRegistry();
        if (registry.bases.length === 0) {
          return textResult(
            "尚未注册任何知识库。使用 knowledge_prism_register 添加知识库。",
          );
        }

        const showStatus = params.showStatus ?? true;
        const enabled = registry.bases.filter((b) => b.enabled).length;
        const disabled = registry.bases.length - enabled;
        const lines = [
          `已注册知识库（${enabled} 个启用${disabled ? ` / ${disabled} 个禁用` : ""}）`,
          "",
        ];

        for (let i = 0; i < registry.bases.length; i++) {
          const b = registry.bases[i];
          const flag = b.enabled ? "启用" : "禁用";
          const lastTs = b.lastProcessedAt
            ? b.lastProcessedAt.replace("T", " ").slice(0, 16)
            : "从未";

          lines.push(`${i + 1}. **${b.name}** [${flag}]`);
          lines.push(`   路径: ${b.baseDir}`);

          if (showStatus && b.enabled) {
            try {
              if (!existsSync(join(b.baseDir, ".knowledgeprism.json"))) {
                lines.push("   状态: [路径无效]");
              } else {
                const st = getStatus(b.baseDir);
                lines.push(
                  `   待处理: ${st.unprocessed.length} 篇 journal, 未归组: ${st.ungroupedCount} 个 atom`,
                );
              }
            } catch (err) {
              lines.push(`   状态: [读取失败] ${err.message}`);
            }
          }

          lines.push(`   上次处理: ${lastTs}`);
          if (b.lastSummary) lines.push(`   摘要: ${b.lastSummary}`);
          lines.push("");
        }

        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tool: knowledge_prism_process_all
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_process_all",
      label: "Knowledge Prism: Process All Registered Bases",
      description:
        "批量处理所有已注册且启用的知识库。遍历注册表，对有待处理内容的知识库执行增量 pipeline" +
        "（atoms → groups → synthesis + Agent 索引更新）。单库失败不影响其他库。",
      parameters: {
        type: "object",
        properties: {
          dryRun: {
            type: "boolean",
            description: "只检查各库状态，不实际执行处理。默认 false。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const registry = loadRegistry();
        const enabledBases = registry.bases.filter((b) => b.enabled);

        if (enabledBases.length === 0) {
          return textResult(
            "未注册任何启用的知识库。请先使用 knowledge_prism_register 注册。",
          );
        }

        const dryRun = params.dryRun ?? false;
        const results = [];

        for (const base of enabledBases) {
          const entry = { name: base.name, baseDir: base.baseDir };

          if (!existsSync(join(base.baseDir, ".knowledgeprism.json"))) {
            entry.status = "error";
            entry.message = "路径无效或未初始化";
            results.push(entry);
            continue;
          }

          let status;
          try {
            status = getStatus(base.baseDir);
          } catch (err) {
            entry.status = "error";
            entry.message = `状态读取失败: ${err.message?.slice(0, 150)}`;
            results.push(entry);
            continue;
          }

          const hasWork =
            status.unprocessed.length > 0 || status.ungroupedCount > 0;

          if (!hasWork) {
            entry.status = "skipped";
            entry.message = "无新内容";
            base.lastProcessedAt = new Date().toISOString();
            base.lastSummary = "无新内容";
            results.push(entry);
            continue;
          }

          if (dryRun) {
            entry.status = "dry-run";
            entry.message =
              `待处理: ${status.unprocessed.length} journal, 未归组: ${status.ungroupedCount} atom`;
            results.push(entry);
            continue;
          }

          try {
            const summary = await runPipeline({
              baseDir: base.baseDir,
              config: buildConfig(),
              callAgent: buildCallAgent(),
              dryRun: false,
              autoWrite: true,
              maxStage: 3,
              verbose: false,
              log: (msg) => api.logger.info(`[${base.name}] ${msg}`),
              warn: (msg) => api.logger.warn(`[${base.name}] ${msg}`),
            });

            entry.status = "processed";
            entry.message =
              `atoms: ${summary.atomsProcessed}, groups 新建: ${summary.groupsWritten}, ` +
              `更新: ${summary.groupsUpdated}, synthesis: ${summary.synthesisUpdated ? "已更新" : "未变"}`;
            base.lastProcessedAt = new Date().toISOString();
            base.lastSummary = entry.message;
            regenerateGraph(base.baseDir);
          } catch (err) {
            entry.status = "error";
            entry.message = err.message?.slice(0, 200);
          }

          results.push(entry);
        }

        if (!dryRun) {
          try {
            saveRegistry(registry);
          } catch { /* best-effort */ }
          runPrismMemorySync({ logger: api.logger }).catch(() => {});
        }

        const disabledCount = registry.bases.length - enabledBases.length;
        const header =
          `自动处理完毕（已注册 ${registry.bases.length} 个` +
          `${disabledCount ? `，${disabledCount} 个已禁用` : ""}）`;
        const lines = [header, ""];

        for (const r of results) {
          const icon =
            r.status === "processed" ? "✓" :
            r.status === "skipped" ? "—" :
            r.status === "dry-run" ? "👁" :
            "✗";
          lines.push(`${icon} ${r.name}`);
          lines.push(`  ${r.message}`);
          lines.push("");
        }

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

  // ---------------------------------------------------------------------------
  // Gateway HTTP Routes: Graph Hub
  // ---------------------------------------------------------------------------

  const GRAPH_ROUTE_PREFIX = "/plugins/js-knowledge/prism";
  const HUB_TEMPLATE_PATH = join(PROJECT_ROOT, "templates", "graph-hub.html");

  function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
  }

  function serveFile(res, filePath, contentType) {
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    res.writeHead(200, { "Content-Type": contentType });
    stream.pipe(res);
  }

  // Redirect /plugins/knowledge-prism -> /plugins/knowledge-prism/
  api.registerHttpRoute({
    path: `${GRAPH_ROUTE_PREFIX}`,
    auth: "plugin",
    async handler(_req, res) {
      res.writeHead(301, { Location: `${GRAPH_ROUTE_PREFIX}/` });
      res.end();
    },
  });

  // Hub page: /plugins/knowledge-prism/
  api.registerHttpRoute({
    path: `${GRAPH_ROUTE_PREFIX}/`,
    auth: "plugin",
    async handler(_req, res) {
      if (!existsSync(HUB_TEMPLATE_PATH)) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Hub template not found");
        return;
      }
      serveFile(res, HUB_TEMPLATE_PATH, "text/html; charset=utf-8");
    },
  });

  // API: /plugins/knowledge-prism/api/bases.json
  api.registerHttpRoute({
    path: `${GRAPH_ROUTE_PREFIX}/api/bases.json`,
    auth: "plugin",
    async handler(_req, res) {
      const registry = loadRegistry();
      const bases = registry.bases.map((b) => ({
        name: b.name,
        baseDir: b.baseDir,
        enabled: b.enabled,
        registeredAt: b.registeredAt,
        lastProcessedAt: b.lastProcessedAt,
        graphExists: existsSync(join(b.baseDir, "graph.html")),
      }));
      sendJson(res, 200, { bases });
    },
  });

  // Serve graph HTML: /plugins/knowledge-prism/graph/{index}
  api.registerHttpRoute({
    path: `${GRAPH_ROUTE_PREFIX}/graph`,
    auth: "plugin",
    match: "prefix",
    async handler(req, res) {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const tail = parsed.pathname.slice(`${GRAPH_ROUTE_PREFIX}/graph/`.length);
      const index = parseInt(tail, 10);

      if (isNaN(index) || index < 0) {
        sendJson(res, 400, { error: "Invalid index" });
        return;
      }

      const registry = loadRegistry();
      if (index >= registry.bases.length) {
        sendJson(res, 404, { error: "Index out of range" });
        return;
      }

      const base = registry.bases[index];
      const graphPath = join(base.baseDir, "graph.html");
      if (!existsSync(graphPath)) {
        sendJson(res, 404, {
          error: `graph.html not found for "${base.name}". Run: openclaw prism graph --base-dir "${base.baseDir}"`,
        });
        return;
      }

      serveFile(res, graphPath, "text/html; charset=utf-8");
    },
  });
}

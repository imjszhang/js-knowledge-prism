import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, createReadStream, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHttpCaller, runPipeline } from "../lib/process.mjs";
import { getStatus } from "../lib/status.mjs";
import { listTemplates, listTypes, loadTemplate, loadType, runOutput } from "../lib/output.mjs";
import { listRewrites, loadRewrite, runRewrite, runRewriteBatch } from "../lib/rewrite.mjs";
import { makePaths, listPerspectiveDirs, parseKeyLineTable } from "../lib/utils.mjs";
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

/**
 * Convert a minutes interval to a valid cron expression.
 * Cron minute field max is 59; intervals > 60 use hour-level expressions.
 */
function minutesToCronExpr(minutes) {
  if (minutes <= 60) return `*/${minutes} * * * *`;
  if (minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  return `0 */${Math.max(1, Math.floor(minutes / 60))} * * *`;
}

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
  // Config-declared output bindings helpers
  // ---------------------------------------------------------------------------

  function loadConfigBindings(baseDir) {
    const configPath = join(baseDir, ".knowledgeprism.json");
    if (!existsSync(configPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return (raw.output?.bindings || [])
        .filter((b) => b.perspectiveDir && b.template)
        .map((b) => ({
          perspectiveDir: b.perspectiveDir,
          template: b.template,
          klStrategy: b.klStrategy || "synthesis",
          enabled: b.enabled ?? true,
          rewrites: b.rewrites || [],
        }));
    } catch {
      return [];
    }
  }

  function mergeBindings(registryBindings, configBindings) {
    const merged = [...registryBindings];
    const seen = new Set(
      registryBindings.map((b) => `${b.perspectiveDir}::${b.template}`),
    );

    for (const cb of configBindings) {
      if (!cb.enabled) continue;
      const key = `${cb.perspectiveDir}::${cb.template}`;
      if (seen.has(key)) {
        const existing = merged.find(
          (b) => b.perspectiveDir === cb.perspectiveDir && b.template === cb.template,
        );
        if (existing) {
          if (cb.klStrategy) existing.klStrategy = cb.klStrategy;
          if (cb.rewrites?.length) existing.rewrites = cb.rewrites;
        }
      } else {
        merged.push({
          ...cb,
          source: "config",
          lastStructureRefreshAt: null,
          lastOutputAt: null,
          lastOutputSummary: null,
        });
        seen.add(key);
      }
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Output inbox/batch helpers (inbox/batch rotation for reliable output cron)
  // ---------------------------------------------------------------------------

  const MAX_KL_RETRIES = 3;

  function getOutputInboxPath() {
    return join(getRegistryDir(), "output-inbox.jsonl");
  }

  function getOutputArchiveDir() {
    return join(getRegistryDir(), "output-archive");
  }

  function appendToOutputInbox(entry) {
    const dir = getRegistryDir();
    mkdirSync(dir, { recursive: true });
    const p = getOutputInboxPath();
    const line = JSON.stringify(entry) + "\n";
    writeFileSync(p, line, { encoding: "utf-8", flag: "a" });
  }

  function readOutputInbox() {
    const p = getOutputInboxPath();
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").split(/\r?\n/).filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return entries;
  }

  function findOutputBatchFile() {
    const dir = getRegistryDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.startsWith("output-batch-") && f.endsWith(".json"));
    return files.length > 0 ? join(dir, files[0]) : null;
  }

  function loadOutputBatch(batchPath) {
    try {
      return JSON.parse(readFileSync(batchPath, "utf-8"));
    } catch {
      return null;
    }
  }

  function saveOutputBatch(batchPath, batch) {
    const tmp = batchPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(batch, null, 2) + "\n", "utf-8");
    renameSync(tmp, batchPath);
  }

  function archiveOutputBatch(batchPath) {
    const archiveDir = getOutputArchiveDir();
    mkdirSync(archiveDir, { recursive: true });
    const name = batchPath.split(/[/\\]/).pop();
    const dest = join(archiveDir, name);
    renameSync(batchPath, dest);
  }

  function rotateInboxToBatch() {
    const inboxPath = getOutputInboxPath();
    const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const batchPath = join(getRegistryDir(), `output-batch-${ts}.json`);

    const inboxEntries = readOutputInbox();
    if (inboxEntries.length === 0) return null;

    const basePerspectives = new Map();
    for (const entry of inboxEntries) {
      const bd = normalizeBaseDir(entry.baseDir);
      const existing = basePerspectives.get(bd) || new Set();
      for (const p of (entry.perspectives || [])) existing.add(p);
      basePerspectives.set(bd, existing);
    }

    const registry = loadRegistry();

    const items = [];
    for (const [bd, inboxPerspectives] of basePerspectives) {
      const idx = findBaseIndex(registry, bd);
      if (idx < 0) continue;
      const base = registry.bases[idx];
      const bindings = (base.outputBindings || []).filter((b) => b.enabled);
      for (const binding of bindings) {
        if (inboxPerspectives.size > 0 && !inboxPerspectives.has(binding.perspectiveDir)) continue;
        items.push({
          baseDir: bd,
          perspectiveDir: binding.perspectiveDir,
          template: binding.template,
          kls: [],
          structureRefreshed: false,
        });
      }
    }

    if (items.length === 0) return null;

    const batch = { createdAt: new Date().toISOString(), source: "inbox", items };
    saveOutputBatch(batchPath, batch);

    writeFileSync(inboxPath, "", "utf-8");

    return batchPath;
  }

  function buildRetryBatch(registry) {
    const items = [];
    for (const base of registry.bases.filter((b) => b.enabled)) {
      for (const binding of (base.outputBindings || []).filter((b) => b.enabled)) {
        const retryable = (binding.failedKLs || []).filter(
          (f) => f.retries < MAX_KL_RETRIES && f.status !== "permanently_failed",
        );
        if (retryable.length === 0) continue;
        items.push({
          baseDir: normalizeBaseDir(base.baseDir),
          perspectiveDir: binding.perspectiveDir,
          template: binding.template,
          kls: retryable.map((f) => ({
            klId: f.klId,
            status: "pending",
            retries: f.retries,
          })),
          structureRefreshed: true,
        });
      }
    }
    if (items.length === 0) return null;

    const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const batchPath = join(getRegistryDir(), `output-batch-${ts}.json`);
    const batch = { createdAt: new Date().toISOString(), source: "retry", items };
    saveOutputBatch(batchPath, batch);
    return batchPath;
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
        .option("--perspective <dir>", "视角目录名（逗号分隔多个，如 P01,P02）")
        .option("--template <name>", "输出模板名（用 --list-templates 查看可用模板）")
        .option("--output-dir <dir>", "输出目录（默认 outputs/<template>）")
        .option("--kl <ids>", "只处理指定 KL（逗号分隔）")
        .option("--source <type>", "素材来源类型（analysis）")
        .option("--groups <ids>", "指定 groups（逗号分隔，配合 --source analysis）")
        .option("--skeleton", "只生成骨架文件（不调用 LLM）")
        .option("--validate", "只验证已有骨架的引用有效性")
        .option("--dry-run", "只预览，不调用模型")
        .option("--force", "覆盖已存在的非骨架文件")
        .option("--review", "生成后执行 LLM 质量审校")
        .option("--stage <name>", "从指定流水线阶段开始执行")
        .option("--base-dir <dir>", "知识库根目录（覆盖插件配置）")
        .option("--list-templates", "列出可用模板")
        .option("--list-types", "列出可用类型定义")
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

          if (opts.listTypes) {
            const types = listTypes(baseDir);
            if (types.length === 0) {
              console.log("没有可用的类型定义。");
              return;
            }
            console.log("\n可用类型:\n");
            for (const t of types) {
              const td = loadType(t.name, baseDir);
              console.log(`  ${t.name} (${t.source})`);
              if (td?.description) console.log(`    ${td.description}`);
              if (td?.split) console.log(`    拆分: ${td.split}, 命名: ${td.fileNaming || "sequence"}`);
              console.log();
            }
            return;
          }

          const perspectiveParts = opts.perspective ? opts.perspective.split(",").map((s) => s.trim()) : [];
          const isMultiPerspective = perspectiveParts.length > 1;

          if (!isMultiPerspective && perspectiveParts.length === 0 && !opts.source) {
            console.error("错误: 必须指定 --perspective 或 --source");
            return;
          }
          if (!opts.template) {
            console.error("错误: 必须指定 --template");
            return;
          }

          let mode;
          if (opts.skeleton) mode = "skeleton";
          else if (opts.validate) mode = "validate";

          const sourceOpt = opts.source
            ? { type: opts.source, groups: opts.groups ? opts.groups.split(",").map((s) => s.trim()) : undefined }
            : undefined;

          await runOutput({
            baseDir,
            perspectiveDir: isMultiPerspective ? perspectiveParts[0] : perspectiveParts[0],
            perspectives: isMultiPerspective ? perspectiveParts : undefined,
            source: sourceOpt,
            template: opts.template,
            outputDir: opts.outputDir,
            mode,
            autoWrite: true,
            dryRun: opts.dryRun || false,
            force: opts.force || false,
            review: opts.review || false,
            stage: opts.stage,
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

            const cronExpr = minutesToCronExpr(minutes);
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

      // --- prism setup-output-cron ---
      prism
        .command("setup-output-cron")
        .description("配置知识棱镜的 output 定时任务（定时批量生成所有已绑定的产出）")
        .option("--every <minutes>", "执行间隔（分钟）", String(pluginCfg.cron?.outputInterval ?? 120))
        .option("--tz <timezone>", "时区（IANA）", pluginCfg.cron?.timezone ?? "Asia/Shanghai")
        .option("--remove", "移除定时任务")
        .action(async (opts) => {
          const JOB_NAME = "prism-auto-output";
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
              console.log(`  如需重新配置，请先执行: openclaw prism setup-output-cron --remove\n`);
              return;
            }

            const minutes = parseInt(opts.every, 10);
            if (isNaN(minutes) || minutes < 1) {
              console.error("  错误: --every 必须为正整数（分钟）");
              return;
            }

            const cronExpr = minutesToCronExpr(minutes);
            const result = runOcCron([
              "add",
              "--name", JOB_NAME,
              "--cron", cronExpr,
              "--tz", opts.tz,
              "--session", "isolated",
              "--message", "执行知识棱镜的自动产出流程：检测 structure 变化并生成 output 内容。",
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

      // --- prism rewrite ---
      prism
        .command("rewrite")
        .description("对已有产出文件执行风格改写")
        .option("--style <name>", "改写风格名")
        .option("--file <path>", "改写单个文件")
        .option("--dir <path>", "批量改写目录下所有 .md 文件")
        .option("--output-dir <dir>", "自定义输出目录")
        .option("--force", "覆盖已存在的改写结果")
        .option("--review", "改写后审校")
        .option("--dry-run", "只预览，不调用模型")
        .option("--list-styles", "列出可用改写定义")
        .action(async (opts) => {
          const baseDir = resolveBaseDir();

          if (opts.listStyles) {
            const rewrites = listRewrites(baseDir);
            if (rewrites.length === 0) {
              console.log("没有可用的改写定义。");
              return;
            }
            console.log("\n可用改写定义:\n");
            for (const r of rewrites) {
              const def = loadRewrite(r.name, baseDir);
              console.log(`  ${r.name} (${r.source})`);
              if (def?.description) console.log(`    ${def.description}`);
              if (def?.platform) console.log(`    平台: ${def.platform}`);
              console.log();
            }
            return;
          }

          if (!opts.style) {
            console.error("  错误: 必须指定 --style（或使用 --list-styles）");
            return;
          }
          if (!opts.file && !opts.dir) {
            console.error("  错误: 必须指定 --file 或 --dir");
            return;
          }

          const callAgent = buildCallAgent();

          if (opts.file) {
            const inputPath = resolve(opts.file);
            const result = await runRewrite({
              inputPath,
              rewriteName: opts.style,
              baseDir,
              callAgent,
              outputDir: opts.outputDir,
              force: !!opts.force,
              review: !!opts.review,
              dryRun: !!opts.dryRun,
            });
            if (result.status === "error") {
              console.error(`  错误: ${result.error}`);
            } else {
              console.log(`  ${result.status}: ${result.file}`);
            }
            return;
          }

          if (opts.dir) {
            const inputDir = resolve(opts.dir);
            await runRewriteBatch({
              inputDir,
              rewriteName: opts.style,
              baseDir,
              callAgent,
              outputDir: opts.outputDir,
              force: !!opts.force,
              review: !!opts.review,
              dryRun: !!opts.dryRun,
            });
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
        "推荐两阶段流程：先 skeleton 生成骨架审查引用，再 generate 填充内容。" +
        "支持多粒度素材（per-kl/per-perspective/per-group）、多视角交叉、从 analysis 直接生成、质量审校和多阶段流水线。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名（如 P25-yangxia-series）。多视角模式下传主视角，并用 perspectives 指定全部。",
          },
          perspectives: {
            type: "array",
            items: { type: "string" },
            description: "多视角交叉生成时指定的视角列表（如 [\"P01-xxx\", \"P02-yyy\"]）。省略则使用单一 perspectiveDir。",
          },
          source: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["cross-perspective", "analysis"], description: "素材来源类型" },
              groups: { type: "array", items: { type: "string" }, description: "指定 groups（配合 type: analysis）" },
            },
            description: "素材来源配置。省略则从 perspectiveDir 的 structure 读取。",
          },
          template: {
            type: "string",
            description: "输出模板名（用 knowledge_prism_list_templates 查看可用模板）",
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
          review: {
            type: "boolean",
            description: "生成后执行 LLM 质量审校，报告保存到 _reviews/。默认 false。",
          },
          stage: {
            type: "string",
            description: "从指定流水线阶段开始执行（需模板声明 stages）。省略则从头开始。",
          },
        },
        required: ["template"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const logs = [];
        const warnings = [];
        const mode = params.mode || "generate";

        if (!params.perspectiveDir && !params.source && !params.perspectives) {
          return textResult("错误: 必须指定 perspectiveDir、perspectives 或 source 之一。");
        }

        const result = await runOutput({
          baseDir,
          perspectiveDir: params.perspectiveDir,
          perspectives: params.perspectives,
          source: params.source,
          template: params.template,
          outputDir: params.outputDir,
          mode,
          autoWrite: true,
          dryRun: false,
          force: params.force ?? false,
          review: params.review ?? false,
          stage: params.stage,
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
            const label = r.id ? `${r.id} → ${r.file}` : r.file;
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

  api.registerTool(
    {
      name: "knowledge_prism_list_types",
      label: "Knowledge Prism: List Output Types",
      description: "列出可用的产出类型定义（内置 + 知识库本地自定义类型），包含各类型的读者画像、拆分粒度和质量标准。",
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
        const types = listTypes(baseDir);

        if (types.length === 0) {
          return textResult("没有可用的产出类型定义。");
        }

        const lines = [`## 可用类型 (${types.length} 个)`, ""];
        for (const t of types) {
          const td = loadType(t.name, baseDir);
          lines.push(`- **${t.name}** (${t.source})`);
          if (td?.description) lines.push(`  ${td.description}`);
          if (td?.split) lines.push(`  拆分: ${td.split}, 命名: ${td.fileNaming || "sequence"}`);
          lines.push("");
        }
        lines.push("模板通过 frontmatter `type: <name>` 引用类型定义。");

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
          outputBindings: [],
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

            const hasOutputRelevantChanges =
              summary.synthesisUpdated || summary.groupsWritten > 0 || summary.groupsUpdated > 0;
            if (hasOutputRelevantChanges) {
              try {
                const perspectives = (base.outputBindings || [])
                  .filter((b) => b.enabled)
                  .map((b) => b.perspectiveDir);
                if (perspectives.length > 0) {
                  appendToOutputInbox({
                    baseDir: normalizeBaseDir(base.baseDir),
                    changedAt: new Date().toISOString(),
                    trigger: "process_all",
                    perspectives: [...new Set(perspectives)],
                  });
                }
              } catch { /* best-effort */ }
            }
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
  // AI Tools: knowledge_prism_rewrite / list_rewrites
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_rewrite",
      label: "Knowledge Prism: Rewrite",
      description:
        "对已有产出文件执行风格改写。可改写单个文件或整个目录。" +
        "改写结果写入 _rewrites/<style>/ 子目录，不覆盖原文。" +
        "支持自动从 frontmatter refs 加载补充素材上下文。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录。省略则使用插件配置。",
          },
          style: {
            type: "string",
            description: "改写风格名（如 kzk-wechat）",
          },
          file: {
            type: "string",
            description: "改写单个文件路径（与 dir 二选一）",
          },
          dir: {
            type: "string",
            description: "批量改写目录路径（与 file 二选一）",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名（配合 template 自动定位产出目录）",
          },
          template: {
            type: "string",
            description: "模板名（配合 perspectiveDir 自动定位产出目录）",
          },
          force: {
            type: "boolean",
            description: "覆盖已存在的改写结果。默认 false。",
          },
          review: {
            type: "boolean",
            description: "改写后执行信息保留度审校。默认 false。",
          },
          dryRun: {
            type: "boolean",
            description: "只预览，不调用模型。默认 false。",
          },
        },
        required: ["style"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const absDir = resolve(baseDir);

        const rewriteDef = loadRewrite(params.style, absDir);
        if (!rewriteDef) {
          const available = listRewrites(absDir).map((r) => r.name);
          return textResult(
            `错误: 改写定义 "${params.style}" 未找到。可用: ${available.join(", ") || "无"}`,
          );
        }

        const callAgent = buildCallAgent();
        const force = params.force ?? false;
        const review = params.review ?? false;
        const dryRun = params.dryRun ?? false;

        if (params.file) {
          const inputPath = resolve(params.file);
          const result = await runRewrite({
            inputPath,
            rewriteName: params.style,
            baseDir: absDir,
            callAgent,
            force,
            review,
            dryRun,
          });
          if (result.status === "error") {
            return textResult(`错误: ${result.error}`);
          }
          return textResult(`${result.status}: ${result.file}${result.outputPath ? ` → ${result.outputPath}` : ""}`);
        }

        let inputDir;
        if (params.dir) {
          inputDir = resolve(params.dir);
        } else if (params.perspectiveDir && params.template) {
          const paths = makePaths(absDir);
          inputDir = join(paths.outputsDir, params.template, params.perspectiveDir);
        } else {
          return textResult("错误: 必须指定 file、dir、或 perspectiveDir+template 之一。");
        }

        if (!existsSync(inputDir)) {
          return textResult(`错误: 目录不存在: ${inputDir}`);
        }

        const result = await runRewriteBatch({
          inputDir,
          rewriteName: params.style,
          baseDir: absDir,
          callAgent,
          force,
          review,
          dryRun,
        });

        return textResult(result.message);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_list_rewrites",
      label: "Knowledge Prism: List Rewrites",
      description: "列出可用的改写定义（内置和知识库自定义）。",
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
        const absDir = resolve(baseDir);
        const rewrites = listRewrites(absDir);

        if (rewrites.length === 0) {
          return textResult("没有可用的改写定义。");
        }

        const lines = ["可用改写定义:", ""];
        for (const r of rewrites) {
          const def = loadRewrite(r.name, absDir);
          lines.push(`- ${r.name} (${r.source})`);
          if (def?.description) lines.push(`  ${def.description}`);
          if (def?.platform) lines.push(`  平台: ${def.platform}`);
        }
        return textResult(lines.join("\n"));
      },
    },
    { optional: true },
  );

  // ---------------------------------------------------------------------------
  // AI Tools: knowledge_prism_bind_output / list_output_bindings / output_all
  // ---------------------------------------------------------------------------

  api.registerTool(
    {
      name: "knowledge_prism_bind_output",
      label: "Knowledge Prism: Bind Output",
      description:
        "为已注册知识库绑定一对 视角+模板 的自动产出配置。绑定后 cron 定时任务会自动检测变化并生成 output。" +
        "klStrategy 控制 structure 刷新策略：synthesis=全量重生成（默认），date-driven=仅追加新日期 KL，manual=不自动刷新。" +
        "传入 enabled=false 可暂停自动产出而不移除绑定。重复绑定相同 perspectiveDir+template 只更新 enabled/klStrategy 状态。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "已注册的知识库根目录路径。省略则使用插件配置的默认值。",
          },
          perspectiveDir: {
            type: "string",
            description: "视角目录名（如 P25-yangxia-series）",
          },
          template: {
            type: "string",
            description: "输出模板名（用 knowledge_prism_list_templates 查看可用模板）",
          },
          enabled: {
            type: "boolean",
            description: "是否启用自动产出。默认 true。传 false 可暂停。",
          },
          klStrategy: {
            type: "string",
            enum: ["synthesis", "date-driven", "manual"],
            description:
              "structure 刷新策略。synthesis=全量重生成 SCQA+KL+expand（默认）；" +
              "date-driven=仅追加新日期的 KL（适合日记/日志型视角）；manual=不自动刷新。",
          },
          rewrites: {
            type: "array",
            items: { type: "string" },
            description: "绑定的改写风格名列表（如 [\"kzk-wechat\"]）。产出生成后自动执行改写。",
          },
        },
        required: ["perspectiveDir", "template"],
      },
      async execute(_toolCallId, params) {
        const baseDir = params.baseDir || resolveBaseDir();
        const absDir = resolve(baseDir);
        const registry = loadRegistry();
        const idx = findBaseIndex(registry, absDir);

        if (idx < 0) {
          return textResult(
            `错误: 知识库 ${normalizeBaseDir(absDir)} 未注册。请先使用 knowledge_prism_register 注册。`,
          );
        }

        const paths = makePaths(absDir);
        const perspPath = join(paths.structureDir, params.perspectiveDir);
        if (!existsSync(perspPath)) {
          const available = listPerspectiveDirs(paths.structureDir);
          return textResult(
            `错误: 视角目录不存在: ${params.perspectiveDir}\n可用视角: ${available.join(", ") || "无"}`,
          );
        }

        const tpl = loadTemplate(params.template, absDir);
        if (!tpl) {
          const available = listTemplates(absDir).map((t) => t.name);
          return textResult(
            `错误: 模板 "${params.template}" 未找到。可用模板: ${available.join(", ") || "无"}`,
          );
        }

        const rewriteNames = params.rewrites || [];
        for (const rn of rewriteNames) {
          if (!loadRewrite(rn, absDir)) {
            const available = listRewrites(absDir).map((r) => r.name);
            return textResult(
              `错误: 改写定义 "${rn}" 未找到。可用: ${available.join(", ") || "无"}`,
            );
          }
        }

        const base = registry.bases[idx];
        if (!base.outputBindings) base.outputBindings = [];

        const cfgBindings = loadConfigBindings(absDir);
        const inConfig = cfgBindings.some(
          (cb) => cb.perspectiveDir === params.perspectiveDir && cb.template === params.template,
        );
        const configHint = inConfig
          ? "\n注意: 该绑定已在 .knowledgeprism.json 的 output.bindings 中声明，手动绑定将与 config 合并（运行时以 config 的 klStrategy 为准）。"
          : "";

        const enabled = params.enabled ?? true;
        const existing = base.outputBindings.find(
          (b) => b.perspectiveDir === params.perspectiveDir && b.template === params.template,
        );

        const klStrategy = params.klStrategy || "synthesis";

        if (existing) {
          existing.enabled = enabled;
          existing.klStrategy = klStrategy;
          if (rewriteNames.length > 0) existing.rewrites = rewriteNames;
          saveRegistry(registry);
          const rewriteHint = rewriteNames.length > 0 ? `, rewrites=[${rewriteNames.join(", ")}]` : "";
          return textResult(
            `已更新绑定: ${params.perspectiveDir} + ${params.template} → enabled=${enabled}, klStrategy=${klStrategy}${rewriteHint}${configHint}`,
          );
        }

        base.outputBindings.push({
          perspectiveDir: params.perspectiveDir,
          template: params.template,
          enabled,
          klStrategy,
          rewrites: rewriteNames.length > 0 ? rewriteNames : undefined,
          lastStructureRefreshAt: null,
          lastOutputAt: null,
          lastOutputSummary: null,
          lastRewriteAt: null,
        });
        saveRegistry(registry);
        const rewriteHint = rewriteNames.length > 0 ? `, rewrites=[${rewriteNames.join(", ")}]` : "";
        return textResult(
          `已绑定: ${base.name} — ${params.perspectiveDir} + ${params.template} (klStrategy=${klStrategy}${rewriteHint})${configHint}`,
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "knowledge_prism_list_output_bindings",
      label: "Knowledge Prism: List Output Bindings",
      description:
        "列出已注册知识库的自动产出绑定配置。可指定某个知识库，或省略列出全部。",
      parameters: {
        type: "object",
        properties: {
          baseDir: {
            type: "string",
            description: "知识库根目录路径。省略则列出所有已注册知识库的绑定。",
          },
        },
      },
      async execute(_toolCallId, params) {
        const registry = loadRegistry();
        let targets = registry.bases;

        if (params.baseDir) {
          const absDir = resolve(params.baseDir);
          const idx = findBaseIndex(registry, absDir);
          if (idx < 0) {
            return textResult(`知识库未注册: ${normalizeBaseDir(absDir)}`);
          }
          targets = [registry.bases[idx]];
        }

        if (targets.length === 0) {
          return textResult("尚未注册任何知识库。");
        }

        const lines = [];
        let totalBindings = 0;

        for (const base of targets) {
          const cfgBindings = loadConfigBindings(base.baseDir);
          const bindings = mergeBindings(base.outputBindings || [], cfgBindings);
          totalBindings += bindings.length;
          lines.push(`**${base.name}** (${normalizeBaseDir(base.baseDir)})`);

          if (bindings.length === 0) {
            lines.push("  无产出绑定");
          } else {
            for (const b of bindings) {
              const flag = b.enabled ? "启用" : "禁用";
              const strategy = b.klStrategy || "synthesis";
              const source = b.source === "config" ? " [来源: config]" : "";
              const lastTs = b.lastOutputAt
                ? b.lastOutputAt.replace("T", " ").slice(0, 16)
                : "从未";
              const lastRefresh = b.lastStructureRefreshAt
                ? b.lastStructureRefreshAt.replace("T", " ").slice(0, 16)
                : "从未";
              const rewriteInfo = b.rewrites?.length ? ` [rewrites: ${b.rewrites.join(", ")}]` : "";
              lines.push(`  - ${b.perspectiveDir} + ${b.template} [${flag}] [klStrategy: ${strategy}]${rewriteInfo}${source}`);
              lines.push(`    上次 structure 刷新: ${lastRefresh} | 上次产出: ${lastTs}`);
              if (b.lastRewriteAt) lines.push(`    上次改写: ${b.lastRewriteAt.replace("T", " ").slice(0, 16)}`);
              if (b.lastOutputSummary) lines.push(`    摘要: ${b.lastOutputSummary}`);
            }
          }
          lines.push("");
        }

        const header = `产出绑定汇总（${targets.length} 个知识库，${totalBindings} 个绑定）\n`;
        return textResult(header + lines.join("\n"));
      },
    },
    { optional: true },
  );

  /**
   * Recursively find the latest mtime under a directory tree.
   * Returns epoch ms, or 0 if dir doesn't exist.
   */
  function getLatestMtime(dir) {
    if (!existsSync(dir)) return 0;
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        latest = Math.max(latest, getLatestMtime(full));
      } else {
        latest = Math.max(latest, statSync(full).mtimeMs);
      }
    }
    return latest;
  }

  /**
   * Run structure refresh according to the binding's klStrategy.
   * @returns {{ status: "refreshed"|"error"|"skipped", message: string, newKlIds?: string[] }}
   */
  async function refreshByStrategy({
    strategy, baseDir, perspectiveDir, paths, perspPath,
    callAgent, logger, runFillPerspective, runExpandKl,
  }) {
    if (strategy === "manual") {
      return { status: "skipped", message: "klStrategy=manual" };
    }

    if (strategy === "synthesis") {
      const scqaResult = await runFillPerspective({
        baseDir, perspectiveDir, stage: "scqa", autoWrite: true, callAgent,
      });
      const klResult = await runFillPerspective({
        baseDir, perspectiveDir, stage: "keyline", autoWrite: true, callAgent,
      });

      let expandCount = 0;
      let expandErrors = 0;
      const treePath = join(perspPath, "tree", "README.md");
      if (existsSync(treePath)) {
        const treeContent = readFileSync(treePath, "utf-8");
        const keyLines = parseKeyLineTable(treeContent);
        for (const kl of keyLines) {
          try {
            await runExpandKl({ baseDir, perspectiveDir, klId: kl.klId, autoWrite: true, callAgent });
            expandCount++;
          } catch (err) {
            expandErrors++;
            logger?.warn?.(`expand ${kl.klId} 失败: ${err.message}`);
          }
        }
      }

      const parts = [];
      if (scqaResult.success) parts.push("SCQA ✓");
      else parts.push(`SCQA ✗ ${scqaResult.message?.slice(0, 60)}`);
      if (klResult.success) parts.push("Key Lines ✓");
      else parts.push(`Key Lines ✗ ${klResult.message?.slice(0, 60)}`);
      if (expandCount > 0 || expandErrors > 0) {
        parts.push(`expand KL: ${expandCount} 成功` + (expandErrors ? `, ${expandErrors} 失败` : ""));
      }
      return { status: "refreshed", message: parts.join(", ") };
    }

    if (strategy === "date-driven") {
      const { buildAbbrevToGroupsMap, detectNewDates, appendDateKls, detectStaleKls }
        = await import("../lib/date-driven-kl.mjs");

      const newDates = detectNewDates(paths, perspectiveDir);

      let appendResult = { success: true, message: "无新日期需要追加", newKlIds: [] };
      if (newDates.length > 0) {
        const abbrevToGroups = buildAbbrevToGroupsMap(paths.groupsDir);
        appendResult = await appendDateKls({ paths, perspectiveDir, newDates, callAgent, abbrevToGroups });
        if (!appendResult.success) {
          return { status: "error", message: appendResult.message };
        }
      }

      let expandCount = 0;
      let expandErrors = 0;
      for (const klId of appendResult.newKlIds) {
        try {
          await runExpandKl({ baseDir, perspectiveDir, klId, autoWrite: true, callAgent });
          expandCount++;
        } catch (err) {
          expandErrors++;
          logger?.warn?.(`expand ${klId} 失败: ${err.message}`);
        }
      }

      const staleKlIds = detectStaleKls(paths, perspectiveDir);
      let reExpandCount = 0;
      let reExpandErrors = 0;
      for (const klId of staleKlIds) {
        if (appendResult.newKlIds.includes(klId)) continue;
        try {
          await runExpandKl({ baseDir, perspectiveDir, klId, autoWrite: true, callAgent });
          reExpandCount++;
        } catch (err) {
          reExpandErrors++;
          logger?.warn?.(`re-expand ${klId} 失败: ${err.message}`);
        }
      }

      if (newDates.length === 0 && staleKlIds.length === 0) {
        return { status: "skipped", message: "无新日期，无 stale KL" };
      }

      const parts = [appendResult.message];
      if (expandCount > 0 || expandErrors > 0) {
        parts.push(`expand: ${expandCount} 成功` + (expandErrors ? `, ${expandErrors} 失败` : ""));
      }
      if (reExpandCount > 0 || reExpandErrors > 0) {
        parts.push(`re-expand(stale): ${reExpandCount} 成功` + (reExpandErrors ? `, ${reExpandErrors} 失败` : ""));
      }
      return { status: "refreshed", message: parts.join(", "), newKlIds: appendResult.newKlIds, staleKlIds };
    }

    return { status: "skipped", message: `未知策略: ${strategy}` };
  }

  api.registerTool(
    {
      name: "knowledge_prism_output_all",
      label: "Knowledge Prism: Output All Bindings",
      description:
        "批量生成所有已注册知识库中启用的产出绑定。使用 inbox/batch 轮转机制：" +
        "优先恢复未完成 batch（崩溃恢复），其次处理 inbox 信号，再次重试失败 KL，" +
        "最后 fallback 到 mtime 检测。支持断点续传和自动重试（最多 3 次）。",
      parameters: {
        type: "object",
        properties: {
          dryRun: {
            type: "boolean",
            description: "只检查各绑定状态，不实际生成。默认 false。",
          },
          force: {
            type: "boolean",
            description: "覆盖已存在的非骨架文件。默认 false。",
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
        const force = params.force ?? false;
        const results = [];

        const { runFillPerspective } = await import("../lib/fill-perspective.mjs");
        const { runExpandKl } = await import("../lib/expand-kl.mjs");
        const callAgent = buildCallAgent();

        // =================================================================
        // Determine work source: batch (crash recovery) > inbox > retry > mtime fallback
        // =================================================================
        let batchPath = findOutputBatchFile();
        let useBatch = false;
        let useMtimeFallback = false;

        if (batchPath) {
          useBatch = true;
          api.logger.info("[output_all] 检测到未完成 batch，执行崩溃恢复");
        } else {
          batchPath = rotateInboxToBatch();
          if (batchPath) {
            useBatch = true;
            api.logger.info("[output_all] inbox 已轮转为 batch");
          } else {
            batchPath = buildRetryBatch(registry);
            if (batchPath) {
              useBatch = true;
              api.logger.info("[output_all] 构建重试 batch");
            } else {
              useMtimeFallback = true;
            }
          }
        }

        // =================================================================
        // Batch-driven path: process items from batch with checkpoint
        // =================================================================
        if (useBatch) {
          const batch = loadOutputBatch(batchPath);
          if (!batch || !batch.items || batch.items.length === 0) {
            try { archiveOutputBatch(batchPath); } catch { /* best-effort */ }
            return textResult("Batch 为空，无需处理。");
          }

          for (const item of batch.items) {
            const idx = findBaseIndex(registry, item.baseDir);
            if (idx < 0) {
              results.push({ name: item.baseDir, binding: "(全部)", status: "error", message: "知识库未注册" });
              continue;
            }
            const base = registry.bases[idx];
            const cfgBindings = loadConfigBindings(base.baseDir);
            const allBindings = mergeBindings(base.outputBindings || [], cfgBindings);
            const binding = allBindings.find(
              (b) => b.perspectiveDir === item.perspectiveDir && b.template === item.template,
            );
            if (!binding || !binding.enabled) continue;

            if (!existsSync(join(base.baseDir, ".knowledgeprism.json"))) {
              results.push({ name: base.name, binding: "(全部)", status: "error", message: "路径无效或未初始化" });
              continue;
            }

            const paths = makePaths(base.baseDir);
            const perspPath = join(paths.structureDir, item.perspectiveDir);

            // --- Phase 1: Structure refresh (once per batch item, skip if already done or retry batch) ---
            const batchStrategy = binding.klStrategy || "synthesis";
            if (!item.structureRefreshed && batchStrategy !== "manual" && !dryRun) {
              if (existsSync(perspPath) && existsSync(paths.synthesisPath)) {
                const synthMtime = statSync(paths.synthesisPath).mtimeMs;
                const groupsMtime = getLatestMtime(paths.groupsDir);
                const analysisMtime = Math.max(synthMtime, groupsMtime);
                const lastRefreshMs = binding.lastStructureRefreshAt
                  ? new Date(binding.lastStructureRefreshAt).getTime()
                  : 0;

                if (analysisMtime > lastRefreshMs) {
                  const refreshEntry = { name: base.name, binding: `${item.perspectiveDir} [structure 刷新 ${batchStrategy}]` };
                  try {
                    const refreshResult = await refreshByStrategy({
                      strategy: batchStrategy,
                      baseDir: base.baseDir,
                      perspectiveDir: item.perspectiveDir,
                      paths, perspPath, callAgent,
                      logger: api.logger,
                      runFillPerspective, runExpandKl,
                    });
                    refreshEntry.status = refreshResult.status;
                    refreshEntry.message = refreshResult.message;
                    if (refreshResult.status === "refreshed") {
                      binding.lastStructureRefreshAt = new Date().toISOString();
                    }
                  } catch (err) {
                    refreshEntry.status = "error";
                    refreshEntry.message = `structure 刷新失败: ${err.message?.slice(0, 150)}`;
                  }
                  results.push(refreshEntry);
                }
              }
              item.structureRefreshed = true;
              try { saveOutputBatch(batchPath, batch); } catch { /* best-effort */ }
            }

            // --- Phase 2: KL-level output with checkpoint ---
            if (!existsSync(perspPath)) {
              results.push({ name: base.name, binding: `${item.perspectiveDir} + ${item.template}`, status: "error", message: "视角目录不存在" });
              continue;
            }
            const tpl = loadTemplate(item.template, base.baseDir);
            if (!tpl) {
              results.push({ name: base.name, binding: `${item.perspectiveDir} + ${item.template}`, status: "error", message: `模板不存在: ${item.template}` });
              continue;
            }

            if (item.kls.length === 0) {
              const treePath = join(perspPath, "tree", "README.md");
              if (existsSync(treePath)) {
                const treeContent = readFileSync(treePath, "utf-8");
                const keyLines = parseKeyLineTable(treeContent);
                item.kls = keyLines.map((kl) => ({ klId: kl.klId, status: "pending", retries: 0 }));
                try { saveOutputBatch(batchPath, batch); } catch { /* best-effort */ }
              }
            }

            const pendingKls = item.kls.filter((k) => k.status === "pending");
            if (pendingKls.length === 0) {
              results.push({ name: base.name, binding: `${item.perspectiveDir} + ${item.template}`, status: "skipped", message: "batch 中无待处理 KL" });
              continue;
            }

            if (dryRun) {
              results.push({ name: base.name, binding: `${item.perspectiveDir} + ${item.template}`, status: "dry-run", message: `${pendingKls.length} 个 KL 待生成` });
              continue;
            }

            const outputResult = await runOutput({
              baseDir: base.baseDir,
              perspectiveDir: item.perspectiveDir,
              template: item.template,
              mode: "generate",
              autoWrite: true,
              dryRun: false,
              force,
              klFilter: pendingKls.map((k) => k.klId),
              callAgent,
              log: (msg) => api.logger.info(`[${base.name}] ${msg}`),
              warn: (msg) => api.logger.warn(`[${base.name}] ${msg}`),
            });

            let genCount = 0;
            let errCount = 0;
            if (outputResult.results) {
              for (const r of outputResult.results) {
                const batchKl = item.kls.find((k) => k.klId === r.klId);
                if (!batchKl) continue;

                if (r.status === "generated" || r.status === "written" || r.status === "created") {
                  batchKl.status = "done";
                  batchKl.processedAt = new Date().toISOString();
                  genCount++;
                  const failedEntry = (binding.failedKLs || []).findIndex((f) => f.klId === r.klId);
                  if (failedEntry >= 0) binding.failedKLs.splice(failedEntry, 1);
                } else if (r.status === "error") {
                  const retries = (batchKl.retries || 0) + 1;
                  if (retries >= MAX_KL_RETRIES) {
                    batchKl.status = "permanently_failed";
                    batchKl.error = r.error || r.message;
                    if (!binding.failedKLs) binding.failedKLs = [];
                    const existingFailed = binding.failedKLs.find((f) => f.klId === r.klId);
                    if (existingFailed) {
                      existingFailed.retries = retries;
                      existingFailed.status = "permanently_failed";
                      existingFailed.lastError = r.error || r.message;
                      existingFailed.failedAt = new Date().toISOString();
                    } else {
                      binding.failedKLs.push({
                        klId: r.klId, retries, status: "permanently_failed",
                        lastError: r.error || r.message, failedAt: new Date().toISOString(),
                      });
                    }
                  } else {
                    batchKl.status = "retry";
                    batchKl.retries = retries;
                    batchKl.error = r.error || r.message;
                    if (!binding.failedKLs) binding.failedKLs = [];
                    const existingFailed = binding.failedKLs.find((f) => f.klId === r.klId);
                    if (existingFailed) {
                      existingFailed.retries = retries;
                      existingFailed.lastError = r.error || r.message;
                      existingFailed.failedAt = new Date().toISOString();
                    } else {
                      binding.failedKLs.push({
                        klId: r.klId, retries, status: "pending",
                        lastError: r.error || r.message, failedAt: new Date().toISOString(),
                      });
                    }
                  }
                  errCount++;
                } else if (r.status === "skipped") {
                  batchKl.status = "done";
                  batchKl.processedAt = new Date().toISOString();
                }
              }
            }

            try { saveOutputBatch(batchPath, batch); } catch { /* best-effort */ }

            if (genCount > 0) {
              binding.lastOutputAt = new Date().toISOString();
              binding.lastOutputSummary = `生成: ${genCount}` + (errCount ? `, 失败: ${errCount}` : "");
            }

            let rewriteCount = 0;
            const bindingRewrites = binding.rewrites || [];
            if (genCount > 0 && bindingRewrites.length > 0 && outputResult.results && !dryRun) {
              const generatedFiles = outputResult.results.filter((r) => r.status === "generated" && r.file);
              const paths = makePaths(base.baseDir);
              const outputDir = join(paths.outputsDir, item.template, item.perspectiveDir);
              for (const style of bindingRewrites) {
                for (const gf of generatedFiles) {
                  const inputPath = join(outputDir, gf.file);
                  if (!existsSync(inputPath)) continue;
                  try {
                    const rr = await runRewrite({
                      inputPath,
                      rewriteName: style,
                      baseDir: base.baseDir,
                      callAgent,
                      force,
                      log: (msg) => api.logger.info(`[${base.name}] ${msg}`),
                      warn: (msg) => api.logger.warn(`[${base.name}] ${msg}`),
                    });
                    if (rr.status === "rewritten") rewriteCount++;
                  } catch (e) {
                    api.logger.warn(`[${base.name}] 改写失败 (${gf.file}, ${style}): ${e.message}`);
                  }
                }
              }
              if (rewriteCount > 0) binding.lastRewriteAt = new Date().toISOString();
            }

            const entry = { name: base.name, binding: `${item.perspectiveDir} + ${item.template}` };
            if (genCount > 0 || errCount === 0) {
              entry.status = "generated";
              entry.message = `${outputResult.message || ""}` +
                (genCount ? ` (生成: ${genCount}` + (errCount ? `, 失败: ${errCount})` : ")") : "") +
                (rewriteCount > 0 ? `, 改写: ${rewriteCount}` : "");
            } else {
              entry.status = "error";
              entry.message = `全部失败 (${errCount} 个)`;
            }
            results.push(entry);

            // Persist runtime state for config-sourced binding into registry
            if (binding.source === "config") {
              if (!base.outputBindings) base.outputBindings = [];
              const regBinding = base.outputBindings.find(
                (rb) => rb.perspectiveDir === binding.perspectiveDir && rb.template === binding.template,
              );
              if (regBinding) {
                if (binding.lastOutputAt) regBinding.lastOutputAt = binding.lastOutputAt;
                if (binding.lastOutputSummary) regBinding.lastOutputSummary = binding.lastOutputSummary;
                if (binding.lastStructureRefreshAt) regBinding.lastStructureRefreshAt = binding.lastStructureRefreshAt;
                if (binding.failedKLs) regBinding.failedKLs = binding.failedKLs;
              } else {
                base.outputBindings.push({
                  perspectiveDir: binding.perspectiveDir,
                  template: binding.template,
                  klStrategy: binding.klStrategy,
                  enabled: binding.enabled,
                  source: "config",
                  lastStructureRefreshAt: binding.lastStructureRefreshAt,
                  lastOutputAt: binding.lastOutputAt,
                  lastOutputSummary: binding.lastOutputSummary,
                  failedKLs: binding.failedKLs || null,
                });
              }
            }
          }

          if (!dryRun) {
            try { archiveOutputBatch(batchPath); } catch { /* best-effort */ }
            try { saveRegistry(registry); } catch { /* best-effort */ }
          }

          if (results.length === 0) {
            return textResult("Batch 中无可处理的产出绑定。");
          }

          const lines = [`自动产出完毕 — batch 模式（${results.length} 项）`, ""];
          for (const r of results) {
            const icon =
              r.status === "generated" ? "✓" :
              r.status === "refreshed" ? "↻" :
              r.status === "skipped" ? "—" :
              r.status === "dry-run" ? "👁" :
              "✗";
            lines.push(`${icon} ${r.name} | ${r.binding}`);
            lines.push(`  ${r.message}`);
            lines.push("");
          }
          return textResult(lines.join("\n"));
        }

        // =================================================================
        // Mtime fallback path (manual trigger or no inbox/retry work)
        // =================================================================
        for (const base of enabledBases) {
          const configBindings = loadConfigBindings(base.baseDir);
          const bindings = mergeBindings(
            (base.outputBindings || []),
            configBindings,
          ).filter((b) => b.enabled);
          if (bindings.length === 0) continue;

          if (!existsSync(join(base.baseDir, ".knowledgeprism.json"))) {
            results.push({ name: base.name, binding: "(全部)", status: "error", message: "路径无效或未初始化" });
            continue;
          }

          const paths = makePaths(base.baseDir);
          const refreshedPerspectives = new Set();

          for (const binding of bindings) {
            const mtimeStrategy = binding.klStrategy || "synthesis";
            if (mtimeStrategy === "manual") continue;
            if (refreshedPerspectives.has(binding.perspectiveDir)) continue;

            const perspPath = join(paths.structureDir, binding.perspectiveDir);
            if (!existsSync(perspPath)) continue;

            if (!existsSync(paths.synthesisPath)) {
              results.push({ name: base.name, binding: `${binding.perspectiveDir} [structure 刷新]`, status: "skipped", message: "synthesis.md 不存在" });
              refreshedPerspectives.add(binding.perspectiveDir);
              continue;
            }

            const synthMtime = statSync(paths.synthesisPath).mtimeMs;
            const groupsMtime = getLatestMtime(paths.groupsDir);
            const analysisMtime = Math.max(synthMtime, groupsMtime);
            const lastRefreshMs = binding.lastStructureRefreshAt
              ? new Date(binding.lastStructureRefreshAt).getTime()
              : 0;

            if (analysisMtime <= lastRefreshMs) {
              results.push({ name: base.name, binding: `${binding.perspectiveDir} [structure 刷新]`, status: "skipped", message: "synthesis/groups 无变化" });
              refreshedPerspectives.add(binding.perspectiveDir);
              continue;
            }

            if (dryRun) {
              results.push({ name: base.name, binding: `${binding.perspectiveDir} [structure 刷新 ${mtimeStrategy}]`, status: "dry-run", message: "检测到变化，待刷新" });
              refreshedPerspectives.add(binding.perspectiveDir);
              continue;
            }

            const refreshEntry = { name: base.name, binding: `${binding.perspectiveDir} [structure 刷新 ${mtimeStrategy}]` };
            try {
              const refreshResult = await refreshByStrategy({
                strategy: mtimeStrategy,
                baseDir: base.baseDir,
                perspectiveDir: binding.perspectiveDir,
                paths, perspPath, callAgent,
                logger: api.logger,
                runFillPerspective, runExpandKl,
              });
              refreshEntry.status = refreshResult.status;
              refreshEntry.message = refreshResult.message;
              if (refreshResult.status === "refreshed") {
                const nowIso = new Date().toISOString();
                for (const b of bindings) {
                  if (b.perspectiveDir === binding.perspectiveDir) b.lastStructureRefreshAt = nowIso;
                }
              }
            } catch (err) {
              refreshEntry.status = "error";
              refreshEntry.message = `structure 刷新失败: ${err.message?.slice(0, 150)}`;
            }
            results.push(refreshEntry);
            refreshedPerspectives.add(binding.perspectiveDir);
          }

          for (const binding of bindings) {
            const entry = { name: base.name, binding: `${binding.perspectiveDir} + ${binding.template}` };
            const perspPath = join(paths.structureDir, binding.perspectiveDir);

            if (!existsSync(perspPath)) {
              entry.status = "error";
              entry.message = `视角目录不存在: ${binding.perspectiveDir}`;
              results.push(entry);
              continue;
            }

            const tpl = loadTemplate(binding.template, base.baseDir);
            if (!tpl) {
              entry.status = "error";
              entry.message = `模板不存在: ${binding.template}`;
              results.push(entry);
              continue;
            }

            const latestMtime = getLatestMtime(perspPath);
            const lastOutputMs = binding.lastOutputAt
              ? new Date(binding.lastOutputAt).getTime()
              : 0;

            const hasFailedKLs = (binding.failedKLs || []).some(
              (f) => f.retries < MAX_KL_RETRIES && f.status !== "permanently_failed",
            );

            if (latestMtime <= lastOutputMs && !hasFailedKLs) {
              entry.status = "skipped";
              entry.message = "structure 无变化";
              results.push(entry);
              continue;
            }

            if (dryRun) {
              entry.status = "dry-run";
              entry.message = hasFailedKLs ? "有失败 KL 待重试" : "检测到 structure 变化，待生成";
              results.push(entry);
              continue;
            }

            const klFilter = hasFailedKLs && latestMtime <= lastOutputMs
              ? (binding.failedKLs || [])
                  .filter((f) => f.retries < MAX_KL_RETRIES && f.status !== "permanently_failed")
                  .map((f) => f.klId)
              : undefined;

            try {
              const result = await runOutput({
                baseDir: base.baseDir,
                perspectiveDir: binding.perspectiveDir,
                template: binding.template,
                mode: "generate",
                autoWrite: true,
                dryRun: false,
                force,
                klFilter,
                callAgent,
                log: (msg) => api.logger.info(`[${base.name}] ${msg}`),
                warn: (msg) => api.logger.warn(`[${base.name}] ${msg}`),
              });

              if (result.success) {
                let genCount = 0;
                let errCount = 0;
                if (result.results) {
                  for (const r of result.results) {
                    if (r.status === "generated" || r.status === "written" || r.status === "created") {
                      genCount++;
                      if (binding.failedKLs) {
                        const fi = binding.failedKLs.findIndex((f) => f.klId === r.klId);
                        if (fi >= 0) binding.failedKLs.splice(fi, 1);
                      }
                    } else if (r.status === "error") {
                      errCount++;
                      if (!binding.failedKLs) binding.failedKLs = [];
                      const existing = binding.failedKLs.find((f) => f.klId === r.klId);
                      const retries = existing ? existing.retries + 1 : 1;
                      if (existing) {
                        existing.retries = retries;
                        existing.status = retries >= MAX_KL_RETRIES ? "permanently_failed" : "pending";
                        existing.lastError = r.error || r.message;
                        existing.failedAt = new Date().toISOString();
                      } else {
                        binding.failedKLs.push({
                          klId: r.klId, retries,
                          status: retries >= MAX_KL_RETRIES ? "permanently_failed" : "pending",
                          lastError: r.error || r.message, failedAt: new Date().toISOString(),
                        });
                      }
                    }
                  }
                }
                let rewriteCount = 0;
                const bindingRewrites = binding.rewrites || [];
                if (genCount > 0 && bindingRewrites.length > 0 && result.results) {
                  const generatedFiles = result.results.filter((r) => r.status === "generated" && r.file);
                  const paths = makePaths(base.baseDir);
                  const outputDir = join(paths.outputsDir, binding.template, binding.perspectiveDir);
                  for (const style of bindingRewrites) {
                    for (const gf of generatedFiles) {
                      const inputPath = join(outputDir, gf.file);
                      if (!existsSync(inputPath)) continue;
                      try {
                        const rr = await runRewrite({
                          inputPath,
                          rewriteName: style,
                          baseDir: base.baseDir,
                          callAgent,
                          force,
                          log: (msg) => api.logger.info(`[${base.name}] ${msg}`),
                          warn: (msg) => api.logger.warn(`[${base.name}] ${msg}`),
                        });
                        if (rr.status === "rewritten") rewriteCount++;
                      } catch (e) {
                        api.logger.warn(`[${base.name}] 改写失败 (${gf.file}, ${style}): ${e.message}`);
                      }
                    }
                  }
                  if (rewriteCount > 0) binding.lastRewriteAt = new Date().toISOString();
                }

                entry.status = "generated";
                entry.message =
                  `${result.message}` +
                  (genCount ? ` (生成: ${genCount}` + (errCount ? `, 失败: ${errCount})` : ")") : "") +
                  (rewriteCount > 0 ? `, 改写: ${rewriteCount}` : "");
                binding.lastOutputAt = new Date().toISOString();
                binding.lastOutputSummary = entry.message;
              } else {
                entry.status = "error";
                entry.message = result.message || "生成失败";
              }
            } catch (err) {
              entry.status = "error";
              entry.message = err.message?.slice(0, 200);
            }

            results.push(entry);
          }

          // Persist runtime state for config-sourced bindings into registry
          for (const b of bindings) {
            if (b.source !== "config") continue;
            if (!base.outputBindings) base.outputBindings = [];
            const existing = base.outputBindings.find(
              (rb) => rb.perspectiveDir === b.perspectiveDir && rb.template === b.template,
            );
            if (existing) {
              if (b.lastOutputAt) existing.lastOutputAt = b.lastOutputAt;
              if (b.lastOutputSummary) existing.lastOutputSummary = b.lastOutputSummary;
              if (b.lastStructureRefreshAt) existing.lastStructureRefreshAt = b.lastStructureRefreshAt;
              if (b.failedKLs) existing.failedKLs = b.failedKLs;
            } else {
              base.outputBindings.push({
                perspectiveDir: b.perspectiveDir,
                template: b.template,
                klStrategy: b.klStrategy,
                enabled: b.enabled,
                source: "config",
                lastStructureRefreshAt: b.lastStructureRefreshAt,
                lastOutputAt: b.lastOutputAt,
                lastOutputSummary: b.lastOutputSummary,
                failedKLs: b.failedKLs || null,
              });
            }
          }
        }

        if (!dryRun) {
          try { saveRegistry(registry); } catch { /* best-effort */ }
        }

        if (results.length === 0) {
          return textResult("所有已注册知识库均无启用的产出绑定。使用 knowledge_prism_bind_output 添加绑定，或在 .knowledgeprism.json 的 output.bindings 中声明。");
        }

        const lines = [`自动产出完毕 — mtime 模式（${results.length} 项）`, ""];
        for (const r of results) {
          const icon =
            r.status === "generated" ? "✓" :
            r.status === "refreshed" ? "↻" :
            r.status === "skipped" ? "—" :
            r.status === "dry-run" ? "👁" :
            "✗";
          lines.push(`${icon} ${r.name} | ${r.binding}`);
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
            description: "要安装的技能 ID",
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

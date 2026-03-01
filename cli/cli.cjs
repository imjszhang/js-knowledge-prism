#!/usr/bin/env node

/**
 * Knowledge Prism Dev CLI
 *
 * Usage:
 *   node cli/cli.cjs <command> [options]
 *
 * Commands:
 *   build [skill|skills|all]   Build targets (default: all)
 *   bump <version>             Sync version across manifests
 *   commit [--message "..."]   Git add + commit
 *   sync [--no-build] [--no-push]  Build + commit + push
 *   release [--draft]          Create GitHub release (requires gh CLI)
 *   --help, -h                 Show help
 */

const { buildSkillZip, buildSubSkillZips, buildSkillsRegistry, bump, getVersion } = require("./lib/builder.cjs");
const { gitStatus, gitAddAll, gitCommit, gitPush, gitDiffStat, gitTag, gitTagExists, generateCommitMessage, ghRelease, ghAvailable } = require("./lib/git.cjs");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const raw = argv.slice(2);
  const command = raw[0] || "";
  const sub = raw[1] || "";
  const flags = {};
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].startsWith("--")) {
      const key = raw[i].slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, sub, flags };
}

function log(msg) {
  console.error(msg);
}

// -- Build --------------------------------------------------------------------

async function cmdBuild(sub) {
  const version = getVersion();
  const target = sub || "all";

  console.log("");
  console.log("========================================");
  console.log(`   Knowledge Prism Builder v${version}`);
  console.log("========================================");
  console.log("");

  switch (target) {
    case "skill":
      await buildSkillZip();
      break;
    case "skills":
      await buildSubSkillZips();
      await buildSkillsRegistry();
      break;
    case "all":
      console.log("[1/3] Main skill bundle");
      await buildSkillZip();
      console.log("");
      console.log("[2/3] Sub-skill bundles");
      await buildSubSkillZips();
      console.log("");
      console.log("[3/3] Skills registry");
      await buildSkillsRegistry();
      console.log("");
      console.log("========================================");
      console.log("   All builds complete.");
      console.log("========================================");
      break;
    default:
      console.error(`  ✗ 未知构建目标: ${target}`);
      console.log("  可选: skill | skills | all");
      process.exit(1);
  }
}

// -- Commit -------------------------------------------------------------------

function cmdCommit(flags) {
  try {
    const status = gitStatus();
    if (status.clean) {
      log("  工作区干净，无需提交。");
      return;
    }

    log("  暂存所有变更...");
    gitAddAll();

    const { files } = gitDiffStat();
    if (files.length === 0) {
      log("  暂存区为空。");
      return;
    }

    const message =
      flags.message || flags.m || generateCommitMessage(files);
    log(`  提交: ${message}`);
    const { hash } = gitCommit(message);

    log(`  ✓ 已提交 ${hash}`);
    log(`    分支: ${status.branch}`);
    log(`    文件: ${files.length}`);
  } catch (err) {
    log(`  ✗ ${err.message}`);
    process.exit(1);
  }
}

// -- Sync ---------------------------------------------------------------------

async function cmdSync(flags) {
  try {
    const noBuild = !!flags["no-build"];
    const noPush = !!flags["no-push"];

    const status = gitStatus();
    log(`  分支: ${status.branch}`);

    if (!noBuild) {
      log("");
      log("  ── 构建 ──");
      await buildSkillZip();
    } else {
      log("  跳过构建。");
    }

    log("");
    log("  ── 暂存 ──");
    gitAddAll();

    const { files } = gitDiffStat();
    if (files.length === 0) {
      log("  构建后无变更，跳过提交。");
      return;
    }

    const message =
      flags.message || flags.m || generateCommitMessage(files);
    log("");
    log("  ── 提交 ──");
    log(`  信息: ${message}`);
    const { hash } = gitCommit(message);
    log(`  ✓ 已提交 ${hash} (${files.length} files)`);

    if (!noPush) {
      log("");
      log("  ── 推送 ──");
      log(`  推送到 origin/${status.branch} ...`);
      gitPush("origin", status.branch);
      log("  ✓ 推送完成。");
    } else {
      log("  跳过推送。");
    }
  } catch (err) {
    log(`  ✗ ${err.message}`);
    process.exit(1);
  }
}

// -- Release ------------------------------------------------------------------

function cmdRelease(flags) {
  try {
    if (!ghAvailable()) {
      log("  ✗ 需要 gh CLI。安装: https://cli.github.com/");
      process.exit(1);
    }

    const version = getVersion();
    const tag = `v${version}`;
    const draft = !!flags.draft;

    if (gitTagExists(tag)) {
      log(`  ⚠ 标签 ${tag} 已存在。`);
    }

    log(`  创建 Release ${tag} ...`);

    const DIST = path.join(__dirname, "..", "dist");
    const assets = [];
    if (fs.existsSync(DIST)) {
      const distFiles = fs
        .readdirSync(DIST)
        .filter((f) => f.endsWith(".zip"));
      for (const f of distFiles) {
        assets.push(path.join(DIST, f));
      }
    }

    if (assets.length > 0) {
      log("  附件:");
      assets.forEach((a) => log(`    - ${path.basename(a)}`));
    }

    const title = `Knowledge Prism ${tag}`;
    const notes = `Release ${tag}`;
    const { url } = ghRelease(tag, title, notes, assets);

    log(`  ✓ Release 创建成功`);
    log(`  URL: ${url}`);
  } catch (err) {
    log(`  ✗ ${err.message}`);
    process.exit(1);
  }
}

// -- Help ---------------------------------------------------------------------

function showHelp() {
  console.log("Knowledge Prism Dev CLI");
  console.log("");
  console.log("用法: node cli/cli.js <command> [options]");
  console.log("");
  console.log("命令:");
  console.log("  build [skill|skills|all]   构建目标（默认: all）");
  console.log("  bump <version>             同步版本号到所有 manifest");
  console.log("  commit [--message '...']   git add -A + commit");
  console.log("  sync [--no-build] [--no-push]  构建 + 提交 + 推送");
  console.log("  release [--draft]          创建 GitHub Release（需要 gh CLI）");
  console.log("");
  console.log("选项:");
  console.log("  --message, -m   自定义提交信息");
  console.log("  --no-build      sync 时跳过构建");
  console.log("  --no-push       sync 时跳过推送");
  console.log("  --draft         创建草稿 Release");
  console.log("  --help, -h      显示帮助");
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const { command, sub, flags } = parseArgs(process.argv);

  switch (command) {
    case "build":
      await cmdBuild(sub, flags);
      break;
    case "bump":
      bump(sub);
      break;
    case "commit":
      cmdCommit(flags);
      break;
    case "sync":
      await cmdSync(flags);
      break;
    case "release":
      cmdRelease(flags);
      break;
    case "--help":
    case "-h":
    case "help":
      showHelp();
      break;
    default:
      if (command) {
        console.error(`未知命令: ${command}\n`);
      }
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});

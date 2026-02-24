#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const HELP = `
js-knowledge-prism v${pkg.version}
基于金字塔原理的三层知识蒸馏工具包

用法: js-knowledge-prism <command> [options]

命令:
  init <dir>              在目标目录初始化知识棱镜骨架
  process                 金字塔增量处理（atoms → groups → synthesis）
  status                  查看待处理状态
  new-perspective <slug>  从模板创建新视角

全局选项:
  -h, --help              显示帮助
  -v, --version           显示版本号

示例:
  npx js-knowledge-prism init docs/knowledge --name "我的知识库"
  npx js-knowledge-prism process --dry-run
  npx js-knowledge-prism status
  npx js-knowledge-prism new-perspective blog-post
`.trim();

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

const commandArgs = args.slice(1);

try {
  switch (command) {
    case "init": {
      const { run } = await import("../lib/init.mjs");
      await run(commandArgs);
      break;
    }
    case "process": {
      const { run } = await import("../lib/process.mjs");
      await run(commandArgs);
      break;
    }
    case "status": {
      const { run } = await import("../lib/status.mjs");
      await run(commandArgs);
      break;
    }
    case "new-perspective": {
      const { run } = await import("../lib/new-perspective.mjs");
      await run(commandArgs);
      break;
    }
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(`致命错误: ${err.message}`);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
}

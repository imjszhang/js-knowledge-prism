#!/usr/bin/env node
/**
 * 基于 analysis 生成新视角的完整流程
 * 用法: node scripts/generate-perspective.mjs <baseDir> <slug> [name]
 * 环境变量: LOCAL_LAN_BASE_URL, LOCAL_LAN_MODEL, LOCAL_LAN_API_KEY（或 KNOWLEDGE_PRISM_API_*）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const baseDir = process.argv[2] || process.cwd();
const slug = process.argv[3] || "deployment-guide";
const name = process.argv[4] || slug;

loadDotEnv(join(__dirname, "..", ".env"));
loadDotEnv(join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw", ".env"));
loadDotEnv(join(baseDir, ".env"));

import { createHttpCaller } from "../lib/process.mjs";
import { runWithBaseDir } from "../lib/new-perspective.mjs";
import { runFillPerspective } from "../lib/fill-perspective.mjs";
import { runExpandKl } from "../lib/expand-kl.mjs";

// API 配置：优先环境变量
const apiConfig = {
  baseUrl: process.env.LOCAL_LAN_BASE_URL || process.env.KNOWLEDGE_PRISM_API_BASE_URL || "http://localhost:8888/v1",
  model: process.env.LOCAL_LAN_MODEL || process.env.KNOWLEDGE_PRISM_API_MODEL || "default",
  apiKey: process.env.LOCAL_LAN_API_KEY || process.env.KNOWLEDGE_PRISM_API_KEY || "not-needed",
  timeoutMs: 120_000,
};

const callAgent = createHttpCaller({
  ...apiConfig,
  log: (msg) => console.log("[LLM]", msg),
});

function checkApiConfig() {
  const base = apiConfig.baseUrl;
  const hasCustom = process.env.LOCAL_LAN_BASE_URL || process.env.KNOWLEDGE_PRISM_API_BASE_URL;
  if (!hasCustom && (base.includes("localhost") || base.includes("127.0.0.1"))) {
    console.warn(
      "[提示] 使用默认 localhost。若 LLM 不可用，请配置环境变量：\n" +
        "  LOCAL_LAN_BASE_URL  LOCAL_LAN_MODEL  LOCAL_LAN_API_KEY\n" +
        "或在 baseDir/.env、~/.openclaw/.env 中设置。"
    );
  }
}

async function main() {
  checkApiConfig();
  let perspectiveDir;
  const structureDir = join(baseDir, "pyramid", "structure");

  // 优先使用已有相同 slug 的视角
  const existing = readdirSync(structureDir).find(
    (d) => d.startsWith("P") && d.endsWith(`-${slug}`)
  );
  if (existing) {
    perspectiveDir = existing;
    console.log("1. 使用已有视角:", perspectiveDir);
  } else {
    console.log("1. 创建视角骨架...");
    const r1 = runWithBaseDir({ baseDir, slug, name });
    if (r1.error) {
      console.error("错误:", r1.error);
      process.exit(1);
    }
    perspectiveDir = r1.dirName;
    console.log("   已创建:", perspectiveDir);
  }

  console.log("\n2. 填充 SCQA...");
  const r2 = await runFillPerspective({
    baseDir,
    perspectiveDir,
    stage: "scqa",
    autoWrite: true,
    callAgent,
  });
  if (!r2.success) {
    console.error("错误:", r2.message);
    process.exit(1);
  }
  console.log("   ", r2.message);

  console.log("\n3. 填充 Key Line 表格...");
  const r3 = await runFillPerspective({
    baseDir,
    perspectiveDir,
    stage: "keyline",
    autoWrite: true,
    callAgent,
  });
  if (!r3.success) {
    console.error("错误:", r3.message);
    process.exit(1);
  }
  console.log("   ", r3.message);

  // 解析第一个 Key Line 用于 expand
  const treePath = join(baseDir, "pyramid", "structure", perspectiveDir, "tree", "README.md");
  const tree = readFileSync(treePath, "utf-8");
  const klMatch = tree.match(/\|\s*(KL\d+)\s*\|/);
  const firstKl = klMatch ? klMatch[1] : "KL01";

  console.log(`\n4. 展开 ${firstKl}...`);
  const r4 = await runExpandKl({
    baseDir,
    perspectiveDir,
    klId: firstKl,
    autoWrite: true,
    callAgent,
  });
  if (!r4.success) {
    console.error("错误:", r4.message);
  } else {
    console.log("   ", r4.message);
  }

  console.log("\n完成。视角:", perspectiveDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

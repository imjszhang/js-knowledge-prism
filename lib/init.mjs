import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

const HELP = `
用法: js-knowledge-prism init <dir> [选项]

在目标目录初始化知识棱镜骨架。

选项:
  --name <name>    知识库名称（默认使用目录名）
  -h, --help       显示帮助
`.trim();

function replacePlaceholders(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/**
 * Recursively copy templates dir to target, processing .tpl files.
 * .tpl files get placeholder replacement and have their .tpl suffix removed.
 */
function copyTemplates(srcDir, destDir, vars) {
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyTemplates(srcPath, join(destDir, entry), vars);
    } else if (entry.endsWith(".tpl")) {
      const content = readFileSync(srcPath, "utf-8");
      const processed = replacePlaceholders(content, vars);
      const destName = entry.slice(0, -4); // remove .tpl
      writeFileSync(join(destDir, destName), processed, "utf-8");
    } else {
      const content = readFileSync(srcPath, "utf-8");
      writeFileSync(join(destDir, entry), content, "utf-8");
    }
  }
}

export async function run(args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const targetArg = positionals[0];
  if (!targetArg) {
    console.error("错误: 请指定目标目录\n");
    console.log(HELP);
    process.exit(1);
  }

  const targetDir = resolve(targetArg);
  const configPath = join(targetDir, CONFIG_FILENAME);

  if (existsSync(configPath)) {
    console.error(`错误: ${targetDir} 已包含 ${CONFIG_FILENAME}，请勿重复初始化。`);
    process.exit(1);
  }

  const name = flags.name || basename(targetDir);
  const date = new Date().toISOString().slice(0, 10);

  console.log(`\n初始化知识棱镜: ${name}`);
  console.log(`目标目录: ${targetDir}\n`);

  const vars = { name, date };

  // Create journal directory (empty, ready for use)
  mkdirSync(join(targetDir, "journal"), { recursive: true });

  // Copy and process all templates
  copyTemplates(TEMPLATES_DIR, targetDir, vars);

  // Write config file
  const config = {
    name,
    api: {
      baseUrl: "http://localhost:8888/v1",
      model: "unsloth/Qwen3.5-397B-A17B",
      apiKey: "",
    },
    process: {
      batchSize: 5,
      temperature: 0.3,
      maxTokens: 8192,
      timeoutMs: 1800000,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  console.log("✓ 目录骨架已生成");
  console.log(`✓ 配置文件已写入 ${CONFIG_FILENAME}`);
  console.log(`
下一步:
  1. 编辑 ${CONFIG_FILENAME} 配置 API 地址和模型
  2. 在 journal/YYYY-MM-DD/ 下创建你的第一篇笔记
  3. 运行 npx js-knowledge-prism process 开始增量处理
`);
}

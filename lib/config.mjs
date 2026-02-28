import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CONFIG_FILENAME = ".knowledgeprism.json";

/** Walk up from startDir to filesystem root looking for CONFIG_FILENAME. */
export function findConfigPath(startDir = process.cwd()) {
  let dir = resolve(startDir);
  const { root } = new URL("file:///" + dir.replace(/\\/g, "/"));
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Load and parse .env file (simple KEY=VALUE lines). */
function loadDotEnv(envPath) {
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
 * Resolve the full config: file -> env overrides -> defaults.
 * Returns { baseDir, config } where baseDir is the directory containing
 * .knowledgeprism.json (the knowledge prism root).
 */
export function loadConfig(startDir) {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    throw new Error(
      `未找到 ${CONFIG_FILENAME}。请先运行 js-knowledge-prism init <dir> 初始化。`,
    );
  }

  const baseDir = dirname(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  loadDotEnv(join(baseDir, ".env"));

  const config = {
    name: raw.name || "Knowledge Prism",
    api: {
      baseUrl:
        process.env.KNOWLEDGE_PRISM_API_BASE_URL ||
        raw.api?.baseUrl ||
        "http://localhost:8888/v1",
      model:
        process.env.KNOWLEDGE_PRISM_API_MODEL ||
        raw.api?.model ||
        "unsloth/Qwen3.5-397B-A17B",
      apiKey:
        process.env.KNOWLEDGE_PRISM_API_KEY ||
        raw.api?.apiKey ||
        "not-needed",
    },
    process: {
      batchSize: raw.process?.batchSize ?? 5,
      temperature: raw.process?.temperature ?? 0.3,
      maxTokens: raw.process?.maxTokens ?? 8192,
      timeoutMs: raw.process?.timeoutMs ?? 1_800_000,
    },
  };

  return { baseDir, config };
}

export { CONFIG_FILENAME };

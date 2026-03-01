/**
 * Knowledge Prism Builder
 *
 * Skill build:  package openclaw-plugin/ + lib/ + templates/ into ZIP
 * Bump:         sync version across package.json + openclaw.plugin.json + SKILL.md
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const PKG_PATH = path.join(PROJECT_ROOT, "package.json");
const PLUGIN_JSON = path.join(
  PROJECT_ROOT,
  "openclaw-plugin",
  "openclaw.plugin.json",
);
const SKILL_MD = path.join(PROJECT_ROOT, "SKILL.md");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

const SKILL_BUNDLE_FILES = ["SKILL.md", "SECURITY.md", "package.json", "LICENSE"];
const SKILL_BUNDLE_DIRS = ["openclaw-plugin", "lib", "templates"];
const SKILL_ZIP_NAME = "js-knowledge-prism-skill.zip";

const SUB_SKILL_EXCLUDE = [
  "node_modules/**",
  "**/node_modules/**",
  "work_dir/**",
  "**/work_dir/**",
  "package-lock.json",
  ".git/**",
  "**/.git/**",
  "**/.DS_Store",
  "**/Thumbs.db",
];

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// -- YAML frontmatter parser (minimal, for SKILL.md) --------------------------

function parseSkillFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1].split(/\r?\n/);
  const root = {};
  const stack = [{ obj: root, indent: -1 }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const indent = raw.search(/\S/);
    const trimmed = raw.trim();

    while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith("- ")) {
      const val = parseYamlValue(trimmed.slice(2).trim());
      if (Array.isArray(parent)) parent.push(val);
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valPart = trimmed.slice(colonIdx + 1).trim();

    if (valPart === "") {
      let nextLine = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextLine = lines[j];
          break;
        }
      }
      const nextTrimmed = nextLine.trim();
      const nextIndent = nextLine.search(/\S/);
      if (nextTrimmed.startsWith("- ")) {
        parent[key] = [];
        stack.push({
          obj: parent[key],
          indent: nextIndent >= 0 ? nextIndent : indent + 2,
        });
      } else {
        parent[key] = {};
        stack.push({
          obj: parent[key],
          indent: nextIndent >= 0 ? nextIndent : indent + 2,
        });
      }
    } else {
      parent[key] = parseYamlValue(valPart);
    }
  }
  return root;
}

function parseYamlValue(str) {
  if (str === "true") return true;
  if (str === "false") return false;
  if (str === "null") return null;
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str);

  let val = str;
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  val = val.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  val = val.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  return val;
}

// -- Sub-skill discovery ------------------------------------------------------

function discoverSubSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;

    const meta = parseSkillFrontmatter(skillMd);
    if (!meta || !meta.name) continue;

    const pluginJson = path.join(
      skillDir,
      "openclaw-plugin",
      "openclaw.plugin.json",
    );
    let pluginMeta = null;
    if (fs.existsSync(pluginJson)) {
      try {
        pluginMeta = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
      } catch {}
    }

    const pluginEntry = path.join(skillDir, "openclaw-plugin", "index.mjs");
    const tools = [];
    if (fs.existsSync(pluginEntry)) {
      const src = fs.readFileSync(pluginEntry, "utf8");
      const re = /name:\s*["']([a-z_]+)["']/g;
      let m;
      while ((m = re.exec(src)) !== null) tools.push(m[1]);
    }

    const oc = (meta.metadata && meta.metadata.openclaw) || {};
    skills.push({
      id: meta.name,
      dir: skillDir,
      dirName: entry.name,
      name: (pluginMeta && pluginMeta.name) || meta.name,
      description: meta.description || "",
      version: meta.version || "1.0.0",
      emoji: oc.emoji || "",
      homepage: oc.homepage || "",
      requires: oc.requires || {},
      tools,
    });
  }
  return skills;
}

// -- Build: main skill zip ----------------------------------------------------

async function buildSkillZip() {
  const archiver = require("archiver");

  ensureDir(DIST_DIR);
  const outputFile = path.join(DIST_DIR, SKILL_ZIP_NAME);

  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  const output = fs.createWriteStream(outputFile);
  const archive = archiver("zip", { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    for (const file of SKILL_BUNDLE_FILES) {
      const src = path.join(PROJECT_ROOT, file);
      if (fs.existsSync(src)) archive.file(src, { name: file });
    }
    for (const dir of SKILL_BUNDLE_DIRS) {
      const src = path.join(PROJECT_ROOT, dir);
      if (fs.existsSync(src)) archive.directory(src, dir);
    }

    archive.finalize();
  });

  const stats = fs.statSync(outputFile);
  console.log(
    `  ✓ Skill bundle: ${SKILL_ZIP_NAME} (${formatSize(stats.size)})`,
  );
}

// -- Build: sub-skill zips ----------------------------------------------------

async function buildSubSkillZips() {
  const skills = discoverSubSkills();
  if (skills.length === 0) return;

  const archiver = require("archiver");

  for (const skill of skills) {
    const outDir = path.join(DIST_DIR, "skills", skill.dirName);
    ensureDir(outDir);

    const zipName = `${skill.id}-skill.zip`;
    const outputFile = path.join(outDir, zipName);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

    const output = fs.createWriteStream(outputFile);
    const archive = archiver("zip", { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.glob("**/*", {
        cwd: skill.dir,
        dot: false,
        ignore: SUB_SKILL_EXCLUDE,
      });
      archive.finalize();
    });

    const stats = fs.statSync(outputFile);
    console.log(
      `  ✓ Sub-skill bundle: skills/${skill.dirName}/${zipName} (${formatSize(stats.size)})`,
    );
  }
}

// -- Build: skills registry ---------------------------------------------------

async function buildSkillsRegistry(siteUrl) {
  const skills = discoverSubSkills();
  const version = getVersion();

  const baseUrl = siteUrl || "https://github.com/user/js-knowledge-prism";

  const registry = {
    version: 1,
    generated: new Date().toISOString(),
    baseUrl,
    parentSkill: { id: "js-knowledge-prism", version },
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      emoji: s.emoji,
      requires: s.requires,
      downloadUrl: `${baseUrl}/dist/skills/${s.dirName}/${s.id}-skill.zip`,
      homepage: s.homepage,
      tools: s.tools,
    })),
  };

  ensureDir(DIST_DIR);
  const outputFile = path.join(DIST_DIR, "skills.json");
  fs.writeFileSync(
    outputFile,
    JSON.stringify(registry, null, 2) + "\n",
    "utf8",
  );
  console.log(
    `  ✓ Skills registry: skills.json (${skills.length} skill(s))`,
  );
}

// -- Bump ---------------------------------------------------------------------

function bump(newVersion) {
  if (!newVersion) {
    console.error("  ✗ 请指定版本号");
    console.log("  用法: node cli/cli.js bump <version>");
    console.log("  示例: node cli/cli.js bump 1.2.0");
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error(`  ✗ 版本号格式错误: ${newVersion}`);
    console.log("  格式: major.minor.patch (如 1.2.0)");
    process.exit(1);
  }

  const current = getVersion();
  console.log("");
  console.log("  ── 版本同步 ──");
  console.log("");
  console.log(`  当前版本: ${current}`);
  console.log(`  新版本:   ${newVersion}`);
  console.log("");

  // package.json
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const oldPkg = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(
    `  ✓ package.json: ${oldPkg} → ${newVersion}`,
  );

  // openclaw.plugin.json
  if (fs.existsSync(PLUGIN_JSON)) {
    const pluginCfg = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8"));
    const oldPlugin = pluginCfg.version;
    pluginCfg.version = newVersion;
    fs.writeFileSync(
      PLUGIN_JSON,
      JSON.stringify(pluginCfg, null, 2) + "\n",
      "utf8",
    );
    console.log(
      `  ✓ openclaw.plugin.json: ${oldPlugin} → ${newVersion}`,
    );
  }

  // SKILL.md frontmatter
  if (fs.existsSync(SKILL_MD)) {
    let content = fs.readFileSync(SKILL_MD, "utf8");
    const replaced = content.replace(
      /^(version:\s*).+$/m,
      `$1${newVersion}`,
    );
    if (replaced !== content) {
      fs.writeFileSync(SKILL_MD, replaced, "utf8");
      console.log(`  ✓ SKILL.md: → ${newVersion}`);
    }
  }

  console.log("");
  console.log("  版本同步完成。");
}

module.exports = {
  buildSkillZip,
  buildSubSkillZips,
  buildSkillsRegistry,
  bump,
  getVersion,
  discoverSubSkills,
  parseSkillFrontmatter,
};

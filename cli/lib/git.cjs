/**
 * Git operations for CLI commit, sync, and release commands.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  } catch (err) {
    const stderr = err.stderr?.trim() || err.message;
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
}

function gitStatus() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = git(["status", "--porcelain"]);
  const lines = porcelain ? porcelain.split("\n") : [];

  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (const line of lines) {
    const match = line.match(/^(.)(.) (.+)$/);
    if (!match) continue;
    const [, x, y, file] = match;
    if (x === "?" && y === "?") {
      untracked.push(file);
    } else {
      if (x !== " " && x !== "?") staged.push(file);
      if (y !== " " && y !== "?") unstaged.push(file);
    }
  }

  return { branch, clean: lines.length === 0, staged, unstaged, untracked };
}

function gitAdd(paths) {
  if (!paths || paths.length === 0) throw new Error("gitAdd: no paths");
  git(["add", ...paths]);
}

function gitAddAll() {
  git(["add", "-A"]);
}

function gitCommit(message) {
  if (!message || message.trim() === "")
    throw new Error("gitCommit: empty message");
  git(["commit", "-m", message]);
  const hash = git(["rev-parse", "--short", "HEAD"]);
  return { hash, message };
}

function gitPush(remote = "origin", branch, force = false) {
  if (!branch) branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const args = ["push", remote, branch];
  if (force) args.splice(1, 0, "--force");
  git(args);
  return { remote, branch };
}

function gitDiffStat() {
  const stat = git(["diff", "--cached", "--stat"]);
  const nameOnly = git(["diff", "--cached", "--name-only"]);
  const files = nameOnly ? nameOnly.split("\n") : [];
  return { files, summary: stat };
}

function gitTag(tag, message) {
  if (message) {
    git(["tag", "-a", tag, "-m", message]);
  } else {
    git(["tag", tag]);
  }
}

function gitTagExists(tag) {
  try {
    git(["rev-parse", tag]);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Generate commit message from changed file paths, adapted for knowledge-prism.
 */
function generateCommitMessage(files) {
  if (!files || files.length === 0) return "chore: update files";

  const areas = new Set();
  let hasDocs = false;

  for (const f of files) {
    if (f.startsWith("docs/")) hasDocs = true;

    if (f.startsWith("lib/")) areas.add("lib");
    else if (f.startsWith("openclaw-plugin/")) areas.add("plugin");
    else if (f.startsWith("bin/")) areas.add("cli");
    else if (f.startsWith("cli/")) areas.add("toolchain");
    else if (f.startsWith("test/")) areas.add("test");
    else if (f.startsWith("templates/")) areas.add("templates");
    else if (f.startsWith("skills/")) areas.add("skills");
    else if (f.startsWith("docs/")) areas.add("docs");
    else if (f.startsWith("scripts/")) areas.add("scripts");
    else if (
      f === "package.json" ||
      f === "README.md" ||
      f === "CHANGELOG.md" ||
      f === "SKILL.md"
    )
      areas.add("meta");
  }

  if (hasDocs && areas.size === 1 && areas.has("docs")) {
    return "docs: update documentation";
  }

  const areaList = [...areas].filter((a) => a !== "docs");

  if (areaList.length === 0) {
    return `chore: update ${files.length} file(s)`;
  }
  if (areaList.length === 1) {
    const area = areaList[0];
    if (hasDocs) return `${area}: update and rebuild`;
    return `${area}: update`;
  }

  if (hasDocs) return `update ${areaList.join(", ")} and rebuild docs`;
  return `update ${areaList.join(", ")}`;
}

function ghRelease(tag, title, notes, assets = []) {
  const args = [
    "release",
    "create",
    tag,
    "--title",
    title,
    "--notes",
    notes,
  ];
  for (const asset of assets) {
    args.push(asset);
  }
  try {
    const output = execFileSync("gh", args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { tag, url: output };
  } catch (err) {
    const stderr = err.stderr?.trim() || err.message;
    throw new Error(`gh release failed: ${stderr}`);
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  gitStatus,
  gitAdd,
  gitAddAll,
  gitCommit,
  gitPush,
  gitDiffStat,
  gitTag,
  gitTagExists,
  generateCommitMessage,
  ghRelease,
  ghAvailable,
};

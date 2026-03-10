import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { parseSkeleton } from "./output.mjs";
import {
  extractTitle,
  heading,
  listDateDirs,
  listMdFiles,
  listPerspectiveDirs,
  log as defaultLog,
  makePaths,
  parseAbbrevTable,
  parseKeyLineTable,
  read,
  warn as defaultWarn,
} from "./utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Node / Link type constants
// ---------------------------------------------------------------------------

const NODE_TYPES = ["journal", "atom", "group", "synthesis", "perspective", "output"];

const LINK_TYPES = {
  EXTRACT: "extract",       // journal → atom
  CLASSIFY: "classify",     // atom → group
  SUPPORT: "support",       // group → synthesis
  STRUCTURE: "structure",   // synthesis → perspective
  PRODUCE: "produce",       // perspective → output
};

// ---------------------------------------------------------------------------
// extractGraph — scan the knowledge base and build { nodes, links }
// ---------------------------------------------------------------------------

/**
 * Scan the knowledge base directory and extract all document nodes and their
 * reference relationships.
 *
 * @param {string} baseDir - Knowledge prism root directory
 * @returns {{ nodes: Array, links: Array }}
 */
export function extractGraph(baseDir) {
  const paths = makePaths(baseDir);
  const nodes = [];
  const links = [];
  const nodeIndex = new Map();

  function addNode(id, props) {
    if (nodeIndex.has(id)) return;
    const node = { id, ...props };
    nodes.push(node);
    nodeIndex.set(id, node);
  }

  const linkSet = new Set();
  function addLink(source, target, type) {
    if (!source || !target) return;
    const key = `${source}|${target}|${type}`;
    if (linkSet.has(key)) return;
    linkSet.add(key);
    links.push({ source, target, type });
  }

  // -- Layer 1: Journals --

  const journalDates = listDateDirs(paths.journalDir);
  for (const dateDir of journalDates) {
    const mdFiles = listMdFiles(join(paths.journalDir, dateDir));
    for (const f of mdFiles) {
      const filePath = join(paths.journalDir, dateDir, f);
      const relPath = relative(baseDir, filePath).replace(/\\/g, "/");
      const title = extractTitle(read(filePath));
      addNode(relPath, {
        name: `${dateDir} ${title}`,
        type: "journal",
        path: relPath,
        meta: { date: dateDir },
      });
    }
  }

  // -- Layer 2: Atoms + journal→atom links --

  const abbrevToStem = new Map();
  const atomIdToPath = new Map();

  if (existsSync(paths.atomsReadme)) {
    const { fileToAbbrev } = parseAbbrevTable(read(paths.atomsReadme));
    for (const [stem, abbrev] of fileToAbbrev) {
      abbrevToStem.set(abbrev, stem);
    }
  }

  if (existsSync(paths.atomsDir)) {
    for (const sub of readdirSync(paths.atomsDir)) {
      const subDir = join(paths.atomsDir, sub);
      if (!statSync(subDir).isDirectory() || !/^\d{4}-\d{2}$/.test(sub)) continue;
      for (const f of listMdFiles(subDir)) {
        const filePath = join(subDir, f);
        const relPath = relative(baseDir, filePath).replace(/\\/g, "/");
        const content = read(filePath);
        const title = extractTitle(content);

        const abbrevMatch = content.match(/>\s*缩写[：:]\s*([A-Z]{2})/);
        const abbrev = abbrevMatch ? abbrevMatch[1] : null;
        const atomType = detectAtomType(content);

        addNode(relPath, {
          name: abbrev ? `${abbrev} ${title}` : title,
          type: "atom",
          path: relPath,
          meta: { abbrev, atomType, month: sub },
        });

        // Register atom IDs (e.g. "KA-01") for later group linking
        for (const m of content.matchAll(/\|\s*([A-Z]{2}-\d{2})\s*\|/g)) {
          atomIdToPath.set(m[1], relPath);
        }

        // journal → atom link via "来源" line
        const sourceMatch = content.match(/>\s*来源[：:]\s*\[([^\]]*)\]\(([^)]+)\)/);
        if (sourceMatch) {
          const journalAbsPath = resolve(dirname(filePath), sourceMatch[2]);
          const journalRelPath = relative(baseDir, journalAbsPath).replace(/\\/g, "/");
          if (nodeIndex.has(journalRelPath)) {
            addLink(journalRelPath, relPath, LINK_TYPES.EXTRACT);
          }
        }
      }
    }
  }

  // -- Layer 3: Groups + atom→group links --

  if (existsSync(paths.groupsDir)) {
    const groupFiles = listMdFiles(paths.groupsDir).filter((f) => f.startsWith("G"));
    for (const f of groupFiles) {
      const filePath = join(paths.groupsDir, f);
      const relPath = relative(baseDir, filePath).replace(/\\/g, "/");
      const content = read(filePath);
      const title = extractTitle(content);
      const gMatch = f.match(/^(G\d+)/);
      const gId = gMatch ? gMatch[1] : f.replace(/\.md$/, "");

      const referencedAtomIds = new Set();
      for (const m of content.matchAll(/\|\s*([A-Z]{2}-\d{2})\s*\|/g)) {
        referencedAtomIds.add(m[1]);
      }

      addNode(relPath, {
        name: title,
        type: "group",
        path: relPath,
        meta: { gId, atomCount: referencedAtomIds.size },
      });

      // atom → group links
      for (const atomId of referencedAtomIds) {
        const atomPath = atomIdToPath.get(atomId);
        if (atomPath) {
          addLink(atomPath, relPath, LINK_TYPES.CLASSIFY);
        }
      }
    }
  }

  // -- Layer 4: Synthesis + group→synthesis links --

  const groupIdToNodePath = new Map();
  for (const n of nodes) {
    if (n.type === "group" && n.meta?.gId) {
      groupIdToNodePath.set(n.meta.gId, n.id);
    }
  }

  const synthesisNodePaths = [];
  if (existsSync(paths.synthesisPath)) {
    const content = read(paths.synthesisPath);
    const candidates = parseSynthesisCandidates(content);

    for (const c of candidates) {
      const nodeId = `synthesis:${c.id}`;
      addNode(nodeId, {
        name: `${c.id} ${c.thesis}`,
        type: "synthesis",
        path: relative(baseDir, paths.synthesisPath).replace(/\\/g, "/") + `#${c.id}`,
        meta: { sId: c.id, confidence: c.confidence },
      });
      synthesisNodePaths.push({ sId: c.id, nodeId, groups: c.groups });

      for (const gRef of c.groups) {
        const gNodePath = groupIdToNodePath.get(gRef);
        if (gNodePath) {
          addLink(gNodePath, nodeId, LINK_TYPES.SUPPORT);
        }
      }
    }
  }

  // Build reverse map: groupId → set of synthesisNodeIds
  const groupToSynthesis = new Map();
  for (const s of synthesisNodePaths) {
    for (const g of s.groups) {
      if (!groupToSynthesis.has(g)) groupToSynthesis.set(g, new Set());
      groupToSynthesis.get(g).add(s.nodeId);
    }
  }

  // -- Layer 5: Perspectives + synthesis→perspective links --

  if (existsSync(paths.structureDir)) {
    const perspDirs = listPerspectiveDirs(paths.structureDir);
    for (const dir of perspDirs) {
      const perspPath = join(paths.structureDir, dir);
      const relPath = `pyramid/structure/${dir}`;
      const pMatch = dir.match(/^(P\d+)/);
      const pId = pMatch ? pMatch[1] : dir;

      let perspName = dir.replace(/^P\d+-/, "").replace(/-/g, " ");
      const scqaPath = join(perspPath, "scqa.md");
      if (existsSync(scqaPath)) {
        const scqa = read(scqaPath);
        const nameMatch = scqa.match(/>\s*所属视角[：:]\s*(.+)/);
        if (nameMatch) perspName = nameMatch[1].trim().replace(/^P\d+\s*-\s*/, "");
      }

      const treePath = join(perspPath, "tree", "README.md");
      let keyLines = [];
      if (existsSync(treePath)) {
        keyLines = parseKeyLineTable(read(treePath));
      }

      addNode(relPath, {
        name: `${pId} ${perspName}`,
        type: "perspective",
        path: relPath,
        meta: { pId, keyLineCount: keyLines.length },
      });

      // Derive synthesis→perspective links via KL→groups→synthesis chain
      const linkedSyntheses = new Set();
      for (const kl of keyLines) {
        for (const gRef of kl.groups) {
          const sNodes = groupToSynthesis.get(gRef);
          if (sNodes) {
            for (const sNode of sNodes) linkedSyntheses.add(sNode);
          }
        }
      }
      for (const sNodeId of linkedSyntheses) {
        addLink(sNodeId, relPath, LINK_TYPES.STRUCTURE);
      }
    }
  }

  // -- Layer 6: Outputs + perspective→output links --

  if (existsSync(paths.outputsDir)) {
    for (const templateDir of readdirSync(paths.outputsDir)) {
      const tDir = join(paths.outputsDir, templateDir);
      if (!statSync(tDir).isDirectory()) continue;
      if (templateDir.startsWith("_") || templateDir === "node_modules") continue;
      for (const f of listMdFiles(tDir)) {
        const filePath = join(tDir, f);
        const relPath = relative(baseDir, filePath).replace(/\\/g, "/");
        const content = readFileSync(filePath, "utf-8");
        const title = extractTitle(content);

        addNode(relPath, {
          name: title,
          type: "output",
          path: relPath,
          meta: { template: templateDir },
        });

        // Link to perspective via skeleton refs
        const skeleton = parseSkeleton(filePath, baseDir);
        if (skeleton.isSkeleton || skeleton.meta?.perspective) {
          const perspDir = skeleton.meta.perspective;
          if (perspDir) {
            const perspNodeId = `pyramid/structure/${perspDir}`;
            if (nodeIndex.has(perspNodeId)) {
              addLink(perspNodeId, relPath, LINK_TYPES.PRODUCE);
            }
          }
        } else {
          // Fallback: try to infer perspective from file path pattern or refs
          const refs = skeleton.refs || {};
          if (refs.kl) {
            const klPath = Array.isArray(refs.kl) ? refs.kl[0] : refs.kl;
            if (klPath) {
              const perspMatch = klPath.match(/pyramid\/structure\/(P\d+[^/]*)\//);
              if (perspMatch) {
                const perspNodeId = `pyramid/structure/${perspMatch[1]}`;
                if (nodeIndex.has(perspNodeId)) {
                  addLink(perspNodeId, relPath, LINK_TYPES.PRODUCE);
                }
              }
            }
          }
        }
      }
    }
  }

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectAtomType(content) {
  const types = { "事实": 0, "步骤": 0, "经验": 0, "判断": 0 };
  for (const m of content.matchAll(/\|\s*(?:事实|步骤|经验|判断)\s*\|/g)) {
    const t = m[0].replace(/[|\s]/g, "");
    if (t in types) types[t]++;
  }
  const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : null;
}

/**
 * Parse the synthesis candidate table.
 * Expected format: | S1 | thesis | confidence | G01, G03 |
 */
function parseSynthesisCandidates(content) {
  const candidates = [];
  const lines = content.split("\n");
  let inSection = false;
  let headerPassed = false;

  for (const line of lines) {
    if (/^##\s+顶层观点候选/.test(line)) { inSection = true; continue; }
    if (/^##\s+待成熟候选/.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(line) && !/顶层观点候选|待成熟候选/.test(line)) {
      inSection = false;
      headerPassed = false;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("|") && line.includes("---") && !/[A-Za-z\u4e00-\u9fff]/.test(line)) {
      headerPassed = true; continue;
    }
    if (!headerPassed) continue;

    const m = line.match(/^\|\s*(S\d+\*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (m) {
      const groups = m[4]
        .split(/[,，]/)
        .map((g) => g.trim())
        .filter((g) => /^G\d+/.test(g));
      candidates.push({
        id: m[1],
        thesis: m[2].trim(),
        confidence: m[3].trim(),
        groups,
      });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// analyzeGraph — compute stats from the extracted graph
// ---------------------------------------------------------------------------

/**
 * @param {{ nodes: Array, links: Array }} graph
 * @returns {object} stats
 */
export function analyzeGraph({ nodes, links }) {
  const typeCounts = {};
  for (const t of NODE_TYPES) typeCounts[t] = 0;
  for (const n of nodes) {
    if (n.type in typeCounts) typeCounts[n.type]++;
  }

  const connectedIds = new Set();
  const brokenLinks = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const l of links) {
    const sid = typeof l.source === "object" ? l.source.id : l.source;
    const tid = typeof l.target === "object" ? l.target.id : l.target;
    connectedIds.add(sid);
    connectedIds.add(tid);
    if (!nodeIds.has(sid) || !nodeIds.has(tid)) {
      brokenLinks.push({ source: sid, target: tid, type: l.type });
    }
  }

  const orphanNodes = nodes.filter((n) => !connectedIds.has(n.id));
  const coverage = nodes.length > 0
    ? Math.round((connectedIds.size / nodes.length) * 100)
    : 0;

  return {
    totalNodes: nodes.length,
    totalLinks: links.length,
    typeCounts,
    orphanCount: orphanNodes.length,
    orphanNodes: orphanNodes.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    coverage,
    brokenLinks,
    isEmpty: nodes.length === 0,
    hasNoLinks: nodes.length > 0 && links.length === 0,
  };
}

// ---------------------------------------------------------------------------
// generateGraphHtml — inject data into template and write HTML file
// ---------------------------------------------------------------------------

/**
 * @param {{ nodes: Array, links: Array }} graph
 * @param {object} stats - from analyzeGraph
 * @param {object} options
 * @param {string} options.outputPath - where to write the HTML
 * @param {string} [options.knowledgeBaseName]
 * @param {function} [options.log]
 * @returns {string} the output path
 */
export function generateGraphHtml(graph, stats, options = {}) {
  const {
    outputPath,
    knowledgeBaseName = "Knowledge Prism",
    log = defaultLog,
  } = options;

  const templatePath = join(__dirname, "..", "templates", "graph.html");
  let html = readFileSync(templatePath, "utf-8");

  html = html.replace(
    '/*__GRAPH_DATA__*/{nodes:[],links:[]}',
    JSON.stringify({ nodes: graph.nodes, links: graph.links }),
  );
  html = html.replace(
    '/*__GRAPH_STATS__*/{totalNodes:0,totalLinks:0,orphanCount:0,coverage:0,isEmpty:false,hasNoLinks:false}',
    JSON.stringify(stats),
  );
  html = html.replace(
    '/*__KB_NAME__*/"Knowledge Prism"',
    JSON.stringify(knowledgeBaseName),
  );

  // Inline vendor JS for offline usage
  const vendorDir = join(__dirname, "..", "vendor");
  const inlineEntries = [
    { pattern: /<script src="[^"]*three@[^"]*\/three\.min\.js"><\/script>/, file: "three.min.js" },
    { pattern: /<script src="[^"]*three-spritetext[^"]*"><\/script>/, file: "three-spritetext.min.js" },
    { pattern: /<script src="[^"]*d3-force-3d[^"]*"><\/script>/, file: "d3-force-3d.min.js" },
    { pattern: /<script src="[^"]*3d-force-graph[^"]*"><\/script>/, file: "3d-force-graph.min.js" },
  ];
  for (const { pattern, file } of inlineEntries) {
    const localPath = join(vendorDir, file);
    if (existsSync(localPath)) {
      const content = readFileSync(localPath, "utf-8");
      html = html.replace(pattern, `<script>${content}</script>`);
    }
  }

  writeFileSync(outputPath, html, "utf-8");
  log(`✓ 已生成知识图谱: ${outputPath}`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const HELP = `
用法: js-knowledge-prism graph [选项]

生成知识图谱可视化 HTML 文件。

选项:
  --output <path>       输出文件路径（默认 <baseDir>/graph.html）
  --json                额外输出原始 JSON 数据文件
  --perspective <id>    只显示特定视角相关的子图
  -h, --help            显示帮助
`.trim();

export async function run(args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      output: { type: "string" },
      json: { type: "boolean", default: false },
      perspective: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { baseDir, config } = loadConfig();

  heading("知识图谱生成");
  defaultLog(`根目录: ${baseDir}`);

  let graph = extractGraph(baseDir);

  // Perspective sub-graph filtering
  if (flags.perspective) {
    graph = filterByPerspective(graph, flags.perspective);
    defaultLog(`已过滤至视角: ${flags.perspective}`);
  }

  const stats = analyzeGraph(graph);

  defaultLog(`节点: ${stats.totalNodes}, 链接: ${stats.totalLinks}`);
  for (const [type, count] of Object.entries(stats.typeCounts)) {
    if (count > 0) defaultLog(`  ${type}: ${count}`);
  }
  if (stats.orphanCount > 0) {
    defaultWarn(`发现 ${stats.orphanCount} 个孤立节点`);
  }
  if (stats.brokenLinks.length > 0) {
    defaultWarn(`发现 ${stats.brokenLinks.length} 条断链`);
  }

  const outputPath = flags.output || join(baseDir, "graph.html");

  generateGraphHtml(graph, stats, {
    outputPath,
    knowledgeBaseName: config.name || "Knowledge Prism",
  });

  if (flags.json) {
    const jsonPath = outputPath.replace(/\.html$/, ".json");
    writeFileSync(jsonPath, JSON.stringify({ ...graph, stats }, null, 2), "utf-8");
    defaultLog(`✓ 已生成 JSON 数据: ${jsonPath}`);
  }

  heading("生成完毕");
}

// ---------------------------------------------------------------------------
// Perspective sub-graph filter
// ---------------------------------------------------------------------------

function filterByPerspective(graph, perspectiveId) {
  const { nodes, links } = graph;
  const perspNode = nodes.find(
    (n) => n.type === "perspective" && (n.meta?.pId === perspectiveId || n.id.includes(perspectiveId)),
  );
  if (!perspNode) return graph;

  const keepIds = new Set([perspNode.id]);

  // Walk backward through links to collect all ancestors
  let frontier = [perspNode.id];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const l of links) {
        const tid = typeof l.target === "object" ? l.target.id : l.target;
        const sid = typeof l.source === "object" ? l.source.id : l.source;
        if (tid === id && !keepIds.has(sid)) {
          keepIds.add(sid);
          next.push(sid);
        }
      }
    }
    frontier = next;
  }

  // Walk forward to collect outputs
  frontier = [perspNode.id];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const l of links) {
        const sid = typeof l.source === "object" ? l.source.id : l.source;
        const tid = typeof l.target === "object" ? l.target.id : l.target;
        if (sid === id && !keepIds.has(tid)) {
          keepIds.add(tid);
          next.push(tid);
        }
      }
    }
    frontier = next;
  }

  return {
    nodes: nodes.filter((n) => keepIds.has(n.id)),
    links: links.filter((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      return keepIds.has(sid) && keepIds.has(tid);
    }),
  };
}

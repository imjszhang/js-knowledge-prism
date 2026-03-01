---
name: js-knowledge-prism
description: Pyramid-principle knowledge distillation — extract atoms, form groups, synthesize insights from journal notes.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F48E"
    homepage: https://github.com/user/js-knowledge-prism
    os:
      - windows
      - macos
      - linux
    requires:
      bins:
        - node
---

# JS Knowledge Prism

A pyramid-principle-based knowledge distillation toolkit that transforms scattered journal notes into structured knowledge outputs.

## What it does

Knowledge Prism processes journal notes through a three-layer pipeline:

1. **Atoms** — extract atomic knowledge units from daily journals
2. **Groups** — cluster related atoms into thematic groups
3. **Synthesis** — distill groups into top-level insights

Then uses these structured materials to generate perspective-driven outputs (articles, tutorials, etc.) via the SCQA + Key Line framework.

## Architecture

```
Journal Notes  →  Process Pipeline  →  Pyramid (atoms/groups/synthesis)
                                           ↓
                                    Perspectives (SCQA + Key Lines)
                                           ↓
                                    Outputs (articles, guides, etc.)
```

The OpenClaw plugin connects to an OpenAI-compatible LLM API to drive extraction and synthesis. All processing is incremental — only new journals are processed.

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `knowledge_prism_process` | Run incremental pipeline (atoms → groups → synthesis) |
| `knowledge_prism_status` | Query knowledge base status and statistics |
| `knowledge_prism_new_perspective` | Create a new perspective skeleton from template |
| `knowledge_prism_fill_perspective` | Generate SCQA or Key Line content for a perspective |
| `knowledge_prism_expand_kl` | Expand a Key Line into a full supporting argument document |

## CLI Commands

```
openclaw prism init <dir>              Initialize knowledge prism skeleton
openclaw prism process [--dry-run]     Run incremental processing
openclaw prism status [--json]         View processing status
openclaw prism new-perspective <slug>  Create new perspective from template
```

## Skill Bundle Structure

```
js-knowledge-prism/
├── SKILL.md                           ← Skill entry point (this file)
├── package.json                       ← Root package
├── LICENSE
├── openclaw-plugin/
│   ├── openclaw.plugin.json           ← Plugin manifest (config schema, UI hints)
│   ├── package.json                   ← ESM module descriptor
│   └── index.mjs                      ← Plugin logic — 5 AI tools + CLI
├── lib/
│   ├── config.mjs                     ← Configuration loading
│   ├── process.mjs                    ← Core pipeline (atoms → groups → synthesis)
│   ├── status.mjs                     ← Status collection
│   ├── init.mjs                       ← Project initialization
│   ├── new-perspective.mjs            ← Perspective creation
│   ├── fill-perspective.mjs           ← SCQA/Key Line generation
│   ├── expand-kl.mjs                  ← Key Line expansion
│   └── utils.mjs                      ← Shared utilities
└── templates/                         ← Init templates for skeleton creation
```

> `openclaw-plugin/index.mjs` imports from `../lib/` via relative paths, so the directory layout must be preserved.

## Prerequisites

- **Node.js** >= 18
- An **OpenAI-compatible API** endpoint (local or remote)

## Install

### Option A — One-command install (recommended)

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.ps1 | iex
```

By default, the skill is installed to `./skills/js-knowledge-prism`. To change:

```bash
curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | JS_PRISM_DIR=~/.openclaw/skills bash
```

### Option B — Manual

1. Download the skill zip from GitHub Releases
2. Extract to your skills directory
3. Run `npm install` in the extracted directory
4. Register the plugin (see below)

### Register the plugin

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/js-knowledge-prism/openclaw-plugin"]
    },
    "entries": {
      "js-knowledge-prism": {
        "enabled": true,
        "config": {
          "baseDir": "/path/to/your-knowledge-base",
          "api": {
            "baseUrl": "http://localhost:8888/v1",
            "model": "your-model",
            "apiKey": "your-key"
          }
        }
      }
    }
  }
}
```

Restart OpenClaw to load the plugin.

## Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseDir` | string | cwd | Knowledge base root directory |
| `api.baseUrl` | string | `http://localhost:8888/v1` | OpenAI-compatible API endpoint |
| `api.model` | string | `default` | Model name |
| `api.apiKey` | string | `not-needed` | API key |
| `process.batchSize` | number | `5` | Journals per batch |
| `process.temperature` | number | `0.3` | LLM temperature |
| `process.maxTokens` | number | `8192` | Max tokens per request |
| `process.timeoutMs` | number | `1800000` | Request timeout (ms) |

## Verify

```bash
openclaw prism status
```

Expected output:

```
知识棱镜根目录: /path/to/base

  Journal: 12 篇 (5 个日期目录)
  Atoms:   24 个文件
  Groups:  6 个分组
  视角:    2 个
  待处理:  0 篇 journal
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `未找到 .knowledgeprism.json` | Not initialized | Run `openclaw prism init <dir>` |
| LLM timeout | API unreachable | Check `api.baseUrl` and network |
| Empty atoms | Journal has no extractable content | Ensure journals contain substantive notes |
| Tools not appearing | Plugin path wrong | Ensure path points to `openclaw-plugin/` subdirectory |

## Security

This skill only communicates with **user-configured** LLM API endpoints. It does not call any external APIs, collect telemetry, or transmit user data. All processing happens locally through the configured API.

## Extension Skills

Knowledge Prism supports extension skills that add specialized output capabilities:

| Skill | Description |
|-------|-------------|
| **prism-output-blog** | Transform perspectives into blog-ready articles |

Use `knowledge_prism_discover_skills` to list available extensions, or `knowledge_prism_install_skill` to install them.

## Links

- Source: https://github.com/user/js-knowledge-prism
- License: MIT

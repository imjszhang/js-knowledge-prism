# js-knowledge-prism

基于金字塔原理的三层知识蒸馏工具包。将散乱的时间线笔记转化为结构化知识产出。

支持两种使用方式：独立 CLI 和 [OpenClaw](https://github.com/openclaw/openclaw) 插件。

## 快速开始

```bash
# 在任意项目中初始化知识棱镜
npx js-knowledge-prism init docs/knowledge --name "我的知识库"

# 查看处理状态
npx js-knowledge-prism status

# 运行增量处理（先 dry-run 预览）
npx js-knowledge-prism process --dry-run

# 创建新视角
npx js-knowledge-prism new-perspective blog-post --name "博客文章"
```

## 什么是知识棱镜

一束白光射入三棱镜，折射出有序的七色光谱。散乱的日常笔记（白光）经过结构化拆解（棱镜），产出面向读者的清晰文章（光谱）。

```
journal/   原始素材层    ← 按日期忠实记录，只增不改
    ↓
pyramid/   结构化拆解层  ← 基于金字塔原理，双轨处理
    ↓
outputs/   读者产出层    ← 面向特定读者的成品文章
```

详细方法论见 [docs/knowledge-prism-introduction.md](docs/knowledge-prism-introduction.md)。

## CLI 命令

### `init <dir>`

在目标目录生成完整的知识棱镜骨架。

```bash
npx js-knowledge-prism init docs/knowledge --name "项目知识库"
```

生成的目录结构：

```
docs/knowledge/
├── .knowledgeprism.json       # 配置文件（处理参数，不含敏感信息）
├── .env.example               # 环境变量模板（复制为 .env 填入实际值）
├── README.md                  # 知识库说明
├── CHANGELOG.md               # 架构变更日志
├── journal/                   # 原始笔记（按日期组织）
├── pyramid/                   # 结构化拆解
│   ├── analysis/
│   │   ├── atoms/             # 信息单元（按月分目录）
│   │   ├── groups/            # 归组（跨文档分组）
│   │   └── synthesis.md       # 收敛（顶层观点候选）
│   └── structure/
│       ├── _template/         # 视角模板
│       └── PXX-xxx/           # 各视角目录
└── outputs/                   # 面向读者的产出
```

### `process`

金字塔增量处理：自动从 journal 提取 atoms，更新 groups 和 synthesis。

```bash
npx js-knowledge-prism process              # 三阶段完整处理（建议模式）
npx js-knowledge-prism process --dry-run    # 只预览，不调用模型
npx js-knowledge-prism process --auto-write # 自动写入文件
npx js-knowledge-prism process --stage 1    # 只执行阶段 1（提取 atoms）
npx js-knowledge-prism process --file x.md  # 只处理指定 journal
```

需要配置 OpenAI 兼容的 API 端点，见下方配置说明。

### `status`

查看知识棱镜的处理状态：journal 总数、待处理数、atoms/groups 统计等。

```bash
npx js-knowledge-prism status
```

### `graph`

生成交互式 3D 知识图谱可视化 HTML。

```bash
npx js-knowledge-prism graph                   # 在当前知识库生成图谱
npx js-knowledge-prism graph --base-dir ./docs  # 指定知识库目录
npx js-knowledge-prism graph --open             # 生成后自动打开浏览器
```

生成的 HTML 为自包含单文件，支持：

- **3D 交互**：鼠标旋转、平移、缩放，金字塔层级布局
- **搜索与过滤**：按关键词搜索节点，按文档类型过滤图层
- **溯源高亮**：点击节点高亮完整引用链（journal → output）
- **详情面板**：查看节点元信息与引用关系，点击可导航到关联节点

### `new-perspective <slug>`

从模板创建新的金字塔视角。

```bash
npx js-knowledge-prism new-perspective tutorial --name "入门教程"
```

## 配置（独立 CLI）

`init` 命令会在知识棱镜根目录生成 `.knowledgeprism.json`（不含敏感信息）和 `.env.example` 模板：

```json
{
  "name": "知识库名称",
  "api": {},
  "process": {
    "batchSize": 5,
    "temperature": 0.3,
    "maxTokens": 8192,
    "timeoutMs": 1800000
  }
}
```

API 地址、模型和密钥通过环境变量配置。复制 `.env.example` 为 `.env` 并填入实际值：

```bash
cp .env.example .env
```

```ini
KNOWLEDGE_PRISM_API_BASE_URL=http://localhost:8888/v1
KNOWLEDGE_PRISM_API_MODEL=qwen3.5
KNOWLEDGE_PRISM_API_KEY=your-api-key-here
```

| 环境变量 | 覆盖字段 | 默认值 |
| --- | --- | --- |
| `KNOWLEDGE_PRISM_API_BASE_URL` | `api.baseUrl` | `http://localhost:8888/v1` |
| `KNOWLEDGE_PRISM_API_MODEL` | `api.model` | `unsloth/Qwen3.5-397B-A17B` |
| `KNOWLEDGE_PRISM_API_KEY` | `api.apiKey` | `not-needed` |

> `.env` 已在 `.gitignore` 中，不会被提交到仓库。

## OpenClaw 插件

本项目内置 OpenClaw 插件（`openclaw-plugin/` 目录），可将知识棱镜集成到 OpenClaw 的 CLI 和 AI Agent 中。

### 启用插件

在 OpenClaw 配置文件（如 `~/.openclaw/openclaw.json`）中添加：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/js-knowledge-prism/openclaw-plugin"]
    },
    "entries": {
      "knowledge-prism": {
        "enabled": true,
        "config": {
          "baseDir": "/path/to/your-knowledge-base",
          "api": {
            "baseUrl": "http://localhost:8888/v1",
            "model": "your-model-name",
            "apiKey": "your-api-key"
          },
          "process": {
            "batchSize": 5,
            "temperature": 0.3,
            "maxTokens": 8192,
            "timeoutMs": 1800000
          }
        }
      }
    }
  }
}
```

API 配置支持 `${ENV_VAR}` 语法引用环境变量。

### 插件提供的 CLI 命令

通过 `openclaw prism` 子命令组使用，功能与独立 CLI 一致：

```bash
openclaw prism init <dir> [--name <name>]
openclaw prism process [--dry-run] [--auto-write] [--stage <n>] [--base-dir <dir>]
openclaw prism status [--json] [--base-dir <dir>]
openclaw prism new-perspective <slug> [--name <name>]
openclaw prism graph [--base-dir <dir>] [--output <path>] [--json] [--perspective <id>]
openclaw prism register <dir>
openclaw prism unregister <dir>
openclaw prism registered [--status]
openclaw prism setup-cron [--every <minutes>]
openclaw prism setup-output-cron [--every <minutes>]
openclaw prism sync [--force]
```

### 插件提供的 AI 工具

插件注册了以下 AI 工具，OpenClaw Agent 在对话中可自动调用：

| 工具 | 说明 |
|------|------|
| `knowledge_prism_process` | 执行增量处理（atoms → groups → synthesis） |
| `knowledge_prism_status` | 查询知识库当前状态 |
| `knowledge_prism_graph` | 生成知识图谱可视化 HTML，返回统计摘要 |
| `knowledge_prism_new_perspective` | 创建新视角骨架 |
| `knowledge_prism_fill_perspective` | 生成 SCQA 或 Key Line 内容 |
| `knowledge_prism_expand_kl` | 展开 Key Line 为完整论证文档 |
| `knowledge_prism_output` | 从视角生成面向读者的产出 |
| `knowledge_prism_register` | 注册知识库到自动处理列表 |
| `knowledge_prism_list_registered` | 列出所有已注册知识库及状态 |
| `knowledge_prism_process_all` | 批量处理所有已注册知识库，变更时自动通知 output inbox |
| `knowledge_prism_bind_output` | 绑定视角+模板的自动产出配置（含 `refreshStructure` 开关） |
| `knowledge_prism_list_output_bindings` | 列出所有产出绑定及状态 |
| `knowledge_prism_output_all` | Inbox/batch 轮转产出（崩溃恢复 + 失败重试 + 变化检测） |

### Web UI：知识图谱总览

插件通过 OpenClaw HTTP 网关提供 Web 页面，可在浏览器中查看所有已注册知识库的知识图谱。

访问路径：`http://<openclaw-host>/plugins/js-knowledge/prism/`

- 列出所有已注册知识库，显示名称、路径、启用状态和图谱生成状态
- 点击"查看图谱"直接在浏览器中打开对应知识库的 3D 交互图谱
- 图谱需先通过 `openclaw prism graph` 或 AI 工具 `knowledge_prism_graph` 生成

## 编程 API

`lib/process.mjs` 和 `lib/status.mjs` 导出了可编程接口，方便集成到其他系统：

```javascript
import { createHttpCaller, runPipeline } from "js-knowledge-prism/lib/process.mjs";
import { getStatus } from "js-knowledge-prism/lib/status.mjs";

// 创建模型调用函数
const callAgent = createHttpCaller({
  baseUrl: "http://localhost:8888/v1",
  model: "your-model",
  apiKey: "your-key",
});

// 运行处理管道
const summary = await runPipeline({
  baseDir: "/path/to/knowledge-base",
  config: { process: { batchSize: 5 } },
  callAgent,
  autoWrite: true,
});

// 查询状态
const status = getStatus("/path/to/knowledge-base");
```

## 要求

- Node.js >= 18.0.0
- 零外部依赖（独立 CLI 和核心模块均不依赖第三方包）

## License

MIT

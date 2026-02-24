# js-knowledge-prism

基于金字塔原理的三层知识蒸馏 CLI 工具包。将散乱的时间线笔记转化为结构化知识产出。

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

## 命令

### `init <dir>`

在目标目录生成完整的知识棱镜骨架。

```bash
npx js-knowledge-prism init docs/knowledge --name "项目知识库"
```

生成的目录结构：

```
docs/knowledge/
├── .knowledgeprism.json       # 配置文件（API、处理参数）
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

### `new-perspective <slug>`

从模板创建新的金字塔视角。

```bash
npx js-knowledge-prism new-perspective tutorial --name "入门教程"
```

## 配置

`init` 命令会在知识棱镜根目录生成 `.knowledgeprism.json`：

```json
{
  "name": "知识库名称",
  "api": {
    "baseUrl": "http://localhost:8888/v1",
    "model": "unsloth/Qwen3.5-397B-A17B",
    "apiKey": ""
  },
  "process": {
    "batchSize": 5,
    "temperature": 0.3,
    "maxTokens": 8192,
    "timeoutMs": 1800000
  }
}
```

### 环境变量覆盖

以下环境变量优先于配置文件（也可写在知识棱镜根目录的 `.env` 中）：

| 环境变量 | 覆盖字段 |
| --- | --- |
| `KNOWLEDGE_PRISM_API_BASE_URL` | `api.baseUrl` |
| `KNOWLEDGE_PRISM_API_MODEL` | `api.model` |
| `KNOWLEDGE_PRISM_API_KEY` | `api.apiKey` |

## 要求

- Node.js >= 18.0.0
- 零外部依赖

## License

MIT

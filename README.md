# dsh-charm-provider

DeepSeek Harness 的 **Charm Hyper**（[hyper.charm.land](https://hyper.charm.land/docs/)）供应商插件。
注册一条 `hyper` 路由，走 OpenAI 兼容的 chat-completions 协议。

- **实时模型目录** —— 启动时读 `GET {baseURL}/models`（免鉴权），落盘缓存
  `~/.hyper/models-cache.json`（默认 TTL 6 小时）；断网沿用上一次快照。目录里带
  上下文窗口、最大输出、`capabilities.vision`、`reasoning.effort_levels` 和价格。
- **能力来自端点自报** —— 思考档位直接由端点 `effort_levels` 映射（线值原样发送，
  含 `none`），视觉模态由 `capabilities.vision` 映射，不需要手工声明。
- **图片输入** —— vision 模型的图片按 `image_url` data URL 发送，字节取自 dsh 的
  attachment 服务。
- **推理强度** —— 请求带 `reasoning_effort`，assistant 历史回放 `reasoning_content`，
  只回放有配对结果的 tool call。
- **余额统计（Hypercredits）** —— `Settings → Hyper` 顶部是余额卡片，`Settings → Models`
  的 Hyper 卡片上也有一行余额；`/hyper` 给文字版汇总（余额、本次会话请求数/累计花费/
  累计积分、最近一次请求）。数据有**两个来源**，卡片会标明用的是哪个：

  - `GET /v1/credits` → 整数余额，权威；
  - 每个响应的 `usage.remaining.hypercredits` → 精确到小数。

  > 实测（`scripts/verify-live.mjs` 对账出来的，文档没写）：**流式**响应的 usage 只带
  > `cost.usd` / `cost.hypercredits`，**不带 `remaining`**——只有非流式响应两者都有。
  > 而 dsh 永远是流式，所以余额平时来自端点读数，再减去其后累计的花费，卡片显示为
  > 「来自 /v1/credits，已扣除其后的花费」（协议里的 `estimated` 标记）。
- **错误语义** —— 401 → `INVALID_CREDENTIAL`、402 → `QUOTA`、429 → `RATE_LIMIT`
  （带 `retry-after`）、5xx → `PROVIDER_HTTP_ERROR`；每个请求都带
  `attributionHeaders()`。

## 安装

`dsh plugin --profile <profile> add <spec>` 本质是在该 profile 目录里跑 pnpm，
所以 `<spec>` 可以是**包名 / git 地址 / 本地路径或压缩包**三种。每个前门
（`web`、`dsh-tui` …）各有自己的插件列表，要分别安装。

### 从 npm

```sh
dsh plugin --profile web add dsh-charm-provider@latest
```

新发布 24 小时内的版本要写死版本号：pnpm 11 的 `minimumReleaseAge` 默认 1440 分钟，
期间 `@latest` 会**静默**解析到上一个版本（退出码仍是成功）：

```sh
dsh plugin --profile web add dsh-charm-provider@0.1.1
```

### 直接从 GitHub

`lib/` 已提交进仓库，所以 git 安装不需要在目标机器上构建：

```sh
dsh plugin --profile web add github:Namas-pan/dsh-charm-provider
```

### 从本地源码

```sh
node scripts/install.mjs            # 构建 + 自动升版本 + 打包 + 装进 web profile
node scripts/install.mjs --pack-only
node scripts/install.mjs --profile dsh-tui
```

安完**重启前门**：新增的 bundle 只在启动时装配。

## 配置

composition 行由本包的 bundle patch 提供（`cordis.patch.yml`）：

```yaml
- insert:
    - id: llm-hyper
      name: "dsh-charm-provider"
      config:
        apiKeyEnv: HYPER_API_KEY
        baseURL: https://hyper.charm.land/v1
```

用户层 `$DSH_HOME/settings.yaml`（热加载，无需重启）：

```yaml
llm-hyper:
  apiKeyEnv: HYPER_API_KEY
  baseURL: https://hyper.charm.land/v1
  catalogTtlMs: 21600000
  visibleModels: []          # 非空时只列出这些模型 id
  requestTimeoutMs: 60000
  streamIdleTimeoutMs: 300000
  defaultMaxTokens: 0        # 0 = 不替调用方设输出上限
```

### 密钥

密钥只进本地凭据存储，**不要**写进 `settings.yaml`：

- GUI：`Settings → Models` 的 **Hyper** 卡片，或 `Settings → Hyper` 页；
- 环境变量：启动前 `set HYPER_API_KEY=sk-hyper-...`。

设置页里的 **API Base URL** 直接走 `settingsScope`，改完下一个请求生效。

## 路由与命名空间

| 项 | 值 |
| --- | --- |
| provider 路由 | `hyper` |
| 显示名 | Hyper |
| settings 命名空间 | `llm-hyper` |
| 协议 | `openai-completions`（`POST {baseURL}/chat/completions`） |
| 目录 | `GET {baseURL}/models`（免鉴权） |
| 余额 | `GET {baseURL}/credits` → `{"balance": 94}`（需要 key） |
| 余额 Remote | 命名空间 `hyper` · 方法 `credits` · Host 服务 `hyperCredits` |

## 开发

Harness 的包（`@deepseek-ai/*`）是 peer dependency，由部署方提供；本包只在开发时
把它们装成 devDependencies。

```bash
pnpm install
pnpm run build        # 或 node scripts/build.mjs：类型检查 + 编译到 lib/
pnpm run check        # typecheck + verify（不需要密钥）
pnpm run verify:live  # 真机端到端（需要密钥，见下）
```

构建解析 peer 的顺序：本机 DSH 运行时（`DSH_RUNTIME` / `DSH_HOME/node_modules` /
`dsh.runtime.json` / npm `_npx` 缓存）→ 本包 `node_modules`。前者走生成的
`tsconfig.build.json` 的 `paths`，不碰 `node_modules`。

`lib/client.js`（浏览器半）是手写的，不经编译：它按
`window.__ModuleLoader__.load({ id, factory })` 约定注册，页面用
`react.createElement` 构造，因此改完直接生效。

### 验证

| 脚本 | 覆盖 | 需要密钥 |
| --- | --- | --- |
| `scripts/verify-plugin.mjs` | 产物能在真实运行时 import；导出契约；**线上** `/v1/models` 解析 | 否 |
| `scripts/verify-client.mjs` | 浏览器半自注册、两个座位、凭据 Remote 信封、组件渲染 | 否 |
| `scripts/verify-live.mjs` | 真机：目录 / resolveModel / 纯文本流 / `reasoning_effort` / 工具调用 / 带图 / **余额端点与派生余额** | 是 |

`verify-live` 的密钥取自 `HYPER_API_KEY` 或 `$DSH_HOME/.credentials.yaml`，
**不会打印**。

## 发布（维护者）

```bash
git add -A && git commit -m "dsh-charm-provider 0.1.1"
git push                    # origin 已指向 Namas-pan/dsh-charm-provider

# 发布到 npm（prepublishOnly 会先构建）
pnpm login
pnpm publish --access public
```

CI（`.github/workflows/ci.yml`）在 push / PR 上跑 typecheck、build、verify。

升级流程就是 `node scripts/install.mjs`：它会升 patch 版本、构建、打包、装进
profile，并在发现旧包名残留时先移除（否则同一路由会被注册两次导致启动失败）。

## 许可

BSD-3-Clause，见 [LICENSE](./LICENSE)。Hyper 是 Charm（charm.land）的产品；
本插件是社区集成，与 Charm 无隶属关系，使用需遵守 Hyper 自己的条款。
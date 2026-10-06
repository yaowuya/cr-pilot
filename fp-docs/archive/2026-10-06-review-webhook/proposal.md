# pi 驱动的代码评审 Webhook 服务

本文定义 cr-pilot 的首个能力：一个最小的、由 pi 驱动的代码评审服务。

范围限定在一条主线上：接收代码，读取自定义 prompt，调用 pi 产出评审文本，并把文本同步返回给调用方。

## Why

- `cr-pilot` 目前除 README 外为空仓库，团队还没有可用的代码评审服务。
- 参考项目 AI-CodeReview 自带多平台 webhook 解析、LLM 客户端工厂、通知渠道、任务队列与 Dashboard，对最小可用版本过重。
- pi 已经提供 agent 运行时，涵盖模型接入、会话管理和 system prompt。评审能力因此可以收敛为「读 prompt、拼代码、调 pi、取文本」四步。
- 现在做的理由是这条链路最短。先跑通并验证评审质量，再决定是否扩展。

## What Changes

### 1. 新建 Node.js 22 + TypeScript 服务骨架

引入 npm 项目结构与 TypeScript 编译配置，提供启动脚本和测试脚本。

选 Node.js 22 是因为 pi 要求 Node.js 22.19 或更高版本，同栈可以省掉跨语言调用。

### 2. 新增 `POST /review/webhook` 接口

接口有两个入口，共用一个路径和一份实现。

- 请求体是 GitLab 原始 payload 时，按 `object_kind` 识别事件。`merge_request` 事件从 `object_attributes` 取标题与变更，`push` 事件从 `commits` 取提交信息。
- 请求体不是 GitLab payload 时，直接把请求体中的代码文本当作待评审内容。

响应为同步返回，响应体包含评审文本、实际使用的模型标识和耗时毫秒数。

### 3. 自定义 prompt 从 `prompts/review.md` 读取

该 Markdown 文件的全部内容作为 pi 的 system prompt，代码作为用户消息送入。

文件路径可用环境变量覆盖，便于在不改代码的前提下切换评审要求。

### 4. 新增 pi 适配层

在进程内嵌入 `@earendil-works/pi-coding-agent`，不启动子进程。

每个评审请求创建一个内存会话，调用会话的 prompt 方法并读取最终助手文本，最后释放会话。

### 5. 接口不做鉴权，服务默认只绑本机

接口不校验调用方身份，默认监听 `127.0.0.1`，仅本机可访问。

## Capabilities

### New Capabilities

- `code-review-webhook`: 接收代码文本或 GitLab webhook payload，返回 pi 生成的代码评审文本。
- `custom-review-prompt`: 通过替换单个 Markdown 文件改变评审要求，不需要改代码。

### Modified Capabilities

- 无。当前仓库没有既有能力可扩展。

## Out of Scope

- 不把评审结果回写 GitLab MR 评论，也不调用任何 GitLab 写接口。
- 不做异步任务队列、结果持久化和结果查询接口，评审一律同步返回。
- 不做仓库级 prompt 覆盖，也不做多种评审风格切换。
- 不做通知渠道，包括钉钉、企业微信和飞书。
- 不做 Dashboard、数据库和评审历史记录。
- 不兼容 GitHub 与 Gitea 的 payload 结构，GitLab 结构只在本接口内解析。
- 不做接口鉴权，不区分 GitLab 调用方与普通调用方。

## Impact

当前仓库除 `README.md` 外为空，本次改动基本是新增。

- `package.json`、`tsconfig.json` - 新增项目骨架与依赖声明；依赖 `@earendil-works/pi-coding-agent`。
- `src/` 下的服务入口、接口路由、pi 适配层与 prompt 加载模块 - 新增，承载上述五个变更点。具体模块划分由设计阶段确定。
- `prompts/review.md` - 新增默认评审 prompt。
- `README.md` - 修改，补充安装、配置与本地运行说明。
- `.gitignore` - 新增，忽略 `node_modules` 与构建产物。

运行前置条件：执行评审的进程内需要有可用的 pi 模型凭证。

已知风险有两条。

- pi SDK 默认按工作目录发现 `AGENTS.md`、skills 等项目资源，需要显式收窄，否则评审结果会被无关上下文污染。
- 一次评审通常耗时 30 秒到 120 秒。同步返回意味着调用方要一直等待，若把 GitLab 原生 webhook 直接指向本接口，GitLab 会因超时重试。该限制已在 Out of Scope 中记录。

### Handoff Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| P-001 | 技术栈采用 Node.js 22 + TypeScript | user answer | yes | `user-confirmed` | `P-001: selected 「Node.js 22 + TypeScript」; user message 本次会话路由确认中用户明确选择该选项` |
| P-002 | `POST /review/webhook` 同时兼容 GitLab 原始 payload 与纯代码 | user answer | yes | `user-confirmed` | `P-002: selected 「同时兼容 GitLab 原始 payload（推荐）」; user message 本次会话路由确认中用户明确选择该选项` |
| P-003 | 进程内嵌入 pi SDK，不用子进程 CLI | user answer | yes | `user-confirmed` | `P-003: selected 「进程内嵌入 pi SDK（推荐）」; user message 本次会话 P-003 确认中用户明确选择该选项` |
| P-004 | 自定义 prompt 为单个 Markdown 文件，整体作为 system prompt | user answer | yes | `user-confirmed` | `P-004: selected 「单个 Markdown 文件（推荐）」; user message 本次会话 P-004 确认中用户明确选择该选项` |
| P-005 | 评审结果同步返回，不做异步与回写 | user answer | yes | `user-confirmed` | `P-005: selected 「同步返回评审文本（推荐）」; user message 本次会话 P-005 确认中用户明确选择该选项` |
| P-006 | 接口不做鉴权 | user answer | yes | `user-confirmed` | `P-006: selected 「不做鉴权」; user message 本次会话 P-006 确认中用户明确选择该选项` |

### Pre-write Confirmation Evidence

- Covered IDs: `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户选择「确认并按 P-001〜P-006 写入」，授权按本文件展示的 Why / What Changes / Out of Scope / Impact 与 `P-001`〜`P-006` 写入 `fp-docs/changes/review-webhook/proposal.md`。

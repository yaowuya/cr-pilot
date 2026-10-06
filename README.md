# cr-pilot

pi 驱动的代码评审 Webhook 服务。接收代码与可选的 GitLab webhook 元数据，读取自定义 prompt，在进程内调用 pi 完成一次评审，并同步返回评论文本。

## 环境要求

- Node.js 22.19.0 或更高版本。这既是 pi SDK 的 `engines` 下限，也是本项目依赖的原生 TypeScript 类型剥离所需版本。
- 可用的 pi 模型凭证，见下方「前置条件」。

## 安装

```bash
npm install
```

## 前置条件：pi 模型凭证

服务在进程内嵌入 pi SDK，因此运行服务的进程必须能解析到模型凭证。凭证由 pi 自身管理，不属于本项目的配置项。

- 全局配置目录为 `~/.pi/agent/`，包含 `settings.json` 与 `auth.json`。
- 评审所用的模型也由该配置决定，本服务不提供按请求选模型的入口。

凭证缺失或模型不可用时，每次评审都会返回 502。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `REVIEW_PROMPT_PATH` | `prompts/review.md` | 评审 prompt 文件路径 |
| `REVIEW_TIMEOUT_MS` | `120000` | 单次评审超时毫秒数 |

`HOST` 默认只绑本机。接口按已确认的设计不做鉴权，改成对外地址前请自行评估暴露风险。非法数值会在启动时直接报错，不会静默回退到默认值。

## 运行

```bash
npm start
```

## 调用

### 直接提交代码

```bash
curl -X POST http://127.0.0.1:3000/review/webhook \
  -H 'Content-Type: application/json' \
  -d '{"code":"diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n","context":"修复登录超时"}'
```

### 附带 GitLab webhook 元数据

请求体带 `object_kind` 时按 GitLab payload 处理。`merge_request` 事件会提取 `iid`、标题、描述与分支，`push` 事件会提取分支、提交信息与变更文件列表，作为评审上下文。

> **注意**：GitLab webhook payload 本身**不含代码 diff**。官方 payload 中，push 事件的 `commits` 只有文件路径与提交信息，`merge_request` 事件的 `object_attributes` 只有元数据。因此即使提交 GitLab payload，仍然必须在请求体中附带 `code` 字段，否则返回 400。本服务不调用 GitLab API，也不会自行拉取 diff。

### 响应

| 状态码 | 触发条件 | 响应体 |
| --- | --- | --- |
| 200 | 评审成功 | `{"review": string, "model": string, "duration_ms": number}` |
| 400 | 请求体不是 JSON 对象，或 `code` 缺失、非字符串、去空白后为空 | `{"error": string}` |
| 500 | prompt 文件不存在、不可读或内容为空 | `{"error": string}` |
| 502 | pi 调用失败，或评审结果为空 | `{"error": string}` |
| 504 | 超过 `REVIEW_TIMEOUT_MS` | `{"error": string}` |

接口是同步的：一次评审通常耗时 30 到 120 秒，请求会一直等待。若把 GitLab 原生 webhook 直接指向本接口，GitLab 会因超时重试，导致同一变更被重复评审。

## 自定义评审 prompt

编辑 `prompts/review.md` 即可。该文件全文会作为 pi 的 system prompt，服务不需要重启；也可以用 `REVIEW_PROMPT_PATH` 指向其他文件。

## 开发

```bash
npm test        # node --test；全部用例不调用真实模型，可离线运行
npm run typecheck
```

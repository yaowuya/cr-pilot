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

服务在进程内嵌入 pi SDK，因此运行服务的进程必须能解析到模型凭证。凭证由 pi 自身管理，不属于本项目的配置项，也不通过本服务的环境变量传入。

配置目录默认为 `~/.pi/agent/`，可用 `PI_CODING_AGENT_DIR` 改到别处。需要两个文件。

**`models.json` — 声明评审使用的模型。** 内置 provider 之外的自定义 endpoint 写在这里：

```json
{
  "providers": {
    "llmgw": {
      "baseUrl": "https://llmgw.cwoa.net/v1",
      "api": "openai-responses",
      "models": [
        {
          "id": "gpt-5.6-terra",
          "name": "gpt-5.6-terra",
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "reasoning": false,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

**`auth.json` — 存放该 provider 的密钥。** 键名与 `models.json` 里的 provider 名一致：

```json
{
  "llmgw": { "type": "api_key", "key": "<模型服务密钥>" }
}
```

`settings.json` 里的 `defaultModel` 决定默认模型；本服务不提供按请求选模型的入口。

### 校验配置是否可用

```bash
npx pi auth check --provider llmgw --json   # 期望 {"status":"ready",...}
npx pi --list-models                        # 期望能列出上面声明的模型
```

两处都通过后服务才能评审成功。注意 `models.json` 的 `apiKey` 字段是可选的环境变量插值形式（`$NAME`）；把密钥放在 `auth.json` 更合适，也不会因为进程缺少该环境变量而失败。

### 凭证缺失时的表现

每次评审返回 `502`，错误体形如：

```json
{"error": "No API key found for the selected model."}
```

看到这个错误说明凭证没被解析到，按上面的两处检查核对；这是配置问题，不是接口问题。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `REVIEW_PROMPT_PATH` | `prompts/review.md` | 评审 prompt 文件路径 |
| `REVIEW_TIMEOUT_MS` | `120000` | 单次评审超时毫秒数 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` / `silent` |

## 日志

服务把请求处理的每个步骤都写到控制台，默认 `info` 级别即可看到完整流水线。时间使用本地时区，`debug` 与 `info` 走标准输出，`warn` 与 `error` 走标准错误。

一次成功评审的输出形如：

```text
[2026-10-06 20:01:57.363] INFO  cr-pilot 正在启动 node=v22.19.0 logLevel=info
[2026-10-06 20:01:57.368] INFO  生效配置 host=127.0.0.1 port=3305 promptPath=prompts/review.md timeoutMs=300000
[2026-10-06 20:01:57.384] INFO  服务已开始监听 url=http://127.0.0.1:3305/review/webhook
[2026-10-06 20:01:58.888] INFO  收到评审请求 method=POST path=/review/webhook remote=127.0.0.1 bodyBytes=409
[2026-10-06 20:01:58.891] INFO  请求体解析完成 isGitlabPayload=false bodyFields=code,context
[2026-10-06 20:01:58.893] INFO  入参校验通过 codeChars=331 contextSources=1 contextChars=13
[2026-10-06 20:01:58.897] INFO  prompt 就绪 promptPath=prompts/review.md promptChars=491 durationMs=3
[2026-10-06 20:01:58.898] INFO  开始调用 pi timeoutMs=300000 promptChars=491 codeChars=331 contextChars=13
[2026-10-06 20:02:27.214] INFO  评审完成 model=gpt-5.6-terra reviewChars=430 durationMs=28317
[2026-10-06 20:02:27.218] INFO  响应完成 status=200 reviewChars=430 totalMs=28330
```

失败路径同样按步骤记录，例如：

```text
[2026-10-06 20:02:28.288] WARN  入参校验失败 status=400 reason=missing_code totalMs=1
[2026-10-06 20:03:00.983] ERROR 监听失败 host=127.0.0.1 port=3306 message="listen EACCES: permission denied 127.0.0.1:3306"
```

`LOG_LEVEL=debug` 额外输出 pi 会话的内部步骤：隔离工作目录、会话创建与释放、送入 pi 的消息长度、pi 返回。

**日志不记录代码正文与评审正文**，只记录长度与耗时。请求体里是待评审的源代码，日志经常被转发到控制台以外的位置，写全文会扩大泄露面。排查内容问题请直接看接口响应。

`silent` 用于测试等需要完全静默的场景。

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

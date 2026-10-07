# cr-pilot

pi 驱动的 GitLab 代码评审服务。GitLab MR webhook 触发后，服务在后台拉取变更、按仓库自定义 prompt 分批评审、汇总成一份评论并回写到 MR。

## 环境要求

- Node.js 22.19.0 或更高版本（pi SDK 的 `engines` 下限，也是原生 TypeScript 类型剥离所需版本）。
- 可用的 pi 模型凭证，见「前置条件：pi 模型凭证」。
- 一个 GitLab 实例与访问令牌（拉取 diff / 回写评论），见「配置」。

## 安装

```bash
npm install
```

## 前置条件：pi 模型凭证

服务在进程内嵌入 pi SDK，凭证由 pi 自身管理，不属于本项目的配置项，也不通过本服务的环境变量传入。配置目录默认为 `~/.pi/agent/`。

**`models.json`** 声明评审模型，自定义 endpoint 写在这里：

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

**`auth.json`** 存放密钥，键名与 `models.json` 的 provider 名一致：

```json
{
  "llmgw": { "type": "api_key", "key": "<模型服务密钥>" }
}
```

`settings.json` 的 `defaultModel` 决定默认模型。校验方式：

```bash
npx pi auth check --provider llmgw --json   # 期望 {"status":"ready",...}
npx pi --list-models                        # 期望能列出上面声明的模型
```

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `5001` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `GITLAB_URL` | 无（必填） | GitLab 实例地址，如 `https://code.cwoa.net` |
| `GITLAB_TOKEN` | 无（必填） | 访问令牌（拉 diff、回写评论），只从环境变量读取 |
| `GITLAB_INSECURE_TLS` | `0` | 为 `1` 时跳过 GitLab TLS 证书校验（内网自签名） |
| `GITLAB_API_TIMEOUT` | `15000` | GitLab API 单次请求超时毫秒数 |
| `REVIEW_BATCH_MAX_TOKENS` | `6000` | 单批评审 token 预算 |
| `REVIEW_TIMEOUT_MS` | `120000` | 单批评审/汇总超时毫秒数 |
| `REVIEW_RULES_DIR` | `prompts/rules` | 仓库规则目录 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` / `silent` |

`GITLAB_URL`、`GITLAB_TOKEN` 缺失时启动直接报错——服务「启动成功但每次拉取失败」比「起不来」更难排查。

本地开发可用 `.env`（复制 `.env.example`），启动时自动加载；已存在的同名环境变量优先。

## 运行

```bash
npm start
```

## 配置 GitLab webhook

1. GitLab 项目 → Settings → Webhooks → URL 填 `http://<host>:5001/review/webhook`。
2. 勾选 **Merge request events** 触发器（本服务只处理 `merge_request`，`push` 事件会返回 400）。
3. **来源校验**：本服务不校验 `X-Gitlab-Token` / Secret token——一个 GitLab 实例有多个项目，每个项目的 Secret token 各不相同，单实例无法用一份全局 secret 校验所有来源。来源保护由部署层负责（内网隔离、网关白名单等）。

服务收到事件后立即返回 200，真正的评审在后台串行队列中执行：拉取变更 → 分批评审 → 汇总 → 回写一条 MR 评论。

**已知边界**：后台队列在内存中，服务重启会丢正在排队的任务；GitLab 重试同一事件可能产生多条评论。这两项是已确认的简化，升级计划见设计文档。

## 仓库级 prompt

`prompts/rules/` 目录下：

- `default.yaml` — 全局默认规则，所有未单独配置的仓库生效。
- 其余 `.yaml` — 每仓库一份，必须含 `repository:` 字段（GitLab 项目全名，如 `rd-fy21-canway-GOAC/auto-ops`）。

规则结构：

```yaml
repository: team/app
code_review_prompt:
  system_prompt: |
    你是资深工程师，按以下要求评审……
  user_prompt: |
    代码变更内容：
    {diffs_text}

    提交历史：
    {commits_text}
```

`user_prompt` 支持 `{diffs_text}` 与 `{commits_text}` 两个占位符。匹配优先级：仓库规则 > `default.yaml` > `prompts/review.md`（全文作 system prompt 的最后兜底）。

## 日志

服务把每个处理步骤写到控制台，默认 `info` 即可看到完整流水线；`LOG_LEVEL=debug` 额外输出 pi 会话内部步骤。

```text
INFO  cr-pilot 正在启动 node=v22.19.0 logLevel=info
INFO  生效配置 host=127.0.0.1 port=5001 gitlabUrl=https://code.cwoa.net gitlabTokenSet=true ...
INFO  服务已开始监听 url=http://127.0.0.1:5001/review/webhook
INFO  MR 任务已入队 projectId=3483 iid=5327 fullName=rd-fy21-canway-GOAC/auto-ops
INFO  管线开始处理 MR projectId=3483 iid=5327 ...
INFO  已拉取 MR 变更 projectId=3483 iid=5327 changeCount=17 commitCount=2
INFO  分批完成 projectId=3483 iid=5327 batchCount=2
INFO  单批评审完成 ... batch=1/2 reviewChars=430 durationMs=28317
INFO  汇总完成 ... finalChars=894 durationMs=11872
INFO  评论已回写 GitLab projectId=3483 iid=5327
```

**日志不记录代码正文、评审正文与任何 token**，只记录长度、数量与耗时。

## 开发

```bash
npm test        # node --test；全部用例不调用真实模型与 GitLab，可离线运行
npm run typecheck
```

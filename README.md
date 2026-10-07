# cr-pilot

pi 驱动的 GitLab 代码评审服务。GitLab MR webhook 触发后，服务在后台拉取变更、按仓库自定义 prompt 分批评审、汇总成一份评论并回写到 MR。

## 代码架构

采用分层架构（依赖只指向内层，外层的具体实现通过端口注入内层用例）：

```text
src/
├── bootstrap.ts                 # 组合根：装配全部依赖并启动
├── interfaces/http/             # 表现层（≈ MVC 的 Controller）
│   ├── app.ts                   #   Express 路由：校验事件类型、入队、立即响应
│   ├── webhook-parser.ts        #   payload → MergeRequestTask（纯 DTO 映射）
│   └── server.ts                #   startServer：装配并监听端口
├── application/                 # 应用层（≈ MVC 的 Service，用例编排）
│   └── review-pipeline.ts       #   拉取 → 分批 → 逐批评审 → 汇总 → 回写
├── domain/                      # 领域层（纯业务规则与端口，零 IO）
│   ├── review-task.ts           #   MergeRequestTask/Change/Commit 模型 + Reviewer/GitlabClient 端口
│   ├── change.ts                #   token 估算与分批拆分（纯函数）
│   └── review-rules.ts          #   规则匹配与 prompt 渲染（纯函数）
├── infrastructure/              # 基础设施层（实现 domain 端口，≈ Repository/Adapter）
│   ├── gitlab/gitlab-client.ts  #   GitLab API 客户端
│   ├── pi/reviewer.ts           #   pi SDK 评审执行者
│   └── rules/review-rules.ts    #   YAML 规则目录读取
└── shared/                      # 横切共享（配置、日志、队列）
    ├── config.ts
    ├── logger.ts
    └── queue.ts
```

依赖方向：`interfaces → application → domain`；`infrastructure` 实现 `domain` 端口并由组合根注入。`domain` 不依赖任何外层，全部纯函数可离线测试。

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
| `GITLAB_URL` | 无（可选） | GitLab 实例地址。缺省时从 webhook 派生：优先 `X-Gitlab-Instance` 请求头，其次 payload `repository.homepage` 的 origin；显式配置可覆盖派生值，并兜底老版本 GitLab |
| `GITLAB_INSECURE_TLS` | `0` | 为 `1` 时跳过 GitLab TLS 证书校验（内网自签名） |
| `GITLAB_API_TIMEOUT` | `15000` | GitLab API 单次请求超时毫秒数 |
| `REVIEW_BATCH_MAX_TOKENS` | `120000` | 单批评审 token 预算（模型上下文 1M，可按需调大） |
| `REVIEW_TIMEOUT_MS` | `120000` | 单批评审/汇总超时毫秒数 |
| `REVIEW_RULES_DIR` | `prompts/rules` | 仓库规则目录 |
| `REVIEW_STYLE` | `professional` | 评审风格：`professional` / `sarcastic` / `gentle` / `humorous`，注入规则模板的 `{{ style }}` 与风格分支 |
| `QUEUE_CONCURRENCY` | `5` | 后台队列并发数：同时处理的 MR 评审任务上限 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` / `silent` |
| `LOG_FILE` | 空（仅控制台） | 日志文件路径：非空时日志双写控制台 + 该文件（目录自动创建）。Docker 部署建议 `/app/logs/cr-pilot.log`（compose 已挂载宿主机 `/data/logs/cr-pilot`） |

无任何必填配置。访问令牌随 webhook 请求头 `X-Gitlab-Token` 携带（每个项目独立，对齐参考项目），`GITLAB_URL` 之所以可选：现代 GitLab 的 webhook 请求头自带实例地址，服务在收到事件时派生（任务级优先于全局配置）。

本地开发可用 `.env`（复制 `.env.example`），启动时自动加载；已存在的同名环境变量优先。

## 运行

```bash
npm start
```

## Docker 部署

```bash
# 1. 准备 .env：cp .env.example .env，填入 LLMGW_API_KEY（pi 模型密钥）
#    Docker 部署建议同时设 LOG_FILE=/app/logs/cr-pilot.log
# 2. 准备宿主机日志目录
sudo mkdir -p /data/logs/cr-pilot
# 3. 构建并启动
docker compose up -d --build

# 健康检查
curl http://localhost:5001/health   # → {"status":"ok"}

# 查看日志（控制台 + /data/logs/cr-pilot/cr-pilot.log）
docker compose logs -f cr-pilot
tail -f /data/logs/cr-pilot/cr-pilot.log
```

**pi 凭证闭环**：镜像内置 `pi-agent/models.json` + `settings.json`（`PI_CODING_AGENT_DIR=/app/pi-agent`），其中 `apiKey` 用 `$LLMGW_API_KEY` 环境变量插值；`docker-compose.yml` 把宿主机 `.env` 挂载为 `/app/.env:ro`，应用启动时自动加载。全部配置（含模型密钥）只在一个 `.env` 文件里维护，不依赖宿主机 `~/.pi/agent` 挂载。

## 配置 GitLab webhook

1. GitLab 项目 → Settings → Webhooks → URL 填 `http://<host>:5001/review/webhook`。
2. 勾选 **Merge request events** 触发器（本服务只处理 `merge_request`，`push` 事件会返回 400）。
3. **访问令牌**：GitLab webhook 请求头自带 `X-Gitlab-Token`（项目配置的 Secret token 会被 GitLab 放入该头），服务用其调用 GitLab API 拉取变更与回写评论，每个项目的 token 各自独立，无需任何环境变量。
4. **来源保护**：服务不校验 token 本身（无法预知每个项目的值），来源保护由部署层负责（内网隔离、网关白名单等）。

服务收到事件后立即返回 200，真正的评审在后台队列中执行（并发数 `QUEUE_CONCURRENCY`，默认 5）：拉取变更 → 分批评审 → 汇总 → 回写一条 MR 评论。

**已知边界**：后台队列在内存中，服务重启会丢正在排队的任务；GitLab 重试同一事件可能产生多条评论。这两项是已确认的简化，升级计划见设计文档。

## 仓库级 prompt

`prompts/rules/` 目录下（已从参考项目 AI-CodeReview 的 `conf/review_rule/` 迁移 7 份真实规则）：

- `default.yaml` — 全局默认规则，所有未单独配置的仓库生效。
- `auto-ops.yaml` — 匹配 `auto-ops` / `cw-auto-ops` / `auto-ops-platform` / `ops-node-server` / `auto-screenshot`（短项目名，逗号分隔）。
- `cw-auto-ops.yaml` — 匹配 `rd-fy23-canway-kingark/auto-ops-v4/cw-auto-ops`（仅通知配置，无独立 prompt）。
- `ada.yaml` — 匹配 `cw-publish` / `app-mgmt`（应用发布中心）。
- `bcms.yaml` — 匹配 `cw-bcms-backend`（应急管理中心）。
- `chaos.yaml` — 匹配 `cw-chaos-backend`（混沌工程）。
- `demo.yaml` — 示例规则。

其余 `.yaml` 必须含 `repository:` 字段，支持逗号分隔多个仓库。匹配规则对齐参考项目：先按项目全名、再按短项目名（最后一个 `/` 之后的部分）查找，大小写不敏感。

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

- `user_prompt` 支持 `{diffs_text}` 与 `{commits_text}` 两个占位符。
- prompt 支持最小 Jinja2 模板：`{{ style }}` 变量与 `{% if style == '...' %} / {% elif ... %} / {% else %} / {% endif %}` 风格分支，`style` 由 `REVIEW_STYLE` 环境变量注入（默认 `professional`）。
- 匹配优先级：仓库规则 > `default.yaml` > `prompts/review.md`（全文作 system prompt 的最后兜底）。
- 规则文件可带企业微信推送配置：`wecom_webhook_url`（群机器人地址）与 `wecom_score_threshold`（评分阈值）。评审总分**低于**阈值时向该群推送提醒（缺省继承 `default.yaml` 的阈值；没有 webhook URL 则不推送）。

## 企业微信推送

评审回写 GitLab 成功后，按仓库规则推送企微：

- 从汇总评论文本解析总分（正则 `总分[:：]\s*(\d+)分?`，多批次取最低分）。
- `wecom_score_threshold` 语义：总分**低于**阈值才推送（低分提醒团队关注）；无阈值时不按分数过滤。
- 消息为企微 markdown 格式（标题 + MR/分支/评分 + 评审正文），超过 4096 字节自动截断。
- 推送失败只记日志，不影响已完成的评审回写。

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

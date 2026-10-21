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

模型厂商配置**由数据库管理**，在管理页面「AI 厂商」里维护（支持 OpenAI / DeepSeek /
Anthropic / 通义千问等多厂商，可指定每个项目用哪个厂商）。服务启动时把数据库配置
导出到 `pi-agent/models.json`，并把密钥写入进程环境变量供 pi SDK 读取。

配置目录由 `PI_CODING_AGENT_DIR` 指定，默认 `pi-agent/`。该目录下的文件分工：

| 文件 | 是否入库 | 作用 |
|---|---|---|
| `models.template.json` | ✅ | **初始配置模板**。数据库为空时用它兜底，保证新机器首次部署能启动 |
| `models.json` | ❌ 运行时生成 | 由数据库配置导出，改一次厂商就会变，故不入库（`.gitignore`） |
| `settings.json` | ❌ 运行时生成 | 同上，记录 `defaultModel` |
| `auth.json` | ❌ | pi SDK 的凭证缓存（含密钥） |
| `models-store.json` | ❌ | pi SDK 的运行期缓存 |

`models.template.json` 的形状：

```json
{
  "providers": {
    "llmgw": {
      "baseUrl": "https://llmgw.cwoa.net/v1",
      "api": "openai-responses",
      "apiKey": "$LLMGW_API_KEY",
      "models": [
        {
          "id": "gpt-5.6-terra",
          "name": "gpt-5.6-terra",
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "reasoning": false,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

`apiKey` 必须是 `$环境变量名` 形式的引用，**不要写明文**——生成 `models.json` 时
原样保留这个引用，实际密钥从数据库导出到同名环境变量。

`settings.json` 的 `defaultModel` 决定默认模型。校验方式：

```bash
npx pi auth check --provider llmgw --json   # 期望 {"status":"ready",...}
npx pi --list-models                        # 期望能列出上面声明的模型
```

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `5001` | 主监听端口（API 与 webhook） |
| `UI_PORT` | `5002` | 管理界面端口，与 `PORT` 提供完全相同的服务。设 `0` 关闭第二端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `GITLAB_URL` | 无（可选） | GitLab 实例地址。缺省时从 webhook 派生：优先 `X-Gitlab-Instance` 请求头，其次 payload `repository.homepage` 的 origin；显式配置可覆盖派生值，并兜底老版本 GitLab |
| `GITLAB_INSECURE_TLS` | `0` | 为 `1` 时跳过 GitLab TLS 证书校验（内网自签名） |
| `GITLAB_API_TIMEOUT` | `15000` | GitLab API 单次请求超时毫秒数 |
| `REVIEW_BATCH_MAX_TOKENS` | `120000` | 单批评审 token 预算（模型上下文 1M，可按需调大） |
| `REVIEW_TIMEOUT_MS` | `1200000` | 单批评审/汇总超时毫秒数（默认 20 分钟） |
| `REVIEW_RULES_DIR` | `prompts/rules` | 仓库规则目录（首次启动可用导入接口或脚本写入数据库） |
| `REVIEW_STYLE` | `professional` | 评审风格：`professional` / `sarcastic` / `gentle` / `humorous`，注入规则模板的 `{{ style }}` 与风格分支 |
| `QUEUE_CONCURRENCY` | `5` | 后台队列并发数：同时处理的 MR 评审任务上限 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` / `silent` |
| `LOG_FILE` | 空（仅控制台） | 日志文件路径：非空时日志双写控制台 + 该文件（目录自动创建）。compose 已固定为 `/app/logs/cr-pilot.log`，宿主机路径 `/data/logs/cr-pilot/cr-pilot.log` |
| `DB_PATH` | `./data/cr-pilot.db` | SQLite 数据库文件路径。容器内固定 `/app/data/cr-pilot.db`（挂载具名卷 `cr-pilot-data`）。**必须落在本地盘**：WAL 模式不支持网络文件系统 |
| `ADMIN_USERNAME` | 空 | 首次启动引导创建的管理员用户名，仅在管理员表为空时生效 |
| `ADMIN_PASSWORD` | 空 | 首次启动引导创建的管理员密码；留空则跳过创建（空密码无法登录），启动告警 |
| `AUTH_SALT` | 无（**必填**） | 令牌与密码盐的部署盐。令牌由「用户名 + 此盐」离线派生，留空等于任何人都能算出管理令牌，**服务拒绝启动**。生成：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` |

访问令牌随 webhook 请求头 `X-Gitlab-Token` 携带（每个项目独立，对齐参考项目），`GITLAB_URL` 之所以可选：现代 GitLab 的 webhook 请求头自带实例地址，服务在收到事件时派生（任务级优先于全局配置）。

本地开发可用 `.env`（复制 `.env.example`），启动时自动加载；已存在的同名环境变量优先。**数据库覆盖优先**：管理页面写入的配置存于数据库，启动时覆盖同名环境变量。

### 配置生效时机

管理页面的「环境变量」页保存后，配置写入数据库并在**重启容器后生效**（消费方在构造时持有快照，写入 `process.env` 不会让已构造的队列、管线、日志器与 GitLab 客户端重新读取）。页面会明确标注需重启的项；`DB_PATH`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` 为只读，只能通过 `.env` 修改。

配置项在页面上按用途分组展示：**AI 模型 / GitLab 集成 / 评审行为 / 服务与存储 / 账号与安全**。
其中 AI 模型的 API 地址、密钥与模型清单**不在环境变量页编辑**——多厂商配置需要成组管理，
统一收敛到「AI 厂商」页（见下文），环境变量页只保留跳转指引，避免两处都能改造成事实源分叉。

### prompt 生效时机

与配置不同，prompt 保存在数据库后**下一次评审立即生效**（评审管线每次任务都重新读取），无需重启。

## Prompt 管理

评审 prompt 以数据库为准，yaml 文件降级为初始导入源与兜底。三种落地方式：

```bash
# 方式 1：管理页面「Prompt 管理」→「从 yaml 导入」（推荐）
# 方式 2：命令行脚本（读取同一 .env 与 DB_PATH，幂等可重复执行）
npm run import:prompts
# 方式 3：直接调用接口
curl -X POST http://localhost:5001/api/prompts/import -H "Authorization: Bearer <token>"
```

匹配优先级：**数据库项目记录 > 数据库 `default` 记录 > `prompts/rules/*.yaml` > `prompts/review.md` 兜底**。

### 多项目关联

一条 prompt 可以同时关联多个 GitLab 项目，任一项目命中即使用该 prompt。页面上的「关联项目」是标签式多选框：

- 从下拉选择已有项目，或直接输入新项目名回车添加
- 点标签上的 `×` 删减关联，保存即生效
- `default` 是全局兜底，不绑定任何项目

从 yaml 导入时，`repository` 里的逗号串会被拆成多个项目。例如
`repository: auto-ops,cw-auto-ops,auto-ops-platform` 会生成一条 prompt 关联三个项目，
导入后仍可在页面上自由增删。

## AI 厂商配置

模型厂商支持配置多个，页面「AI 厂商」页管理（D-021 / D-022）：

- 每个厂商独立配置 **API 地址 / API Key / 协议类型 / 模型清单 / 默认模型**
- 内置模板：OpenAI、DeepSeek、Anthropic、通义千问、智谱 GLM、月之暗面 Kimi，以及任意 OpenAI 兼容的自定义网关
- 保存后自动生成 `pi-agent/models.json` 并同步 `settings.json`，下一次评审即生效
- 密钥以 `$LLM_KEY_<NAME>` 形式写入 models.json，**文件里不落明文**；实际密钥存数据库并导出到进程环境变量
- 读取接口只回掩码（如 `sk-t****3456`），留空保存表示不修改

模型选择优先级：**项目级绑定 > prompt 上指定的厂商 > 全局默认厂商 > `models.json` 既有配置**。

项目级绑定在「AI 厂商 → 项目级模型绑定」里设置，可把某个项目钉到指定厂商与模型。

## 管理控制台

内置管理前端（Vue 3 + Vite + Element Plus），包含六个模块：管理员登录、评审记录与统计、prompt 管理、AI 厂商配置、环境变量管理、管理员账号管理。

- 访问 `http://<host>:5001/` 进入控制台，未登录自动跳转登录页
- 首次部署需在 `.env` 设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`AUTH_SALT`（`AUTH_SALT` 必填，留空拒绝启动）
- 所有管理接口位于 `/api/*`，使用 `Authorization: Bearer <token>`（令牌由登录接口下发，存于浏览器 localStorage）
- 管理员账号：禁止删除当前登录账号，也禁止删除最后一个管理员
- **首屏部署检查**：启动日志会显示数据库路径与配置覆盖项数；prompt 未导入数据库时会走 yaml 兜底，可用「Prompt 管理 → 从 yaml 导入」补齐
- 支持亮色/暗色主题切换（顶栏月亮图标），偏好存于 localStorage

### 行内评论

评审会为**能精确定位到行**的问题发布 GitLab 行内评论（`/discussions`，带 position），无法定位的问题仍进入汇总评论。保证内容不丢失：

- 结构化输出约定已内置在 `prompts/rules/default.yaml`：模型需回显 `reviewed_head_sha`（服务端把当前 head sha 注入 user prompt 的 `{head_sha}` 占位符）
- AI 输出按 JSON schema 校验（`new_line` 与 `old_line` 互斥，需 40 位 head sha）
- 行号必须落在该文件的 diff 变更行上，否则降级进汇总
- 评审期间的 head 与当前 head 不一致时全部降级进汇总
- 单条发布失败只影响该条，其余继续；汇总评论会带上「无法定位到行的问题」段落
- 已成功发行内评论的条目会从汇总评论中剔除，避免同一问题出现两次
- 每条评论带 `<!-- marker:{head_sha}:{批次}:{id} -->` 幂等标记，webhook 重复触发不会刷屏
- 其他仓库的规则文件需包含与 `default.yaml` 相同的「行内评论定位块」约定，否则该仓库一律走汇总评论

## 运行

```bash
npm start
```

前端开发（可选）：

```bash
npm run dev:frontend   # Vite 开发服务器 http://localhost:5173，自动代理 /api 与 /review/ 到后端 5001
npm run build:frontend # 构建产物到 dist/，由 Express 托管
```

开发时前后端端口分工：**前端 5173（Vite dev server）、后端 5001（Express）**。
Vite 用 `strictPort: true`，5173 被占用时直接报错而不是静默切换端口。
注意：Vite 只在本地开发时用；Docker 部署时前端已构建成静态文件由后端 5001 托管，
不存在 5173/5002 端口。

## Docker 部署

```bash
# 1. 准备 .env：cp .env.example .env
#    必填：AUTH_SALT（管理令牌盐，建议 32 位随机串）
#    首启：ADMIN_USERNAME + ADMIN_PASSWORD（仅在账号表为空时创建）
#    模型密钥：可在「AI 厂商」页配置，或保持模板里的 $LLMGW_API_KEY 并在此填值
# 2. 构建并启动（Dockerfile 内含前端构建阶段，首次约 1-2 分钟）
docker compose up -d --build

# 健康检查（两个端口都提供）
curl http://localhost:5001/health   # → {"status":"ok"}
curl http://localhost:5002/health   # → {"status":"ok"}

# 管理控制台（两个端口任选，服务内容完全相同）
# 浏览器打开 http://<host>:5001/ 或 http://<host>:5002/，
# 用 ADMIN_USERNAME / ADMIN_PASSWORD 登录

# 查看日志（控制台 + 容器内 /app/logs/cr-pilot.log）
docker compose logs -f cr-pilot
docker compose exec cr-pilot tail -f /app/logs/cr-pilot.log

# 升级已有部署：把既有 yaml prompt 导入数据库（幂等）
docker compose exec cr-pilot node scripts/import-prompts.ts
```

**不需要手动构建前端**：Dockerfile 的 `frontend` 阶段会在容器内执行 `npm run build`，
产物落到 `/app/dist` 并由 Express 托管。

**构建时 apk 拉取失败**：runner 阶段要装 `su-exec`（entrypoint 降权用）。若日志出现
`WARNING: fetching https://dl-cdn.alpinelinux.org/...: TLS: unspecified error`，随后紧跟
`ERROR: unable to select packages: su-exec (no such package)`，说明是索引拉取失败而非包名错误
（缺包是拿不到索引后的连锁报错）。镜像默认把 apk 源换成阿里云
（`ARG APK_MIRROR=mirrors.aliyun.com`；只替换仓库地址的 `://主机` 段，保留
`/alpine/vX.Y/main|community` 路径）。海外或内网环境可覆盖：

```bash
docker compose build --build-arg APK_MIRROR=dl-cdn.alpinelinux.org   # 回到官方源
docker compose build --build-arg APK_MIRROR=<内网 apk 镜像主机名，可带 :端口>
docker compose build --build-arg APK_MIRROR=                          # 留空：沿用基础镜像自带源
```

**双端口说明**：容器同时监听 **5001** 和 **5002**，两者由同一个 Express 实例提供服务，
页面与 API 完全一致。这是为对齐团队既有约定（旧项目 5001=Flask API、5002=Streamlit UI），
让既有运维脚本与书签无需改动。本项目只有一个进程，没有第二个服务，因此不需要 Nginx。
可用 `UI_PORT=0` 关闭第二端口，只保留 5001。

**挂载点**：

| 容器内 | 宿主机 | 类型 | 说明 |
|---|---|---|---|
| `/app/logs` | `/data/logs/cr-pilot` | bind mount | 日志文件 `cr-pilot.log`，可直接 tail、归档、接入日志采集 |
| `/app/data` | 具名卷 `cr-pilot-data` | named volume | SQLite 库。用卷而非宿主机路径：必须本地盘，且避免属主问题 |
| `/app/prompts` | `./prompts`（仓库目录） | bind mount（只读） | 规则 yaml 与兜底 prompt |

日志按路径直接查看：

```bash
tail -f /data/logs/cr-pilot/cr-pilot.log
```

> **挂载目录的属主问题**：容器以 `node`（uid 1000）运行，但两个目录的属主都不受镜像控制——
> 具名卷首次挂载时 Docker 把**卷根目录属主设为 root**；bind mount 的宿主机目录不存在时
> 也由 Docker 以 root 创建。因此镜像带了一个 entrypoint（`docker-entrypoint.sh`）：
> 启动时以 root 递归修正 `/app/data`、`/app/logs` 的属主，再用 `su-exec` 降权到 `node`。
> 这意味着**不需要手工预建目录或 chown**，但也**不要**在 compose 里设 `user:` 为非 root，
> 否则修正属主那一步会被跳过。

如果启动报 `unable to open database file`，通常是卷属主问题。排查与修复：

```bash
# 看卷根目录属主（应为 root，entrypoint 会在启动时改）
docker compose run --rm --entrypoint sh cr-pilot -c 'ls -ld /app/data /app/logs'

# 手工修正（通常不需要，entrypoint 已处理；用于历史卷遗留 root 文件的情况）
docker compose run --rm --user root --entrypoint sh cr-pilot -c 'chown -R node:node /app/data /app/logs'
```

备份或迁移数据：

```bash
# 数据卷实际落在 /var/lib/docker/volumes/cr-pilot_cr-pilot-data/_data
docker run --rm -v cr-pilot_cr-pilot-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/cr-pilot-data.tar.gz -C /data .
```

**pi 模型配置**：镜像内置 `pi-agent/models.template.json`（`PI_CODING_AGENT_DIR=/app/pi-agent`），
数据库为空时用它兜底；有厂商配置后由数据库导出 `models.json`。`docker-compose.yml` 通过
`env_file` 注入 `.env`，应用启动时自动加载，不依赖宿主机 `~/.pi/agent` 挂载。

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
- 消息末尾会 @ 提交人：在「企微映射」页登记 GitLab 账号与企微 userid 后是**真实成员提醒**；只登记企微姓名时退化为纯文本 `@中文名`，仅展示、不会推送通知。未登记任何映射时使用 GitLab 作者显示名做纯文本展示。
- userid 由企微管理后台分配（通讯录 → 成员 → 账号），需由管理员提供；服务不会拿 GitLab 账号当 userid 使用。
- 推送失败只记日志，不影响已完成的评审回写。

## 评审建议采纳追踪

系统会记录每条行内评审建议（带被评论行的代码指纹），并在 MR 有新提交时判定该行是否真的被改动，统计页按项目、提交人、严重级展示采纳率。

- **口径**：采纳率 = 代码已变化的建议数 ÷ 可统计建议数。指纹只能证明目标行变了，不能证明改得对，因此这是「代码变化率」而非「修复正确率」。
- **不可统计部分单列**：降级并入汇总评论的建议（无行锚点）与文件被删除/大重构导致无法定位的建议都不计入分母。
- 追踪由独立定时器执行，默认每 10 分钟一轮；`ADOPTION_TRACKING_ENABLED=false` 可关闭，`ADOPTION_SYNC_INTERVAL_MS` 调整间隔。
- 功能上线前的评审没有建议明细，统计只覆盖上线后的数据。

## 功能自检

不用等真实 MR 合并，直接验证 AI 评审与企微推送两条链路。有两种入口：

**页面**：登录后打开左侧「功能自检」，两个按钮分别验证：

- 「开始验证 AI 评审」：真实调用一次模型，返回输出摘要与解析出的总分
- 「发送验证消息」：二次确认后真的发到群里；「仅预览」只组装不发送

页面采用异步任务 + 轮询：AI 评审约需 1 分钟，同步请求容易被超时截断。

**命令行**：

```bash
npm run verify:ai                        # 真实调用模型评审一段样例 diff，断言能解析出总分
npm run verify:wecom                     # 只打印企微消息预览，不发送
npm run verify:wecom -- --confirm-send   # 真实发送到规则里配置的群
npm run verify:all -- --confirm-send     # 全链路：AI 真实评审 → 消息组装 → 企微发送
```

CLI 参数：

- `--confirm-send`：不加只预览；加上才真正发群消息。
- `--webhook <url>`：覆盖规则文件里的群地址，用于发到测试群。
- `--repository <group/project>`：按指定仓库规则解析 webhook；不指定时自动找第一个配置了地址的规则。

页面与 CLI 共用同一份验证实现（`src/application/feature-verifier.ts`），行为一致。

验证脚本不写数据库、不发 MR 评论、不改仓库文件。企微消息固定以 `[验证]` 开头并注明发送时间，避免被误认为真实评审提醒。

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

## 接口文档

完整 OpenAPI 3.0 规范在 [`docs/openapi.json`](docs/openapi.json)，覆盖全部 32 个接口。

规范由脚本从代码生成，**不是手写**——改接口后重新生成即可，避免文档与实现漂移：

```bash
npm run build:openapi   # 生成 docs/openapi.json
npm run sync:apifox     # 导入到 Apifox 项目「AI Code Review」
```

`sync:apifox` 需要 `APIFOX_ACCESS_TOKEN`（环境变量或 `.agent/.env`）。
覆盖策略是「同 method+path 原地更新」，因此可重复执行而不会产生重复接口。

接口按 tag 分为 8 组：系统、Webhook、认证、评审记录、Prompt 管理、AI 厂商、环境变量、管理员账号。

### 权限边界

- `/health`、`/review/webhook`、`/api/auth/login` 免鉴权
- `/api/admins` 整组要求管理员权限（非管理员返回 403）
- 其余 `/api/*` 所有登录账号可用

管理员身份由部署配置 `ADMIN_USERNAME` 决定：该账号即启动引导创建的那个，其余账号都是普通账号且无法在页面上提升。改动该配置会让原管理员失去权限，启动日志会打印当前管理员账号名。

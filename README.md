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
| `REPOSITORY_CLONE_TIMEOUT_MS` | `120000` | 开启项目的仓库 clone/fetch/索引总超时毫秒数；环境配置，修改需重启 |
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

### 修改名称

编辑任意 Prompt 时可修改「名称」，保存后列表立即显示新名称，关联项目、仓库规范和项目开关都保留。改名受以下约束：

- 新名称不能为空，最长 200 字符；
- 不能与其他 Prompt 重名，冲突返回 409 且本次修改整体不生效；
- `default` 是全局兜底的保留名称，本身不可改名，其他 Prompt 也不能改名为 `default`；
- 只包含 `/` 等名称映射关系不变：改名不会改变 Prompt 与项目的关联。

### 多项目关联

一条 prompt 可以同时关联多个 GitLab 项目，任一项目命中即使用该 prompt。页面上的「关联项目」是标签式多选框：

- 从下拉选择已有项目，或直接输入新项目名回车添加
- 点标签上的 `×` 删减关联，保存即生效
- `default` 是全局兜底，不绑定任何项目，名称不可修改

从 yaml 导入时，`repository` 里的逗号串会被拆成多个项目。例如
`repository: auto-ops,cw-auto-ops,auto-ops-platform` 会生成一条 prompt 关联三个项目，
导入后仍可在页面上自由增删。

### 项目评审白名单

只有在「Prompt 管理」中明确关联到非 `default` Prompt 的项目才允许发起 MR 评审。白名单直接读取该页面保存的关联，不抓取页面、不维护第二份名单，也不以 Prompt 的展示名称作为项目名。

- 未关联项目的完整评审 webhook 返回 **403**：`项目未在 Prompt 管理中配置，拒绝评审`。请求不进入评审队列，不查询作者、不拉取代码、不调用模型、不发布评论或通知。
- 白名单检查器未装配或数据库读取异常时返回 **503**：`读取项目评审白名单失败，拒绝评审`，不使用默认配置放行。
- `default`、尚未导入数据库的 YAML 项目规则和 Markdown 兜底均不能授予评审资格。空名单会拒绝全部新评审；升级前应先在页面关联所需项目，或完成 YAML 导入并核对关联。
- 匹配沿用既有完整路径、短名、大小写和首尾空白兼容规则。短名可能匹配不同命名空间的同名项目，需要精确控制时请填写完整 `namespace/project`。
- 页面新增、修改或删除关联对下一次检查立即生效，无需重启。队列任务真正开始前会再检查一次，防止排队期间移除项目后仍执行；已经开始的任务不强制中断。
- 历史建议的定时采纳追踪及其 webhook 分流保持不变；若未装配追踪入口而回退为完整评审，则同样受白名单限制。

项目白名单是业务范围限制，不能替代部署层的 webhook 来源校验和任务级 GitLab 凭据权限。

### 可选仓库上下文与仓库规范

在「Prompt 管理 → 仓库设置」中逐项开启“拉取仓库进行 Review”。项目名可以是完整路径（如 `group/project`），也可以是存量短名（如 `auto-ops`）。旧数据、新项目、未配置项目均默认关闭；同一项目关联多个 Prompt 时共享一个开关，最后一个关联删除后清除开关，重新关联默认关闭。

短名按“路径结尾”匹配真实 MR 项目：`auto-ops` 可匹配 `group/auto-ops`。同一 Prompt 内同时存在 `auto-ops` 与 `group/auto-ops` 时，精确或更长的关联优先，不会套用更宽泛短名的开关，也不会继承另一条 Prompt 的设置。**仓库地址始终由本次 MR 的源项目 API 返回，界面上的项目名从不用于拼接 clone 地址**，因此短名不会造成拉错仓库；但短名仍可能同时匹配多个同结尾项目，需要精确控制时请使用完整路径。

“仓库规范”与 System/User Prompt 独立保存，供同一 Prompt 的关联项目共享，可留空（最多 32,000 字符）。建议写清整个仓库的架构、模块边界、接口、数据、安全、日志、测试和性能要求。只有开启项目会使用该规范；关闭不删除规范。保存只影响后续开始的评审，不扫描无关历史问题。

开启后使用**任务携带的 GitLab token**，需要 Git 仓库读取权限（例如 `read_repository`，同时保留原有 API/评论权限）。不读取示例中的用户名密码，也不新增页面密码配置。服务使用 MR API 的固定 diff version（包含 diff、commits 和 refs），从源项目而非猜测目标项目获取仓库地址，支持 fork。版本协议见 [GitLab MR API](<https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request-diff-version>)。

拉取采用单分支浅克隆（`--single-branch --depth=1 --no-checkout`）；若分支已推进，仅补取一次评审 SHA。模型通过受限的文件列表、字面量搜索和文本读取工具核对上下文，不检出工作树，不执行目标仓库脚本、hooks、filters、LFS 或子模块，也不开放命令执行/写文件工具。仓库配置不会成为模型会话的自动加载资源。

运行要求和限制：

- 本机需可用的 `git` 和可信 CA；新 runner 镜像包含 Git 与 CA，**更新源码但继续运行旧镜像不保证具备 Git**。生产建议 HTTPS 与可信企业 CA；HTTP 不加密 token，显式 `GITLAB_INSECURE_TLS` 关闭校验也有中间人风险，不能自动降级。
- 仓库地址限同一任务 GitLab origin，禁止带凭据和重定向。凭据不写 URL、命令参数、日志、仓库配置或模型输入；子进程环境仍不提供同一 OS 用户之间的秘密隔离。
- 准备总超时 `REPOSITORY_CLONE_TIMEOUT_MS=120000`（环境配置，修改需重启）。默认监测仓库 512 MiB、索引最多 50,000 条；超限、拉取失败、版本不可得或 diff 截断会**终止本次 Review 并记录失败**，不静默降级。
- 单文件最多 256 KiB、每次最多 200 行/16,000 字符；搜索每次最多 200 文件/4 MiB/50 命中；每会话最多 40 次工具调用/128,000 字符。分页和截断会明确传给模型。模型按需读取，不保证遍历整个仓库。
- 拒绝常见凭据文件、符号链接、二进制、LFS 指针和依赖/生成目录；无法保证发现任意源码内硬编码秘密。项目必须已获准向所选模型发送相关源码。
- 每任务临时目录独立，正常/异常/超时结束都等待读取和子进程停止后清理；进程被系统强杀仍可能遗留系统临时目录下的 `cr-pilot-repo-*`，运维可在确认无活动任务后清理。磁盘监测存在采样窗口，不是操作系统硬配额。
- 项目配置沿既有名称级模型：不同 GitLab 实例的同名完整路径共享开关，不能冒充逐实例租户隔离；实际仓库和 token 始终按任务隔离。

升级前停止配置写入并关闭服务连接，制作可恢复的一致性 SQLite 备份；WAL 模式不能仅复制运行中的主 DB 文件。升级为增量加表加列，旧配置全部关闭。回退前先关闭仓库开关，不自动删除新表/列；旧代码不会维护新设置，重新升级会忽略或清理已无有效关联的状态。恢复旧备份会丢失备份后的合法写入，需在停写窗口人工选择，不混用旧 DB 与运行中的 WAL。

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
- GitLab 作者名形如 `王秦[wangqin]` 且账号为 `wangqin` 时，通知只展示 `@王秦`，评审记录仍保留原名。GitLab 只提供英文名时不能自动猜出中文名，需在「企微映射」中登记。
- 未成功解析 MR 作者或姓名无法安全展示时，消息仍发送但不提及其他人，并记录「本次企微通知未追加提交人提及」及原因。
- userid 由企微管理后台分配（通讯录 → 成员 → 账号），需由管理员提供；服务不会拿 GitLab 账号当 userid 使用。映射列表与保存响应只给中间 `**` 的掩码和“已配置”标记，不下发完整 userid；编辑时留空保留原值，清除需显式勾选。
- 推送失败只记日志，不影响已完成的评审回写。

## 评审建议采纳追踪

系统会记录每条行内评审建议（带被评论行的代码指纹），在 MR 有新提交时重新定位该行，并在 MR 合并或关闭时收口仍待判定的建议。统计页按项目、提交人、严重级分别展示等待判定数与采纳率。

- **口径**：采纳率 = 代码已变化的建议数 ÷ 已完成判定的可统计建议数。指纹只能证明目标行变了，不能证明改得对，因此这是「代码变化率」而非「修复正确率」。等待判定的建议不按未采纳计入分母。
- **终态收口**：MR 合并/关闭时，目标行变化记为已采纳；目标行未变且讨论已解决记为“已解决但代码未变”；未变且未解决记为未采纳。opened 且 head 未变时继续等待。
- **不可统计部分单列**：降级并入汇总评论的建议（无行锚点）与历史上无法可靠判定的建议不计入分母。文件明确删除、整体重写或原指纹消失均属于代码变化，记为已采纳；限流、权限、超时和 5xx 保留原状态并在下一轮重试。行内评论**发布失败但位置合法**的建议保留指纹继续追踪。
- **失败回写不丢证据**：行内评论已经发布后，即使最终汇总评论被 GitLab/WAF 拒绝，建议明细仍关联本次失败记录落库，避免 GitLab 有评论而统计缺失。
- **诊断日志**：每轮输出扫描候选、实际判定、终态收口、等待新提交、已是最新判定、缺少凭据、版本不可用和失败数量；不再用一个“待处理”数字混合不同原因。
- 新提交、合并或关闭 webhook 会立即触发 single-flight 追踪；独立定时器仍按默认每 10 分钟兜底。`ADOPTION_TRACKING_ENABLED=false` 可关闭，`ADOPTION_SYNC_INTERVAL_MS` 调整间隔。
- 功能上线前的评审没有建议明细，统计只覆盖上线后的数据；同一 GitLab 实例、同一 MR 的后续 webhook 会刷新可追踪 pending 的任务凭据。实例地址为空或无法确认归属的旧数据不会跨实例猜测绑定，日志会明确计入缺少凭据。

## 功能自检

不用等真实 MR 合并，直接验证 AI 评审与企微推送两条链路。有两种入口：

**页面**：登录后打开左侧「功能自检」，两个按钮分别验证：

- 「开始验证 AI 评审」：真实调用一次模型，返回输出摘要与解析出的总分
- 企微验证前先选择「企微机器人」与「测试提交人」：机器人从**实际生效的规则**获得（数据库项目规则优先，再到数据库 default；未命中数据库时才回落 YAML），按 webhook 地址去重，因此多个项目可共用一台。页面只显示脱敏 key，不接触完整地址；提交人列表来自已有「企微映射」，不会自动选取登录者或第一条记录。
- 「发送验证消息」：二次确认后真的发到群里；「仅预览」只组装不发送。两条路径都会在消息最后一行带上所选提交人：配置 userid 时发群消息使用完整标识以触发真实提醒，但预览及任务结果只显示中间 `**` 的掩码；只有中文名时仅展示 `@中文名`。
- 没有映射时先到「企微映射」页登记；映射被删除或不可用时验证失败，不会发送一条缺少提及却显示验证通过的消息。若某台机器人发送失败，先看任务结果：映射/配置变更错误表示未发出；HTTP 状态或企微 `errcode` 表示请求已到外部边界，需核对脱敏机器人标识与企微群配置。

机器人地址由服务端按所选 id 解析，自检接口不接受任意 URL。页面采用异步任务 + 轮询：AI 评审约需 1 分钟，同步请求容易被超时截断。

**命令行**：

```bash
npm run verify:ai                        # 真实调用模型评审一段样例 diff，断言能解析出总分
npm run verify:wecom                     # 只打印企微消息预览，不发送
npm run verify:wecom -- --confirm-send   # 真实发送到规则里配置的群
npm run verify:all -- --confirm-send     # 全链路：AI 真实评审 → 消息组装 → 企微发送
```

CLI 参数：

- `--confirm-send`：不加只预览；加上才真正发群消息。
- `--webhook <url>`：覆盖 CLI 默认从 YAML 选中的群地址，仅供本机运维发到测试群；页面接口不接受任意 URL。

页面与 CLI 共用[自检用例](<src/application/feature-verifier.ts>)。页面会额外选择测试提交人并验证末行提及；现有 CLI 未传入提交人，只验证模型与发送通道，结果会注明「未验证 @ 提交人」。

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

单批评审失败时最多尝试 3 次（仅重试空文本、超时、网络抖动等瞬时故障；鉴权/参数错误不重试）。重试仍失败的批次会被跳过，其余批次继续评审，改评评论仍会回写，但记录与日志会标出被跳过的批次，避免把不完整结果当成完整评审。所有批次都失败时不回写评论，按失败结束。

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

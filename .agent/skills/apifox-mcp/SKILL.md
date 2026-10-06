---
name: apifox-mcp
description: |
  Apifox MCP 客户端技能：与 Apifox 云端通过 MCP 协议交互，完成项目发现、结构读取、实体详情、OpenAPI 导入/导出、HTTP 接口 CRUD、测试用例管理等操作。

  触发分支（前置词均为独立触发点）：
  - discover / 发现 —— 需要列出可访问项目、读取项目摘要、浏览结构
  - read / 读取 —— 读取单个实体详情（endpoint / schema / markdown）
  - sync / 同步 —— exportData 导出 OpenAPI 到本地缓存，或 importData 导入
  - endpoint / 接口 —— createHttpEndpoint / updateHttpEndpoint / deleteHttpEndpoint / getHttpEndpoint
  - testcase / 测试用例 —— listTestCases / getTestCase / createTestCase / updateTestCase / deleteTestCase
  - escape / 逃生口 —— listOpenApiEndpoints / getOpenApiDetails / executeOpenApi
  - cache / 缓存 —— 本地 .apifox/{projectId}_{safeName}.settings.json 的刷新与 TTL 管理
  - handshake / 握手 —— 手动完成 initialize → notifications/initialized → 后续调用
disable-model-invocation: false
---

# Apifox MCP 技能

> 触发词：`discover` / `read` / `sync` / `endpoint` / `testcase` / `escape` / `cache` / `handshake`

本技能封装与 Apifox 云端 MCP 服务器的交互：握手、工具调用、参数封装差异、本地缓存约定与常见坑点。

## 凭证与配置

| 位置 | 内容 |
|---|---|
| `.agent/.env` | `APIFOX_ACCESS_TOKEN=afxp_...`（Personal Access Token） |
| `.mcp.json` | 注册 server `apifox-new-mcp` → `https://apifox.com/api/v1/mcp`，headers：`Authorization: Bearer ${APIFOX_ACCESS_TOKEN}`、`X-Apifox-Api-Version: 2025-09-01` |

> `.agent`、`.apifox`、`.mcp.json` 均在 `.gitignore`，凭证不入库。

## 握手流程（必须按序）

```
POST https://apifox.com/api/v1/mcp
Headers: Authorization, X-Apifox-Api-Version, Content-Type: application/json,
         Accept: application/json, text/event-stream

1. initialize
   { "jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                 "clientInfo": { "name": "...", "version": "1.0" } } }
   → 200，响应头 `mcp-session-id: <uuid>`，body 含 serverInfo.name=apifox-mcp-server

2. notifications/initialized
   { "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }
   → 202 且 body 为空，无 JSON-RPC 响应。这是正常应答，不是错误。

3. 之后每个 tools/call 都要带 Header `mcp-session-id: <uuid>`
```

会话是服务端的：进程退出即失效，但同一次运行内的多次调用共用一个 session。

> **坑点**：未握手直接 `tools/list`，或后续调用不带 `mcp-session-id`，都返回 HTTP 400；`Accept` 缺 `text/event-stream` 返回 406。

## 工具全景（18 个）

| 分组 | 工具 | 参数风格 |
|---|---|---|
| 发现 | `listAccessibleProjects`、`getProjectSummary`、`getStructureInfo`、`readEntityDetails` | **扁平** |
| 文档 IO | `importData`、`exportData` | **嵌套** |
| HTTP 接口 CRUD | `getHttpEndpoint`、`createHttpEndpoint`、`updateHttpEndpoint`、`deleteHttpEndpoint` | **嵌套** |
| 测试用例 | `listTestCases`、`getTestCase`、`createTestCase`、`updateTestCase`、`deleteTestCase` | **嵌套** |
| 逃生口 | `listOpenApiEndpoints`、`getOpenApiDetails`、`executeOpenApi` | 混合 |

**扁平**指业务字段直接放 `arguments`；**嵌套**指包在 `pathParams` / `queryParams` / `headers` / `body` 里。两套混用会直接参数校验失败。

字段命名也不统一：`getHttpEndpoint` / `deleteHttpEndpoint` 用 `pathParams.httpApiId`，`updateHttpEndpoint` 用 `pathParams.http_api_id`。逐工具的准确签名见 [工具参数参考](reference/tool-reference.md)。

## 调用信封

`tools/call` 的请求与响应都是 JSON-RPC：

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "<工具名>", "arguments": { } } }
```

响应把真正的数据塞在 `content[0].text`，且是**字符串化的 JSON**，需二次解析：

```json
{ "result": { "content": [ { "type": "text", "text": "{\"data\":…}" } ] } }
```

失败时仍返回 HTTP 200，用 `isError: true` 与 `text` 里的 `MCP error -32602: …` 表达。脚本已处理这两层，无需手工解析。

## 本地缓存约定（来自服务端 agentHints）

- 文件：`.apifox/{projectId}_{safeName}.settings.json`
- 根节点必须包含 `fetchedAt: "<ISO 时间戳>"`
- **TTL 30 分钟**：`fetchedAt` 超 30 分钟、文件不存在、内容无效、下游工具报结构 ID 不存在、或用户要求刷新时 → 重新 `getProjectSummary` 并覆盖缓存
- 服务端的 `agentHints` 会随版本变化，它优先于本文档

## 当前项目关键标识（已验证）

| 对象 | ID | 名称 |
|---|---|---|
| Project | 8884889 | AI Code Review |
| Team | 4770170 | — |
| Module | 8646340 | 默认 |
| Branch (main) | 8683450 | main (SPRINT, isMain=true) |
| Endpoint Folder | 96972308 | 代码评审 |
| Endpoint | 521519124 | POST /review/webhook |
| TestCase Categories | 13814139~13814143 | 正向/负向/边界值/安全性/其他 |

## 常见错误与对策

下表的状态码与响应均由实测确认：

| 现象 | 原因 | 对策 |
|---|---|---|
| HTTP 406 | `Accept` 缺 `text/event-stream` | 带上完整 Accept 头 |
| HTTP 401 | PAT 过期或写错 | 核对 `APIFOX_ACCESS_TOKEN` |
| HTTP 400 | 未握手，或后续调用未带 `mcp-session-id` | 先 `initialize`，之后每次调用都带会话头 |
| `notifications/initialized` 返回**空 body** | 该通知只用 HTTP 202 应答，没有响应体 | 不要当错误；判断有无 JSON-RPC 消息即可 |
| HTTP 200 + `isError:true` + `MCP error -32602: Tool X not found` | 工具名拼错 | 跑 `tools` 子命令取准确名称 |
| 删除 schema 报 `404 Not found` | 项目 ID 放错了位置 | 放 `headers.X-Project-Id`，不是 `pathParams` |
| 参数校验失败 | 扁平/嵌套混用，或 `httpApiId` / `http_api_id` 写错 | 对照 [工具参数参考](reference/tool-reference.md) |
| 工具报错称结构 ID 不存在 | 缓存过期 | 跑 `refresh-cache` |

## 脚本

`scripts/apifox-mcp.mjs` 封装握手、`tools/call`、响应二次解析与会话过期重试，参数统一走这里，无需手写 fetch。

```bash
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs tools
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs list-projects

# 项目摘要 / 刷新本地缓存（写 .apifox/<id>_<name>.settings.json + fetchedAt）
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs summary       --project 8884889 [--branch 8683450]
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs refresh-cache --project 8884889

# 结构浏览 → 实体详情
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs structure --project 8884889 --type endpoint [--module <id>] [--folder <id>]
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs entity    --project 8884889 --entity 521519124 [--with testCase]

# 导出 / 导入 OpenAPI
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs export --project 8884889 --out .apifox/review.openapi.json
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs import --project 8884889 --file .apifox/review.openapi.json \
  --api-mode methodAndPath --schema-mode name

# 任意工具；--args 收完整 arguments 对象，扁平与嵌套照原样传
node .agent/skills/apifox-mcp/scripts/apifox-mcp.mjs call getStructureInfo --args '{"projectId":8884889,"entityType":"endpoint"}'
```

Token 取自环境变量 `APIFOX_ACCESS_TOKEN`，否则从向上找到的 `.agent/.env` 读取；始终作为请求头发送，不落盘。

进度信息（`Wrote …`）走 stderr，JSON 结果走 stdout。

### 自检

```bash
node .agent/skills/apifox-mcp/scripts/smoke-test.mjs
```

24 个用例覆盖握手、各读取命令、导出落盘、缓存契约与错误路径。import 只测参数校验与文件读取，不真正写入——真实导入会新建模型，跑之前先确认不会污染项目。

## 执行步骤（模型自动触发时的标准流程）

1. **读缓存**：涉及具体项目时先读 `.apifox/{projectId}_*.settings.json`，看 `fetchedAt` 是否在 30 分钟内。
2. **刷新**：缓存缺失、过期、内容无效、下游报结构 ID 不存在、或用户要求刷新时，跑 `refresh-cache`。
3. **探索**：`structure` 拿 entityId，再 `entity` 取完整定义。
4. **交付**：脚本已二次解析，直接用 stdout。

## 完成判据

- 命令退出码为 0，stdout 是可解析 JSON（`import` 另看 `success` 与各 `errorCount`）
- 缓存文件存在、含 `fetchedAt`、内容与远程一致
- 写操作（import / create / update / delete）后用 `structure` 或 `summary` 复核，不凭返回就宣布完成
- Token 与 session id 未落盘、未出现在输出里

---

*另见：`reference/tool-reference.md`（完整参数 Schema）、`scripts/apifox-mcp.mjs`（可运行 CLI）、`scripts/smoke-test.mjs`（自检）*
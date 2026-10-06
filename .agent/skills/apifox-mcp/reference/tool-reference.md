# Apifox MCP 工具参数参考

按 `tools/list` 实际返回整理。服务标识：`apifox-mcp-server` v1.0.0，protocolVersion `2025-06-18`。

## 参数信封的两种形状

服务器上的工具并非统一形状，这是本 MCP 最大的坑：

- **扁平**：`arguments` 直接放业务字段。
  `listAccessibleProjects` `getProjectSummary` `getStructureInfo` `readEntityDetails` `listOpenApiEndpoints` `getOpenApiDetails`
- **嵌套**：业务字段包在 `pathParams` / `queryParams` / `headers` / `body` 里。
  `importData` `exportData` `getHttpEndpoint` `createHttpEndpoint` `updateHttpEndpoint` `deleteHttpEndpoint` `listTestCases` `getTestCase` `createTestCase` `updateTestCase` `deleteTestCase` `executeOpenApi`

信封内各层的作用：

| 层 | 含义 |
|---|---|
| `pathParams` | URL 路径段 |
| `queryParams` | URL 查询串；Apifox 也把 `locale`（`en-US` / `ja-JP`）放这里 |
| `headers` | `X-Project-Id` 必填；测试用例类工具还需 `X-Branch-Id` |
| `body` | 请求体。多数 HTTP 接口工具的子字段是 **JSON 字符串**而非对象 |

## 发现类（扁平）

### listAccessibleProjects
无参数。返回 `[{project:{id,name,description,visibility,teamId}}]`。

### getProjectSummary
`projectId`（必填，整数）、`branchId`（可选）。

返回 `{data:{id,name,teamId,statistics,modules,branches,endpointFolders,schemaFolders,testCaseCategories,testScenarioFolders,testSuiteFolders}, agentHints:{instruction,tips}}`。

`agentHints.instruction` 要求把 `data` 原样写入 `.apifox/{projectId}_{safeName}.settings.json` 并在根节点追加 `fetchedAt`。

### getStructureInfo
`projectId`（必填）、`entityType`（必填：`endpoint` \| `schema` \| `markdown`）、`branchId`、`moduleId`、`folderId` 可选。三个范围参数同时传取交集；都不传返回全量。`folderId` 只匹配直接子项。

返回 `{data:{entityType,scope,total,entities:[{entityId,name,method,path,status,moduleId}]}}`。

### readEntityDetails
`projectId`（必填）、`entityType`（必填）、`entityId`（必填，取自 `getStructureInfo` 的 `entityId`，即 originId）、`branchId`、`with`（逗号分隔，当前仅 `testCase`）。

`options` 仅在 `with` 含 `testCase` 时生效，形状 `{"testCase":{"categoryId":123}}`。

endpoint 返回 `{data:{entityType,entityId,projectId,branchId,updatedAt,definition:{...OAS 3.0...}}}`。`definition` 即完整 OAS，`components.schemas` 的键是数字 ID，语义名放在 `title`。

## 文档 IO（嵌套）

### exportData
`pathParams.projectId`（**字符串**）、`queryParams.locale`、`headers.X-Project-Id`、`body`：

| 字段 | 说明 |
|---|---|
| `format` | `json` \| `yaml` |
| `type` | 1 全部、2 选择接口、3 选择标签、4 选择目录 |
| `version` | `openapi2` \| `openapi30` \| `openapi31` |
| `apiDetailId` | 指定接口 ID 数组 |
| `apiSchemaId` | 指定数据模型 ID 数组 |
| `selectedFolderIds` / `checkedFolder` | 文件夹 ID 数组 |
| `includeTags` / `excludeTags` | 标签过滤 |
| `excludeExtension` / `excludeTagsWithFolder` / `excludeCustomTag` / `excludeInternalVisibility` | 精简开关 |

### importData
`pathParams.projectId`（**字符串**）、`body`：

| 字段 | 说明 |
|---|---|
| `importFormat` | **必填**，目前只支持 `openapi` |
| `data` | OAS JSON **字符串**（支持 OpenAPI 3、Swagger 1/2/3） |
| `url` / `auth` | 改用 URL 作为数据源；同时给 `url` 与 `data` 时 `url` 优先 |
| `apiOverwriteMode` | `methodAndPath` \| `both` \| `merge` \| `ignore`（默认 `ignore`） |
| `schemaOverwriteMode` | `name` \| `both` \| `merge` \| `ignore`（默认 `ignore`） |
| `syncApiFolder` / `apiFolderId` | 同步接口目录 / 指定目标目录 |
| `importBasePath` | 建议保持 `false`，BasePath 放到环境的「前置 URL」 |

`merge` 与 `both` 的差别：重命名接口时 `merge` 可能留下旧接口副本。

返回 `success` 与各 `*Collection.item` 计数，重点看 `errorCount`：非 0 说明导入有问题，需按提示排查。

### 删除数据模型（逃生口）

工具包里没有删除 schema 的工具，走 `executeOpenApi`：

1. `listOpenApiEndpoints` → `{"keyword":"schema","method":"DELETE"}` → 命中 `/api/v1/api-schemas/{schema_id}`，id `de0ab6b96b11e065`。
2. `getOpenApiDetails` 确认参数。
3. `executeOpenApi`：

```json
{ "id": "de0ab6b96b11e065",
  "pathParams": { "schema_id": "318280260" },
  "queryParams": {},
  "headers": { "X-Project-Id": "8884889" } }
```

> **项目 ID 放在 `X-Project-Id` 头里**，不放在 `pathParams`。放错会得到 `HTTP 404 Not found`（看起来像「对象不存在」，实际是路径参数错了）。

## HTTP 接口 CRUD（嵌套）

| 工具 | 路径参数 | 必填 |
|---|---|---|
| `getHttpEndpoint` | `pathParams.projectId` + `pathParams.httpApiId` | 两个都必填 |
| `createHttpEndpoint` | 无 | `body.method`、`body.path` |
| `updateHttpEndpoint` | `pathParams.http_api_id`（**snake_case**） | — |
| `deleteHttpEndpoint` | `pathParams.httpApiId`（**camelCase**） | 配合 `headers.X-Project-Id` |

`createHttpEndpoint` / `updateHttpEndpoint` 的 body 字段：

`name` `method` `path` `folderId` `status` `responsibleId` `serverId` `description` `type`（http/socket/webhook）`tags` `auth` `advancedSettings` `codeSamples` `customApiFields` `commonParameters` `responses` `responseExamples` `responseChildren` `parameters` `requestBody` `commonResponseStatus`

其中 `parameters`、`requestBody`、`responses`、`responseExamples`、`commonParameters` 是 **JSON 字符串**，需自行序列化。

`status` 枚举：`designing` `pending` `developing` `integrating` `testing` `tested` `released` `deprecated` `exception` `obsolete`；`updateHttpEndpoint` 也接受自定义状态。

`responsibleId` 为 `0` 表示未指定。`serverId` 为 `"0"` 时继承父级。

`responses` 每项：`name`、`code`、`jsonSchema`、`contentType`（json/xml/html/raw/binary/noContent/msgpack/eventStream）。

## 测试用例（嵌套）

四个工具都需 `headers.X-Project-Id`；`X-Branch-Id` 用于指定分支。列表用 `queryParams.endpointId` 过滤到单个接口，`queryParams.fields` 逗号分隔筛字段。

`createTestCase` / `updateTestCase` 的 `body.parameters` 分 `path` / `query` / `cookie` / `header` 四组数组，每项含 `id` `name` `type` `value` `enable` `description`；`value` 可为字符串或字符串数组（多同名参数）。

创建用例至少需要项目 ID、接口 ID、分组 ID。分组 ID 来自 `getProjectSummary` 的 `testCaseCategories`。

## 逃生口（`listOpenApiEndpoints` / `getOpenApiDetails` / `executeOpenApi`）

默认工具包覆盖不到时走这条线。

- `listOpenApiEndpoints`：`keyword`（匹配路径与描述）、`method`（GET/POST/PUT/DELETE/PATCH）、`tags`、`limit`（默认 50）、`offset`。返回为空即停止翻页。
- `getOpenApiDetails`：`id`（**必填**，工具 hash）、`format`（默认 `yaml`）、`includeExamples`、`includeResponseSchema`。
- `executeOpenApi`：`id`（必填）、`pathParams`、`queryParams`、`headers` 三者**均为必填**，另可带 `body`、`contentType`。

可覆盖的领域：团队管理、变量与参数、目录/接口/数据模型/响应组件/快捷请求、自动化测试报告与场景、CI 配置、导入导出、Runner 任务、Webhook 通知。

## 服务端返回的 agentHints

多个工具在 `result.content[0].text` 的 JSON 里带 `agentHints`，属于服务端下发的操作指令，随服务端版本变化，优先于本文档：

- `getProjectSummary`：缓存到 `.apifox/{projectId}_{safeName}.settings.json` 并加 `fetchedAt`；`fetchedAt` 超 30 分钟则重新调用；编辑分支时基于 base branch 的 shadow branch。
- `readEntityDetails`（endpoint）：修改接口以返回的 `definition` 为基础，提交给 `updateHttpEndpoint`。
- `getStructureInfo`：查看完整 OAS 用 `readEntityDetails`。
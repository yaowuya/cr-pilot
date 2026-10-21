/**
 * 生成 cr-pilot 的完整 OpenAPI 3.0 规范到 `docs/openapi.json`。
 *
 * 为什么用脚本而不是手写 JSON：
 * 1) 接口多、字段重复度高，脚本能保证 schema 复用与格式一致；
 * 2) 代码改动后重新跑一次即可，不需要手工比对遗漏；
 * 3) 生成结果确定，diff 可读，评审时能直接看到契约变化。
 *
 * 契约来源全部是 `src/interfaces/http/api/*.ts` 与 `src/domain/*.ts` 的实际实现，
 * 不是设计文档——文档会过期，代码不会。
 *
 * 用法：`npm run build:openapi`（= `node scripts/build-openapi.ts`）。
 * 产物入库（`docs/openapi.json`），供 Apifox 导入与评审对照。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 产物路径，相对仓库根目录。 */
const OUT = join(process.cwd(), "docs", "openapi.json");

/** 统一的 Bearer 鉴权安全方案名。 */
const BEARER = "bearerAuth";

/** OpenAPI 片段的宽松类型：结构由下面的字面量保证，不必为每个字段建类型。 */
type JsonObject = Record<string, unknown>;

/** 构造标准错误响应。 */
function errorResponse(description: string, examples?: JsonObject): JsonObject {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
        ...(examples ? { example: examples } : {}),
      },
    },
  };
}

/** 构造成功响应。 */
function jsonResponse(description: string, schema: JsonObject, example?: unknown): JsonObject {
  return {
    description,
    content: {
      "application/json": {
        schema,
        ...(example !== undefined ? { example } : {}),
      },
    },
  };
}

/** 常见响应码：每个需要鉴权的接口都会出现 401。 */
const COMMON_ERRORS: Record<number, JsonObject> = {
  400: errorResponse("参数校验失败", { error: "参数非法" }),
  401: errorResponse("未携带令牌或令牌无效", { error: "缺少访问令牌" }),
  500: errorResponse("服务端错误", { error: "服务器内部错误" }),
};

/** 管理员专属接口额外带 403。 */
const ADMIN_ERRORS: Record<number, JsonObject> = {
  ...COMMON_ERRORS,
  403: errorResponse("当前账号不是管理员（由 ADMIN_USERNAME 决定）", { error: "需要管理员权限" }),
};

const paths: Record<string, JsonObject> = {};

// ============ 系统 ============

paths["/health"] = {
  get: {
    tags: ["系统"],
    summary: "健康检查",
    description: "容器 healthcheck 与负载均衡探活使用。不需要鉴权。",
    operationId: "getHealth",
    security: [],
    responses: {
      200: jsonResponse("服务正常", {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", example: "ok" } },
      }),
    },
  },
};

// ============ Webhook ============

paths["/review/webhook"] = {
  post: {
    tags: ["Webhook"],
    summary: "GitLab Merge Request Webhook（评审入口）",
    description: [
      "GitLab 推送 MR 事件后，本接口把任务放进后台队列并立即返回 200。",
      "后台管线：拉取变更 → 按仓库规则分批评审 → 汇总 → 回写 MR 评论。",
      "",
      "**来源校验**：不校验 `X-Gitlab-Token` 的 secret 语义。一个 GitLab 实例有多个项目、",
      "每个项目 secret 各不相同，单实例无法用一份全局 secret 校验所有来源，",
      "来源保护由部署层（内网隔离、网关白名单）负责。",
      "",
      "**访问令牌**：请求头 `X-Gitlab-Token` 会被当作 GitLab API 访问令牌使用（拉取变更与回写评论）。",
    ].join("\n"),
    operationId: "postReviewWebhook",
    security: [],
    parameters: [
      {
        name: "X-Gitlab-Token",
        in: "header",
        required: true,
        description: "GitLab 访问令牌，用于调用 GitLab API。缺失时返回 400。",
        schema: { type: "string" },
      },
      {
        name: "X-Gitlab-Instance",
        in: "header",
        required: false,
        description: "GitLab 实例地址；缺省时从 payload 派生，再回落到 `GITLAB_URL` 配置。",
        schema: { type: "string", example: "https://code.cwoa.net" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/GitlabMergeRequestHook" } },
      },
    },
    responses: {
      200: jsonResponse(
        "任务已入队",
        {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string", example: "merge_request !5347 已进入评审队列" } },
        },
        { message: "merge_request !5347 已进入评审队列" },
      ),
      400: errorResponse("事件类型不支持或 payload 缺字段", { error: "仅支持 merge_request 事件，收到：push" }),
      404: errorResponse("路径不存在", { error: "未找到该路径" }),
      500: errorResponse("服务端错误", { error: "服务器内部错误" }),
    },
  },
};

// ============ 认证 ============

paths["/api/auth/login"] = {
  post: {
    tags: ["认证"],
    summary: "登录",
    description: [
      "用账号密码换取 Bearer 令牌。令牌是无状态派生值（`deriveToken(username, AUTH_SALT)`），",
      "不存会话表，因此服务重启后旧令牌仍有效；改密码或改 `AUTH_SALT` 才会失效。",
      "",
      "失败一律返回相同的 401 响应体，不区分「用户不存在」与「密码错误」，避免账号枚举。",
    ].join("\n"),
    operationId: "postAuthLogin",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/LoginRequest" },
          example: { username: "admin", password: "admin12345" },
        },
      },
    },
    responses: {
      200: jsonResponse(
        "登录成功",
        { $ref: "#/components/schemas/LoginResponse" },
        { token: "6f1c9b2e8a4d7c3f5e0b1a2d3c4e5f60", username: "admin", isAdmin: true },
      ),
      400: errorResponse("用户名或密码为空", { error: "用户名与密码不能为空" }),
      401: errorResponse("用户名或密码错误", { error: "用户名或密码错误" }),
    },
  },
};

paths["/api/auth/logout"] = {
  post: {
    tags: ["认证"],
    summary: "登出",
    description: "令牌无服务端状态，此接口只为语义完整：实际清除在前端 localStorage。",
    operationId: "postAuthLogout",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("已登出", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/auth/me"] = {
  get: {
    tags: ["认证"],
    summary: "校验登录态",
    description:
      "前端启动与刷新时用它判断本地令牌是否仍可用，并恢复当前账号的角色。每次调用都重新计算 `isAdmin`，因此改 `ADMIN_USERNAME` 重启后刷新页面即拿到新角色。",
    operationId: "getAuthMe",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("当前账号", {
        type: "object",
        required: ["username", "isAdmin"],
        properties: {
          username: { type: "string", example: "admin" },
          isAdmin: {
            type: "boolean",
            description: "是否管理员。由部署配置 `ADMIN_USERNAME` 决定，不存数据库。",
            example: true,
          },
        },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

// ============ 评审记录 ============

paths["/api/reviews"] = {
  get: {
    tags: ["评审记录"],
    summary: "查询评审记录列表",
    description: "按时间倒序分页返回评审明细。只读接口：记录只能由评审管线追加，管理端不得篡改历史。",
    operationId: "listReviews",
    security: [{ [BEARER]: [] }],
    parameters: [
      { name: "page", in: "query", description: "页码，默认 1", schema: { type: "integer", minimum: 1, default: 1 } },
      {
        name: "pageSize",
        in: "query",
        description: "每页条数，默认 20，最大 200",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
      { name: "project_id", in: "query", description: "按 GitLab 项目 ID 过滤", schema: { type: "integer", minimum: 1 } },
      { name: "committer", in: "query", description: "按提交人过滤", schema: { type: "string" } },
      { name: "from", in: "query", description: "起始时间（Unix 毫秒）", schema: { type: "integer" } },
      { name: "to", in: "query", description: "结束时间（Unix 毫秒）", schema: { type: "integer" } },
    ],
    responses: {
      200: jsonResponse("分页结果", { $ref: "#/components/schemas/ReviewListResponse" }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      500: COMMON_ERRORS[500],
    },
  },
};

paths["/api/reviews/stats"] = {
  get: {
    tags: ["评审记录"],
    summary: "评审统计",
    description:
      "基础统计走 SQL 实时聚合，不受分页影响。`avgScore` 为 null 表示没有任何带分数的记录（与 0 分区分）。",
    operationId: "getReviewStats",
    security: [{ [BEARER]: [] }],
    parameters: [
      { name: "from", in: "query", description: "起始时间（Unix 毫秒）", schema: { type: "integer" } },
      { name: "to", in: "query", description: "结束时间（Unix 毫秒）", schema: { type: "integer" } },
    ],
    responses: {
      200: jsonResponse("统计结果", { $ref: "#/components/schemas/ReviewStats" }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      500: COMMON_ERRORS[500],
    },
  },
};

// ============ Prompt 管理 ============

paths["/api/prompts"] = {
  get: {
    tags: ["Prompt 管理"],
    summary: "prompt 列表",
    description:
      "只返回摘要，不含正文——正文可达数万字符，一次拉全部会明显拖慢页面。详情用 `GET /api/prompts/{id}`。",
    operationId: "listPrompts",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("prompt 摘要列表", {
        type: "array",
        items: { $ref: "#/components/schemas/PromptSummary" },
      }),
      401: COMMON_ERRORS[401],
    },
  },
  post: {
    tags: ["Prompt 管理"],
    summary: "新建 prompt",
    description: [
      "`repository` 是唯一键与展示名；`projects` 是关联的 GitLab 项目列表，任一项目命中即使用本 prompt。",
      "",
      "**projects 三态语义**：",
      "- 不传 → 默认关联到同名项目（兼容「一个 prompt 就是一个项目」的老用法）；",
      "- 传空数组 → 不关联任何项目；",
      "- `repository=default` → 全局兜底，永远不绑定项目（传了也忽略）。",
    ].join("\n"),
    operationId: "createPrompt",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PromptCreateRequest" },
          example: {
            repository: "通用评审",
            projects: ["auto-ops", "cw-auto-ops", "auto-ops-platform"],
            system_prompt: "你是一位资深工程师…",
            user_prompt: "以下是代码变更：\n{diffs_text}",
            wecom_score_threshold: 70,
            provider_id: 1,
            model: "deepseek-chat",
          },
        },
      },
    },
    responses: {
      200: jsonResponse("创建成功", { $ref: "#/components/schemas/StoredPrompt" }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      409: errorResponse("repository 已存在", { error: "prompt 通用评审 已存在" }),
      500: COMMON_ERRORS[500],
    },
  },
};

paths["/api/prompts/meta"] = {
  get: {
    tags: ["Prompt 管理"],
    summary: "下拉建议数据",
    description: "返回已关联的项目合集与可用厂商，供前端下拉选择。",
    operationId: "getPromptsMeta",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("建议数据", {
        type: "object",
        required: ["projects", "providers"],
        properties: {
          projects: {
            type: "array",
            description: "已关联到任意 prompt 的项目全名（去重排序）",
            items: { type: "string" },
            example: ["auto-ops", "cw-auto-ops"],
          },
          providers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", example: 1 },
                label: { type: "string", example: "DeepSeek" },
                name: { type: "string", example: "deepseek" },
                models: { type: "array", items: { type: "string" }, example: ["deepseek-chat", "deepseek-reasoner"] },
                defaultModel: { type: "string", example: "deepseek-chat" },
                isDefault: { type: "boolean", example: true },
              },
            },
          },
        },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/prompts/import"] = {
  post: {
    tags: ["Prompt 管理"],
    summary: "从 yaml 目录导入 prompt",
    description: [
      "扫描 `REVIEW_RULES_DIR`（默认 `prompts/rules`）下的 yaml，导入为数据库记录。",
      "已存在的 `repository` 跳过，因此可重复调用。",
      "",
      "**多项目拆分**：yaml 里 `repository: a,b,c` 这样的逗号串会被拆成三个项目关联。",
    ].join("\n"),
    operationId: "importPrompts",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("导入结果", {
        type: "object",
        required: ["imported", "skipped"],
        properties: {
          imported: { type: "integer", description: "新增条数", example: 6 },
          skipped: { type: "integer", description: "跳过条数（已存在或解析失败）", example: 1 },
        },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/prompts/{id}"] = {
  get: {
    tags: ["Prompt 管理"],
    summary: "prompt 详情（含正文）",
    operationId: "getPrompt",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("完整记录", { $ref: "#/components/schemas/StoredPrompt" }),
      400: errorResponse("ID 非法", { error: "prompt ID 非法" }),
      401: COMMON_ERRORS[401],
      404: errorResponse("不存在", { error: "prompt 不存在" }),
    },
  },
  put: {
    tags: ["Prompt 管理"],
    summary: "更新 prompt",
    description:
      "保存即生效（下一次评审读取新值），无需重启。`projects` 不传时保留原有关联；显式传（含空数组）才覆盖。",
    operationId: "updatePrompt",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/PromptUpdateRequest" } } },
    },
    responses: {
      200: jsonResponse("更新后的记录", { $ref: "#/components/schemas/StoredPrompt" }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      404: errorResponse("不存在", { error: "prompt 不存在" }),
    },
  },
  delete: {
    tags: ["Prompt 管理"],
    summary: "删除 prompt",
    description: "删除即删除，被删项目在解析时自然回落到 `default`。关联项目由外键级联清理。",
    operationId: "deletePrompt",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("已删除", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: errorResponse("ID 非法", { error: "prompt ID 非法" }),
      401: COMMON_ERRORS[401],
    },
  },
};

// ============ AI 厂商 ============

paths["/api/providers"] = {
  get: {
    tags: ["AI 厂商"],
    summary: "厂商列表与项目绑定",
    description: "密钥只回掩码（如 `sk-t****3456`），绝不回明文。",
    operationId: "listProviders",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("厂商列表", {
        type: "object",
        required: ["items", "bindings"],
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/LlmProviderSummary" } },
          bindings: { type: "array", items: { $ref: "#/components/schemas/LlmProjectBinding" } },
        },
      }),
      401: COMMON_ERRORS[401],
    },
  },
  post: {
    tags: ["AI 厂商"],
    summary: "新增厂商",
    description:
      "保存后自动重建 `pi-agent/models.json`（合并写入，保留手写的其他厂商）并导出密钥到进程环境变量，下一次评审即生效。",
    operationId: "createProvider",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/LlmProviderInput" },
          example: {
            name: "deepseek",
            label: "DeepSeek",
            kind: "deepseek",
            base_url: "https://api.deepseek.com/v1",
            api_key: "sk-xxxxxxxx",
            api: "openai-completions",
            models: ["deepseek-chat", "deepseek-reasoner"],
            default_model: "deepseek-chat",
            is_default: true,
          },
        },
      },
    },
    responses: {
      200: jsonResponse("创建成功", {
        type: "object",
        properties: { id: { type: "integer", example: 1 }, name: { type: "string", example: "deepseek" } },
      }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      409: errorResponse("name 已存在", { error: "厂商 deepseek 已存在" }),
      500: COMMON_ERRORS[500],
    },
  },
};

paths["/api/providers/templates"] = {
  get: {
    tags: ["AI 厂商"],
    summary: "内置厂商模板",
    description: "新建厂商时页面据此预填 baseUrl、协议与常见模型。用户仍可全部改掉。",
    operationId: "listProviderTemplates",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("模板列表", {
        type: "array",
        items: { $ref: "#/components/schemas/LlmProviderTemplate" },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/providers/{id}"] = {
  get: {
    tags: ["AI 厂商"],
    summary: "厂商详情",
    description: "同样只回掩码密钥，连详情接口也不回明文。",
    operationId: "getProvider",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("厂商详情", { $ref: "#/components/schemas/LlmProviderSummary" }),
      400: errorResponse("ID 非法", { error: "厂商 ID 非法" }),
      401: COMMON_ERRORS[401],
      404: errorResponse("不存在", { error: "厂商不存在" }),
    },
  },
  put: {
    tags: ["AI 厂商"],
    summary: "更新厂商",
    description:
      "密钥三态：不传 / 空串 / 提交掩码形式，都表示「不修改原密钥」；只有提交新明文才覆盖。避免页面把掩码当新密钥写回。",
    operationId: "updateProvider",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/LlmProviderInput" } } },
    },
    responses: {
      200: jsonResponse("已更新", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: COMMON_ERRORS[400],
      401: COMMON_ERRORS[401],
      404: errorResponse("不存在", { error: "厂商不存在" }),
      409: errorResponse("name 冲突", { error: "厂商 deepseek 已存在" }),
    },
  },
  delete: {
    tags: ["AI 厂商"],
    summary: "删除厂商",
    description: "关联的项目绑定由外键级联清理；引用该厂商的 prompt 会显示「厂商已删除」并回落到全局默认。",
    operationId: "deleteProvider",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("已删除", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: errorResponse("ID 非法", { error: "厂商 ID 非法" }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/providers/{id}/default"] = {
  post: {
    tags: ["AI 厂商"],
    summary: "设为全局默认厂商",
    description: "全局默认厂商至多一个，设置后其余厂商的默认标记会被清除。",
    operationId: "setDefaultProvider",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("已设置", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: errorResponse("ID 非法", { error: "厂商 ID 非法" }),
      401: COMMON_ERRORS[401],
      404: errorResponse("不存在", { error: "厂商不存在" }),
    },
  },
};

paths["/api/providers/bindings/{project}"] = {
  put: {
    tags: ["AI 厂商"],
    summary: "设置项目级厂商绑定",
    description: [
      "把某个 GitLab 项目钉到指定厂商与模型。",
      "",
      "**模型选择优先级**：项目绑定 > prompt 指定厂商 > 全局默认厂商 > models.json 既有配置。",
    ].join("\n"),
    operationId: "bindProjectProvider",
    security: [{ [BEARER]: [] }],
    parameters: [
      {
        name: "project",
        in: "path",
        required: true,
        description: "GitLab 项目全名，需 URL 编码",
        schema: { type: "string" },
        example: "group%2Fproject",
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["provider_id"],
            properties: {
              provider_id: { type: "integer", minimum: 1, example: 1 },
              model: { type: "string", description: "可选；不传则用厂商默认模型", example: "gpt-4o-mini" },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse("已绑定", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: errorResponse("参数非法", { error: "provider_id 必须是正整数" }),
      401: COMMON_ERRORS[401],
      404: errorResponse("厂商不存在", { error: "厂商不存在" }),
    },
  },
  delete: {
    tags: ["AI 厂商"],
    summary: "解除项目级绑定",
    operationId: "unbindProjectProvider",
    security: [{ [BEARER]: [] }],
    parameters: [
      {
        name: "project",
        in: "path",
        required: true,
        description: "GitLab 项目全名，需 URL 编码",
        schema: { type: "string" },
      },
    ],
    responses: {
      200: jsonResponse("已解除", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      401: COMMON_ERRORS[401],
    },
  },
};

// ============ 环境变量 ============

paths["/api/config"] = {
  get: {
    tags: ["环境变量"],
    summary: "配置项列表",
    description: [
      "返回白名单内的全部配置项及其生效值。密钥类字段的 `value` 已是掩码。",
      "",
      "**生效值来源**：数据库覆盖值优先，没有覆盖时取进程环境变量。",
      "",
      "**只读项**：`DB_PATH`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` 只能在 `.env` 修改。",
    ].join("\n"),
    operationId: "listConfig",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("配置项列表", {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", items: { $ref: "#/components/schemas/ConfigItem" } } },
      }),
      401: COMMON_ERRORS[401],
    },
  },
  put: {
    tags: ["环境变量"],
    summary: "批量保存配置项",
    description: [
      "只允许修改白名单内的键，且不能是只读项。值会先做校验——非法值（如 `PORT=abc`）会在下次启动让进程直接退出，因此必须提前拦截。",
      "",
      "**生效时机**：写入数据库并同步 `process.env`，但消费方在构造时持有快照，标记为「需重启」的键必须重启容器才真正生效。",
    ].join("\n"),
    operationId: "saveConfig",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["key", "value"],
                  properties: {
                    key: { type: "string", example: "QUEUE_CONCURRENCY" },
                    value: { type: "string", example: "8" },
                  },
                },
              },
            },
          },
          example: { items: [{ key: "QUEUE_CONCURRENCY", value: "8" }] },
        },
      },
    },
    responses: {
      200: jsonResponse("保存结果", {
        type: "object",
        required: ["items", "restartRequired"],
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
          },
          restartRequired: {
            type: "array",
            description: "需要重启才生效的键",
            items: { type: "string" },
            example: ["QUEUE_CONCURRENCY"],
          },
        },
      }),
      400: errorResponse("参数非法或配置项不可改", { error: "配置项 DB_PATH 为只读，请通过 .env 修改后重启" }),
      401: COMMON_ERRORS[401],
    },
  },
};

// ============ 功能自检 ============

paths["/api/verify/ai"] = {
  post: {
    tags: ["功能自检"],
    summary: "提交 AI 评审验证任务",
    description: [
      "用一段固定样例 diff 真实调用一次模型，检查能否返回评审正文并解析出总分。",
      "",
      "**异步执行**：AI 评审约需 1 分钟，接口立即返回 `taskId`，需轮询 `GET /api/verify/tasks/{id}` 取结果。",
      "",
      "**限流**：同一时间只允许一个 AI 验证任务，重复提交返回 409。",
    ].join("\n"),
    operationId: "submitVerifyAi",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("任务已提交", { type: "object", required: ["taskId"], properties: { taskId: { type: "string", example: "8f3c..." } } }),
      401: COMMON_ERRORS[401],
      409: errorResponse("已有 AI 验证在执行", { error: "已有 AI 验证正在执行，请等待完成" }),
    },
  },
};

paths["/api/verify/wecom"] = {
  post: {
    tags: ["功能自检"],
    summary: "提交企微推送验证任务",
    description: [
      "组装一条带 `[验证]` 前缀的消息发送到群机器人，确认配置可用。",
      "",
      "**默认只预览**：`confirmSend` 不为 `true` 时只组装消息、不发送。真实发群不可撤销，必须显式确认。",
      "",
      "**测试提交人**：必须传 `gitlabUsername`，服务端按现有企微映射解析提及对象；配置 userid 时真实提及，仅配置姓名时输出纯文本 `@姓名`。无映射时任务失败，不发送、不猜测其他人。",
      "",
      "`webhook` 可覆盖规则文件里的群地址，用于发到测试群。",
    ].join("\n"),
    operationId: "submitVerifyWecom",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["gitlabUsername"],
            properties: {
              gitlabUsername: { type: "string", minLength: 1, pattern: "^[a-zA-Z0-9_.-]+$", description: "被测提交人的 GitLab 账号，必须已登记企微映射", example: "code-author" },
              confirmSend: { type: "boolean", description: "为 true 才真实发送到群", example: true },
              webhook: { type: "string", description: "覆盖规则文件里的群机器人地址", example: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse("任务已提交", { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } }),
      400: errorResponse("提交人账号缺失或 webhook 非法", { error: "请选择有效的测试提交人（GitLab 账号）" }),
      401: COMMON_ERRORS[401],
      409: errorResponse("已有企微验证在执行", { error: "已有企微验证正在执行，请等待完成" }),
    },
  },
};

paths["/api/verify/tasks/{id}"] = {
  get: {
    tags: ["功能自检"],
    summary: "查询验证任务状态",
    description: "轮询验证结果。任务只存内存，进程重启后丢失；超过 1 小时或超过 20 条会被清理。",
    operationId: "getVerifyTask",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: {
      200: jsonResponse("任务状态与结果", { $ref: "#/components/schemas/VerifyTask" }),
      401: COMMON_ERRORS[401],
      404: errorResponse("任务不存在或已过期", { error: "任务不存在或已过期" }),
    },
  },
};

// ============ 采纳统计 ============

paths["/api/reviews/adoption"] = {
  get: {
    tags: ["评审记录"],
    summary: "评审建议采纳统计",
    description: [
      "统计 AI 评审建议在后续提交中是否真的改了代码。",
      "",
      "**口径**：采纳率 = 代码已变化的建议数 ÷ 可统计建议数。指纹只能证明目标行变了，不能证明改得对，因此该指标是「代码变化率」。",
      "",
      "**不可统计部分单列**：`fallback` 为降级并入汇总评论的建议（无行锚点），`unknown` 为文件被删除或大重构导致无法定位的建议，二者均不计入分母。",
      "",
      "**历史数据**：功能上线前的评审没有建议明细，统计只覆盖上线后的数据。",
    ].join("\n"),
    operationId: "getAdoptionStats",
    security: [{ [BEARER]: [] }],
    parameters: [
      { name: "from", in: "query", required: false, schema: { type: "integer" }, description: "起始时间（Unix 毫秒）" },
      { name: "to", in: "query", required: false, schema: { type: "integer" }, description: "结束时间（Unix 毫秒）" },
      { name: "projectId", in: "query", required: false, schema: { type: "integer" }, description: "只看指定项目" },
    ],
    responses: {
      200: jsonResponse("采纳统计", { $ref: "#/components/schemas/AdoptionStats" }),
      400: errorResponse("查询参数非法", { error: "查询参数必须是正整数" }),
      401: COMMON_ERRORS[401],
    },
  },
};

// ============ 企微映射 ============

paths["/api/wecom-contacts"] = {
  get: {
    tags: ["企微映射"],
    summary: "映射列表",
    description: [
      "返回 GitLab 账号到企微成员的映射，用于评审提醒里的 @ 目标。",
      "",
      "**提醒语义**：`wecomUserId` 非空时通知发送 `<@userid>`，能真实提醒成员；只有 `wecomName` 时退化为纯文本 `@姓名`，仅展示、不推送通知。",
    ].join("\n"),
    operationId: "listWecomContacts",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("映射列表", {
        type: "array",
        items: { $ref: "#/components/schemas/WecomContact" },
      }),
      401: COMMON_ERRORS[401],
    },
  },
  put: {
    tags: ["企微映射"],
    summary: "新增或更新单条映射",
    description: [
      "按 `gitlabUsername` 幂等写入：账号不存在则新增，已存在则覆盖姓名与 userid。",
      "",
      "**校验**：账号只允许字母、数字、`_`、`.`、`-`；userid 只允许字母、数字、`_`、`.`、`-`、`@`；`all` 不能作为成员标识。",
    ].join("\n"),
    operationId: "saveWecomContact",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["gitlabUsername"],
            properties: {
              gitlabUsername: { type: "string", example: "samxiao" },
              wecomName: { type: "string", example: "王秦" },
              wecomUserId: { type: "string", example: "wangqin" },
            },
          },
          example: { gitlabUsername: "samxiao", wecomName: "王秦", wecomUserId: "wangqin" },
        },
      },
    },
    responses: {
      200: jsonResponse("保存后的映射", { $ref: "#/components/schemas/WecomContact" }),
      400: errorResponse("参数校验失败", { error: "企微姓名与企微 userid 至少填写一项" }),
      401: COMMON_ERRORS[401],
    },
  },
};

paths["/api/wecom-contacts/{gitlabUsername}"] = {
  delete: {
    tags: ["企微映射"],
    summary: "删除映射",
    description: "按 GitLab 账号删除（大小写不敏感）。账号未登记时返回 404。",
    operationId: "deleteWecomContact",
    security: [{ [BEARER]: [] }],
    parameters: [
      { name: "gitlabUsername", in: "path", required: true, schema: { type: "string" }, example: "samxiao" },
    ],
    responses: {
      200: jsonResponse("删除结果", { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }),
      401: COMMON_ERRORS[401],
      404: errorResponse("映射不存在", { error: "映射不存在" }),
    },
  },
};

// ============ 管理员账号 ============

paths["/api/admins"] = {
  get: {
    tags: ["管理员账号"],
    summary: "账号列表",
    description:
      "**需要管理员权限**：非 admin 账号一律 403。`isAdmin` 由部署配置 `ADMIN_USERNAME` 计算，不存数据库。",
    operationId: "listAdmins",
    security: [{ [BEARER]: [] }],
    responses: {
      200: jsonResponse("账号列表（不含任何密码字段）", {
        type: "array",
        items: { $ref: "#/components/schemas/AdminUser" },
      }),
      401: COMMON_ERRORS[401],
      403: ADMIN_ERRORS[403],
    },
  },
  post: {
    tags: ["管理员账号"],
    summary: "新增账号",
    description: "**需要管理员权限**。新账号一律是普通账号，无法通过页面提升为管理员。",
    operationId: "createAdmin",
    security: [{ [BEARER]: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["username", "password"],
            properties: {
              username: { type: "string", example: "viewer" },
              password: { type: "string", minLength: 8, example: "viewer12345" },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse("创建成功", { $ref: "#/components/schemas/AdminUser" }),
      400: errorResponse("参数非法", { error: "密码长度不能少于 8 位" }),
      401: COMMON_ERRORS[401],
      403: ADMIN_ERRORS[403],
      409: errorResponse("用户名已存在", { error: "管理员 viewer 已存在" }),
      500: COMMON_ERRORS[500],
    },
  },
};

paths["/api/admins/{id}"] = {
  delete: {
    tags: ["管理员账号"],
    summary: "删除账号",
    description: [
      "**需要管理员权限**。两条约束：",
      "- 禁止删除当前登录的账号；",
      "- 禁止删除最后一个管理员账号。",
    ].join("\n"),
    operationId: "deleteAdmin",
    security: [{ [BEARER]: [] }],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: {
      200: jsonResponse("已删除", {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      }),
      400: errorResponse("违反删除约束", { error: "不能删除当前登录的账号" }),
      401: COMMON_ERRORS[401],
      403: ADMIN_ERRORS[403],
      404: errorResponse("账号不存在", { error: "账号不存在" }),
    },
  },
};

// ============ 数据模型 ============

const schemas: Record<string, JsonObject> = {
  ErrorResponse: {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string", description: "人类可读的错误说明" } },
  },

  LoginRequest: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", example: "admin" },
      password: { type: "string", format: "password", example: "admin12345" },
    },
  },

  LoginResponse: {
    type: "object",
    required: ["token", "username", "isAdmin"],
    properties: {
      token: {
        type: "string",
        description: "Bearer 令牌，放 `Authorization: Bearer <token>`",
        example: "6f1c9b2e8a4d7c3f5e0b1a2d3c4e5f60",
      },
      username: { type: "string", example: "admin" },
      isAdmin: { type: "boolean", description: "是否管理员（由 ADMIN_USERNAME 决定）", example: true },
    },
  },

  GitlabMergeRequestHook: {
    type: "object",
    required: ["object_kind", "project", "object_attributes"],
    description:
      "GitLab Merge Request Hook payload。服务只读取 `object_kind`、`project_id`（缺失回退 `project.id`）、`project.path_with_namespace`、`object_attributes.iid/source_branch/target_branch`，其余字段原样忽略。",
    properties: {
      object_kind: { type: "string", enum: ["merge_request"], example: "merge_request" },
      project_id: { type: "integer", description: "缺失时回退 project.id", example: 101 },
      project: {
        type: "object",
        properties: {
          id: { type: "integer", example: 101 },
          path_with_namespace: { type: "string", example: "group/payment-service" },
          web_url: { type: "string", example: "https://code.cwoa.net/group/payment-service" },
        },
      },
      object_attributes: {
        type: "object",
        required: ["iid"],
        properties: {
          iid: { type: "integer", description: "MR 内部编号", example: 12 },
          source_branch: { type: "string", example: "feature/pay" },
          target_branch: { type: "string", example: "main" },
          url: { type: "string" },
          title: { type: "string" },
          state: { type: "string", example: "opened" },
        },
      },
      user: {
        type: "object",
        description: "触发人；服务读取 name 作为提交人记录",
        properties: {
          name: { type: "string", example: "张三" },
          username: { type: "string", example: "zhangsan" },
        },
      },
    },
  },

  ReviewRecord: {
    type: "object",
    required: [
      "projectId",
      "projectName",
      "mrIid",
      "committerName",
      "changeCount",
      "batchCount",
      "score",
      "durationMs",
      "result",
      "startedAt",
      "finishedAt",
    ],
    properties: {
      projectId: { type: "integer", example: 101 },
      projectName: { type: "string", example: "group/payment-service" },
      mrIid: { type: "integer", example: 12 },
      committerName: { type: "string", example: "张三" },
      changeCount: { type: "integer", description: "变更文件数", example: 8 },
      batchCount: { type: "integer", description: "评审批次数", example: 3 },
      score: {
        type: "integer",
        nullable: true,
        description: "AI 给出的总分。`null` 表示未解析出分数，与真实的 0 分不同。",
        example: 86,
      },
      durationMs: { type: "integer", description: "耗时毫秒", example: 12400 },
      result: { type: "string", enum: ["success", "failed"], example: "success" },
      errorMessage: { type: "string", nullable: true, description: "仅 result=failed 时有值" },
      commentUrl: { type: "string", nullable: true, description: "回写的 MR 评论地址" },
      mrUrl: {
        type: "string",
        nullable: true,
        description: "MR 的 GitLab web 地址，供页面点击跳转；缺实例地址或项目名时为 null",
        example: "https://code.cwoa.net/group/payment-service/-/merge_requests/12",
      },
      startedAt: { type: "integer", description: "Unix 毫秒", example: 1792226620931 },
      finishedAt: { type: "integer", description: "Unix 毫秒", example: 1792226633331 },
    },
  },

  ReviewListResponse: {
    type: "object",
    required: ["items", "total", "page", "pageSize"],
    properties: {
      items: { type: "array", items: { $ref: "#/components/schemas/ReviewRecord" } },
      total: { type: "integer", example: 6 },
      page: { type: "integer", example: 1 },
      pageSize: { type: "integer", example: 20 },
    },
  },

  ReviewStats: {
    type: "object",
    required: ["total", "projectCount", "committerCount", "avgScore", "daily"],
    properties: {
      total: { type: "integer", description: "评审总次数", example: 6 },
      projectCount: { type: "integer", description: "涉及项目数", example: 4 },
      committerCount: { type: "integer", description: "提交人数", example: 4 },
      avgScore: {
        type: "number",
        nullable: true,
        description: "平均分。`null` 表示没有任何带分数的记录。",
        example: 73.2,
      },
      daily: {
        type: "array",
        description: "按日聚合",
        items: {
          type: "object",
          required: ["date", "count", "avgScore"],
          properties: {
            date: { type: "string", example: "2026-10-17" },
            count: { type: "integer", example: 3 },
            avgScore: { type: "number", nullable: true, example: 78.5 },
          },
        },
      },
    },
  },

  PromptSummary: {
    type: "object",
    required: ["id", "repository", "projects", "hasWecomWebhook", "updatedAt"],
    description: "prompt 列表摘要：刻意不含正文。",
    properties: {
      id: { type: "integer", example: 1 },
      repository: { type: "string", description: "唯一键与展示名；`default` 表示全局兜底", example: "通用评审" },
      projects: {
        type: "array",
        description: "关联的 GitLab 项目全名；任一命中即使用本 prompt。default 恒为空数组。",
        items: { type: "string" },
        example: ["auto-ops", "cw-auto-ops"],
      },
      hasWecomWebhook: { type: "boolean", example: true },
      wecomScoreThreshold: { type: "integer", description: "总分低于该值才推送企微", example: 70 },
      providerId: { type: "integer", description: "指定的 LLM 厂商 id；未设置则用全局默认", example: 1 },
      providerLabel: { type: "string", description: "厂商展示名；厂商已删除时为空", example: "DeepSeek" },
      model: { type: "string", description: "指定模型；未设置则用厂商默认模型", example: "deepseek-chat" },
      updatedAt: { type: "integer", description: "Unix 毫秒", example: 1792226620931 },
    },
  },

  StoredPrompt: {
    allOf: [
      { $ref: "#/components/schemas/PromptSummary" },
      {
        type: "object",
        required: ["systemPrompt", "userPrompt"],
        properties: {
          systemPrompt: { type: "string", description: "作为 pi 的 system prompt 全文" },
          userPrompt: {
            type: "string",
            description: "含占位符的模板。`{diffs_text}` 必填，`{commits_text}` 与 `{head_sha}` 可选。",
            example: "以下是代码变更：\n{diffs_text}",
          },
          wecomWebhookUrl: { type: "string", description: "企业微信群机器人 Webhook URL" },
        },
      },
    ],
  },

  PromptCreateRequest: {
    type: "object",
    required: ["repository", "system_prompt", "user_prompt"],
    properties: {
      repository: { type: "string", description: "唯一键与展示名", example: "通用评审" },
      projects: {
        type: "array",
        description: "关联项目列表。不传则默认关联同名项目；传空数组表示不关联；default 恒不绑定。",
        items: { type: "string" },
      },
      system_prompt: { type: "string" },
      user_prompt: { type: "string", description: "必须包含 `{diffs_text}` 占位符" },
      wecom_webhook_url: { type: "string" },
      wecom_score_threshold: { type: "integer", minimum: 0 },
      provider_id: { type: "integer", description: "指定 LLM 厂商；不传用全局默认" },
      model: { type: "string", description: "指定模型；不传用厂商默认模型" },
    },
  },

  PromptUpdateRequest: {
    type: "object",
    required: ["system_prompt", "user_prompt"],
    properties: {
      projects: {
        type: "array",
        description: "不传则保留原有关联；显式传（含空数组）才覆盖",
        items: { type: "string" },
      },
      system_prompt: { type: "string" },
      user_prompt: { type: "string" },
      wecom_webhook_url: { type: "string" },
      wecom_score_threshold: { type: "integer", minimum: 0 },
      provider_id: { type: "integer" },
      model: { type: "string" },
    },
  },

  LlmProviderSummary: {
    type: "object",
    required: ["id", "name", "label", "kind", "baseUrl", "hasApiKey", "api", "models", "isDefault", "updatedAt"],
    properties: {
      id: { type: "integer", example: 1 },
      name: { type: "string", description: "models.json 里的 provider key", example: "deepseek" },
      label: { type: "string", description: "展示名", example: "DeepSeek" },
      kind: { type: "string", description: "厂商类型（模板 kind）", example: "deepseek" },
      baseUrl: { type: "string", example: "https://api.deepseek.com/v1" },
      hasApiKey: { type: "boolean", example: true },
      apiKeyMasked: { type: "string", description: "密钥掩码；未配置时为空", example: "sk-t****3456" },
      api: {
        type: "string",
        enum: ["openai-responses", "openai-completions", "anthropic-messages"],
        example: "openai-completions",
      },
      models: { type: "array", items: { type: "string" }, example: ["deepseek-chat", "deepseek-reasoner"] },
      defaultModel: { type: "string", example: "deepseek-chat" },
      isDefault: { type: "boolean", description: "是否全局默认厂商（全局至多一个）", example: true },
      updatedAt: { type: "integer", example: 1792226620931 },
    },
  },

  LlmProviderInput: {
    type: "object",
    required: ["name", "label", "base_url", "api", "models"],
    properties: {
      name: {
        type: "string",
        description:
          "唯一标识，会成为 models.json 的 provider key 与环境变量名。只允许字母、数字、下划线、短横线。",
        pattern: "^[a-zA-Z0-9_-]+$",
        example: "deepseek",
      },
      label: { type: "string", example: "DeepSeek" },
      kind: { type: "string", description: "厂商类型，来自模板；自定义填 custom", example: "deepseek" },
      base_url: {
        type: "string",
        description: "必须以 http:// 或 https:// 开头",
        example: "https://api.deepseek.com/v1",
      },
      api_key: {
        type: "string",
        description: "API 密钥。更新时不传/空串/掩码形式都表示不修改原密钥。",
        example: "sk-xxxxxxxx",
      },
      api: {
        type: "string",
        enum: ["openai-responses", "openai-completions", "anthropic-messages"],
        example: "openai-completions",
      },
      models: { type: "array", minItems: 1, items: { type: "string" }, example: ["deepseek-chat"] },
      default_model: { type: "string", description: "必须在 models 清单内；不传则用第一个" },
      is_default: { type: "boolean", description: "设为全局默认厂商，会清除其他厂商的默认标记" },
    },
  },

  LlmProviderTemplate: {
    type: "object",
    required: ["kind", "label", "baseUrl", "api", "models"],
    properties: {
      kind: { type: "string", example: "deepseek" },
      label: { type: "string", example: "DeepSeek" },
      baseUrl: { type: "string", example: "https://api.deepseek.com/v1" },
      api: {
        type: "string",
        enum: ["openai-responses", "openai-completions", "anthropic-messages"],
        example: "openai-completions",
      },
      models: { type: "array", items: { type: "string" }, example: ["deepseek-chat", "deepseek-reasoner"] },
    },
  },

  LlmProjectBinding: {
    type: "object",
    required: ["project", "providerId"],
    properties: {
      project: { type: "string", example: "auto-ops" },
      providerId: { type: "integer", example: 1 },
      model: { type: "string", description: "不传则用厂商默认模型", example: "gpt-4o-mini" },
    },
  },

  ConfigItem: {
    type: "object",
    required: ["key", "value", "masked", "restartRequired", "overridden", "readOnly"],
    properties: {
      key: { type: "string", example: "QUEUE_CONCURRENCY" },
      value: { type: "string", description: "生效值；密钥类字段此处已是掩码", example: "5" },
      masked: { type: "boolean", description: "是否密钥类字段", example: false },
      restartRequired: { type: "boolean", description: "是否必须重启才生效", example: true },
      overridden: { type: "boolean", description: "是否已被数据库覆盖", example: false },
      readOnly: { type: "boolean", description: "是否只读（只能通过 .env 修改）", example: false },
    },
  },

  AdminUser: {
    type: "object",
    required: ["id", "username", "isAdmin", "createdAt"],
    properties: {
      id: { type: "integer", example: 1 },
      username: { type: "string", example: "admin" },
      isAdmin: { type: "boolean", description: "是否管理员（由 ADMIN_USERNAME 决定，不存数据库）", example: true },
      createdAt: { type: "integer", description: "Unix 毫秒", example: 1792226620931 },
    },
  },

  AdoptionDimensionRow: {
    type: "object",
    required: ["name", "tracked", "adopted", "rate"],
    properties: {
      name: { type: "string", example: "group/app" },
      tracked: { type: "integer", description: "可统计建议数（不含 unknown 与不可追踪项）", example: 12 },
      adopted: { type: "integer", description: "代码已变化的建议数", example: 7 },
      rate: { type: "number", nullable: true, description: "采纳率 0-1；分母为 0 时为 null", example: 0.583 },
    },
  },

  AdoptionStats: {
    type: "object",
    required: ["total", "untrackable", "byProject", "byCommitter", "bySeverity"],
    properties: {
      total: {
        type: "object",
        required: ["tracked", "adopted", "rate"],
        properties: {
          tracked: { type: "integer", example: 30 },
          adopted: { type: "integer", example: 18 },
          rate: { type: "number", nullable: true, example: 0.6 },
        },
      },
      untrackable: {
        type: "object",
        required: ["fallback", "unknown"],
        properties: {
          fallback: { type: "integer", description: "降级并入汇总评论、无行锚点的建议数", example: 4 },
          unknown: { type: "integer", description: "文件被删除或无法定位的建议数", example: 2 },
        },
      },
      byProject: { type: "array", items: { $ref: "#/components/schemas/AdoptionDimensionRow" } },
      byCommitter: { type: "array", items: { $ref: "#/components/schemas/AdoptionDimensionRow" } },
      bySeverity: { type: "array", items: { $ref: "#/components/schemas/AdoptionDimensionRow" } },
    },
  },

  VerifyTask: {
    type: "object",
    required: ["id", "kind", "status", "message", "detail", "durationMs", "startedAt", "finishedAt"],
    properties: {
      id: { type: "string", example: "8f3c2a1e-..." },
      kind: { type: "string", enum: ["ai", "wecom"], example: "ai" },
      status: { type: "string", enum: ["running", "success", "failed"], example: "success" },
      message: { type: "string", description: "结论或错误原因", example: "AI 评审通过，解析出 17 分" },
      detail: { type: "string", description: "详细输出摘要", example: "# 代码审查报告…" },
      durationMs: { type: "integer", description: "耗时毫秒；未结束时为 0", example: 72432 },
      startedAt: { type: "integer", description: "Unix 毫秒" },
      finishedAt: { type: "integer", nullable: true, description: "Unix 毫秒；未结束时为 null" },
    },
  },

  WecomContact: {
    type: "object",
    required: ["gitlabUsername", "wecomName", "wecomUserId", "updatedAt"],
    properties: {
      gitlabUsername: { type: "string", description: "GitLab 登录名（唯一键，大小写不敏感）", example: "samxiao" },
      wecomName: { type: "string", description: "企微姓名；无 userid 时用于纯文本展示", example: "王秦" },
      wecomUserId: {
        type: "string",
        description: "企微 userid；非空时通知发送真实成员提及，空串表示仅展示姓名",
        example: "wangqin",
      },
      updatedAt: { type: "integer", description: "Unix 毫秒", example: 1792226620931 },
    },
  },
};

// ============ 组装并写盘 ============

const spec = {
  openapi: "3.0.3",
  info: {
    title: "cr-pilot 代码评审服务",
    version: "1.0.0",
    description: [
      "pi 驱动的 GitLab 代码评审服务。GitLab MR webhook 触发后，服务在后台拉取变更、",
      "按仓库自定义 prompt 分批评审、汇总成一份评论并回写到 MR，同时支持行内评论。",
      "",
      "## 鉴权",
      "除 `/health`、`/review/webhook`、`/api/auth/login` 外，全部接口要求",
      "`Authorization: Bearer <token>`，令牌由 `/api/auth/login` 下发。",
      "",
      "## 权限",
      "`/api/admins` 整组要求管理员权限，其余接口所有登录账号可用。",
      "管理员身份由部署配置 `ADMIN_USERNAME` 决定，非管理员调用返回 403。",
      "",
      "## 基础地址",
      "默认 `http://127.0.0.1:5001`。请按实际部署环境调整，不要在文档里写死。",
    ].join("\n"),
  },
  servers: [
    { url: "http://127.0.0.1:5001", description: "本地开发" },
    {
      url: "http://{host}:{port}",
      description: "自定义部署",
      variables: { host: { default: "localhost" }, port: { default: "5001" } },
    },
  ],
  tags: [
    { name: "系统", description: "健康检查" },
    { name: "Webhook", description: "GitLab 事件入口" },
    { name: "认证", description: "登录与登录态" },
    { name: "评审记录", description: "评审明细查询与统计（只读）" },
    { name: "Prompt 管理", description: "按项目维护评审 prompt，支持多项目关联" },
    { name: "AI 厂商", description: "多 LLM 厂商配置与项目级模型绑定" },
    { name: "环境变量", description: "运行期配置管理" },
    { name: "企微映射", description: "GitLab 账号到企微成员的映射，决定通知里 @ 谁" },
    { name: "功能自检", description: "不用等真实 MR，验证 AI 评审与企微推送链路" },
    { name: "管理员账号", description: "账号增删（仅管理员）" },
  ],
  paths,
  components: {
    securitySchemes: {
      [BEARER]: {
        type: "http",
        scheme: "bearer",
        description: "由 `/api/auth/login` 下发的令牌。前端存于 localStorage。",
      },
    },
    schemas,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

const pathCount = Object.keys(paths).length;
const opCount = Object.values(paths).reduce<number>(
  (sum, item) => sum + Object.keys(item as JsonObject).length,
  0,
);
process.stdout.write(
  `OpenAPI 已生成：${OUT}\n` +
    `路径 ${pathCount} 个，操作 ${opCount} 个，数据模型 ${Object.keys(schemas).length} 个\n`,
);

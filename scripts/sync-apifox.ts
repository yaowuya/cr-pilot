/**
 * 把 `docs/openapi.json` 导入 Apifox 项目。
 *
 * 凭证：从 `.agent/.env` 读取 `APIFOX_ACCESS_TOKEN`（该目录已被 gitignore，
 * 凭证不入库）。也可以直接用同名环境变量覆盖。
 *
 * 覆盖策略（`apiOverwriteMode`）：
 * - `methodAndPath`：同 method+path 视为同一接口，原地更新。
 *   选它而不是 `both`（按 method+path+名称）是因为接口名称会随描述微调，
 *   用名称匹配会产生重复接口；也不是 `merge`，`merge` 在重命名时会留下旧副本。
 * - `schemaOverwriteMode: name`：数据模型按名称覆盖，避免每次导入都新增一堆重复模型。
 *
 * 用法：`npm run sync:apifox`（= `node scripts/sync-apifox.ts`）
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Apifox 项目与目标目录（来自项目既有配置，改动时同步更新）。 */
const PROJECT_ID = 8884889;
const API_FOLDER_ID = 96972308;

const MCP_URL = "https://apifox.com/api/v1/mcp";

/** 向上查找仓库根（以 `.agent/.env` 为标记）。 */
function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".agent", ".env"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("未找到仓库根：缺少 .agent/.env");
}

/** 读取 Apifox 访问令牌：环境变量优先，其次 .agent/.env。 */
function readToken(root: string): string {
  const fromEnv = process.env.APIFOX_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envPath = join(root, ".agent", ".env");
  const content = readFileSync(envPath, "utf8");
  const token = content.match(/APIFOX_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim();
  if (!token) throw new Error("APIFOX_ACCESS_TOKEN 未配置（环境变量或 .agent/.env）");
  return token;
}

const root = findRepoRoot();
const token = readToken(root);

/** MCP 会话 id：握手后由服务端下发，后续请求需要回传。 */
let sessionId: string | null = null;

/** 发一条 JSON-RPC 请求并返回第一条消息（兼容 SSE 响应）。 */
async function rpc(payload: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "x-apifox-api-version": "2025-09-01",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload) });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);

  const contentType = res.headers.get("content-type") ?? "";
  let messages: unknown[];
  if (contentType.includes("text/event-stream")) {
    messages = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } else if (text.trim()) {
    messages = [JSON.parse(text)];
  } else {
    messages = [];
  }
  return messages[0];
}

/** 调用一个 MCP 工具，返回解析后的结果。 */
async function callTool(name: string, args: unknown): Promise<unknown> {
  const msg = (await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } } | undefined;

  const result = msg?.result ?? {};
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(`工具 ${name} 调用失败：${text ?? "unknown"}`);
  try {
    return JSON.parse(text ?? "");
  } catch {
    return text;
  }
}

// 握手：必须按 initialize → notifications/initialized 顺序。
await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cr-pilot-apifox-import", version: "1.0.0" },
  },
});
await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

const specPath = join(root, "docs", "openapi.json");
if (!existsSync(specPath)) {
  throw new Error(`找不到 ${specPath}，请先运行 npm run build:openapi`);
}
const spec = readFileSync(specPath, "utf8");
const parsed = JSON.parse(spec) as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
const opCount = Object.values(parsed.paths).reduce<number>(
  (sum, item) => sum + Object.keys(item as Record<string, unknown>).length,
  0,
);

process.stdout.write(
  `准备导入：${Object.keys(parsed.paths).length} 条路径 / ${opCount} 个操作 / ` +
    `${Object.keys(parsed.components.schemas).length} 个数据模型\n`,
);

const result = await callTool("importData", {
  pathParams: { projectId: String(PROJECT_ID) },
  headers: { "X-Project-Id": String(PROJECT_ID) },
  body: {
    importFormat: "openapi",
    data: spec,
    apiOverwriteMode: "methodAndPath",
    schemaOverwriteMode: "name",
    // 按 tag 建子目录，保持项目结构整洁。
    syncApiFolder: true,
    apiFolderId: API_FOLDER_ID,
    // BasePath 放到环境的「前置 URL」，不写进接口路径。
    importBasePath: false,
  },
});

process.stdout.write(`\n=== 导入结果 ===\n${JSON.stringify(result, null, 2)}\n`);

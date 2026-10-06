#!/usr/bin/env node
/**
 * Apifox MCP CLI — https://apifox.com/api/v1/mcp
 *
 * Handles the MCP handshake (initialize -> mcp-session-id -> tools/call), retries once
 * on an expired session, and unwraps the double-encoded tool result so callers get the
 * inner payload instead of the JSON-RPC envelope.
 *
 * Token resolution: APIFOX_ACCESS_TOKEN from the environment, else APIFOX_ACCESS_TOKEN
 * read from .agent/.env found by walking up from the current directory. The token is
 * passed as a fetch header, never written to disk or echoed.
 *
 * Usage:
 *   node apifox-mcp.mjs tools
 *   node apifox-mcp.mjs list-projects
 *   node apifox-mcp.mjs summary        --project 8884889 [--branch 8683450]
 *   node apifox-mcp.mjs refresh-cache  --project 8884889
 *   node apifox-mcp.mjs structure      --project 8884889 [--type endpoint] [--branch] [--module] [--folder]
 *   node apifox-mcp.mjs entity         --project 8884889 --entity 521519124 [--type endpoint] [--with testCase]
 *   node apifox-mcp.mjs export         --project 8884889 [--out .apifox/spec.json] [--format json|yaml] [--scope 1]
 *   node apifox-mcp.mjs import         --project 8884889 --file spec.json [--api-mode methodAndPath] [--schema-mode name]
 *   node apifox-mcp.mjs call <tool>    --args '{"projectId":8884889,"entityType":"endpoint"}'
 *
 * Exit codes: 0 success, 1 failure (message on stderr).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MCP_URL = "https://apifox.com/api/v1/mcp";
const API_VERSION = "2025-09-01";

// ---------------------------------------------------------------- credentials

function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".agent", ".env"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No .agent/.env found walking up from ${resolve(start)}`);
}

function readToken() {
  if (process.env.APIFOX_ACCESS_TOKEN) return process.env.APIFOX_ACCESS_TOKEN.trim();
  const envFile = join(findRepoRoot(), ".agent", ".env");
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*APIFOX_ACCESS_TOKEN\s*=\s*(.+?)\s*$/);
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  throw new Error(`APIFOX_ACCESS_TOKEN not found in ${envFile} nor in the environment`);
}

// ---------------------------------------------------------------- transport

/** Apifox may answer application/json or text/event-stream; normalise both. */
function parseBody(text, contentType) {
  if (contentType?.includes("text/event-stream")) {
    return text
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
  }
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

class ApifoxClient {
  constructor(token) {
    this.token = token;
    this.sessionId = null;
  }

  async rpc(payload, { retryOnStaleSession = false } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "x-apifox-api-version": API_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    const sid = res.headers.get("mcp-session-id");
    const text = await res.text();

    if (res.status === 401) throw new Error("Apifox rejected the access token (HTTP 401); refresh APIFOX_ACCESS_TOKEN in .agent/.env");
    // 400 here means the session is missing or expired; 404 can mean the same after routing.
    if ((res.status === 400 || res.status === 404) && retryOnStaleSession) {
      this.sessionId = null;
      return this.rpc(payload, { retryOnStaleSession: false });
    }
    if (!res.ok) throw new Error(`Apifox HTTP ${res.status}: ${text.slice(0, 500)}`);

    // A notification (no id) is acknowledged with 202 and an empty body; there is
    // nothing to parse, so hand the caller an empty message list rather than failing.
    const messages = parseBody(text, res.headers.get("content-type"));
    if (messages.length === 0) return { sessionId: sid, message: null };
    return { sessionId: sid, message: messages[0] };
  }

  async connect() {
    const { sessionId, message } = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cr-pilot-apifox-skill", version: "1.0.0" },
      },
    });
    if (message.error) throw new Error(`initialize failed: ${JSON.stringify(message.error)}`);
    if (!sessionId) throw new Error("initialize returned no mcp-session-id header");
    this.sessionId = sessionId;
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return sessionId;
  }

  async listTools() {
    if (!this.sessionId) await this.connect();
    const { message } = await this.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    if (!message?.result?.tools) throw new Error("tools/list returned no tools");
    return message.result.tools;
  }

  async call(name, args) {
    if (!this.sessionId) await this.connect();
    const { message } = await this.rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      { retryOnStaleSession: true },
    );
    if (!message?.result) throw new Error(`tool '${name}' returned no result envelope`);

    const result = message.result ?? {};
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (result.isError) throw new Error(`tool '${name}' failed: ${text ?? "unknown error"}`);
    if (text === undefined) throw new Error(`tool '${name}' returned no text content`);

    // Tool payloads arrive as JSON encoded inside a string; unwrap one level.
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === "") throw new Error(`--${name} is required`);
  return v;
}

function num(flags, name) {
  const v = flags[name];
  return v === undefined || v === true ? undefined : Number(v);
}

// ---------------------------------------------------------------- commands

/** Write the full getProjectSummary payload to .apifox/<id>_<name>.settings.json with fetchedAt. */
function writeSummaryCache(projectId, payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!obj.data) throw new Error("getProjectSummary returned no data block");

  const safeName = obj.data.name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ");
  const dir = join(findRepoRoot(), ".apifox");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${projectId}_${safeName}.settings.json`);

  writeFileSync(file, JSON.stringify({ ...obj, fetchedAt: new Date().toISOString() }, null, 2), "utf8");
  return file;
}

const USAGE = `apifox-mcp — Apifox MCP CLI

  tools                                    list available MCP tools
  list-projects                            list accessible Apifox projects
  summary        --project <id> [--branch <id>]
  refresh-cache  --project <id> [--branch <id>]   write .apifox/<id>_<name>.settings.json
  structure      --project <id> [--type endpoint|schema|markdown]
                                           [--branch <id>] [--module <id>] [--folder <id>]
  entity         --project <id> --entity <id> [--type ...] [--branch <id>] [--with testCase]
  export         --project <id> [--out <path>] [--format json|yaml] [--scope 1-4]
  import         --project <id> --file <path> [--api-mode <mode>] [--schema-mode <mode>]
  call <tool>    --args '<json>'           invoke any tool with raw arguments

Token: APIFOX_ACCESS_TOKEN from the environment, else from .agent/.env above this repo.
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  const flags = parseArgs(rest);
  const client = new ApifoxClient(readToken());
  const emit = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

  switch (command) {
    case "tools": {
      const tools = await client.listTools();
      for (const t of tools) console.log(`${t.name}\n  ${(t.description ?? "").split("\n")[0]}`);
      break;
    }

    case "list-projects":
      emit(await client.call("listAccessibleProjects", {}));
      break;

    case "summary": {
      const projectId = requireFlag(flags, "project");
      const args = { projectId: Number(projectId) };
      const branch = num(flags, "branch");
      if (branch) args.branchId = branch;
      emit(await client.call("getProjectSummary", args));
      break;
    }

    case "refresh-cache": {
      const projectId = requireFlag(flags, "project");
      const args = { projectId: Number(projectId) };
      const branch = num(flags, "branch");
      if (branch) args.branchId = branch;
      const payload = await client.call("getProjectSummary", args);
      console.error(`Wrote ${writeSummaryCache(Number(projectId), payload)}`);
      break;
    }

    case "structure": {
      const projectId = requireFlag(flags, "project");
      const args = { projectId: Number(projectId), entityType: flags.type ?? "endpoint" };
      const branch = num(flags, "branch");
      const module = num(flags, "module");
      const folder = num(flags, "folder");
      if (branch) args.branchId = branch;
      if (module) args.moduleId = module;
      if (folder) args.folderId = folder;
      emit(await client.call("getStructureInfo", args));
      break;
    }

    case "entity": {
      const projectId = requireFlag(flags, "project");
      const entityId = requireFlag(flags, "entity");
      const args = {
        projectId: Number(projectId),
        entityType: flags.type ?? "endpoint",
        entityId: Number(entityId),
      };
      const branch = num(flags, "branch");
      if (branch) args.branchId = branch;
      if (flags.with) args.with = flags.with;
      emit(await client.call("readEntityDetails", args));
      break;
    }

    case "export": {
      const projectId = requireFlag(flags, "project");
      const doc = await client.call("exportData", {
        pathParams: { projectId: String(projectId) },
        body: {
          format: flags.format ?? "json",
          type: Number(flags.scope ?? 1),
          version: flags.version ?? "openapi30",
        },
      });
      if (flags.out) {
        const out = resolve(String(flags.out));
        mkdirSync(dirname(out), { recursive: true });
        const text = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);
        writeFileSync(out, text, "utf8");
        console.error(`Wrote ${out} (${text.length} chars)`);
      } else {
        emit(doc);
      }
      break;
    }

    case "import": {
      const projectId = requireFlag(flags, "project");
      const file = requireFlag(flags, "file");
      // Apifox wants the OAS document as a JSON string, not a nested object.
      const data = readFileSync(resolve(String(file)), "utf8");
      JSON.parse(data);
      const body = { importFormat: "openapi", data, apiOverwriteMode: flags["api-mode"] ?? "ignore" };
      if (flags["schema-mode"]) body.schemaOverwriteMode = String(flags["schema-mode"]);
      const result = await client.call("importData", { pathParams: { projectId: String(projectId) }, body });
      emit(result);
      // Surface errors loudly: Apifox reports per-collection counts, not a thrown error.
      if (result?.success === false) process.exitCode = 1;
      else {
        const collections = Object.entries(result?.data ?? {}).filter(([, v]) => v?.item?.errorCount > 0);
        if (collections.length > 0) process.exitCode = 1;
      }
      break;
    }

    case "call": {
      const tool = rest.find((a) => !a.startsWith("--"));
      if (!tool) throw new Error("call requires a tool name: node apifox-mcp.mjs call <tool> --args '<json>'");
      const args = flags.args && flags.args !== true ? JSON.parse(String(flags.args)) : {};
      emit(await client.call(tool, args));
      break;
    }

    default:
      throw new Error(`Unknown command '${command}'. Run with --help.`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`apifox-mcp: ${err.message}`);
    process.exit(1);
  });
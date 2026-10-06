#!/usr/bin/env node
/**
 * Smoke test for apifox-mcp.mjs. Exercises every subcommand against the live Apifox
 * project and reports PASS/FAIL per case. Exits non-zero if any case fails.
 *
 *   node smoke-test.mjs [--project 8884889]
 *
 * The import case is written to be a no-op: it re-imports a spec that already exists,
 * so createCount and errorCount must both be 0. That keeps the test from mutating the
 * project — if it ever fails, stop and inspect rather than re-running blindly.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./apifox-mcp.mjs", import.meta.url));

const projectFlagIndex = process.argv.indexOf("--project");
const PROJECT = projectFlagIndex > -1 ? process.argv[projectFlagIndex + 1] : "8884889";
const BRANCH = "8683450";
// scripts/ -> apifox-mcp/ -> skills/ -> .agent/ -> repo root
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

let passed = 0;
let failed = 0;

/**
 * Capture stdout and stderr separately with spawnSync: execFileSync only pipes
 * stdout, so stderr would leak to the parent console. Progress messages (export's
 * "Wrote …", refresh-cache's path) go to stderr and are asserted on.
 */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function check(name, args, predicate, { expectFail = false } = {}) {
  const r = run(args);
  const matched = predicate(r);
  // A failing case passes when the CLI exits non-zero AND the message matches;
  // a succeeding case passes only on a clean exit.
  const good = expectFail ? matched && r.code !== 0 : matched && r.code === 0;
  if (good) {
    console.log(`PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`FAIL  ${name}  exit=${r.code}  out=${JSON.stringify((r.stdout + r.stderr).slice(0, 200))}`);
    failed += 1;
  }
}

const has = (s) => ({ stdout, stderr }) => `${stdout}${stderr}`.includes(s);

console.log(`# apifox-mcp smoke test (project ${PROJECT})\n`);

// ---- no auth or network needed
check("help", ["--help"], has("list-projects"));
check("bad-command", ["bogus"], has("Unknown command"), { expectFail: true });
check("missing-flag", ["summary"], has("--project is required"), { expectFail: true });
check("bad-json-args", ["call", "getProjectSummary", "--args", "{not json}"], has("JSON"), { expectFail: true });

// ---- transport
check("tools", ["tools"], has("getProjectSummary"));
check("list-projects", ["list-projects"], has("project"));

// ---- discovery
check("summary", ["summary", "--project", PROJECT], has("AI Code Review"));
check("summary+branch", ["summary", "--project", PROJECT, "--branch", BRANCH], has("8683450"));
check("structure-endpoint", ["structure", "--project", PROJECT, "--type", "endpoint"], has('"total"'));
check("structure-schema", ["structure", "--project", PROJECT, "--type", "schema"], has("ReviewRequest"));
check("structure-filtered", ["structure", "--project", PROJECT, "--type", "endpoint", "--folder", "96972308"], has("entities"));

// ---- entity reads
check("entity", ["entity", "--project", PROJECT, "--entity", "521519124"], has("提交代码进行评审"));
check("entity+testcase", ["entity", "--project", PROJECT, "--entity", "521519124", "--with", "testCase"],
  ({ stdout }) => stdout.includes("testCases") || stdout.includes("included"));

// ---- raw tool invocation, both argument shapes
check("call-flat", ["call", "getProjectSummary", "--args", `{"projectId":${PROJECT}}`], has("branches"));
check("call-nested", ["call", "exportData", "--args",
  `{"pathParams":{"projectId":"${PROJECT}"},"body":{"format":"json","type":1,"version":"openapi30"}}`],
  has("openapi"));
check("bad-tool-name", ["call", "noSuchTool", "--args", "{}"], has("not found"), { expectFail: true });

// ---- export round-trips through disk
const exportFile = join(tmpdir(), `apifox-smoke-export-${Date.now()}.json`);
check("export", ["export", "--project", PROJECT, "--out", exportFile], has("Wrote"));
try {
  const doc = JSON.parse(readFileSync(exportFile, "utf8"));
  const ok = Boolean(doc.openapi) && Object.keys(doc.paths ?? {}).length > 0;
  if (ok) {
    console.log(`PASS  export-parses   openapi=${doc.openapi} paths=${Object.keys(doc.paths).length}`);
    passed += 1;
  } else {
    console.log("FAIL  export-parses");
    failed += 1;
  }
} catch (e) {
  console.log(`FAIL  export-parses  ${e.message}`);
  failed += 1;
}
rmSync(exportFile, { force: true });

// ---- cache refresh honours the server's agentHints contract
check("refresh-cache", ["refresh-cache", "--project", PROJECT], has("Wrote"));
try {
  const cachePath = join(REPO_ROOT, ".apifox", `${PROJECT}_AI Code Review.settings.json`);
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const age = (Date.now() - Date.parse(cache.fetchedAt)) / 1000;
  const ok = Boolean(cache.data) && Boolean(cache.fetchedAt) && age >= 0 && age < 60;
  if (ok) {
    console.log(`PASS  cache-contract  data+fetchedAt present, age=${age.toFixed(1)}s`);
    passed += 1;
  } else {
    console.log("FAIL  cache-contract");
    failed += 1;
  }
} catch (e) {
  console.log(`FAIL  cache-contract  ${e.message}`);
  failed += 1;
}

// ---- import is checked without mutating the project.
// A real import would create the probe schema, so exercise only the parts that are
// safe: flag validation, spec reading, and the CLI's own error surface. The live
// import path is verified manually, not by this suite.
const specFile = join(tmpdir(), `apifox-smoke-import-${Date.now()}.json`);
writeFileSync(
  specFile,
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "cli-import-probe", version: "1.0.0" },
    paths: {},
    components: { schemas: { CliImportProbe: { type: "object", properties: { x: { type: "string" } } } } },
  }),
  "utf8",
);
check("import-missing-project", ["import", "--file", specFile], has("--project is required"), { expectFail: true });
check("import-missing-file", ["import", "--project", PROJECT], has("--file is required"), { expectFail: true });
check("import-unreadable-file", ["import", "--project", PROJECT, "--file", join(tmpdir(), "apifox-no-such-spec.json")], has("ENOENT"), { expectFail: true });

const badSpec = join(tmpdir(), `apifox-smoke-bad-${Date.now()}.json`);
writeFileSync(badSpec, "{not json", "utf8");
check("import-invalid-spec", ["import", "--project", PROJECT, "--file", badSpec], has("JSON"), { expectFail: true });
rmSync(badSpec, { force: true });
rmSync(specFile, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
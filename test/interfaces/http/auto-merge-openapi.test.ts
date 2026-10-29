import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface Schema {
  required?: string[];
  description?: string;
  properties?: Record<string, Record<string, unknown>>;
}

const openapi = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as {
  info: { description: string };
  paths: Record<string, {
    post?: { description?: string; responses?: Record<string, unknown>; parameters?: Array<{ name?: string; description?: string }> };
    put?: { description?: string; responses?: Record<string, unknown> };
    delete?: { description?: string; responses?: Record<string, unknown> };
  }>;
  components: { schemas: Record<string, Schema> };
};
const generator = readFileSync(new URL("../../../scripts/build-openapi.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

test("Webhook 契约声明自动合并副作用与任务令牌权限", () => {
  const webhook = openapi.paths["/review/webhook"]?.post;
  assert.match(webhook?.description ?? "", /安全门[\s\S]*GitLab 合并|自动合并[\s\S]*合并 API/);
  const tokens = webhook?.parameters?.filter((parameter) => parameter.name === "X-Gitlab-Token") ?? [];
  assert.equal(tokens.length, 1, "目标分支模式不能引入第二套 GitLab token");
  assert.match(tokens[0]?.description ?? "", /自动合并|合并 MR/);
  assert.match(tokens[0]?.description ?? "", /api.*scope|合并权限/i);
  assert.match(tokens[0]?.description ?? "", /仅 target_mode=default.*默认分支/);
  assert.match(tokens[0]?.description ?? "", /令牌所属 GitLab 账号.*合并身份/);
  assert.match(generator, /显式启用自动合并[\s\S]*合并 API/);
});

test("OpenAPI 以 camelCase 响应项目自动合并策略，并声明安全默认值", () => {
  const policy = openapi.components.schemas.ProjectAutoMergePolicy;
  assert.ok(policy, "缺少 ProjectAutoMergePolicy schema");
  assert.deepEqual(policy.required, ["enabled", "minimumScore", "targetMode", "targetBranches", "method", "removeSourceBranch"]);
  assert.equal(policy.properties?.enabled?.default, false);
  assert.equal(policy.properties?.minimumScore?.minimum, 1);
  assert.equal(policy.properties?.minimumScore?.maximum, 100);
  assert.equal(policy.properties?.minimumScore?.default, 100);
  assert.deepEqual(policy.properties?.targetMode?.enum, ["default", "specified", "any"]);
  assert.equal(policy.properties?.targetMode?.default, "default");
  assert.match(String(policy.properties?.targetMode?.description ?? ""), /默认分支/);
  assert.match(String(policy.properties?.targetMode?.description ?? ""), /any.*危险|危险.*any/i);
  assert.deepEqual(policy.properties?.targetBranches?.default, []);
  assert.match(String(policy.properties?.targetBranches?.description ?? ""), /specified/);
  assert.deepEqual(policy.properties?.method?.enum, ["merge", "squash"]);
  assert.equal(policy.properties?.method?.default, "merge");
  assert.equal(policy.properties?.removeSourceBranch?.default, false);
  assert.match(policy.description ?? "", /evaluator/);
  assert.match(policy.description ?? "", /diffs_text/);

  const storedPrompt = openapi.components.schemas.StoredPrompt;
  assert.match(JSON.stringify(storedPrompt), /自动合并[^\"]*diffs_text/);

  const setting = openapi.components.schemas.ProjectReviewSetting;
  assert.ok(setting.required?.includes("autoMergePolicy"));
  assert.deepEqual(setting.properties?.autoMergePolicy, { $ref: "#/components/schemas/ProjectAutoMergePolicy" });
});

test("OpenAPI 以 snake_case partial patch 接收自动合并策略并记录管理员门禁", () => {
  assert.match(openapi.info.description, /Prompt 自动合并策略写入/);
  assert.match(openapi.info.description, /已启用自动合并项目/);
  assert.match(openapi.info.description, /PUT \/api\/config/);
  assert.match(openapi.info.description, /项目模型绑定/);
  assert.doesNotMatch(openapi.info.description, /其余接口所有登录账号可用/);

  const input = openapi.components.schemas.ProjectAutoMergePolicyInput;
  assert.ok(input, "缺少 ProjectAutoMergePolicyInput schema");
  assert.deepEqual(input.required, ["enabled", "minimum_score", "target_branches", "method", "remove_source_branch"]);
  assert.match(input.description ?? "", /省略 target_mode.*兼容|兼容旧客户端.*省略 target_mode/);
  assert.equal(input.properties?.minimum_score?.minimum, 1);
  assert.deepEqual(input.properties?.target_mode?.enum, ["default", "specified", "any"]);
  assert.equal(input.properties?.target_mode?.default, "default");
  assert.equal(input.properties?.minimum_score?.maximum, 100);
  assert.equal(input.properties?.target_branches?.uniqueItems, true);
  assert.deepEqual(input.properties?.method?.enum, ["merge", "squash"]);

  const patch = openapi.components.schemas.ProjectReviewSettingInput;
  assert.deepEqual(patch.required, ["project"], "项目设置是 partial patch，不能把上下文开关变成必填");
  assert.deepEqual(patch.properties?.auto_merge_policy, { $ref: "#/components/schemas/ProjectAutoMergePolicyInput" });

  const guardedOperations = [
    openapi.paths["/api/prompts"]?.post,
    openapi.paths["/api/prompts/{id}"]?.put,
    openapi.paths["/api/prompts/{id}"]?.delete,
    openapi.paths["/api/prompts/import"]?.post,
  ];
  for (const operation of guardedOperations) {
    assert.ok(operation?.responses?.["403"], "新建、更新、删除与 YAML 导入都要声明自动合并管理员门禁");
    assert.match(operation?.description ?? "", /自动合并[\s\S]*管理员|管理员[\s\S]*自动合并/);
  }
  assert.match(openapi.paths["/api/prompts/{id}"]?.put?.description ?? "", /已启用/);
  assert.match(openapi.paths["/api/prompts/{id}"]?.delete?.description ?? "", /已启用/);
  assert.match(openapi.paths["/api/prompts/import"]?.post?.description ?? "", /已启用/);

  const trustRootWrites = [
    openapi.paths["/api/providers"]?.post,
    openapi.paths["/api/providers/{id}"]?.put,
    openapi.paths["/api/providers/{id}"]?.delete,
    openapi.paths["/api/providers/{id}/default"]?.post,
    openapi.paths["/api/providers/bindings/{project}"]?.put,
    openapi.paths["/api/providers/bindings/{project}"]?.delete,
    openapi.paths["/api/config"]?.put,
  ];
  for (const operation of trustRootWrites) {
    assert.ok(operation?.responses?.["403"], "evaluator 与运行配置信任根写入必须声明管理员门禁");
    assert.match(operation?.description ?? "", /管理员/);
  }
});

test("OpenAPI 生成器拥有自动合并 schema 与安全语义，不能只手改生成产物", () => {
  for (const token of [
    "ProjectAutoMergePolicy:",
    "ProjectAutoMergePolicyInput:",
    "autoMergePolicy",
    "auto_merge_policy",
    "minimum_score",
    "targetMode",
    "target_mode",
    "target_branches",
    "remove_source_branch",
  ]) {
    assert.ok(generator.includes(token), `生成器缺少 ${token}`);
  }
  assert.match(generator, /默认关闭/);
  assert.match(generator, /精确.*目标分支|目标分支.*精确/);
  assert.match(generator, /修改自动合并策略需要管理员权限/);
});

test("README 说明自动合并的权限、GitLab 前提、失败语义与名称级隔离限制", () => {
  assert.match(readme, /### 项目级自动合并/);
  assert.match(readme, /默认安全关闭/);
  assert.match(readme, /完整 `namespace\/project`/);
  assert.match(readme, /一个已启用项目只能关联一个非 `default` Prompt/);
  assert.match(readme, /`api` scope/);
  assert.match(readme, /最终汇总评论非空/);
  assert.match(readme, /CI 状态、审批规则、受保护分支、冲突检测/);
  assert.match(readme, /不回滚/);
  assert.match(readme, /不同 GitLab 实例的同名完整路径仍共享/);
  assert.match(readme, /AI 厂商[^\n]*写操作[^\n]*管理员/);
  assert.match(readme, /PUT `?\/api\/config|`PUT \/api\/config`/);
});

test("README 说明三种目标范围、旧策略迁移和不变的 Webhook token 模型", () => {
  assert.match(readme, /实际合并[^\r\n]*MR 当前目标分支|MR 当前目标分支[^\r\n]*实际合并/);
  assert.match(readme, /`default`[\s\S]*GitLab API[\s\S]*默认分支/);
  assert.match(readme, /`specified`[\s\S]*精确/);
  assert.match(readme, /`any`[\s\S]*危险/);
  assert.match(readme, /旧[^\r\n]*策略[^\r\n]*`specified`/);
  assert.match(readme, /X-Gitlab-Token[\s\S]*凭据模型不变/);
  assert.match(readme, /不新增[^\r\n]*页面[^\r\n]*(?:Token|token)/);
});

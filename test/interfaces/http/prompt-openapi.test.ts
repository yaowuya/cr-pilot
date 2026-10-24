import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPOSITORY_STANDARDS_MAX_LENGTH } from "../../../src/domain/review-prompt.ts";

interface Schema { type?:string; maxLength?:number; description?:string; required?:string[]; properties?:Record<string,Schema>; items?:Schema; $ref?:string; allOf?:Schema[] }
const spec = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url),"utf8")) as {
  components:{schemas:Record<string,Schema>};
  paths:Record<string,{get:{responses:Record<string,{content:{"application/json":{schema:Schema}}}>}}>;
};

test("公开 Prompt schema 记录共享规范、严格布尔、部分更新和 meta 状态", () => {
  const schemas=spec.components.schemas;
  for(const name of ["PromptCreateRequest","PromptUpdateRequest"]) {
    const request=schemas[name];
    assert.equal(request.properties?.repository_standards?.maxLength,REPOSITORY_STANDARDS_MAX_LENGTH);
    assert.equal(request.properties?.project_settings?.items?.$ref,"#/components/schemas/ProjectReviewSettingInput");
    assert(!request.required?.includes("repository_standards"));
    assert(!request.required?.includes("project_settings"));
    assert.match(request.properties!.project_settings.description!,/部分|省略/);
  }
  assert.equal(schemas.ProjectReviewSettingInput.properties?.repository_context_enabled.type,"boolean");
  assert.equal(schemas.ProjectReviewSetting.properties?.repositoryContextEnabled.type,"boolean");
  assert.equal(schemas.PromptSummary.properties?.hasRepositoryStandards.type,"boolean");
  assert.equal(schemas.StoredPrompt.allOf?.[1].properties?.repositoryStandards.maxLength,REPOSITORY_STANDARDS_MAX_LENGTH);
  const meta=spec.paths["/api/prompts/meta"].get.responses["200"].content["application/json"].schema;
  assert.equal(meta.properties?.projectSettings.items?.$ref,"#/components/schemas/ProjectReviewSetting");
  // 存量的短项目名同样可以开启，文档不能声称必须先改成完整路径。
  assert.doesNotMatch(schemas.ProjectReviewSettingInput.properties!.project.description!,/要求.*完整路径/);
  assert.match(schemas.ProjectReviewSettingInput.properties!.project.description!,/短名/);
  // 更新请求必须公开改名能力，并写明 default 例外与重名状态码。
  const update=schemas.PromptUpdateRequest;
  assert.equal(update.properties?.repository?.maxLength,200);
  assert(!update.required?.includes("repository"));
  assert.match(update.properties!.repository.description!,/default/);
  assert.match(update.properties!.repository.description!,/409/);
});

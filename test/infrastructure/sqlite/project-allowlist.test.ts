/**
 * 项目评审白名单只认非 default Prompt 的显式项目关联，不复用 resolve 的兜底结果。
 * 所有用例使用合成数据与独立内存库；缺少 isProjectConfigured 时应明确红测，不能回退放行。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PromptInput } from "../../../src/domain/review-prompt.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";

/** 显式传 projects，避免省略值触发仓储的旧版同名自动关联兼容分支。 */
function input(repository: string, projects: string[]): PromptInput {
  return { repository, projects, systemPrompt: `synthetic-${repository}`, userPrompt: "review {diffs_text}" };
}

/** 走真实初始化与仓储，每个用例结束后释放其独立内存库。 */
function fixture(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return { db, repo: createPromptRepository(db) };
}

test("空库拒绝所有未关联项目，包含名称为 default 的项目", (t) => {
  const { repo } = fixture(t);

  assert.equal(repo.resolve("team/app"), undefined);
  for (const project of ["team/app", "app", "default", "team/default"]) {
    assert.equal(repo.isProjectConfigured(project), false, `${project} 没有任何显式关联`);
  }
});

test("只有 default 时 resolve 仍兜底，但 default 不能授予项目评审资格", (t) => {
  const { repo } = fixture(t);
  const fallback = repo.create(input("default", []));

  assert.equal(repo.resolve("team/app")?.id, fallback.id);
  assert.equal(repo.resolve()?.id, fallback.id);
  for (const project of ["team/app", "default", "team/default"]) {
    assert.equal(repo.isProjectConfigured(project), false, "全局兜底不等于项目已配置");
  }
});

test("向 default 提交 projects 也不能建立评审白名单", (t) => {
  const { repo } = fixture(t);
  const fallback = repo.create(input("default", ["team/app", "app"]));

  assert.deepEqual(fallback.projects, []);
  assert.equal(repo.isProjectConfigured("team/app"), false);
  assert.equal(repo.isProjectConfigured("another-team/app"), false);
});

test("非 default Prompt 没有关联时拒绝，名称与项目全名相同也不能授权", (t) => {
  const { repo } = fixture(t);
  repo.create(input("team/app", []));
  repo.create(input("unused-rules", []));

  assert.equal(repo.resolve("team/app"), undefined, "Prompt 名称不是项目关联");
  for (const project of ["team/app", "app", "unused-rules", "team/unused-rules"]) {
    assert.equal(repo.isProjectConfigured(project), false);
  }
});

test("评审资格来自 projects 而非 Prompt 名称或仓库上下文开关", (t) => {
  const { repo } = fixture(t);
  repo.create(input("shared-review-rules", ["team/app", "team/library"]));

  assert.equal(repo.isProjectConfigured("team/app"), true);
  assert.equal(repo.isProjectConfigured("team/library"), true);
  assert.equal(repo.isRepositoryContextEnabled!("team/app"), false, "关联项目不必开启仓库上下文");
  assert.equal(repo.isProjectConfigured("shared-review-rules"), false);
  assert.equal(repo.isProjectConfigured("team/shared-review-rules"), false);
  assert.equal(repo.isProjectConfigured("team/unlinked"), false);
});

test("完整项目命中优先于先创建的短名规则，且白名单不改变 resolve 优先级", (t) => {
  const { repo } = fixture(t);
  repo.create(input("broad-rules", ["app"]));
  const exact = repo.create(input("exact-rules", ["Team/App"]));

  assert.equal(repo.resolve("  TEAM/APP  ")?.id, exact.id);
  assert.equal(repo.isProjectConfigured("  TEAM/APP  "), true);
  assert.equal(repo.isProjectConfigured("team/other-app"), false);
});

test("项目关联和查询兼容现有 resolve 的大小写与首尾空白归一化", (t) => {
  const { repo } = fixture(t);
  const linked = repo.create(input("normalization-rules", [" \tTeam/App \n"]));

  assert.equal(repo.resolve(" \tTEAM/aPP \n")?.id, linked.id);
  assert.equal(repo.isProjectConfigured(" \tTEAM/aPP \n"), true);
  assert.equal(repo.isProjectConfigured(" team/other-app "), false);
});

test("存量关联自身含首尾空白时仍与 resolve 保持兼容", (t) => {
  const { db, repo } = fixture(t);
  const linked = repo.create(input("legacy-rules", ["team/app"]));
  // 模拟旧版本写入的未修剪关联；当前 create 会先修剪，无法经公开写接口构造。
  db.prepare("UPDATE prompt_projects SET project = ? WHERE prompt_id = ?")
    .run(" \tTeAm/App \n", linked.id);

  assert.equal(repo.resolve(" TEAM/APP ")?.id, linked.id);
  assert.equal(repo.isProjectConfigured(" TEAM/APP "), true);
});

test("短名关联允许多个命名空间下同名项目，但不允许 other-app 或不同短名", (t) => {
  const { repo } = fixture(t);
  repo.create(input("short-name-rules", ["app"]));

  for (const project of ["app", "team/app", "another-team/app", "group/subgroup/app", " TEAM/APP "]) {
    assert.equal(repo.isProjectConfigured(project), true, `${project} 命中显式短名 app`);
  }
  for (const project of ["other-app", "team/other-app", "team/application", "team/apps", "team/worker", "team/app/child"]) {
    assert.equal(repo.isProjectConfigured(project), false, `${project} 不应仅凭字符串后缀或前缀被放行`);
  }
});

test("完整关联不会仅凭相同短名授权另一个命名空间", (t) => {
  const { repo } = fixture(t);
  repo.create(input("full-name-rules", ["team/app"]));

  assert.equal(repo.isProjectConfigured("team/app"), true);
  assert.equal(repo.isProjectConfigured("other-team/app"), false);
  assert.equal(repo.isProjectConfigured("team/other-app"), false);
});

test("短查询匹配存量完整路径的行为与现有 resolve 一致", (t) => {
  const { repo } = fixture(t);
  const linked = repo.create(input("legacy-full-path-rules", ["group/team/app"]));

  for (const project of ["app", "team/app", " GROUP/TEAM/APP "]) {
    assert.equal(repo.resolve(project)?.id, linked.id);
    assert.equal(repo.isProjectConfigured(project), true);
  }
  assert.equal(repo.isProjectConfigured("other-team/app"), false);
});

test("同项目关联多个 Prompt 时，最后一个关联消失才拒绝", (t) => {
  const { repo } = fixture(t);
  const first = repo.create(input("rules-a", ["team/app"]));
  const second = repo.create(input("rules-b", ["TEAM/APP"]));

  assert.equal(repo.isProjectConfigured("team/app"), true);
  repo.remove(first.id);
  assert.equal(repo.isProjectConfigured("team/app"), true, "另一条 Prompt 的关联仍然有效");
  repo.update(second.id, input("rules-b", []));
  assert.equal(repo.isProjectConfigured("team/app"), false, "最后一个关联解绑后立即拒绝");
  repo.update(second.id, input("rules-b", ["team/app"]));
  assert.equal(repo.isProjectConfigured("team/app"), true, "重新关联立即恢复资格");
  repo.remove(second.id);
  assert.equal(repo.isProjectConfigured("team/app"), false);
});

test("同一仓储实例立即反映 projects 的新增、替换和清空，不缓存授权结果", (t) => {
  const { repo } = fixture(t);
  const prompt = repo.create(input("editable-rules", []));

  assert.equal(repo.isProjectConfigured("team/app"), false);
  repo.update(prompt.id, input("editable-rules", ["team/app"]));
  assert.equal(repo.isProjectConfigured("team/app"), true);
  repo.update(prompt.id, input("editable-rules", ["team/worker"]));
  assert.equal(repo.isProjectConfigured("team/app"), false);
  assert.equal(repo.isProjectConfigured("team/worker"), true);
  repo.update(prompt.id, input("editable-rules", []));
  assert.equal(repo.isProjectConfigured("team/worker"), false);
});

test("删除 Prompt 立即撤销其最后关联，即使 resolve 仍能返回 default", (t) => {
  const { repo } = fixture(t);
  const fallback = repo.create(input("default", []));
  const linked = repo.create(input("removable-rules", ["team/app"]));

  assert.equal(repo.isProjectConfigured("team/app"), true);
  repo.remove(linked.id);
  assert.equal(repo.resolve("team/app")?.id, fallback.id);
  assert.equal(repo.isProjectConfigured("team/app"), false);
});

test("Prompt 改名不改变项目评审资格，也不把新旧名称当作关联项目", (t) => {
  const { repo } = fixture(t);
  const linked = repo.create(input("team/old-name", ["team/app"]));

  assert.equal(repo.isProjectConfigured("team/app"), true);
  assert.equal(repo.isProjectConfigured("team/old-name"), false);
  repo.update(linked.id, { repository: "team/new-name", systemPrompt: "changed", userPrompt: "u" });
  assert.equal(repo.isProjectConfigured("team/app"), true, "只改名称保留 projects");
  assert.equal(repo.isProjectConfigured("team/new-name"), false);
  assert.equal(repo.isProjectConfigured("team/old-name"), false);
});

test("损坏或旧版本遗留在 default 上的全名和短名关联不能放行", (t) => {
  const { db, repo } = fixture(t);
  const fallback = repo.create(input("default", []));
  // 正常写接口禁止 default 关联；直接注入仅用于模拟损坏/遗留数据。
  const insert = db.prepare("INSERT INTO prompt_projects (prompt_id, project) VALUES (?, ?)");
  insert.run(fallback.id, "team/app");
  insert.run(fallback.id, "worker");

  assert.equal(repo.resolve("team/app")?.id, fallback.id);
  for (const project of ["team/app", "app", "worker", "team/worker", "default"]) {
    assert.equal(repo.isProjectConfigured(project), false, "default 上的关联不是有效授权来源");
  }
});

test("default 遗留关联先被 resolve 命中时，仍认可其他非 default Prompt 的有效关联", (t) => {
  const { db, repo } = fixture(t);
  const fallback = repo.create(input("default", []));
  db.prepare("INSERT INTO prompt_projects (prompt_id, project) VALUES (?, ?)")
    .run(fallback.id, "team/app");
  repo.create(input("valid-short-name-rules", ["app"]));

  assert.equal(repo.resolve("team/app")?.id, fallback.id, "保留既有 resolve 的全名优先行为");
  assert.equal(repo.isProjectConfigured("team/app"), true, "白名单必须查询有效关联，不能只检查 resolve 的首条结果");
});

test("孤立关联和孤立仓库开关都不能替代非 default Prompt 的有效关联", (t) => {
  const { db, repo } = fixture(t);
  // 仅在内存夹具里关闭外键以模拟损坏旧库，随后立即恢复。
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO prompt_projects (prompt_id, project) VALUES (?, ?)").run(999, "team/orphan");
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO project_review_settings (project, repository_context_enabled, updated_at) VALUES (?, 1, 1)")
    .run("team/settings-only");

  assert.equal(repo.isProjectConfigured("team/orphan"), false);
  assert.equal(repo.isProjectConfigured("team/settings-only"), false);
});

for (const project of ["team/app", "team/unlinked"]) {
  test(`数据库关闭后查询 ${project} 必须抛出读取错误，不能吞错或返回缓存授权`, () => {
    const db = openDatabase(":memory:");
    const repo = createPromptRepository(db);
    try {
      repo.create(input("linked-rules", ["team/app"]));
      assert.equal(repo.isProjectConfigured("team/app"), true, "先读取有效授权以暴露缓存放行");
    } finally {
      db.close();
    }

    assert.throws(
      () => repo.isProjectConfigured(project),
      { code: "ERR_INVALID_STATE" },
      "SQLite 读取异常必须交给调用方 fail closed；缺方法 TypeError 也不能伪装成预期异常",
    );
  });
}

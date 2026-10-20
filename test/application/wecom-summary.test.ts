import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMergeRequestUrl,
  buildWecomMessage,
  countFindingsBySeverity,
} from "../../src/application/review-pipeline.ts";

/** 构造一条典型评审正文（含 P0/P1/P2 与代码块）。 */
const COMMENT_WITH_CODE = `代码审查报告

审查范围：本次变更涉及后端权限与前端构建产物。

P0：部分拓扑权限被错误扩大为整个业务权限
- 位置： \`apps/task_mgmt/service/dynamic_topo_service.py:429-434\`
- 问题：
\`\`\`python
if partial_permission_biz_ids:
    biz_node_data = {bk_biz_id: ["biz|{var1}".format(var1=bk_biz_id)] for bk_biz_id in sorted(partial_permission_biz_ids)}
\`\`\`
- 建议：使用实际授权节点集合查询主机。

---

P1：通知组搜索按用户循环查询关联关系，存在 N+1 查询
- 位置： \`apps/system_mgmt/filters/notice_group_filter.py:22-25\`
- 问题：
\`\`\`python
for i in user:
    group_id.extend(i.notice_group.all().values_list("id", flat=True))
\`\`\`

---

P2：命名不一致
- 位置： \`apps/x.py:1\`
`;

test("buildMergeRequestUrl 按 GitLab 规则拼接", () => {
  assert.equal(
    buildMergeRequestUrl({ gitlabUrl: "https://code.cwoa.net", fullName: "group/proj", iid: 5391 }),
    "https://code.cwoa.net/group/proj/-/merge_requests/5391",
  );
});

test("buildMergeRequestUrl 去掉实例地址尾部斜杠，避免双斜杠", () => {
  assert.equal(
    buildMergeRequestUrl({ gitlabUrl: "https://code.cwoa.net///", fullName: "a/b", iid: 1 }),
    "https://code.cwoa.net/a/b/-/merge_requests/1",
  );
});

test("buildMergeRequestUrl 缺实例地址或项目名时返回 null", () => {
  // 宁可不给链接，也不给一个点开 404 的地址
  assert.equal(buildMergeRequestUrl({ gitlabUrl: undefined, fullName: "a/b", iid: 1 }), null);
  assert.equal(buildMergeRequestUrl({ gitlabUrl: "  ", fullName: "a/b", iid: 1 }), null);
  assert.equal(buildMergeRequestUrl({ gitlabUrl: "https://x", fullName: "", iid: 1 }), null);
});

test("countFindingsBySeverity 统计各级别数量", () => {
  const counts = countFindingsBySeverity(COMMENT_WITH_CODE);
  assert.equal(counts.p0, 1);
  assert.equal(counts.p1, 1);
  assert.equal(counts.p2, 1);
  assert.equal(counts.total, 3);
});

test("countFindingsBySeverity 不把代码里的 P0 误计", () => {
  // 只匹配行首的问题条目，正文代码块里出现的 "P0" 不该被计入
  const text = ["P0：真正的问题", "```python", "log_level = 'P1：不是问题'", "```"].join("\n");
  const counts = countFindingsBySeverity(text);
  assert.equal(counts.total, 1, "代码块内的 P1 不应计入");
  assert.equal(counts.p0, 1);
});

test("countFindingsBySeverity 支持列表项与加粗写法", () => {
  const text = ["- P0: 甲", "* P1：乙", "**P2**：丙"].join("\n");
  const counts = countFindingsBySeverity(text);
  assert.equal(counts.p0, 1);
  assert.equal(counts.p1, 1);
  assert.equal(counts.p2, 1);
});

test("企微消息只发摘要，不含评审正文与代码块", () => {
  const message = buildWecomMessage({
    projectId: 1,
    iid: 5391,
    fullName: "rd-fy21-canway-GOAC/auto-ops",
    sourceBranch: "dev/wq/3.7-two",
    targetBranch: "develop/3.8-tmp",
    score: 58,
    comment: COMMENT_WITH_CODE,
    mrUrl: "https://code.cwoa.net/rd-fy21-canway-GOAC/auto-ops/-/merge_requests/5391",
  });

  // 必须包含摘要要素
  assert.match(message, /代码评审提醒/);
  assert.match(message, /!5391/);
  assert.match(message, /58 分/);
  assert.match(message, /\*\*P0\*\* 1 个/);
  assert.match(message, /\*\*P1\*\* 1 个/);
  assert.match(message, /共 3 个/);

  // 绝不能包含代码详情——这是用户明确抱怨的点
  assert.equal(message.includes("```"), false, "消息里不得出现代码块");
  assert.equal(message.includes("partial_permission_biz_ids"), false, "不得包含代码内容");
  assert.equal(message.includes("位置："), false, "不得包含问题正文");
  assert.equal(message.includes("建议："), false, "不得包含建议正文");
});

test("企微消息带可点击的 MR 链接", () => {
  const message = buildWecomMessage({
    projectId: 1,
    iid: 5391,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 58,
    comment: "P0：x",
    mrUrl: "https://code.cwoa.net/a/b/-/merge_requests/5391",
  });
  // 企微 markdown 的链接语法：[文本](url)
  assert.match(message, /\[👉 查看 MR 与完整评审\]\(https:\/\/code\.cwoa\.net\/a\/b\/-\/merge_requests\/5391\)/);
});

test("企微消息在 MR 链接下方单独一行提及提交人", () => {
  const mrUrl = "https://code.cwoa.net/a/b/-/merge_requests/5391";
  const message = buildWecomMessage({
    projectId: 1,
    iid: 5391,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 58,
    comment: "P0：x",
    mrUrl,
    authorUsername: " author.a-1 ",
  });

  assert.ok(message.endsWith(`[👉 查看 MR 与完整评审](${mrUrl})\n\n<@author.a-1>`));
  assert.equal(message.split("\n").at(-1), "<@author.a-1>");
  assert.equal(message.includes("```"), false, "成员提及不能放进代码块，否则不会触发提醒");
});

test("无 MR 链接时，提交人提及仍是最后一行", () => {
  const message = buildWecomMessage({
    projectId: 1,
    iid: 1,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 50,
    comment: "整体看起来没问题。",
    mrUrl: null,
    authorUsername: "author-a",
  });

  assert.ok(message.endsWith("详见 MR 评论\n\n<@author-a>"));
  assert.equal(message.includes("查看 MR"), false);
});

test("缺少或不安全的作者账号时保持原通知，不提及全员或注入其他成员", () => {
  const input = {
    projectId: 1,
    iid: 1,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 50,
    comment: "P1：y",
    mrUrl: "https://x/a/b/-/merge_requests/1",
  };
  const withoutMention = buildWecomMessage(input);
  for (const authorUsername of [undefined, "", " \t ", "all", "ALL", "<@all>", "author>\n<@all", "张三", "two users"]) {
    assert.equal(buildWecomMessage({ ...input, authorUsername }), withoutMention, `无效账号：${authorUsername}`);
  }
});

test("无 mrUrl 时不输出链接行，也不留空行尾巴", () => {
  const message = buildWecomMessage({
    projectId: 1,
    iid: 1,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 50,
    comment: "P1：y",
    mrUrl: null,
  });
  assert.equal(message.includes("查看 MR"), false);
  assert.equal(message.endsWith("\n"), false, "不应留空行");
});

test("未识别出分级问题时给出明确说明而不是空白", () => {
  const message = buildWecomMessage({
    projectId: 1,
    iid: 1,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 50,
    comment: "整体看起来没问题。",
    mrUrl: "https://x/a/b/-/merge_requests/1",
  });
  assert.match(message, /未识别到分级问题/);
});

test("摘要消息体积远小于完整正文，不会触发 4096 字节截断", () => {
  // 用一个超长正文验证：摘要只取统计，不受正文长度影响
  const hugeComment = `${COMMENT_WITH_CODE}\n${"重复内容。".repeat(2000)}`;
  const message = buildWecomMessage({
    projectId: 1,
    iid: 1,
    fullName: "a/b",
    sourceBranch: "f",
    targetBranch: "m",
    score: 58,
    comment: hugeComment,
    mrUrl: "https://x/a/b/-/merge_requests/1",
  });
  const bytes = new TextEncoder().encode(message).length;
  assert.ok(bytes < 1000, `摘要应远小于 4096 字节，实际 ${bytes}`);
});

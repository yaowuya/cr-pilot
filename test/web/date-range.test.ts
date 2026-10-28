import { test } from "node:test";
import assert from "node:assert/strict";
import { inclusiveCalendarRange } from "../../web/src/date-range.ts";

test("日历筛选包含结束日 23:59:59.999，且不固定按 24 小时推算", () => {
  const start = new Date(2026, 9, 27, 12, 30).getTime();
  const end = new Date(2026, 9, 28).getTime();
  assert.deepEqual(inclusiveCalendarRange([String(start), String(end)]), {
    from: String(new Date(2026, 9, 27, 0, 0, 0, 0).getTime()),
    to: String(new Date(2026, 9, 28, 23, 59, 59, 999).getTime()),
  });
});

test("清空日历不会附加时间筛选；非法值交给 API 校验而非伪造日期", () => {
  assert.deepEqual(inclusiveCalendarRange(null), {});
  assert.deepEqual(inclusiveCalendarRange(["bad", "also-bad"]), { from: "bad", to: "also-bad" });
});

/**
 * 将日历范围转为后端的闭区间时间戳。
 * 不依赖日期选择器是否保留毫秒；本地 setHours 同时保留 DST 日历语义。
 */
export function inclusiveCalendarRange(range: [string, string] | null): { from?: string; to?: string } {
  if (!range) return {};
  const start = new Date(Number(range[0]));
  const end = new Date(Number(range[1]));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return { from: range[0], to: range[1] };
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { from: String(start.getTime()), to: String(end.getTime()) };
}

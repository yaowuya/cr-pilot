/**
 * 变更分批纯逻辑：token 估算与按预算拆分。
 *
 * 全部为纯函数、零 IO，领域层可独立测试。算法依据设计决策 D-005：
 * 按字符数/4 估算 token（有意偏保守），单批预算取配置值的 85% 作安全阈值。
 */
import type { Change } from "./review-task.ts";

/**
 * 估算文本 token 数：按字符数/4 向上取整。
 *
 * 有意偏保守：代码约 3-4 字符/token，按 4 估算会让批次偏小而不是偏大，
 * 保证任何单批都不会超过模型上下文。内网模型词表未知，精确 tokenizer 收益
 * 有限，见设计决策 D-005。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 单批 token 预算的安全系数：只使用预算的 85%，为估算误差与 prompt 开销留余量。 */
const BATCH_THRESHOLD_RATIO = 0.85;

/**
 * 把变更列表按 token 预算拆成多批。
 *
 * 规则：整文件塞得下就整文件装箱；单个文件超预算时按 diff 行拆（保留文件路径
 * 元信息）；单行仍超预算时按字符切。`promptOverheadTokens` 是 system/user prompt
 * 与提交信息占用的预算，先扣除再装箱。
 */
export function splitChangesIntoBatches(
  changes: Change[],
  maxTokens: number,
  promptOverheadTokens: number,
): Change[][] {
  const threshold = Math.floor(maxTokens * BATCH_THRESHOLD_RATIO) - promptOverheadTokens;
  if (threshold <= 0) {
    // 预算连 prompt 都装不下：每个文件单列一批，由调用方在评审时暴露问题。
    return changes.map((change) => [change]);
  }

  const units: Change[] = [];
  for (const change of changes) {
    if (estimateTokens(change.diff) <= threshold) {
      units.push(change);
      continue;
    }
    for (const part of splitByDiffLines(change, threshold)) {
      units.push(part);
    }
  }

  const batches: Change[][] = [];
  let current: Change[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const unitTokens = estimateTokens(unit.diff);
    if (current.length > 0 && currentTokens + unitTokens > threshold) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** 把单个超预算文件按 diff 行拆成多个保留元信息的 Change。 */
function splitByDiffLines(change: Change, threshold: number): Change[] {
  const lines = change.diff.split("\n");
  const parts: Change[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    parts.push({ ...change, diff: current.join("\n") });
    current = [];
    currentTokens = 0;
  };
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (lineTokens > threshold) {
      flush();
      for (const chunk of splitByCharacters(line, threshold)) {
        parts.push({ ...change, diff: chunk });
      }
      continue;
    }
    if (currentTokens + lineTokens > threshold) {
      flush();
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  flush();
  return parts.length > 0 ? parts : [{ ...change }];
}

/** 把单行超预算的文本按字符切块，每块不超过阈值。 */
function splitByCharacters(line: string, threshold: number): string[] {
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    const take = Math.max(threshold * 4, 1);
    chunks.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  return chunks;
}

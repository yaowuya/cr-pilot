import { readFile } from "node:fs/promises";

/**
 * prompt 文件不可用时抛出。
 *
 * 与 pi 调用失败区分开：前者是服务端配置问题，路由映射成 500；后者映射成 502。
 */
export class PromptFileError extends Error {
  override readonly name = "PromptFileError";
}

/**
 * 读取评审 prompt 全文。
 *
 * 每次请求都重新读取，这样改 prompt 不需要重启服务，也避免为一份小文件引入
 * 缓存与失效逻辑。返回前去掉首尾空白，纯空白文件按不可用处理。
 */
export async function loadReviewPrompt(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PromptFileError(`prompt 文件不可读：${path}`, { cause: error });
  }
  const prompt = raw.trim();
  if (!prompt) {
    throw new PromptFileError(`prompt 文件内容为空：${path}`);
  }
  return prompt;
}

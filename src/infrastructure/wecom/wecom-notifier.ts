import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { WecomNotifier } from "../../domain/review-task.ts";

// 领域端口类型由 domain 持有，这里重导出保持既有导入路径兼容。
export type { WecomNotifier };

/** 企业微信机器人 markdown 消息的字节上限（企微官方 4096 字节）。 */
const WECOM_MARKDOWN_MAX_BYTES = 4096;

interface CreateWecomNotifierOptions {
  logger?: Logger;
  /** 可注入的 fetch，测试用。 */
  fetchFn?: typeof fetch;
}

/**
 * 创建企业微信群机器人通知器（实现 domain 的 `WecomNotifier` 端口）。
 *
 * 企微机器人 webhook 契约：POST JSON `{"msgtype":"markdown","markdown":{"content":...}}`，
 * 成功返回 `{"errcode":0}`。内容超过 4096 字节时按字节截断并加省略提示——
 * 企微 markdown 超限会整体发送失败，截断比失败更可用。不新增 HTTP 依赖，
 * 复用全局 fetch。
 */
export function createWecomNotifier(options: CreateWecomNotifierOptions = {}): WecomNotifier {
  const logger = options.logger ?? createSilentLogger();
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async send(webhookUrl, markdown) {
      const content = truncateUtf8Bytes(markdown, WECOM_MARKDOWN_MAX_BYTES);
      const response = await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
      });
      if (!response.ok) {
        throw new Error(`企业微信返回 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { errcode?: number; errmsg?: string };
      if (payload.errcode !== undefined && payload.errcode !== 0) {
        throw new Error(`企业微信返回错误 errcode=${payload.errcode} errmsg=${payload.errmsg ?? ""}`);
      }
      logger.info("企业微信消息已发送", { bytes: new TextEncoder().encode(content).length });
    },
  };
}

/**
 * 按 UTF-8 字节截断文本，保证不解码出半个字符。
 * 企微 markdown 上限 4096 字节；超限时截断到上限并追加省略提示。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const suffix = encoder.encode("\n…（内容过长，已截断）");
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes - suffix.length));
  return `${cut}${new TextDecoder().decode(suffix)}`;
}

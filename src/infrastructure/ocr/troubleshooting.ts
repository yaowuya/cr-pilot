import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { OcrDiagnostics } from "../../domain/ocr-review.ts";

const TRACE_LIFETIME_MS = 45 * 60 * 1000;

interface OcrTroubleshootingTrace {
  projectId: number;
  iid: number;
  base: string;
  head: string;
  diagnostics: OcrDiagnostics | undefined;
  completions: Array<{ text: string; truncated: boolean }>;
}

/** 保留判断建议是否存在所需的正文，清理已知凭据、常见令牌和多行代码。 */
export function redactCompletionText(text: string, credentials: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const credential of credentials) {
    if (credential) redacted = redacted.replaceAll(credential, "[凭据已隐去]");
  }
  return redacted
    .replace(/```[\s\S]*?(?:```|$)/gu, "[代码块已隐去]")
    .replace(/https?:\/\/[^\s<>`"']+/giu, "[地址已隐去]")
    .replace(/\b(?:authorization|x-api-key|private[_ -]?token|api[_ -]?key|password|secret|token)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, "[凭据已隐去]")
    .replace(/\b(?:glpat-[\w-]{8,}|gh[pousr]_[\w-]{8,}|sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gu, "[凭据已隐去]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

/** 仅写入临时私有目录；普通服务日志可以用返回的标识定位文件。 */
export async function writeOcrTroubleshootingTrace(root: string, trace: OcrTroubleshootingTrace): Promise<{ status: "written"; id: string }> {
  if (!isAbsolute(root)) throw new Error("OCR 排障目录须为绝对路径");
  const info = await lstat(root);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("OCR 排障目录须为私有目录");
  }
  const directory = await mkdtemp(join(root, "cr-pilot-ocr-detail-"));
  const cleanup = () => rm(directory, { recursive: true, force: true }).catch(() => undefined);
  try {
    await writeFile(join(directory, "trace.json"), JSON.stringify({ capturedAt: new Date().toISOString(), ...trace }), {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  setTimeout(() => { void cleanup(); }, TRACE_LIFETIME_MS).unref();
  return { status: "written", id: basename(directory) };
}

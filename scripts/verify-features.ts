/**
 * 功能验证 CLI：不依赖 GitLab 与真实 MR，直接验证 AI 评审与企微推送两条链路。
 *
 * 验证逻辑在 `src/application/feature-verifier.ts`，与页面「功能自检」按钮共用
 * 同一份实现，本脚本只负责参数解析与终端输出，避免两套逻辑漂移。
 *
 * 用法：
 *   node scripts/verify-features.ts ai
 *   node scripts/verify-features.ts wecom [--confirm-send] [--webhook <url>]
 *   node scripts/verify-features.ts all [--confirm-send] [--webhook <url>]
 *
 * 安全边界：不写数据库、不发 MR 评论、不改仓库文件。企微默认只预览，
 * 必须 `--confirm-send` 才真的发送。
 */
import { loadConfig } from "../src/shared/config.ts";
import { createConsoleLogger } from "../src/shared/logger.ts";
import { createFeatureVerifier } from "../src/application/feature-verifier.ts";

/** 一次验证运行的配置。 */
interface VerifyOptions {
  /** 子命令：ai / wecom / all。 */
  target: "ai" | "wecom" | "all";
  /** 为 true 时真的要发企微消息。 */
  confirmSend: boolean;
  /** 覆盖规则文件里的 webhook 地址，用于发到测试群。 */
  webhook?: string;
}

/** 解析命令行参数；未知参数直接报错，避免拼错后静默跑错分支。 */
function parseArgs(argv: string[]): VerifyOptions {
  const target = argv[0];
  if (target !== "ai" && target !== "wecom" && target !== "all") {
    throw new Error(`用法：verify-features.ts <ai|wecom|all> [--confirm-send] [--webhook <url>]，实际收到：${target ?? "(空)"}`);
  }
  const options: VerifyOptions = { target, confirmSend: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-send") {
      options.confirmSend = true;
      continue;
    }
    if (arg === "--webhook") {
      const value = argv[index + 1];
      if (!value || !/^https?:\/\//i.test(value)) {
        throw new Error("--webhook 需要一个 http(s) 地址");
      }
      options.webhook = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 加载 .env（存在才加载），与主程序保持一致。 */
function loadEnvFileIfPresent(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 打印一次验证结果；失败时设置非零退出码。 */
function report(label: string, outcome: { success: boolean; message: string; detail: string; durationMs: number }): void {
  const mark = outcome.success ? "✓" : "✗";
  process.stdout.write(`${mark} ${label}：${outcome.message}（${(outcome.durationMs / 1000).toFixed(1)} 秒）\n`);
  if (outcome.detail) process.stdout.write(`\n----- ${label}详情 -----\n${outcome.detail.slice(0, 800)}\n----------------------\n`);
  if (!outcome.success) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnvFileIfPresent(".env");
  const logger = createConsoleLogger("info");
  const config = loadConfig();
  const verifier = createFeatureVerifier({ config, logger });

  process.stdout.write(`验证目标：${options.target}${options.confirmSend ? "（会真实发送）" : ""}\n`);
  process.stdout.write(`模型配置目录：${process.env.PI_CODING_AGENT_DIR?.trim() || "pi-agent"}\n\n`);

  if (options.target === "ai") {
    report("AI 评审", await verifier.verifyAi());
    return;
  }
  if (options.target === "wecom") {
    report("企微推送", await verifier.verifyWecom({ webhookOverride: options.webhook, dryRun: !options.confirmSend }));
    return;
  }

  // all：先真实评审，再发企微；企微消息用固定样例内容，避免把长评审正文发进群。
  report("AI 评审", await verifier.verifyAi());
  report("企微推送", await verifier.verifyWecom({ webhookOverride: options.webhook, dryRun: !options.confirmSend }));
}

main().catch((error: unknown) => {
  process.stderr.write(`✗ 验证失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

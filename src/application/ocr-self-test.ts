import type { OcrDiagnostics, OcrReviewResult } from "../domain/ocr-review.ts";
import type { LlmProviderRepository, ResolvedLlmTarget } from "../domain/llm-provider.ts";
import type { PromptRepository } from "../domain/review-prompt.ts";
import type { Logger } from "../shared/logger.ts";
import type { VerifyOutcome } from "./feature-verifier.ts";
import { buildOcrReport } from "./ocr-review-result.ts";
import { resolveReviewLlmTarget } from "./review-pipeline.ts";

const SELF_TEST_TIMEOUT_MS = 90_000;
const EXPECTED_DEFECT = /ZeroDivisionError|divis(?:ion|or)[^\n]{0,45}(?:zero|\b0\b)|divid(?:e[sd]?|ing)[^\n]{0,25}(?:zero|\b0\b)|除零|除以\s*[零0]|除数[^\n]{0,12}[零0]|零作除数/iu;

interface SelfTestFixture {
  path: string;
  line: number;
  baseSha: string;
  headSha: string;
}

export interface OcrSelfTestRunResult extends OcrReviewResult {
  fixture: SelfTestFixture;
  /** 记录 OCR 原始 comments 字段的实际形状。 */
  rawCommentsFormat?: "array" | "null";
}

export interface OcrSelfTestOutcome extends VerifyOutcome {
  ocr?: {
    project?: string;
    provider?: string;
    model?: string;
    verdict: "detected" | "missed" | "incomplete";
    fixture: SelfTestFixture;
    filesReviewed: number;
    complete: boolean;
    score: number | null;
    findings: Array<{ path: string; line: number; severity: string; message: string }>;
    diagnostics?: OcrDiagnostics;
    rawCommentsFormat?: "array" | "null";
  };
}

interface OcrSelfTestDeps {
  logger: Logger;
  run(input: { llmTarget?: ResolvedLlmTarget; signal: AbortSignal }): Promise<OcrSelfTestRunResult>;
  prompts?: Pick<PromptRepository, "resolve" | "isProjectConfigured">;
  providers?: LlmProviderRepository;
  timeoutMs?: number;
}

/** 用固定除零样例验证真实 OCR 调用、文件覆盖和结构化建议；不访问指定项目的仓库。 */
export function createOcrSelfTestVerifier(deps: OcrSelfTestDeps): (project?: string) => Promise<OcrSelfTestOutcome> {
  return async (project) => {
    const started = Date.now();
    const signal = AbortSignal.timeout(Math.min(deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS, SELF_TEST_TIMEOUT_MS));
    const failure = (message: string): OcrSelfTestOutcome => ({
      success: false, message, detail: "", durationMs: Date.now() - started,
    });
    try {
      if (project && deps.prompts && !deps.prompts.isProjectConfigured(project)) {
        return failure("该项目尚未配置代码评审");
      }
      const target = resolveReviewLlmTarget(deps.providers, project, project ? deps.prompts?.resolve(project) : undefined);
      const output = await deps.run({ llmTarget: target, signal });
      const complete = output.complete && output.filesReviewed === 1;
      const score = buildOcrReport({ ...output, complete }).score;
      // 模型返回的位置也需要符合固定样例范围；汇总诊断仍保留 OCR 的原始计数。
      const fixtureFindings = output.findings.filter(({ path }) => path === output.fixture.path);
      const detected = fixtureFindings.some(({ body }) => EXPECTED_DEFECT.test(body));
      const verdict = !complete ? "incomplete" : detected ? "detected" : "missed";
      const findings = fixtureFindings.slice(0, 20).map(({ path, line, severity, body }) => ({
        path, line, severity, message: body.slice(0, 2048),
      }));
      const message = verdict === "detected" ? "OCR 自检通过，已识别样例中的除零错误"
        : verdict === "incomplete" ? "OCR 未完成样例评审"
        : "OCR 已完成评审，但未识别样例中的除零错误";
      deps.logger.info("OCR 自检完成", {
        项目: project, 模型厂商: target?.provider.name, 模型: target?.model, 状态: verdict,
        已评审文件数: output.filesReviewed, 建议数: output.findings.length, 评分: score,
      });
      return {
        success: verdict === "detected",
        message,
        detail: `${output.fixture.path}:${output.fixture.line} · OCR 返回 ${output.findings.length} 条建议`,
        durationMs: Date.now() - started,
        ocr: {
          project, provider: target?.provider.name, model: target?.model, verdict,
          fixture: output.fixture, filesReviewed: output.filesReviewed, complete, score, findings,
          diagnostics: output.diagnostics, rawCommentsFormat: output.rawCommentsFormat,
        },
      };
    } catch {
      // OCR 或模型错误正文可能带配置细节。自检 API 只返回可定位的失败阶段。
      deps.logger.warn("OCR 自检执行失败", { 项目: project, 超时: signal.aborted });
      return failure(signal.aborted ? "OCR 自检超时" : "OCR 自检执行失败，请检查服务配置");
    }
  };
}

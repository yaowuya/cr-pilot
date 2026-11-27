import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedLlmTarget } from "../../domain/llm-provider.ts";
import type { OcrReviewResult } from "../../domain/ocr-review.ts";
import { buildGitEnvironment, createGitRunner, type GitRunner } from "../git/git-runner.ts";
import { createOcrReviewer } from "./reviewer.ts";
import { redactCompletionText } from "./troubleshooting.ts";

export const OCR_SELF_TEST_FIXTURE = { path: "src/order_totals.py", line: 3 } as const;

export type OcrSelfTestResult = OcrReviewResult & {
  fixture: typeof OCR_SELF_TEST_FIXTURE & { baseSha: string; headSha: string };
  rawCommentsFormat?: "array" | "null";
};

const INSTANCE = "https://ocr-self-test.invalid";
const REPOSITORY = `${INSTANCE}/synthetic/order-totals.git`;
const SOURCE_BRANCH = "self-test";
const BASE = 'def calculate_tax(subtotal: float) -> float:\n    """Calculate twenty percent tax on an order."""\n    return subtotal * 0.2\n';
const HEAD = BASE.replace("subtotal * 0.2", "subtotal // 0");
const CHANGE_MESSAGE = "Update calculation for order tax";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** 通过同一个 OCR 引擎评审固定的合成改动。Git 对象只从本次创建的本地 bundle 导入。 */
export async function runOcrSelfTest(
  { llmTarget, signal }: { llmTarget?: ResolvedLlmTarget; signal: AbortSignal },
  { env = process.env, ocrRunner }: { env?: NodeJS.ProcessEnv; ocrRunner?: GitRunner } = {},
): Promise<OcrSelfTestResult> {
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "cr-pilot-ocr-self-test-"));
  try {
    const git = createGitRunner();
    const source = join(root, "source");
    const bundle = join(root, "fixture.bundle");
    const fixturePath = join(source, OCR_SELF_TEST_FIXTURE.path);
    await mkdir(dirname(fixturePath), { recursive: true });
    const localEnv = buildGitEnvironment({ root, inherited: env });
    const gitSource = async (...args: string[]) =>
      (await git(args, { cwd: source, env: localEnv, signal, maxOutputBytes: MAX_GIT_OUTPUT_BYTES })).toString("utf8");
    const commit = async (contents: string, message: string) => {
      await writeFile(fixturePath, contents, { encoding: "utf8" });
      await gitSource("add", "--", OCR_SELF_TEST_FIXTURE.path);
      await gitSource("-c", "user.name=OCR Self-Test", "-c", "user.email=ocr-self-test@example.invalid", "commit", "--quiet", "-m", message);
      return (await gitSource("rev-parse", "HEAD")).trim();
    };

    await gitSource("init", "--quiet", "--object-format=sha1", `--initial-branch=${SOURCE_BRANCH}`);
    const baseSha = await commit(BASE, "Add order tax calculation");
    const headSha = await commit(HEAD, CHANGE_MESSAGE);
    const diff = await gitSource("diff", "--no-color", "--no-ext-diff", "--no-textconv", baseSha, headSha, "--", OCR_SELF_TEST_FIXTURE.path);
    await gitSource("bundle", "create", bundle, "HEAD");

    const gitRunner: GitRunner = (args, options) => {
      if (args[0] !== "fetch") return git(args, options);
      if (args.at(-3) !== "--" || args.at(-2) !== REPOSITORY || args.at(-1) !== headSha) {
        throw new Error("OCR 自检收到意外的仓库或提交引用");
      }
      // 保留评审运行器后续的 Git SHA 校验。这里的本地进程没有任何认证头。
      return git(["bundle", "unbundle", bundle], { ...options, env: localEnv });
    };
    const cli = ocrRunner ?? createGitRunner({ executable: env.OCR_EXECUTABLE?.trim() || "ocr" });
    let rawCommentsFormat: OcrSelfTestResult["rawCommentsFormat"];
    const reviewer = createOcrReviewer({ env, gitRunner, ocrRunner: async (args, options) => {
      try {
        return await cli(args, options);
      } finally {
        const outputIndex = args.indexOf("--output");
        if (!options.signal?.aborted && outputIndex >= 0 && args[outputIndex + 1]) {
          rawCommentsFormat = await readRawCommentsFormat(args[outputIndex + 1]).catch(() => undefined);
        }
      }
    } });
    const result = await reviewer.review({
      snapshot: {
        changes: [{ oldPath: OCR_SELF_TEST_FIXTURE.path, newPath: OCR_SELF_TEST_FIXTURE.path, diff }],
        commits: [{ id: headSha, message: CHANGE_MESSAGE }],
        refs: { baseSha, headSha, startSha: baseSha },
        sourceProjectId: 1,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: "main",
        repositoryUrl: REPOSITORY,
        gitlabUrl: INSTANCE,
      },
      token: "self-test-local-only",
      signal,
      llmTarget,
    });
    const credentials = [llmTarget?.provider.apiKey?.trim(), env.OCR_LLM_TOKEN?.trim()];
    const findings = result.findings.map((finding) => ({
      ...finding,
      body: redactCompletionText(finding.body, credentials),
      ...(finding.suggestionCode !== undefined && { suggestionCode: redactCompletionText(finding.suggestionCode, credentials) }),
    }));
    return { ...result, findings, fixture: { ...OCR_SELF_TEST_FIXTURE, baseSha, headSha }, ...(rawCommentsFormat && { rawCommentsFormat }) };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** 只保留合成报告中 comments 的原始表示。OCR 运行器仍自行验证同一份报告。 */
async function readRawCommentsFormat(path: string): Promise<OcrSelfTestResult["rawCommentsFormat"]> {
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_REPORT_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(stats.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stats.size) return undefined;
    const report: unknown = JSON.parse(buffer.toString("utf8"));
    if (!report || typeof report !== "object" || !("comments" in report)) return undefined;
    if (report.comments === null) return "null";
    return Array.isArray(report.comments) ? "array" : undefined;
  } finally {
    await file.close();
  }
}

/**
 * 评审记录查询与统计路由（只读）。
 *
 * 不提供任何写接口：记录只能由评审管线追加，管理端不得篡改历史。
 */
import { Router } from "express";
import type { ReviewRecordRepository } from "../../../domain/review-record.ts";

/** 单页最大条数：防止一次拉全表拖垮服务与前端。 */
const MAX_PAGE_SIZE = 200;

/** 评审记录路由依赖。 */
export interface ReviewsRouterDeps {
  records: ReviewRecordRepository;
}

/** 读取可选正整数查询参数；未提供返回 undefined，非法返回 null（由调用方转 400）。 */
function readOptionalPositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 解析后的列表查询参数；任一非法即返回 null。 */
interface ParsedListQuery {
  page: number;
  pageSize: number;
  projectId?: number;
  from?: number;
  to?: number;
  committer?: string;
}

/**
 * 解析并校验列表查询参数。
 *
 * 逐个判空而不是把结果塞进数组后用 `some`：TypeScript 无法从数组检查里缩小
 * 各变量的类型，逐个判空才能让后续代码只面对已确定的数值。
 */
function parseListQuery(query: Record<string, unknown>): ParsedListQuery | { error: string } {
  const page = readOptionalPositiveInt(query.page);
  if (page === null) return { error: "page 必须是正整数" };
  const pageSize = readOptionalPositiveInt(query.pageSize);
  if (pageSize === null) return { error: "pageSize 必须是正整数" };
  if (pageSize !== undefined && pageSize > MAX_PAGE_SIZE) {
    // 明确报错而不是静默截断：否则前端分页显示与实际条数不符。
    return { error: `pageSize 不能超过 ${MAX_PAGE_SIZE}` };
  }
  const projectId = readOptionalPositiveInt(query.project_id);
  if (projectId === null) return { error: "project_id 必须是正整数" };
  const from = readOptionalPositiveInt(query.from);
  if (from === null) return { error: "from 必须是正整数时间戳" };
  const to = readOptionalPositiveInt(query.to);
  if (to === null) return { error: "to 必须是正整数时间戳" };
  if (from !== undefined && to !== undefined && from > to) {
    return { error: "起始时间不能晚于结束时间" };
  }
  const committer = typeof query.committer === "string" ? query.committer.trim() : "";
  return {
    page: page ?? 1,
    pageSize: pageSize ?? 20,
    projectId: projectId ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    committer: committer || undefined,
  };
}

/** 创建评审记录路由。 */
export function createReviewsRouter(deps: ReviewsRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const parsed = parseListQuery(req.query as Record<string, unknown>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = deps.records.getList(parsed);
    res.json({ items: result.items, total: result.total, page: parsed.page, pageSize: parsed.pageSize });
  });

  router.get("/stats", (req, res) => {
    const from = readOptionalPositiveInt(req.query.from);
    const to = readOptionalPositiveInt(req.query.to);
    if (from === null || to === null) {
      res.status(400).json({ error: "查询参数必须是正整数" });
      return;
    }
    res.json(deps.records.getStats({ from: from ?? undefined, to: to ?? undefined }));
  });

  return router;
}

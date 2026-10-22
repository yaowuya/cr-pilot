/**
 * 企微联系人映射路由：维护「GitLab 账号 → 企微姓名/企微 userid」。
 *
 * 权限：与其余管理页一致，登录即可访问（不额外要求 admin）——映射只影响通知
 * 里的 @ 目标，不改动账号与权限模型。
 *
 * userid 无法通过姓名可靠推导：它由企微管理后台分配，页面只做手工登记。
 * GET/PUT 响应只能返回中间掩码与是否配置，不能把明文交给页面；
 * 想自动查询需要给机器人开通通讯录权限，属于部署配置，不在本接口职责内。
 */
import { Router } from "express";
import { maskWecomUserId, type WecomContact, type WecomContactRepository } from "../../../domain/wecom-contact.ts";

/** GitLab 账号允许的字符，与 GitLab 登录名规则一致。 */
const GITLAB_USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** 企微 userid 允许的字符；排除空白、尖括号与换行。 */
const WECOM_USERID_PATTERN = /^[a-zA-Z0-9_.@-]+$/;

/** 姓名长度上限：仅做防御，正常中文姓名远小于此值。 */
const MAX_NAME_LENGTH = 64;

/** 映射路由依赖。 */
export interface WecomContactsRouterDeps {
  contacts: WecomContactRepository;
}

/** 把内部明文映射转换成页面可见形式；响应绝不包含原始 userid。 */
function publicContact(contact: WecomContact) {
  return {
    gitlabUsername: contact.gitlabUsername,
    wecomName: contact.wecomName,
    hasWecomUserId: Boolean(contact.wecomUserId),
    wecomUserIdMasked: maskWecomUserId(contact.wecomUserId),
    updatedAt: contact.updatedAt,
  };
}

/** 校验并合并编辑入参；空 userid 保留已有值，只有显式清除才删除。 */
function parseContact(
  body: Record<string, unknown>,
  existing?: WecomContact,
): { gitlabUsername: string; wecomName: string; wecomUserId: string } | { error: string } {
  const gitlabUsername = typeof body.gitlabUsername === "string" ? body.gitlabUsername.trim() : "";
  const wecomName = typeof body.wecomName === "string" ? body.wecomName.trim() : "";
  const hasInput = body.wecomUserId !== undefined;
  if (hasInput && typeof body.wecomUserId !== "string") return { error: "企微 userid 必须是字符串" };
  if (body.clearWecomUserId !== undefined && typeof body.clearWecomUserId !== "boolean") {
    return { error: "清除 userid 标记必须是布尔值" };
  }
  const typedUserId = typeof body.wecomUserId === "string" ? body.wecomUserId.trim() : "";
  if (body.clearWecomUserId === true && typedUserId) return { error: "不能同时替换和清除企微 userid" };
  if (body.clearWecomUserId === true && !existing) return { error: "只允许清除已有的企微 userid" };
  const wecomUserId = body.clearWecomUserId === true ? "" : typedUserId || existing?.wecomUserId || "";

  if (!gitlabUsername) return { error: "GitLab 账号不能为空" };
  if (!GITLAB_USERNAME_PATTERN.test(gitlabUsername)) {
    return { error: "GitLab 账号只能包含字母、数字、下划线、点或连字符" };
  }
  if (!wecomName && !wecomUserId) {
    return { error: "企微姓名与企微 userid 至少填写一项" };
  }
  if (wecomName.length > MAX_NAME_LENGTH) {
    return { error: `企微姓名不能超过 ${MAX_NAME_LENGTH} 个字符` };
  }
  if (/[\n\r<>[\]\u0000-\u001f]/.test(wecomName)) {
    return { error: "企微姓名不能包含换行、尖括号或控制字符" };
  }
  // all 是企微的全员提及标记，不能当作普通 userid 或姓名保存。
  if (wecomUserId.toLowerCase() === "all" || wecomName.toLowerCase() === "all") {
    return { error: "不能使用 all 作为企微成员标识" };
  }
  if (wecomUserId && !WECOM_USERID_PATTERN.test(wecomUserId)) {
    return { error: "企微 userid 只能包含字母、数字、下划线、点、连字符或 @" };
  }
  return { gitlabUsername, wecomName, wecomUserId };
}

/** 创建企微联系人映射路由。 */
export function createWecomContactsRouter(deps: WecomContactsRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(deps.contacts.list().map(publicContact));
  });

  // 单条幂等保存：页面「新增」与「编辑」走同一入口，谁也不用猜测是否已存在。
  router.put("/", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.gitlabUsername === "string" ? body.gitlabUsername.trim() : "";
    const existing = GITLAB_USERNAME_PATTERN.test(username) ? deps.contacts.findByGitlabUsername(username) : undefined;
    const parsed = parseContact(body, existing);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      res.json(publicContact(deps.contacts.upsert(parsed)));
    } catch {
      // 数据库错误可能携带入参；响应不回显完整 userid 或底层异常文本。
      res.status(500).json({ error: "保存企微映射失败" });
    }
  });

  router.delete("/:gitlabUsername", (req, res) => {
    const gitlabUsername = String(req.params.gitlabUsername ?? "").trim();
    if (!gitlabUsername) {
      res.status(400).json({ error: "GitLab 账号不能为空" });
      return;
    }
    if (!deps.contacts.remove(gitlabUsername)) {
      res.status(404).json({ error: "映射不存在" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

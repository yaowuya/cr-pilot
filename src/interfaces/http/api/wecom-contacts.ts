/**
 * 企微联系人映射路由：维护「GitLab 账号 → 企微姓名/企微 userid」。
 *
 * 权限：与其余管理页一致，登录即可访问（不额外要求 admin）——映射只影响通知
 * 里的 @ 目标，不改动账号与权限模型。
 *
 * userid 无法通过姓名可靠推导：它由企微管理后台分配，页面只做手工登记。
 * 想自动查询需要给机器人开通通讯录权限，属于部署配置，不在本接口职责内。
 */
import { Router } from "express";
import type { WecomContactRepository } from "../../../domain/wecom-contact.ts";

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

/** 从请求体读出并校验一条映射。 */
function parseContact(body: Record<string, unknown>): { gitlabUsername: string; wecomName: string; wecomUserId: string } | { error: string } {
  const gitlabUsername = typeof body.gitlabUsername === "string" ? body.gitlabUsername.trim() : "";
  const wecomName = typeof body.wecomName === "string" ? body.wecomName.trim() : "";
  const wecomUserId = typeof body.wecomUserId === "string" ? body.wecomUserId.trim() : "";

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
    res.json(deps.contacts.list());
  });

  // 单条幂等保存：页面「新增」与「编辑」走同一入口，谁也不用猜测是否已存在。
  router.put("/", (req, res) => {
    const parsed = parseContact((req.body ?? {}) as Record<string, unknown>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      res.json(deps.contacts.upsert(parsed));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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

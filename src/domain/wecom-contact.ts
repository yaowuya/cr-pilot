/**
 * 企微联系人映射的领域模型与持久化端口。
 *
 * 为什么需要这张映射：GitLab 账号与企微成员是两套身份，账号名（如 `samxiao`）
 * 通常不是企微 userid，直接拼 `<@账号>` 会 @ 错人或不生效；而企微姓名（如「王秦」）
 * 又与 GitLab 显示名可能存在差异。因此把「GitLab 账号 → 企微姓名/企微 userid」
 * 显式登记，通知才能真正提醒到提交人。
 *
 * 提及优先级（见 `buildWecomMessage`）：已登记的 userid > 已登记的企微姓名
 * （纯文本）> GitLab 作者显示名（纯文本）。只有 userid 能触发企微成员提醒，
 * 纯文本 `@姓名` 仅用于展示，不会推送通知。
 */

/** 一条 GitLab 账号到企微成员的映射。 */
export interface WecomContact {
  /** GitLab 账号（登录名），唯一键。 */
  gitlabUsername: string;
  /** 企微姓名（中文名），用于无法真实提及时展示。 */
  wecomName: string;
  /** 企微 userid；为空时只能展示姓名，无法触发真实提醒。 */
  wecomUserId: string;
  /** Unix 毫秒。 */
  updatedAt: number;
}

/** 企微联系人映射端口。实现方为 infrastructure/sqlite。 */
export interface WecomContactRepository {
  list(): WecomContact[];
  /** 按 GitLab 账号查询；账号大小写不敏感，找不到返回 undefined。 */
  findByGitlabUsername(gitlabUsername: string): WecomContact | undefined;
  /** 按 GitLab 账号幂等写入（存在则覆盖企微姓名与 userid）。 */
  upsert(item: { gitlabUsername: string; wecomName: string; wecomUserId: string }): WecomContact;
  /** 删除映射；不存在时返回 false。 */
  remove(gitlabUsername: string): boolean;
}

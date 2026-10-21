/**
 * 企微联系人映射仓储：基于 `node:sqlite` 的同步实现。
 *
 * 账号用 `COLLATE NOCASE` 做主键：GitLab 账号本身大小写不敏感，若允许
 * `SamXiao` 与 `samxiao` 并存，同一个人会被登记两次，通知时取到哪条取决于插入顺序。
 */
import type { DatabaseSync } from "node:sqlite";
import type { WecomContact, WecomContactRepository } from "../../domain/wecom-contact.ts";

/** 表行形状（数据库列名）。 */
interface WecomContactRow {
  gitlab_username: string;
  wecom_name: string;
  wecom_userid: string;
  updated_at: number;
}

/** 数据库行转领域对象。 */
function toContact(row: WecomContactRow): WecomContact {
  return {
    gitlabUsername: row.gitlab_username,
    wecomName: row.wecom_name,
    wecomUserId: row.wecom_userid,
    updatedAt: row.updated_at,
  };
}

/** 创建企微联系人映射仓储。 */
export function createWecomContactRepository(db: DatabaseSync): WecomContactRepository {
  /** 按账号读一行；查询与写回共用，避免两处写出不一致的 SQL。 */
  const findByGitlabUsername = (gitlabUsername: string): WecomContact | undefined => {
    // COLLATE NOCASE 只在比较时生效，这里显式指定以覆盖旧库可能出现的差异。
    const row = db
      .prepare("SELECT gitlab_username, wecom_name, wecom_userid, updated_at FROM wecom_contacts WHERE gitlab_username = ? COLLATE NOCASE")
      .get(gitlabUsername) as unknown as WecomContactRow | undefined;
    return row ? toContact(row) : undefined;
  };

  return {
    list() {
      const rows = db
        .prepare("SELECT gitlab_username, wecom_name, wecom_userid, updated_at FROM wecom_contacts ORDER BY gitlab_username ASC")
        .all() as unknown as WecomContactRow[];
      return rows.map(toContact);
    },

    findByGitlabUsername,

    upsert(item) {
      const now = Date.now();
      // 冲突时保留原有账号写法：用户可能习惯 `SamXiao`，没必要被下一次保存改成小写。
      db.prepare(
        `
        INSERT INTO wecom_contacts (gitlab_username, wecom_name, wecom_userid, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(gitlab_username) DO UPDATE SET
          wecom_name = excluded.wecom_name,
          wecom_userid = excluded.wecom_userid,
          updated_at = excluded.updated_at
      `,
      ).run(item.gitlabUsername, item.wecomName, item.wecomUserId, now);
      // 重新读回：以实际落库的账号写法为准，避免调用方拿到输入值却与库里不一致。
      const saved = findByGitlabUsername(item.gitlabUsername);
      if (!saved) throw new Error("企微联系人写入后未能读回");
      return saved;
    },

    remove(gitlabUsername) {
      const result = db.prepare("DELETE FROM wecom_contacts WHERE gitlab_username = ? COLLATE NOCASE").run(gitlabUsername);
      return Number(result.changes) > 0;
    },
  };
}

/**
 * 管理员账号仓储：基于 `node:sqlite` 的同步实现。
 *
 * 密码哈希委托 shared/crypto，本模块只负责存取与唯一约束的错误转换。
 */
import type { DatabaseSync } from "node:sqlite";
import { scryptSync } from "node:crypto";
import type { AdminRepository, AdminUser } from "../../domain/admin.ts";
import { hashPassword, verifyPassword } from "../../shared/crypto.ts";

/** 与 shared/crypto 一致的 scrypt 输出长度，用于「账号不存在」时的等成本校验。 */
const KEY_LENGTH = 16;

interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

/** 行转对外视图：不暴露 password_hash。 */
function toUser(row: AdminRow): AdminUser {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

/** 判断是否为用户名唯一约束冲突。 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: admins\.username/i.test(message);
}

/**
 * 创建管理员仓储。
 *
 * `deploymentSalt` 由环境变量提供、不写入数据库：它参与盐派生，使数据库被单独
 * 取走时哈希无法直接用已知字典比对。
 */
export function createAdminRepository(db: DatabaseSync, deploymentSalt: string): AdminRepository {
  return {
    create(username, password) {
      const trimmed = username.trim();
      const now = Date.now();
      try {
        const result = db
          .prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)")
          .run(trimmed, hashPassword(password, trimmed, deploymentSalt), now);
        return { id: Number(result.lastInsertRowid), username: trimmed, createdAt: now };
      } catch (error) {
        if (isUniqueViolation(error)) {
          // 转换为带业务语义的消息：仓储不引入 HTTP 状态码，由路由层判定 409。
          throw new Error(`管理员 ${trimmed} 已存在`);
        }
        throw error;
      }
    },

    list() {
      const rows = db.prepare("SELECT * FROM admins ORDER BY created_at ASC, id ASC").all() as unknown as AdminRow[];
      return rows.map(toUser);
    },

    delete(id) {
      db.prepare("DELETE FROM admins WHERE id = ?").run(id);
    },

    findByUsername(username) {
      const row = db.prepare("SELECT * FROM admins WHERE username = ?").get(username.trim()) as unknown as AdminRow | undefined;
      return row ? toUser(row) : undefined;
    },

    ensureInitialAdmin(username, password) {
      // 只在表为空时创建：重复启动或用户已自行改号都不应被覆盖。
      const row = db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
      if (row.n > 0) return;
      this.create(username, password);
    },

    count() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
      return row.n;
    },

    authenticate(username, password) {
      const row = db.prepare("SELECT * FROM admins WHERE username = ?").get(username.trim()) as unknown as AdminRow | undefined;
      if (!row) {
        // 账号不存在时也跑一次固定成本的 scrypt：否则「不存在账号」比「密码错误」
        // 快约 6 万倍，攻击者能凭单次请求的耗时枚举有效用户名——与登录接口
        // 「不区分用户不存在与密码错误」的承诺相悖。校验结果必然失败，直接丢弃。
        scryptSync("dummy-password", "dummy-salt", KEY_LENGTH);
        return undefined;
      }
      return verifyPassword(password, row.password_hash) ? toUser(row) : undefined;
    },
  };
}

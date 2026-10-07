/**
 * 管理员账号的领域模型与持久化端口。
 *
 * 该端口是账号 CRUD 的唯一入口，由 infrastructure/sqlite 实现。
 * 密码哈希与令牌生成属于 shared/crypto 纯函数，端口只负责存取。
 */

/** 管理员账号的对外视图：刻意不含密码哈希，避免列表接口泄漏。 */
export interface AdminUser {
  id: number;
  username: string;
  /** Unix 毫秒。 */
  createdAt: number;
}

/** 管理员仓储端口。实现方为 infrastructure/sqlite。 */
export interface AdminRepository {
  /** 创建账号；用户名重复时抛错，错误消息含「已存在」供路由转 409。 */
  create(username: string, password: string): AdminUser;
  list(): AdminUser[];
  delete(id: number): void;
  findByUsername(username: string): AdminUser | undefined;
  /** 仅在表为空时创建首个账号（D-011 的引导语义）；重复调用无副作用。 */
  ensureInitialAdmin(username: string, password: string): void;
  count(): number;
}

/**
 * 管理员账号的领域模型与持久化端口。
 *
 * 该端口是账号 CRUD 的唯一入口，由 infrastructure/sqlite 实现。
 * 密码哈希与令牌生成属于 shared/crypto 纯函数，端口只负责存取。
 *
 * 角色（D-024）：不引入 role 字段，管理员身份由部署配置 `ADMIN_USERNAME`
 * 决定——该账号即启动引导创建的那个，其余账号都是普通账号且无法在页面上提升。
 * 这样数据模型保持最简，代价是改 `ADMIN_USERNAME` 会让原管理员失去权限。
 */

/** 管理员账号的对外视图：刻意不含密码哈希，避免列表接口泄漏。 */
export interface AdminUser {
  id: number;
  username: string;
  /**
   * 是否具备管理员权限。
   *
   * 由仓储按部署配置 `ADMIN_USERNAME` 计算，不存数据库：角色是部署属性
   * 而非账号属性，存库反而会与配置产生两个事实源。
   */
  isAdmin: boolean;
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
  /** 校验用户名与密码；不匹配返回 undefined。供认证路由使用。 */
  authenticate(username: string, password: string): AdminUser | undefined;
  /**
   * 部署配置里的管理员用户名（可能为空 = 未配置）。
   *
   * 供启动日志与权限中间件读取：空值时无人具备管理员权限，
   * 需要告警提示运维补配置。
   */
  readonly adminUsername: string;
}

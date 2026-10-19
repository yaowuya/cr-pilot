/**
 * 运行期配置覆盖的领域模型与持久化端口。
 *
 * 语义（P-005 / D-014）：数据库中的覆盖值在启动时应用到环境变量，
 * 使数据库优先于进程原有环境变量；页面保存时同步写入两者，因此大部分
 * 配置项下一次读取即生效，仅启动期绑定项需要重启。
 */

/** 一条配置覆盖值。`value` 为空串表示清空覆盖、回落到环境变量。 */
export interface ConfigOverride {
  key: string;
  value: string;
  /** Unix 毫秒。 */
  updatedAt: number;
}

/** 配置覆盖端口。实现方为 infrastructure/sqlite。 */
export interface ConfigRepository {
  list(): ConfigOverride[];
  setAll(items: { key: string; value: string }[]): void;
  clear(keys: string[]): void;
}

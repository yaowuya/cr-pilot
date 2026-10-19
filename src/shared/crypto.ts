/**
 * 凭证相关纯函数：密码哈希与无状态会话令牌。
 *
 * 全部基于 Node 内置 `node:crypto`，不引入外部依赖。本模块零 IO，
 * 不触碰数据库与 HTTP；存储与校验编排由 infrastructure/interfaces 完成。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt 输出长度（字节）。16 字节足以抵抗暴力破解，且校验开销可忽略。 */
const KEY_LENGTH = 16;

/** 哈希串前缀，用于格式判别与将来算法升级。 */
const HASH_PREFIX = "scrypt";

/**
 * 派生盐的 hex 表示：SHA256(用户名 + 部署固定盐)。
 *
 * 盐含用户名，使不同用户即使密码相同也得到不同哈希；同时盐不必逐账号存字段，
 * 校验时从哈希串里取回即可（D-010）。
 */
function deriveSaltHex(username: string, deploymentSalt: string): string {
  return createHash("sha256").update(`${username}:${deploymentSalt}`).digest("hex");
}

/**
 * 计算密码哈希（纯函数）。
 *
 * `username` 与 `deploymentSalt` 是两个不同值，缺一不可：用户名让相同密码在不同
 * 账号下产生不同哈希，部署盐由环境变量提供、不入库，使哈希在库被拖走时仍不可
 * 直接比对。返回格式 `scrypt$<saltHex>$<hashHex>`，盐内嵌于哈希串。
 *
 * 用 `scryptSync` 而非异步版：账号写入是低频管理操作，同步实现更简单，
 * 且避免在 Express 处理器中引入 Promise 包装。
 */
export function hashPassword(plain: string, username: string, deploymentSalt: string): string {
  const saltHex = deriveSaltHex(username, deploymentSalt);
  const hash = scryptSync(plain, saltHex, KEY_LENGTH).toString("hex");
  return `${HASH_PREFIX}$${saltHex}$${hash}`;
}

/**
 * 校验密码是否匹配已存储的哈希。
 *
 * 盐从 `stored` 内嵌的 saltHex 取回，因此不需要调用方传入用户名或部署盐——
 * 这也意味着**轮换部署盐不会让已存储的密码失效**（旧哈希仍可校验通过），
 * 这是有意行为：部署盐轮换不应把全部管理员锁在门外。
 *
 * 用 `timingSafeEqual` 做定长比较，避免通过响应耗时推断哈希前缀。
 * 格式非法（非本模块产出）直接返回 false，不抛错：调用方按「凭证错误」处理。
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(plain, parts[1], expected.length);
  return timingSafeEqual(actual, expected);
}

/** 生成 32 字节随机令牌（hex）。用于不可预测的场景。 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 由用户名与部署盐派生确定性令牌（D-009 的无状态会话）。
 *
 * 不建会话表意味着令牌必须能从库中现有数据重算，否则每次请求都要跑一次
 * scrypt 密码校验。派生值让校验退化为「查账号 + 一次 scrypt 比较」。
 *
 * 已知代价（design 风险表已登记）：无法主动吊销，管理员改密码后旧令牌仍有效
 * 直到进程重启或部署盐变更。
 */
export function deriveToken(username: string, deploymentSalt: string): string {
  return scryptSync(username, deriveSaltHex(username, deploymentSalt), KEY_LENGTH).toString("hex");
}

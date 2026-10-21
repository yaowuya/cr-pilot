/**
 * 敏感字段的对称加密（AES-256-GCM）。
 *
 * 使用场景：采纳追踪是脱离请求的定时任务，拿不到 webhook 请求头里的 GitLab
 * 访问令牌，只能把令牌随建议一起持久化。明文存库会把「一份业务数据泄露」升级为
 * 「GitLab 写权限泄露」，因此必须加密。
 *
 * 密钥由部署盐 `AUTH_SALT` 派生：该值本就不入库（见 `src/shared/config.ts`），
 * 库被单独取走时无法解密。代价是轮换 `AUTH_SALT` 会让历史密文不可用——这些
 * 令牌是短期任务级凭据，追踪记不上的部分会如实落入「不可统计」，可接受。
 *
 * 用 GCM 而非 CBC：GCM 自带完整性校验，密文被篡改会在解密时直接失败，
 * 而不是解出一段错误明文继续参与请求。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 算法固定为 AES-256-GCM（密钥 32 字节、IV 12 字节、认证标签 16 字节）。 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
/** 密文格式版本前缀，未来换算法时可判别旧数据。 */
const VERSION = "v1";

/** 从任意长度的部署盐派生出 32 字节密钥。 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * 加密明文；空串原样返回空串。
 *
 * 空串表示「没有值」，不需要加密，也让调用方免于区分「未设置」与「加密结果为空」。
 */
export function sealSecret(plain: string, secret: string): string {
  if (!plain) return "";
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 用 base64url 而不是 hex：密文更短，且作为单列文本存储不需要转义。
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

/**
 * 解密 `sealSecret` 的产物。
 *
 * 任何异常（格式不符、密钥不匹配、密文被改）都返回空串而不是抛出：追踪是后台任务，
 * 一条历史记录解不开不应该让整轮追踪中断；调用方拿到空令牌后按「无凭据」降级。
 */
export function openSecret(sealed: string, secret: string): string {
  if (!sealed) return "";
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return "";
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

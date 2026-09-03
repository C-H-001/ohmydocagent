// backend/src/modules/auth/auth.constants.ts
// 刷新令牌 Redis 存储常量：
// 键格式 rt:{userId}:{jti}，值 '1'（仅作存在性标记），TTL 与 refreshToken 有效期一致（7 天）。
// 撤销/登出/旋转时按 jti 删除键即可使对应 refreshToken 立即失效。
export const REFRESH_TOKEN_KEY_PREFIX = 'rt:';

/** 刷新令牌 Redis TTL（秒）：与 JWT refreshExpiresIn '7d' 保持一致 */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

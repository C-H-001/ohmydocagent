// CryptoService 单元测试（Task 2.3）：AES-256-GCM API Key 加解密。
// 断言维度：
// - 加密→解密还原（同密钥必还原，中文/emoji 等任意 UTF-8 内容）
// - 同明文两次加密密文不同（IV 随机——GCM 安全要求 IV 唯一，见 crypto.service.ts 注释）
// - 密文格式 `${iv}:${authTag}:${data}`（base64 三段冒号分隔，DB 落库格式）
// - 密钥派生：sha256(ENCRYPTION_KEY) 定长 32 字节（AES-256 密钥长度），
//   不同 ENCRYPTION_KEY → 密文不可解（错误密钥解密抛异常）
// - 非法密文（段数不对/非 base64）→ 抛错（fail-fast，不静默返回空串）；
//   质量审查整改：解密失败统一包装为 BadRequestException 友好中文提示
//   （不泄露底层错误细节；提示重新保存模型配置 = 用当前密钥重加密自愈）
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { CryptoService } from '../src/modules/model/crypto.service.js';

/** 构造被测实例：只喂 encryptionKey（ConfigService 形态的 getOrThrow 桩） */
function makeCrypto(key = 'test-encryption-key-0123456789abcdef') {
  return new CryptoService({
    getOrThrow: (name: string) => {
      if (name === 'encryptionKey') return key;
      throw new Error(`未预期的配置键: ${name}`);
    },
  } as unknown as ConfigService);
}

describe('CryptoService（AES-256-GCM API Key 加密）', () => {
  it('encrypt→decrypt 还原原文（同密钥必还原）', () => {
    const c = makeCrypto();
    const payload = c.encrypt('sk-plaintext-secret-123');
    expect(payload).not.toBe('sk-plaintext-secret-123');
    expect(c.decrypt(payload)).toBe('sk-plaintext-secret-123');
  });

  it('同明文两次加密密文不同（IV 随机）', () => {
    const c = makeCrypto();
    expect(c.encrypt('same-secret')).not.toBe(c.encrypt('same-secret'));
  });

  it('密文格式为 iv:tag:data 三段 base64（DB 落库格式）', () => {
    const c = makeCrypto();
    const payload = c.encrypt('secret');
    const parts = payload.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      // base64 合法：解码后重编码（去 padding）应还原自身
      expect(
        Buffer.from(part, 'base64').toString('base64').replace(/=+$/, ''),
      ).toBe(part.replace(/=+$/, ''));
    }
  });

  it('中文/emoji 等任意 UTF-8 内容加解密正确', () => {
    const c = makeCrypto();
    const payload = c.encrypt('中文密钥内容：机密信息 🎯');
    expect(c.decrypt(payload)).toBe('中文密钥内容：机密信息 🎯');
  });

  it('不同加密密钥解密失败（密钥派生：sha256(ENCRYPTION_KEY)）', () => {
    const c1 = makeCrypto('key-aaaa-key-aaaa-key-aaaa');
    const c2 = makeCrypto('key-bbbb-key-bbbb-key-bbbb');
    const payload = c1.encrypt('secret');
    expect(() => c2.decrypt(payload)).toThrow();
  });

  it('非法密文格式（段数不对/非 base64）→ 抛错', () => {
    const c = makeCrypto();
    expect(() => c.decrypt('not-a-valid-format')).toThrow();
    expect(() => c.decrypt('a:b')).toThrow();
    expect(() => c.decrypt('')).toThrow();
  });

  it('解密失败 → BadRequestException 友好中文提示（不泄露底层错误）', () => {
    const c = makeCrypto();
    // 错误密钥解不出：认证失败（GCM authTag 校验）
    const c2 = makeCrypto('different-key-different-key-diff');
    const payload = c.encrypt('secret');
    expect(() => c2.decrypt(payload)).toThrow(BadRequestException);
    expect(() => c2.decrypt(payload)).toThrow(/解密失败，请重新保存模型配置/);
    // 格式非法同样包装（不泄露「iv:tag:data 三段」等底层细节）
    expect(() => c.decrypt('garbage')).toThrow(BadRequestException);
  });
});

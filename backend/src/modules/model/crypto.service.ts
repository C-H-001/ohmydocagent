// backend/src/modules/model/crypto.service.ts
// API Key 加密服务（Task 2.3）：AES-256-GCM 对称加密，用于 models.apiKeyEncrypted 列。
//
// 设计决策：
// - 算法 AES-256-GCM：认证加密（密文 + authTag），密钥长度 256 位；GCM 是
//   现代 TLS 首选 AEAD——比 CBC 多了完整性校验（密文被篡改/密钥错误时
//   decipher.final() 抛错，fail-fast 而不是解出乱码）。
// - 密钥派生：sha256(ENCRYPTION_KEY) 取 32 字节定长密钥——ENCRYPTION_KEY 是
//   任意长度的口令（.env 配置），AES-256 需要恰好 32 字节，sha256 派生态是
//   标准做法（非 KDF，但密钥本身由运维保管、熵足够，无需 PBKDF2 拉伸；
//   注释说明：若 ENCRYPTION_KEY 改为低熵口令，应升级 PBKDF2/scrypt）。
// - IV 随机：每次 encrypt 用 crypto.randomBytes(12)（GCM 标准 96 位 IV）；
//   IV 随机性要求「同密钥下不重复」，randomBytes 满足（安全要求，见 spec）。
// - 密文格式 `${iv}:${authTag}:${data}`（三段 base64，冒号分隔）：自描述
//   结构，无需额外元数据列；base64 保证 DB 文本列安全存储（无控制字符）。
// - 不落明文：DB 层只存密文（e2e 断言「DB 查不到明文」）；响应层再剔除
//   密文列（见 model.service.ts sanitize），双层防护。
//
// 质量审查整改（Task 2.3）：
// - 密钥轮换 TODO：ENCRYPTION_KEY 变更后旧密文全部不可解（GCM 认证失败）——
//   轮换需在运维窗口内「新密钥重新加密所有 apiKeyEncrypted」批量任务（解密 →
//   新密钥加密 → 回写），P1 未实现，见 deploy/ 运维文档 TODO；
// - 解密失败友好化：解密异常包装为 BadRequestException「API Key 解密失败，
//   请重新保存模型配置」——不泄露底层错误（可能含密钥派生信息/堆栈），
//   且提示用户「重新保存」即用新密钥重加密（自愈路径）。
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/** 密文段分隔符（iv:tag:data） */
const SEPARATOR = ':';

@Injectable()
export class CryptoService {
  /** AES-256-GCM 密钥（sha256(ENCRYPTION_KEY) 派生的 32 字节） */
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    // getOrThrow：ENCRYPTION_KEY 缺失即启动失败（fail-fast，配置层兜底见
    // configuration.ts 生产检查 + config.validation.ts 默认值）
    this.key = createHash('sha256')
      .update(config.getOrThrow<string>('encryptionKey'))
      .digest();
  }

  /** 加密：返回 `${iv}:${authTag}:${data}`（base64 三段） */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      data.toString('base64'),
    ].join(SEPARATOR);
  }

  /** 解密：解析 iv:tag:data → 还原明文；格式非法/认证失败（密钥错误或密文
   * 被篡改）→ 抛友好中文错误（不泄露底层细节；提示重新保存模型配置 = 用
   * 当前密钥重加密，自愈路径）。密钥轮换 TODO 见文件头注释 */
  decrypt(payload: string): string {
    try {
      const parts = payload.split(SEPARATOR);
      if (parts.length !== 3) {
        throw new Error('API Key 密文格式非法（应为 iv:tag:data 三段）');
      }
      const [ivB64, tagB64, dataB64] = parts;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      // 不泄露底层错误（密钥派生信息/堆栈）；统一友好提示 + 重新保存自愈
      throw new BadRequestException('API Key 解密失败，请重新保存模型配置');
    }
  }
}

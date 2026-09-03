// 平台 API Key 服务（Task 4.5）：创建（明文一次）/列表（脱敏）/吊销 + 校验。
// 安全设计：
// - 明文格式 dm_ + 32hex（16 字节 CSPRNG，256 bit 熵）；库存 sha256 哈希——
//   泄露 DB 也无法还原明文（无加密密钥可解，哈希单向）；
// - 明文只在 create 响应返回一次（后续任何接口/日志都不再出现）；
// - 校验：sha256(请求 key) 查库比对（恒定时间由 sha256 摘要比对天然近似——
//   hex 字符串比对，非逐字节时序泄露；不引入 bcrypt——API key 是高频校验
//   路径，bcrypt 成本过高，且 256 bit 随机熵无需慢哈希防护暴力枚举）；
// - enabled=false（暂停）校验拒绝；吊销 = 硬删（删除后校验查不到即失败）。
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { PlatformApiKey } from './platform-api-key.entity.js';

/** 明文 key 前缀（版本化：未来格式演进按前缀区分） */
export const API_KEY_PREFIX = 'dm_';

/** 创建响应：明文 key 仅此一次（hasApiKey=true 恒成立——key 一定存在，语义为「已生成」） */
export interface CreateApiKeyResult {
  id: string;
  name: string;
  apiKey: string;
  hasApiKey: true;
  scopes: string[];
  enabled: boolean;
  createdAt: Date;
}

/** 列表项（脱敏：绝不返回 keyHash/明文） */
export interface ApiKeyListItem {
  id: string;
  name: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  hasApiKey: true;
}

/** 校验成功注入的身份（ApiKeyGuard 挂到 req.user，role=Admin——平台 key 等价管理员凭证） */
export interface ApiKeyIdentity {
  id: string;
  name: string;
  type: 'api-key';
  role: 'member';
}

/** 对明文 key 做 sha256 十六进制摘要（库存与校验共用，防两处实现漂移） */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

@Injectable()
export class PlatformApiKeyService {
  constructor(
    @InjectRepository(PlatformApiKey)
    private readonly keyRepository: Repository<PlatformApiKey>,
    // Task 4.4 审计（全局模块直接注入）
    private readonly audit: AuditService,
  ) {}

  /**
   * 创建：生成 dm_ + 32hex 明文（一次返回），库存 sha256。
   * name 唯一（实体层 unique 索引兜底并发重复 → 23505 转 409）。
   */
  async create(
    name: string,
    scopes: string[] = [],
    actorId: string,
  ): Promise<CreateApiKeyResult> {
    const apiKey = `${API_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
    try {
      const entity = this.keyRepository.create({
        name,
        keyHash: hashApiKey(apiKey),
        scopes,
        enabled: true,
      });
      const saved = await this.keyRepository.save(entity);
      // 审计：创建平台 API Key（不记明文/哈希）
      await this.audit.log('api_key.create', actorId, 'api_key', saved.id, {
        name,
        scopes,
      });
      return {
        id: saved.id,
        name: saved.name,
        apiKey,
        hasApiKey: true,
        scopes: saved.scopes,
        enabled: saved.enabled,
        createdAt: saved.createdAt,
      };
    } catch (err) {
      // 并发重名兜底：撞 name 唯一索引（23505）→ 409
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('该名称的 API Key 已存在');
      }
      throw err;
    }
  }

  /** 列表：全部脱敏（无 keyHash/明文），按创建时间倒序 */
  async list(): Promise<ApiKeyListItem[]> {
    const keys = await this.keyRepository.find({
      order: { createdAt: 'DESC' },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      scopes: k.scopes,
      enabled: k.enabled,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      hasApiKey: true,
    }));
  }

  /** 吊销（硬删）：不存在 → 404（非 UUID 格式 id 撞 PG 22P02 同样视为不存在） */
  async revoke(id: string, actorId: string): Promise<void> {
    let key: PlatformApiKey | null;
    try {
      key = await this.keyRepository.findOne({ where: { id } });
    } catch (err) {
      // 非 UUID 格式 id 撞 PG 22P02：与「不存在」同样视为无此资源 → 404
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('API Key 不存在');
      }
      throw err;
    }
    if (!key) {
      throw new NotFoundException('API Key 不存在');
    }
    await this.keyRepository.delete({ id });
    // 审计：吊销平台 API Key
    await this.audit.log('api_key.delete', actorId, 'api_key', id, {
      name: key.name,
    });
  }

  /**
   * 校验明文 key：sha256 查库 + enabled 判定；成功更新 lastUsedAt
   * （fire-and-forget，失败不影响校验结果）。失败返回 null（guard 转 401）。
   */
  async validate(apiKey: string): Promise<ApiKeyIdentity | null> {
    const key = await this.keyRepository.findOne({
      where: { keyHash: hashApiKey(apiKey) },
    });
    if (!key || !key.enabled) {
      return null;
    }
    // lastUsedAt 更新非关键路径：失败仅忽略（审计排查友好性，不做重试）
    this.keyRepository
      .update({ id: key.id }, { lastUsedAt: new Date() })
      .catch(() => undefined);
    return {
      id: key.id,
      name: key.name,
      type: 'api-key',
      role: 'member',
    };
  }
}

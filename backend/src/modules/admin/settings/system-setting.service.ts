// 全局设置服务（Task 4.6）：GET/PUT /admin/settings 的读写 + 按 key 的 DTO 校验。
// SETTING_DEFS 注册表集中声明全部业务配置项（类型/默认值/校验约束）——新增
// 配置项在此单点追加，服务层按注册表校验与合并默认值，避免 key 字符串散落。
// 当前 key 及语义（value 类型按 key 校验，见 update 注释）：
// - registration_enabled（boolean，默认 true）：是否开放注册
// - invite_enabled（boolean，默认 true）：是否开放邀请制注册
// - default_chat_model_id（uuid|''，默认 ''）：默认对话模型（空 = 未配置）
// - default_embedding_model_id（uuid|''，默认 ''）：默认向量模型
// - max_upload_mb（number，1~2048，默认 20）：上传大小上限（MB）
// 说明（简化决策）：本任务只做配置的存储/校验/读取，不接线业务行为（如
// registration_enabled=false 时 register 接口是否拒绝）——行为接线留给后续
// 任务按注册表消费（各业务 service 读 ConfigService 等价物或本服务）。
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from './system-setting.entity.js';

/** 设置项类型（按 key 校验 value 类型） */
export type SettingValueType = 'boolean' | 'number' | 'uuid';

/** 设置项注册表：key → 类型/默认值/校验约束（新增配置项在此追加） */
export const SETTING_DEFS = {
  registration_enabled: { type: 'boolean' as const, default: true },
  invite_enabled: { type: 'boolean' as const, default: true },
  default_chat_model_id: { type: 'uuid' as const, default: '' },
  default_embedding_model_id: { type: 'uuid' as const, default: '' },

  max_upload_mb: { type: 'number' as const, default: 20, min: 1, max: 2048 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;

/** UUID 格式校验（空串 = 未配置，跳过） */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SystemSettingService {
  constructor(
    @InjectRepository(SystemSetting)
    private readonly settingRepository: Repository<SystemSetting>,
  ) {}

  /** 读取全部配置：DB 值合并注册表默认值（未设置的 key 返回默认值） */
  async getSettings(): Promise<Record<SettingKey, unknown>> {
    const rows = await this.settingRepository.find();
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const result = {} as Record<SettingKey, unknown>;
    for (const key of Object.keys(SETTING_DEFS) as SettingKey[]) {
      result[key] = stored.has(key)
        ? stored.get(key)
        : SETTING_DEFS[key].default;
    }
    return result;
  }

  /** 读取单个 key（供业务接线消费，不存在/未设置返回默认值） */
  async getSetting(key: SettingKey): Promise<unknown> {
    const row = await this.settingRepository.findOne({ where: { key } });
    return row ? row.value : SETTING_DEFS[key].default;
  }

  /**
   * 更新配置：values 为 key→value 部分更新。逐 key 校验：
   * 未知 key → 400；类型不符 → 400；范围约束（max_upload_mb）→ 400。
   * upsert 语义：已存在更新、不存在插入（updatedBy 记录修改人）。
   */
  async updateSettings(
    values: Record<string, unknown>,
    updatedBy: string | null,
  ): Promise<Record<SettingKey, unknown>> {
    for (const [key, value] of Object.entries(values)) {
      this.assertValid(key, value);
    }
    for (const [key, value] of Object.entries(values)) {
      const existing = await this.settingRepository.findOne({
        where: { key },
      });
      if (existing) {
        existing.value = value;
        existing.updatedBy = updatedBy;
        await this.settingRepository.save(existing);
      } else {
        await this.settingRepository.save(
          this.settingRepository.create({
            key,
            value,
            updatedBy,
          }),
        );
      }
    }
    return this.getSettings();
  }

  /** 按注册表校验单个 key/value（见 SETTING_DEFS 注释） */
  private assertValid(key: string, value: unknown): void {
    const def = SETTING_DEFS[key as SettingKey];
    if (!def) {
      throw new BadRequestException(`未知设置项: ${key}`);
    }
    if (def.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new BadRequestException(`设置项 ${key} 必须是布尔值`);
      }
      return;
    }
    if (def.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(`设置项 ${key} 必须是数字`);
      }
      const { min, max } = def as { min?: number; max?: number };
      if (min !== undefined && value < min) {
        throw new BadRequestException(`设置项 ${key} 最小为 ${min}`);
      }
      if (max !== undefined && value > max) {
        throw new BadRequestException(`设置项 ${key} 最大为 ${max}`);
      }
      return;
    }
    // uuid 类型：空串 = 未配置；非空必须是合法 UUID
    if (def.type === 'uuid') {
      if (typeof value !== 'string') {
        throw new BadRequestException(`设置项 ${key} 必须是字符串`);
      }
      if (value !== '' && !UUID_RE.test(value)) {
        throw new BadRequestException(`设置项 ${key} 必须是合法的 UUID 或空串`);
      }
      return;
    }
    throw new BadRequestException(`设置项 ${key} 类型不受支持`);
  }
}

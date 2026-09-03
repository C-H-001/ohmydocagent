// 平台 API Key 实体（Task 4.5）：供管理员创建的平台级访问凭证（如自动化脚本/
// 外部系统调用管理接口）。
// 设计决策：
// - keyHash：sha256(key) 十六进制，DB 不存明文——完整明文（dm_ + 32hex）仅在
//   创建响应返回一次（见 platform-api-key.service.ts create 注释）；
// - scopes jsonb：预留权限域（当前默认空数组，未启用细粒度域控制，YAGNI——
//   后续需要时按域拦截，见 guard 注释）；
// - enabled：吊销即删除（revoke 硬删）；enabled 保留用于「暂停」场景
//   （guard 校验 enabled，暂停后立即失效，见 validate 注释）；
// - lastUsedAt：最近一次通过校验的时间（guard 校验成功后 fire-and-forget 更新，
//   用于审计排查哪个 key 在用）。
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('platform_api_keys')
export class PlatformApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 用途名称（如「运维脚本」）；唯一便于排查 */
  @Column({ unique: true })
  name: string;

  /** sha256(明文 key) 十六进制（DB 不存明文） */
  @Column()
  keyHash: string;

  /** 权限域（预留，当前默认空数组——未启用细粒度域控制） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  scopes: string[];

  /** 启用状态：false 时 guard 校验拒绝（暂停场景，吊销走删除） */
  @Column({ default: true })
  enabled: boolean;

  /** 最近一次校验成功时间（guard 更新，fire-and-forget） */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}

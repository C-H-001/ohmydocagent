// 全局设置实体（Task 4.6）：key-value 配置存储（value jsonb，兼容多类型）。
// 业务 key 由 SystemSettingService 的 SETTING_DEFS 注册表集中声明（新增配置项
// 单点追加）；本实体只负责存储，不承载 key 语义。updatedBy 记录最近修改人
// （无请求上下文的系统写入为 null）。
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('system_settings')
export class SystemSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 配置键（见 SystemSettingService.SETTING_DEFS 注册表） */
  @Column({ unique: true })
  key: string;

  /** 配置值（jsonb：boolean/number/string 均可，类型按 key 校验） */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  value: unknown;

  /** 最近修改人用户 id（系统写入为 null） */
  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

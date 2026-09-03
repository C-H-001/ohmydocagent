// 知识库共享实体（个人邀请）：用户需求——去掉组织维度，只有超级管理员与
// 普通用户；KB 创建者（Owner）自治，可邀请其他用户为 Admin/编辑/查看。
// 唯一索引：kbId+userId（部分唯一，兼容旧数据 userId 非空即唯一）；并发
// 重复共享由唯一索引兜底（23505 → 409）。
// 权限：view（只读——KB 详情/文档/分块/图谱/检索）/ edit（内容可写：上传/
// 编辑分块/重解析，但不可删 KB、不可管理共享）/ admin（KBAdmin：内容管理 +
// 可看共享列表，仍不可删 KB、不可管理成员——成员管理是 Owner 专属）。
// 判定语义见 KbAccessService：系统 super 与 KB 创建者全权限，其余用户按
// 个人共享的最高档（view<edit<admin）裁决，权限不足统一 404（资源隐藏）。
// kbId/userId 为普通 uuid 列（无外键，沿用既有约定；KB 删除时共享行由
// KbService.remove 清理）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 共享权限等级：view（只读）< edit（可写）< admin（KB 管理员） */
export enum SharePermission {
  View = 'view',
  Edit = 'edit',
  // KBAdmin：被 Owner 邀请的 KB 级管理员（内容管理 + 可看共享列表，
  // 不可删除 KB、不可管理成员——成员管理是 Owner 专属）。
  Admin = 'admin',
}

@Index('idx_kb_shares_kb_user', ['kbId', 'userId'], { unique: true, where: '"userId" IS NOT NULL' })
@Entity('knowledge_base_shares')
export class KnowledgeBaseShare {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 被共享的知识库 id */
  @Column({ type: 'uuid' })
  kbId: string;

  /** 获得共享权限的个人用户 id（个人邀请共享） */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({
    type: 'enum',
    enum: SharePermission,
    default: SharePermission.View,
  })
  permission: SharePermission;

  /** 共享创建人用户 id */
  @Column({ type: 'uuid' })
  createdById: string;

  @CreateDateColumn()
  createdAt: Date;
}

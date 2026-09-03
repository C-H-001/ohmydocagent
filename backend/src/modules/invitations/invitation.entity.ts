// backend/src/modules/invitations/invitation.entity.ts
// 邀请实体：一次性 token、绑定邮箱、可过期、可撤销（撤销即删除）
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Role } from '../users/user.entity.js';

/**
 * 同邮箱最多一条「未使用」邀请：PG 部分唯一索引（email WHERE used=false）收口
 * 并发创建竞态——服务层 create 的「已有待使用邀请 → 409」检查存在 TOCTOU 窗口
 * （两个请求同时通过 findOne 检查后都执行 insert），由数据库层唯一约束兜底：
 * 后落库者撞 23505，服务层统一转 409（见 InvitationsService.create）。
 * 已使用（used=true）的旧邀请不满足谓词，不阻塞重新邀请；
 * 过期的未使用残留由 create 插入前清理（见 InvitationsService.create）。
 */
@Index(['email'], { unique: true, where: 'used = false' })
@Entity('invitations')
export class Invitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 邀请绑定邮箱：register-by-invite 只能以该邮箱注册（consume 校验一致） */
  @Column()
  email: string;

  /** 受邀人注册后的角色：仅 admin（DTO 与服务层双重限制，Owner 不可经邀请产生） */
  @Column({ type: 'enum', enum: Role, default: Role.Member })
  role: Role;

  /** 一次性令牌：crypto.randomBytes(32).toString('hex')（64 字符），完整值仅创建响应返回 */
  @Column({ unique: true })
  token: string;

  /** 是否已消费（原子消费见 InvitationsService.consume，防并发双用） */
  @Column({ default: false })
  used: boolean;

  /** 过期时间：创建时按 INVITE_TTL_DAYS（默认 7 天）设置 */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** 创建人（Owner/Admin）用户 id */
  @Column({ type: 'uuid' })
  createdById: string;

  @CreateDateColumn()
  createdAt: Date;
}

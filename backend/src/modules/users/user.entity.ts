// backend/src/modules/users/user.entity.ts
// 用户实体：RBAC 仅 Owner/Admin 两种角色
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum Role {
  Super = 'super',
  Member = 'member',
}

/**
 * 唯一 Owner 不变量 DB 层兜底（并发 init 双 Owner 的最后防线）：
 * 部分唯一索引（role WHERE role='owner'）保证全库最多一条 Owner 记录。
 * 服务层 AuthService.init 的 isInitialized 存在 TOCTOU 窗口（两个并发 init
 * 同时通过检查后都执行 INSERT），由本索引收口：后落库者撞 23505，服务层统一转 409
 * （见 AuthService.init 的 23505 处理器）——与 invitations.email 部分索引同模式。
 * 注意：role 是 PG enum 类型，WHERE role='owner' 的字符串比较对 enum 直接生效
 * （已实测：PG 会隐式把 unknown 字面量转为枚举类型参与比较）。
 */
@Index('idx_users_single_owner', ['role'], {
  unique: true,
  where: "role = 'super'",
})
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  // select: false —— 默认查询不返回密码哈希，只有显式 addSelect 才取（见 UsersService.findByEmail）
  @Column({ select: false })
  passwordHash: string;

  @Column({ default: '' })
  name: string;

  @Column({ default: '' })
  avatarUrl: string;

  @Column({ type: 'enum', enum: Role, default: Role.Member })
  role: Role;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

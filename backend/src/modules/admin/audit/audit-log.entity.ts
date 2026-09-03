// 审计日志实体（Task 4.4）：管理员审计追踪（谁在什么时候做了什么）。
// 设计决策：
// - userId 可空：绝大多数接线点在既有 service 内（任务要求「加一行调用」，
//   不侵入控制器签名），无请求上下文的系统级操作（如模型创建/删除——模型是
//   系统级配置、接口不传操作人）记 null（视为系统操作）；有 actor 的调用点
//   （登录/注册/角色变更/转移/KB 共享等）记实际用户 id；
// - detail jsonb：结构化上下文（如角色变更的前后值、KB 名称、共享的组织/权限），
//   便于审计查询与回放；不含密码等敏感字段（接线点注意只记元数据）；
// - ip 预留：既有 service 无请求上下文（REQ scoped 未启用），接线调用一律不传
//   ip（空串）；后续如需 IP 审计可改控制器层透传（见 audit.service.ts 注释）；
// - 查询索引：action + createdAt 复合索引覆盖「按动作筛选 + 时间倒序」的
//   默认审计查询模式；userId 单列索引覆盖按操作者筛选。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('audit_logs')
@Index('idx_audit_logs_action_created', ['action', 'createdAt'])
@Index('idx_audit_logs_user', ['userId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 操作者用户 id；系统级操作（无请求上下文）为 null */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** 动作类型（如 auth.login / kb.create / user.role.change），见各接线点 */
  @Column()
  action: string;

  /** 资源类型（user / kb / kb_share / model / invitation / api_key） */
  @Column()
  resourceType: string;

  /** 被操作资源 id（如 KB id / 用户 id）；无具体资源时 null */
  @Column({ type: 'uuid', nullable: true })
  resourceId: string | null;

  /** 结构化上下文（前后值/名称等元数据，不含敏感字段） */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  detail: Record<string, unknown>;

  /** 来源 IP（预留；接线点暂不采集，见文件头注释） */
  @Column({ default: '' })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}

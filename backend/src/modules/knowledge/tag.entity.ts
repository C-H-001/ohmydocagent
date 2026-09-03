// 标签实体（Task 1.3）：知识库内名称唯一。
// 与文件夹不同，tags 的 (kbId, name) 两列均 NOT NULL，无 NULL 漏网问题，
// DB 层唯一索引真正生效；服务层仍先查重（409 友好错误，见 ensureTagNameUnique），
// 唯一索引兜底并发（撞唯一约束时 TypeORM 抛 23505，正常入口不会触发）。
// kbId 为普通 uuid 列（无外键），KB/标签级联删除由服务层事务承担。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('tags')
@Index('idx_tags_kb_name_unique', ['kbId', 'name'], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属知识库 id（无外键，级联删除由服务层事务承担） */
  @Column({ type: 'uuid' })
  kbId: string;

  /** 标签名称（知识库内唯一） */
  @Column()
  name: string;

  /** 十六进制色值（#RRGGBB），前端标签渲染用；缺省默认蓝 */
  @Column({ default: '#3b82f6' })
  color: string;

  @CreateDateColumn()
  createdAt: Date;
}

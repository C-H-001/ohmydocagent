// 用户级置顶（多对多关系表）：同一用户可置顶多个知识库。
// 唯一约束（userId + kbId）保证同一用户对同一 KB 最多一条置顶记录，
// togglePin 的 upsert/删除依赖此约束收口并发竞态（后落库者撞 23505）。
// 本表不建外键（P1 由服务层显式清理，见 KbService.remove 注释）；
// Task 1.2/1.5 建 knowledge/chunks 子表时统一补 onDelete CASCADE 外键。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user_kb_pins')
@Index(['userId', 'kbId'], { unique: true })
export class UserKbPin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 置顶者用户 id */
  @Column({ type: 'uuid' })
  userId: string;

  /** 被置顶的知识库 id */
  @Column({ type: 'uuid' })
  kbId: string;

  @CreateDateColumn()
  createdAt: Date;
}

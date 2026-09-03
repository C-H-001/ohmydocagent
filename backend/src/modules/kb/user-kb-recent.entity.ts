// 用户级最近访问（Task 1.10）：同用户同 KB 只保留一条，访问详情时 upsert 更新
// visitedAt（recordVisit），recent 视图按 visitedAt 倒序取该用户最近访问的 KB。
// 唯一约束（userId + kbId）保证同用户同 KB 单条记录（upsert 的 conflictPaths）；
// 复合索引 (userId, visitedAt) 支撑 recent 视图的「按用户 + 时间倒序」主查询
// （view=recent 的 WHERE userId + ORDER BY visitedAt DESC 走此索引）。
// 本表不建外键（P1 由服务层显式清理，见 KbService.remove 注释）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user_kb_recents')
@Index(['userId', 'kbId'], { unique: true })
@Index(['userId', 'visitedAt'])
export class UserKbRecent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 访问者用户 id */
  @Column({ type: 'uuid' })
  userId: string;

  /** 被访问的知识库 id */
  @Column({ type: 'uuid' })
  kbId: string;

  /** 最近访问时间（recordVisit 每次访问都刷新；recent 视图按此倒序） */
  @Column({ type: 'timestamptz' })
  visitedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}

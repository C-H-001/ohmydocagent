// 用户级收藏（多对多关系表，Task 1.10）：与 UserKbPin 同构——同一用户可收藏
// 多个知识库，唯一约束（userId + kbId）保证同一用户对同一 KB 最多一条收藏记录，
// toggleFavorite 的 upsert/删除依赖此约束收口并发竞态（后落库者撞 23505）。
// 本表不建外键（P1 由服务层显式清理，见 KbService.remove 注释——remove 事务内
// 先删 pins/favorites/recents 再删 KB 行，与 user_kb_pins 同款约定）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user_kb_favorites')
@Index(['userId', 'kbId'], { unique: true })
export class UserKbFavorite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 收藏者用户 id */
  @Column({ type: 'uuid' })
  userId: string;

  /** 被收藏的知识库 id */
  @Column({ type: 'uuid' })
  kbId: string;

  @CreateDateColumn()
  createdAt: Date;
}

// 分块版本历史实体（Task 1.9）：每次编辑/回滚生成一条（revision 从 1 递增；
// 0 号即原始 content，不落库——初始状态由 chunk.content 表示，原始内容另经
// chunk.sourceContent 永久保留）。与 WeKnora 的 chunk_revision 设计对齐的
// 追加式历史：编辑/回滚只 INSERT 新记录，从不 UPDATE/DELETE 既有记录——
// 版本线完整可追溯，回滚 = 以目标版本内容生成一个新版本（见
// ChunkService.revert 注释）。
// - chunkId：所属分块 id（无外键，沿用项目约定：子表级联删除由服务层显式
//   清理；本表随 chunk 删除自然遗留——分块删除目前只发生在文档删除/重新
//   解析（删旧建新）场景，版本历史随之作废，P4 可加级联清理，注释说明）
// - editorId：编辑者用户 id（无外键；nullable 容错手写 SQL 插入——正常路径
//   恒由 JwtAuthGuard 提供，见属性注释）
// - createdAt：CreateDateColumn（TypeORM 自动填充，不手动赋值）
// 索引：(chunkId, revision) 复合唯一（防同版本重复插入——并发编辑竞态下
// revision=contentRevision+1 相同则唯一约束兜底）；其前缀 (chunkId) 已覆盖
// 「按 chunk 读历史」（WHERE chunkId ORDER BY revision）查询，不建单列索引
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('chunk_revisions')
@Index('idx_chunk_revisions_chunk_revision', ['chunkId', 'revision'], {
  unique: true,
})
export class ChunkRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属分块 id（无外键；版本历史随 chunk 生命周期，见文件头注释） */
  @Column({ type: 'uuid' })
  chunkId: string;

  /** 该版本的分块内容（编辑/回滚后的新内容快照） */
  @Column({ type: 'text' })
  content: string;

  /** 版本号（1 起的递增序号，对应该 chunk 的 contentRevision——插入时
   * revision = chunk.contentRevision + 1） */
  @Column()
  revision: number;

  /** 编辑者用户 id（无外键）。nullable（任务书草稿为 default: ''——实施实测
   * PG 在 CREATE TABLE 时即校验 uuid 列 DEFAULT 常量字面量，'' 不是合法 uuid
   * 文本 → 22P02 建表失败；nullable 达成同一容错目标：手写 SQL 插入不提供
   * editorId 时落 NULL 而非报错，正常路径恒由 JwtAuthGuard 提供） */
  @Column({ type: 'uuid', nullable: true })
  editorId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

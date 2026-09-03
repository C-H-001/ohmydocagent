// 文档-标签多对多关联（Task 1.3）：普通 uuid 列（无外键，沿用 kbId 无 FK 约定），
// 级联删除由服务层事务承担（deleteTag / setKnowledgeTags 删旧插新 /
// KnowledgeService.removeByKbInTx 按 KB 聚合清理）。
// (knowledgeId, tagId) 唯一索引防重复关联（幂等打标 + 并发兜底）；
// tagId 单列索引供「删除标签时清理关联行」按 tagId 查询（唯一索引前缀不含 tagId）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('knowledge_tags')
@Index('idx_knowledge_tags_knowledge_tag_unique', ['knowledgeId', 'tagId'], {
  unique: true,
})
@Index('idx_knowledge_tags_tag_id', ['tagId'])
export class KnowledgeTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 文档 id */
  @Column({ type: 'uuid' })
  knowledgeId: string;

  /** 标签 id */
  @Column({ type: 'uuid' })
  tagId: string;

  @CreateDateColumn()
  createdAt: Date;
}

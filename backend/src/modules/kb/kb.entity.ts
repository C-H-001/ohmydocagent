// 知识库实体：单工作区多知识库（Task 1.1）。
// chunkingConfig 为解析分块配置（P1 先用默认空对象，Task 1.4/1.5 引入
// ChunkingConfig schema 后消费：{ chunkSize, chunkOverlap, separators }）。
// 注意：creatorId 仅是 uuid 列（无外键约束，与 invitations.createdById 同款约定），
// 子表外键/级联在 Task 1.2/1.5 建 knowledge/chunks 时补充。
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('knowledge_bases')
export class KnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ default: '' })
  description: string;

  /** 知识库类型：仅 document（FAQ/Wiki 已在需求阶段移除） */
  @Column({ default: 'document' })
  type: string;

  /** 创建人用户 id（当前无外键；P4 共享后 creatorId 仍是归属人） */
  @Column({ type: 'uuid' })
  creatorId: string;

  /**
   * 解析分块配置：P1 默认空对象（DTO 层可选传入，接受任意对象不校验结构），
   * Task 1.5 定义 ChunkingConfig 结构后再加 schema 校验。
   * default 用 SQL 表达式（"'{}'::jsonb"）而非 JS 默认值，避免 TypeORM
   * 对 jsonb 列默认值的序列化歧义，保证 insert 未传时落库为合法 jsonb。
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  chunkingConfig: Record<string, unknown>;

  /** 检索配置（参考 WeKnora RetrievalConfig）：RRF 权重与检索阈值。
   *  { vectorWeight, keywordWeight, graphWeight, k, vectorThreshold, keywordThreshold }
   *  缺省用默认值（0.7/0.3 向量偏重——WeKnora 默认，见 kb-search.tool） */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  retrievalConfig: Record<string, unknown>;

  /** 绑定的向量化模型 id：P1 未接入模型管理，恒为 null（Task 1.6 消费） */
  @Column({ type: 'uuid', nullable: true })
  embeddingModelId: string | null;

  /**
   * 图谱抽取配置（Task 3.2）：{ enabled: boolean }——KB 级开关，默认开启
   * （上传即建图的产品核心能力，e2e 契约：extractConfig 缺省 → 默认开启）。
   * 消费点：ParseProcessor 分块成功后按此开关入队 GRAPH、ExtractProcessor
   * 消费侧双保险（见 extract.processor.ts 文件头注释）。
   * default 用 SQL 表达式（与 chunkingConfig 同约定，避免 TypeORM 对 jsonb
   * 列默认值的序列化歧义，保证 insert 未传时落库为合法 jsonb）。
   */
  @Column({ type: 'jsonb', default: () => '\'{"enabled": true}\'::jsonb' })
  extractConfig: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

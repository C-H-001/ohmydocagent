// 文档分块实体（Task 1.5）：解析出的文本按 chunkingConfig 切块落库，块间用
// preChunkId/nextChunkId 形成单向链表（顺序访问/邻近块检索用，不依赖排序）。
// - content：当前分块内容（Task 1.9 支持编辑，编辑后与 sourceContent 分离）
// - sourceContent：首次解析生成的原文分块（编辑时保留，Task 1.9 版本语义）
// - indexStatus：向量化状态（processing/ready/failed）——Task 1.6 向量化完成后
//   置 ready；本任务插入时保持 processing（embedding 列见下）
// - startAt/endAt：原文中的半开区间偏移 [startAt, endAt)，用于原文定位/回溯
// kbId/knowledgeId 为普通 uuid 列（无外键，沿用 Task 1.1/1.2 约定：子表级联删除
// 由服务层显式清理保证无残留——见 KnowledgeService.removeByKbInTx 与 ChunkService）
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('chunks')
// 复合索引 (knowledgeId, chunkIndex)：列表按 chunkIndex 升序分页（WHERE
// knowledgeId + ORDER BY chunkIndex）的主力索引；其前缀 (knowledgeId) 已覆盖
// 「按文档读/删块」的查询（含文档删除时的子表清理），故不建 knowledgeId
// 单列索引；chunkIndex 单列无查询价值（全局序号无意义）
@Index('idx_chunks_knowledge_index', ['knowledgeId', 'chunkIndex'])
export class Chunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属知识库 id（无外键；级联删除由服务层清理） */
  @Index('idx_chunks_kb_id')
  @Column({ type: 'uuid' })
  kbId: string;

  /** 所属文档 id（无外键；文档删除时由 KnowledgeService/ChunkService 清理。
   * 不建单列索引——复合索引 (knowledgeId, chunkIndex) 前缀已覆盖，见类上注释） */
  @Column({ type: 'uuid' })
  knowledgeId: string;

  /** 分块内容（Task 1.9 编辑后与 sourceContent 分离） */
  @Column({ type: 'text' })
  content: string;

  // 中文检索词（应用侧 jieba 分词，GIN 索引检索；'simple' 分词器不切中文）
  /** 块类型（Task: 多模态）：'text'（正文块，默认）| 'image'（图片 caption 块）——
   *  image 块 content = VLM 图片描述（对齐 WeKnora ChunkTypeImageCaption），
   *  独立入向量/关键词索引，检索命中即可作为「带图引用」 */
  @Column({ type: 'varchar', default: 'text' })
  type: string;

  /** 图片块关联的 parser asset 键（type='image' 时有值；对齐 WeKnora
   *  image_info 的图片定位） */
  @Column({ type: 'varchar', nullable: true })
  assetKey: string | null;

  /** 图片块元数据（type='image' 时登记：url/caption/page/mimeType——
   *  与 knowledge.images 同源，见 parse.processor.persistImages） */
  @Column({ type: 'jsonb', nullable: true })
  imageInfo: {
    url: string;
    caption?: string;
    page?: number;
    mimeType?: string;
    assetKey?: string;
  } | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  keywords: string[];

  // 检索词空格连接文本（BM25 打分：to_tsvector('simple', keyword_text) 是
  // IMMUTABLE 表达式可建 GIN 索引——array_to_string 是 STABLE 不能进索引
  // 表达式，故入库时物化；与 keywords 同源，见 chunk.service）
  @Column({ type: 'text', default: '' })
  keywordText: string;

  /** 首次解析时的原文分块（编辑时保留，Task 1.9 版本语义） */
  @Column({ type: 'text' })
  sourceContent: string;

  /** 内容编辑版本号（Task 1.9 自增；本任务恒为 0） */
  @Column({ default: 0 })
  contentRevision: number;

  /** 向量化状态：processing（待向量化）/ ready（已向量化）/ failed。
   * Task 1.6 向量化后置 ready；插入时保持 processing（分块即待向量化） */
  @Column({ type: 'varchar', default: 'processing' })
  indexStatus: string;

  /**
   * 向量列（pgvector）：Task 1.6 写入。select:false —— 常规查询（列表/详情）
   * 不加载大向量（1024 维 × 4 字节 float4 ≈ 4KB/块——pgvector 默认 float4
   * 存储，8 字节 float8 需显式指定），只有原生 SQL 检索按需读取。
   * 类型 'vector' 由 TypeORM 1.1.0 原生支持（已实测，见下）：synchronize 会
   * 生成 vector(1024) 列；写入/读取时 JS 数组与 '[0.1,0.2,...]' 文本互转。
   * 存储格式：pgvector 文本（如 '[0.1,0.2,...]'）。
   *
   * 实测结论（Task 1.6 实施记录）：TypeORM 1.1.0 的 PostgresDriver 把 'vector'
   * 列入 supportedDataTypes，synchronize 前自动执行 CREATE EXTENSION IF NOT
   * EXISTS "vector"（afterConnect → checkMetadataForExtensions），loadTableColumns
   * 能解析 vector(1024) 的维度做类型比对——无需回退到「实体不声明 + 原生 SQL
   * 建列」方案。向量化扩展的存在性另由 DatabaseModule.onModuleInit 兜底确保。
   */
  @Column({ type: 'vector', length: 1024, nullable: true, select: false })
  embedding?: string | null;

  /** 块序号（文档内从 0 递增，列表按此升序） */
  @Column({ default: 0 })
  chunkIndex: number;

  /** 原文起始偏移（UTF-16 码元偏移，半开区间 [startAt, endAt)，与 content 的
   * slice 对应；分块引擎保证切点不在代理对中间，见 ChunkingService 注释） */
  @Column({ default: 0 })
  startAt: number;

  /** 原文结束偏移 */
  @Column({ default: 0 })
  endAt: number;

  /** 链表前驱块 id（首块为 null） */
  @Column({ type: 'uuid', nullable: true })
  preChunkId: string | null;

  /** 链表后继块 id（末块为 null） */
  @Column({ type: 'uuid', nullable: true })
  nextChunkId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

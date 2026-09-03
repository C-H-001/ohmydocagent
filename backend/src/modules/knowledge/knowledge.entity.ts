// 知识文档实体（Task 1.2）：file/url/manual 三种来源统一入库。
// - file：multipart 上传，文件落本地磁盘（filePath 相对 UPLOAD_DIR），解析在 Task 1.4 接入
// - url：URL 导入，P1 仅保存 sourceUrl（不抓取正文），正文抓取/解析在 Task 1.4 决定
// - manual：手动创建，正文存 manualContent（Task 1.5 分块消费）
// status 状态机：pending → parsing → ready/failed（Task 1.4 解析管线驱动；
// 本任务所有创建方式一律落 pending，不解析不入队——解析入口是 Task 1.4 的扩展点）
// folderId 列本任务预留（nullable），Task 1.3 文件夹功能启用；kbId 为普通 uuid 列
// （无外键），KB 删除级联由服务层事务显式删除（见 KbService.remove），不依赖 DB 级联。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 文档图片登记元数据（knowledge.images JSONB 元素，对齐 WeKnora ImageInfo） */
export interface KnowledgeImageMeta {
  /** parser 侧图片键（asset_key） */
  assetKey: string;
  /** 所在页（1-based） */
  page: number;
  /** MIME（image/png 等） */
  mimeType: string;
  /** 存储相对路径（{kbId}/{knowledgeId}/images/{key}.{ext}，见 StorageService） */
  url: string;
  /** VLM 生成的图片描述（图表 Caption；可能为空） */
  description?: string;
}

@Entity('knowledge')
export class Knowledge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属知识库 id（无外键，级联删除由服务层事务承担，见 KbService.remove 注释） */
  @Index('idx_knowledge_kb_id')
  @Column({ type: 'uuid' })
  kbId: string;

  /** 所属文件夹 id：Task 1.3 使用，本任务恒为 null */
  @Column({ type: 'uuid', nullable: true })
  folderId: string | null;

  /** 文档标题：文件上传 = 原文件名去扩展名；URL 导入 = 显式标题或 sourceUrl；手动 = 用户输入 */
  @Column()
  title: string;

  /** 创建方式：file（文件上传）/ url（URL 导入）/ manual（手动创建） */
  @Column({ type: 'enum', enum: ['file', 'url', 'manual'], default: 'file' })
  type: string;

  /** 落盘相对路径（相对 UPLOAD_DIR，见 StorageService 布局注释）；url/manual 为空串 */
  @Column({ default: '' })
  filePath: string;

  /** 文件扩展名（小写，pdf/docx/md/txt/png/...，见 KnowledgeService 白名单）；非文件类型为空串 */
  @Column({ default: '' })
  fileType: string;

  /** 文件字节数（multipart 的 size 原样记录）；url/manual 为 0 */
  @Column({ default: 0 })
  fileSize: number;

  /** URL 导入的源地址；非 url 类型为空串 */
  @Column({ default: '' })
  sourceUrl: string;

  /** 手动创建正文（Task 1.5 分块消费）；file/url 为 null */
  @Column({ type: 'text', nullable: true })
  manualContent: string | null;

  /** 解析提取的纯文本（Task 1.4 写入，Task 1.5 分块消费；未解析为 null。
   * 列表投影 LIST_SELECT 不含本字段——与 manualContent/summary 同为大字段，
   * 完整实体由详情接口返回 */
  @Column({ type: 'text', nullable: true })
  parsedText: string | null;

  /** 解析状态机：pending → parsing → ready/failed（Task 1.4 驱动） */
  @Column({
    type: 'enum',
    enum: ['pending', 'parsing', 'ready', 'failed'],
    default: 'pending',
  })
  status: string;

  /** 失败原因（status=failed 时填写，Task 1.4 解析错误）；成功为空串 */
  @Column({ default: '' })
  error: string;

  /** 文档摘要（Task 1.7 生成）；未生成为 null */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** 分块数量（Task 1.5 分块后更新） */
  @Column({ default: 0 })
  chunkCount: number;

  /** 文档入库到完成消耗的 token 数量（嵌入 + 图谱抽取 + 摘要，估算口径见
   *   embed.processor / graph-extraction.service / summary.processor 注释） */
  @Column({ default: 0 })
  tokenCost: number;

  /** 文档级分块配置（覆盖 KB 级 chunkingConfig；null = 跟随 KB）。
   *  结构同 ChunkingConfig { strategy, chunkSize, chunkOverlap, separators } */
  @Column({ type: 'jsonb', nullable: true })
  chunkingConfig: Record<string, unknown> | null;

  /** 文档图片资产登记（多模态：对齐 WeKnora ImageInfo——解析时图片 content
   *  存对象存储，元数据登记于此）。元素：{ assetKey, page, mimeType, url,
   *  description }（url = 存储相对路径，见 StorageService 路径语义） */
  @Column({ type: 'jsonb', nullable: true })
  images: KnowledgeImageMeta[] | null;

  /** 文档级解析引擎（mineru；null = 跟随全局 PARSER_ENGINE）。
   *  参考 WeKnora 引擎注册表——每文档可选引擎 */
  @Column({ type: 'text', nullable: true })
  parserEngine: string | null;

  /** 解析时间线（Task 1.7 写入各阶段耗时）；本任务为空数组 */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  parserStages: unknown[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

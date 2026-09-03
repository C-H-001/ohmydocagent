// 会话实体（Task 2.1）：单用户归属（userId 即 owner，无共享语义——P4 共享机制
// 另议）；kbIds 为对话上下文的知识库范围（@提及与选择器在 UI 层更新）。
// - pinned/pinnedAt：置顶标记 + 置顶时间（列表置顶优先排序，pinnedAt 供前端
//   展示「置顶于…」，语义见 SessionService.update 注释：pinned=true 更新、
//   false 清空）
// - userId 为普通 uuid 列（无外键，沿用本仓库约定：子表级联由服务层事务承担）
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('sessions')
// 列表查询（按 userId 过滤 + 置顶/updatedAt 排序）与详情归属校验的复合索引
@Index('idx_sessions_user_updated', ['userId', 'updatedAt'])
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 归属用户 id（会话属于创建者；P4 共享机制启用前只有本人可访问） */
  @Column({ type: 'uuid' })
  userId: string;

  /** 会话标题：创建时默认「新会话」（前端重命名覆盖） */
  @Column({ default: '新会话' })
  title: string;

  /**
   * 对话上下文的知识库范围（uuid 数组，@提及/选择器在 UI 层保证有效——
   * 服务端宽松校验，不校验 knowledge_bases 存在，见 SessionService.create 注释）。
   * 空数组 = 未关联任何知识库（全局检索语义由 Task 2.4 RAG 决定）
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  kbIds: string[];

  /** 置顶标记（列表置顶优先排序；置顶时间戳见 pinnedAt） */
  @Column({ default: false })
  pinned: boolean;

  /** 置顶时间：pinned=true 时写入、false 时清空（见 SessionService.update） */
  @Column({ type: 'timestamptz', nullable: true })
  pinnedAt: Date | null;

  /** 对话记忆（LLM 上下文压缩）：超出滑动窗口的早期历史经 LLM 摘要成一段
   *  记忆注入 system prompt——长会话不丢早期信息（参考 WeKnora 历史截断 +
   *  OhMyDocAgent 增强：截断而非丢弃，见 agent-orchestrator 记忆压缩注释）。
   *  格式 `{"summary":"...","count":N}`（count = 已纳入摘要的消息数，
   *  用于增量判断：窗口外新增消息时重新摘要） */
  @Column({ type: 'text', nullable: true })
  memorySummary: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

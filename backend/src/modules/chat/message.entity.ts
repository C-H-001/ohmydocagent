// 消息实体（Task 2.1）：本任务只定义列结构，写入/生成由 Task 2.2+（对话）驱动。
// - role 枚举：user/assistant/system（多模态消息结构在 Task 2.4-2.6 细化）
// - references/toolCalls/ragStages/attachments 为 Task 2.4-2.6 填充的 JSON 结构，
//   本任务先定义列（默认空数组），避免后续任务改表
// - reasoning 为深度思考内容（Task 2.8 模型输出 reasoning 字段时写入，可为 null）
// - sessionId 为普通 uuid 列（无外键，会话删除级联由服务层事务承担，
//   见 SessionService.remove/removeBatch/clearMessages）
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('messages')
// 消息列表（按 sessionId 过滤 + createdAt 升序）的复合索引
@Index('idx_messages_session_created', ['sessionId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属会话 id（无外键，级联删除由服务层事务承担，见 SessionService.remove） */
  @Column({ type: 'uuid' })
  sessionId: string;

  /** 消息角色：user（用户提问）/ assistant（助手回复）/ system（系统消息） */
  // TS 侧收紧为字面量联合（质量审查整改）：DB 侧仍是 enum 列（约束在库上），
  // 但 TS 属性类型与枚举取值集合对齐，Task 2.2 起写入消息时非法角色在编译期拦截
  @Column({
    type: 'enum',
    enum: ['user', 'assistant', 'system'],
    default: 'user',
  })
  role: 'user' | 'assistant' | 'system';

  /** 消息正文（assistant 回复的纯文本内容；多媒体结构在 Task 2.4-2.6 细化） */
  @Column({ type: 'text', default: '' })
  content: string;

  /** 深度思考内容（Task 2.8 模型输出 reasoning 时写入；未输出为 null） */
  @Column({ type: 'text', nullable: true })
  reasoning: string | null;

  /** 引用来源列表（Task 2.4 RAG 引用填充：[{ knowledgeId, chunkId, ... }]） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  references: unknown[];

  /** 工具调用记录（Task 2.5 工具调用填充：[{ tool, args, result, ... }]） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  toolCalls: unknown[];

  /** RAG 阶段追踪（Task 2.6 检索链路填充：[{ stage, status, ... }]） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  ragStages: unknown[];

  /** 附件列表（Task 2.4+ 多模态附件填充：[{ type, url, name, ... }]） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  attachments: unknown[];

  /** token 用量（assistant 消息：{ inputTokens, outputTokens, cacheHitTokens }，
   *  历史回放时顶栏恢复展示；user 消息为 null） */
  @Column({ type: 'jsonb', nullable: true })
  usage: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | null;

  /** 生成是否被中断（Task 2.10 停止生成）：stop/断连导致生成未完成 → true
   * （前端据此展示「已停止」+ partial 内容）；正常完成默认 false；user 消息
   * 恒 false（不中断）。断连 partial 也标 true——生成未完成即视为中断，
   * 与 stop 同一语义（见 chat-orchestrator.service.ts 文件头 Task 2.10 注释） */
  @Column({ default: false })
  interrupted: boolean;

  /** 创建时间：消息列表按此升序返回（对话自然时序） */
  @CreateDateColumn()
  createdAt: Date;
}

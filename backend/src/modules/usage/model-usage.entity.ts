// 模型用量实体（Task：普通用户模型用量管理界面）：
// 按 用户+模型 维度累计（唯一索引 userId+modelId），每次生成完成后累加：
// calls（调用次数）、inputTokens（输入）、outputTokens（输出）。
// 用途：用户查看自己的模型用量（token 消耗/调用次数），系统 super 可查全局。
// 设计决策：
// - 累计行（非明细）：用量展示是「额度/成本视角」，明细由聊天历史承载；
//   累计行查询 O(1)，随聊天量增长无膨胀（明细表会随消息增长）。
// - 记录点在 ChatOrchestrator 生成完成后（result.usage 透传），embedding/
//   摘要等离线任务暂不记录（聚焦用户可见的对话用量，见实现注释）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('model_usage')
@Index('idx_model_usage_user_model', ['userId', 'modelId'], { unique: true })
export class ModelUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 使用用户 */
  @Column({ type: 'uuid' })
  userId: string;

  /** 模型 id（models.id；模型删除后行保留，modelName 冗余快照） */
  @Column({ type: 'uuid' })
  modelId: string;

  /** 模型名快照（models.name 冗余：模型删除/改名后用量仍可读） */
  @Column({ type: 'text', default: '' })
  modelName: string;

  /** 模型类型（chat/embedding/rerank） */
  @Column({ type: 'text', default: 'chat' })
  type: string;

  /** 累计调用次数 */
  @Column({ default: 0 })
  calls: number;

  /** 累计输入 token */
  @Column({ default: 0 })
  inputTokens: number;

  /** 累计输出 token */
  @Column({ default: 0 })
  outputTokens: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

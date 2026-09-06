// 模型用量明细（Task: 用量趋势可视化）：每次对话生成完成后写一条明细
// （userId+modelId+createdAt+input/output tokens）——用于「每日趋势」聚合
// 图（近 7/14/30 天按日统计各模型调用/Token）。
// 设计决策：
// - 与 model_usage（累计行）并存：累计行服务「总量/成本视角」（O(1) 查询），
//   明细行服务「时间趋势视角」（按日 GROUP BY）。明细随对话量增长——仅保留
//   近 90 天可裁剪（见 service 清理注释），控制膨胀。
// - 记录点在 ChatOrchestrator 生成完成后（与累计 record 同一调用点补写，
//   见 model-usage.service.record 注释）；embedding/摘要等离线任务暂不记录
//   （与累计行口径一致——聚焦用户可见的对话用量）。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('usage_events')
@Index('idx_usage_events_user_date', ['userId', 'createdAt'])
export class UsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 使用用户 */
  @Column({ type: 'uuid' })
  userId: string;

  /** 模型 id（模型删除后行保留，modelName 冗余快照——同 model_usage 约定） */
  @Column({ type: 'uuid' })
  modelId: string;

  /** 模型名快照 */
  @Column({ type: 'text', default: '' })
  modelName: string;

  /** 模型类型（chat/embedding/rerank） */
  @Column({ type: 'text', default: 'chat' })
  type: string;

  /** 本次输入 token */
  @Column({ default: 0 })
  inputTokens: number;

  /** 本次输出 token */
  @Column({ default: 0 })
  outputTokens: number;

  /** 记录时间（按日聚合依据；清理 >90 天旧数据依据） */
  @CreateDateColumn()
  createdAt: Date;
}

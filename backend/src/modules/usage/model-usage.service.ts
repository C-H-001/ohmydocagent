// 模型用量服务（Task：普通用户模型用量管理界面）：
// - record：生成完成后累计（userId+modelId 唯一行，原子累加——并发防丢
//   更新：单条 UPDATE 累加，affected=0 时 INSERT；并发同首条 INSERT 撞
//   唯一索引 23505 → 重试 UPDATE 一次，收敛即可）
// - listMine：当前用户自己的用量（按 token 总量降序）
// - listAll：全部用户用量（super 专属；含用户 email join）
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../users/user.entity.js';
import { ModelUsage } from './model-usage.entity.js';
import { UsageEvent } from './usage-event.entity.js';

export interface UsageRow {
  modelId: string;
  modelName: string;
  type: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class ModelUsageService {
  constructor(
    @InjectRepository(ModelUsage)
    private readonly usageRepository: Repository<ModelUsage>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UsageEvent)
    private readonly eventRepository: Repository<UsageEvent>,
  ) {}

  /** 记录一次生成用量（原子累计；失败仅日志级影响——用量是辅助数据，不阻断对话） */
  async record(input: {
    userId: string;
    modelId: string;
    modelName: string;
    type?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) return; // 无用量（如上游未返回）
    try {
      const result = await this.usageRepository
        .createQueryBuilder()
        .update(ModelUsage)
        .set({
          calls: () => '"calls" + 1',
          inputTokens: () => `"inputTokens" + ${inputTokens}`,
          outputTokens: () => `"outputTokens" + ${outputTokens}`,
          modelName: input.modelName,
          type: input.type ?? 'chat',
        })
        .where('"userId" = :userId AND "modelId" = :modelId', {
          userId: input.userId,
          modelId: input.modelId,
        })
        .execute();
      if (result.affected === 0) {
        try {
          await this.usageRepository.insert({
            userId: input.userId,
            modelId: input.modelId,
            modelName: input.modelName,
            type: input.type ?? 'chat',
            calls: 1,
            inputTokens,
            outputTokens,
          });
        } catch (err) {
          // 并发首条：另一请求已插入（23505）→ 转 UPDATE 累加
          if (
            (err as { driverError?: { code?: string } })?.driverError?.code ===
            '23505'
          ) {
            await this.usageRepository
              .createQueryBuilder()
              .update(ModelUsage)
              .set({
                calls: () => '"calls" + 1',
                inputTokens: () => `"inputTokens" + ${inputTokens}`,
                outputTokens: () => `"outputTokens" + ${outputTokens}`,
              })
              .where('"userId" = :userId AND "modelId" = :modelId', {
                userId: input.userId,
                modelId: input.modelId,
              })
              .execute();
          } else {
            throw err;
          }
        }
      }
      // 补写明细行（趋势图数据源——按日聚合用）。独立事务/失败不阻断累计
      // （明细是辅助；累计行已成功）。清理 >90 天旧明细（随写随清，控制表膨胀）
      try {
        await this.eventRepository.insert({
          userId: input.userId,
          modelId: input.modelId,
          modelName: input.modelName,
          type: input.type ?? 'chat',
          inputTokens,
          outputTokens,
        });
        // 顺带清理 90 天前明细（低频——每次记录删一次远早于保留窗口的行）
        await this.eventRepository
          .createQueryBuilder()
          .delete()
          .where(`"createdAt" < NOW() - INTERVAL '90 days'`)
          .execute();
      } catch (err) {
        // 明细失败不影响累计（辅助中的辅助——仅告警）
        // eslint-disable-next-line no-console
        console.error(
          `用量明细记录失败: userId=${input.userId}`,
          err,
        );
      }
    } catch (err) {
      // 用量记录失败不阻断对话（辅助数据；日志由调用方捕获）
      // eslint-disable-next-line no-console
      console.error(
        `模型用量记录失败: userId=${input.userId}, modelId=${input.modelId}`,
        err,
      );
    }
  }

  /** 当前用户自己的用量（按 token 总量降序） */
  async listMine(userId: string): Promise<UsageRow[]> {
    const rows = await this.usageRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
    return rows
      .map((r) => ({
        modelId: r.modelId,
        modelName: r.modelName,
        type: r.type,
        calls: r.calls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }))
      .sort(
        (a, b) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      );
  }

  /** 全部用户用量（super 专属；join 用户 email） */
  async listAll(): Promise<
    Array<UsageRow & { userId: string; email: string }>
  > {
    const rows = await this.usageRepository.find({
      order: { updatedAt: 'DESC' },
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = userIds.length
      ? await this.userRepository.find({ where: { id: In(userIds) } })
      : [];
    const emailMap = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      userId: r.userId,
      email: emailMap.get(r.userId) ?? '未知用户',
      modelId: r.modelId,
      modelName: r.modelName,
      type: r.type,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));
  }

  /**
   * 用量趋势（按日聚合——图表数据源）：近 N 天（默认 30，上限 90）每天各
   * 模型的调用次数与 token 消耗。按日 GROUP BY（日期用本地时区——数据库
   * 会话时区决定，生产 UTC；前端按展示即可）。
   * 返回 [{ date: 'YYYY-MM-DD', models: { modelId: { calls, tokens } } }]——
   * 模型动态（用户配置过哪些就返回哪些），缺失日期的模型记 0（前端堆叠图
   * 需连续轴）。
   */
  async trend(
    userId: string,
    days = 30,
  ): Promise<Array<{ date: string; models: Record<string, { calls: number; tokens: number; name: string }> }>> {
    const clamped = Math.min(Math.max(days, 1), 90);
    const rows: Array<{
      day: string;
      modelId: string;
      modelName: string;
      calls: string;
      tokens: string;
    }> = await this.eventRepository
      .createQueryBuilder('e')
      .select("TO_CHAR(e.\"createdAt\", 'YYYY-MM-DD')", 'day')
      .addSelect('e."modelId"', 'modelId')
      .addSelect('MAX(e."modelName")', 'modelName')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('SUM(e."inputTokens" + e."outputTokens")', 'tokens')
      .where('e."userId" = :userId', { userId })
      .andWhere('e."createdAt" >= NOW() - (:days || \' days\')::interval', {
        days: clamped,
      })
      .groupBy('day')
      .addGroupBy('e."modelId"')
      .orderBy('day', 'ASC')
      .getRawMany<{
        day: string;
        modelId: string;
        modelName: string;
        calls: string;
        tokens: string;
      }>();

    // 组装：每天 → 模型映射（缺失补 0——连续日期轴）
    const byDay = new Map<string, Record<string, { calls: number; tokens: number; name: string }>>();
    const modelNames = new Map<string, string>();
    for (const r of rows) {
      modelNames.set(r.modelId, r.modelName);
      const day = byDay.get(r.day) ?? {};
      day[r.modelId] = {
        calls: Number(r.calls ?? 0),
        tokens: Number(r.tokens ?? 0),
        name: r.modelName,
      };
      byDay.set(r.day, day);
    }
    // 连续日期（含无数据的天——前端堆叠图轴连续）
    const out: Array<{ date: string; models: Record<string, { calls: number; tokens: number; name: string }> }> = [];
    const today = new Date();
    for (let i = clamped - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, models: byDay.get(key) ?? {} });
    }
    return out;
  }
}

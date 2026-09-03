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
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { EmbeddingProfile } from './embedding-profile.entity.js';
import { Model } from './model.entity.js';
import { LLMProviderFactory } from './providers/llm-provider.factory.js';
import type { LLMProvider } from './providers/llm-provider.interface.js';

type EmbeddingResult = { vectors: number[][]; totalTokens: number };
type UsageProvider = LLMProvider & {
  embedWithUsage?: (
    texts: string[],
    model?: string,
  ) => Promise<EmbeddingResult>;
};

/** 不解析默认模型；快照定义空间，当前模型仅提供权限状态和最新凭据。 */
@Injectable()
export class EmbeddingProfileService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly factory: LLMProviderFactory,
  ) {}

  async getProfile(profileId: string): Promise<EmbeddingProfile> {
    let profile: EmbeddingProfile | null;
    try {
      if (!profileId) throw new Error();
      profile = await this.dataSource
        .getRepository(EmbeddingProfile)
        .findOne({ where: { id: profileId } });
    } catch {
      throw new ServiceUnavailableException('读取向量配置失败，请稍后重试');
    }
    if (!profile) throw new NotFoundException('向量配置不存在');
    return profile;
  }

  async createProfile(
    modelId: string,
    ownerId: string,
  ): Promise<EmbeddingProfile> {
    try {
      const model = await this.loadModel(modelId, ownerId);
      const extraConfig = this.embeddingConfig(model.extraConfig);
      // 在请求前复制配置，避免探测期间的对象变更影响指纹或落库快照。
      const snapshot = {
        modelId: model.id,
        ownerId,
        provider: model.provider,
        baseUrl: model.baseUrl,
        modelName: model.modelName,
        extraConfig,
      };
      const result = await this.request(model, ['向量配置验证']);
      const dimension = this.validateVectors(
        result.vectors,
        1,
        extraConfig.dimensions as number | undefined,
      );
      const config = { ...snapshot, dimension };
      const fingerprint = createHash('sha256')
        .update(this.stableSerialize(config))
        .digest('hex');
      const repository = this.dataSource.getRepository(EmbeddingProfile);
      const where = { ownerId, fingerprint };
      const existing = await repository.findOne({ where });
      if (existing) return existing;
      try {
        return await repository.save(
          repository.create({ ...config, fingerprint }),
        );
      } catch (error) {
        // PostgreSQL 唯一索引解决并发创建；不更新已有快照。
        if (this.isUniqueViolation(error)) {
          const winner = await repository.findOne({ where });
          if (winner) return winner;
        }
        throw error;
      }
    } catch {
      // 不传递上游异常、URL、响应正文或密钥（包括工厂解密/数据库异常）。
      throw new BadRequestException(
        '创建向量配置失败，请检查私有向量模型是否启用、连接配置及向量维度是否有效（1至4000）',
      );
    }
  }

  async embed(profileId: string, texts: string[]): Promise<EmbeddingResult> {
    try {
      const profile = await this.getProfile(profileId);
      const model = await this.loadModel(profile.modelId, profile.ownerId);
      this.validateDimension(profile.dimension);
      if (!Array.isArray(texts)) throw new Error();
      for (const text of texts) {
        if (typeof text !== 'string') throw new Error();
      }
      if (texts.length === 0) return { vectors: [], totalTokens: 0 };
      const result = await this.request(
        {
          ...model,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          modelName: profile.modelName,
          extraConfig: profile.extraConfig,
        },
        texts,
      );
      this.validateVectors(result.vectors, texts.length, profile.dimension);
      return result;
    } catch {
      throw new ServiceUnavailableException(
        '向量生成失败，请检查向量配置、模型权限、启用状态及返回维度',
      );
    }
  }

  private async loadModel(modelId: string, ownerId: string): Promise<Model> {
    if (!modelId || !ownerId) throw new Error();
    const model = await this.dataSource
      .getRepository(Model)
      .findOne({ where: { id: modelId } });
    if (
      !model ||
      model.userId !== ownerId ||
      model.enabled !== true ||
      model.type !== 'embedding'
    ) {
      throw new Error();
    }
    return model;
  }

  private embeddingConfig(
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    // 严格白名单：不复制密钥、任意嵌套对象或 chat 参数。
    const result: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(config ?? {}, 'dimensions')) {
      this.validateDimension(config.dimensions);
      result.dimensions = config.dimensions;
    }
    if (typeof config?.supportsDimensionOverride === 'boolean') {
      result.supportsDimensionOverride = config.supportsDimensionOverride;
    }
    return result;
  }

  private async request(
    model: Model,
    texts: string[],
  ): Promise<EmbeddingResult> {
    const provider: UsageProvider = this.factory.create(model);
    if (typeof provider.embedWithUsage === 'function') {
      const result = await provider.embedWithUsage(texts, model.modelName);
      // 不向调用方透传供应商可能附加的敏感字段；无效用量归零。
      return {
        vectors: result.vectors,
        totalTokens:
          Number.isSafeInteger(result.totalTokens) && result.totalTokens >= 0
            ? result.totalTokens
            : 0,
      };
    }
    return {
      vectors: await provider.embed(texts, model.modelName),
      totalTokens: 0,
    };
  }

  private validateDimension(value: unknown): asserts value is number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 4000
    ) {
      throw new Error();
    }
  }

  private validateVectors(
    vectors: unknown,
    count: number,
    expected?: number,
  ): number {
    if (!Array.isArray(vectors) || vectors.length !== count || count < 1) {
      throw new Error();
    }
    const dimension =
      expected ?? (Array.isArray(vectors[0]) ? vectors[0].length : 0);
    this.validateDimension(dimension);
    // for..of 不跳过稀疏数组中的空槽；不能使用 every/some 代替完整校验。
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== dimension)
        throw new Error();
      let nonzero = false;
      for (const value of vector) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error();
        if (value !== 0) nonzero = true;
      }
      if (!nonzero) throw new Error();
    }
    return dimension;
  }

  private stableSerialize(value: unknown): string {
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value))
        return `[${value.map((item) => this.stableSerialize(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${this.stableSerialize(record[key])}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const databaseError = error as {
      code?: unknown;
      driverError?: { code?: unknown };
    };
    return (
      databaseError.code === '23505' ||
      databaseError.driverError?.code === '23505'
    );
  }
}

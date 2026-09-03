// backend/src/modules/model/model.service.ts
// 模型管理业务规则（Task 2.3 + 质量审查整改）：
//
// - create：apiKey 用 CryptoService 加密后落库（DB 不存明文）；ollama 未传
//   baseUrl 时填默认 http://127.0.0.1:11434（本地端点，见实体注释）；
//   openai-compatible 必填 baseUrl（DTO 层 @IsUrl 只拦格式，这里拦「缺省」——
//   空 baseUrl 无法路由，fail-fast 而不是等连通性测试才暴露）
// - list/getById/update/setDefault 返回脱敏视图（sanitize）：剔除
//   apiKeyEncrypted，只暴露 hasApiKey 布尔（响应层不泄露密文；
//   e2e 断言「响应无 apiKeyEncrypted 字段 + DB 查不到明文」）
// - update：只更新传入字段；apiKey 非空 → 重新加密、空串 → 清除密钥、
//   不传 → 保留原密文；**type 变更 + 本行是默认** → 目标 type 已有默认则
//   清除本行 isDefault（防部分唯一索引 23505 裸 500；语义与删除默认模型一致：
//   改 type 即放弃默认地位，见 update 注释）
// - setDefault：事务内「同 type 先清默认 → 目标置默认」——每 type 最多
//   一个默认（部分唯一索引 idx_models_default_type 兜底；并发撞 23505 →
//   重试一次收敛，见 setDefault 注释）；**disabled 模型拒绝设默认**（400——
//   否则 getDefault 过滤 enabled 后静默无默认，见 setDefault 注释）
// - remove：**允许删除默认模型**（设计决策：删除即该 type 自动无默认，
//   前端提示后续需重设——比「拒绝删除 + 400 请先切换」更顺滑：模型配置
//   是低频操作，强制先切默认再删是多余步骤）
// - getDefault(type)：路由用——isDefault=true && enabled，无则 null
//   （真实 ChatModelService/EmbeddingService 无默认模型时抛 503，见各实现）；
//   **内存缓存**：检索热路径（标题生成/向量化）每次查库不必要——模型个位数，
//   Map<type, Model> 缓存 + 写操作失效（setDefault/update/remove，见各处注释）
// - testConnection：连通性测试「只探活、不落库」——请求体完整配置直传
//   provider（baseUrl 的 SSRF 防护在 provider fetch 前，见 ssrf.guard.ts）；
//   testSavedModel：已保存模型解密 key 后测试
// - debug：模型调试——固定测试消息调 chat，返回实际生成文本（前端
//   「模型调试」直接展示；与 testConnection 的最小 1-token 请求区分）
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { AuditService } from '../admin/audit/audit.service.js';
import { Role, User } from '../users/user.entity.js';
import { CryptoService } from './crypto.service.js';
import { CreateModelDto } from './dto/create-model.dto.js';
import { UpdateModelDto } from './dto/update-model.dto.js';
import { TestModelDto } from './dto/test-model.dto.js';
import { Model } from './model.entity.js';
import type { ModelType } from './model.entity.js';
import { LLMProviderFactory } from './providers/llm-provider.factory.js';
import type {
  TestConnectionResult,
  ProviderConnectionConfig,
} from './providers/llm-provider.interface.js';

/** Ollama 默认端点（create 时未传 baseUrl 的兜底，见实体/任务书注释） */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** 对外模型视图：剔除加密 key 列，只暴露 hasApiKey 布尔
 * （DB 存密文 + 响应脱敏双保险，见文件头注释） */
export type ModelView = Omit<Model, 'apiKeyEncrypted'> & {
  hasApiKey: boolean;
};

/** 模型调试结果（POST /models/:id/debug） */
export interface DebugResult {
  output: string;
}

@Injectable()
export class ModelService {
  /**
   * getDefault 内存缓存：检索热路径（标题生成/向量化管线每次都要查默认模型）
   * 避免每次查库。模型是系统级配置、数量个位数，Map<type, Model> 足够。
   * 缓存值：null 也缓存（「该 type 无默认」是合法结果，避免反复查库）。
   * 失效点（凡可能改变 isDefault/enabled/type 的写操作）：
   * - setDefault → 直接写入新默认（见该方法）
   * - update → 删旧/新 type 两条（enabled/isDefault/type 都可能变）
   * - remove → 删该模型 type（默认被删除 = 该 type 无默认）
   * - create 不失效：新模型 isDefault 恒 false，不影响 getDefault 结果
   */
  // BYOK 缓存：键 `${type}:${userId ?? 'global'}`——用户私有默认 + 全局默认
  private readonly defaultCache = new Map<string, Model | null>();

  constructor(
    @InjectRepository(Model)
    private readonly repo: Repository<Model>,
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly factory: LLMProviderFactory,
    // Task 4.4 审计（全局模块直接注入，见 audit.module.ts 注释）：模型是
    // 系统级配置、接口不传操作人 → userId 记 null（见 audit-log.entity.ts 注释）
    private readonly audit: AuditService,
  ) {}

  /** 脱敏视图：apiKeyEncrypted 剔除、hasApiKey 布尔表达密钥是否存在 */
  private sanitize(model: Model): ModelView {
    const { apiKeyEncrypted: _key, ...rest } = model;
    return { ...rest, hasApiKey: model.apiKeyEncrypted.length > 0 };
  }

  /** 加载模型行（不存在 → 404）；内部方法（带密文，不脱敏）。
   *  BYOK 归属校验：私有模型仅归属用户；全局模型仅 super；越权 → 404（隐藏） */
  private async requireModel(
    id: string,
    userId?: string,
    role?: string,
  ): Promise<Model> {
    const model = await this.repo.findOne({ where: { id } });
    if (!model) {
      throw new NotFoundException('模型不存在');
    }
    if (model.userId !== null && model.userId !== userId) {
      throw new NotFoundException('模型不存在');
    }
    if (model.userId === null && role !== Role.Super) {
      throw new NotFoundException('模型不存在');
    }
    return model;
  }

  /** 新增模型：加密 apiKey + provider 默认值；返回脱敏视图（201） */
  async create(dto: CreateModelDto, userId?: string | null): Promise<ModelView> {
    // openai-compatible 必填 baseUrl：DTO 层 @IsUrl 只校验格式，这里拦「缺省」
    // （ollama 可留空 → 下方填默认 127.0.0.1:11434；openai-compatible 空 baseUrl
    // 无法路由，fail-fast 而不是等连通性测试/实际调用才暴露）
    if (dto.provider === 'openai-compatible' && !dto.baseUrl) {
      throw new BadRequestException(
        'openai-compatible 供应商必须配置 baseUrl（如 https://api.deepseek.com）',
      );
    }
    const entity = this.repo.create({
      name: dto.name,
      provider: dto.provider,
      // ollama 未传 baseUrl → 本地默认端点（见文件头注释）
      baseUrl:
        dto.baseUrl ??
        (dto.provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : ''),
      // API Key 加密后落库（DB 不存明文；空/未传 → 空密文 = 无密钥）
      apiKeyEncrypted: dto.apiKey ? this.crypto.encrypt(dto.apiKey) : '',
      modelName: dto.modelName,
      type: dto.type ?? 'chat',
      enabled: dto.enabled ?? true,
      extraConfig: dto.extraConfig ?? {},
      // BYOK：用户私有模型（userId=null = 全局，super 配置兜底）
      userId: userId ?? null,
    });
    const saved = await this.repo.save(entity);
    // 审计：创建模型（不记 apiKey 相关字段）
    await this.audit.log('model.create', null, 'model', saved.id, {
      name: saved.name,
      provider: saved.provider,
      type: saved.type,
    });
    return this.sanitize(saved);
  }

  /** 列表（按 type 可选筛选）：全量返回（模型数量有限不分页，见 DTO 注释） */
  async list(type?: ModelType, userId?: string, role?: string): Promise<ModelView[]> {
    // BYOK：返回「我的模型 + 全局模型」（super 配置兜底——聊天/检索路由
    // 用户私有优先、全局兜底，见 getDefault）；super 额外可见全部全局
    // BYOK：只返回自己的模型（平台不提供全局默认——参考 WeKnora 用户自配）
    const where: FindOptionsWhere<Model> = {};
    if (type) where.type = type;
    where.userId = userId ?? '';
    const models = await this.repo.find({
      where,
      order: { type: 'ASC', createdAt: 'ASC' },
    });
    return models.map((m) => this.sanitize(m));
  }

  /** 详情：脱敏视图；不存在 → 404 */
  async getById(id: string, userId?: string, role?: string): Promise<ModelView> {
    return this.sanitize(await this.requireModel(id, userId, role));
  }

  /** 更新：只更新传入字段；apiKey 语义见文件头注释（空串清除 / 非空重加密） */
  async update(
    id: string,
    dto: UpdateModelDto,
    userId?: string,
    role?: string,
  ): Promise<ModelView> {
    const model = await this.requireModel(id, userId, role);
    const oldType = model.type;
    // type 变更 + 本行是默认 → 目标 type 已有默认则清除本行 isDefault：
    // 否则「改 type 保留默认」会撞部分唯一索引 idx_models_default_type → 23505
    // 裸 500。选「清除」而非「400 拒绝」——与删除默认模型语义一致（改 type
    // 即放弃默认地位，前端可在目标 type 重新设置）；目标 type 无默认则保留
    // 默认标记（本行继续作为新 type 的唯一默认，符合索引约束）
    if (dto.type !== undefined && dto.type !== model.type && model.isDefault) {
      const targetDefault = await this.repo.findOne({
        where: { type: dto.type, isDefault: true },
      });
      if (targetDefault) {
        model.isDefault = false;
      }
    }
    if (dto.name !== undefined) model.name = dto.name;
    if (dto.provider !== undefined) model.provider = dto.provider;
    if (dto.baseUrl !== undefined) model.baseUrl = dto.baseUrl;
    if (dto.apiKey !== undefined) {
      // 非空 → 重新加密；空串 → 清除已存密钥（hasApiKey 变 false）
      model.apiKeyEncrypted = dto.apiKey ? this.crypto.encrypt(dto.apiKey) : '';
    }
    if (dto.modelName !== undefined) model.modelName = dto.modelName;
    if (dto.type !== undefined) model.type = dto.type;
    if (dto.enabled !== undefined) model.enabled = dto.enabled;
    if (dto.extraConfig !== undefined) model.extraConfig = dto.extraConfig;
    const saved = await this.repo.save(model);
    // getDefault 缓存失效：旧/新 type 都删（enabled/isDefault/type 可能都变了）
    this.invalidateDefault(oldType, saved.userId);
    this.invalidateDefault(saved.type, saved.userId);
    return this.sanitize(saved);
  }

  /** 删除：允许删除默认模型（删除即该 type 无默认，见文件头设计决策） */
  async remove(id: string, userId?: string, role?: string): Promise<void> {
    const model = await this.requireModel(id, userId, role);
    await this.repo.delete(id);
    // getDefault 缓存失效：默认模型被删 = 该 type 无默认
    this.defaultCache.delete(model.type);
    // 审计：删除模型
    await this.audit.log('model.delete', null, 'model', id, {
      name: model.name,
      type: model.type,
    });
  }

  /**
   * 设为默认（每 type 唯一）：事务内「同 type 先清默认 → 目标置默认」。
   * 并发兜底：两个并发 setDefault 同 type 时，部分唯一索引
   * （idx_models_default_type）可能撞 23505——重试一次即可收敛（先清后设
   * 的事务在串行化后结果确定：后提交者胜，符合预期）；重试仍冲突则抛
   * ConflictException（异常竞争，不应发生）。
   */
  async setDefault(id: string, userId?: string, role?: string): Promise<ModelView> {
    for (let attempt = 0; ; attempt++) {
      try {
        const model = await this.dataSource.transaction(async (em) => {
          const target = await em.findOne(Model, { where: { id } });
          if (!target) {
            throw new NotFoundException('模型不存在');
          }
          // disabled 模型拒绝设默认：否则 getDefault（isDefault && enabled）
          // 查不到它 → 路由静默无默认（503 而非明确报错），排查成本高
          if (!target.enabled) {
            throw new BadRequestException('该模型已停用，请先启用再设为默认');
          }
          // 同 type 现有默认全部清除 → 目标置默认（原子：要么全清要么不动）
          await em.update(
            Model,
            { type: target.type, isDefault: true },
            { isDefault: false },
          );
          target.isDefault = true;
          return em.save(target);
        });
        // getDefault 缓存：直接写入新默认（比 delete 再查省一次查库；
        // model 已通过 enabled + isDefault=true 校验，符合 getDefault 条件）
        this.defaultCache.set(`${model.type}:${model.userId ?? 'global'}`, model);
        // 审计：默认模型变更
        await this.audit.log('model.set_default', null, 'model', id, {
          name: model.name,
          type: model.type,
        });
        return this.sanitize(model);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt < 1 && code === '23505') continue; // 并发唯一冲突 → 重试一次
        throw err;
      }
    }
  }

  /** 路由用：该 type 的默认模型（isDefault && enabled），无则 null。
   * 内存缓存命中直接返回（热路径查库优化，见 defaultCache 注释） */
  async getDefault(type: ModelType, userId?: string | null): Promise<Model | null> {
    // BYOK（参考 WeKnora：租户/用户自己配模型，平台不提供默认兜底）：
    // 只查用户私有默认；无 userId（调用方未传归属）或未配置 → null
    // （ChatModelService/EmbeddingService 抛 503 提示用户配置）
    if (!userId) return null;
    const key = `${type}:${userId}`;
    if (this.defaultCache.has(key)) {
      return this.defaultCache.get(key) ?? null;
    }
    const model = await this.repo.findOne({
      where: { type, isDefault: true, enabled: true, userId },
    });
    this.defaultCache.set(key, model);
    return model;
  }

  /** 缓存失效：删除某 (type, userId) 的默认缓存（userId=null 为全局） */
  private invalidateDefault(type: ModelType, userId: string | null): void {
    this.defaultCache.delete(`${type}:${userId ?? 'global'}`);
  }

  /** 连通性测试（POST /models/test）：请求体完整配置直传，不落库 */
  async testConnection(dto: TestModelDto): Promise<TestConnectionResult> {
    const config: ProviderConnectionConfig = {
      baseUrl: dto.baseUrl,
      apiKey: dto.apiKey ?? '',
      modelName: dto.modelName,
    };
    return this.factory.getRaw(dto.provider).testConnection(config);
  }

  /** 已保存模型连通性测试（POST /models/:id/test）：解密 key 后测试 */
  async testSavedModel(id: string, userId?: string, role?: string): Promise<TestConnectionResult> {
    const model = await this.requireModel(id, userId, role);
    const config: ProviderConnectionConfig = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKeyEncrypted
        ? this.crypto.decrypt(model.apiKeyEncrypted)
        : '',
      modelName: model.modelName,
    };
    return this.factory.getRaw(model.provider).testConnection(config, model.type);
  }

  /** 模型调试（POST /models/:id/debug）：固定测试消息 → 实际生成文本 */
  async debug(id: string, userId?: string, role?: string): Promise<DebugResult> {
    const model = await this.requireModel(id, userId, role);
    const provider = this.factory.create(model);
    const output = await provider.chat(
      [{ role: 'user', content: '请直接回复两个字：你好' }],
      { maxTokens: 20, temperature: 0, model: model.modelName },
    );
    return { output };
  }
}

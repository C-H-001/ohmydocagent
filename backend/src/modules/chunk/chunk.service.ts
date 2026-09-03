// 分块持久化服务（Task 1.5 + Task 1.9）：
// - buildChunkRows：纯函数（可单测）——把 ChunkUnit[] 转成带 uuid/chunkIndex/
//   pre/next 链表的 Chunk 行。用 randomUUID 预生成 id，单次批量插入即可完成
//   链表回填（无需第二遍 update）；链表与分块写入同一事务（见 replaceChunksInTx）
// - createChunksForKnowledge / replaceChunksInTx：事务内写块（EntityManager
//   参数——ParseProcessor 复用其 dataSource.transaction；replace = 删旧插新，
//   Task 1.7 reparse 语义基础）
// - listChunks：分块列表（chunkIndex 升序 + 分页，复用 common/pagination），
//   kbId+knowledgeId 双重限定（404 语义，防跨 KB 越权读取）
// - updateContent / listRevisions / revert（Task 1.9 编辑/版本历史/回滚）：
//   编辑/回滚在同一事务内更新 chunk + 追加版本记录（chunk_revisions），
//   indexStatus 置 processing 触发单块重新向量化（入队 EMBED，payload
//   { chunkId }，事务提交后入队——保证 EmbedProcessor 读到的已是新内容）；
//   sourceContent 保留首次解析原文（编辑/回滚都不触碰）；回滚是追加式
//   （不改历史，新版本内容 = 目标版本内容；revision=0 表示原始版本，目标
//   内容 = sourceContent），与 WeKnora chunk_revision 设计对齐（见
//   chunk-revision.entity.ts 注释）
// - 并发/竞态语义（质量审查整改）：chunk 更新改用 UPDATE + affected 校验
//   （原 save 在行被并发删除时静默成功返回陈旧实体）——affected=0 即行已
//   不存在 → 404，事务回滚使已插入的 revision 一并撤销（不产生孤儿版本行）；
//   revision 插入撞 (chunkId, revision) 复合唯一索引（PG 23505，同 chunk 两个
//   编辑/回滚并发时后落库者）→ 409「分块正在被编辑，请重试」（与 auth 的
//   M1 driverError.code 模式一致，见 updateContent/revert 注释）
// - deleteByKnowledge / deleteByKnowledgeInTx / deleteByKbInTx：文档删除 / KB
//   级联删除的子表清理（chunks 无外键，服务层显式清理保证无残留，沿用
//   Task 1.2 约定；InTx 变体供 KnowledgeService 在删除事务内复用，与主表行
//   删除原子化，见 parse.processor.ts 的删除竞态注释）
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { segment } from '../../common/utils/chinese-seg.js';
import { paginate, Paginated } from '../../common/pagination.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { addQueueJob, EMBED_QUEUE } from '../parse/parse-queue.constants.js';
import type { EmbedJob } from '../parse/parse-queue.constants.js';
import { Chunk } from './chunk.entity.js';
import { ChunkRevision } from './chunk-revision.entity.js';
import type { ChunkUnit } from './chunking.service.js';

@Injectable()
export class ChunkService {
  private readonly logger = new Logger(ChunkService.name);

  constructor(
    @InjectRepository(Chunk)
    private readonly chunkRepository: Repository<Chunk>,
    // 文档存在性校验直查 knowledge 表（不注入 KnowledgeService，
    // 保持本模块不依赖 KnowledgeModule，模块依赖方向单向无环）
    @InjectRepository(Knowledge)
    private readonly knowledgeRepository: Repository<Knowledge>,
    // 版本历史仓储（Task 1.9）：updateContent/revert 追加记录、listRevisions 读取
    @InjectRepository(ChunkRevision)
    private readonly revisionRepository: Repository<ChunkRevision>,
    // 事务（编辑/回滚 = chunk 更新 + 版本记录原子化）
    private readonly dataSource: DataSource,
    // 单块向量化队列（Task 1.9）：编辑/回滚后入队 EMBED（payload { chunkId }），
    // 队列由 EmbedQueueModule 单点注册/导出（两侧注入同一实例，见
    // embed-queue.module.ts 注释）
    @InjectQueue(EMBED_QUEUE) private readonly embedQueue: Queue<EmbedJob>,
  ) {}

  /**
   * 纯函数：把 ChunkUnit[] 转为待落库的 Chunk 行（预生成 uuid + 一次性回填
   * 链表）。不触碰 repo——单测可直接调用（new Chunk() 断言字段）。
   * - chunkIndex 从 0 递增；preChunkId/nextChunkId 形成单向链表
   * - sourceContent = 首次解析内容（Task 1.9 编辑时保留语义）
   * - indexStatus = processing（Task 1.6 向量化后置 ready，本任务不向量化）
   */
  buildChunkRows(
    knowledgeId: string,
    kbId: string,
    units: ChunkUnit[],
  ): Chunk[] {
    const rows = units.map((unit, i) => {
      const row = new Chunk();
      row.id = randomUUID(); // 预生成：单次批量插入即可回填链表
      row.kbId = kbId;
      row.knowledgeId = knowledgeId;
      row.content = unit.content;
      row.sourceContent = unit.content; // 首次解析内容（Task 1.9 编辑保留）
      row.keywords = segment(unit.content); // 中文检索词（jieba 分词）
      row.keywordText = row.keywords.join(' '); // BM25 打分物化列
      row.chunkIndex = i;
      row.startAt = unit.startAt;
      row.endAt = unit.endAt;
      if (unit.type === 'image') {
        row.type = 'image';
        row.assetKey = unit.assetKey ?? null;
        row.imageInfo = unit.imageInfo ?? null;
      }
      row.indexStatus = 'processing'; // 显式：Task 1.6 向量化后置 ready
      row.contentRevision = 0;
      row.preChunkId = null;
      row.nextChunkId = null;
      return row;
    });
    // 链表回填（第二遍就地更新，同批插入）：首块 pre 空、末块 next 空
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) rows[i].preChunkId = rows[i - 1].id;
      if (i < rows.length - 1) rows[i].nextChunkId = rows[i + 1].id;
    }
    return rows;
  }

  /** 事务内创建分块：空 units → 空数组不写库；返回落库后的 Chunk 数组 */
  async createChunksForKnowledge(
    manager: EntityManager,
    knowledge: Knowledge,
    units: ChunkUnit[],
  ): Promise<Chunk[]> {
    if (units.length === 0) return [];
    const rows = this.buildChunkRows(knowledge.id, knowledge.kbId, units);
    return manager.save(Chunk, rows);
  }

  /** 事务内全量替换分块（删旧插新）：Task 1.7 reparse 语义基础——
   * 重新解析后旧块整体作废（含链表/偏移全部重建），不存在增量 diff */
  async replaceChunksInTx(
    manager: EntityManager,
    knowledge: Knowledge,
    units: ChunkUnit[],
  ): Promise<Chunk[]> {
    await manager.delete(Chunk, { knowledgeId: knowledge.id });
    return this.createChunksForKnowledge(manager, knowledge, units);
  }

  /**
   * 分块列表：kbId+knowledgeId 双重限定（防跨 KB 越权读取），
   * 按 chunkIndex 升序 + 分页（复用 common/pagination 的统一结构）。
   * 文档不存在/非 UUID → 404（22P02 同样视为不存在，不泄露内部错误）。
   */
  async listChunks(
    kbId: string,
    knowledgeId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<Chunk>> {
    await this.ensureKnowledgeInKb(kbId, knowledgeId);
    return paginate(this.chunkRepository, page, pageSize, {
      where: { knowledgeId },
      order: { chunkIndex: 'ASC' },
    });
  }

  /**
   * 编辑分块内容（Task 1.9）：content 更新 + contentRevision 自增 + 追加版本
   * 记录 + indexStatus=processing（触发单块重新向量化）。
   * 事务内完成 chunk 更新与 revision 落库（原子化：任一步失败整体回滚，不会
   * 出现「版本记录已写但块未更新」的中间态）；入队在事务提交后（与
   * ParseProcessor 的入队时机一致，见 parse.processor.ts chunkKnowledge 注释）。
   * sourceContent 保留首次解析原文（编辑不触碰——版本语义：原始内容随时可
   * 经 sourceContent 找回，见 chunk.entity.ts 注释）。
   * 返回更新后的 chunk（不含 embedding：实体列 select:false，见 chunk.entity.ts）。
   */
  async updateContent(
    chunkId: string,
    content: string,
    editorId: string,
  ): Promise<Chunk> {
    const updated = await this.dataSource.transaction(async (manager) => {
      const chunk = await this.loadChunkInTx(manager, chunkId);
      const newRevision = chunk.contentRevision + 1;
      // 先更新块再追加版本记录：UPDATE 先行 + affected 校验（0 行 = 块已被
      // 并发删除 → 404，此时 revision 尚未插入，无孤儿行可回滚；见
      // updateChunkContent 注释）；revision 插入撞唯一索引（并发编辑）→ 409
      await this.updateChunkContent(manager, chunk, content, newRevision);
      await this.insertRevision(
        manager,
        chunk.id,
        content,
        newRevision,
        editorId,
      );
      return chunk;
    });
    // 事务提交后入队单块向量化（payload { chunkId }，见 enqueueSingleEmbed 注释）
    this.enqueueSingleEmbed(chunkId);
    return updated;
  }

  /**
   * 版本历史（Task 1.9）：按 revision 升序全量返回。
   * 决策：不分页——单块编辑频率低，版本历史通常 < 100 条（编辑 100 次才
   * 逼近阈值；真到那时再加分页不迟），全量返回省去客户端分页状态管理；
   * chunk 不存在 → 404（与编辑/回滚一致的资源语义）。
   */
  async listRevisions(chunkId: string): Promise<ChunkRevision[]> {
    await this.ensureChunkExists(chunkId);
    return this.revisionRepository.find({
      where: { chunkId },
      order: { revision: 'ASC' },
    });
  }

  /**
   * 回滚到指定版本（Task 1.9）：追加式——不修改既有历史，以目标版本的
   * content 生成一个新版本（revision = contentRevision+1），与 WeKnora 的
   * chunk_revision 设计一致（版本线完整可追溯，回滚本身也是一次可回滚的
   * 操作）。事务内：加载 chunk（404）→ 找目标版本（不存在 404）→ 追加
   * 新版本记录 → chunk.content 回滚 + contentRevision+1 + indexStatus=processing
   * → 入队单块向量化（同 updateContent）。sourceContent 同样保留原文。
   */
  async revert(
    chunkId: string,
    revision: number,
    editorId: string,
  ): Promise<Chunk> {
    const updated = await this.dataSource.transaction(async (manager) => {
      const chunk = await this.loadChunkInTx(manager, chunkId);
      const newRevision = chunk.contentRevision + 1;
      // 目标内容解析：revision=0 表示原始版本——目标内容 = chunk.sourceContent
      // （0 号原始不落库，无对应历史行，见 chunk-revision.entity.ts 注释；DTO
      // 已允许 0，见 revert-chunk.dto.ts）；>0 查历史表——DTO 已保证整数且在
      // 值域内（≥0），但历史中不存在（如超出当前最大版本）→ 404（读设计：
      // 目标版本不存在 = 资源不存在，与 chunk 不存在同语义；不用 400——400
      // 留给格式错误）
      let targetContent: string;
      if (revision === 0) {
        targetContent = chunk.sourceContent;
      } else {
        const target = await manager.findOne(ChunkRevision, {
          where: { chunkId: chunk.id, revision },
        });
        if (!target) {
          throw new NotFoundException('目标版本不存在');
        }
        targetContent = target.content;
      }
      // 追加式回滚：新记录内容 = 目标内容（历史不被修改）；先更新块（affected
      // 校验 → 并发删除 404）再插入版本记录（并发回滚/编辑撞 23505 → 409）
      await this.updateChunkContent(manager, chunk, targetContent, newRevision);
      await this.insertRevision(
        manager,
        chunk.id,
        targetContent,
        newRevision,
        editorId,
      );
      return chunk;
    });
    this.enqueueSingleEmbed(chunkId);
    return updated;
  }

  /**
   * 更新分块内容 + contentRevision + indexStatus=processing（updateContent/revert
   * 共用；编辑/回滚语义：内容变了旧向量失效，重新向量化；sourceContent 不动）。
   * 改用 UPDATE + affected 校验（质量审查整改）：原 save 在「load 后、save 前块
   * 被并发删除」（chunks 无外键、无行锁保护，见 chunk-revision.entity.ts 注释）
   * 时静默成功并返回陈旧实体；UPDATE affected=0 即行已不存在 → 404，事务回滚
   * 使本事务内已做的写入（含已插入的 revision）一并撤销，不产生孤儿版本行。
   * 实体字段就地更新后返回（响应体反映本次修改；updatedAt 手工对齐 DB 值——
   * TypeORM 的 update 不回流实体，仅影响返回的 JSON 中的时间戳，无逻辑依赖）。
   */
  private async updateChunkContent(
    manager: EntityManager,
    chunk: Chunk,
    content: string,
    newRevision: number,
  ): Promise<void> {
    const result = await manager.update(
      Chunk,
      { id: chunk.id },
      {
        content,
        keywords: segment(content), // 编辑后重分词（检索词随内容更新）
        keywordText: segment(content).join(' '),
        contentRevision: newRevision,
        indexStatus: 'processing',
      },
    );
    if (result.affected === 0) {
      throw new NotFoundException('分块不存在');
    }
    chunk.content = content;
    chunk.contentRevision = newRevision;
    chunk.indexStatus = 'processing';
    chunk.updatedAt = new Date();
  }

  /**
   * 追加版本记录（updateContent/revert 共用）：revision = contentRevision+1，
   * 内容 = 新版本内容（0 号原始不落库——初始状态由 chunk.content 表示，见
   * chunk-revision.entity.ts 注释）。
   * 并发编辑兜底（质量审查整改）：同 chunk 两个编辑/回滚并发时，两者都从
   * 相同 contentRevision 算得相同新 revision，后落库者撞 (chunkId, revision)
   * 复合唯一索引（PG driverError.code 23505）→ 409「分块正在被编辑，请重试」
   * ——事务回滚，前序 chunk 更新一并撤销（与 auth 的 M1 同模式，见
   * auth.service.ts register 注释：driverError.code 判定，避免 500 与数据库
   * 错误细节泄露）。
   */
  private async insertRevision(
    manager: EntityManager,
    chunkId: string,
    content: string,
    revision: number,
    editorId: string,
  ): Promise<void> {
    try {
      await manager.save(
        ChunkRevision,
        manager.create(ChunkRevision, { chunkId, content, revision, editorId }),
      );
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('分块正在被编辑，请重试');
      }
      throw err;
    }
  }

  /** 事务内加载分块：不存在/非 UUID（22P02）一律 404（沿用 ensureKnowledgeInKb 模式） */
  private async loadChunkInTx(
    manager: EntityManager,
    chunkId: string,
  ): Promise<Chunk> {
    try {
      const chunk = await manager.findOne(Chunk, { where: { id: chunkId } });
      if (!chunk) {
        throw new NotFoundException('分块不存在');
      }
      return chunk;
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('分块不存在');
      }
      throw err;
    }
  }

  /** chunk 存在性校验（列表前校验用）：不存在/非 UUID 一律 404 */
  private async ensureChunkExists(chunkId: string): Promise<void> {
    try {
      const chunk = await this.chunkRepository.findOne({
        where: { id: chunkId },
      });
      if (!chunk) {
        throw new NotFoundException('分块不存在');
      }
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('分块不存在');
      }
      throw err;
    }
  }

  /**
   * 入队单块向量化（Task 1.9 编辑/回滚）：payload { chunkId }——与 Task 1.6
   * 的 knowledgeId 批量载荷并存（EmbedProcessor 按载荷分支，见
   * embed.processor.ts）。决策（见任务书）：编辑场景块少，单块 job 精确处理
   * 该块——若复用批量路径需依赖「编辑后无其他 processing 块」的隐式前提
   * （批量 job 只处理 processing 块），显式 chunkId 载荷语义自明、不依赖外部
   * 状态。配置与既有入队一致（addQueueJob 单点：attempts=2 + 指数退避）；
   * 入队失败（Redis 抖动）不阻断编辑响应：块保持 processing，可经再次编辑/
   * P4.3 重试入口重新触发（与 ParseProcessor.enqueueEmbed 的容错语义一致）。
   */
  private enqueueSingleEmbed(chunkId: string): void {
    addQueueJob(this.embedQueue, EMBED_QUEUE, {
      chunkId,
    } satisfies EmbedJob).catch((err: unknown) => {
      this.logger.warn(`单块向量化任务入队失败: ${chunkId}`, err as Error);
    });
  }

  /** 删除某文档的全部分块（文档删除时调用；Task 1.7 reparse 亦可用） */
  async deleteByKnowledge(knowledgeId: string): Promise<void> {
    await this.chunkRepository.delete({ knowledgeId });
  }

  /** 事务内删除某文档的全部分块（KnowledgeService.remove 的事务化调用——
   * 与 knowledge 行删除原子化，防「解析中删除」竞态产生孤儿块，见
   * parse.processor.ts chunkKnowledge 注释） */
  async deleteByKnowledgeInTx(
    manager: EntityManager,
    knowledgeId: string,
  ): Promise<void> {
    await manager.delete(Chunk, { knowledgeId });
  }

  /** 删除某 KB 的全部分块（KB 级联删除时由 KnowledgeService.removeByKbInTx 调用） */
  async deleteByKbInTx(manager: EntityManager, kbId: string): Promise<void> {
    await manager.delete(Chunk, { kbId });
  }

  /** 文档存在性校验（kbId 限定防跨 KB）：不存在/非 UUID 一律 404 */
  private async ensureKnowledgeInKb(
    kbId: string,
    knowledgeId: string,
  ): Promise<void> {
    try {
      const count = await this.knowledgeRepository.count({
        where: { kbId, id: knowledgeId },
      });
      if (!count) {
        throw new NotFoundException('文档不存在');
      }
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('文档不存在');
      }
      throw err;
    }
  }
}

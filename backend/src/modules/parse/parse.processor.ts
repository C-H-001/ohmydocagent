// 解析队列处理器（Task 1.4 + Task 1.5 + Task 1.7）：消费 PARSE_QUEUE，载荷 { knowledgeId }。
// 流程：加载 knowledge（404 → 抛错 → BullMQ 重试）→ 写 status=parsing +
// parserStages extract running → ParserClient.parse → 保存 parsedText + error
// 清空（重试成功后不得残留上次失败原因）+ extract done → Task 1.5 分块：
// 读 KB chunkingConfig → ChunkingService.chunk → 事务内写 chunks 表（删旧插新，
// 预生成 uuid + pre/next 链表）+ status=ready + chunkCount + chunk 阶段记录 →
// 分块成功后入队向量化（EMBED，Task 1.6）与自动摘要（SUMMARY，Task 1.7，
// 有 parsedText 才入队——空文本无内容可总结，见 chunkKnowledge 注释）→
// 返回 { textLength }。空文本（图片占位返回 ''）→ 直接 ready + chunkCount=0。
// 失败：写 status=failed + error + 对应阶段（extract/chunk）failed → 抛错触发
// BullMQ 重试（重试次数 job 级 attempts=2 + 指数 backoff，在 KnowledgeService
// 入队时配置；重试耗尽后 job 进入 failed 状态，P4.3 任务仪表盘可查看/重新入队）。
// 注意：分块是纯本地确定性算法，失败是 bug 而非瞬时故障——不做专门重试
// （与解析失败的瞬时性不同）；job 级 attempts=2 仍会触发一次无意义的重复尝试
// 后进入 failed，最终状态一致（status=failed），注释说明差异。
// 并发：BullMQ worker 默认并发 1（@Processor 可配 concurrency）；连接独立——
// BullModule.forRoot 单独提供连接（不共享 RedisService 的 maxRetriesPerRequest=3
// 客户端，阻塞命令语义不同，见 redis.service.ts 注释）。
// TODO(P4.3): 任务队列仪表盘提供 pending 文档重试入口（入队失败遗留的
// pending 文档在此重入队；本任务不实现启动对账——见 Task 1.4 计划登记）。
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PARSER_CLIENT, type ParsedImage } from '../../parser/parser-client.interface.js';
import type {
  ParseInput,
  ParserClient,
} from '../../parser/parser-client.interface.js';
import { ChunkService } from '../chunk/chunk.service.js';
import { ChunkingService } from '../chunk/chunking.service.js';
import type { ChunkingConfig, ChunkUnit } from '../chunk/chunking.service.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Knowledge, KnowledgeImageMeta } from '../knowledge/knowledge.entity.js';
import { StorageService } from '../storage/storage.service.js';
import { KnowledgeProgressService } from '../knowledge/knowledge-progress.service.js';
import {
  PARSE_QUEUE,
  EMBED_QUEUE,
  SUMMARY_QUEUE,
  addQueueJob,
} from './parse-queue.constants.js';
import type {
  ParseJob,
  EmbedJob,
  SummaryJob,
} from './parse-queue.constants.js';
import { GRAPH_QUEUE } from '../graph/graph-queue.constants.js';
import type { GraphJob } from '../graph/graph-queue.constants.js';

@Processor(PARSE_QUEUE)
@Injectable()
export class ParseProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(ParseProcessor.name);

  constructor(
    @InjectRepository(Knowledge)
    private readonly repo: Repository<Knowledge>,
    @InjectRepository(KnowledgeBase)
    private readonly kbRepository: Repository<KnowledgeBase>,
    private readonly progress: KnowledgeProgressService,
    private readonly storage: StorageService,
    @Inject(PARSER_CLIENT) private readonly parser: ParserClient,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly chunking: ChunkingService,
    private readonly chunkService: ChunkService,
    // 向量化队列（Task 1.6）：分块落库成功后入队（见 enqueueEmbed 注释）。
    // 队列在本模块注册（ParseModule 的 BullModule.registerQueue），
    // EmbedProcessor 在本模块消费，与 PARSE_QUEUE 的注册/消费同模块内聚
    @InjectQueue(EMBED_QUEUE) private readonly embedQueue: Queue<EmbedJob>,
    // 自动摘要队列（Task 1.7）：分块落库成功后入队（见 enqueueSummary 注释）。
    // SUMMARY_QUEUE 由 SummaryQueueModule 单点注册，两侧（KnowledgeModule/
    // ParseModule）import 复用——本模块 import SummaryQueueModule 注入同一
    // 实例（KnowledgeService 的 regenerate-summary 亦然，见 summary-queue
    // .module.ts 注释）
    @InjectQueue(SUMMARY_QUEUE)
    private readonly summaryQueue: Queue<SummaryJob>,
    // 图谱抽取队列（Task 3.2）：分块落库成功后按 KB extractConfig 入队
    // （见 enqueueGraph 注释）。GRAPH_QUEUE 由 GraphQueueModule 单点注册，
    // 本模块 import GraphQueueModule 注入同一实例（消费侧 ExtractProcessor
    // 在 GraphModule，见 graph-queue.module.ts 注释）
    @InjectQueue(GRAPH_QUEUE) private readonly graphQueue: Queue<GraphJob>,
  ) {
    super();
  }

  // worker 事件监听（Task 1.4 质量整改）：BullMQ worker 在框架 onModuleInit 阶段
  // 创建（BullExplorer.handleProcessor 赋 instance._worker），WorkerHost.worker
  // getter 明确要求 onApplicationBootstrap 之后才能访问（见 @nestjs/bullmq
  // worker-host.class.js 的报错提示）——故在此挂 failed 监听。
  // 'failed' 事件每次失败尝试都会触发（含会被 backoff 重试的中间尝试）：
  // process() 内已 try/catch 写 status=failed 并抛错，这里兜底记录告警
  // （job id + knowledgeId + 已尝试次数 + 失败原因），供 P4.3 仪表盘排查。
  onApplicationBootstrap(): void {
    this.worker.on('failed', (job, err) => {
      // 注意：job 可能为 undefined（stalled 超限且被 removeOnFail 清理，
      // 见 bullmq worker.d.ts 'failed' 事件注释）——此时只剩错误可记
      if (!job) {
        this.logger.warn(`解析任务失败（job 已清理）: 原因=${err.message}`);
        return;
      }
      const data = job.data as ParseJob;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      this.logger.warn(
        `解析任务${exhausted ? '失败（重试耗尽）' : '失败（将按 backoff 重试）'}: ` +
          `job=${job.id} knowledgeId=${data.knowledgeId} ` +
          `已尝试=${job.attemptsMade} 原因=${err.message}`,
      );
    });
  }

  async process(job: Job<ParseJob>): Promise<{ textLength: number }> {
    const { knowledgeId } = job.data;
    // 加载 knowledge：不存在（已被删除/级联清理）→ 抛错 → BullMQ 按 attempts 重试
    // （重试仍失败则 job 进 failed，不无限重试）
    const knowledge = await this.repo.findOne({ where: { id: knowledgeId } });
    if (!knowledge) {
      throw new Error(`解析任务引用的文档不存在: ${knowledgeId}`);
    }
    await this.progress.markParsing(knowledgeId);
    // 失败阶段跟踪：extract（解析）→ chunk（分块）。用于错误落库时的阶段标记
    // （markFailed 的 stageName），保证 parserStages 时间线真实反映失败位置
    let phase: 'extract' | 'chunk' = 'extract';
    try {
      const input: ParseInput = {
        fileType: knowledge.fileType,
        filePath: knowledge.filePath || undefined,
        url: knowledge.sourceUrl || undefined,
        manualContent: knowledge.manualContent ?? undefined,
        // 解析引擎：文档级 parserEngine 优先（覆盖全局 PARSER_ENGINE——
        // 上传时可选；归一化见 normalizeParserEngine，仅 mineru）
        engine: (knowledge.parserEngine as 'mineru' | undefined) ??
          this.config.get('parserEngine'),
      };
      const parsed = await this.parser.parse(input);
      await this.progress.saveParsedText(knowledgeId, parsed.text);
      // 图片资产落盘（多模态）：content 存对象存储 + 登记 knowledge.images
      // （对齐 WeKnora ImageInfo/子块——描述已由 grpc-parser 注入 parsedText，
      // 此处负责持久化图片本体供前端预览/引用；失败仅记日志不阻断文档 ready）
      // 图片资产落盘返回的登记元数据（有 description 的图 → 图片 caption
      // chunk 参与分块/向量化，对齐 WeKnora ImageCaption 子块——见
      // chunkKnowledge 的 image units 拼接）
      let imageMetas: KnowledgeImageMeta[] = [];
      if (parsed.images?.length) {
        imageMetas = await this.persistImages(knowledge, parsed.images);
      }
      // ===== Task 1.5：分块闭环（extract 成功后） =====
      phase = 'chunk';
      await this.chunkKnowledge(knowledge, parsed.text, imageMetas);
      return { textLength: parsed.text.length };
    } catch (err) {
      // 失败：错误落库（error + 对应阶段 failed）后抛错触发重试。分块失败
      // （纯本地算法）与解析失败共用此路径——差异仅阶段标记，不做专门重试
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`解析失败: ${knowledgeId} - ${message}`);
      try {
        await this.progress.markFailed(knowledgeId, message, phase);
      } catch (markErr) {
        // 状态写回失败（如 DB 抖动）不能掩盖原始解析错误：记告警并继续抛原始错误
        // ——下游 retry/backoff 依据的是原始错误（queue 侧），落库失败仅丢诊断
        this.logger.warn(
          `解析失败状态写回失败: ${knowledgeId}`,
          markErr as Error,
        );
      }
      throw err;
    }
  }

  /**
   * 分块落库（Task 1.5）：读 KB chunkingConfig（容错：KB 被并发删除/配置非法
   * → ChunkingService.normalizeConfig 收敛默认，不抛错）→ 纯算法切块 →
   * 事务内写库 + 置 ready。
   * 事务边界：chunk 写入（删旧插新 + 链表）与最终状态更新（status=ready +
   * chunkCount + chunk done 阶段）在同一 dataSource.transaction——任一步失败
   * 整体回滚（不会出现「块已写但状态仍 parsing」的中间态）；分块失败时
   * 回滚后由 process() catch 统一 markFailed。
   * 删除竞态（质量修复）：事务首句先对 knowledge 行做 SELECT ... FOR UPDATE
   * 存在性复查——文档在解析期间被 KnowledgeService.remove 删除时：
   * - remove 先提交（行已删）→ 复查读不到行 → 抛错回滚，不插块（无孤儿）；
   * - 本事务先拿到行锁 → remove 的删行阻塞到本事务提交，随后在同一事务内
   *   删行 + 删块（见 KnowledgeService.remove 的事务化改造）——本事务已提交
   *   的块被一并清掉（无孤儿）。
   * 两种时序都收敛到无孤儿块：FOR UPDATE 行锁是两事务的仲裁点，串行化提交
   * 顺序。同理覆盖 KB 级联删除（removeByKbInTx 的行删除也在事务内）。
   * 空文本（图片占位返回 ''）：不分块，单条原子写置 ready + chunkCount=0
   * （Task 1.4 遗留语义落实——解析成功但无文本的文档不得停留在 parsing）。
   */
  /**
   * 图片资产落盘：逐张存对象存储（saveImage）→ knowledge.images 全量登记。
   * 幂等：reparse 同 assetKey 覆盖（saveImage 同路径写）；失败（单图/登记）
   * 仅告警——图片是增强信息，不影响文档 ready（与摘要同语义非关键路径）。
   */
  private async persistImages(
    knowledge: Knowledge,
    images: ParsedImage[],
  ): Promise<KnowledgeImageMeta[]> {
    const metas: KnowledgeImageMeta[] = [];
    for (const img of images) {
      try {
        const url = await this.storage.saveImage(
          knowledge.kbId,
          knowledge.id,
          img.assetKey,
          img.content,
          img.mimeType,
        );
        metas.push({
          assetKey: img.assetKey,
          page: img.page,
          mimeType: img.mimeType,
          url,
          description: img.description,
        });
      } catch (err) {
        this.logger.warn(
          `图片资产落盘失败: knowledgeId=${knowledge.id} asset=${img.assetKey} - ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    if (metas.length > 0) {
      try {
        await this.repo.update(knowledge.id, { images: metas });
      } catch (err) {
        this.logger.warn(
          `图片资产登记失败: knowledgeId=${knowledge.id}`,
          err as Error,
        );
      }
    }
    return metas;
  }

  private async chunkKnowledge(
    knowledge: Knowledge,
    parsedText: string,
    imageMetas: KnowledgeImageMeta[] = [],
  ): Promise<void> {
    const kb = await this.kbRepository.findOne({
      where: { id: knowledge.kbId },
    });
    // 文档级分块配置优先（覆盖 KB 级——用户需求「文档级别选择覆盖 KB 级」）；
    // 文档未设（null）→ 跟随 KB 配置；都缺省 → 默认配置
    const docCfg = knowledge.chunkingConfig as Partial<ChunkingConfig> | null | undefined;
    const units = this.chunking.chunk(
      parsedText,
      docCfg ?? (kb?.chunkingConfig as Partial<ChunkingConfig> | undefined),
    );
    // 图片 caption chunk（Task: 多模态对齐 WeKnora ImageCaption 子块）：有
    // VLM 描述的图片 → 独立块（content=描述，type=image，imageInfo 登记 url/
    // caption/page）——随文本块一起入向量/关键词索引，检索命中即为「带图引用」；
    // 无描述（parser 未配 VLM/识别失败）不建块（正文已含 mineru 图注，双保险）
    const imageUnits: ChunkUnit[] = imageMetas
      .filter((m) => m.description?.trim())
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
      .map((m) => ({
        content: m.description!.trim(),
        startAt: 0,
        endAt: 0,
        type: 'image' as const,
        assetKey: m.assetKey,
        imageInfo: {
          url: m.url,
          caption: m.description!.trim(),
          page: m.page,
          mimeType: m.mimeType,
          assetKey: m.assetKey,
        },
      }));
    units.push(...imageUnits);
    if (units.length === 0) {
      // 空文本：单条原子写（status=ready + chunkCount=0 + chunk done 阶段），
      // 无需事务（无 chunk 写入，不存在跨表原子性问题）。
      // 不入队 SUMMARY：无文本可总结（决策：有 parsedText 才入队，见文件头）；
      // 图片占位（''）与纯空白文本都收敛到此处，摘要无意义
      await this.progress.updateProgress(knowledge.id, {
        status: 'ready',
        chunkCount: 0,
        stage: {
          stage: 'chunk',
          status: 'done',
          detail: '空文本，跳过分块',
          at: new Date().toISOString(),
        },
      });
      return;
    }
    await this.dataSource.transaction(async (manager) => {
      // 删除竞态复查（见方法头注释）：文档在解析期间被删除 → 抛错回滚，
      // 不插块（无孤儿）。原生 SQL FOR UPDATE（行锁）：与 remove 的事务化
      // 行删除互斥，任一时序都收敛到无孤儿块。knowledge 表名/列名 id 全小写
      // （本项目未配置 snake_case 策略，camelCase 列需加引号——id 不受影响）
      const alive = await manager.query<Array<{ id: string }>>(
        'SELECT id FROM knowledge WHERE id = $1 FOR UPDATE',
        [knowledge.id],
      );
      if (alive.length === 0) {
        throw new Error(`文档在解析期间被删除，放弃分块: ${knowledge.id}`);
      }
      // 阶段记录 chunk running（与后续写入同一事务，失败整体回滚）
      await this.progress.updateProgress(
        knowledge.id,
        {
          status: 'parsing', // 显式保持 parsing（幂等，语义清晰）
          stage: {
            stage: 'chunk',
            status: 'running',
            at: new Date().toISOString(),
          },
        },
        manager,
      );
      // 删旧插新（reparse 语义基础）：旧块整体作废，链表/偏移全量重建
      await this.chunkService.replaceChunksInTx(manager, knowledge, units);
      // 分块完成：status=ready + chunkCount + chunk done 阶段（同事务）
      await this.progress.updateProgress(
        knowledge.id,
        {
          status: 'ready',
          chunkCount: units.length,
          stage: {
            stage: 'chunk',
            status: 'done',
            at: new Date().toISOString(),
          },
        },
        manager,
      );
    });
    // 分块落库成功后入队向量化（EMBED_QUEUE，Task 1.6）：按 knowledgeId 批量
    // （一个文档的全部块一次向量化，减少队列条目——逐块入队会让每块一个 job，
    // 大量块时队列膨胀且处理碎片化）。事务提交后才入队：保证入队时块已落库
    // （EmbedProcessor 按 knowledgeId 查块，事务未提交查不到）。
    // 文档 status=ready 与块向量化异步解耦：文档 ready ≠ 全部块已嵌入，检索只
    // 查 indexStatus='ready' 的块（见 VectorService.searchVector 注释）——
    // 此处不再阻塞等向量化完成，避免解析管线被向量化拖慢。
    this.enqueueEmbed(knowledge.id);
    // 分块成功后入队自动摘要（SUMMARY_QUEUE，Task 1.7）：此分支 units>0 →
    // parsedText 必然非空（决策：有 parsedText 才入队，见文件头注释）；
    // 与向量化并行异步，摘要缺失不影响文档 ready 可用（见 summary.processor.ts）
    this.enqueueSummary(knowledge.id);
    // 分块成功后按 KB extractConfig 入队图谱抽取（GRAPH_QUEUE，Task 3.2）：
    // 上传即建图的产品核心能力（extractConfig 缺省默认开启）；enabled=false
    // 不入队（消费侧 ExtractProcessor 双保险，见 extract.processor.ts 注释）
    this.enqueueGraph(knowledge.id, kb?.extractConfig);
  }

  /** 入队向量化任务：载荷只带 knowledgeId（块内容由 worker 从 DB 读取）。
   * job 级 attempts=2 + 指数退避（入队配置统一走 addQueueJob 单点，四处入队
   * 共用，见 parse-queue.constants.ts 注释）；入队失败（Redis 抖动）不阻断
   * 解析：块保持 processing，Task 1.9 提供向量化重试入口（TODO(P4.3) 任务
   * 仪表盘一并覆盖）
   *
   * 不用 jobId: knowledgeId 去重（评估记录，Task 1.6 质量整改）：BullMQ 的
   * 同 jobId 去重语义是「job key 存在即返回既有 job」（addStandardJob Lua 的
   * handleDuplicatedJob，任何状态都命中，含 completed/failed）——而 completed
   * job 的 key 在 removeOnComplete {count: 1000} 清理前一直存在；「同
   * knowledgeId 重新入队」是正常业务流（reparse 删旧插新后新块需重新向量化、
   * P4.3 手动重放），带 jobId 时新 embed job 会被旧 completed job 静默吞掉，
   * 新块永远停在 processing（比并发双 job 的重复 embed 更糟）。故不做 jobId
   * 去重：并发双 job 的重复 embed 由幂等语义兜底（worker 只处理 processing
   * 块、upsert 幂等、失败仅标本次读取集合，见 embed.processor.ts 注释）。 */
  private enqueueEmbed(knowledgeId: string): void {
    addQueueJob(this.embedQueue, EMBED_QUEUE, {
      knowledgeId,
    } satisfies EmbedJob).catch((err: unknown) => {
      this.logger.warn(`向量化任务入队失败: ${knowledgeId}`, err as Error);
    });
  }

  /** 入队摘要任务（Task 1.7）：载荷只带 knowledgeId（正文由 worker 从 DB 读取）。
   * job 级 attempts=2 + 指数退避（入队配置统一走 addQueueJob 单点，与
   * enqueueEmbed 同配置）——摘要失败重试一次，重试耗尽仅记日志（非关键路径，
   * 见 summary.processor.ts 文件头注释）。
   *
   * 不用 jobId: knowledgeId 去重：与 enqueueEmbed 的评估结论一致（见该方法
   * 注释）——BullMQ 同 jobId 去重会吞掉「同 knowledgeId 重新入队」的后续 job
   * （completed job 的 key 在清理前一直存在），而 regenerate-summary 正是
   * 「同 knowledgeId 重新入队」的正常业务流（Task 1.7）：带 jobId 时重生成
   * 会被初始自动摘要的 completed job 静默吞掉。并发双 job 的重复生成由
   * 幂等语义兜底（重新生成覆盖 summary + 追加阶段，最终状态一致）。 */
  private enqueueSummary(knowledgeId: string): void {
    addQueueJob(this.summaryQueue, SUMMARY_QUEUE, {
      knowledgeId,
    } satisfies SummaryJob).catch((err: unknown) => {
      this.logger.warn(`摘要任务入队失败: ${knowledgeId}`, err as Error);
    });
  }

  /** 入队图谱抽取任务（Task 3.2）：载荷只带 knowledgeId（知识/分块/开关由
   * worker 从 DB 读取，见 extract.processor.ts process()）。
   * KB 级开关：extractConfig.enabled=false → 不入队（KB 显式关闭图谱抽取）；
   * 缺省（undefined / {} / { enabled: true }）→ 默认开启——上传即建图的
   * 产品核心能力（e2e 契约：extractConfig 缺省 → 默认开启，见
   * graph-extraction.e2e-spec.ts）。job 级 attempts=2 + 指数退避（入队配置
   * 统一走 addQueueJob 单点，与 enqueueEmbed/enqueueSummary 同配置）——
   * 抽取失败重试一次，重试耗尽仅记日志（图谱缺失不影响文档可用，见
   * extract.processor.ts 文件头注释）。
   *
   * 不用 jobId: knowledgeId 去重：与 enqueueEmbed/enqueueSummary 的评估结论
   * 一致（见 enqueueEmbed 注释）——同 knowledgeId 重新入队（reparse）是正常
   * 业务流，jobId 去重会吞掉后续 job。并发双 job 的重复抽取由幂等语义兜底
   * （MERGE 实体/边 + deleteKnowledgeSubgraph 清理旧 chunk 关联，最终状态
   * 一致，见 extract.processor.ts 注释）。 */
  private enqueueGraph(
    knowledgeId: string,
    extractConfig?: Record<string, unknown>,
  ): void {
    const config = extractConfig as { enabled?: boolean } | undefined;
    if (config?.enabled === false) return;
    addQueueJob(this.graphQueue, GRAPH_QUEUE, {
      knowledgeId,
    } satisfies GraphJob).catch((err: unknown) => {
      this.logger.warn(`图谱抽取任务入队失败: ${knowledgeId}`, err as Error);
    });
  }
}

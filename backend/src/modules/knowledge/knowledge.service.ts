// 知识文档业务规则（Task 1.2）：
// - createFromFile：扩展名白名单（pdf/doc/docx/png/jpg/jpeg/webp/md/markdown/txt，
//   注意 doc 与 docx 都收；pdf/docx 解析在 Task 1.4 用 pdf-parse/mammoth，图片先收
//   占位返回空文本）→ 落盘 → 建行（type=file, status=pending）。不解析不入队——
//   解析入口是 Task 1.4 的扩展点（接入队列后此处仅置 pending）
// - URL 导入（type=url）已下线（占位符功能，见 git 历史）——存量文档保留展示
// - createManual：手动创建（title + content 落 manualContent，Task 1.5 分块消费）
// - list：分页 + 筛选（type/status 精确、keyword 对 title ILIKE），默认 createdAt DESC
// - getById/update/remove：按 kbId+id 双重限定（防跨 KB 访问），404 语义（含 22P02）
// - remove：先删行（成功后）再删磁盘文件——fs 与 DB 非原子，文件删除失败仅记日志不
//   阻断（孤儿文件可后续清理）；删行与删文件的顺序保证「行删成功才清理文件」，
//   反之若先删文件后删行失败会丢数据
// - Task 3.2：remove/batchDelete 事务提交后 best-effort 调 GraphRepository.
//   deleteKnowledgeSubgraph 清理图谱子图（剔除实体/边上的该文档 chunk 关联 + 删
//   chunk 镜像——已删文档不得残留反查入口；失败仅记日志，图谱清理非关键路径）
// - removeByKbInTx：KB 删除级联（KbService 事务内调用，EntityManager 参数避免
//   KbService 注入本服务的耦合——本服务也不依赖 KbService，模块依赖单向无环）；
//   Task 1.3 扩展为聚合清理：knowledge_tags 关联 + knowledge 文档 + knowledge_folders
//   文件夹 + tags 标签四类子表行；Task 1.5 再加 chunks 分块子表行
//   （ChunkService.deleteByKbInTx）
// - KB 存在性校验用 DataSource 直查 knowledge_bases，避免注入 KbService 造成循环依赖
// Task 1.3 新增（文件夹树 + 标签）：
// - createFolder/listFolders/renameFolder/moveFolder/deleteFolder：parentId 自引用树；
//   同级同名服务层查重（409）+ DB 部分唯一索引兜底并发（23505→409，见
//   folder.entity.ts 注释）；移动环检测（目标不能是自身/子孙，BFS 子树收集），
//   目标存在性复查在事务内（防并发删除产生孤儿节点）；删除决策 = 文档归根
//   （folderId=null）+ 级联删子树（不拒绝删除非空文件夹，前端交互顺）
// - createTag/listTags/updateTag/deleteTag/setKnowledgeTags：标签 CRUD + 批量打标/去标
//   （全量替换语义，幂等；事务内插新→删旧 + ON CONFLICT DO NOTHING 防并发 500，
//   跨 KB 标签 400 防护）；deleteTag 事务内先删关联再删标签行
// - list 扩展 tagIds（逗号分隔，并集语义）+ folderId 筛选
// Task 1.7 新增（状态/摘要/重新解析）：
// - getStages：解析时间线（parserStages 透传 + status/chunkCount/summary/updatedAt 摘要）
// - regenerateSummary：重新生成摘要（入队 SUMMARY，202；幂等重复调用）
// - reparse：重新解析（事务内删旧 chunks 含向量 → 重置产物 → pending → 入队
//   PARSE；行锁 + 状态判定防并发双跑，处理中返回 409，见 reparse 注释）
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DataSource,
  EntityManager,
  FindOneOptions,
  FindOptionsSelect,
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  Not,
  Raw,
  Repository,
} from 'typeorm';
import { paginate, Paginated } from '../../common/pagination.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Chunk } from '../chunk/chunk.entity.js';
import { ChunkService } from '../chunk/chunk.service.js';
import { GraphRepository } from '../graph/graph.repository.js';
import { PARSE_QUEUE, SUMMARY_QUEUE } from '../parse/parse-queue.constants.js';
import {
  addQueueJob,
  type ParseJob,
  type SummaryJob,
} from '../parse/parse-queue.constants.js';
import {
  UploadedFileLike,
  StorageService,
} from '../storage/storage.service.js';
import { CreateManualDto } from './dto/create-manual.dto.js';
import { CreateFolderDto } from './dto/create-folder.dto.js';
import { CreateTagDto } from './dto/create-tag.dto.js';
import { ListKnowledgeDto } from './dto/list-knowledge.dto.js';
import { MoveFolderDto } from './dto/move-folder.dto.js';
import { SetKnowledgeTagsDto } from './dto/set-knowledge-tags.dto.js';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto.js';
import { UpdateFolderDto } from './dto/update-folder.dto.js';
import { UpdateTagDto } from './dto/update-tag.dto.js';
import { KnowledgeFolder } from './folder.entity.js';
import { KnowledgeTag } from './knowledge-tag.entity.js';
import { Knowledge } from './knowledge.entity.js';
import { Tag } from './tag.entity.js';

/** 文件扩展名白名单（小写，无点）：pdf/docx 解析用 pdf-parse/mammoth（Task 1.4），
 * 图片 png/jpg/jpeg/webp 先收（Task 1.4 占位返回空文本），md/txt 直接可读 */
const ALLOWED_FILE_TYPES = new Set([
  'pdf',
  'doc',
  'docx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'md',
  'markdown',
  'txt',
]);

/** 上传大小上限（与控制器 FileInterceptor limits.fileSize 一致，超限由 multer 抛 413） */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * 列表投影字段：列表只返回轻量摘要字段——不含大字段（manualContent/summary/
 * parserStages，pageSize=100 的手动文档可序列化 ~10MB）、内部路径（filePath，
 * 防路径泄露）与内部诊断（error）。完整实体由详情接口 getById 返回。
 */
const LIST_SELECT: FindOptionsSelect<Knowledge> = {
  id: true,
  title: true,
  type: true,
  status: true,
  fileType: true,
  fileSize: true,
  sourceUrl: true,
  chunkCount: true,
  createdAt: true,
  updatedAt: true,
};

/** type 白名单（与 ListKnowledgeDto 的 IsIn 一致）：服务层兜底，防绕过 DTO 直接调
 * 服务时把非法枚举传给 PG enum 列撞 22P02 → 500（与 URL/文件大小校验的服务层兜底哲学一致） */
const LIST_TYPE_WHITELIST = ['file', 'url', 'manual'] as const;

/** status 白名单（同上）：非法值忽略而非透传，避免 500 */
const LIST_STATUS_WHITELIST = [
  'pending',
  'parsing',
  'ready',
  'failed',
] as const;

/**
 * 修复 multer/busboy 对非 ASCII 文件名的 latin1 误读：
 * busboy 解析 multipart 头时用 latin1Slice 读 filename（见 busboy multipart.js），
 * UTF-8 中文字节被逐个映射成 U+0080–U+00FF 字符；浏览器/表单库（form-data）发送的是
 * 原始 UTF-8 字节（非 RFC5987 filename*），因此反向转换可还原。启发式：仅当文件名
 * 全部字符都在 latin1 高位区（≤U+00FF）时可能是被误读的 UTF-8，才做转换——
 * 已含 U+0100+ 字符（说明发送方按正确编码传参）时不转换，避免双重编码损坏。
 * 加固：转换结果若含 U+FFFD（替换符），说明原串是真实 latin1 高位字符（如 é，
 * 其字节不是合法 UTF-8），转换只会损坏——保持原样返回。
 */
function decodeOriginalName(name: string): string {
  if (/[\u0080-\u00ff]/.test(name) && !/[\u0100-\uffff]/.test(name)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) {
      return decoded;
    }
  }
  return name;
}

/** 标题 = 原文件名去扩展名；空（如纯扩展名文件）兜底「未命名文档」 */
function titleFromFilename(originalname: string): string {
  const base = path.basename(originalname, path.extname(originalname)).trim();
  return base || '未命名文档';
}

/** 标签默认色（#RRGGBB，与前端原型默认一致） */
const DEFAULT_TAG_COLOR = '#3b82f6';

/** UUID 格式（tagIds 查询参数解析时丢弃非法 UUID 用，见 parseTagIds） */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 文件夹树节点：文件夹字段 + children 子树（叶子为 []） */
export interface FolderTreeNode extends KnowledgeFolder {
  children: FolderTreeNode[];
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectRepository(Knowledge)
    private readonly knowledgeRepository: Repository<Knowledge>,
    @InjectRepository(KnowledgeFolder)
    private readonly folderRepository: Repository<KnowledgeFolder>,
    @InjectRepository(Tag)
    private readonly tagRepository: Repository<Tag>,
    @InjectRepository(KnowledgeTag)
    private readonly knowledgeTagRepository: Repository<KnowledgeTag>,
    private readonly storage: StorageService,
    // KB 存在性校验直查 knowledge_bases 表（而非注入 KbService）：
    // 保持本服务不依赖 KbService，模块依赖方向单向无环（KbModule → KnowledgeModule）
    private readonly dataSource: DataSource,
    // 解析队列（Task 1.4）：三种创建方式建行后入队，worker 消费（见 ParseProcessor）。
    // 队列在本模块注册（BullModule.registerQueue），ParseModule 直接复用
    @InjectQueue(PARSE_QUEUE) private readonly parseQueue: Queue<ParseJob>,
    // 自动摘要队列（Task 1.7）：分块成功后由 ParseProcessor 入队；本服务在
    // regenerate-summary 时入队（重复调用幂等，见 enqueueSummary 注释）。
    // SUMMARY_QUEUE 由 SummaryQueueModule 单点注册，两侧（KnowledgeModule/
    // ParseModule）import 复用（本模块 import SummaryQueueModule，见
    // summary-queue.module.ts 注释）
    @InjectQueue(SUMMARY_QUEUE)
    private readonly summaryQueue: Queue<SummaryJob>,
    // 分块子表清理（Task 1.5）：文档删除/KB 级联时显式删 chunks 行
    // （chunks 无外键，服务层清理保证无残留，见 ChunkService 注释）
    private readonly chunkService: ChunkService,
    // 图谱子图清理（Task 3.2 质量审查整改）：文档删除后剔除实体/边上的
    // 该文档 chunk 关联并删 chunk 镜像（否则已删文档仍可反查，见 remove
    // 注释）。GraphModule 由本模块 forwardRef import（循环依赖说明见
    // knowledge.module.ts / graph.module.ts 文件头）
    private readonly graph: GraphRepository,
  ) {}

  /**
   * 创建后入队解析任务（Task 1.4）：job 载荷只带 knowledgeId，解析所需字段由
   * worker 从 DB 读取。job 级 attempts=2：解析失败自动重试一次（重试仍失败
   * 则 status=failed，见 ParseProcessor 注释）；backoff 指数退避（2s 起，每次
   * 翻倍）——错峰重试：瞬时故障（Redis/DB 抖动）下多个失败 job 同时重试会
   * 打爆依赖，退避让重试分散开。
   * 入队失败（Redis 抖动）不阻断创建：knowledge 保持 pending，可后续重新入队
   * （TODO(P4.3): 任务队列仪表盘提供 pending 文档重试入口——本任务不实现
   * 启动对账，e2e 每次启动 app 会误触发重扫，跨文件干扰风险）；这里仅记日志，
   * 避免创建接口 5xx。
   * 入队配置统一走 parse-queue.constants.ts 的 addQueueJob 单点（attempts/
   * backoff/清理策略四处入队共用，防 Task 2.x 配置漂移，见该文件注释） */
  private enqueueParse(knowledgeId: string): void {
    addQueueJob(this.parseQueue, PARSE_QUEUE, {
      knowledgeId,
    } satisfies ParseJob).catch((err: unknown) => {
      this.logger.warn(`解析任务入队失败: ${knowledgeId}`, err as Error);
    });
  }

  /** 入队摘要任务（Task 1.7）：regenerate-summary 复用（重新生成摘要）。
   * job 级 attempts=2 + 指数退避（入队配置统一走 addQueueJob 单点，见
   * parse-queue.constants.ts 注释）；入队失败（Redis 抖动）仅记日志不阻断
   * （摘要非关键路径，可再次重生成）。
   * 不用 jobId 去重：同 knowledgeId 重复入队是正常业务流（重生成摘要），
   * BullMQ 同 jobId 去重会吞掉后续 job（见 parse.processor.ts enqueueSummary
   * 注释的完整评估）——重复生成由幂等语义兜底（覆盖 summary + 追加阶段） */
  private enqueueSummary(knowledgeId: string): void {
    addQueueJob(this.summaryQueue, SUMMARY_QUEUE, {
      knowledgeId,
    } satisfies SummaryJob).catch((err: unknown) => {
      this.logger.warn(`摘要任务入队失败: ${knowledgeId}`, err as Error);
    });
  }

  /** KB 存在性校验：不存在/非 UUID 一律 404（创建类操作与列表的前置条件） */
  private async ensureKbExists(kbId: string): Promise<void> {
    try {
      const count = await this.dataSource
        .getRepository(KnowledgeBase)
        .count({ where: { id: kbId } });
      if (!count) {
        throw new NotFoundException('知识库不存在');
      }
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('知识库不存在');
      }
      throw err;
    }
  }

  /**
   * 文件上传创建（type=file）：
   * 白名单校验 → 落盘（文件名 knowledgeId.ext，见 StorageService 布局注释）→ 建行。
   * 文件先落盘、行后建：保证 filePath 恒有值；若建行失败（DB 异常）尽力删除已落盘文件
   * （fs 与 DB 非原子，仅尽力清理并记日志，孤儿文件可后续清理）。
   * 不解析不入队：status 落 pending，Task 1.4 接入解析队列后由队列驱动状态机。
   */
  async createFromFile(
    kbId: string,
    file: UploadedFileLike | undefined,
    _userId: string,
    chunkingConfigJson = '',
    parserEngine = '',
  ): Promise<Knowledge> {
    await this.ensureKbExists(kbId);
    if (!file || !file.buffer || !file.originalname) {
      throw new BadRequestException('缺少文件');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      // 双保险：控制器 FileInterceptor 的 limits.fileSize 已拦截（413），
      // 服务层再校验一次防绕过（如绕过 interceptor 直接调服务）
      throw new BadRequestException('文件大小超过 50MB 上限');
    }
    // 中文等非 ASCII 文件名修复（busboy latin1 误读，见 decodeOriginalName 注释）
    const originalname = decodeOriginalName(file.originalname);
    const ext = path.extname(originalname).slice(1).toLowerCase();
    if (!ext || !ALLOWED_FILE_TYPES.has(ext)) {
      throw new BadRequestException(`不支持的文件类型: ${ext || '未知'}`);
    }
    // 先落盘后建行（见方法头注释）；knowledgeId 由服务端生成，
    // 落盘文件名与其一致（{knowledgeId}.{ext}），天然防重名与路径穿越
    const knowledgeId = randomUUID();
    const relativePath = await this.storage.save(
      { originalname, buffer: file.buffer, size: file.size },
      kbId,
      knowledgeId,
    );
    try {
      const knowledge = this.knowledgeRepository.create({
        id: knowledgeId,
        kbId,
        title: titleFromFilename(originalname),
        type: 'file',
        filePath: relativePath,
        fileType: ext,
        fileSize: file.size,
        status: 'pending',
        // 文档级分块配置（multipart 文本字段；JSON 解析容错：非法/空 → null
        // 跟随 KB 配置）
        chunkingConfig: this.parseDocChunkingConfig(chunkingConfigJson),
        // 文档级解析引擎（multipart 文本字段；参考 WeKnora 引擎路由：
        // 复杂格式 pdf/docx 未指定时默认 mineru——版式还原更稳；简单
        // md/txt 未指定时跟随全局 PARSER_ENGINE）
        parserEngine: this.normalizeParserEngine(parserEngine, ext),
      });
      const saved = await this.knowledgeRepository.save(knowledge);
      // 建行成功后入队解析（失败仅记日志不阻断，见 enqueueParse 注释）
      this.enqueueParse(saved.id);
      return saved;
    } catch (err) {
      // 行建失败（DB 异常）时文件已落盘：尽力清理——先删文件，再 best-effort 删除
      // 父目录 {kbId}/{knowledgeId}/（removeEmptyDirectory 用 rmdir，仅空目录可删，
      // 不存在/非空/失败全部静默），孤儿文件/目录可后续清理
      await this.storage
        .remove(relativePath)
        .catch(() => this.logger.warn(`清理孤儿文件失败: ${relativePath}`));
      const parentDir = relativePath.split('/').slice(0, -1).join('/');
      await this.storage
        .removeEmptyDirectory(parentDir)
        .catch(() => this.logger.warn(`清理孤儿目录失败: ${parentDir}`));
      throw err;
    }
  }

  /** 手动创建（type=manual）：正文落 manualContent（Task 1.5 分块消费），status=pending */
  async createManual(
    kbId: string,
    dto: CreateManualDto,
    _userId: string,
  ): Promise<Knowledge> {
    await this.ensureKbExists(kbId);
    const knowledge = this.knowledgeRepository.create({
      kbId,
      title: dto.title,
      type: 'manual',
      manualContent: dto.content,
      status: 'pending',
    });
    const saved = await this.knowledgeRepository.save(knowledge);
    // 建行成功后入队解析（manualContent 直接作为解析结果）
    this.enqueueParse(saved.id);
    return saved;
  }

  /** 分页列表：type/status 精确匹配 + keyword 对 title ILIKE 模糊；默认 createdAt DESC。
   * 返回投影实体（LIST_SELECT）：不含 manualContent/filePath 等大字段与内部路径。
   * Task 1.3 新增筛选：folderId（精确，folder 必须属于该 KB 否则 404）与
   * tagIds（逗号分隔，并集语义，见 parseTagIds 注释） */
  async list(
    kbId: string,
    query: ListKnowledgeDto,
  ): Promise<Paginated<Knowledge>> {
    await this.ensureKbExists(kbId);
    const where: FindOptionsWhere<Knowledge> = { kbId };
    // 服务层白名单兜底（与 DTO 双层防护）：非法 type/status 忽略而非透传给 PG enum
    // 列（否则绕过 DTO 直接调服务会撞 22P02 → 500）；正常入口 DTO 已 400 拦截
    if (
      query.type &&
      (LIST_TYPE_WHITELIST as readonly string[]).includes(query.type)
    ) {
      where.type = query.type;
    }
    if (
      query.status &&
      (LIST_STATUS_WHITELIST as readonly string[]).includes(query.status)
    ) {
      where.status = query.status;
    }
    // ILike 参数化查询（无注入面）；% 通配符来自用户输入，命中面扩大是可接受的
    // 搜索语义（与常见搜索框行为一致），不做额外转义
    if (query.keyword) where.title = ILike(`%${query.keyword}%`);
    // 文件夹筛选：folder 必须属于该 KB（404 快速失败，与详情/更新语义一致）
    if (query.folderId) {
      await this.ensureFolderInKb(kbId, query.folderId);
      where.folderId = query.folderId;
    }
    // 标签筛选（Task 1.3）：解析逗号分隔 tagIds，并集语义见 parseTagIds 注释。
    // Raw 子查询（参数化，无注入面）：id IN (SELECT kt."knowledgeId" FROM
    // knowledge_tags kt WHERE kt."tagId" IN (:...tagIds))——In(QueryBuilder) 的 TS 类型
    // 不开放，Raw 等价且类型安全。注意：本项目未配置 snake_case 命名策略，列名即
    // 属性名（camelCase），且 PG 会把未加引号的标识符小写化，故原始 SQL 中必须加引号
    const tagIdList = this.parseTagIds(query.tagIds);
    if (tagIdList.length > 0) {
      where.id = Raw(
        (alias) =>
          `${alias} IN (SELECT kt."knowledgeId" FROM knowledge_tags kt WHERE kt."tagId" IN (:...tagIds))`,
        { tagIds: tagIdList },
      );
    }
    return paginate(this.knowledgeRepository, query.page, query.pageSize, {
      where,
      select: LIST_SELECT,
      order: { createdAt: 'DESC' },
    });
  }

  /** 解析 tagIds 查询参数：逗号分隔 + 去重 + 丢弃非法 UUID。
   * 并集语义决策：命中任一标签即返回（子查询 id IN (...)）。
   * 选择并集而非交集——前端标签筛选栏是「点选多个标签放宽范围」的心智模型
   * （与常见文档库一致）；交集需 GROUP BY + HAVING count，P1 无此需求
   * （未来可加参数切换）。宽容策略：非 UUID 片段直接丢弃——若透传给 PG
   * uuid IN 子查询会撞 22P02 → 500，丢弃后语义 = 该片段不参与筛选 */
  private parseTagIds(raw: string | undefined): string[] {
    if (!raw) return [];
    return [
      ...new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => UUID_RE.test(s)),
      ),
    ];
  }

  /** 详情：kbId+id 双重限定（防跨 KB 越权读取）；不存在/非 UUID 一律 404 */
  async getById(kbId: string, id: string): Promise<Knowledge> {
    try {
      const knowledge = await this.knowledgeRepository.findOne({
        where: { kbId, id },
      });
      if (!knowledge) {
        throw new NotFoundException('文档不存在');
      }
      return knowledge;
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

  /** 更新：标题重命名 + 文件夹归属（folderId，Task 1.3）；只更新传入字段 */
  async update(
    kbId: string,
    id: string,
    dto: UpdateKnowledgeDto,
  ): Promise<Knowledge> {
    const knowledge = await this.getById(kbId, id);
    if (dto.title !== undefined) knowledge.title = dto.title;
    // 文档移入/移出文件夹（Task 1.3）：folderId 必须是该 KB 的文件夹（404 防跨 KB），
    // null = 移回根（folderId 列 nullable）
    if (dto.folderId !== undefined) {
      if (dto.folderId !== null) {
        await this.ensureFolderInKb(kbId, dto.folderId);
      }
      knowledge.folderId = dto.folderId;
    }
    return this.knowledgeRepository.save(knowledge);
  }

  /**
   * 删除文档（事务化，Task 1.5 质量整改）：chunks 子表删除 + knowledge 行删除
   * 在同一事务（先删主表行、后删子表块，顺序原因见下），提交后再清理磁盘
   * 文件（fs 不可回滚，沿用「行删成功才清理文件」约定；文件删除失败仅记日志
   * 不阻断，孤儿文件可后续清理）。
   * 先删主表行的原因（与 ParseProcessor 分块事务的 SELECT FOR UPDATE 复查构成
   * 竞态仲裁，见 parse.processor.ts chunkKnowledge 注释）：解析期间删除文档时，
   * 本事务对 knowledge 行的 DELETE 行锁 = 仲裁点——分块事务若先拿到行锁并提交
   * 了块，本事务随后删行 + 删块（可看到其已提交的块）→ 无孤儿；分块事务的
   * 复查若发生在本事务提交后 → 读到行已删 → 抛错回滚 → 不插块。若仍按旧序
   * （先删块后删行），分块事务可在删块之后、删行之前提交新块 → 块残留成
   * 孤儿（正是本修复要堵的竞态）。
   */
  async remove(kbId: string, id: string): Promise<void> {
    const knowledge = await this.getById(kbId, id); // 404 语义 + kbId 限定
    await this.dataSource.transaction(async (manager) => {
      // 行删除在前（行锁仲裁点，见方法头注释）；chunks 无外键，删行后删块
      await manager.delete(Knowledge, { id });
      await this.chunkService.deleteByKnowledgeInTx(manager, id);
    });
    if (knowledge.filePath) {
      await this.storage.remove(knowledge.filePath);
    }
    // 图谱子图清理（Task 3.2 质量审查整改）：删除文档后实体/边的 chunkIds
    // 与 chunk 镜像仍指向已删文档（反查残留，已删文档仍可被实体详情检索到）
    // ——事务提交后 best-effort 调 GraphRepository.deleteKnowledgeSubgraph
    // 剔除该文档的 chunk 关联并删镜像（实体/边保留——图谱是跨文档聚合结构，
    // 见 graph.repository.ts deleteKnowledgeSubgraph 注释）。失败仅记日志不
    // 阻断：图谱清理非关键路径（与磁盘文件清理同一约定；残留可由 KB 删除
    // 时的 deleteKbSubgraph 兜底清空）
    await this.graph.deleteKnowledgeSubgraph(kbId, id).catch((err: unknown) => {
      this.logger.warn(`文档删除后图谱子图清理失败: ${id}`, err as Error);
    });
  }

  /**
   * KB 删除级联聚合（供 KbService 在事务内调用）：删除该 KB 的全部子表数据——
   * knowledge 文档行、chunks 分块（Task 1.5；行删除先于块删除，与 remove 同一
   * 竞态仲裁语义，见 remove 注释）、knowledge_tags 关联行（先按文档 id 收集，
   * 关联行依赖 knowledge/tags 的 id）、knowledge_folders 文件夹、tags 标签。
   * EntityManager 参数——KbService 复用同一事务（与 pins/KB 行删除原子化），
   * 且本服务不注入 KbService，模块依赖方向单向无环。
   * 磁盘目录清理不在事务内（fs 不可回滚），由 KbService 事务提交后调用
   * StorageService.removeKbDirectory 完成（见 KbService.remove 注释）。
   */
  async removeByKbInTx(manager: EntityManager, kbId: string): Promise<void> {
    // 文档 id 先收集（knowledge_tags 关联行依赖其 id，需在删行前读取）
    const knowledgeIds = (
      await manager.find(Knowledge, { where: { kbId }, select: { id: true } })
    ).map((k) => k.id);
    // 行删除先于 chunks 删除（与 remove 同一竞态仲裁语义，见 remove 注释：
    // 分块事务的 SELECT FOR UPDATE 复查与行删除互斥，任一时序无孤儿块；
    // 若先删 chunks，分块事务可在其间提交新块 → 孤儿残留）
    await manager.delete(Knowledge, { kbId });
    // chunks 引用 knowledge 的 id：清分块（无文档 KB 也幂等执行，防御残留）
    await this.chunkService.deleteByKbInTx(manager, kbId);
    if (knowledgeIds.length > 0) {
      await manager.delete(KnowledgeTag, { knowledgeId: In(knowledgeIds) });
    }
    await manager.delete(KnowledgeFolder, { kbId });
    await manager.delete(Tag, { kbId });
  }

  // ==================== 文件夹（Task 1.3） ====================

  /** 新建文件夹：KB 存在性 → 父级存在性（404）→ 同级同名查重（409）→ 建行。
   * DB 部分唯一索引兜底并发（见 folder.entity.ts 注释）：并发创建同名文件夹时
   * 服务层查重可能双双通过，后提交者撞唯一索引 → 23505 → 捕获转 409 */
  async createFolder(
    kbId: string,
    dto: CreateFolderDto,
  ): Promise<KnowledgeFolder> {
    await this.ensureKbExists(kbId);
    const parentId = dto.parentId ?? null;
    if (parentId) await this.ensureFolderInKb(kbId, parentId);
    await this.ensureFolderNameUnique(kbId, parentId, dto.name);
    const folder = this.folderRepository.create({
      kbId,
      parentId,
      name: dto.name,
    });
    try {
      return await this.folderRepository.save(folder);
    } catch (err) {
      // 并发竞态：两请求同时通过服务层查重，后提交者撞部分唯一索引 → 23505。
      // 与 tags 的 23505 兜底同一模式（见 createTag）——正常入口不会触发
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('同级已存在同名文件夹');
      }
      throw err;
    }
  }

  /** 文件夹树：一次查全量 → 内存组装 children 嵌套。
   * 规模考量：P1 单 KB 文件夹量级小（几十~几百），一次查全量 + 内存组装最简
   * （逐层 N+1 查询方案明显更差）；若未来量级上来（万级），改递归 CTE 在 DB 层组装 */
  async listFolders(kbId: string): Promise<FolderTreeNode[]> {
    await this.ensureKbExists(kbId);
    const all = await this.folderRepository.find({
      where: { kbId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    // 邻接表：parentId → 子节点（null=根级）
    const byParent = new Map<string | null, FolderTreeNode[]>();
    for (const f of all) {
      const node: FolderTreeNode = { ...f, children: [] };
      const list = byParent.get(f.parentId) ?? [];
      list.push(node);
      byParent.set(f.parentId, list);
    }
    const build = (parentId: string | null): FolderTreeNode[] =>
      (byParent.get(parentId) ?? []).map((node) => ({
        ...node,
        children: build(node.id),
      }));
    return build(null);
  }

  /** 重命名：同级同名查重（409，排除自身）后更新 */
  async renameFolder(
    kbId: string,
    folderId: string,
    dto: UpdateFolderDto,
  ): Promise<KnowledgeFolder> {
    const folder = await this.ensureFolderInKb(kbId, folderId);
    await this.ensureFolderNameUnique(
      kbId,
      folder.parentId,
      dto.name,
      folderId,
    );
    folder.name = dto.name;
    return this.folderRepository.save(folder);
  }

  /** 移动文件夹：目标父级存在性（404）→ 环检测（400）→ 新父级同名查重（409）。
   * 环检测算法：BFS 收集以 folderId 为根的整棵子树 id（含自身，见
   * collectFolderSubtreeIds）；目标父级落在子树内即会成环 → 400。
   * 事务内执行（环检测读取的树状态与 update 原子化，防并发移动竞态）。
   * 目标父级存在性复查也在事务内（与环检测同一事务快照，见方法体注释）。
   * 移到相同父级 = no-op（幂等，直接返回原实体）。 */
  async moveFolder(
    kbId: string,
    folderId: string,
    dto: MoveFolderDto,
  ): Promise<KnowledgeFolder> {
    const folder = await this.ensureFolderInKb(kbId, folderId);
    // 决策：null 与缺省都表示移回根（前端拖拽到根区域可能只发空对象）
    const newParentId = dto.parentId ?? null;
    if (newParentId === folder.parentId) return folder; // 幂等 no-op
    return this.dataSource.transaction(async (manager) => {
      // 目标父级存在性复查（事务内）：事务外的 ensureFolderInKb 读到的是旧快照，
      // 目标被并发删除时事务内 update 会把 parentId 指向已删行（孤儿节点）——
      // 复查与环检测/update 用同一事务快照原子化：目标已消失 → 404。
      // 并发语义：本事务先提交则删除方事务内复查（见 deleteFolder）读不到本行
      // → 404；删除方先提交则本事务复查 404——任一时序都不会产生孤儿节点。
      if (newParentId) {
        await this.ensureFolderInKbWith(
          (opts) => manager.findOne(KnowledgeFolder, opts),
          kbId,
          newParentId,
        );
      }
      const subtree = await this.collectFolderSubtreeIds(
        manager,
        kbId,
        folderId,
      );
      // 移动到根（newParentId=null）恒合法，无环；仅非空目标需要环检测
      if (newParentId && subtree.has(newParentId)) {
        throw new BadRequestException('不能移动到自身或其子文件夹下');
      }
      const dup = await manager.findOne(KnowledgeFolder, {
        where: {
          kbId,
          name: folder.name,
          parentId: newParentId ?? IsNull(),
        },
      });
      if (dup && dup.id !== folderId) {
        throw new ConflictException('同级下已存在同名文件夹');
      }
      await manager.update(
        KnowledgeFolder,
        { kbId, id: folderId },
        { parentId: newParentId },
      );
      const saved = await manager.findOne(KnowledgeFolder, {
        where: { kbId, id: folderId },
      });
      return saved!;
    });
  }

  /** 删除文件夹（决策：文档归根 + 级联删子树，不拒绝删除非空文件夹——
   * 前端交互更顺：拖到删除直接删，文件夹内文档不丢，归到根后仍可见；
   * 子文件夹一并删除（无孤儿树节点），子树内文档同样归根。事务保证
   * 「文档归根 + 删文件夹」原子化） */
  async deleteFolder(kbId: string, folderId: string): Promise<void> {
    // 事务外快速失败（404 语义，正常入口 folderId 存在时无需进事务）
    await this.ensureFolderInKb(kbId, folderId);
    await this.dataSource.transaction(async (manager) => {
      // 事务内复查存在性（与 moveFolder 的目标复查同模式）：事务外的 ensure
      // 读到的是旧快照，并发删除竞态下 update/delete 会静默 affected=0——
      // 复查保证「删不存在的文件夹 → 404」而非假装成功，且与 moveFolder
      // 形成互斥（见 moveFolder 注释的并发语义）
      await this.ensureFolderInKbWith(
        (opts) => manager.findOne(KnowledgeFolder, opts),
        kbId,
        folderId,
      );
      const subtree = await this.collectFolderSubtreeIds(
        manager,
        kbId,
        folderId,
      );
      const ids = [...subtree];
      // 子树内文档全部归根（folderId=null）
      await manager.update(
        Knowledge,
        { kbId, folderId: In(ids) },
        { folderId: null },
      );
      // 删除文件夹行（含子树）
      await manager.delete(KnowledgeFolder, { kbId, id: In(ids) });
    });
  }

  /** 文件夹存在性校验底层实现（Repository 或事务 EntityManager 共用）：
   * findOne 由调用方注入——事务内复查时传入 manager 的查询，保证读取与
   * 事务内其它操作同一快照（并发语义见 moveFolder/deleteFolder 注释）。
   * 不存在/非 UUID 一律 404 */
  private async ensureFolderInKbWith(
    findOne: (
      options: FindOneOptions<KnowledgeFolder>,
    ) => Promise<KnowledgeFolder | null>,
    kbId: string,
    folderId: string,
  ): Promise<KnowledgeFolder> {
    try {
      const folder = await findOne({ where: { kbId, id: folderId } });
      if (!folder) {
        throw new NotFoundException('文件夹不存在');
      }
      return folder;
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('文件夹不存在');
      }
      throw err;
    }
  }

  /** 文件夹存在性校验（kbId 限定防跨 KB）：不存在/非 UUID 一律 404 */
  private ensureFolderInKb(
    kbId: string,
    folderId: string,
  ): Promise<KnowledgeFolder> {
    return this.ensureFolderInKbWith(
      (options) => this.folderRepository.findOne(options),
      kbId,
      folderId,
    );
  }

  /** 同级同名查重（服务层，409 友好错误）：PG 唯一索引对 NULL 不冲突（根级
   * parentId=null 同名漏网），故 DB 用两个部分唯一索引兜底并发（见
   * folder.entity.ts 注释）：正常入口服务层查重先拦截，并发竞态由 23505
   * 捕获兜底（见 createFolder）。excludeId 用于重命名/移动时排除自身 */
  private async ensureFolderNameUnique(
    kbId: string,
    parentId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const where: FindOptionsWhere<KnowledgeFolder> = {
      kbId,
      name,
      parentId: parentId ?? IsNull(),
    };
    if (excludeId) where.id = Not(excludeId);
    const dup = await this.folderRepository.findOne({ where });
    if (dup) {
      throw new ConflictException('同级下已存在同名文件夹');
    }
  }

  /** 收集以 folderId 为根的整棵子树 id（含自身）：一次查全量 KB 文件夹，
   * 内存建 parent→children 邻接表后 BFS。环检测与级联删除共用此算法。
   * 规模考量同 listFolders（P1 量级小；量级上来改递归 CTE） */
  private async collectFolderSubtreeIds(
    manager: EntityManager,
    kbId: string,
    folderId: string,
  ): Promise<Set<string>> {
    const all = await manager.find(KnowledgeFolder, {
      where: { kbId },
      select: { id: true, parentId: true },
    });
    const childrenByParent = new Map<string, string[]>();
    for (const f of all) {
      if (f.parentId) {
        const list = childrenByParent.get(f.parentId) ?? [];
        list.push(f.id);
        childrenByParent.set(f.parentId, list);
      }
    }
    const subtree = new Set<string>();
    const queue = [folderId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      queue.push(...(childrenByParent.get(id) ?? []));
    }
    return subtree;
  }

  // ==================== 标签（Task 1.3） ====================

  /** 创建标签：KB 存在性 → 重名查重（409，DB 唯一索引兜底）→ 建行 */
  async createTag(kbId: string, dto: CreateTagDto): Promise<Tag> {
    await this.ensureKbExists(kbId);
    await this.ensureTagNameUnique(kbId, dto.name);
    const tag = this.tagRepository.create({
      kbId,
      name: dto.name,
      color: dto.color ?? DEFAULT_TAG_COLOR,
    });
    return this.tagRepository.save(tag);
  }

  /** 标签列表：按创建顺序返回（前端标签栏渲染顺序稳定可预期） */
  async listTags(kbId: string): Promise<Tag[]> {
    await this.ensureKbExists(kbId);
    return this.tagRepository.find({
      where: { kbId },
      order: { createdAt: 'ASC' },
    });
  }

  /** 更新标签：重名查重（409，排除自身）+ 颜色更新；只更新传入字段 */
  async updateTag(
    kbId: string,
    tagId: string,
    dto: UpdateTagDto,
  ): Promise<Tag> {
    const tag = await this.ensureTagInKb(kbId, tagId);
    if (dto.name !== undefined) {
      if (dto.name !== tag.name) {
        await this.ensureTagNameUnique(kbId, dto.name, tagId);
      }
      tag.name = dto.name;
    }
    if (dto.color !== undefined) tag.color = dto.color;
    return this.tagRepository.save(tag);
  }

  /** 删除标签（事务）：先清关联行再删标签行，保证无孤儿关联 */
  async deleteTag(kbId: string, tagId: string): Promise<void> {
    const tag = await this.ensureTagInKb(kbId, tagId);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(KnowledgeTag, { tagId });
      await manager.delete(Tag, { kbId, id: tag.id });
    });
  }

  /** 批量打标/去标（全量替换语义，幂等）：文档存在性（404）→ 校验全部标签
   * 属于该 KB（400 防跨 KB 打标）→ 事务内插新→删旧（并发安全，见方法体注释）。
   * 返回文档当前标签列表（前端打标后可直接渲染最新状态）。空数组 = 清除全部标签。 */
  async setKnowledgeTags(
    kbId: string,
    knowledgeId: string,
    dto: SetKnowledgeTagsDto,
  ): Promise<Tag[]> {
    await this.getById(kbId, knowledgeId); // 404 语义（文档存在性 + kbId 限定）
    const tagIds = [...new Set(dto.tagIds)]; // 去重：重复 id 只关联一次（幂等）
    await this.ensureTagsInKb(kbId, tagIds); // 400 防跨 KB 打标（严格）
    await this.applyKnowledgeTags(knowledgeId, tagIds);
    // 返回文档当前标签（最新状态）
    const rows = await this.knowledgeTagRepository.find({
      where: { knowledgeId },
    });
    if (rows.length === 0) return [];
    return this.tagRepository.find({
      where: { kbId, id: In(rows.map((r) => r.tagId)) },
      order: { createdAt: 'ASC' },
    });
  }

  /** 标签存在性校验（kbId 限定防跨 KB）：不存在/非 UUID 一律 404 */
  private async ensureTagInKb(kbId: string, tagId: string): Promise<Tag> {
    try {
      const tag = await this.tagRepository.findOne({
        where: { kbId, id: tagId },
      });
      if (!tag) {
        throw new NotFoundException('标签不存在');
      }
      return tag;
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('标签不存在');
      }
      throw err;
    }
  }

  /** 知识库内重名查重（409）：服务层先查（友好错误消息），
   * DB (kbId, name) 唯一索引兜底并发（正常入口不会触发） */
  private async ensureTagNameUnique(
    kbId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const where: FindOptionsWhere<Tag> = { kbId, name };
    if (excludeId) where.id = Not(excludeId);
    const dup = await this.tagRepository.findOne({ where });
    if (dup) {
      throw new ConflictException('知识库内已存在同名标签');
    }
  }

  /** 标签属于该 KB 校验（setKnowledgeTags/batchSetTags 共用）：任一标签不属于
   * 该 KB → 400（防跨 KB 打标）。调用方需先对 tagIds 去重——find 返回唯一行，
   * 重复 id 会误判「数量不符」 */
  private async ensureTagsInKb(kbId: string, tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const tags = await this.tagRepository.find({
      where: { kbId, id: In(tagIds) },
    });
    if (tags.length !== tagIds.length) {
      throw new BadRequestException('存在不属于该知识库的标签');
    }
  }

  /**
   * 单文档标签全量替换事务体（setKnowledgeTags/batchSetTags 共用）：
   * 「插新→删旧」顺序 + ON CONFLICT DO NOTHING（并发全量替换竞态修复，重要）：
   * 旧实现「删旧→插新」在同文档并发 PUT tags 时两个事务都先 DELETE 再 INSERT，
   * 后提交者的 INSERT 撞 (knowledgeId, tagId) 唯一索引 → 23505 → PG 语句失败
   * abort 整个事务（事务内捕获后 COMMIT 会撞 25P02，无法吞掉继续）→ 500。
   * 插新→删旧 + orIgnore 后：
   * - INSERT 撞唯一索引的行被 ON CONFLICT DO NOTHING 跳过（已存在即无需再插，
   *   不报错）；对未提交冲突行 PG 会等对方提交/回滚再判定——后提交者的集合
   *   完整胜出（后写者决定最终状态）；
   * - 事务内 find 读「自身已插 + 已提交」的行，DELETE 只清「新集合之外的旧行」
   *   ——先提交者的多余行会被后提交者清掉，任意并发时序结果一致且无孤儿行。
   * 23505 兜底（orIgnore 已覆盖插入冲突，此分支理论不可达；保留防未来改动——
   * 如换成普通 INSERT 或新增约束时不把并发竞态暴露成 500）：撞唯一索引说明
   * 目标关联行已存在（对方已提交），幂等视为成功，最终状态以随后读取为准。
   * 注意：PG 语句失败会 abort 事务，此捕获必须在事务外（回调内吞掉后 COMMIT
   * 会撞 25P02）
   */
  private async applyKnowledgeTags(
    knowledgeId: string,
    tagIds: string[],
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        if (tagIds.length > 0) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(KnowledgeTag)
            .values(tagIds.map((tagId) => ({ knowledgeId, tagId })))
            .orIgnore()
            .execute();
        }
        const keep = new Set(tagIds);
        const existing = await manager.find(KnowledgeTag, {
          where: { knowledgeId },
          select: { tagId: true },
        });
        const toRemove = existing
          .map((r) => r.tagId)
          .filter((tagId) => !keep.has(tagId));
        if (toRemove.length > 0) {
          await manager.delete(KnowledgeTag, {
            knowledgeId,
            tagId: In(toRemove),
          });
        }
      });
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code !==
        '23505'
      ) {
        throw err;
      }
    }
  }

  // ==================== 批量操作（Task 1.8） ====================

  /**
   * 批量删除（Task 1.8）：kbId 限定删除（WHERE kbId AND id IN），事务内先删
   * knowledge 行再删 chunks（与 remove 同一竞态仲裁语义，见 remove 注释），
   * 事务外清理磁盘文件（fs 不可回滚，沿用「行删成功才清理文件」约定——
   * StorageService.remove 内部吞错记日志，见该文件注释）。
   * 批量语义决策（宽容）：不属于该 KB 的 id 自然不命中删除（跳过），返回实际
   * 删除数——前端多选同页文档不会跨 KB，单条误选不应让整批失败；KB 不存在
   * → 404（快速失败，与单条接口一致）。
   * 性能与计数（质量审查整改）：旧实现循环逐条 delete（上限 100 → 2N 条
   * round-trip），改为两条 set-based DELETE——Knowledge 一条 + Chunk 一条，
   * 条件均含 kbId 双限定（Chunk 表有 kbId 列，防跨 KB 误删），删除顺序保持
   * 先行后块（与 remove 同一竞态仲裁语义）。deleted 以事务内实际 affected
   * 为准（Postgres DELETE 的 affected = 实际删除行数——并发抢先删除时不会像
   * 旧实现那样用事务前快照计数导致虚高）；affected 为 null（其它驱动）时
   * 回退快照计数（计数仅供参考，事务内删除才是权威）。
   * filePath 磁盘清理：set-based 删除后拿不到 filePath 列表，故在事务前 SELECT
   * filePath 快照（与旧实现等价，仅用于事务后清理；孤儿文件 remove 吞错幂等
   * 无害）。
   * 返回 { deleted }（实际删除的文档数）。
   */
  async batchDelete(kbId: string, ids: string[]): Promise<{ deleted: number }> {
    await this.ensureKbExists(kbId);
    const uniqueIds = [...new Set(ids)]; // 去重：重复 id 只删一次（计数真实）
    // 事务前收集 filePath 快照（供事务后磁盘清理，见方法头注释）——
    // 跨 KB id 不命中即跳过
    const doomed = await this.knowledgeRepository.find({
      where: { kbId, id: In(uniqueIds) },
      select: { id: true, filePath: true },
    });
    if (doomed.length === 0) return { deleted: 0 };
    const deleted = await this.dataSource.transaction(async (manager) => {
      // set-based：两条语句替代 2N 条 round-trip；行删除在前（行锁仲裁点，
      // 见 remove 注释）；chunks 无外键，删行后删块（kbId + knowledgeId
      // 双限定——防跨 KB 误删）
      const docResult = await manager.delete(Knowledge, {
        kbId,
        id: In(uniqueIds),
      });
      await manager.delete(Chunk, {
        knowledgeId: In(uniqueIds),
        kbId,
      });
      // Postgres DELETE 的 affected = 实际删除行数（实测确认）；null（其它
      // 驱动）时回退快照计数（计数仅供参考，事务内删除才是权威）
      return docResult.affected ?? doomed.length;
    });
    // 事务提交后清理磁盘文件 + 图谱子图（与 remove 同一约定；失败仅记日志不阻断）
    for (const doc of doomed) {
      if (doc.filePath) {
        await this.storage.remove(doc.filePath);
      }
      // 图谱子图清理（Task 3.2 质量审查整改，与 remove 同语义）：批量删除的
      // 文档同样剔除实体/边 chunk 关联 + 删 chunk 镜像（失败仅记日志）
      await this.graph
        .deleteKnowledgeSubgraph(kbId, doc.id)
        .catch((err: unknown) => {
          this.logger.warn(
            `批量删除后图谱子图清理失败: ${doc.id}`,
            err as Error,
          );
        });
    }
    return { deleted };
  }

  /**
   * 批量重新解析（Task 1.8）：逐条复用 prepareReparse（行锁 + 状态判定，与单条
   * reparse 同一防重机制），成功后入队 PARSE（入队在事务提交后，见 prepareReparse）。
   * 批量语义决策（宽容）：
   * - 处理中（pending/parsing）的文档 → 跳过计入 skipped，不 409——批量场景下
   *   同批内文档可能正处于解析中（如刚创建未完成），单条 409 会让整批失败，
   *   跳过并返回计数让前端按需提示「N 个文档正在处理中」；
   * - 不属于该 KB 的 id → 跳过计入 skipped（前端多选同页文档不会跨 KB，宽容）；
   * - 单条重置/入队阶段抛错 → 计入 failed 继续处理其余条（部分失败语义：
   *   逐条独立事务，前 k-1 条已应用不因第 k 条失败而回滚，也不整批 500——
   *   前端可重试，操作幂等）；
   * - KB 不存在 → 404（快速失败，与单条接口一致）。
   * 返回 { queued, skipped, failed }：queued = 已重置并入队的文档数（已重置
   * 为确定事实，队列投递 best-effort——入队失败仅记日志不阻断，与单条 reparse
   * 一致，见 enqueueParse 注释）；skipped = 处理中/跨 KB 的文档数；
   * failed = 重置/入队阶段抛错的条数（仅计数不记 detail，错误原因见服务日志）。
   */
  async batchReparse(
    kbId: string,
    ids: string[],
  ): Promise<{ queued: number; skipped: number; failed: number }> {
    await this.ensureKbExists(kbId);
    let queued = 0;
    let skipped = 0;
    let failed = 0;
    // 直接迭代 Set（去重）而非 [...new Set(ids)]——for..of 可迭代 Set，免多余数组
    for (const id of new Set(ids)) {
      try {
        const result = await this.prepareReparse(kbId, id);
        if (result === 'queued') {
          this.enqueueParse(id);
          queued++;
        } else {
          skipped++;
        }
      } catch (err) {
        // 逐条捕获（部分失败语义）：单条重置事务抛错不阻断整批——记日志 +
        // 计入 failed，前端可重试（操作幂等：重复 reparse 语义一致，见 reparse 注释）
        failed++;
        this.logger.warn(
          `批量重新解析失败（已跳过，可重试）: knowledgeId=${id}`,
          err as Error,
        );
      }
    }
    return { queued, skipped, failed };
  }

  /**
   * 批量打标/去标（Task 1.8）：tagIds 空数组 = 批量去标（全量替换语义与单条
   * setKnowledgeTags 一致）；逐条复用 applyKnowledgeTags（事务内插新删旧，并发安全）。
   * 批量语义决策：
   * - tagIds 含跨 KB 标签 → 400（严格——标签是整批共享目标，标错库是程序错误，
   *   与单条接口一致快速失败）；
   * - 不属于该 KB 的文档 id → 跳过（宽容，不整批失败），不计数；
   * - 单条打标抛错 → 计入 failed 继续处理其余条（部分失败语义：逐条独立事务，
   *   前 k-1 条已应用不因第 k 条失败而回滚，也不整批 500——前端可重试，
   *   操作幂等：全量替换语义重试结果一致，见 applyKnowledgeTags 注释）；
   * - KB 不存在 → 404（快速失败）。
   * 返回 { updated, failed }：updated = 实际更新标签的文档数；
   * failed = 打标抛错的条数（仅计数不记 detail，错误原因见服务日志）。
   */
  async batchSetTags(
    kbId: string,
    ids: string[],
    tagIds: string[],
  ): Promise<{ updated: number; failed: number }> {
    await this.ensureKbExists(kbId);
    const uniqueIds = [...new Set(ids)]; // 去重：重复 id 只处理一次（计数真实）
    const uniqueTagIds = [...new Set(tagIds)]; // 去重：重复标签只关联一次（幂等）
    await this.ensureTagsInKb(kbId, uniqueTagIds); // 400 防跨 KB 打标（严格）
    // 收集属于该 KB 的文档（跨 KB id 跳过，宽容）
    const existing = await this.knowledgeRepository.find({
      where: { kbId, id: In(uniqueIds) },
      select: { id: true },
    });
    let updated = 0;
    let failed = 0;
    for (const doc of existing) {
      try {
        await this.applyKnowledgeTags(doc.id, uniqueTagIds);
        updated++;
      } catch (err) {
        // 逐条捕获（部分失败语义）：单条打标事务抛错不阻断整批——记日志 +
        // 计入 failed，前端可重试（操作幂等：全量替换语义，见 applyKnowledgeTags 注释）
        failed++;
        this.logger.warn(
          `批量打标失败（已跳过，可重试）: knowledgeId=${doc.id}`,
          err as Error,
        );
      }
    }
    return { updated, failed };
  }

  /**
   * 批量移动文件夹（Task 1.8）：folderId 必填（DTO @IsDefined），null = 移回根
   * （folderId 列 nullable，与单条 update 的 folderId=null 语义一致——批量接口
   * 支持 null，避免前端「全选移回根」要多调 N 次单条接口）。
   * 批量语义决策：
   * - folderId 属于其它 KB → 404（严格——目标文件夹是整批共享的，指错库是程序
   *   错误，与单条 update 一致快速失败）；
   * - 不属于该 KB 的文档 id → 跳过（宽容，不整批失败），返回实际移动数；
   * - KB 不存在 → 404（快速失败）。
   * 实现：单条 UPDATE ... WHERE kbId AND id IN（原子；跨 KB id 自然不命中）。
   * 返回 { moved }（实际移动的文档数）。
   */
  async batchMove(
    kbId: string,
    ids: string[],
    folderId: string | null,
  ): Promise<{ moved: number }> {
    await this.ensureKbExists(kbId);
    if (folderId !== null) {
      await this.ensureFolderInKb(kbId, folderId); // 404 防跨 KB 文件夹（严格）
    }
    const uniqueIds = [...new Set(ids)];
    const result = await this.knowledgeRepository.update(
      { kbId, id: In(uniqueIds) },
      { folderId },
    );
    return { moved: result.affected ?? 0 };
  }

  // ==================== 状态 / 摘要 / 重新解析（Task 1.7） ====================

  /** 解析时间线（Task 1.7）：parserStages 直接透传（extract→chunk→embed→summary
   * 各阶段记录，含状态与时间——detail 为失败原因），外加状态摘要
   * （status/chunkCount/summary/updatedAt，summary 供前端直接渲染当前摘要文本，
   * 与 regenerate-summary 轮询语义对齐，见控制器注释）供前端渲染进度。
   * 文档不存在 → 404（getById） */
  async getStages(
    kbId: string,
    id: string,
  ): Promise<{
    stages: unknown[];
    status: string;
    chunkCount: number;
    summary: string | null;
    updatedAt: Date;
  }> {
    const knowledge = await this.getById(kbId, id);
    return {
      stages: knowledge.parserStages,
      status: knowledge.status,
      chunkCount: knowledge.chunkCount,
      summary: knowledge.summary,
      updatedAt: knowledge.updatedAt,
    };
  }

  /** 重新生成摘要（Task 1.7）：文档存在性（404）→ 入队 SUMMARY → 202
   * （控制器标注 @HttpCode(202)，前端轮询 stages/summary 更新）。
   * 不做状态防重：摘要非关键路径，重复调用幂等（每轮都重新生成，
   * summary 阶段追加 + summary 覆盖） */
  async regenerateSummary(kbId: string, id: string): Promise<void> {
    await this.getById(kbId, id); // 404 语义 + kbId 限定
    this.enqueueSummary(id);
  }

  /**
   * 重新解析（Task 1.7）：清旧建新——删旧 chunks（含向量）→ 重置解析产物 →
   * status=pending → 入队 PARSE → 202（控制器标注 @HttpCode(202)）。
   *
   * 事务与防重：事务内 SELECT ... FOR UPDATE 行锁复查存在性 + 状态判定——
   * - 文档不存在（含 404 前置快速失败后的并发删除竞态）→ 404；
   * - status 非 ready/failed（pending/parsing 等处理中状态）→ 409「正在处理中」：
   *   防并发双跑——同一文档重复 reparse 会双入队导致两轮解析互踩（旧 job 删
   *   新块/新 job 删旧块交错），行锁 + 事务内状态检查把「判定 + 重置 + 提交」
   *   串行化，两个并发 reparse 只有一个能拿到 ready/failed 状态通过；
   * - 删旧 chunks 即删向量：embedding 在 chunks 表内（vector 列），删行即删向量；
   *   EMBED 队列中未消费的旧 job 会读到已删 chunk → 幂等 no-op（Task 1.6 已做，
   *   见 embed.processor.ts 文件头注释）——无孤儿向量/块残留。
   * 重置字段：parserStages='[]'（时间线从零开始）+ parsedText/summary=null +
   * error='' + chunkCount=0 + status='pending'（重新入队，worker 置 parsing）。
   * 入队在事务提交后（保证入队时新状态已落库，worker 读到 pending/无旧产物）。
   * 事务体抽为 prepareReparse 与批量接口 batchReparse 共用（见该方法注释）。
   */
  async reparse(kbId: string, id: string): Promise<void> {
    // 404 前置快速失败（含 22P02 语义，见 getById）——事务内复查兜底并发删除
    await this.getById(kbId, id);
    const result = await this.prepareReparse(kbId, id);
    if (result === 'not_found') {
      // 并发删除竞态（getById 之后文档被删）：行锁复查读到行不存在 → 404
      throw new NotFoundException('文档不存在');
    }
    if (result === 'skipped') {
      // 防重（决策）：pending/parsing 等处理中状态拒绝重复 reparse——
      // 等本轮完成后（ready）再重试；failed 允许（reparse 是失败恢复入口）
      throw new ConflictException('文档正在处理中，请稍后再试');
    }
    // 事务提交后入队（见方法头注释）
    this.enqueueParse(id);
  }

  /**
   * 单条重新解析的事务体（reparse / batchReparse 共用）：行锁复查存在性 +
   * 状态判定 + 删旧 chunks（含向量）+ 重置解析产物（原子化，竞态仲裁语义见
   * reparse 方法头注释）。
   * 返回 'queued'（已重置待入队）/ 'skipped'（处理中，防重）/ 'not_found'
   * （并发删除——reparse 转 404，batchReparse 计入 skipped）。
   * 入队由调用方在事务提交后执行（保证入队时新状态已落库）。
   */
  private async prepareReparse(
    kbId: string,
    id: string,
  ): Promise<'queued' | 'skipped' | 'not_found'> {
    return this.dataSource.transaction(async (manager) => {
      // 行锁复查（与 ParseProcessor 分块事务的 FOR UPDATE 同仲裁模式）：
      // 文档在并发中被删除 → 读不到行 → not_found；行锁把并发 reparse 串行化
      const row = await manager.findOne(Knowledge, {
        where: { kbId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return 'not_found';
      if (row.status !== 'ready' && row.status !== 'failed') return 'skipped';
      // 删旧 chunks（含向量，见 reparse 注释）——与重置同事务原子化
      await manager.delete(Chunk, { knowledgeId: id });
      // 重置解析产物 + 时间线 + 状态（reparse 语义：从零开始）
      await manager.update(
        Knowledge,
        { kbId, id },
        {
          status: 'pending',
          parsedText: null,
          summary: null,
          error: '',
          chunkCount: 0,
          parserStages: [],
        },
      );
      return 'queued';
    });
  }

  /** 解析上传携带的文档级分块配置（JSON 字符串）；空/非法 → null（跟随 KB） */
  private parseDocChunkingConfig(json: string): Record<string, unknown> | null {
    if (!json) return null;
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      // 结构校验：至少含一个分块参数才视为有效（避免空对象覆盖 KB 配置）
      const hasAny =
        obj &&
        (typeof obj.chunkSize === 'number' ||
          typeof obj.chunkOverlap === 'number' ||
          typeof obj.separators !== 'undefined' ||
          typeof obj.strategy === 'string');
      return hasAny ? obj : null;
    } catch {
      return null;
    }
  }

  /** 解析引擎归一化：显式指定（mineru）→ 原样；未指定时复杂格式
   *  （pdf/docx）默认 mineru（版式还原更稳，WeKnora 引擎路由语义），
   *  其余 null（跟随全局 PARSER_ENGINE） */
  private normalizeParserEngine(raw: string, ext: string): string | null {
    const v = raw?.trim().toLowerCase();
    if (v === 'mineru') return v;
    if (['pdf', 'doc', 'docx'].includes(ext)) return 'mineru';
    return null;
  }
}

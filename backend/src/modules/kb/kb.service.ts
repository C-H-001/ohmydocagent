// 知识库数据访问与业务规则（Task 1.1 + Task 1.10）：
// - create：创建者即操作者（creatorId=userId），type 固定 document（FAQ/Wiki 已移除）
// - list：分页列表 + 视图筛选（view=all|mine|favorite|recent）+ 当前用户视角
//   pinned/favorite 标记 + docCount/chunkCount 聚合计数；SQL 侧完成筛选+排序+
//   分页（Task 1.1 挂账：列表从内存分页改 SQL，见 list 注释），置顶优先（仅
//   view=all）、组内 updatedAt DESC（recent 按 visitedAt DESC）
// - getById/update/remove：404 语义（非 UUID 格式 id 撞 PG 22P02 同样视为不存在）
// - togglePin/toggleFavorite：用户级开关（无则 upsert、有则删除，返回切换后状态），
//   唯一约束收口并发竞态（后落库者撞 23505 幂等返回已置位）
// - recordVisit：详情访问时 upsert 最近访问（同用户同 KB 仅一条，刷新 visitedAt）
// - stats：知识库统计（totalKbs/mine/favorite/totalDocs/totalChunks）
// - duplicate：复制配置行（新 UUID、creatorId=当前用户、名称默认「原名称 副本」），
//   文档/分块/文件夹不复制（P1 仅复制配置，子表复制语义在 Task 1.2/1.3 引入后另行决定）
// - remove：硬删除（P1 无回收站需求，YAGNI），事务内先删 pins/favorites/recents、
//   再删 knowledge/folders/tags/关联子表行（removeByKbInTx 聚合，Task 1.3）、
//   最后删 KB 行——user_kb_pins/user_kb_favorites/user_kb_recents 与 knowledge 等
//   子表均无外键（Task 1.1/1.2 建表时的约定：creatorId/kbId 为普通 uuid 列，
//   子表级联由服务层显式清理保证无残留）；事务提交成功后清理 KB 磁盘目录
//   （fs 不可回滚，放事务外，失败仅记日志）；Task 3.2：事务提交后 best-effort
//   调 GraphRepository.deleteKbSubgraph 清空该 KB 的 Neo4j 图谱数据（实体/边/
//   chunk 镜像，失败仅记日志——图谱清理非关键路径）
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphRepository } from '../graph/graph.repository.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { Chunk } from '../chunk/chunk.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { CreateKbDto } from './dto/create-kb.dto.js';
import { KB_VIEWS, KbView } from './dto/list-kb.dto.js';
import { UpdateKbDto } from './dto/update-kb.dto.js';
import { KnowledgeBase } from './kb.entity.js';
import { Role, User } from '../users/user.entity.js';
import { KbAccessService } from '../kb-share/kb-access.service.js';
import { UserKbFavorite } from './user-kb-favorite.entity.js';
import { UserKbPin } from './user-kb-pin.entity.js';
import { UserKbRecent } from './user-kb-recent.entity.js';

/** 列表单条记录：知识库字段 + 当前用户视角 pinned/favorite 标记 + 聚合计数 */
export interface KbListItem extends KnowledgeBase {
  pinned: boolean;
  favorite: boolean;
  /** 文档数（knowledge 表按 kbId 聚合，列表页一次查询而非 N+1） */
  docCount: number;
  /** 分块数（chunks 表按 kbId 聚合） */
  chunkCount: number;
}

/** 列表响应结构（与 common/pagination 的 Paginated 约定一致） */
export interface KbListResult {
  items: KbListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** 各视图真实计数（tab 徽标：全部/我的/收藏/最近——一次给全，避免前端
   *  基于当前视图分页近似导致点击切换时数字跳动/不准） */
  counts: { all: number; mine: number; favorite: number; recent: number };
}

@Injectable()
export class KbService {
  private readonly logger = new Logger(KbService.name);

  constructor(
    @InjectRepository(KnowledgeBase)
    private readonly kbRepository: Repository<KnowledgeBase>,
    @InjectRepository(UserKbPin)
    private readonly pinRepository: Repository<UserKbPin>,
    // Task 1.10：收藏/最近访问关系表（与 pin 同构，视图筛选与标记的来源）
    @InjectRepository(UserKbFavorite)
    private readonly favoriteRepository: Repository<UserKbFavorite>,
    @InjectRepository(UserKbRecent)
    private readonly recentRepository: Repository<UserKbRecent>,
    // remove 需要事务（pins + knowledge + KB 三步删除原子化，见 remove 注释）：
    // DataSource 由 TypeOrmModule.forRoot 全局提供（与 users.service 同模式）
    private readonly dataSource: DataSource,
    // 可见性过滤（用户需求：只有被邀请/共享的人才能查看）：列表只返回
    // 「我创建的 ∪ 被共享给我的」——取消 Owner/Admin 隐式全可见
    // （注册默认 Admin，若全可见则共享机制形同虚设，见 kb-access.service 注释）
    private readonly kbAccessService: KbAccessService,
    // KB 删除级联（Task 1.2/1.3）：事务内删 knowledge/folders/tags/关联行用
    // KnowledgeService.removeByKbInTx
    // （EntityManager 参数解耦，本服务注入它但文档服务不依赖本服务，无环）
    private readonly knowledgeService: KnowledgeService,
    // 事务外清理 KB 磁盘目录（uploads/{kbId}）
    private readonly storage: StorageService,
    // 图谱子图清理（Task 3.2 质量审查整改）：KB 删除后清空该 KB 的图谱数据
    // （实体/边/chunk 镜像——否则孤儿图数据仍挂在已删 KB 名下，见 remove 注释）
    private readonly graph: GraphRepository,
    // Task 4.4 审计（全局模块直接注入，见 audit.module.ts 注释）
    private readonly audit: AuditService,
  ) {}

  /** 创建知识库：creatorId=当前用户，type 固定 document，分块配置默认空对象，
   * 图谱抽取配置默认开启（{ enabled: true }——上传即建图的产品核心能力，
   * 显式 { enabled: false } 关闭，见 kb.entity.ts extractConfig 注释） */
  async create(dto: CreateKbDto, userId: string): Promise<KnowledgeBase> {
    const kb = this.kbRepository.create({
      name: dto.name,
      description: dto.description ?? '',
      type: 'document',
      creatorId: userId,
      chunkingConfig: dto.chunkingConfig ?? {},
      // DTO 校验后的 ExtractConfigDto 落 jsonb 列（Record<string, unknown> 无
      // 索引签名，显式断言——enabled 布尔校验见 extract-config.dto.ts 注释）
      extractConfig: (dto.extractConfig ?? {
        enabled: true,
      }) as Record<string, unknown>,
    });
    const saved = await this.kbRepository.save(kb);
    // 审计：创建知识库
    await this.audit.log('kb.create', userId, 'kb', saved.id, {
      name: saved.name,
    });
    return saved;
  }

  /**
   * 分页列表（Task 1.10 重写，落实 Task 1.1 挂账）：视图筛选 + 排序 + 分页全部在
   * SQL 侧完成（不再全量取出内存排序），docCount/chunkCount 用两个索引子查询
   * 聚合（一次查询而非 N+1）。
   * - view=all（默认）：全部 KB，置顶优先、组内 updatedAt DESC
   * - view=mine：creatorId = 当前用户，updatedAt DESC
   * - view=favorite：当前用户收藏的 KB（id IN 收藏集合），updatedAt DESC
   * - view=recent：当前用户最近访问的 KB（innerJoin user_kb_recents），按
   *   visitedAt DESC（同时间戳再按 updatedAt DESC 稳定）
   * - pinned/favorite 标记：一次性读三张关系表后内存 Set 判定（关系表行数 ≪ KB 数）
   * 性能说明：主查询先只取分页 id（轻量），再用 id IN 取实体 + 两个 COUNT 子查询
   * （命中 idx_knowledge_kb_id / idx_chunks_kb_id）；P1 数据量小无需物化，
   * 量级上来后可换 LEFT JOIN + GROUP BY 或物化视图。
   * common/pagination 的 paginate() 助手不适用：置顶排序/视图筛选涉及跨表
   * （user_kb_pins/user_kb_recents + 聚合子查询），findAndCount 无法表达，
   * 故手工实现同构 Paginated 结构（PaginationDto 仍在控制器复用做查询参数校验）。
   */
  async list(
    page: number,
    pageSize: number,
    user: User,
    view: KbView = 'all',
  ): Promise<KbListResult> {
    const userId = user.id;
    // view 合法性兜底：DTO @IsEnum 已拦 HTTP 层（400），服务层再校验防内部
    // 调用绕过 DTO（直接调 service.list 传非法 view 同样 400）
    if (!KB_VIEWS.includes(view)) {
      throw new BadRequestException(
        'view 必须是 all|mine|favorite|recent 之一',
      );
    }
    // 一次性读两张关系表：pinned/favorite 标记只做内存 Set 判定，不再逐 KB 查询
    const [pinnedRows, favRows] = await Promise.all([
      this.pinRepository.find({ where: { userId } }),
      this.favoriteRepository.find({ where: { userId } }),
    ]);
    const pinnedKbIds = new Set(pinnedRows.map((p) => p.kbId));
    const favKbIds = new Set(favRows.map((f) => f.kbId));
    // 各视图计数（tab 徽标：一次响应给全——all 受可见性约束；mine = 我创建
    // 的；favorite/recent = 收藏/访问集合大小）。与主查询并行，开销为 4 个
    // 轻量 count。
    const visible = await this.kbAccessService.visibleKbIds(user);
    const counts = await (async () => {
      const [allCount, mineCount, recentCount] = await Promise.all([
        visible === null
          ? this.kbRepository.count()
          : visible.size === 0
            ? Promise.resolve(0)
            : this.kbRepository.count({
                where: { id: In([...visible]) },
              }),
        this.kbRepository.count({ where: { creatorId: userId } }),
        this.recentRepository.count({ where: { userId } }),
      ]);
      return {
        all: allCount,
        mine: mineCount,
        favorite: favKbIds.size,
        recent: recentCount,
      };
    })();
    // favorite 视图且无任何收藏：IN () 是非法 SQL，提前短路返回空结果
    if (view === 'favorite' && favKbIds.size === 0) {
      return { items: [], total: 0, page, pageSize, counts };
    }
    // 主查询：先取分页 id（轻量列），筛选/排序/分页全部下推到数据库
    const qb = this.kbRepository.createQueryBuilder('kb').select('kb.id', 'id');
    // 可见性过滤（用户需求：只有被邀请/共享的人才能查看）：
    // 列表只返回「我创建的 ∪ 个人被共享的 ∪ 所在组织被共享的」；
    // 系统 Owner 全可见（visibleKbIdsFor 返回 null 表示不限）。
    if (view === 'mine') {
      qb.where('kb."creatorId" = :userId', { userId });
    } else if (view === 'favorite') {
      qb.where('kb.id IN (:...favIds)', { favIds: [...favKbIds] });
    } else if (view === 'recent') {
      // innerJoin 即完成「只取访问过的 KB」过滤；排序直接用访问时间
      qb.innerJoin(
        UserKbRecent,
        'r',
        'r."kbId" = kb.id AND r."userId" = :userId',
        { userId },
      );
    }
    // 叠加可见性过滤（用户需求：只有被邀请/共享的人才能查看）：
    // visibleKbIds 已含「我创建的 ∪ 个人共享 ∪ 组织共享」，直接 IN 过滤；
    // 系统 Owner 全可见（visibleKbIds 返回 null → 不过滤）。
    // 空集合提前短路：IN () 是非法 SQL（TypeORM 生成 `IN ()` 报错）。
    if (view === 'all' || view === 'favorite' || view === 'recent') {
      if (visible === null) {
        // 系统 Owner：全可见，不过滤
      } else if (visible.size === 0) {
        return { items: [], total: 0, page, pageSize, counts };
      } else {
        qb.andWhere('kb.id IN (:...visibleIds)', {
          visibleIds: [...visible],
        });
      }
    }
    // 置顶优先仅对 view=all 生效（mine/favorite/recent 是子集语义，
    // 叠加置顶分组会让「我创建的」列表顺序被无关置顶打乱）
    if (view === 'all' && pinnedKbIds.size > 0) {
      qb.orderBy(
        'CASE WHEN kb.id IN (:...pinnedIds) THEN 0 ELSE 1 END',
        'ASC',
      ).setParameters({ pinnedIds: [...pinnedKbIds] });
    }
    // 组内排序语义：recent 按访问时间倒序；其余视图按 updatedAt 倒序
    if (view === 'recent') {
      qb.addOrderBy('r."visitedAt"', 'DESC').addOrderBy(
        'kb."updatedAt"',
        'DESC',
      );
    } else {
      qb.addOrderBy('kb."updatedAt"', 'DESC');
    }
    // 决胜键（质量审查整改）：updatedAt/visitedAt 时间戳可能并列（同毫秒），
    // 末尾追加 kb.id ASC 唯一决胜，保证跨页边界排序稳定（分页抖动）
    qb.addOrderBy('kb.id', 'ASC');
    qb.limit(pageSize).offset((page - 1) * pageSize);
    // getCount 忽略 select/order/limit/offset，得到筛选后的全量总数
    const [total, rows] = await Promise.all([qb.getCount(), qb.getRawMany()]);
    if (rows.length === 0) {
      return { items: [], total, page, pageSize, counts };
    }
    const pageIds = rows.map((r) => r.id as string);
    // 取实体 + docCount/chunkCount 聚合子查询（两个 COUNT 子查询而非 N+1 次查询：
    // 列表页 N 个 KB 时只需 1 次查询；命中 kbId 索引，P1 量级足够）。
    // 注意：getMany() 不会把 addSelect 的裸表达式列挂到实体上（TypeORM 只映射
    // 实体元数据列），故用 getRawAndEntities 取对齐的 raw 行再手动装配计数。
    const { entities, raw } = await this.kbRepository
      .createQueryBuilder('kb')
      .where('kb.id IN (:...ids)', { ids: pageIds })
      .addSelect(
        '(SELECT COUNT(*) FROM knowledge k WHERE k."kbId" = kb.id)',
        'docCount',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM chunks c WHERE c."kbId" = kb.id)',
        'chunkCount',
      )
      .orderBy('kb.id', 'ASC')
      .getRawAndEntities();
    // WHERE IN 不保序：按主查询返回的 id 顺序重排，恢复分页排序语义
    const idOrder = new Map(pageIds.map((id, i) => [id, i]));
    // raw 与 entities 行序一致但排序后下标会错位：按 kb_id 建索引取值更稳
    const rawByKbId = new Map(raw.map((r) => [r.kb_id as string, r]));
    const items = entities
      .slice()
      .sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0))
      .map((kb) => ({
        ...kb,
        pinned: pinnedKbIds.has(kb.id),
        favorite: favKbIds.has(kb.id),
        docCount: Number(rawByKbId.get(kb.id)?.docCount ?? 0),
        chunkCount: Number(rawByKbId.get(kb.id)?.chunkCount ?? 0),
      }));
    return { items, total, page, pageSize, counts };
  }

  /** 详情：不存在返回 404；非 UUID 格式 id 撞 PG 22P02 同样视为不存在（不泄露内部错误） */
  async getById(id: string): Promise<KnowledgeBase> {
    try {
      const kb = await this.kbRepository.findOne({ where: { id } });
      if (!kb) {
        throw new NotFoundException('知识库不存在');
      }
      return kb;
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

  /** 更新名称/描述/分块配置/图谱抽取配置：只更新传入字段（undefined 跳过），不存在返回 404 */
  async update(id: string, dto: UpdateKbDto): Promise<KnowledgeBase> {
    const kb = await this.getById(id);
    if (dto.name !== undefined) kb.name = dto.name;
    if (dto.description !== undefined) kb.description = dto.description;
    if (dto.chunkingConfig !== undefined) {
      kb.chunkingConfig = dto.chunkingConfig;
    }
    // Task 3.2：图谱抽取开关可更新（如关闭后不再建图；存量图保留，由 reparse
    // 或 P3 的显式清理移除——开关只管新文档是否入队抽取）。DTO 校验后的
    // ExtractConfigDto 落 jsonb 列（断言见 create 注释）
    if (dto.extractConfig !== undefined) {
      kb.extractConfig = dto.extractConfig as Record<string, unknown>;
    }
    return this.kbRepository.save(kb);
  }

  /**
   * 删除知识库（硬删除）：事务内先删 pins/favorites/recents、再删
   * knowledge/folders/tags/关联（KnowledgeService.removeByKbInTx 聚合清理子表数据）、
   * 最后删 KB 行，保证置顶/收藏/最近访问记录与文档/文件夹/标签等子表数据无残留
   * 且要么都成功要么都回滚（避免第二步失败留下「KB 已删但置顶残留」或
   * 「置顶已删但 KB 还在」的不一致态）。
   * 删除顺序说明：user_kb_pins/user_kb_favorites/user_kb_recents 与 knowledge 均
   * 无外键（kbId/creatorId 为普通 uuid 列），先清子表后删主表是语义上最稳的顺序
   * （未来补 FK 后顺序依然正确）。
   * 磁盘目录（uploads/{kbId}）在事务提交后清理：fs 不可回滚，必须放事务外；
   * 失败仅记日志不阻断（孤儿文件可后续清理）。
   */
  async remove(id: string): Promise<void> {
    const kb = await this.getById(id); // 404 语义（不存在/非法 id 都先于任何删除动作暴露）
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(UserKbPin, { kbId: id });
      await manager.delete(UserKbFavorite, { kbId: id });
      await manager.delete(UserKbRecent, { kbId: id });
      await this.knowledgeService.removeByKbInTx(manager, id);
      await manager.delete(KnowledgeBase, { id });
    });
    // 事务提交成功后清理磁盘目录（幂等：目录不存在时静默）
    await this.storage.removeKbDirectory(id);
    // 图谱子图清理（Task 3.2 质量审查整改）：KB 删除后清空该 KB 的实体/边/
    // chunk 镜像（deleteKbSubgraph 的 DETACH DELETE 语义，见 graph.repository.ts
    // 注释）——否则已删 KB 的子图仍留在 Neo4j（无主数据，跨 KB 隔离也被破坏）。
    // 失败仅记日志不阻断：图谱清理非关键路径（与磁盘目录清理同一约定）
    await this.graph.deleteKbSubgraph(id).catch((err: unknown) => {
      this.logger.warn(`知识库删除后图谱子图清理失败: ${id}`, err as Error);
    });
    // 审计：删除知识库（无请求上下文 → userId 记 null，视为系统级清理后的
    // 管理操作，见 audit-log.entity.ts 文件头注释）
    await this.audit.log('kb.delete', null, 'kb', id, {
      name: kb.name,
    });
  }

  /**
   * 置顶开关（toggle）：知识库必须存在（404）；已置顶 → 取消并返回 { pinned: false }，
   * 未置顶 → 写入并返回 { pinned: true }。具体开关逻辑在 toggleRelation 助手
   * （与 toggleFavorite 共用同一套 23505 并发兜底语义，改动时同步 toggleRelation）。
   */
  async togglePin(kbId: string, userId: string): Promise<{ pinned: boolean }> {
    await this.getById(kbId);
    const pinned = await this.toggleRelation(this.pinRepository, kbId, userId);
    return { pinned };
  }

  /**
   * 收藏开关（toggle，Task 1.10）：与 togglePin 同形态同语义——知识库必须存在
   * （404）；已收藏 → 取消并返回 { favorite: false }，未收藏 → 写入并返回
   * { favorite: true }。具体开关逻辑在 toggleRelation 助手（质量审查整改：
   * 原两方法 ~90% 重复，抽取共用；改动时同步 toggleRelation，勿只改其一）。
   */
  async toggleFavorite(
    kbId: string,
    userId: string,
  ): Promise<{ favorite: boolean }> {
    await this.getById(kbId);
    const favorite = await this.toggleRelation(
      this.favoriteRepository,
      kbId,
      userId,
    );
    return { favorite };
  }

  /**
   * 用户级关系开关通用实现（togglePin/toggleFavorite 共用，质量审查整改）：
   * 无则写入、有则删除，返回切换后状态（true=已置位/已收藏）。关系表
   * （user_kb_pins / user_kb_favorites）结构相同（userId + kbId 唯一），唯一约束
   * 收口并发竞态：find→save 非原子，两个并发请求可能同时判定「未置位」；
   * 唯一约束保证只有一个能落库，后落库者撞 23505。此处不把竞态当错误抛给前端——
   * 撞约束即说明该用户此刻已置位（另一请求已写入），幂等返回 true（后落库者的
   * 最终态与「先落库再查询」一致，语义无偏差）。23505 之外的错误照常抛出。
   */
  private async toggleRelation(
    repo: Repository<UserKbPin | UserKbFavorite>,
    kbId: string,
    userId: string,
  ): Promise<boolean> {
    const existing = await repo.findOne({ where: { userId, kbId } });
    if (existing) {
      await repo.delete({ id: existing.id });
      return false;
    }
    try {
      await repo.save(repo.create({ userId, kbId }));
    } catch (err) {
      // 并发兜底：唯一约束 23505（unique_violation）意味着另一请求已写入同一
      // (userId, kbId)，当前用户实际处于已置位态 → 幂等返回，不抛 500
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        return true;
      }
      throw err;
    }
    return true;
  }

  /**
   * 记录最近访问（Task 1.10）：同用户同 KB 只保留一条，每次访问 upsert 刷新
   * visitedAt=now。调用点在控制器 GET /kbs/:id（详情访问即视为「最近访问」信号）。
   * 用 Repository.upsert（ON CONFLICT (userId,kbId) DO UPDATE）原子化处理
   * 「首次插入 / 再次刷新」两种路径，天然并发安全，无需 find→save 的竞态兜底。
   * 不做 KB 存在性校验（质量审查整改）：详情 GET 已先 getById 校验过（404 语义
   * 由主流程保证），此处再查是重复查询（每次详情多一次 SQL）。删除竞态下可能
   * 为已删除的 kbId 写孤儿行（user_kb_recents 无外键），但 recent 视图的
   * innerJoin 条件 r."kbId" = kb.id（见 list）只命中存在的 KB，孤儿行天然不可见，
   * 可接受（remove 事务内也会显式清 recents，竞态窗口极小）。
   */
  async recordVisit(kbId: string, userId: string): Promise<void> {
    await this.recentRepository.upsert(
      { userId, kbId, visitedAt: new Date() },
      { conflictPaths: ['userId', 'kbId'] },
    );
  }

  /**
   * 知识库统计（Task 1.10）：{ totalKbs, mine, favorite, totalDocs, totalChunks }。
   * 口径说明：totalKbs/totalDocs/totalChunks 是系统全量（所有 KB / 所有文档 /
   * 所有分块，与查看者无关，Owner/Admin 无差别）；mine/favorite 是当前用户维度
   * （我创建的 / 我收藏的）。P1 数据量小，count() 直查即可，无聚合物化必要。
   */
  async stats(userId: string): Promise<{
    totalKbs: number;
    mine: number;
    favorite: number;
    totalDocs: number;
    totalChunks: number;
  }> {
    const [totalKbs, mine, favorite, totalDocs, totalChunks] =
      await Promise.all([
        this.kbRepository.count(),
        this.kbRepository.count({ where: { creatorId: userId } }),
        this.favoriteRepository.count({ where: { userId } }),
        this.kbRepository.manager.count(Knowledge),
        this.kbRepository.manager.count(Chunk),
      ]);
    return { totalKbs, mine, favorite, totalDocs, totalChunks };
  }

  /**
   * 复制知识库：复制配置行（name/description/type/chunkingConfig/embeddingModelId），
   * 新 UUID + creatorId=当前用户（副本归属复制操作者）；名称默认「原名称 副本」，
   * DuplicateKbDto.name 可覆盖。P1 仅复制配置——文档/分块/文件夹在 Task 1.2/1.3
   * 引入子表后另行决定复制语义（计划暂不复制文件内容）。
   */
  async duplicate(
    kbId: string,
    userId: string,
    name?: string,
  ): Promise<KnowledgeBase> {
    const source = await this.getById(kbId); // 404 语义
    const copy = this.kbRepository.create({
      name: name ?? `${source.name} 副本`,
      description: source.description,
      type: source.type,
      creatorId: userId,
      chunkingConfig: source.chunkingConfig,
      embeddingModelId: source.embeddingModelId,
      // Task 3.2：图谱抽取开关随配置复制（副本默认继承源开关语义）
      extractConfig: source.extractConfig,
    });
    return this.kbRepository.save(copy);
  }
}

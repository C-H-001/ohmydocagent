// KbService 单元测试（Task 1.1 + Task 1.10）：mock 仓库 + DataSource + 级联依赖
// （KnowledgeService/StorageService），覆盖——
// Task 1.1：duplicate 配置复制、remove 事务内级联删除、togglePin 开关语义与
// 并发双置顶（撞 23505 幂等）；
// Task 1.10：list 视图筛选（all/mine/favorite/recent）与 SQL 侧排序分页
// （置顶 CASE 表达式 + visitedAt 倒序）、docCount/chunkCount 聚合装配、非法 view
// 400、toggleFavorite 开关与 23505 兜底、recordVisit upsert、stats 聚合统计。
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphRepository } from '../graph/graph.repository.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { Chunk } from '../chunk/chunk.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeBase } from './kb.entity.js';
import { KbAccessService } from '../kb-share/kb-access.service.js';
import { UserKbFavorite } from './user-kb-favorite.entity.js';
import { UserKbPin } from './user-kb-pin.entity.js';
import { UserKbRecent } from './user-kb-recent.entity.js';
import { KbService } from './kb.service.js';

/** 构造可链式调用的 query builder mock：链式方法返回自身，末端子查询按用例配置 */
function makeQb(
  overrides: {
    getCount?: number;
    getRawMany?: Array<{ id: string }>;
    getRawAndEntities?: {
      entities: KnowledgeBase[];
      raw: Array<Record<string, unknown>>;
    };
  } = {},
) {
  const qb: Record<string, unknown> = {
    getCount: vi.fn(async () => overrides.getCount ?? 0),
    getRawMany: vi.fn(async () => overrides.getRawMany ?? []),
    getRawAndEntities: vi.fn(async () => ({
      entities: overrides.getRawAndEntities?.entities ?? [],
      raw: overrides.getRawAndEntities?.raw ?? [],
    })),
  };
  for (const m of [
    'select',
    'where',
    'innerJoin',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
    'setParameters',
    'addSelect',
  ]) {
    qb[m] = vi.fn(() => qb);
  }
  return qb as {
    getCount: ReturnType<typeof vi.fn>;
    getRawMany: ReturnType<typeof vi.fn>;
    getRawAndEntities: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    innerJoin: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    addOrderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    offset: ReturnType<typeof vi.fn>;
    setParameters: ReturnType<typeof vi.fn>;
    addSelect: ReturnType<typeof vi.fn>;
  };
}

describe('KbService', () => {
  let service: KbService;
  // 仓库 mock：findOne/find/save/delete/create/count/upsert 按用例覆写
  const kbRepoMock = {
    create: vi.fn((data: Partial<KnowledgeBase>) => data),
    save: vi.fn(async (entity: KnowledgeBase) => entity),
    findOne: vi.fn(),
    find: vi.fn(),
    delete: vi.fn(async () => ({ affected: 1 })),
    count: vi.fn(async () => 0),
    createQueryBuilder: vi.fn(),
    // stats 的 totalDocs/totalChunks 用 EntityManager.count（Repository.manager）
    manager: { count: vi.fn(async () => 0) },
  };
  const pinRepoMock = {
    create: vi.fn((data: Partial<UserKbPin>) => data),
    save: vi.fn(async (entity: UserKbPin) => entity),
    find: vi.fn(),
    findOne: vi.fn(),
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  // Task 1.10 新增关系表 mock：favorite（toggle/list 标记）、recent（recordVisit/upsert）
  const favoriteRepoMock = {
    create: vi.fn((data: Partial<UserKbFavorite>) => data),
    save: vi.fn(async (entity: UserKbFavorite) => entity),
    find: vi.fn(),
    findOne: vi.fn(),
    delete: vi.fn(async () => ({ affected: 1 })),
    count: vi.fn(async () => 0),
  };
  const recentRepoMock = {
    upsert: vi.fn(async () => ({ identifiers: [{ id: 'r' }] })),
  };
  // DataSource mock：transaction 直接执行回调，manager 是隔离的删除 mock——
  // remove 用例断言「删除动作发生在事务回调内」（通过 manager 而非仓库）
  const managerMock = {
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  const dataSourceMock = {
    transaction: vi.fn(async (cb: (m: typeof managerMock) => unknown) =>
      cb(managerMock),
    ),
  };
  // Task 1.2 级联依赖 mock：remove 在事务内调 removeByKbInTx，事务外清磁盘目录
  const knowledgeServiceMock = {
    removeByKbInTx: vi.fn(async () => undefined),
  };
  const storageMock = {
    removeKbDirectory: vi.fn(async () => undefined),
  };

  // 图谱子图清理 mock（Task 3.2）：KB 删除事务提交后 best-effort 调
  // deleteKbSubgraph 清空该 KB 的 Neo4j 数据（失败仅记日志不阻断，见 remove 注释）
  const graphRepoMock = {
    deleteKbSubgraph: vi.fn(async () => undefined),
  };

  const userId = '11111111-1111-4111-8111-111111111111';
  const now = Date.now();
  /** 构造 KB 测试数据（updatedAt 由调用方给定，模拟不同更新先后） */
  function makeKb(
    id: string,
    name: string,
    updatedAtMs: number,
    chunking?: Record<string, unknown>,
  ): KnowledgeBase {
    return {
      id,
      name,
      description: '',
      type: 'document',
      creatorId: userId,
      chunkingConfig: chunking ?? {},
      embeddingModelId: null,
      createdAt: new Date(updatedAtMs),
      updatedAt: new Date(updatedAtMs),
    } as KnowledgeBase;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        KbService,
        { provide: getRepositoryToken(KnowledgeBase), useValue: kbRepoMock },
        { provide: getRepositoryToken(UserKbPin), useValue: pinRepoMock },
        {
          provide: getRepositoryToken(UserKbFavorite),
          useValue: favoriteRepoMock,
        },
        {
          provide: getRepositoryToken(UserKbRecent),
          useValue: recentRepoMock,
        },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: KnowledgeService, useValue: knowledgeServiceMock },
        { provide: StorageService, useValue: storageMock },
        // Task 3.2：GraphRepository（KB 删除清空图谱子图）
        { provide: GraphRepository, useValue: graphRepoMock },
        // Task 4.4 审计（全局模块注入，单测需显式 provide mock）
        { provide: AuditService, useValue: { log: vi.fn() } },
        { provide: KbAccessService, useValue: { visibleKbIds: vi.fn(async () => null) } },
      ],
    }).compile();
    service = moduleRef.get(KbService);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list（Task 1.10 视图筛选 + SQL 排序分页）', () => {
    it('view=all：置顶优先下推 SQL（CASE 表达式），分页 id 顺序被恢复，pinned/favorite 标记正确', async () => {
      const kbA = makeKb('a', 'A 库', now);
      const kbB = makeKb('b', 'B 库', now - 2000);
      const kbC = makeKb('c', 'C 库', now - 4000);
      // 主查询分页 id：置顶的 b 排最前（SQL 侧已排序）
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 3,
          getRawMany: [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
          // 实体查询返回乱序（WHERE IN 不保序），验证服务层按 idOrder 重排
          getRawAndEntities: {
            entities: [kbA, kbB, kbC],
            raw: [
              { kb_id: 'a', docCount: '0', chunkCount: '0' },
              { kb_id: 'b', docCount: '0', chunkCount: '0' },
              { kb_id: 'c', docCount: '0', chunkCount: '0' },
            ],
          },
        }),
      );
      pinRepoMock.find.mockResolvedValue([{ userId, kbId: 'b' } as UserKbPin]);
      favoriteRepoMock.find.mockResolvedValue([]);
      const result = await service.list(1, 10, { id: userId, role: "admin" } as never, 'all');
      expect(result.total).toBe(3);
      expect(result.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
      expect(result.items[0].pinned).toBe(true);
      expect(result.items[1].pinned).toBe(false);
      // 置顶优先是 SQL CASE 表达式（Task 1.1 挂账：排序下推数据库层）
      const qb = kbRepoMock.createQueryBuilder.mock.results[0].value;
      expect(qb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('CASE WHEN kb.id IN'),
        'ASC',
      );
      expect(qb.addOrderBy).toHaveBeenCalledWith('kb."updatedAt"', 'DESC');
    });

    it('view=all：分页下推 SQL（limit/offset），getRawMany 只取分页 id', async () => {
      const rows = Array.from({ length: 11 }, (_, i) =>
        makeKb(`kb-${i}`, `库${i}`, now - i * 1000),
      );
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 11,
          // 第 1 页：SQL 已按置顶优先+updatedAt 排好，这里返回前 10 个 id
          getRawMany: rows.slice(0, 10).map((r) => ({ id: r.id })),
          getRawAndEntities: {
            entities: rows.slice(0, 10),
            raw: rows
              .slice(0, 10)
              .map((r) => ({ kb_id: r.id, docCount: '0', chunkCount: '0' })),
          },
        }),
      );
      pinRepoMock.find.mockResolvedValue([]);
      favoriteRepoMock.find.mockResolvedValue([]);
      const page1 = await service.list(1, 10, { id: userId, role: "admin" } as never, 'all');
      const qb = kbRepoMock.createQueryBuilder.mock.results[0].value;
      expect(qb.limit).toHaveBeenCalledWith(10);
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(page1.items).toHaveLength(10);
      expect(page1.total).toBe(11);
      // 第 2 页：offset=10，只剩 1 条
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 11,
          getRawMany: rows.slice(10).map((r) => ({ id: r.id })),
          getRawAndEntities: {
            entities: rows.slice(10),
            raw: rows
              .slice(10)
              .map((r) => ({ kb_id: r.id, docCount: '0', chunkCount: '0' })),
          },
        }),
      );
      const page2 = await service.list(2, 10, { id: userId, role: 'admin' } as never, 'all');
      // createQueryBuilder 每次 list 调用两次（主查询 + 实体查询），第 2 次 list 的
      // 主查询在下标 2（下标 0/1 属于第 1 次 list）
      const qb2 = kbRepoMock.createQueryBuilder.mock.results[2].value;
      expect(qb2.offset).toHaveBeenCalledWith(10);
      expect(page2.items.map((i) => i.id)).toEqual(['kb-10']);
    });

    it('view=mine：WHERE creatorId=当前用户', async () => {
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 1,
          getRawMany: [{ id: 'a' }],
          getRawAndEntities: {
            entities: [makeKb('a', 'A 库', now)],
            raw: [{ kb_id: 'a', docCount: '0', chunkCount: '0' }],
          },
        }),
      );
      pinRepoMock.find.mockResolvedValue([]);
      favoriteRepoMock.find.mockResolvedValue([]);
      const result = await service.list(1, 10, { id: userId, role: "admin" } as never, 'mine');
      const qb = kbRepoMock.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('kb."creatorId" = :userId', {
        userId,
      });
      // mine 视图不叠加置顶分组（子集语义）
      expect(qb.orderBy).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('view=favorite：无收藏 → 短路空结果（不查库）；有收藏 → WHERE id IN 收藏集合', async () => {
      // 无收藏：直接返回空，createQueryBuilder 不应被调用
      favoriteRepoMock.find.mockResolvedValue([]);
      pinRepoMock.find.mockResolvedValue([]);
      const empty = await service.list(1, 10, { id: userId, role: "admin" } as never, 'favorite');
      expect(empty.items).toHaveLength(0);
      expect(empty.total).toBe(0);
      expect(kbRepoMock.createQueryBuilder).not.toHaveBeenCalled();
      // 有收藏：where IN 收藏集合
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 1,
          getRawMany: [{ id: 'b' }],
          getRawAndEntities: {
            entities: [makeKb('b', 'B 库', now)],
            raw: [{ kb_id: 'b', docCount: '0', chunkCount: '0' }],
          },
        }),
      );
      favoriteRepoMock.find.mockResolvedValue([
        { userId, kbId: 'b' } as UserKbFavorite,
      ]);
      const result = await service.list(1, 10, { id: userId, role: "admin" } as never, 'favorite');
      const qb = kbRepoMock.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('kb.id IN (:...favIds)', {
        favIds: ['b'],
      });
      expect(result.items[0].id).toBe('b');
      expect(result.items[0].favorite).toBe(true);
    });

    it('view=recent：innerJoin user_kb_recents 并按 visitedAt 倒序', async () => {
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 2,
          getRawMany: [{ id: 'a' }, { id: 'b' }],
          getRawAndEntities: {
            entities: [makeKb('a', 'A 库', now), makeKb('b', 'B 库', now)],
            raw: [
              { kb_id: 'a', docCount: '0', chunkCount: '0' },
              { kb_id: 'b', docCount: '0', chunkCount: '0' },
            ],
          },
        }),
      );
      pinRepoMock.find.mockResolvedValue([]);
      favoriteRepoMock.find.mockResolvedValue([]);
      const result = await service.list(1, 10, { id: userId, role: "admin" } as never, 'recent');
      const qb = kbRepoMock.createQueryBuilder.mock.results[0].value;
      expect(qb.innerJoin).toHaveBeenCalledWith(
        UserKbRecent,
        'r',
        'r."kbId" = kb.id AND r."userId" = :userId',
        { userId },
      );
      // recent 视图排序语义：访问时间倒序（Task 1.10），不叠加置顶分组
      expect(qb.addOrderBy).toHaveBeenCalledWith('r."visitedAt"', 'DESC');
      expect(qb.orderBy).not.toHaveBeenCalled();
      expect(result.items.map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('非法 view 参数 → BadRequestException（服务层兜底，防绕过 DTO）', async () => {
      await expect(
        service.list(1, 10, { id: userId, role: "admin" } as never, 'invalid' as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('列表项装配 docCount/chunkCount（从 raw 聚合列，缺省兜底 0）', async () => {
      kbRepoMock.createQueryBuilder.mockImplementation(() =>
        makeQb({
          getCount: 2,
          getRawMany: [{ id: 'a' }, { id: 'b' }],
          getRawAndEntities: {
            entities: [makeKb('a', 'A 库', now), makeKb('b', 'B 库', now)],
            raw: [
              { kb_id: 'a', docCount: '1', chunkCount: '4' },
              // b 无文档无分块：raw 里计数为 null（COUNT 无匹配行返回 0，这里模拟）
              { kb_id: 'b', docCount: '0', chunkCount: '0' },
            ],
          },
        }),
      );
      pinRepoMock.find.mockResolvedValue([]);
      favoriteRepoMock.find.mockResolvedValue([]);
      const result = await service.list(1, 10, { id: userId, role: "admin" } as never, 'all');
      expect(result.items[0].docCount).toBe(1);
      expect(result.items[0].chunkCount).toBe(4);
      expect(result.items[1].docCount).toBe(0);
      expect(result.items[1].chunkCount).toBe(0);
    });
  });

  describe('toggleFavorite / recordVisit / stats（Task 1.10）', () => {
    it('toggleFavorite：未收藏 → 收藏（返回 { favorite: true } 并写入记录）', async () => {
      kbRepoMock.findOne.mockResolvedValue(makeKb('f', '收藏', now));
      favoriteRepoMock.findOne.mockResolvedValue(null);
      const result = await service.toggleFavorite('f', userId);
      expect(result).toEqual({ favorite: true });
      expect(favoriteRepoMock.save).toHaveBeenCalledTimes(1);
      expect(favoriteRepoMock.delete).not.toHaveBeenCalled();
    });

    it('toggleFavorite：已收藏 → 取消（返回 { favorite: false } 并删除记录）', async () => {
      kbRepoMock.findOne.mockResolvedValue(makeKb('f', '收藏', now));
      favoriteRepoMock.findOne.mockResolvedValue({
        id: 'fav-1',
        userId,
        kbId: 'f',
      } as UserKbFavorite);
      const result = await service.toggleFavorite('f', userId);
      expect(result).toEqual({ favorite: false });
      expect(favoriteRepoMock.delete).toHaveBeenCalledWith({ id: 'fav-1' });
      expect(favoriteRepoMock.save).not.toHaveBeenCalled();
    });

    it('toggleFavorite：并发双收藏撞唯一约束 23505 → 幂等返回 { favorite: true }（不抛 500）', async () => {
      kbRepoMock.findOne.mockResolvedValue(makeKb('f', '收藏', now));
      favoriteRepoMock.findOne.mockResolvedValue(null);
      const uniqueViolation = new Error(
        'duplicate key value violates unique constraint',
      );
      (uniqueViolation as { driverError?: { code?: string } }).driverError = {
        code: '23505',
      };
      favoriteRepoMock.save.mockRejectedValueOnce(uniqueViolation);
      const result = await service.toggleFavorite('f', userId);
      expect(result).toEqual({ favorite: true });
    });

    it('recordVisit：upsert (userId, kbId) 且 visitedAt=now；不查存在性（404 由控制器 getById 先行保证）', async () => {
      await service.recordVisit('v', userId);
      expect(recentRepoMock.upsert).toHaveBeenCalledWith(
        {
          userId,
          kbId: 'v',
          visitedAt: expect.any(Date),
        },
        { conflictPaths: ['userId', 'kbId'] },
      );
      // 质量审查整改：recordVisit 不做存在性校验（详情 GET 已先 getById 校验，
      // 避免每次详情重复查询）；删除竞态下的孤儿行由 recent 视图 innerJoin
      // knowledge_bases（r."kbId" = kb.id）天然过滤，见 list/recordVisit 注释
      await service.recordVisit('missing', userId);
      expect(recentRepoMock.upsert).toHaveBeenCalledTimes(2);
    });

    it('stats：五组计数聚合（totalKbs/mine/favorite/totalDocs/totalChunks）', async () => {
      kbRepoMock.count
        .mockResolvedValueOnce(10) // totalKbs（全量）
        .mockResolvedValueOnce(4); // mine（creatorId=userId）
      favoriteRepoMock.count.mockResolvedValueOnce(2); // favorite
      kbRepoMock.manager.count
        .mockResolvedValueOnce(100) // totalDocs（knowledge 全量）
        .mockResolvedValueOnce(500); // totalChunks（chunks 全量）
      const result = await service.stats(userId);
      expect(result).toEqual({
        totalKbs: 10,
        mine: 4,
        favorite: 2,
        totalDocs: 100,
        totalChunks: 500,
      });
      // 统计口径：totalDocs/totalChunks 是全量（实体类计数），mine/favorite 按用户
      expect(kbRepoMock.manager.count).toHaveBeenNthCalledWith(1, Knowledge);
      expect(kbRepoMock.manager.count).toHaveBeenNthCalledWith(2, Chunk);
    });
  });

  it('duplicate：复制配置行，名称默认「原名称 副本」，creatorId 为当前用户', async () => {
    const source = makeKb('src', '源库', now, { chunkSize: 800 });
    kbRepoMock.findOne.mockResolvedValue(source);
    const result = await service.duplicate('src', userId);
    expect(kbRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '源库 副本',
        creatorId: userId,
        chunkingConfig: { chunkSize: 800 },
      }),
    );
    expect(result.name).toBe('源库 副本');
    expect(result.creatorId).toBe(userId);
    expect(result.chunkingConfig).toEqual({ chunkSize: 800 });
  });

  it('duplicate：传入 name 时覆盖默认「原名称 副本」', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('src', '源库', now));
    const result = await service.duplicate('src', userId, '自定义副本名');
    expect(result.name).toBe('自定义副本名');
  });

  it('duplicate/update/getById：知识库不存在返回 404', async () => {
    kbRepoMock.findOne.mockResolvedValue(null);
    await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
    await expect(service.duplicate('missing', userId)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.update('missing', { name: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('remove：级联删除在事务内执行（pins → favorites → recents → 文档行 → KB 行），磁盘目录在事务外清理', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('r', '待删', now));
    await service.remove('r');
    // 事务回调被调用，且删除动作走 manager 而非仓库（事务内提交/回滚一体）
    expect(dataSourceMock.transaction).toHaveBeenCalledTimes(1);
    // 删除顺序：pins/favorites/recents 先于 KB 行（先清子表后删主表）；
    // 文档行经 KnowledgeService 在事务内删除
    const order = managerMock.delete.mock.invocationCallOrder;
    expect(order[0]).toBeLessThan(order[3]);
    expect(managerMock.delete).toHaveBeenNthCalledWith(1, UserKbPin, {
      kbId: 'r',
    });
    expect(managerMock.delete).toHaveBeenNthCalledWith(2, UserKbFavorite, {
      kbId: 'r',
    });
    expect(managerMock.delete).toHaveBeenNthCalledWith(3, UserKbRecent, {
      kbId: 'r',
    });
    expect(managerMock.delete).toHaveBeenNthCalledWith(4, KnowledgeBase, {
      id: 'r',
    });
    // 文档行删除经 KnowledgeService.removeByKbInTx（EntityManager 事务内，服务解耦）
    expect(knowledgeServiceMock.removeByKbInTx).toHaveBeenCalledWith(
      managerMock,
      'r',
    );
    // 磁盘目录清理在事务提交之后（fs 不可回滚，放事务外）
    expect(storageMock.removeKbDirectory).toHaveBeenCalledWith('r');
    expect(
      storageMock.removeKbDirectory.mock.invocationCallOrder[0],
    ).toBeGreaterThan(dataSourceMock.transaction.mock.invocationCallOrder[0]);
    // 图谱子图清理在事务提交之后（Task 3.2 质量审查整改：清空该 KB 的
    // 实体/边/chunk 镜像，失败仅记日志——与磁盘目录同一 best-effort 约定）
    expect(graphRepoMock.deleteKbSubgraph).toHaveBeenCalledWith('r');
    expect(
      graphRepoMock.deleteKbSubgraph.mock.invocationCallOrder[0],
    ).toBeGreaterThan(dataSourceMock.transaction.mock.invocationCallOrder[0]);
    // 仓库级 delete 不应再被直接调用（避免绕过事务）
    expect(pinRepoMock.delete).not.toHaveBeenCalled();
    expect(kbRepoMock.delete).not.toHaveBeenCalled();
  });

  it('togglePin：未置顶 → 置顶（返回 pinned=true 并写入记录）', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('t', '切换', now));
    pinRepoMock.findOne.mockResolvedValue(null);
    const result = await service.togglePin('t', userId);
    expect(result).toEqual({ pinned: true });
    expect(pinRepoMock.save).toHaveBeenCalledTimes(1);
    expect(pinRepoMock.delete).not.toHaveBeenCalled();
  });

  it('togglePin：已置顶 → 取消（返回 pinned=false 并删除记录）', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('t', '切换', now));
    pinRepoMock.findOne.mockResolvedValue({
      id: 'pin-1',
      userId,
      kbId: 't',
    } as UserKbPin);
    const result = await service.togglePin('t', userId);
    expect(result).toEqual({ pinned: false });
    expect(pinRepoMock.delete).toHaveBeenCalledWith({ id: 'pin-1' });
    expect(pinRepoMock.save).not.toHaveBeenCalled();
  });

  it('togglePin：并发双置顶撞唯一约束 23505 → 幂等返回 pinned=true（不抛 500）', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('t', '切换', now));
    pinRepoMock.findOne.mockResolvedValue(null);
    // 另一并发请求已抢先写入 → save 撞 (userId, kbId) 唯一约束
    const uniqueViolation = new Error(
      'duplicate key value violates unique constraint',
    );
    (uniqueViolation as { driverError?: { code?: string } }).driverError = {
      code: '23505',
    };
    pinRepoMock.save.mockRejectedValueOnce(uniqueViolation);
    const result = await service.togglePin('t', userId);
    // 撞约束即已置顶：幂等返回，不把竞态升级成 500
    expect(result).toEqual({ pinned: true });
  });

  it('togglePin：撞 23505 之外的错误照常抛出（不吞异常）', async () => {
    kbRepoMock.findOne.mockResolvedValue(makeKb('t', '切换', now));
    pinRepoMock.findOne.mockResolvedValue(null);
    const other = new Error('connection lost');
    pinRepoMock.save.mockRejectedValueOnce(other);
    await expect(service.togglePin('t', userId)).rejects.toThrow(
      'connection lost',
    );
  });
});

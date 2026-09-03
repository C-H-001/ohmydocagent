// SessionService 单元测试（Task 2.1）：mock 仓库 + DataSource，覆盖——
// create：默认标题「新会话」+ kbIds 缺省空数组 + 归属用户；
// 归属权限：getById/update/remove/clearMessages/listMessages 对他人会话 403、
// 不存在 404（含非 UUID 22P02 兜底转 404）；
// update：pinned=true 写入 pinnedAt、false 清空、未传 pinned 不触碰、
// 空更新 {} 不调用 save（不刷新 updatedAt，避免列表跳顶）；
// remove/removeBatch/clearMessages：事务内先删 messages 再删会话/清消息；
// removeBatch：宽容语义（只删本人的、返回 deleted 数）；
// list：置顶优先 + updatedAt DESC + id 决胜键、messageCount 聚合装配。
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';
import { SessionService } from './session.service.js';

/** 构造可链式调用的 query builder mock（对齐 KbService.spec 的 makeQb 模式） */
function makeQb(
  overrides: {
    getCount?: number;
    getRawMany?: Array<{ id: string }>;
    getRawAndEntities?: {
      entities: Session[];
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
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
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
    orderBy: ReturnType<typeof vi.fn>;
    addOrderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    offset: ReturnType<typeof vi.fn>;
    addSelect: ReturnType<typeof vi.fn>;
  };
}

/** 会话行工厂 */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-owner',
    title: '新会话',
    kbIds: [],
    pinned: false,
    pinnedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as Session;
}

describe('SessionService', () => {
  let service: SessionService;
  // 仓库 mock 用工厂函数返回对象字面量——类型从 vi.fn() 调用推断
  // （每个 delete/findOne 等都是带实现/默认 Procedure 的 Mock，可调用；
  // 若预声明 ReturnType<typeof vi.fn> 会解析成 Mock<Procedure|Constructable>
  // 联合导致 TS2348 不可调用）
  let sessionRepoMock: ReturnType<typeof makeRepos>['session'];
  let messageRepoMock: ReturnType<typeof makeRepos>['message'];
  const dataSourceMock = {
    transaction: vi.fn(async (fn: (manager: unknown) => Promise<unknown>) => {
      // 事务管理器 mock：delete 直接转发到对应仓库 mock
      const manager = {
        delete: vi.fn(async (entity: unknown, criteria: unknown) => {
          if (entity === Message) return messageRepoMock.delete(criteria);
          if (entity === Session) return sessionRepoMock.delete(criteria);
          return { affected: 1 };
        }),
      };
      return fn(manager);
    }),
  };

  /** 仓库 mock 工厂：beforeEach 重建，保证用例间无状态残留 */
  function makeRepos() {
    return {
      session: {
        create: vi.fn((data: Partial<Session>) => data),
        save: vi.fn(async (entity: Session) => entity),
        findOne: vi.fn(),
        find: vi.fn(),
        delete: vi.fn(async (_criteria: unknown) => ({ affected: 1 })),
        count: vi.fn(async () => 0),
        createQueryBuilder: vi.fn(),
      },
      message: {
        delete: vi.fn(async (_criteria: unknown) => ({ affected: 1 })),
      },
    };
  }

  beforeEach(() => {
    const repos = makeRepos();
    sessionRepoMock = repos.session;
    messageRepoMock = repos.message;
    vi.clearAllMocks();
  });

  // 在每个用例内重新构造（beforeEach 里 reset 后注入会丢失，改为惰性工厂）
  function createService() {
    return new SessionService(
      sessionRepoMock as never,
      messageRepoMock as never,
      dataSourceMock as unknown as DataSource,
    );
  }

  describe('create', () => {
    it('缺省 title/kbIds：默认「新会话」+ 空数组 + 归属当前用户', async () => {
      service = createService();
      const result = await service.create({}, 'user-owner');
      expect(sessionRepoMock.create).toHaveBeenCalledWith({
        title: '新会话',
        kbIds: [],
        userId: 'user-owner',
        pinned: false,
        pinnedAt: null,
      });
      expect(sessionRepoMock.save).toHaveBeenCalled();
      expect(result.title).toBe('新会话');
    });

    it('显式 title/kbIds：原样保存', async () => {
      service = createService();
      const result = await service.create(
        { title: '研发问答', kbIds: ['kb-1'] },
        'user-owner',
      );
      expect(result.title).toBe('研发问答');
      expect(result.kbIds).toEqual(['kb-1']);
    });
  });

  describe('归属权限（getById/update/remove/clearMessages/listMessages）', () => {
    it('他人会话 → 403（无权访问该会话）', async () => {
      sessionRepoMock.findOne.mockResolvedValue(
        makeSession({ userId: 'user-other' }),
      );
      service = createService();
      await expect(service.getById('s1', 'user-owner')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.update('s1', {}, 'user-owner')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove('s1', 'user-owner')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.clearMessages('s1', 'user-owner')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.listMessages('s1', 'user-owner', 1, 10),
      ).rejects.toThrow(ForbiddenException);
    });

    it('不存在 → 404（会话不存在）', async () => {
      sessionRepoMock.findOne.mockResolvedValue(null);
      service = createService();
      await expect(service.getById('s1', 'user-owner')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update('s1', {}, 'user-owner')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove('s1', 'user-owner')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.clearMessages('s1', 'user-owner')).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.listMessages('s1', 'user-owner', 1, 10),
      ).rejects.toThrow(NotFoundException);
    });

    it('非 UUID 格式 id：22P02 兜底转 404（不泄露 500）', async () => {
      const pgError = new Error('invalid input syntax for type uuid');
      (pgError as { driverError?: { code?: string } }).driverError = {
        code: '22P02',
      };
      sessionRepoMock.findOne.mockRejectedValue(pgError);
      service = createService();
      await expect(service.getById('not-a-uuid', 'user-owner')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update（pinned 语义）', () => {
    it('pinned=true：写入 pinnedAt（时间戳非空）', async () => {
      sessionRepoMock.findOne.mockResolvedValue(makeSession());
      service = createService();
      const result = await service.update('s1', { pinned: true }, 'user-owner');
      expect(result.pinned).toBe(true);
      expect(result.pinnedAt).toBeInstanceOf(Date);
    });

    it('pinned=false：清空 pinnedAt=null', async () => {
      sessionRepoMock.findOne.mockResolvedValue(
        makeSession({ pinned: true, pinnedAt: new Date() }),
      );
      service = createService();
      const result = await service.update(
        's1',
        { pinned: false },
        'user-owner',
      );
      expect(result.pinned).toBe(false);
      expect(result.pinnedAt).toBeNull();
    });

    it('未传 pinned：不触碰 pinnedAt（保持既有置顶状态）', async () => {
      sessionRepoMock.findOne.mockResolvedValue(
        makeSession({ pinned: true, pinnedAt: new Date('2025-01-02') }),
      );
      service = createService();
      const result = await service.update(
        's1',
        { title: '改名' },
        'user-owner',
      );
      expect(result.pinned).toBe(true);
      expect(result.pinnedAt).toEqual(new Date('2025-01-02'));
    });

    it('空更新 {}：不调用 save（避免刷新 updatedAt 使会话在列表跳顶）', async () => {
      sessionRepoMock.findOne.mockResolvedValue(makeSession());
      service = createService();
      const result = await service.update('s1', {}, 'user-owner');
      expect(sessionRepoMock.save).not.toHaveBeenCalled();
      expect(result.title).toBe('新会话');
      expect(result.updatedAt).toEqual(new Date('2025-01-01T00:00:00Z'));
    });
  });

  describe('remove / removeBatch / clearMessages（级联 + 宽容语义）', () => {
    it('removeBatch：只删本人的（跨用户 id 跳过），返回 deleted 数', async () => {
      sessionRepoMock.find.mockResolvedValue([
        makeSession({ id: 's-own-1' }),
        makeSession({ id: 's-own-2' }),
      ]);
      service = createService();
      const result = await service.removeBatch(
        ['s-own-1', 's-own-2', 's-other'],
        'user-owner',
      );
      expect(result.deleted).toBe(2);
      // 事务内删除限定在本人 id 集合（他人 id 未进入删除条件）
      expect(messageRepoMock.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.objectContaining({
            _type: 'in',
            _value: ['s-own-1', 's-own-2'],
          }),
        }),
      );
      expect(sessionRepoMock.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.objectContaining({
            _type: 'in',
            _value: ['s-own-1', 's-own-2'],
          }),
        }),
      );
    });

    it('removeBatch：ids 全是他人会话 → deleted=0（幂等，不报错）', async () => {
      sessionRepoMock.find.mockResolvedValue([]);
      service = createService();
      const result = await service.removeBatch(['s-other'], 'user-owner');
      expect(result.deleted).toBe(0);
      expect(messageRepoMock.delete).not.toHaveBeenCalled();
    });

    it('clearMessages：只删消息，不碰会话行', async () => {
      sessionRepoMock.findOne.mockResolvedValue(makeSession());
      service = createService();
      await service.clearMessages('s1', 'user-owner');
      expect(messageRepoMock.delete).toHaveBeenCalledWith({
        sessionId: 's1',
      });
      expect(sessionRepoMock.delete).not.toHaveBeenCalled();
    });
  });

  describe('list（置顶优先 + messageCount 聚合）', () => {
    it('按置顶优先 + updatedAt DESC + id 决胜键排序，装配 messageCount', async () => {
      const s1 = makeSession({ id: 's-pinned', pinned: true });
      const s2 = makeSession({ id: 's-normal' });
      const qb = makeQb({
        getCount: 2,
        getRawMany: [{ id: 's-pinned' }, { id: 's-normal' }],
        getRawAndEntities: {
          entities: [s1, s2],
          raw: [
            { s_id: 's-pinned', messageCount: '3' },
            { s_id: 's-normal', messageCount: '0' },
          ],
        },
      });
      sessionRepoMock.createQueryBuilder.mockReturnValue(qb);
      service = createService();
      const result = await service.list(1, 10, 'user-owner');
      expect(qb.orderBy).toHaveBeenCalledWith('s."pinned"', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('s."updatedAt"', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('s.id', 'ASC');
      expect(result.total).toBe(2);
      expect(result.items[0].id).toBe('s-pinned');
      expect(result.items[0].messageCount).toBe(3);
      expect(result.items[1].messageCount).toBe(0);
    });

    it('空列表：返回空 items 且 total 来自 count', async () => {
      const qb = makeQb({ getCount: 0, getRawMany: [] });
      sessionRepoMock.createQueryBuilder.mockReturnValue(qb);
      service = createService();
      const result = await service.list(1, 10, 'user-owner');
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});

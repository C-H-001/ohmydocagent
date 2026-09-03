// kb-access.service.spec.ts
// KB 访问权限服务核心路径单测：权限判定（Owner/创建者/个人共享/组织共享）+
// 可见性集合（列表过滤：只有被邀请/共享的人才能查看）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { KbAccessService } from './kb-access.service.js';

function setup() {
  const kbRepo = {
    findOne: vi.fn(),
    createQueryBuilder: vi.fn(),
  };
  const shareRepo = {
    createQueryBuilder: vi.fn(),
  };
  const service = new KbAccessService(kbRepo as never, shareRepo as never);
  return { service, kbRepo, shareRepo };
}

describe('KbAccessService.effectivePermission（单 KB 权限判定）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('系统 Owner 全权限（不管是否创建者/被共享）', async () => {
    const { service, kbRepo } = setup();
    kbRepo.findOne.mockResolvedValue({ id: 'kb1', creatorId: 'someone' });
    const perm = await service.effectivePermission(
      { id: 'owner', role: 'super' } as never,
      'kb1',
    );
    expect(perm).toBe('full');
  });

  it('KB 创建者全权限', async () => {
    const { service, kbRepo } = setup();
    kbRepo.findOne.mockResolvedValue({ id: 'kb1', creatorId: 'u1' });
    const perm = await service.effectivePermission(
      { id: 'u1', role: 'admin' } as never,
      'kb1',
    );
    expect(perm).toBe('full');
  });

  it('个人共享（share.userId=me）→ 共享权限档', async () => {
    const { service, kbRepo, shareRepo } = setup();
    kbRepo.findOne.mockResolvedValue({ id: 'kb1', creatorId: 'other' });
    const qb = {
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      select: () => qb,
      getRawMany: async () => [{ permission: 'view' }],
    };
    shareRepo.createQueryBuilder.mockReturnValue(qb);
    const perm = await service.effectivePermission(
      { id: 'u1', role: 'admin' } as never,
      'kb1',
    );
    expect(perm).toBe('view');
  });

  it('组织共享（所在组织被共享）→ 共享权限档', async () => {
    const { service, kbRepo, shareRepo } = setup();
    kbRepo.findOne.mockResolvedValue({ id: 'kb1', creatorId: 'other' });
    // leftJoin 组织成员命中 → 组织共享生效
    const qb = {
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      select: () => qb,
      getRawMany: async () => [{ permission: 'edit' }],
    };
    shareRepo.createQueryBuilder.mockReturnValue(qb);
    const perm = await service.effectivePermission(
      { id: 'u1', role: 'admin' } as never,
      'kb1',
    );
    expect(perm).toBe('edit');
  });

  it('非创建者非共享者 → null（无权）', async () => {
    const { service, kbRepo, shareRepo } = setup();
    kbRepo.findOne.mockResolvedValue({ id: 'kb1', creatorId: 'other' });
    const qb = {
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      select: () => qb,
      getRawMany: async () => [],
    };
    shareRepo.createQueryBuilder.mockReturnValue(qb);
    const perm = await service.effectivePermission(
      { id: 'u1', role: 'admin' } as never,
      'kb1',
    );
    expect(perm).toBeNull();
  });

  it('KB 不存在 → null（统一 404 语义）', async () => {
    const { service, kbRepo } = setup();
    kbRepo.findOne.mockResolvedValue(null);
    const perm = await service.effectivePermission(
      { id: 'u1', role: 'admin' } as never,
      'nope',
    );
    expect(perm).toBeNull();
  });
});

describe('KbAccessService.visibleKbIds（列表可见性：只有被邀请的人才能查看）', () => {
  it('普通用户：可见 = 我创建的 ∪ 个人共享 ∪ 组织共享', async () => {
    const { service, kbRepo, shareRepo } = setup();
    // 创建者查询
    kbRepo.createQueryBuilder.mockReturnValueOnce({
      select: () => ({
        where: () => ({
          getRawMany: async () => [{ id: 'my-kb' }],
        }),
      }),
    });
    // 共享查询（个人 + 组织）
    const qb = {
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      select: () => qb,
      getRawMany: async () => [
        { kbId: 'shared-personal' },
        { kbId: 'shared-org' },
      ],
    };
    shareRepo.createQueryBuilder.mockReturnValue(qb);
    const ids = await service.visibleKbIds({ id: 'u1', role: 'admin' } as never);
    expect([...ids!].sort()).toEqual(
      ['my-kb', 'shared-org', 'shared-personal'].sort(),
    );
  });

  it('系统 Owner → null（全可见，不限）', async () => {
    const { service, kbRepo } = setup();
    const ids = await service.visibleKbIds({
      id: 'owner',
      role: 'super',
    } as never);
    expect(ids).toBeNull();
    expect(kbRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('无创建无共享 → 空集合', async () => {
    const { service, kbRepo, shareRepo } = setup();
    kbRepo.createQueryBuilder.mockReturnValueOnce({
      select: () => ({ where: () => ({ getRawMany: async () => [] }) }),
    });
    const qb = {
      leftJoin: () => qb,
      where: () => qb,
      andWhere: () => qb,
      select: () => qb,
      getRawMany: async () => [],
    };
    shareRepo.createQueryBuilder.mockReturnValue(qb);
    const ids = await service.visibleKbIds({ id: 'u1', role: 'admin' } as never);
    expect(ids!.size).toBe(0);
  });
});

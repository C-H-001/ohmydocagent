// backend/src/modules/users/users.service.spec.ts
// UsersService 单元测试：mock 仓库与 DataSource，聚焦 Task 0.7 新增业务规则——
// list 分页脱敏、updateRole 唯一 Owner 不变量（幂等 200 / 双 Owner 400 / 无 Owner 400 /
// 自己 400 / 不存在 404 / 非 Owner 403）、transferOwnership 事务原子交换与并发兜底。
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { AuditService } from '../admin/audit/audit.service.js';
import { Role, User } from './user.entity.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  let service: UsersService;
  // 仓库 mock：findOne / findAndCount 按用例覆写
  const repoMock = {
    findOne: vi.fn(),
    findAndCount: vi.fn(),
  };
  // 事务 mock：createQueryBuilder 链（setLock/where/getMany）按用例返回 lockedRows
  let lockedRows: User[] = [];
  const qbMock = {
    setLock: vi.fn(function (this: unknown) {
      return this;
    }),
    where: vi.fn(function (this: unknown) {
      return this;
    }),
    getMany: vi.fn(async () => lockedRows),
  };
  const managerMock = {
    createQueryBuilder: vi.fn(() => qbMock),
    // save：transferOwnership 原子交换改走 manager.save（见 service 注释：@UpdateDateColumn
    // 生效的显式契约）；mock 原样返回实体，由用例断言传入实体的角色变化
    save: vi.fn(async (entities: unknown) => entities),
    update: vi.fn(async () => ({ affected: 1 })),
    findOneByOrFail: vi.fn(),
  };
  const dataSourceMock = {
    transaction: vi.fn(
      async (cb: (m: typeof managerMock) => Promise<unknown>) =>
        cb(managerMock),
    ),
  };

  const owner: User = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'owner@ohmydocagent.local',
    passwordHash: 'hash-owner',
    name: '所有者',
    avatarUrl: '',
    role: Role.Super,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const admin1: User = {
    ...owner,
    id: '22222222-2222-4222-8222-222222222222',
    email: 'admin1@ohmydocagent.local',
    name: '管理员甲',
    role: Role.Member,
  };
  const admin2: User = {
    ...owner,
    id: '33333333-3333-4333-8333-333333333333',
    email: 'admin2@ohmydocagent.local',
    name: '管理员乙',
    role: Role.Member,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repoMock },
        { provide: DataSource, useValue: dataSourceMock },
        // Task 4.4 审计（全局模块注入，单测需显式 provide mock）
        { provide: AuditService, useValue: { log: vi.fn() } },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('分页返回 { items, total, page, pageSize }，且 items 为脱敏公开形态（不含 passwordHash）', async () => {
      repoMock.findAndCount.mockResolvedValue([[admin1, admin2], 2]);
      const result = await service.list(1, 10);
      expect(result).toEqual({
        items: [
          expect.objectContaining({ id: admin1.id, email: admin1.email }),
          expect.objectContaining({ id: admin2.id, email: admin2.email }),
        ],
        total: 2,
        page: 1,
        pageSize: 10,
      });
      // 脱敏：任何条目都不含 passwordHash（PublicUser 类型本就无此字段，用 Record 断言运行时也不存在）
      for (const item of result.items) {
        expect((item as Record<string, unknown>).passwordHash).toBeUndefined();
      }
      // 分页参数正确透传给 findAndCount（skip/take 从 page/pageSize 推导）
      expect(repoMock.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
    });
  });

  describe('updateRole', () => {
    it('角色未变化时幂等返回（200 语义）：目标 Admin 设为 admin 直接返回公开用户，不落库', async () => {
      repoMock.findOne.mockResolvedValue(admin1);
      const result = await service.updateRole(admin1.id, Role.Member, owner);
      expect(result).toEqual(expect.objectContaining({ id: admin1.id }));
      expect((result as Record<string, unknown>).passwordHash).toBeUndefined();
      // 幂等路径不写库：repoMock 未提供 save/update，若服务尝试写库会直接 TypeError 使用例失败
      expect(repoMock.findOne).toHaveBeenCalledWith({
        where: { id: admin1.id },
      });
    });

    it('非 Owner 调用返回 403（服务层兜底，常规由 RolesGuard 先拦截）', async () => {
      await expect(
        service.updateRole(admin1.id, Role.Member, admin1),
      ).rejects.toThrow(ForbiddenException);
      expect(repoMock.findOne).not.toHaveBeenCalled();
    });

    it('目标用户不存在返回 404', async () => {
      repoMock.findOne.mockResolvedValue(null);
      await expect(
        service.updateRole(admin2.id, Role.Member, owner),
      ).rejects.toThrow(NotFoundException);
    });

    it('不能修改自己的角色返回 400', async () => {
      repoMock.findOne.mockResolvedValue(owner);
      await expect(
        service.updateRole(owner.id, Role.Member, owner),
      ).rejects.toThrow(BadRequestException);
    });

    it('把 Admin 提升为 Owner 返回 400（系统只能有一个 Owner，请走所有权转移）', async () => {
      repoMock.findOne.mockResolvedValue(admin1);
      await expect(
        service.updateRole(admin1.id, Role.Super, owner),
      ).rejects.toThrow(BadRequestException);
    });

    it('把唯一 Owner 降级为 Admin 返回 400（系统必须保留一个 Owner）', async () => {
      repoMock.findOne.mockResolvedValue(owner);
      await expect(
        service.updateRole(owner.id, Role.Member, owner),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('transferOwnership', () => {
    beforeEach(() => {
      lockedRows = [];
    });

    it('非 Owner 调用返回 403（事务外前置校验）', async () => {
      await expect(
        service.transferOwnership(admin2.id, admin1),
      ).rejects.toThrow(ForbiddenException);
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });

    it('转移给自己返回 400（事务外前置校验）', async () => {
      await expect(service.transferOwnership(owner.id, owner)).rejects.toThrow(
        BadRequestException,
      );
      expect(dataSourceMock.transaction).not.toHaveBeenCalled();
    });

    it('目标用户不存在返回 404（事务内行锁读取后判定）', async () => {
      // 事务内 FOR UPDATE 只锁到 actor 一行（目标不存在）
      lockedRows = [owner];
      await expect(service.transferOwnership(admin2.id, owner)).rejects.toThrow(
        NotFoundException,
      );
      // 校验行锁策略：pessimistic_write + 两个候选 id
      expect(managerMock.createQueryBuilder).toHaveBeenCalledWith(User, 'user');
      expect(qbMock.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(qbMock.where).toHaveBeenCalledWith('user.id IN (:...ids)', {
        ids: [owner.id, admin2.id],
      });
    });

    it('目标已是 Owner 返回 400（重复转移/竞态兜底）', async () => {
      lockedRows = [owner, { ...owner, id: admin2.id }];
      await expect(service.transferOwnership(admin2.id, owner)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('事务内重读发现原 Owner 已降级返回 403（并发转移兜底：后执行者被拒）', async () => {
      // 模拟并发：另一事务先提交，原 Owner 已变 admin；本事务 FOR UPDATE 重读拿到降级后角色
      lockedRows = [{ ...owner, role: Role.Member }, admin2];
      await expect(service.transferOwnership(admin2.id, owner)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('Owner→Admin 事务内原子交换角色，返回 { previousOwner, newOwner } 公开形态', async () => {
      // 用副本避免污染共享 fixture：save 会原地改传入实体的 role（真实代码同样如此），
      // 若直接传共享的 owner/admin2 常量，后续用例（toPublicUser 等）会读到被改脏的角色
      lockedRows = [{ ...owner }, { ...admin2 }];
      managerMock.findOneByOrFail
        .mockResolvedValueOnce({ ...owner, role: Role.Member })
        .mockResolvedValueOnce({ ...owner, ...admin2, role: Role.Super });
      const result = await service.transferOwnership(admin2.id, owner);
      // 角色原子交换：原 Owner → admin，目标 → owner（save 收到的是已改角色的实体）
      expect(managerMock.save).toHaveBeenCalledTimes(1);
      const saved = managerMock.save.mock.calls[0][0] as User[];
      expect(saved.map((u) => ({ id: u.id, role: u.role }))).toEqual([
        { id: owner.id, role: Role.Member },
        { id: admin2.id, role: Role.Super },
      ]);
      expect(result.previousOwner).toEqual(
        expect.objectContaining({ id: owner.id, role: Role.Member }),
      );
      expect(result.newOwner).toEqual(
        expect.objectContaining({ id: admin2.id, role: Role.Super }),
      );
      expect(
        (result.previousOwner as Record<string, unknown>).passwordHash,
      ).toBeUndefined();
      expect(
        (result.newOwner as Record<string, unknown>).passwordHash,
      ).toBeUndefined();
    });
  });

  describe('toPublicUser', () => {
    it('脱敏：返回字段不含 passwordHash，其余字段原样保留', () => {
      const result = service.toPublicUser(owner);
      expect(result).toEqual(
        expect.objectContaining({
          id: owner.id,
          email: owner.email,
          name: owner.name,
          role: Role.Super,
        }),
      );
      expect((result as Record<string, unknown>).passwordHash).toBeUndefined();
    });
  });
});

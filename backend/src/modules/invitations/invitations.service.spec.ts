// backend/src/modules/invitations/invitations.service.spec.ts
// InvitationsService 单元测试：mock 仓库/UsersService/Config，聚焦业务规则
// （创建冲突、token 生成、列表脱敏、撤销、lookup 校验、consume 原子性）
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AuditService } from '../admin/audit/audit.service.js';
import { Role } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { Invitation } from './invitation.entity.js';
import { InvitationsService } from './invitations.service.js';

describe('InvitationsService', () => {
  let service: InvitationsService;
  const mockRepo = {
    findOne: vi.fn(),
    findAndCount: vi.fn(),
    save: vi.fn((e: Invitation) => e),
    create: vi.fn((e: Partial<Invitation>) => e),
    // 默认删除命中 1 行（revoke 成功分支）；affected=0 / 22P02 的用例用 mockResolvedValueOnce 覆盖
    delete: vi.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: vi.fn(),
  };
  const mockUsers = { findByEmail: vi.fn() };
  const mockConfig = {
    get: vi.fn((k: string) => (k === 'invite.ttlDays' ? 7 : undefined)),
  };

  /** 构造一个有效（未使用、未过期）的邀请实体 */
  function validInvitation(overrides: Partial<Invitation> = {}): Invitation {
    return {
      id: 'inv-1',
      email: 'invitee@a.b',
      role: Role.Member,
      token: 'a'.repeat(64),
      used: false,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      createdById: 'u-owner',
      createdAt: new Date(),
      ...overrides,
    } as Invitation;
  }

  /** 构造 consume 的 manager mock：createQueryBuilder 返回可链式调用的 update qb */
  function buildManagerMock(result: unknown) {
    const qb: any = { execute: vi.fn().mockResolvedValue(result) };
    qb.update = vi.fn(() => qb);
    qb.set = vi.fn(() => qb);
    qb.where = vi.fn(() => qb);
    qb.returning = vi.fn(() => qb);
    return {
      createQueryBuilder: vi.fn(() => qb),
      qb,
      manager: { createQueryBuilder: vi.fn(() => qb) },
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: 'InvitationRepository', useValue: mockRepo },
        { provide: UsersService, useValue: mockUsers },
        { provide: ConfigService, useValue: mockConfig },
        // Task 4.4 审计（全局模块注入，单测需显式 provide mock）
        { provide: AuditService, useValue: { log: vi.fn() } },
      ],
    }).compile();
    service = moduleRef.get(InvitationsService);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create 目标邮箱已注册抛 ConflictException', async () => {
    mockUsers.findByEmail.mockResolvedValue({ id: 'u1', email: 'invitee@a.b' });
    await expect(
      service.create({ email: 'invitee@a.b' }, 'u-owner'),
    ).rejects.toBeInstanceOf(ConflictException);
    // 已注册时不得继续创建邀请
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('create 同邮箱已有待使用邀请抛 ConflictException（过期/已使用不阻塞）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockRepo.findOne.mockResolvedValue(validInvitation());
    await expect(
      service.create({ email: 'invitee@a.b' }, 'u-owner'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create 成功：生成 64 位 hex token、默认 admin、过期时间为 now+7 天', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockRepo.findOne.mockResolvedValue(null);
    const before = Date.now();
    const invitation = await service.create(
      { email: 'invitee@a.b' },
      'u-owner',
    );
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation.role).toBe(Role.Member);
    expect(invitation.used).toBe(false);
    expect(invitation.createdById).toBe('u-owner');
    // 默认 TTL 7 天：过期时间落在 [now+7d-2s, now+7d+2s] 区间。上界带 2s 容差：
    // create 内部会在 await 边界重新取 Date.now()（用于计算过期时间），async 调度下
    // 时钟可能比 before 快 1ms+，上界零容差会偶发时钟竞态导致 flaky（Task 0.6 规范审查整改）。
    const ttlMs = 7 * 24 * 3600 * 1000;
    expect(invitation.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + ttlMs - 2000,
    );
    expect(invitation.expiresAt.getTime()).toBeLessThanOrEqual(
      before + ttlMs + 2000,
    );
  });

  it('create role=owner 被拒（400：Owner 不能通过邀请产生）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockRepo.findOne.mockResolvedValue(null);
    await expect(
      service.create({ email: 'invitee@a.b', role: Role.Super }, 'u-owner'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list 分页返回脱敏 tokenPreview 与状态字段（不暴露完整 token）', async () => {
    mockRepo.findAndCount.mockResolvedValue([
      [
        validInvitation({
          id: 'inv-1',
          token:
            'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        }),
        validInvitation({ id: 'inv-2', used: true }),
        validInvitation({
          id: 'inv-3',
          expiresAt: new Date(Date.now() - 1000),
        }),
      ],
      3,
    ]);
    const result = await service.list(1, 10);
    expect(result.total).toBe(3);
    expect(result.items[0].tokenPreview).toBe('••••567890');
    // 列表结构不暴露完整 token（InvitationListItem 无 token 字段）
    expect(result.items[0]).not.toHaveProperty('token');
    expect(result.items[0].status).toBe('valid');
    expect(result.items[1].status).toBe('used');
    expect(result.items[2].status).toBe('expired');
    // 分页参数透传
    expect(mockRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    );
  });

  it('revoke 撤销即删除（删除后 token 立即失效）', async () => {
    await service.revoke('inv-1');
    expect(mockRepo.delete).toHaveBeenCalledWith({ id: 'inv-1' });
  });

  it('revoke 不存在的邀请抛 NotFoundException（affected=0）', async () => {
    mockRepo.delete.mockResolvedValueOnce({ affected: 0 });
    await expect(service.revoke('inv-missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revoke 非 UUID 格式 id（PG 22P02）抛 NotFoundException，不泄露内部错误', async () => {
    mockRepo.delete.mockRejectedValueOnce({ driverError: { code: '22P02' } });
    await expect(service.revoke('not-a-uuid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('create 存在过期未使用旧邀请：先清理残留再插入（保持「过期不阻塞重新邀请」）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockRepo.findOne.mockResolvedValue(
      validInvitation({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const qb: any = {
      execute: vi.fn().mockResolvedValue({ affected: 1 }),
    };
    qb.delete = vi.fn(() => qb);
    qb.where = vi.fn(() => qb);
    mockRepo.createQueryBuilder.mockReturnValue(qb);
    const invitation = await service.create(
      { email: 'invitee@a.b' },
      'u-owner',
    );
    // 删除条件仅限过期未使用残留（不碰有效邀请）
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('"expiresAt" <= now()'),
      { email: 'invitee@a.b' },
    );
    expect(mockRepo.save).toHaveBeenCalled();
    expect(invitation.email).toBe('invitee@a.b');
  });

  it('create 并发兜底：插入撞 partial unique index（23505）抛 ConflictException（M1 同款）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockRepo.findOne.mockResolvedValue(null);
    mockRepo.save.mockRejectedValueOnce({ driverError: { code: '23505' } });
    await expect(
      service.create({ email: 'invitee@a.b' }, 'u-owner'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lookup 无效/已使用/过期 token 抛 BadRequestException', async () => {
    mockRepo.findOne.mockResolvedValue(null); // 不存在
    await expect(service.lookup('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    mockRepo.findOne.mockResolvedValue(validInvitation({ used: true })); // 已使用
    await expect(service.lookup('used')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    mockRepo.findOne.mockResolvedValue(
      validInvitation({ expiresAt: new Date(Date.now() - 1000) }), // 已过期
    );
    await expect(service.lookup('expired')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lookup 有效 token 返回 email/role/expiresAt（不返回 token 本身）', async () => {
    mockRepo.findOne.mockResolvedValue(validInvitation());
    const result = await service.lookup('a'.repeat(64));
    expect(result).toEqual({
      email: 'invitee@a.b',
      role: Role.Member,
      expiresAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty('token');
  });

  it('consume affected=0 抛 BadRequestException（并发双用/过期/邮箱不匹配均落入此分支）', async () => {
    const { manager } = buildManagerMock({ affected: 0, raw: [] });
    await expect(
      service.consume('tok', 'invitee@a.b', manager as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('consume affected=1 原子 UPDATE used=true（WHERE 含 used=false/email/未过期）并返回行', async () => {
    const row = validInvitation({ id: 'inv-1', token: 'tok', used: true });
    const { manager, qb } = buildManagerMock({ affected: 1, raw: [row] });
    const result = await service.consume(
      'tok',
      'invitee@a.b',
      manager as never,
    );
    expect(qb.update).toHaveBeenCalledWith(Invitation);
    expect(qb.set).toHaveBeenCalledWith({ used: true });
    // 原子条件：token 匹配、未使用、邮箱绑定一致、未过期（MoreThan 运算符，断言其类型标记）
    expect(qb.where).toHaveBeenCalledWith({
      token: 'tok',
      used: false,
      email: 'invitee@a.b',
      expiresAt: expect.objectContaining({ _type: 'moreThan' }),
    });
    expect(qb.returning).toHaveBeenCalledWith('*');
    expect(result).toEqual(row);
  });
});

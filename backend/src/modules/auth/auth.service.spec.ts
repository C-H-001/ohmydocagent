// backend/src/modules/auth/auth.service.spec.ts
// AuthService 单元测试：mock DB/Redis/JWT，聚焦业务分支（查重冲突、密码校验、刷新旋转、邀请注册）
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { RedisService } from '../../redis/redis.service.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { Role, User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

// I2 验证需要断言 bcrypt.compare 的调用参数（占位哈希），但 vitest 无法对
// ESM namespace 直接 spyOn（module namespace 不可配置）；改为部分 mock：
// compare 包装为 spy（默认仍走真实 bcrypt 实现），其余导出保持原样
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return { ...actual, compare: vi.fn(actual.compare) };
});

describe('AuthService', () => {
  let service: AuthService;
  const mockUsers = {
    findByEmail: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    exists: vi.fn(),
    // 与真实实现一致的脱敏逻辑
    toPublicUser: vi.fn((u: User) => {
      const { passwordHash: _passwordHash, ...rest } = u;
      return rest;
    }),
  };
  const mockJwt = { signAsync: vi.fn(), verifyAsync: vi.fn() };
  // getClient().eval 用于 refresh 的原子旋转（Lua 脚本，见 auth.service.ts ROTATE_SCRIPT）
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    getClient: vi.fn(),
  };
  // 邀请模块：lookup 转发用；consume 由 registerByInvite 在事务内调用
  const mockInvitations = {
    lookup: vi.fn(),
    consume: vi.fn(),
  };
  // DataSource.transaction：直接回调 mock manager（consume/create 均为 mock，无需真实 SQL）
  const mockManager = {};
  const mockDataSource = {
    transaction: vi.fn(
      async (cb: (m: typeof mockManager) => Promise<unknown>) =>
        cb(mockManager),
    ),
  };
  const mockConfig = {
    get: vi.fn((key: string) => {
      if (key === 'jwt.expiresIn') return '2h';
      if (key === 'jwt.refreshExpiresIn') return '7d';
      if (key === 'auth.defaultRole') return Role.Member;
      return 'secret';
    }),
    getOrThrow: vi.fn((key: string) => {
      if (key === 'jwt.secret') return 'secret';
      return 'secret';
    }),
  };

  // 真实 bcrypt 哈希（低轮数仅测试用），用于登录密码比对分支
  let userWithHash: User;
  let publicUser: Omit<User, 'passwordHash'>;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test123456', 4);
    userWithHash = {
      id: 'u1',
      email: 'a@b.c',
      passwordHash: hash,
      name: '张三',
      avatarUrl: '',
      role: Role.Member,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    publicUser = { ...userWithHash };
    delete (publicUser as Partial<User>).passwordHash;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUsers.toPublicUser.mockImplementation((u: User) => {
      const { passwordHash: _passwordHash, ...rest } = u;
      return rest;
    });
    mockJwt.signAsync.mockResolvedValue('signed-token');
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'u1', jti: 'j1' });
    // 默认：refresh 原子旋转脚本返回 1（存在且已删除）
    mockRedis.getClient.mockReturnValue({ eval: vi.fn().mockResolvedValue(1) });

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsers },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: RedisService, useValue: mockRedis },
        { provide: InvitationsService, useValue: mockInvitations },
        { provide: DataSource, useValue: mockDataSource },
        // Task 4.4 审计（全局模块注入，单测需显式 provide mock）：log 为
        // 非关键路径（内部吞错），此处 mock 断言调用即可
        { provide: AuditService, useValue: { log: vi.fn() } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('register 重复邮箱抛 ConflictException', async () => {
    mockUsers.findByEmail.mockResolvedValue(userWithHash);
    await expect(
      service.register({
        email: 'a@b.c',
        password: 'Test123456',
        name: '张三',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register 成功时创建默认 Admin 角色并返回脱敏用户', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockUsers.create.mockResolvedValue(userWithHash);
    const result = await service.register({
      email: 'a@b.c',
      password: 'Test123456',
      name: '张三',
    });
    expect(mockUsers.create).toHaveBeenCalledWith(
      'a@b.c',
      'Test123456',
      '张三',
      Role.Member,
    );
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user).toEqual(publicUser);
  });

  it('register 邮箱规范化：trim + 小写后再查重/入库（M2）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockUsers.create.mockResolvedValue(userWithHash);
    await service.register({
      email: '  A@B.C  ',
      password: 'Test123456',
      name: '张三',
    });
    expect(mockUsers.findByEmail).toHaveBeenCalledWith('a@b.c');
    expect(mockUsers.create).toHaveBeenCalledWith(
      'a@b.c',
      expect.any(String),
      '张三',
      expect.any(String),
    );
  });

  it('register 并发撞 PG 唯一约束（23505）转 409（M1）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    mockUsers.create.mockRejectedValue({
      driverError: { code: '23505' },
    });
    await expect(
      service.register({
        email: 'a@b.c',
        password: 'Test123456',
        name: '张三',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('login 密码错误抛 UnauthorizedException（统一错误消息）', async () => {
    mockUsers.findByEmail.mockResolvedValue(userWithHash);
    await expect(
      service.login({ email: 'a@b.c', password: 'WrongPass123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('login 用户不存在时也对占位哈希执行 bcrypt.compare（I2 计时均衡）', async () => {
    mockUsers.findByEmail.mockResolvedValue(null);
    const compareMock = vi.mocked(bcrypt.compare);
    await expect(
      service.login({ email: 'ghost@x.io', password: 'Whatever123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // 用户不存在时仍执行了一次真实 bcrypt 比对，且目标必须是真实 bcrypt 格式的占位哈希
    expect(compareMock).toHaveBeenCalledWith(
      'Whatever123',
      expect.stringMatching(/^\$2[aby]\$/),
    );
  });

  it('login 邮箱规范化：trim + 小写后再查库（M2）', async () => {
    mockUsers.findByEmail.mockResolvedValue(userWithHash);
    await expect(
      service.login({ email: '  A@B.C  ', password: 'WrongPass123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockUsers.findByEmail).toHaveBeenCalledWith('a@b.c');
  });

  it('login 凭证正确返回 token 并写入 Redis jti', async () => {
    mockUsers.findByEmail.mockResolvedValue(userWithHash);
    const result = await service.login({
      email: 'a@b.c',
      password: 'Test123456',
    });
    expect(result.accessToken).toBeDefined();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^rt:u1:/),
      '1',
      604800,
    );
  });

  it('refresh 时 Redis 中 jti 已失效（旋转脚本返回 0）抛 UnauthorizedException', async () => {
    mockRedis.getClient.mockReturnValue({ eval: vi.fn().mockResolvedValue(0) });
    await expect(
      service.refresh({ refreshToken: 'old-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refresh 成功时通过 Lua 原子旋转删除旧 jti 并签发新 token（C1）', async () => {
    mockUsers.findById.mockResolvedValue(userWithHash);
    const result = await service.refresh({ refreshToken: 'old-token' });
    // 原子「校验存在 → 删除」：脚本返回 1，且以 rt:{sub}:{jti} 为唯一 KEYS
    expect(mockRedis.getClient().eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'rt:u1:j1',
    );
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it('refresh 的 refreshToken 缺 jti 直接 401（M5）', async () => {
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'u1' } as never);
    await expect(
      service.refresh({ refreshToken: 'no-jti-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refresh 的 refreshToken 缺 sub 直接 401（M5）', async () => {
    mockJwt.verifyAsync.mockResolvedValue({ jti: 'j1' } as never);
    await expect(
      service.refresh({ refreshToken: 'no-sub-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout 删除 Redis 中的 jti（幂等）', async () => {
    await service.logout({ refreshToken: 'some-token' });
    expect(mockRedis.del).toHaveBeenCalledWith('rt:u1:j1');
  });

  it('isInitialized 无用户时返回 false（首次部署）', async () => {
    mockUsers.exists.mockResolvedValue(false);
    await expect(service.isInitialized()).resolves.toBe(false);
  });

  it('isInitialized 已有用户时返回 true', async () => {
    mockUsers.exists.mockResolvedValue(true);
    await expect(service.isInitialized()).resolves.toBe(true);
  });

  it('init 已初始化时抛 ConflictException（系统已初始化）', async () => {
    mockUsers.exists.mockResolvedValue(true);
    await expect(
      service.init({
        email: 'owner@ohmydocagent.local',
        password: 'Owner123456',
        name: '所有者',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // 已初始化时不得创建任何用户
    expect(mockUsers.create).not.toHaveBeenCalled();
  });

  it('init 无用户时创建 Owner 角色并返回 token（不走注册默认 Admin 逻辑）', async () => {
    mockUsers.exists.mockResolvedValue(false);
    mockUsers.create.mockResolvedValue(userWithHash);
    const result = await service.init({
      email: 'owner@ohmydocagent.local',
      password: 'Owner123456',
      name: '所有者',
    });
    // 关键：角色必须显式为 Owner，而非注册的默认 Admin
    expect(mockUsers.create).toHaveBeenCalledWith(
      'owner@ohmydocagent.local',
      'Owner123456',
      '所有者',
      Role.Super,
    );
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user).toEqual(publicUser);
  });

  it('init 邮箱规范化：trim + 小写后再入库（M2）', async () => {
    mockUsers.exists.mockResolvedValue(false);
    mockUsers.create.mockResolvedValue(userWithHash);
    await service.init({
      email: '  Owner@OhMyDocAgent.LOCAL  ',
      password: 'Owner123456',
      name: '所有者',
    });
    expect(mockUsers.create).toHaveBeenCalledWith(
      'owner@ohmydocagent.local',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('init 并发撞 PG 唯一约束（23505）转 409 系统已初始化（并发初始化兜底）', async () => {
    // 两个 init 同时通过 isInitialized 检查后，后落库者撞 email 唯一约束 → 409
    mockUsers.exists.mockResolvedValue(false);
    mockUsers.create.mockRejectedValue({
      driverError: { code: '23505' },
    });
    await expect(
      service.init({
        email: 'owner@ohmydocagent.local',
        password: 'Owner123456',
        name: '所有者',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lookupInvitation 转发 invitationsService.lookup（不在此层做业务）', async () => {
    mockInvitations.lookup.mockResolvedValue({
      email: 'invitee@a.b',
      role: Role.Member,
      expiresAt: new Date('2099-01-01'),
    });
    await expect(
      service.lookupInvitation({ token: 'tok-1' }),
    ).resolves.toMatchObject({
      email: 'invitee@a.b',
      role: Role.Member,
    });
    expect(mockInvitations.lookup).toHaveBeenCalledWith('tok-1');
  });

  it('registerByInvite 有效邀请：事务内原子消费 + 创建用户（角色=邀请角色）+ 签发 token', async () => {
    mockInvitations.consume.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@a.b',
      role: Role.Member,
      token: 'tok-1',
    });
    mockUsers.create.mockResolvedValue(userWithHash);
    const result = await service.registerByInvite({
      token: 'tok-1',
      email: 'invitee@a.b',
      password: 'Invite123456',
      name: '受邀用户',
    });
    // 事务内先 consume（原子防并发双用），后 create（角色来自邀请而非默认值）
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    expect(mockInvitations.consume).toHaveBeenCalledWith(
      'tok-1',
      'invitee@a.b',
      mockManager,
    );
    expect(mockUsers.create).toHaveBeenCalledWith(
      'invitee@a.b',
      'Invite123456',
      '受邀用户',
      Role.Member,
      mockManager,
    );
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user).toEqual(publicUser);
  });

  it('registerByInvite 邮箱规范化：trim + 小写后再消费/入库（M2）', async () => {
    mockInvitations.consume.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@a.b',
      role: Role.Member,
      token: 'tok-1',
    });
    mockUsers.create.mockResolvedValue(userWithHash);
    await service.registerByInvite({
      token: 'tok-1',
      email: '  Invitee@A.B  ',
      password: 'Invite123456',
      name: '受邀用户',
    });
    expect(mockInvitations.consume).toHaveBeenCalledWith(
      'tok-1',
      'invitee@a.b',
      mockManager,
    );
    expect(mockUsers.create).toHaveBeenCalledWith(
      'invitee@a.b',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      mockManager,
    );
  });

  it('registerByInvite 邀请消费失败（已用/过期/无效）透传 400 且不创建用户', async () => {
    mockInvitations.consume.mockRejectedValue(
      new BadRequestException('邀请无效、已使用或已过期'),
    );
    await expect(
      service.registerByInvite({
        token: 'used-token',
        email: 'invitee@a.b',
        password: 'Invite123456',
        name: '受邀用户',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // consume 失败：事务回调内抛错，不进入创建用户分支
    expect(mockUsers.create).not.toHaveBeenCalled();
  });

  it('registerByInvite 邮箱已注册撞 23505 转 409（事务整体回滚，邀请不消耗）', async () => {
    mockInvitations.consume.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@a.b',
      role: Role.Member,
      token: 'tok-1',
    });
    mockUsers.create.mockRejectedValue({ driverError: { code: '23505' } });
    await expect(
      service.registerByInvite({
        token: 'tok-1',
        email: 'invitee@a.b',
        password: 'Invite123456',
        name: '受邀用户',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // 语义：消费与建用户在同一事务（mockDataSource.transaction），异常即回滚
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('registerByInvite 邮箱不一致：consume 条件含邮箱匹配，不匹配即 400（邀请绑定邮箱）', async () => {
    // consume 的 WHERE 含 email=:email，不匹配 affected=0 → 400（服务层语义，见 InvitationsService.consume）
    mockInvitations.consume.mockRejectedValue(
      new BadRequestException('邀请无效、已使用或已过期'),
    );
    await expect(
      service.registerByInvite({
        token: 'tok-other-email',
        email: 'other@a.b',
        password: 'Invite123456',
        name: '错邮箱',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockInvitations.consume).toHaveBeenCalledWith(
      'tok-other-email',
      'other@a.b',
      mockManager,
    );
  });
});

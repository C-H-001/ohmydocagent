// PlatformApiKeyService 单元测试（Task 4.5）：mock 仓库 + AuditService，
// 聚焦安全语义：创建明文一次（dm_ + 32hex，库存 sha256 非明文）、列表脱敏
// （无 keyHash/明文）、吊销（不存在 404）、校验（sha256 查库 + enabled 判定 +
// lastUsedAt 更新）、并发重名 409、审计调用。
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import {
  hashApiKey,
  PlatformApiKeyService,
} from './platform-api-key.service.js';
import { PlatformApiKey } from './platform-api-key.entity.js';

describe('PlatformApiKeyService', () => {
  const mockRepo = {
    create: vi.fn((e: unknown) => e),
    save: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  const mockAudit = { log: vi.fn() };
  const actorId = '11111111-1111-4111-8111-111111111111';

  const buildService = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PlatformApiKeyService,
        { provide: getRepositoryToken(PlatformApiKey), useValue: mockRepo },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    return moduleRef.get(PlatformApiKeyService);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // save 透传实体（含 id/createdAt 补全）
    mockRepo.save.mockImplementation(async (e: PlatformApiKey) => ({
      ...e,
      id: 'key-1',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    }));
  });

  it('创建：返回明文一次（dm_ + 32hex），库存为 sha256 哈希而非明文', async () => {
    const service = await buildService();
    const result = await service.create('运维脚本', ['kb:read'], actorId);
    expect(result.apiKey).toMatch(/^dm_[0-9a-f]{32}$/);
    expect(result.hasApiKey).toBe(true);
    // 落库字段：keyHash = sha256(明文)，绝无明文
    const saved = mockRepo.save.mock.calls[0][0] as PlatformApiKey;
    expect(saved.keyHash).toBe(hashApiKey(result.apiKey));
    expect(saved.keyHash).not.toContain(result.apiKey);
    expect(saved.scopes).toEqual(['kb:read']);
    // 审计：创建（不记明文）
    expect(mockAudit.log).toHaveBeenCalledWith(
      'api_key.create',
      actorId,
      'api_key',
      'key-1',
      expect.objectContaining({ name: '运维脚本' }),
    );
  });

  it('创建：并发重名撞唯一索引（23505）→ 409', async () => {
    mockRepo.save.mockRejectedValue({ driverError: { code: '23505' } });
    const service = await buildService();
    await expect(service.create('同名', [], actorId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('列表：脱敏（无 keyHash/明文），hasApiKey=true 恒成立', async () => {
    mockRepo.find.mockResolvedValue([
      {
        id: 'key-1',
        name: '运维脚本',
        keyHash: 'abc',
        scopes: [],
        enabled: true,
        lastUsedAt: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ]);
    const service = await buildService();
    const result = await service.list();
    expect(result[0]).toEqual({
      id: 'key-1',
      name: '运维脚本',
      scopes: [],
      enabled: true,
      lastUsedAt: null,
      createdAt: expect.any(Date),
      hasApiKey: true,
    });
    expect(JSON.stringify(result)).not.toContain('keyHash');
  });

  it('吊销：存在则删除并审计；不存在 → 404', async () => {
    mockRepo.findOne.mockResolvedValue({
      id: 'key-1',
      name: '运维脚本',
    });
    const service = await buildService();
    await service.revoke('key-1', actorId);
    expect(mockRepo.delete).toHaveBeenCalledWith({ id: 'key-1' });
    expect(mockAudit.log).toHaveBeenCalledWith(
      'api_key.delete',
      actorId,
      'api_key',
      'key-1',
      expect.objectContaining({ name: '运维脚本' }),
    );

    mockRepo.findOne.mockResolvedValue(null);
    await expect(service.revoke('missing', actorId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('校验：sha256 匹配 + enabled → 注入 admin 身份并更新 lastUsedAt', async () => {
    const keyRow = {
      id: 'key-1',
      name: '运维脚本',
      keyHash: hashApiKey('dm_abcd'),
      scopes: [],
      enabled: true,
    };
    mockRepo.findOne.mockResolvedValue(keyRow);
    mockRepo.update.mockResolvedValue(undefined);
    const service = await buildService();
    const identity = await service.validate('dm_abcd');
    expect(identity).toEqual({
      id: 'key-1',
      name: '运维脚本',
      type: 'api-key',
      role: 'member',
    });
    // 查库用 sha256 摘要（DB 比对的是哈希）
    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey('dm_abcd') },
    });
    expect(mockRepo.update).toHaveBeenCalledWith(
      { id: 'key-1' },
      { lastUsedAt: expect.any(Date) },
    );
  });

  it('校验：已暂停（enabled=false）或不存在 → null', async () => {
    mockRepo.findOne.mockResolvedValue({
      id: 'key-1',
      name: '停用',
      enabled: false,
    });
    const service = await buildService();
    expect(await service.validate('dm_abcd')).toBeNull();

    mockRepo.findOne.mockResolvedValue(null);
    expect(await service.validate('dm_unknown')).toBeNull();
  });
});

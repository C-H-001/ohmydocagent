// SystemSettingService 单元测试（Task 4.6）：mock 仓库，聚焦按 key 校验：
// getSettings 合并默认值、updateSettings 逐 key 类型/范围校验（布尔/数字/uuid/
// 未知 key/越界）、upsert 语义。
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { describe, expect, it, vi } from 'vitest';
import { SystemSetting } from './system-setting.entity.js';
import { SystemSettingService } from './system-setting.service.js';

describe('SystemSettingService', () => {
  const mockRepo = {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
  };
  const actorId = '11111111-1111-4111-8111-111111111111';

  const buildService = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SystemSettingService,
        { provide: getRepositoryToken(SystemSetting), useValue: mockRepo },
      ],
    }).compile();
    return moduleRef.get(SystemSettingService);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getSettings：DB 值合并注册表默认值（未设置的 key 返回默认值）', async () => {
    mockRepo.find.mockResolvedValue([{ key: 'max_upload_mb', value: 100 }]);
    const service = await buildService();
    const result = await service.getSettings();
    expect(result).toEqual({
      registration_enabled: true,
      invite_enabled: true,
      default_chat_model_id: '',
      default_embedding_model_id: '',
      max_upload_mb: 100,
    });
  });

  it('updateSettings：合法值全部 upsert 并返回合并结果', async () => {
    // 已存在 → 更新；不存在 → 插入
    mockRepo.findOne
      .mockResolvedValueOnce({ key: 'registration_enabled', value: true }) // 更新路径
      .mockResolvedValueOnce(null); // 插入路径
    mockRepo.create.mockImplementation((e: unknown) => e);
    mockRepo.save.mockImplementation(async (e: unknown) => e);
    // upsert 后 getSettings 从 DB 读回（find 返回写后的行）
    mockRepo.find.mockResolvedValue([
      { key: 'registration_enabled', value: false },
      { key: 'invite_enabled', value: true },
    ]);
    const service = await buildService();
    const result = await service.updateSettings(
      { registration_enabled: false, invite_enabled: true },
      actorId,
    );
    expect(result.registration_enabled).toBe(false);
    expect(result.invite_enabled).toBe(true);
    // 更新路径写入 updatedBy
    expect(mockRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'registration_enabled',
        value: false,
        updatedBy: actorId,
      }),
    );
    // 插入路径带 updatedBy
    expect(mockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'registration_enabled',
        value: true,
        updatedBy: actorId,
      }),
    );
  });

  it('updateSettings：布尔项传非布尔 → 400', async () => {
    const service = await buildService();
    await expect(
      service.updateSettings({ registration_enabled: 'yes' }, actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateSettings：数字项越界（max_upload_mb > 2048）→ 400', async () => {
    const service = await buildService();
    await expect(
      service.updateSettings({ max_upload_mb: 9999 }, actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateSettings：uuid 项非空必须是合法 UUID，空串 = 未配置', async () => {
    const service = await buildService();
    // 非法 UUID → 400
    await expect(
      service.updateSettings({ default_chat_model_id: 'not-a-uuid' }, actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // 空串合法（未配置）
    mockRepo.findOne.mockResolvedValue(null);
    await expect(
      service.updateSettings({ default_chat_model_id: '' }, actorId),
    ).resolves.toBeDefined();
  });

  it('updateSettings：未知 key → 400', async () => {
    const service = await buildService();
    await expect(
      service.updateSettings({ no_such_key: true }, actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateSettings：部分合法部分非法 → 整体拒绝（先全部校验后写入）', async () => {
    mockRepo.find.mockResolvedValue([]);
    const service = await buildService();
    await expect(
      service.updateSettings(
        { registration_enabled: true, max_upload_mb: 'big' },
        actorId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // 校验失败时不得有任何写入
    expect(mockRepo.save).not.toHaveBeenCalled();
  });
});

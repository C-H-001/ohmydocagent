// QueueAdminService 单元测试（Task 4.3）：mock 五条队列（getQueueToken），
// 聚焦：概览（getJobCounts 聚合）、列表（状态筛选 + 内存分页 + 总数）、
// 详情（payload/progress/failedReason 视图）、重试（失败任务 200/不可重试 400）、
// 取消（remove）、未知队列 404、任务不存在 404。
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_QUEUES, QueueAdminService } from './queue-admin.service.js';
import { GRAPH_QUEUE } from '../../graph/graph-queue.constants.js';
import { TITLE_QUEUE } from '../../chat/chat-queue.constants.js';
import {
  EMBED_QUEUE,
  PARSE_QUEUE,
  SUMMARY_QUEUE,
} from '../../parse/parse-queue.constants.js';

describe('QueueAdminService', () => {
  // 五条队列 mock：getJobCounts/getJobs/getJob 按用例覆写
  const makeQueue = () => ({
    getJobCounts: vi.fn(),
    getJobs: vi.fn(),
    getJob: vi.fn(),
  });
  const queues: Record<string, ReturnType<typeof makeQueue>> = {
    [PARSE_QUEUE]: makeQueue(),
    [EMBED_QUEUE]: makeQueue(),
    [SUMMARY_QUEUE]: makeQueue(),
    [TITLE_QUEUE]: makeQueue(),
    [GRAPH_QUEUE]: makeQueue(),
  };

  // 构造一个最小 job（toView 需要的字段）
  const makeJob = (overrides: Partial<any> = {}) => ({
    id: 'job-1',
    name: PARSE_QUEUE,
    data: { knowledgeId: 'k1' },
    progress: 0,
    attemptsMade: 1,
    timestamp: 1000,
    processedOn: 1100,
    finishedOn: 1200,
    failedReason: '解析失败',
    returnvalue: undefined,
    getState: vi.fn().mockResolvedValue('failed'),
    retry: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const buildService = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        QueueAdminService,
        ...ADMIN_QUEUES.map((name) => ({
          provide: getQueueToken(name),
          useValue: queues[name],
        })),
      ],
    }).compile();
    return moduleRef.get(QueueAdminService);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('概览：五队列 getJobCounts 聚合，队列顺序与 ADMIN_QUEUES 一致', async () => {
    queues[PARSE_QUEUE].getJobCounts.mockResolvedValue({
      waiting: 2,
      active: 1,
      completed: 10,
      failed: 3,
      delayed: 0,
    });
    queues[EMBED_QUEUE].getJobCounts.mockResolvedValue({ waiting: 0 });
    const service = await buildService();
    const result = await service.overview();
    expect(result).toHaveLength(ADMIN_QUEUES.length);
    expect(result.map((r) => r.name)).toEqual([...ADMIN_QUEUES]);
    expect(result[0]).toEqual({
      name: PARSE_QUEUE,
      counts: { waiting: 2, active: 1, completed: 10, failed: 3, delayed: 0 },
    });
  });

  it('列表：按状态筛选时只查该状态，分页 start/end 透传，total 为筛选状态计数之和', async () => {
    queues[PARSE_QUEUE].getJobs.mockResolvedValue([makeJob()]);
    queues[PARSE_QUEUE].getJobCounts.mockResolvedValue({ failed: 5 });
    const service = await buildService();
    const result = await service.jobs(PARSE_QUEUE, 'failed', 2, 10);
    expect(queues[PARSE_QUEUE].getJobs).toHaveBeenCalledWith(
      ['failed'],
      10,
      19,
      false,
    );
    expect(result.total).toBe(5);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.items[0]).toMatchObject({
      id: 'job-1',
      data: { knowledgeId: 'k1' },
      state: 'failed',
      failedReason: '解析失败',
    });
  });

  it('列表：缺省 state 查全部可见状态，总数跨状态求和', async () => {
    queues[PARSE_QUEUE].getJobs.mockResolvedValue([]);
    queues[PARSE_QUEUE].getJobCounts.mockResolvedValue({
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
      prioritized: 0,
      'waiting-children': 0,
    });
    const service = await buildService();
    const result = await service.jobs(PARSE_QUEUE);
    expect(result.total).toBe(15);
    // 全部可见状态（不含 paused——队列级状态，见 service 注释）
    expect(queues[PARSE_QUEUE].getJobs).toHaveBeenCalledWith(
      expect.arrayContaining(['waiting', 'failed', 'delayed']),
      0,
      9,
      false,
    );
  });

  it('详情：返回 payload/progress/result/failedReason 视图', async () => {
    const job = makeJob({ progress: 50, returnvalue: { ok: true } });
    queues[EMBED_QUEUE].getJob.mockResolvedValue(job);
    const service = await buildService();
    const result = await service.jobDetail(EMBED_QUEUE, 'job-1');
    expect(result).toMatchObject({
      id: 'job-1',
      progress: 50,
      returnvalue: { ok: true },
      state: 'failed',
    });
  });

  it('详情：任务不存在 → 404', async () => {
    queues[EMBED_QUEUE].getJob.mockResolvedValue(null);
    const service = await buildService();
    await expect(
      service.jobDetail(EMBED_QUEUE, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('重试：失败任务调用 Job.retry() 并返回 { retried: true }', async () => {
    const job = makeJob();
    queues[SUMMARY_QUEUE].getJob.mockResolvedValue(job);
    const service = await buildService();
    await expect(service.retry(SUMMARY_QUEUE, 'job-1')).resolves.toEqual({
      retried: true,
    });
    expect(job.retry).toHaveBeenCalled();
  });

  it('重试：不可重试任务（BullMQ 拒绝）→ 400，不暴露底层错误', async () => {
    const job = makeJob();
    job.retry.mockRejectedValue(new Error('Not retryable'));
    queues[SUMMARY_QUEUE].getJob.mockResolvedValue(job);
    const service = await buildService();
    await expect(service.retry(SUMMARY_QUEUE, 'job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('取消：调用 Job.remove() 并返回 { canceled: true }', async () => {
    const job = makeJob();
    queues[TITLE_QUEUE].getJob.mockResolvedValue(job);
    const service = await buildService();
    await expect(service.cancel(TITLE_QUEUE, 'job-1')).resolves.toEqual({
      canceled: true,
    });
    expect(job.remove).toHaveBeenCalled();
  });

  it('未知队列名 → 404（列表/详情/重试/取消共用 getQueue 校验）', async () => {
    const service = await buildService();
    await expect(service.jobs('no-such-queue')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.jobDetail('no-such-queue', '1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.retry('no-such-queue', '1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.cancel('no-such-queue', '1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

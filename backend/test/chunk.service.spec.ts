// ChunkService 单测（Task 1.9）：updateContent / listRevisions / revert 的新增
// 方法（buildChunkRows 纯函数在 test/chunking.spec.ts 已覆盖）。
// 用 mock 依赖直接实例化（与 parse-processor.spec.ts 同模式）：
// - dataSource.transaction 透传 fake manager（findOne 按实体类分发：
//   Chunk → 待编辑块、ChunkRevision → 目标版本；update 按 affected 注入）
// - embedQueue.add 断言入队载荷 { chunkId }（单块 EMBED job）
// 覆盖语义：
// - updateContent：事务内先 UPDATE chunk（affected 校验）再追加 revision
//   （revision=contentRevision+1、新内容、editorId）+ 入队（事务提交后）
// - chunk 不存在 / 非法 UUID（22P02）→ 404
// - 并发编辑：revision 插入撞 (chunkId, revision) 唯一索引（23505）→ 409；
//   编辑-删除竞态：chunk UPDATE affected=0（行已被并发删除）→ 404 且不插 revision
// - revert：目标版本内容写回 + 追加 revision + 入队；revision=0 → 回滚到
//   sourceContent（不查历史表）；目标版本不存在 → 404
// - listRevisions：revision 升序全量返回；chunk 不存在 → 404
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChunkService } from '../src/modules/chunk/chunk.service.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import { ChunkRevision } from '../src/modules/chunk/chunk-revision.entity.js';
import { EMBED_QUEUE } from '../src/modules/parse/parse-queue.constants.js';

interface ManagerMock {
  findOne: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

/** 组装 mock 依赖：chunk = manager.findOne(Chunk) 的返回值（null = 不存在），
 * targetRevision = manager.findOne(ChunkRevision) 的返回值。findOneErr 可注入
 * 查询抛错（22P02 模拟）。revisionSaveErr 可注入 revision 插入抛错（23505
 * 模拟）；updateAffected 可注入 chunk UPDATE 的受影响行数（0 = 行已被并发删除）。
 * revisions 为 revisionRepo.find 的返回值。 */
function buildService(options: {
  chunk?: Chunk | null;
  targetRevision?: ChunkRevision | null;
  findOneErr?: unknown;
  revisionSaveErr?: unknown;
  updateAffected?: number;
  revisions?: ChunkRevision[];
}) {
  const {
    chunk = {
      id: 'chunk-1',
      content: '原始内容',
      sourceContent: '原始内容',
      contentRevision: 1,
      indexStatus: 'ready',
    } as Chunk,
    targetRevision = null,
    findOneErr,
    revisionSaveErr,
    updateAffected = 1,
    revisions = [],
  } = options;
  const chunkRepo = {
    // ensureChunkExists（listRevisions 前置校验）用：返回 chunk（null = 不存在）
    findOne: vi.fn().mockResolvedValue(chunk),
  };
  const knowledgeRepo = { count: vi.fn() };
  const revisionRepo = { find: vi.fn().mockResolvedValue(revisions) };
  const manager: ManagerMock = {
    findOne: vi.fn((entity: unknown, _opts: unknown) => {
      if (findOneErr) return Promise.reject(findOneErr);
      if (entity === Chunk) return Promise.resolve(chunk);
      if (entity === ChunkRevision) return Promise.resolve(targetRevision);
      return Promise.resolve(null);
    }),
    create: vi.fn((_entity: unknown, data: unknown) => data),
    save: vi.fn(async (entity: unknown, data: unknown) => {
      // 注入 revision 插入抛错（23505 并发编辑模拟）
      if (revisionSaveErr && entity === ChunkRevision) {
        throw revisionSaveErr;
      }
      return data;
    }),
    // chunk UPDATE：affected 可注入（0 = 行已被并发删除，模拟编辑-删除竞态）
    update: vi.fn(async () => ({
      affected: updateAffected,
      generatedMaps: [],
      raw: [],
    })),
  };
  const dataSource = {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (m: ManagerMock) => Promise<unknown>) =>
        cb(manager),
      ),
  };
  const embedQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const service = new ChunkService(
    chunkRepo as never,
    knowledgeRepo as never,
    revisionRepo as never,
    dataSource as never,
    embedQueue as never,
  );
  return { service, manager, dataSource, embedQueue, revisionRepo, chunkRepo };
}

/** 组装一个编辑前状态的 chunk（原始内容 = sourceContent，revision 可指定） */
function makeChunk(revision: number, content = '原始内容'): Chunk {
  const c = new Chunk();
  c.id = 'chunk-1';
  c.kbId = 'kb-1';
  c.knowledgeId = 'doc-1';
  c.content = content;
  c.sourceContent = '原始内容';
  c.contentRevision = revision;
  c.indexStatus = 'ready';
  return c;
}

describe('ChunkService.updateContent（Task 1.9 编辑）', () => {
  it('成功：事务内追加 revision（revision=contentRevision+1、新内容、editorId）+ chunk 更新 + 入队单块 EMBED', async () => {
    const chunk = makeChunk(1);
    const { service, manager, embedQueue } = buildService({ chunk });
    const updated = await service.updateContent(
      'chunk-1',
      '编辑后的内容',
      'user-1',
    );
    // 版本记录：revision = contentRevision+1 = 2，内容为新内容，editorId 透传
    expect(manager.create).toHaveBeenCalledWith(
      ChunkRevision,
      expect.objectContaining({
        chunkId: 'chunk-1',
        content: '编辑后的内容',
        revision: 2,
        editorId: 'user-1',
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      ChunkRevision,
      expect.objectContaining({ revision: 2, content: '编辑后的内容' }),
    );
    // chunk 更新：改用 UPDATE + affected 校验（save 在行被并发删除时静默成功
    // 返回陈旧实体，见 updateChunkContent 注释）——content 更新、contentRevision+1、
    // indexStatus=processing；sourceContent 保留原值（编辑不触碰）
    expect(manager.update).toHaveBeenCalledWith(
      Chunk,
      { id: 'chunk-1' },
      expect.objectContaining({
        content: '编辑后的内容',
        contentRevision: 2,
        indexStatus: 'processing',
      }),
    );
    expect(updated.content).toBe('编辑后的内容');
    expect(updated.contentRevision).toBe(2);
    expect(updated.indexStatus).toBe('processing');
    expect(updated.sourceContent).toBe('原始内容');
    // 入队单块 EMBED job（payload { chunkId }，addQueueJob 配置 attempts=2）
    expect(embedQueue.add).toHaveBeenCalledWith(
      EMBED_QUEUE,
      { chunkId: 'chunk-1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('chunk 不存在 → 404（NotFound，不写 revision、不入队）', async () => {
    const { service, manager, embedQueue } = buildService({ chunk: null });
    await expect(
      service.updateContent('chunk-1', '新内容', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(embedQueue.add).not.toHaveBeenCalled();
  });

  it('非法 UUID（22P02）→ 404（既有模式：驱动错误视为不存在，不泄露内部错误）', async () => {
    const { service, manager } = buildService({
      findOneErr: { driverError: { code: '22P02' } },
    });
    await expect(
      service.updateContent('not-a-uuid', '新内容', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('并发编辑：revision 插入撞 (chunkId, revision) 唯一索引（23505）→ 409，不入队（事务回滚撤销前序 chunk 更新）', async () => {
    const chunk = makeChunk(1);
    const { service, embedQueue } = buildService({
      chunk,
      // 同 chunk 两个编辑并发：两者从相同 contentRevision 算得相同新 revision，
      // 后落库者撞复合唯一索引 → driverError.code 23505 → 409（与 auth M1 同模式）
      revisionSaveErr: { driverError: { code: '23505' } },
    });
    await expect(
      service.updateContent('chunk-1', '并发内容', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(embedQueue.add).not.toHaveBeenCalled();
  });

  it('编辑-删除竞态：chunk UPDATE affected=0（load 后、UPDATE 前块被并发删除）→ 404，且不插入 revision（无孤儿版本行）', async () => {
    const chunk = makeChunk(1);
    const { service, manager, embedQueue } = buildService({
      chunk,
      updateAffected: 0,
    });
    await expect(
      service.updateContent('chunk-1', '新内容', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // UPDATE 先行：0 行即抛 404，revision 插入从未发生（事务回滚，无孤儿行）
    expect(manager.save).not.toHaveBeenCalled();
    expect(embedQueue.add).not.toHaveBeenCalled();
  });
});

describe('ChunkService.revert（Task 1.9 追加式回滚）', () => {
  it('成功：目标版本内容写回 + 追加 revision（contentRevision+1）+ 入队单块 EMBED', async () => {
    const chunk = makeChunk(2, '版本二内容');
    const target = new ChunkRevision();
    target.id = 'rev-1';
    target.chunkId = 'chunk-1';
    target.content = '版本一内容';
    target.revision = 1;
    target.editorId = 'user-1';
    target.createdAt = new Date();
    const { service, manager, embedQueue } = buildService({
      chunk,
      targetRevision: target,
    });
    const updated = await service.revert('chunk-1', 1, 'user-2');
    // 追加记录：revision = contentRevision+1 = 3，内容 = 目标版本内容
    expect(manager.create).toHaveBeenCalledWith(
      ChunkRevision,
      expect.objectContaining({
        chunkId: 'chunk-1',
        content: '版本一内容',
        revision: 3,
        editorId: 'user-2',
      }),
    );
    // chunk：内容回滚到目标版本、contentRevision+1、indexStatus=processing
    expect(updated.content).toBe('版本一内容');
    expect(updated.contentRevision).toBe(3);
    expect(updated.indexStatus).toBe('processing');
    expect(updated.sourceContent).toBe('原始内容');
    expect(embedQueue.add).toHaveBeenCalledWith(
      EMBED_QUEUE,
      { chunkId: 'chunk-1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('目标版本不存在 → 404（不写 chunk、不入队）', async () => {
    const chunk = makeChunk(2, '版本二内容');
    const { service, manager, embedQueue } = buildService({
      chunk,
      targetRevision: null,
    });
    await expect(
      service.revert('chunk-1', 999, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(embedQueue.add).not.toHaveBeenCalled();
  });

  it('revision=0（回滚到原始版本）：目标内容 = sourceContent，不查历史表，追加新版本记录 + 入队', async () => {
    // 编辑过两次：content=版本二内容、sourceContent=原始内容（首次解析原文）
    const chunk = makeChunk(2, '版本二内容');
    const { service, manager, embedQueue } = buildService({ chunk });
    const updated = await service.revert('chunk-1', 0, 'user-1');
    // 0 号原始不落库、无对应历史行：findOne 只被 loadChunkInTx 用过一次（Chunk）
    expect(manager.findOne).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(Chunk, expect.anything());
    // chunk：内容恢复为 sourceContent、contentRevision 2→3、indexStatus=processing
    expect(updated.content).toBe('原始内容');
    expect(updated.contentRevision).toBe(3);
    expect(updated.indexStatus).toBe('processing');
    // 追加记录：内容 = sourceContent（原始版本），revision = contentRevision+1
    expect(manager.create).toHaveBeenCalledWith(
      ChunkRevision,
      expect.objectContaining({
        chunkId: 'chunk-1',
        content: '原始内容',
        revision: 3,
        editorId: 'user-1',
      }),
    );
    expect(embedQueue.add).toHaveBeenCalledWith(
      EMBED_QUEUE,
      { chunkId: 'chunk-1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });
});

describe('ChunkService.listRevisions（Task 1.9 版本历史）', () => {
  it('按 revision 升序全量返回（版本历史通常 < 100 条，分页后置——见任务决策注释）', async () => {
    const chunk = makeChunk(2);
    const rev1 = new ChunkRevision();
    rev1.revision = 1;
    const rev2 = new ChunkRevision();
    rev2.revision = 2;
    const { service, revisionRepo } = buildService({
      chunk,
      revisions: [rev1, rev2],
    });
    const result = await service.listRevisions('chunk-1');
    expect(result).toEqual([rev1, rev2]);
    expect(revisionRepo.find).toHaveBeenCalledWith({
      where: { chunkId: 'chunk-1' },
      order: { revision: 'ASC' },
    });
  });

  it('chunk 不存在 → 404', async () => {
    const { service, revisionRepo } = buildService({ chunk: null });
    await expect(service.listRevisions('chunk-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(revisionRepo.find).not.toHaveBeenCalled();
  });
});

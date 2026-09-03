// ChatHistoryService 单元测试（Task 2.11）：mock DataSource/仓库，覆盖——
// - stats 聚合口径：dataSource.query 返回行 → 映射（messageCount/citationCount
//   透传 + kbName 批量补查；KB 已删（补查不到）→ 省略 kbName 字段；无引用行
//   → 空数组不补查）
// - 摘要截断：>200 字符截断到 200 + '…'（列表页预览，与 references 截断
//   同一语义）；≤200 原样
// - 摘要截断代理对安全（质量审查整改）：emoji 消息摘要经
//   clampSurrogateBoundary 钳制切点——无孤立代理（朴素 slice 会把代理对
//   劈开产生乱码）
// - escapeLike 转义（质量审查整改）：ILIKE 通配符 %/_/\ 字面量转义（防
//   用户输入扩大匹配，语义锁定防回归）
// - clearAll 清空删除数：本人会话数 = deleted；事务内删 messages/attachments/
//   sessions 三表；附件磁盘路径先收集、事务后尽力清理（复用 SessionService
//   remove 的级联语义）；0 会话 → { deleted: 0 } 且不触发任何删除
// stats 的 SQL 口径（references jsonb 展开 → knowledge 反查 kbId 聚合 + KB
// 归属过滤）由 e2e 对真实 DB 验证（test/chat-history.e2e-spec.ts），单测只
// 覆盖映射层。
import { describe, expect, it, vi } from 'vitest';
import {
  ChatHistoryService,
  escapeLike,
  truncateSnippet,
} from '../src/modules/chat/chat-history.service.js';

/** 组装 mock 依赖：dataSource.query 返回 stats 行、仓库返回查询结果 */
function buildService(options: {
  statsRows?: Array<{
    kbId: string;
    messageCount: number;
    citationCount: number;
  }>;
  kbs?: Array<{ id: string; name: string }>;
  ownedSessions?: Array<{ id: string }>;
}) {
  const { statsRows = [], kbs = [], ownedSessions = [] } = options;
  // clearAll 事务的 manager（delete 三表；mock 在 buildService 内可见）
  const manager = { delete: vi.fn().mockResolvedValue({}) };
  const dataSource = {
    query: vi.fn().mockResolvedValue(statsRows),
    transaction: vi.fn(async (fn: (m: unknown) => Promise<unknown>) =>
      fn(manager),
    ),
  };
  const messageRepo = { createQueryBuilder: vi.fn() };
  const sessionRepo = { find: vi.fn().mockResolvedValue(ownedSessions) };
  const kbRepo = { find: vi.fn().mockResolvedValue(kbs) };
  const attachmentService = {
    getStoredPathsForSessions: vi
      .fn()
      .mockResolvedValue(['attachments/s1/f1.txt']),
    cleanupFiles: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ChatHistoryService(
    dataSource as never,
    messageRepo as never,
    sessionRepo as never,
    kbRepo as never,
  );
  return {
    service,
    dataSource,
    manager,
    sessionRepo,
    kbRepo,
    attachmentService,
  };
}

describe('ChatHistoryService', () => {
  it('stats：聚合行映射（messageCount/citationCount 透传 + kbName 批量补查）', async () => {
    const { service, dataSource, kbRepo } = buildService({
      statsRows: [
        { kbId: 'kb-a', messageCount: 2, citationCount: 3 },
        { kbId: 'kb-b', messageCount: 1, citationCount: 1 },
      ],
      kbs: [
        { id: 'kb-a', name: '知识库甲' },
        { id: 'kb-b', name: '知识库乙' },
      ],
    });
    const result = await service.stats('u-owner', 30);
    // 聚合 SQL 走 dataSource.query（参数化：userId + days；jsonb 展开反查 kbId）
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_array_elements'),
      ['u-owner', 30],
    );
    // 补查用一次 IN 查询（批量而非 N+1），且只取 id/name 投影
    expect(kbRepo.find).toHaveBeenCalledTimes(1);
    const findCall = kbRepo.find.mock.calls[0][0] as {
      where: { id: object };
      select: object;
    };
    expect(findCall.select).toEqual({ id: true, name: true });
    // In() 是 TypeORM 特殊操作符对象（不断言内部结构，只断言用了 In 查询）
    expect(findCall.where.id).toBeTypeOf('object');
    expect(result).toEqual([
      { kbId: 'kb-a', kbName: '知识库甲', messageCount: 2, citationCount: 3 },
      { kbId: 'kb-b', kbName: '知识库乙', messageCount: 1, citationCount: 1 },
    ]);
  });

  it('stats：KB 已删（补查不到）→ 省略 kbName 字段（不报错，孤儿 kbId 可展示）', async () => {
    const { service } = buildService({
      statsRows: [{ kbId: 'kb-deleted', messageCount: 1, citationCount: 2 }],
      kbs: [],
    });
    const result = await service.stats('u-owner', 30);
    expect(result).toEqual([
      { kbId: 'kb-deleted', messageCount: 1, citationCount: 2 },
    ]);
    expect(result[0]).not.toHaveProperty('kbName');
  });

  it('stats：无引用行 → 空数组（不补查 knowledge_bases）', async () => {
    const { service, kbRepo } = buildService({ statsRows: [], kbs: [] });
    const result = await service.stats('u-owner', 30);
    expect(result).toEqual([]);
    expect(kbRepo.find).not.toHaveBeenCalled();
  });

  it('摘要截断：>200 截断到 200 + "…"（含省略号共 201）；≤200 原样', () => {
    const short = '短内容';
    expect(truncateSnippet(short)).toBe(short);
    const long = '长'.repeat(200);
    expect(truncateSnippet(long)).toBe(long);
    const over = '长'.repeat(250);
    const cut = truncateSnippet(over);
    expect(cut).toBe('长'.repeat(200) + '…');
    expect(cut.length).toBe(201);
  });

  it('摘要截断：emoji 消息摘要无孤立代理（clampSurrogateBoundary 钳制切点）', () => {
    // 199 BMP 字符 + emoji（2 码元）= 201 > 200：朴素 slice(0,200) 切点落
    // 在 emoji 低代理上（切出孤立高代理乱码）；clamp 后切点回退到 199——
    // emoji 整体丢弃（配对不被劈开），摘要无孤立代理
    const over = '长'.repeat(199) + '😀';
    const cut = truncateSnippet(over);
    expect(cut).toBe('长'.repeat(199) + '…');
    // 无孤立代理：逐码点检查无 0xD800–0xDFFF 区间码元（孤立代理会单独成项）
    for (const ch of cut) {
      const cp = ch.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
    }
    // 切点前 emoji 完整保留的情形：198 BMP + emoji + 1 BMP = 202 > 200，
    // 切点 200 落在普通字符上 → emoji 配对整体保留、截断无孤立代理
    const intact = '长'.repeat(198) + '😀' + '尾';
    const cut2 = truncateSnippet(intact);
    expect(cut2).toBe('长'.repeat(198) + '😀' + '…');
    expect([...cut2].includes('😀')).toBe(true);
  });

  it('escapeLike：%/_/\\ 转义为字面量（ILIKE 通配符防扩大匹配，质量审查整改）', () => {
    // % 通配符：字面量 '50%折扣' → '50\%折扣'（未转义会匹配任意 50 前缀串）
    expect(escapeLike('50%折扣')).toBe('50\\%折扣');
    // _ 单字符通配：字面量 'a_b' → 'a\_b'（未转义会匹配 axb 等任意单字符）
    expect(escapeLike('a_b')).toBe('a\\_b');
    // 反斜杠自身先转义（防绕过后续 %/_ 的转义序列）
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    // 组合：%/_/\ 全转义
    expect(escapeLike('100%_off\\now')).toBe('100\\%\\_off\\\\now');
    // 无特殊字符原样返回
    expect(escapeLike('普通关键词')).toBe('普通关键词');
  });

  it('clearAll：事务内删三表 + 附件磁盘路径先收集/事务后清理，返回删除数', async () => {
    const { service, manager, sessionRepo, attachmentService } = buildService({
      ownedSessions: [{ id: 's1' }, { id: 's2' }],
    });
    const result = await service.clearAll('u-owner');
    expect(result).toEqual({ deleted: 2 });
    // 本人会话先查（归属范围 = 当前用户）
    expect(sessionRepo.find).toHaveBeenCalledWith({
      where: { userId: 'u-owner' },
      select: { id: true },
    });
    // 附件磁盘路径在行删除前收集（行删后无法再查，与 SessionService.remove 同语义）
    expect(attachmentService.getStoredPathsForSessions).toHaveBeenCalledWith([
      's1',
      's2',
    ]);
    // 事务内三表删除（messages → attachments → sessions，原子化无孤儿残留）
    expect(manager.delete).toHaveBeenCalledTimes(3);
    // 事务后磁盘尽力清理（路径已收集）
    expect(attachmentService.cleanupFiles).toHaveBeenCalledWith([
      'attachments/s1/f1.txt',
    ]);
  });

  it('clearAll：0 会话 → { deleted: 0 }，不触发删除/路径收集/清理', async () => {
    const { service, manager, sessionRepo, attachmentService } = buildService({
      ownedSessions: [],
    });
    const result = await service.clearAll('u-empty');
    expect(result).toEqual({ deleted: 0 });
    expect(sessionRepo.find).toHaveBeenCalledWith({
      where: { userId: 'u-empty' },
      select: { id: true },
    });
    expect(manager.delete).not.toHaveBeenCalled();
    expect(attachmentService.getStoredPathsForSessions).not.toHaveBeenCalled();
    expect(attachmentService.cleanupFiles).not.toHaveBeenCalled();
  });
});

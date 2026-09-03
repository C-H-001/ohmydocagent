// KnowledgeProgressService 单元测试（Task 1.4 质量整改）：
// - 原子写：status/error/parsedText + parserStages 追加合并为单条 UPDATE
//   （断言 execute 单次调用 + 原始 SQL 片段含 jsonb || 拼接）
// - 重试成功不残留失败原因：先 markFailed 再 saveParsedText → error 清空
//   （实体不变量：error 非空 ⇔ status=failed，见 knowledge.entity.ts）
// - 未传入字段保持原值（markParsing/markFailed 不触碰 parsedText）
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { vi } from 'vitest';
import { Knowledge } from './knowledge.entity.js';
import { KnowledgeProgressService } from './knowledge-progress.service.js';

describe('KnowledgeProgressService', () => {
  let service: KnowledgeProgressService;
  // 记录每次 set() 的值（验证单条 UPDATE 的各列内容与追加 SQL 片段）
  let capturedSet: Array<Record<string, unknown>>;

  const execute = vi.fn(async () => ({ affected: 1 }));
  const qbMock = {
    update: vi.fn(() => qbMock),
    set: vi.fn((values: Record<string, unknown>) => {
      capturedSet.push(values);
      return qbMock;
    }),
    setParameter: vi.fn((_key: string, _value: unknown) => qbMock),
    where: vi.fn(() => qbMock),
    execute,
  };
  const repoMock = { createQueryBuilder: vi.fn(() => qbMock) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeProgressService,
        { provide: getRepositoryToken(Knowledge), useValue: repoMock },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeProgressService);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSet = [];
  });

  it('saveParsedText：单条 UPDATE 原子写（status/error/parsedText + parserStages jsonb || 追加）', async () => {
    await service.saveParsedText('doc-1', '文本内容');
    // 单条 query：进度写回不再拆成 appendStage + repo.update 两条独立 UPDATE
    expect(execute).toHaveBeenCalledTimes(1);
    const set = capturedSet[0];
    expect(set.status).toBe('parsing');
    expect(set.error).toBe(''); // 成功路径清空 error（见「重试不残留」用例）
    expect(set.parsedText).toBe('文本内容');
    // parserStages 用 jsonb 数组拼接：COALESCE 兜底 NULL + || 追加
    // （质量审查整改：同一表达式内裁剪保留最近 PARSER_STAGES_LIMIT 条，
    // 不引入 read-modify-write 竞态，见 knowledge-progress.service.ts 注释）
    const raw = (set.parserStages as () => string)();
    expect(raw).toContain('||');
    expect(raw).toContain('COALESCE');
    expect(raw).toContain('"parserStages"'); // camelCase 列名带引号（PG 小写化防护）
    expect(raw).toContain('jsonb_array_elements');
    expect(raw).toContain('jsonb_agg(elem ORDER BY pos)');
    expect(raw).toContain('LIMIT 50'); // 时间线保留上限（追加前裁剪）
    // stage 参数 JSON 序列化后绑定（jsonb 参数化，无注入面）
    expect(qbMock.setParameter).toHaveBeenCalledWith(
      'stage',
      expect.any(String),
    );
    const stage = JSON.parse(qbMock.setParameter.mock.calls[0][1] as string);
    expect(stage).toMatchObject({ stage: 'extract', status: 'done' });
  });

  it('重试成功不残留失败原因（质量整改）：先 markFailed 再 saveParsedText → error 为空', async () => {
    await service.markFailed('doc-1', '解析崩溃: boom');
    await service.saveParsedText('doc-1', '重试成功文本');
    // 两次进度写回各自单条 UPDATE（无中间态）
    expect(execute).toHaveBeenCalledTimes(2);
    expect(capturedSet[0].status).toBe('failed');
    expect(capturedSet[0].error).toBe('解析崩溃: boom');
    // 重试成功后 error 清空——违反实体不变量（error 非空 ⇔ status=failed）的
    // 残留是本次质量整改的修复点
    expect(capturedSet[1].status).toBe('parsing');
    expect(capturedSet[1].error).toBe('');
    expect(capturedSet[1].parsedText).toBe('重试成功文本');
  });

  it('markParsing：status=parsing + 清空残留 error + extract running 阶段；不触碰 parsedText', async () => {
    await service.markParsing('doc-1');
    expect(execute).toHaveBeenCalledTimes(1);
    const set = capturedSet[0];
    expect(set.status).toBe('parsing');
    expect(set.error).toBe(''); // 新尝试开始，旧失败原因不再反映当前状态
    expect(set.parsedText).toBeUndefined(); // 未传字段保持原值（不覆盖）
    const stage = JSON.parse(qbMock.setParameter.mock.calls[0][1] as string);
    expect(stage).toMatchObject({ stage: 'extract', status: 'running' });
  });

  it('markFailed：status=failed + error 记录（超长截断 2000）+ extract failed 阶段；不触碰 parsedText', async () => {
    await service.markFailed('doc-1', 'x'.repeat(5000));
    expect(execute).toHaveBeenCalledTimes(1);
    const set = capturedSet[0];
    expect(set.status).toBe('failed');
    expect((set.error as string).length).toBeLessThanOrEqual(2000);
    expect(set.parsedText).toBeUndefined(); // markFailed 不覆盖已解析文本（保留现场供排查/重试）
    const stage = JSON.parse(
      qbMock.setParameter.mock.calls[0][1] as string,
    ) as {
      stage: string;
      status: string;
      detail: string;
    };
    expect(stage).toMatchObject({ stage: 'extract', status: 'failed' });
    expect(stage.detail.length).toBeLessThanOrEqual(2000);
  });

  it('stage 未传入时不追加 parserStages 列（纯状态更新可复用 updateProgress）', async () => {
    await service.updateProgress('doc-1', { status: 'ready' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(capturedSet[0]).toEqual({ status: 'ready' });
    expect(qbMock.setParameter).not.toHaveBeenCalled();
  });
});

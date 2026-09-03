// KnowledgeService 单元测试：三种创建方式的业务规则与 404/400 语义——
// 文件扩展名白名单（pdf/doc/docx/png/jpg/jpeg/webp/md/markdown/txt）、
// URL 协议白名单（http/https，服务层兜底校验）、KB 不存在统一 404（含 22P02）、
// 列表筛选透传（type/keyword/status）、removeByKbInTx 级联删除（EntityManager 解耦）。
// Task 1.3 新增：文件夹（同级同名 409/环检测 400/删除文档归根）、
// 标签（重名 409/跨 KB 打标 400）。
// Task 1.7 补测（质量审查整改）：getStages 返回字段结构（含 summary）、
// regenerateSummary 入队 + 404 语义、reparse 并发防重论证（行锁 + 事务内
// 状态判定 + 重置字段集合 + 入队在事务后）。
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, ILike, In } from 'typeorm';
import { vi } from 'vitest';
import { Knowledge } from './knowledge.entity.js';
import { KnowledgeFolder } from './folder.entity.js';
import { KnowledgeTag } from './knowledge-tag.entity.js';
import { KnowledgeService } from './knowledge.service.js';
import { Chunk } from '../chunk/chunk.entity.js';
import { ChunkService } from '../chunk/chunk.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PARSE_QUEUE, SUMMARY_QUEUE } from '../parse/parse-queue.constants.js';
import { GraphRepository } from '../graph/graph.repository.js';
import { Tag } from './tag.entity.js';

describe('KnowledgeService', () => {
  let service: KnowledgeService;
  const kbId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = '11111111-1111-4111-8111-111111111111';

  const storageMock = {
    save: vi.fn(async () => `${kbId}/doc/`),
    remove: vi.fn(async () => undefined),
    removeKbDirectory: vi.fn(async () => undefined),
    removeEmptyDirectory: vi.fn(async () => undefined),
  };
  const kbRepoMock = { count: vi.fn(async () => 1) };
  const knowledgeRepoMock = {
    create: vi.fn((data: Partial<Knowledge>) => data as Knowledge),
    save: vi.fn(async (entity: Knowledge) => entity),
    findOne: vi.fn(),
    findAndCount: vi.fn(),
    find: vi.fn(async (_opts?: unknown): Promise<unknown[]> => []),
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  // Task 1.3 新增仓库 mock：文件夹/标签/关联（新方法按用例逐个 stub）
  // 注意：返回类型显式标注为 unknown/unknown[]（默认推断 Promise<never> 会让
  // mockResolvedValueOnce 的具体值报 TS2322）
  const folderRepoMock = {
    create: vi.fn((data: Partial<KnowledgeFolder>) => data as KnowledgeFolder),
    save: vi.fn(async (entity: KnowledgeFolder) => entity),
    findOne: vi.fn(async (_opts?: unknown): Promise<unknown> => null),
    find: vi.fn(async (_opts?: unknown): Promise<unknown[]> => []),
    update: vi.fn(async () => ({ affected: 1 })),
  };
  const tagRepoMock = {
    create: vi.fn((data: Partial<Tag>) => data as Tag),
    save: vi.fn(async (entity: Tag) => entity),
    findOne: vi.fn(async (_opts?: unknown): Promise<unknown> => null),
    find: vi.fn(async (_opts?: unknown): Promise<unknown[]> => []),
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  const knowledgeTagRepoMock = {
    find: vi.fn(async (_opts?: unknown): Promise<unknown[]> => []),
    delete: vi.fn(async () => ({ affected: 1 })),
    insert: vi.fn(async () => undefined),
    createQueryBuilder: vi.fn(),
  };
  // insert 查询构建器 mock（setKnowledgeTags 插新用 createQueryBuilder().insert()...
  // .orIgnore().execute() 链式调用，见知识服务注释）
  const insertQbMock = {
    insert: vi.fn(() => insertQbMock),
    into: vi.fn(() => insertQbMock),
    values: vi.fn(() => insertQbMock),
    orIgnore: vi.fn(() => insertQbMock),
    execute: vi.fn(async () => undefined),
  };
  const managerMock = {
    find: vi.fn(async (_opts?: unknown): Promise<unknown[]> => []),
    findOne: vi.fn(async (_opts?: unknown): Promise<unknown> => null),
    // affected 可为 null（其它驱动 DELETE 不返回行数）——batchDelete 回退快照计数
    delete: vi.fn(async (): Promise<{ affected: number | null }> => ({
      affected: 1,
    })),
    update: vi.fn(async () => ({ affected: 1 })),
    insert: vi.fn(async () => undefined),
    createQueryBuilder: vi.fn(() => insertQbMock),
  };
  const dataSourceMock = {
    getRepository: vi.fn(() => kbRepoMock),
    // moveFolder/deleteFolder/setKnowledgeTags 事务（回调注入 managerMock）
    transaction: vi.fn(async (cb: (m: EntityManager) => unknown) =>
      cb(managerMock as unknown as EntityManager),
    ),
  };

  // 解析队列 mock（Task 1.4）：KnowledgeService 建行后入队，断言 add 调用
  const parseQueueMock = {
    add: vi.fn(async () => undefined),
  };

  // 摘要队列 mock（Task 1.7）：regenerate-summary 入队，断言 add 调用
  const summaryQueueMock = {
    add: vi.fn(async () => undefined),
  };

  // 分块子表清理 mock（Task 1.5）：文档删除/KB 级联时调用（见 remove 用例）；
  // Task 1.5 质量整改：remove 事务化后走 deleteByKnowledgeInTx（见 remove 用例）
  const chunkServiceMock = {
    deleteByKnowledge: vi.fn(async () => undefined),
    deleteByKnowledgeInTx: vi.fn(async () => undefined),
    deleteByKbInTx: vi.fn(async () => undefined),
  };

  // 图谱子图清理 mock（Task 3.2）：remove/batchDelete 事务提交后 best-effort
  // 调 deleteKnowledgeSubgraph（失败仅记日志不阻断，见 remove 注释）
  const graphRepoMock = {
    deleteKnowledgeSubgraph: vi.fn(async () => undefined),
  };

  // 服务内部 new Logger() 自建实例：spy 原型方法拦截所有实例的 warn 输出
  const warnSpy = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);

  /** 构造 Knowledge 测试数据 */
  function makeKnowledge(overrides: Partial<Knowledge> = {}): Knowledge {
    return {
      id: 'doc-1',
      kbId,
      folderId: null,
      title: '测试文档',
      type: 'file',
      filePath: `${kbId}/doc-1/doc-1.pdf`,
      fileType: 'pdf',
      fileSize: 10,
      sourceUrl: '',
      manualContent: null,
      parsedText: null,
      status: 'pending',
      error: '',
      summary: null,
      chunkCount: 0,
      parserStages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Knowledge;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeService,
        { provide: getRepositoryToken(Knowledge), useValue: knowledgeRepoMock },
        {
          provide: getRepositoryToken(KnowledgeFolder),
          useValue: folderRepoMock,
        },
        { provide: getRepositoryToken(Tag), useValue: tagRepoMock },
        {
          provide: getRepositoryToken(KnowledgeTag),
          useValue: knowledgeTagRepoMock,
        },
        { provide: StorageService, useValue: storageMock },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: getQueueToken(PARSE_QUEUE), useValue: parseQueueMock },
        // Task 1.7：自动摘要队列（regenerate-summary 入队）
        { provide: getQueueToken(SUMMARY_QUEUE), useValue: summaryQueueMock },
        // Task 1.5：ChunkService（chunks 子表清理）
        { provide: ChunkService, useValue: chunkServiceMock },
        // Task 3.2：GraphRepository（文档删除清理图谱子图）
        { provide: GraphRepository, useValue: graphRepoMock },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeService);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    kbRepoMock.count.mockResolvedValue(1);
    warnSpy.mockClear();
  });

  /** 构造 multer 内存文件 */
  function makeFile(name: string, content = 'bytes') {
    return {
      originalname: name,
      buffer: Buffer.from(content),
      size: Buffer.byteLength(content),
      mimetype: 'application/octet-stream',
      fieldname: 'file',
      encoding: '7bit',
    };
  }

  it('createFromFile：白名单扩展名 → 保存文件并创建 type=file status=pending 文档', async () => {
    storageMock.save.mockResolvedValue(`${kbId}/new-doc/new-doc.pdf`);
    const result = await service.createFromFile(
      kbId,
      makeFile('方案.pdf'),
      userId,
    );
    expect(storageMock.save).toHaveBeenCalled();
    expect(result.type).toBe('file');
    expect(result.status).toBe('pending');
    expect(result.fileType).toBe('pdf');
    expect(result.title).toBe('方案');
    expect(result.filePath).toBe(`${kbId}/new-doc/new-doc.pdf`);
  });

  it('createFromFile：中文文件名修复（busboy latin1 误读 → 还原 UTF-8）', async () => {
    // '中' 的 UTF-8 字节 E4 B8 AD 被 busboy 按 latin1 逐字节映射成 'ä¸­'
    storageMock.save.mockResolvedValue(`${kbId}/zh/zh.pdf`);
    const result = await service.createFromFile(
      kbId,
      makeFile('ä¸­.pdf'),
      userId,
    );
    expect(result.title).toBe('中');
    expect(result.fileType).toBe('pdf');
    // 落盘用的是还原后的原始文件名（'中.pdf'，而非 busboy 误读的 'ä¸­.pdf'）
    expect(storageMock.save).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: '中.pdf' }),
      kbId,
      expect.any(String),
    );
  });

  it('createFromFile：真实 latin1 高位字符（如 café）不被转换损坏', async () => {
    // 'é' 是真实 latin1 字符：latin1→utf8 转换会产生 U+FFFD（替换符），启发式应保持原样
    storageMock.save.mockResolvedValue(`${kbId}/cafe/cafe.pdf`);
    const result = await service.createFromFile(
      kbId,
      makeFile('café.pdf'),
      userId,
    );
    expect(result.title).toBe('café');
    expect(result.fileType).toBe('pdf');
    expect(storageMock.save).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'café.pdf' }),
      kbId,
      expect.any(String),
    );
  });

  it('createFromFile：行建失败（DB 异常）时清理已落盘文件并 best-effort 删父目录，错误继续抛出', async () => {
    storageMock.save.mockResolvedValue(`${kbId}/fail-doc/fail-doc.pdf`);
    knowledgeRepoMock.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.createFromFile(kbId, makeFile('a.pdf'), userId),
    ).rejects.toThrow('db down');
    expect(storageMock.remove).toHaveBeenCalledWith(
      `${kbId}/fail-doc/fail-doc.pdf`,
    );
    expect(storageMock.removeEmptyDirectory).toHaveBeenCalledWith(
      `${kbId}/fail-doc`,
    );
  });

  it('list：透传 type/keyword/status 筛选，keyword 用 ILike，排序 createdAt DESC，带投影 select', async () => {
    // 模拟 TypeORM 的 select 行为：只返回投影字段（真实查询不会把 manualContent 等带回来）
    knowledgeRepoMock.findAndCount.mockImplementation(
      async (options: {
        select?: Record<string, boolean>;
        skip?: number;
        take?: number;
      }) => {
        const row = makeKnowledge({
          title: '研究报告',
          manualContent: 'x'.repeat(5000),
          filePath: 'secret/内部路径.pdf',
        });
        const selected = options.select
          ? Object.fromEntries(
              Object.entries(row).filter(([k]) => options.select![k]),
            )
          : row;
        return [[selected], 1];
      },
    );
    const result = await service.list(kbId, {
      page: 1,
      pageSize: 10,
      type: 'file',
      keyword: '研究',
      status: 'pending',
    });
    expect(knowledgeRepoMock.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kbId,
          type: 'file',
          status: 'pending',
          title: ILike('%研究%'),
        },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 10,
      }),
    );
    // 列表响应不含 manualContent/filePath（投影生效，防载荷膨胀与路径泄露）
    expect(result.items[0]).not.toHaveProperty('manualContent');
    expect(result.items[0]).not.toHaveProperty('filePath');
    expect(result.items[0]).not.toHaveProperty('parserStages');
    expect(result.items[0]).not.toHaveProperty('error');
    expect(result.items[0]).not.toHaveProperty('summary');
    expect(result.items[0]).toHaveProperty('title', '研究报告');
  });

  it('list：非法 type/status 被忽略而非透传（服务层白名单兜底，不撞 PG 枚举 22P02 → 500）', async () => {
    knowledgeRepoMock.findAndCount.mockResolvedValue([[makeKnowledge()], 1]);
    await expect(
      service.list(kbId, {
        page: 1,
        pageSize: 10,
        type: 'hacker',
        status: 'oops',
      }),
    ).resolves.toBeDefined();
    // where 不包含非法枚举（忽略），只保留 kbId
    expect(knowledgeRepoMock.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kbId },
      }),
    );
    // 合法值不受影响
    await service.list(kbId, { page: 1, pageSize: 10, type: 'manual' });
    expect(knowledgeRepoMock.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kbId, type: 'manual' },
      }),
    );
  });

  it('createFromFile：pdf/doc/docx/png/jpg/jpeg/webp/md/markdown/txt 全部收', async () => {
    const names = [
      'a.pdf',
      'b.doc',
      'c.docx',
      'd.png',
      'e.jpg',
      'f.jpeg',
      'g.webp',
      'h.md',
      'i.markdown',
      'j.txt',
    ];
    for (const name of names) {
      storageMock.save.mockResolvedValue(`${kbId}/x/${name}`);
      const result = await service.createFromFile(kbId, makeFile(name), userId);
      expect(result.fileType).toBe(name.split('.').pop());
    }
  });

  it('createFromFile：不支持/无扩展名 → 400；未带文件 → 400', async () => {
    await expect(
      service.createFromFile(kbId, makeFile('virus.exe'), userId),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createFromFile(kbId, makeFile('README'), userId),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createFromFile(kbId, undefined as never, userId),
    ).rejects.toThrow(BadRequestException);
    // 未落盘：拒绝时不得调用 storage.save
    expect(storageMock.save).not.toHaveBeenCalled();
  });

  it('createFromFile：KB 不存在 → 404（含非 UUID 撞 22P02 转 404）', async () => {
    kbRepoMock.count.mockResolvedValueOnce(0);
    await expect(
      service.createFromFile(kbId, makeFile('a.pdf'), userId),
    ).rejects.toThrow(NotFoundException);
    const pgErr = new Error('invalid input syntax for type uuid');
    (pgErr as { driverError?: { code?: string } }).driverError = {
      code: '22P02',
    };
    kbRepoMock.count.mockRejectedValueOnce(pgErr);
    await expect(
      service.createFromFile(kbId, makeFile('a.pdf'), userId),
    ).rejects.toThrow(NotFoundException);
  });

  it('createFromFile：建行成功后自动入队解析（载荷 {knowledgeId}，attempts=2）；行建失败不入队', async () => {
    storageMock.save.mockResolvedValue(`${kbId}/enq-doc/enq-doc.pdf`);
    const result = await service.createFromFile(
      kbId,
      makeFile('方案.pdf'),
      userId,
    );
    expect(parseQueueMock.add).toHaveBeenCalledTimes(1);
    expect(parseQueueMock.add).toHaveBeenCalledWith(
      PARSE_QUEUE,
      { knowledgeId: result.id },
      expect.objectContaining({
        attempts: 2,
        // 指数退避（质量整改）：失败后 2s 起逐次翻倍，错峰重试（见 enqueueParse 注释）
        backoff: { type: 'exponential', delay: 2000 },
      }),
    );
    // 行建失败（DB 异常）时不入队——入队前置条件是建行成功
    parseQueueMock.add.mockClear();
    knowledgeRepoMock.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.createFromFile(kbId, makeFile('a.pdf'), userId),
    ).rejects.toThrow('db down');
    expect(parseQueueMock.add).not.toHaveBeenCalled();
  });

  it('createManual：保存 manualContent，type=manual status=pending；建行后入队', async () => {
    const result = await service.createManual(
      kbId,
      { title: '笔记', content: '内容正文' },
      userId,
    );
    expect(result.type).toBe('manual');
    expect(result.status).toBe('pending');
    expect(result.manualContent).toBe('内容正文');
    expect(result.title).toBe('笔记');
    expect(parseQueueMock.add).toHaveBeenCalledWith(
      PARSE_QUEUE,
      { knowledgeId: result.id },
      expect.anything(),
    );
  });

  it('list：透传 type/keyword/status 筛选，keyword 用 ILike，排序 createdAt DESC', async () => {
    knowledgeRepoMock.findAndCount.mockResolvedValue([[makeKnowledge()], 1]);
    await service.list(kbId, {
      page: 1,
      pageSize: 10,
      type: 'file',
      keyword: '研究',
      status: 'pending',
    });
    expect(knowledgeRepoMock.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kbId,
          type: 'file',
          status: 'pending',
          title: ILike('%研究%'),
        },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 10,
      }),
    );
  });

  it('getById/update：按 kbId+id 双重限定（防跨 KB 访问），不存在 → 404', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(makeKnowledge());
    const found = await service.getById(kbId, 'doc-1');
    expect(found.id).toBe('doc-1');
    expect(knowledgeRepoMock.findOne).toHaveBeenCalledWith({
      where: { kbId, id: 'doc-1' },
    });
    // 不存在 → 404
    knowledgeRepoMock.findOne.mockResolvedValue(null);
    await expect(service.getById(kbId, 'doc-x')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.update(kbId, 'doc-x', { title: '改名' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('update：重命名后其他字段不变', async () => {
    const doc = makeKnowledge();
    knowledgeRepoMock.findOne.mockResolvedValue(doc);
    const result = await service.update(kbId, 'doc-1', { title: '新标题' });
    expect(result.title).toBe('新标题');
    expect(result.fileType).toBe('pdf');
  });

  it('remove：事务内先删行再删块，提交后删文件（Task 1.5 事务化整改）', async () => {
    const doc = makeKnowledge();
    knowledgeRepoMock.findOne.mockResolvedValue(doc);
    await expect(service.remove(kbId, 'doc-1')).resolves.toBeUndefined();
    // 行删除在前（行锁仲裁点，见 remove 注释）+ chunks 删除在同一事务
    expect(managerMock.delete).toHaveBeenCalledWith(Knowledge, { id: 'doc-1' });
    expect(chunkServiceMock.deleteByKnowledgeInTx).toHaveBeenCalledWith(
      managerMock,
      'doc-1',
    );
    // 事务提交后清理磁盘文件
    expect(storageMock.remove).toHaveBeenCalledWith(doc.filePath);
    // 事务提交后 best-effort 清理图谱子图（Task 3.2 质量审查整改：实体/边
    // 的该文档 chunk 关联剔除 + chunk 镜像删除，防已删文档反查残留）
    expect(graphRepoMock.deleteKnowledgeSubgraph).toHaveBeenCalledWith(
      kbId,
      'doc-1',
    );
  });

  it('removeByKbInTx：事务内聚合级联删除该 KB 的文档/文件夹/标签/关联（Task 1.3）', async () => {
    // 有关联行时：先按文档 id 收集，删 knowledge 行（行锁仲裁点，见 remove
    // 注释）→ 删 chunks → 删 knowledge_tags → 删文件夹/标签
    managerMock.find.mockResolvedValueOnce([{ id: 'doc-1' }]);
    await service.removeByKbInTx(managerMock as unknown as EntityManager, kbId);
    expect(managerMock.delete).toHaveBeenCalledWith(Knowledge, { kbId });
    expect(chunkServiceMock.deleteByKbInTx).toHaveBeenCalledWith(
      managerMock,
      kbId,
    );
    expect(managerMock.delete).toHaveBeenCalledWith(KnowledgeTag, {
      knowledgeId: In(['doc-1']),
    });
    expect(managerMock.delete).toHaveBeenCalledWith(KnowledgeFolder, { kbId });
    expect(managerMock.delete).toHaveBeenCalledWith(Tag, { kbId });
  });

  it('createFolder：同级同名 → 409；父级不存在 → 404；新建根文件夹保存 parentId=null', async () => {
    // 同名冲突：查重命中 → 409
    folderRepoMock.findOne.mockResolvedValueOnce({
      id: 'folder-dup',
      kbId,
      parentId: null,
      name: '研发',
    } as KnowledgeFolder);
    await expect(service.createFolder(kbId, { name: '研发' })).rejects.toThrow(
      ConflictException,
    );
    // 父级不存在 → 404
    folderRepoMock.findOne.mockResolvedValueOnce(null);
    await expect(
      service.createFolder(kbId, {
        name: '子目录',
        parentId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow(NotFoundException);
    // 根文件夹创建成功
    folderRepoMock.findOne.mockResolvedValueOnce(null); // 查重未命中
    await service.createFolder(kbId, { name: '新建' });
    expect(folderRepoMock.create).toHaveBeenCalledWith({
      kbId,
      parentId: null,
      name: '新建',
    });
  });

  it('moveFolder：目标为自身/子孙 → 400（环检测，BFS 子树收集）；合法移动更新 parentId', async () => {
    // 树：A(根) → B → C
    folderRepoMock.findOne.mockResolvedValue({
      id: 'A',
      kbId,
      parentId: null,
      name: 'A',
    } as KnowledgeFolder);
    managerMock.find.mockResolvedValue([
      { id: 'A', parentId: null },
      { id: 'B', parentId: 'A' },
      { id: 'C', parentId: 'B' },
    ]);
    // 把 A 移到 B（A 的子孙）→ 400：事务内先做目标存在性复查（B 存在），
    // 再 BFS 环检测命中 B → 400
    managerMock.findOne.mockResolvedValueOnce({
      id: 'B',
      kbId,
      parentId: 'A',
      name: 'B',
    } as KnowledgeFolder);
    await expect(
      service.moveFolder(kbId, 'A', { parentId: 'B' }),
    ).rejects.toThrow(BadRequestException);
    // 把 A 移到新父级 D：子树 {A,B,C} 不含 D → 200，parentId 更新。
    // 事务内 findOne 调用序：①目标存在性复查（D）②同名查重（null）③回读保存结果
    managerMock.findOne
      .mockResolvedValueOnce({
        id: 'D',
        kbId,
        parentId: null,
        name: 'D',
      } as KnowledgeFolder)
      .mockResolvedValueOnce(null) // 同名查重未命中
      .mockResolvedValueOnce({
        id: 'A',
        kbId,
        parentId: 'D',
        name: 'A',
      } as KnowledgeFolder);
    const moved = await service.moveFolder(kbId, 'A', { parentId: 'D' });
    expect(managerMock.update).toHaveBeenCalledWith(
      KnowledgeFolder,
      { kbId, id: 'A' },
      { parentId: 'D' },
    );
    expect(moved.parentId).toBe('D');
  });

  it('moveFolder：目标父级存在性在事务内复查（并发删除目标 → 404，防孤儿节点）', async () => {
    // 源文件夹存在（事务外 ensureFolderInKb 通过）
    folderRepoMock.findOne.mockResolvedValue({
      id: 'A',
      kbId,
      parentId: null,
      name: 'A',
    } as KnowledgeFolder);
    managerMock.find.mockResolvedValue([{ id: 'A', parentId: null }]);
    // 事务内目标存在性复查：D 已被并发删除 → manager.findOne 未命中 → 404
    managerMock.findOne.mockResolvedValueOnce(null);
    await expect(
      service.moveFolder(kbId, 'A', { parentId: 'D' }),
    ).rejects.toThrow(NotFoundException);
    // 复查确实发生在事务内（走 manager 的事务快照，而非事务外 folderRepository）
    expect(managerMock.findOne).toHaveBeenCalled();
    expect(managerMock.update).not.toHaveBeenCalled();
  });

  it('deleteFolder：事务内先文档归根（folderId=null）再删子树文件夹行', async () => {
    folderRepoMock.findOne.mockResolvedValue({
      id: 'A',
      kbId,
      parentId: null,
      name: 'A',
    } as KnowledgeFolder);
    managerMock.find.mockResolvedValue([
      { id: 'A', parentId: null },
      { id: 'B', parentId: 'A' },
    ]);
    // 事务内存在性复查（与 moveFolder 同模式）：A 存在
    managerMock.findOne.mockResolvedValueOnce({
      id: 'A',
      kbId,
      parentId: null,
      name: 'A',
    } as KnowledgeFolder);
    await expect(service.deleteFolder(kbId, 'A')).resolves.toBeUndefined();
    expect(managerMock.update).toHaveBeenCalledWith(
      Knowledge,
      { kbId, folderId: In(['A', 'B']) },
      { folderId: null },
    );
    expect(managerMock.delete).toHaveBeenCalledWith(KnowledgeFolder, {
      kbId,
      id: In(['A', 'B']),
    });
  });

  it('deleteFolder：事务内复查存在性（并发删除竞态 → 404，而非静默 affected=0）', async () => {
    folderRepoMock.findOne.mockResolvedValue({
      id: 'A',
      kbId,
      parentId: null,
      name: 'A',
    } as KnowledgeFolder);
    // 事务内复查：A 已被并发删除 → manager.findOne 未命中 → 404
    managerMock.findOne.mockResolvedValueOnce(null);
    await expect(service.deleteFolder(kbId, 'A')).rejects.toThrow(
      NotFoundException,
    );
    expect(managerMock.delete).not.toHaveBeenCalled();
  });

  it('createFolder：DB 部分唯一索引兜底并发（save 撞 23505 → 409）', async () => {
    // 并发创建同名：服务层查重双双通过（默认 findOne → null），后提交者 save
    // 撞部分唯一索引 → 23505 → 捕获转 409
    const pgErr = new Error(
      'duplicate key value violates unique constraint "idx_knowledge_folders_kb_parent_name_unique"',
    );
    (pgErr as { driverError?: { code?: string } }).driverError = {
      code: '23505',
    };
    folderRepoMock.save.mockRejectedValueOnce(pgErr);
    await expect(
      service.createFolder(kbId, { name: '并发同名' }),
    ).rejects.toThrow(ConflictException);
  });

  it('createTag：知识库内重名 → 409；缺省 color 用默认色', async () => {
    tagRepoMock.findOne.mockResolvedValueOnce({
      id: 'tag-dup',
      kbId,
      name: '重要',
      color: '#ff0000',
    } as Tag);
    await expect(service.createTag(kbId, { name: '重要' })).rejects.toThrow(
      ConflictException,
    );
    tagRepoMock.findOne.mockResolvedValueOnce(null);
    await service.createTag(kbId, { name: '设计' });
    expect(tagRepoMock.create).toHaveBeenCalledWith({
      kbId,
      name: '设计',
      color: '#3b82f6',
    });
  });

  it('setKnowledgeTags：含其它 KB 的标签 → 400（防跨 KB 打标）；幂等去重', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(makeKnowledge());
    // 传入 2 个 tagId 但只查到 1 个属于该 KB → 400
    tagRepoMock.find.mockResolvedValueOnce([
      { id: 'tag-1', kbId, name: 'x', color: '#000000' } as Tag,
    ]);
    await expect(
      service.setKnowledgeTags(kbId, 'doc-1', { tagIds: ['tag-1', 'tag-2'] }),
    ).rejects.toThrow(BadRequestException);
    // 合法：全部属于该 KB → 事务内插新（ON CONFLICT DO NOTHING 跳过已存在行，含去重）
    tagRepoMock.find.mockResolvedValueOnce([
      { id: 'tag-1', kbId, name: 'x', color: '#000000' } as Tag,
    ]);
    // 显式清空 managerMock.find 实现（其它用例的持久 mock 会泄漏到本用例，见
    // deleteFolder 测试）——本用例现有关联为空，删旧步骤不应触发
    managerMock.find.mockResolvedValue([]);
    const result = await service.setKnowledgeTags(kbId, 'doc-1', {
      tagIds: ['tag-1', 'tag-1'],
    });
    expect(managerMock.find).toHaveBeenCalledWith(KnowledgeTag, {
      where: { knowledgeId: 'doc-1' },
      select: { tagId: true },
    });
    expect(managerMock.createQueryBuilder).toHaveBeenCalled();
    expect(insertQbMock.insert).toHaveBeenCalled();
    expect(insertQbMock.values).toHaveBeenCalledWith([
      { knowledgeId: 'doc-1', tagId: 'tag-1' },
    ]);
    expect(insertQbMock.orIgnore).toHaveBeenCalled();
    expect(insertQbMock.execute).toHaveBeenCalled();
    // 现有关联为空 → 无需清理旧行（全量替换的删旧步骤只删新集合之外的旧行）
    expect(managerMock.delete).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('setKnowledgeTags：并发插入撞 23505 → 幂等成功（不抛 500，23505 兜底）', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(makeKnowledge());
    tagRepoMock.find.mockResolvedValue([
      { id: 'tag-1', kbId, name: 'x', color: '#000000' } as Tag,
    ]);
    // 本用例现有关联为空（清掉其它用例泄漏的 find 实现，见上用例注释）
    managerMock.find.mockResolvedValue([]);
    // orIgnore 覆盖插入冲突后此分支理论不可达，但保留兜底：若未来改动触发 23505
    // （如换成普通 INSERT），不把并发竞态暴露成 500——幂等视为成功
    const pgErr = new Error(
      'duplicate key value violates unique constraint "idx_knowledge_tags_knowledge_tag_unique"',
    );
    (pgErr as { driverError?: { code?: string } }).driverError = {
      code: '23505',
    };
    insertQbMock.execute.mockRejectedValueOnce(pgErr);
    await expect(
      service.setKnowledgeTags(kbId, 'doc-1', { tagIds: ['tag-1'] }),
    ).resolves.toBeDefined();
  });

  it('update：folderId 必须属于该 KB（跨 KB 文件夹 404）；folderId=null 移回根', async () => {
    const doc = makeKnowledge();
    knowledgeRepoMock.findOne.mockResolvedValue(doc);
    // 跨 KB 文件夹：findOne 返回 null → 404
    folderRepoMock.findOne.mockResolvedValueOnce(null);
    await expect(
      service.update(kbId, 'doc-1', {
        folderId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow(NotFoundException);
    // 移回根：folderId=null 直接落列，不查文件夹
    const root = await service.update(kbId, 'doc-1', { folderId: null });
    expect(root.folderId).toBeNull();
  });

  // ==================== 状态 / 摘要 / 重新解析（Task 1.7 补测） ====================

  it('getStages：返回时间线 + 状态摘要（status/chunkCount/summary/updatedAt 字段结构）', async () => {
    const stage = {
      stage: 'summary',
      status: 'done',
      at: new Date().toISOString(),
    };
    knowledgeRepoMock.findOne.mockResolvedValue(
      makeKnowledge({
        status: 'ready',
        chunkCount: 3,
        summary: '摘要文本',
        parserStages: [stage],
      }),
    );
    const result = await service.getStages(kbId, 'doc-1');
    expect(result).toEqual({
      stages: [stage],
      status: 'ready',
      chunkCount: 3,
      summary: '摘要文本', // 质量审查整改：响应补 summary 字段（前端轮询 stages 即可拿当前摘要）
      updatedAt: expect.any(Date),
    });
    // 文档不存在 → 404（透传 getById 语义）
    knowledgeRepoMock.findOne.mockResolvedValue(null);
    await expect(service.getStages(kbId, 'doc-x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('regenerateSummary：入队 SUMMARY（载荷 {knowledgeId} + 公共配置）；404 不入队', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(makeKnowledge());
    // 202 语义在控制器层标注（@HttpCode(202) + { queued: true }，e2e 断言）；
    // 服务层只负责入队（异步任务，前端轮询 stages/summary 更新）
    await expect(
      service.regenerateSummary(kbId, 'doc-1'),
    ).resolves.toBeUndefined();
    expect(summaryQueueMock.add).toHaveBeenCalledWith(
      SUMMARY_QUEUE,
      { knowledgeId: 'doc-1' },
      // 公共配置单点（addQueueJob，见 parse-queue.constants.ts 注释）
      expect.objectContaining({
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
      }),
    );
    // 文档不存在 → 404（不入队）
    knowledgeRepoMock.findOne.mockResolvedValue(null);
    await expect(service.regenerateSummary(kbId, 'doc-x')).rejects.toThrow(
      NotFoundException,
    );
    expect(summaryQueueMock.add).toHaveBeenCalledTimes(1);
  });

  it('reparse：事务内行锁复查（pessimistic_write/FOR UPDATE）+ 删旧 chunks（含向量）+ 重置字段集合完整', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(
      makeKnowledge({ status: 'ready' }),
    );
    // 事务内行锁复查读到同一行（状态 ready 通过判定）
    managerMock.findOne.mockResolvedValue(makeKnowledge({ status: 'ready' }));
    await expect(service.reparse(kbId, 'doc-1')).resolves.toBeUndefined();
    // ①锁查询：pessimistic_write（FOR UPDATE，与 ParseProcessor 分块事务同仲裁
    // 模式——行锁把并发 reparse 串行化，见 reparse 方法头注释）
    expect(managerMock.findOne).toHaveBeenCalledWith(Knowledge, {
      where: { kbId, id: 'doc-1' },
      lock: { mode: 'pessimistic_write' },
    });
    // 删旧 chunks 即删向量（embedding 在 chunks 表内，删行即删向量）
    expect(managerMock.delete).toHaveBeenCalledWith(Chunk, {
      knowledgeId: 'doc-1',
    });
    // 重置字段集合完整：status/parsedText/summary/error/chunkCount/parserStages
    // 全量重置（reparse 语义：从零开始，见 reparse 方法头注释）
    expect(managerMock.update).toHaveBeenCalledWith(
      Knowledge,
      { kbId, id: 'doc-1' },
      {
        status: 'pending',
        parsedText: null,
        summary: null,
        error: '',
        chunkCount: 0,
        parserStages: [],
      },
    );
    // 入队 PARSE（载荷只带 knowledgeId）
    expect(parseQueueMock.add).toHaveBeenCalledWith(
      PARSE_QUEUE,
      { knowledgeId: 'doc-1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('reparse 防重：status 非 ready/failed（处理中）→ 409，不删块/不重置/不入队', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(
      makeKnowledge({ status: 'ready' }),
    );
    // 事务内行锁复查读到 parsing（并发另一轮解析/重解析进行中）——事务内
    // 状态判定拒绝，防并发双跑（行锁 + 事务内检查把判定/重置/提交串行化）
    managerMock.findOne.mockResolvedValue(makeKnowledge({ status: 'parsing' }));
    await expect(service.reparse(kbId, 'doc-1')).rejects.toThrow(
      ConflictException,
    );
    expect(managerMock.delete).not.toHaveBeenCalled();
    expect(managerMock.update).not.toHaveBeenCalled();
    expect(parseQueueMock.add).not.toHaveBeenCalled();
  });

  it('reparse：事务内存在性复查（404 前置后的并发删除竞态 → 404），不重置不入队', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(
      makeKnowledge({ status: 'ready' }),
    );
    // 行锁复查读不到行（文档在 404 前置与事务之间被并发删除）→ 404
    managerMock.findOne.mockResolvedValue(null);
    await expect(service.reparse(kbId, 'doc-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(managerMock.delete).not.toHaveBeenCalled();
    expect(managerMock.update).not.toHaveBeenCalled();
    expect(parseQueueMock.add).not.toHaveBeenCalled();
  });

  it('reparse：入队在事务提交后（enqueue 不得早于事务回调完成）', async () => {
    knowledgeRepoMock.findOne.mockResolvedValue(
      makeKnowledge({ status: 'ready' }),
    );
    managerMock.findOne.mockResolvedValue(makeKnowledge({ status: 'ready' }));
    // 顺序追踪：事务回调先执行，入队在其后（保证 worker 读到新状态——
    // pending/无旧产物，见 reparse 方法头注释「入队在事务提交后」）
    const order: string[] = [];
    dataSourceMock.transaction.mockImplementationOnce(
      async (cb: (m: EntityManager) => unknown) => {
        order.push('tx');
        return cb(managerMock as unknown as EntityManager);
      },
    );
    parseQueueMock.add.mockImplementationOnce(async () => {
      order.push('enqueue');
    });
    await service.reparse(kbId, 'doc-1');
    expect(order).toEqual(['tx', 'enqueue']);
  });

  // ==================== 批量操作（Task 1.8 质量审查整改补测） ====================

  it('batchDelete：set-based 两条 DELETE（Knowledge + Chunk 双限定）+ affected 计数 + 事务后清理文件', async () => {
    const doc1 = makeKnowledge({ id: 'doc-1' });
    const doc2 = makeKnowledge({
      id: 'doc-2',
      filePath: `${kbId}/doc-2/doc-2.pdf`,
    });
    knowledgeRepoMock.find.mockResolvedValue([doc1, doc2]);
    // Postgres DELETE 的 affected = 实际删除行数（质量审查整改：计数不再用事务前快照）
    managerMock.delete.mockResolvedValue({ affected: 2 });
    await expect(
      service.batchDelete(kbId, ['doc-1', 'doc-2']),
    ).resolves.toEqual({ deleted: 2 });
    // 事务内恰好两条 set-based 删除（不再 2N 条逐条 round-trip）：
    // ①Knowledge 行（kbId + id IN 双限定，行删除在前=行锁仲裁点，见 remove 注释）
    // ②Chunk 行（knowledgeId IN + kbId 双限定，Chunk 表有 kbId 列，防跨 KB 误删）
    expect(managerMock.delete).toHaveBeenCalledTimes(2);
    expect(managerMock.delete).toHaveBeenCalledWith(Knowledge, {
      kbId,
      id: In(['doc-1', 'doc-2']),
    });
    expect(managerMock.delete).toHaveBeenCalledWith(Chunk, {
      knowledgeId: In(['doc-1', 'doc-2']),
      kbId,
    });
    // 事务提交后按 filePath 快照清理磁盘（与 remove 同一约定）
    expect(storageMock.remove).toHaveBeenCalledTimes(2);
    expect(storageMock.remove).toHaveBeenCalledWith(doc1.filePath);
    expect(storageMock.remove).toHaveBeenCalledWith(doc2.filePath);
    // 批量删除同样清理图谱子图（Task 3.2 质量审查整改，与 remove 同语义）
    expect(graphRepoMock.deleteKnowledgeSubgraph).toHaveBeenCalledTimes(2);
    expect(graphRepoMock.deleteKnowledgeSubgraph).toHaveBeenCalledWith(
      kbId,
      'doc-1',
    );
    expect(graphRepoMock.deleteKnowledgeSubgraph).toHaveBeenCalledWith(
      kbId,
      'doc-2',
    );
  });

  it('batchDelete：affected 为 null（其它驱动）回退快照计数；跨 KB id 靠 kbId 条件在 SQL 层不命中', async () => {
    knowledgeRepoMock.find.mockResolvedValue([makeKnowledge({ id: 'doc-1' })]);
    managerMock.delete.mockResolvedValue({ affected: null });
    await expect(
      service.batchDelete(kbId, ['doc-1', 'foreign-doc']),
    ).resolves.toEqual({ deleted: 1 });
    // 快照只收集属于该 KB 的文档（filePath 供事务后清理）：foreign-doc 未命中
    expect(knowledgeRepoMock.find).toHaveBeenCalledWith({
      where: { kbId, id: In(['doc-1', 'foreign-doc']) },
      select: { id: true, filePath: true },
    });
    // 删除条件用全量去重 id + kbId 双限定（跨 KB id 由 SQL 层 kbId 条件自然
    // 不命中——宽容跳过，不需要客户端过滤）；affected=null 回退快照计数
    expect(managerMock.delete).toHaveBeenCalledWith(Knowledge, {
      kbId,
      id: In(['doc-1', 'foreign-doc']),
    });
  });

  it('batchReparse：去重（重复 id 只处理一次）+ 全部 queued → 计数与入队一致', async () => {
    const prepareSpy = vi.spyOn(service as any, 'prepareReparse');
    prepareSpy.mockResolvedValue('queued');
    try {
      await expect(
        service.batchReparse(kbId, ['doc-1', 'doc-1', 'doc-2']),
      ).resolves.toEqual({ queued: 2, skipped: 0, failed: 0 });
      // 每个唯一 id 恰好处理一次（去重路径：重复 id 不重复入队）
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      expect(parseQueueMock.add).toHaveBeenCalledTimes(2);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('batchReparse 部分失败：单条重置抛错 → failed 计数 + 记日志，不整批 500，其余继续', async () => {
    const prepareSpy = vi.spyOn(service as any, 'prepareReparse');
    prepareSpy
      .mockResolvedValueOnce('queued')
      .mockRejectedValueOnce(new Error('db boom'));
    try {
      await expect(
        service.batchReparse(kbId, ['doc-1', 'doc-2']),
      ).resolves.toEqual({ queued: 1, skipped: 0, failed: 1 });
      // 成功的入队、失败的记 warn（错误原因进服务日志，响应仅计数）
      expect(parseQueueMock.add).toHaveBeenCalledTimes(1);
      expect(parseQueueMock.add).toHaveBeenCalledWith(
        PARSE_QUEUE,
        { knowledgeId: 'doc-1' },
        expect.objectContaining({ attempts: 2 }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '批量重新解析失败（已跳过，可重试）: knowledgeId=doc-2',
        ),
        expect.any(Error),
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('batchSetTags 部分失败：单条打标抛错 → failed 计数 + 记日志，其余继续（逐条独立事务）', async () => {
    knowledgeRepoMock.find.mockResolvedValue([
      { id: 'doc-1' },
      { id: 'doc-2' },
    ]);
    tagRepoMock.find.mockResolvedValue([{ id: 'tag-1' }]); // ensureTagsInKb 通过
    const applySpy = vi.spyOn(service as any, 'applyKnowledgeTags');
    applySpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('tx boom'));
    try {
      await expect(
        service.batchSetTags(kbId, ['doc-1', 'doc-2'], ['tag-1']),
      ).resolves.toEqual({ updated: 1, failed: 1 });
      // 两条都尝试（逐条独立事务：失败不阻断下一条），失败条记 warn
      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '批量打标失败（已跳过，可重试）: knowledgeId=doc-2',
        ),
        expect.any(Error),
      );
    } finally {
      applySpy.mockRestore();
    }
  });

  it('batchSetTags：去重（重复 id 只处理一次）+ 空 tagIds 批量去标 → 计数真实', async () => {
    knowledgeRepoMock.find.mockResolvedValue([{ id: 'doc-1' }]);
    const applySpy = vi.spyOn(service as any, 'applyKnowledgeTags');
    applySpy.mockResolvedValue(undefined);
    try {
      await expect(
        service.batchSetTags(kbId, ['doc-1', 'doc-1', 'doc-1'], []),
      ).resolves.toEqual({ updated: 1, failed: 0 });
      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(applySpy).toHaveBeenCalledWith('doc-1', []);
    } finally {
      applySpy.mockRestore();
    }
  });
});

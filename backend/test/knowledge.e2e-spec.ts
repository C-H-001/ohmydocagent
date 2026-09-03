// 知识文档 e2e（Task 1.2）：三种创建方式（multipart 文件上传 / URL 导入 / 手动创建）、
// 分页列表（type/keyword 筛选、默认 createdAt DESC）、详情/重命名/删除、
// 删除时磁盘文件清理、KB 删除级联清理（knowledge 行 + 磁盘目录）。
// 上传 fixture 均为内存 buffer 假文件（PDF/docx 只保证魔数/头部，解析校验在 Task 1.4）。
// 说明：本文件沿用既有约定 beforeAll 显式 TRUNCATE 全部相关表（含本任务新增的
// knowledge 表，必须显式列入清单），保证与其它 e2e 文件互不污染。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Knowledge (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const ownerEmail = 'knowledge-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录（删除用例已触发目录清理，此处兜底）
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 本文件创建的文档 id：详情/重命名/删除用例复用
  let pdfId = '';
  let manualId = '';

  /** 假 PDF：%PDF-1.4 头部 + 最小对象 + EOF（解析任务 Task 1.4 才校验内容） */
  const fakePdf = () =>
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n',
      'utf8',
    );
  /** 假 docx：zip 魔数 PK.. + 文本（内容校验留到解析任务） */
  const fakeDocx = () =>
    Buffer.concat([
      Buffer.from('PK\u0003\u0004', 'latin1'),
      Buffer.from('fake docx content for task 1.4'),
    ]);
  /** 假 md/txt：纯文本 */
  const fakeText = (text: string) => Buffer.from(text, 'utf8');
  /** 假 exe：MZ 魔数（不在扩展名白名单内） */
  const fakeExe = () =>
    Buffer.concat([
      Buffer.from('MZ\u0090\u0000', 'latin1'),
      Buffer.from('fake exe'),
    ]);

  /** 判断磁盘文件是否存在（e2e 断言文件清理用；cwd 为 backend，uploads 相对 cwd） */
  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await access(path.join(process.cwd(), 'uploads', relativePath));
      return true;
    } catch {
      return false;
    }
  }

  /** 上传助手：multipart 内存 buffer + 文件名 */
  function uploadFile(
    kbId: string,
    filename: string,
    buffer: Buffer,
    token = ownerToken,
  ) {
    return request(server)
      .post(`/api/v1/kbs/${kbId}/file`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename });
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // Task 1.2 新增 knowledge 表必须显式列入清单（先清子表再清主表，避免 CASCADE 静默）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    // 前置：init 创建 Owner + 创建一个知识库供文档用例使用
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '文档测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '文档测试知识库' });
    expect(kbRes.status).toBe(201);
    kbIds.push(kbRes.body.id as string);
  });

  afterAll(async () => {
    // 清理本文件的上传产物：KB 删除/文档删除用例已触发目录清理，
    // 此处仅兜底删除本文件创建 KB 的 uploads 子目录（不动开发数据）
    for (const id of kbIds) {
      await rm(path.join(process.cwd(), 'uploads', id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    // 清理本文件产生的 rt:* 键（共享 Redis 隔离，沿用既有约定）
    const userRepo = app.get(getRepositoryToken(User));
    const redis = app.get(RedisService);
    const client = redis.getClient();
    for (const email of testEmails) {
      const u = await userRepo.findOne({ where: { email } });
      if (u) {
        const keys = await client.keys(`rt:${u.id}:*`);
        if (keys.length > 0) await client.del(...keys);
      }
    }
    await app.close();
  });

  it('POST /api/v1/kbs/:id/file 上传 PDF（multipart）→ 201，type=file status=pending', async () => {
    const res = await uploadFile(kbIds[0], '产品需求说明书.pdf', fakePdf());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.kbId).toBe(kbIds[0]);
    expect(res.body.type).toBe('file');
    expect(res.body.status).toBe('pending');
    expect(res.body.title).toBe('产品需求说明书'); // 标题 = 原文件名去扩展名
    expect(res.body.fileType).toBe('pdf');
    expect(res.body.fileSize).toBe(fakePdf().length);
    expect(res.body.filePath).toContain(`${kbIds[0]}/`);
    pdfId = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/file 上传 docx → 201', async () => {
    const res = await uploadFile(kbIds[0], '会议纪要.docx', fakeDocx());
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('file');
    expect(res.body.fileType).toBe('docx');
    expect(res.body.title).toBe('会议纪要');
  });

  it('POST /api/v1/kbs/:id/file 上传 md/txt → 201（中文文件名标题正确）', async () => {
    // 中文文件名：busboy 以 latin1 误读 UTF-8 字节，服务层须修复（见 KnowledgeService.decodeOriginalName）
    const md = await uploadFile(
      kbIds[0],
      '研究报告.md',
      fakeText('# 研究报告'),
    );
    expect(md.status).toBe(201);
    expect(md.body.title).toBe('研究报告');
    expect(md.body.fileType).toBe('md');
    const txt = await uploadFile(
      kbIds[0],
      'notes.txt',
      fakeText('plain notes'),
    );
    expect(txt.status).toBe(201);
    expect(txt.body.title).toBe('notes');
    expect(txt.body.fileType).toBe('txt');
  });

  it('POST /api/v1/kbs/:id/file 上传不支持的扩展名（exe/zip）→ 400', async () => {
    const exe = await uploadFile(kbIds[0], 'setup.exe', fakeExe());
    expect(exe.status).toBe(400);
    const zip = await uploadFile(
      kbIds[0],
      'archive.zip',
      Buffer.from('PK\u0003\u0004', 'latin1'),
    );
    expect(zip.status).toBe(400);
    // 无扩展名同样无法识别类型 → 400
    const noext = await uploadFile(kbIds[0], 'README', fakeText('readme'));
    expect(noext.status).toBe(400);
  });

  it('POST /api/v1/kbs/:id/file 未登录 → 401；KB 不存在 → 404；缺文件 → 400', async () => {
    const unauth = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/file`)
      .attach('file', fakePdf(), { filename: 'x.pdf' });
    expect(unauth.status).toBe(401);
    const missingKb = await uploadFile(
      '00000000-0000-4000-8000-000000000000',
      'x.pdf',
      fakePdf(),
    );
    expect(missingKb.status).toBe(404);
    // 非 UUID 格式 kbId 同样 404（不泄露 500，沿用 22P02 语义）
    const badKb = await uploadFile('not-a-uuid', 'x.pdf', fakePdf());
    expect(badKb.status).toBe(404);
    // 未带 file 字段 → multer 解析后 file 为空 → 400
    const noFile = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/file`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(noFile.status).toBe(400);
  });

  it('POST /api/v1/kbs/:id/url 导入 URL → 201，type=url，sourceUrl 保存', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceUrl: 'https://docs.example.com/guide' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('url');
    expect(res.body.status).toBe('pending');
    expect(res.body.sourceUrl).toBe('https://docs.example.com/guide');
    // 未传 title 时默认取 sourceUrl
    expect(res.body.title).toBe('https://docs.example.com/guide');
  });

  it('POST /api/v1/kbs/:id/url 非 http/https 协议（ftp://）→ 400；非法 URL → 400', async () => {
    const ftp = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceUrl: 'ftp://example.com/a.pdf' });
    expect(ftp.status).toBe(400);
    const invalid = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceUrl: 'not a url' });
    expect(invalid.status).toBe(400);
  });

  it('POST /api/v1/kbs/:id/manual 手动创建（title + content）→ 201，type=manual', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/manual`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '手动笔记', content: '这是手动创建的知识文档内容' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('manual');
    expect(res.body.status).toBe('pending');
    expect(res.body.title).toBe('手动笔记');
    expect(res.body.manualContent).toBe('这是手动创建的知识文档内容');
    manualId = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/manual 缺 content → 400；URL 导入到不存在的 KB → 404', async () => {
    const missingContent = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/manual`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '无内容' });
    expect(missingContent.status).toBe(400);
    const badKb = await request(server)
      .post('/api/v1/kbs/00000000-0000-4000-8000-000000000000/manual')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'x', content: 'y' });
    expect(badKb.status).toBe(404);
    const urlBadKb = await request(server)
      .post('/api/v1/kbs/00000000-0000-4000-8000-000000000000/url')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceUrl: 'https://example.com' });
    expect(urlBadKb.status).toBe(404);
  });

  it('GET /api/v1/kbs/:id/knowledge 列表（分页，默认按 createdAt DESC）', async () => {
    // 本文件已创建 6 个文档：pdf/docx/md/txt（file）+ url + manual
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?page=1&pageSize=10`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBe(6);
    expect(res.body.items).toHaveLength(6);
    // 默认排序 createdAt DESC：时间序列单调不增
    const times = res.body.items.map((i: any) =>
      new Date(i.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // 最后创建的手动文档应排最前，最先上传的 pdf 排最后
    expect(res.body.items[0].id).toBe(manualId);
    expect(res.body.items[5].id).toBe(pdfId);
    // 分页回显与切片：pageSize=2 时第 2 页从第 3 条开始
    const page2 = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?page=2&pageSize=2`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.total).toBe(6);
    expect(page2.body.items[0].id).not.toBe(manualId);
    // 不存在/非法 KB 的列表 → 404
    const missingKb = await request(server)
      .get('/api/v1/kbs/00000000-0000-4000-8000-000000000000/knowledge')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missingKb.status).toBe(404);
  });

  it('GET /api/v1/kbs/:id/knowledge?type=file 类型筛选', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?type=file&pageSize=20`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    for (const item of res.body.items) {
      expect(item.type).toBe('file');
    }
  });

  it('GET /api/v1/kbs/:id/knowledge?keyword=xxx 关键词筛选（title 匹配）', async () => {
    // 关键词「研究」只命中 md 文档（标题「研究报告」）；英文关键词同理
    const kw = await request(server)
      .get(
        `/api/v1/kbs/${kbIds[0]}/knowledge?keyword=${encodeURIComponent('研究')}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(kw.status).toBe(200);
    expect(kw.body.total).toBe(1);
    expect(kw.body.items[0].title).toBe('研究报告');
    // 无命中关键词 → 空列表 total=0
    const none = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?keyword=zzz-not-exist`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(none.status).toBe(200);
    expect(none.body.total).toBe(0);
    expect(none.body.items).toHaveLength(0);
  });

  it('GET /api/v1/kbs/:id/knowledge/:kid 详情；不存在/非法 id → 404', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${pdfId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pdfId);
    expect(res.body.title).toBe('产品需求说明书');
    expect(res.body.filePath).toContain(`${kbIds[0]}/`);
    const missing = await request(server)
      .get(
        `/api/v1/kbs/${kbIds[0]}/knowledge/00000000-0000-4000-8000-000000000000`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    const badId = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(badId.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/knowledge/:kid 重命名/更新标题', async () => {
    const res = await request(server)
      .put(`/api/v1/kbs/${kbIds[0]}/knowledge/${pdfId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '产品需求说明书-已重命名' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('产品需求说明书-已重命名');
    // 其余字段不受影响
    expect(res.body.type).toBe('file');
    expect(res.body.fileType).toBe('pdf');
    // 列表同步反映新标题
    const list = await request(server)
      .get(
        `/api/v1/kbs/${kbIds[0]}/knowledge?keyword=${encodeURIComponent('已重命名')}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.total).toBe(1);
    // 空标题/纯空白标题 → 400
    const blank = await request(server)
      .put(`/api/v1/kbs/${kbIds[0]}/knowledge/${pdfId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '   ' });
    expect(blank.status).toBe(400);
  });

  it('DELETE /api/v1/kbs/:id/knowledge/:kid 删除（204），并删除磁盘文件', async () => {
    // 新建一个专用文档用于删除验证（避免影响列表 total 断言）
    const created = await uploadFile(
      kbIds[0],
      '待删除.md',
      fakeText('# 待删除'),
    );
    expect(created.status).toBe(201);
    const delId = created.body.id as string;
    const filePath = created.body.filePath as string;
    expect(await fileExists(filePath)).toBe(true);
    const res = await request(server)
      .delete(`/api/v1/kbs/${kbIds[0]}/knowledge/${delId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
    // 行已删：详情 404，磁盘文件已清理
    const detail = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${delId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(404);
    expect(await fileExists(filePath)).toBe(false);
    // 删除不存在的文档 → 404
    const missing = await request(server)
      .delete(
        `/api/v1/kbs/${kbIds[0]}/knowledge/00000000-0000-4000-8000-000000000000`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
  });

  it('DELETE /api/v1/kbs/:id 删除 KB 级联删除其 knowledge（行 + 磁盘文件/目录）', async () => {
    // 新建独立 KB + 上传一个文件，验证级联删除
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '级联删除测试库' });
    expect(kbRes.status).toBe(201);
    const kb2Id = kbRes.body.id as string;
    kbIds.push(kb2Id);
    const upload = await uploadFile(kb2Id, '级联文档.pdf', fakePdf());
    expect(upload.status).toBe(201);
    expect(await fileExists(upload.body.filePath as string)).toBe(true);
    const kbDir = path.join(process.cwd(), 'uploads', kb2Id);
    await expect(access(kbDir)).resolves.toBeUndefined();
    const del = await request(server)
      .delete(`/api/v1/kbs/${kb2Id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    // knowledge 行已级联删除（查询仓库确认，无残留孤儿行）
    const repo = dataSource.getRepository(Knowledge);
    const left = await repo.find({ where: { kbId: kb2Id } });
    expect(left).toHaveLength(0);
    // 磁盘文件与 KB 目录均已清理
    expect(await fileExists(upload.body.filePath as string)).toBe(false);
    await expect(access(kbDir)).rejects.toThrow();
  });
});

// 文件夹树与标签 e2e（Task 1.3）：
// 文件夹：新建（根/嵌套/非法 parentId/空名称/同级同名 409）、树结构列表、重命名、
//   移动（换父级/移回根/目标不存在 404/移动到自身或子孙 400 环检测）、
//   删除（决策：文档归根 + 级联删子树）、文档移入/移出文件夹（folderId 更新，跨 KB 文件夹 404）
// 标签：创建（name+color/重复 409）、列表、更新、删除（解除关联）、
//   批量打标/去标（幂等、跨 KB 标签 400）、列表按 tagIds 筛选（决策：并集语义）
// 级联：删除 KB → 文件夹/标签/关联行全部清理（removeByKbInTx 聚合）
// 说明：本文件沿用既有约定 beforeAll 显式 TRUNCATE 全部相关表（含本任务新增的
// knowledge_tags / knowledge_folders / tags，先清子表再清主表），保证与其它 e2e 文件互不污染。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { KnowledgeFolder } from '../src/modules/knowledge/folder.entity.js';
import { KnowledgeTag } from '../src/modules/knowledge/knowledge-tag.entity.js';
import { Tag } from '../src/modules/knowledge/tag.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('KnowledgeFolderTag (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const ownerEmail = 'folder-tag-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id（首个为共享用例库）
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 共享用例库的文档 id（beforeAll 创建 3 个 manual 文档）
  let docA = '';
  let docB = '';
  let docC = '';
  // 文件夹 id（各用例按依赖顺序填充）
  let rootA = '';
  let childA = '';
  let grandchildA = '';
  let rootB = '';
  // 标签 id
  let tagA = '';
  let tagB = '';
  let tagC = '';

  /** 共享用例库 id 的快捷别名 */
  const kbId = () => kbIds[0];

  /** 带 Owner token 的 GET */
  function get(path: string) {
    return request(server)
      .get(path)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** 带 Owner token 的 POST（JSON body） */
  function post(path: string, body: unknown) {
    return request(server)
      .post(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body as object);
  }

  /** 带 Owner token 的 PUT（JSON body） */
  function put(path: string, body: unknown) {
    return request(server)
      .put(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body as object);
  }

  /** 带 Owner token 的 DELETE */
  function del(path: string) {
    return request(server)
      .delete(path)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** 手动创建文档并返回 id（断言 201） */
  async function makeDoc(kb: string, title: string): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/manual`, {
      title,
      content: `${title} 的内容正文`,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** 创建文件夹并返回 id（断言 201） */
  async function makeFolder(
    kb: string,
    name: string,
    parentId?: string,
  ): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/folders`, {
      name,
      ...(parentId ? { parentId } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** 创建标签并返回 id（断言 201） */
  async function makeTag(
    kb: string,
    name: string,
    color?: string,
  ): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/tags`, {
      name,
      ...(color ? { color } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离：Task 1.3 新增 knowledge_tags / knowledge_folders / tags
    // 必须显式列入清单（先清子表再清主表，避免 CASCADE 静默清空外键相关表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_tags, knowledge_folders, tags, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    // 前置：init 创建 Owner + 创建一个共享用例知识库 + 3 个文档
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '文件夹标签测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await post('/api/v1/kbs', { name: '文件夹标签测试库' });
    expect(kbRes.status).toBe(201);
    kbIds.push(kbRes.body.id as string);
    docA = await makeDoc(kbId(), '文档A');
    docB = await makeDoc(kbId(), '文档B');
    docC = await makeDoc(kbId(), '文档C');
  });

  afterAll(async () => {
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

  // ============ 文件夹：创建 ============

  it('POST /api/v1/kbs/:id/folders 新建根文件夹 → 201，返回 id/name/parentId=null', async () => {
    const res = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '研发资料',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.kbId).toBe(kbId());
    expect(res.body.name).toBe('研发资料');
    expect(res.body.parentId).toBeNull();
    expect(res.body.sortOrder).toBe(0);
    rootA = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/folders 新建嵌套子文件夹（parentId 指定）→ 201', async () => {
    const res = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '需求文档',
      parentId: rootA,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('需求文档');
    expect(res.body.parentId).toBe(rootA);
    childA = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/folders 新建三级文件夹 → 201', async () => {
    const res = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '2026 需求',
      parentId: childA,
    });
    expect(res.status).toBe(201);
    expect(res.body.parentId).toBe(childA);
    grandchildA = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/folders parentId 不存在 → 404；KB 不存在 → 404', async () => {
    const badParent = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '孤儿文件夹',
      parentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(badParent.status).toBe(404);
    const badKb = await post(
      '/api/v1/kbs/00000000-0000-4000-8000-000000000000/folders',
      { name: '无主文件夹' },
    );
    expect(badKb.status).toBe(404);
  });

  it('POST /api/v1/kbs/:id/folders 空名称/纯空白名称 → 400', async () => {
    const empty = await post(`/api/v1/kbs/${kbId()}/folders`, { name: '' });
    expect(empty.status).toBe(400);
    const blank = await post(`/api/v1/kbs/${kbId()}/folders`, { name: '   ' });
    expect(blank.status).toBe(400);
  });

  it('POST /api/v1/kbs/:id/folders 同级同名 → 409（名称唯一，服务层查重）', async () => {
    const dup = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '研发资料',
    });
    expect(dup.status).toBe(409);
    // 不同父级同名不受影响（parentId 维度隔离）
    const otherParent = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '研发资料',
      parentId: childA,
    });
    expect(otherParent.status).toBe(201);
  });

  // ============ 文件夹：树 / 重命名 / 移动 ============

  it('GET /api/v1/kbs/:id/folders 返回树结构（children 嵌套）', async () => {
    const res = await get(`/api/v1/kbs/${kbId()}/folders`);
    expect(res.status).toBe(200);
    // 根节点：rootA（含子级），以及上文「不同父级同名」创建的其它根节点
    const a = (res.body as any[]).find((f) => f.id === rootA);
    expect(a).toBeDefined();
    expect(a.name).toBe('研发资料');
    expect(a.parentId).toBeNull();
    expect(Array.isArray(a.children)).toBe(true);
    const child = a.children.find((f: any) => f.id === childA);
    expect(child).toBeDefined();
    expect(child.name).toBe('需求文档');
    const grand = child.children.find((f: any) => f.id === grandchildA);
    expect(grand).toBeDefined();
    expect(grand.name).toBe('2026 需求');
    expect(grand.children).toEqual([]);
    // KB 不存在 → 404
    const badKb = await get(
      '/api/v1/kbs/00000000-0000-4000-8000-000000000000/folders',
    );
    expect(badKb.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/folders/:fid 重命名 → 200；同级同名 → 409', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/folders/${rootA}`, {
      name: '研发资料库',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('研发资料库');
    expect(res.body.id).toBe(rootA);
    // 重命名为同层（根级）已有名称 → 409：先建一个根级文件夹作为冲突目标
    const sibling = await post(`/api/v1/kbs/${kbId()}/folders`, {
      name: '冲突名',
    });
    expect(sibling.status).toBe(201);
    const dup = await put(`/api/v1/kbs/${kbId()}/folders/${rootA}`, {
      name: '冲突名',
    });
    expect(dup.status).toBe(409);
    // 重命名为自身原名（no-op）→ 200
    const same = await put(`/api/v1/kbs/${kbId()}/folders/${rootA}`, {
      name: '研发资料库',
    });
    expect(same.status).toBe(200);
  });

  it('PUT /api/v1/kbs/:id/folders/:fid/move 移动文件夹到其他父级 → 200', async () => {
    rootB = await makeFolder(kbId(), '归档资料');
    const res = await put(`/api/v1/kbs/${kbId()}/folders/${childA}/move`, {
      parentId: rootB,
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(childA);
    expect(res.body.parentId).toBe(rootB);
  });

  it('PUT /api/v1/kbs/:id/folders/:fid/move 目标父级不存在 → 404', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/folders/${childA}/move`, {
      parentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/folders/:fid/move 移动到自身/子孙 → 400（环检测）', async () => {
    // 自身 → 400
    const toSelf = await put(`/api/v1/kbs/${kbId()}/folders/${rootA}/move`, {
      parentId: rootA,
    });
    expect(toSelf.status).toBe(400);
    // 子孙链：childA 已被「换父级」用例移到 rootB 下，此处新建一条 rootA 下的
    // 子孙链做环检测：把 rootA 移入自己的子孙 → 400
    const cycleChild = await makeFolder(kbId(), '环检测子', rootA);
    const cycleGrand = await makeFolder(kbId(), '环检测孙', cycleChild);
    const toDesc = await put(`/api/v1/kbs/${kbId()}/folders/${rootA}/move`, {
      parentId: cycleGrand,
    });
    expect(toDesc.status).toBe(400);
    // 移动不存在的文件夹 → 404
    const missing = await put(
      `/api/v1/kbs/${kbId()}/folders/00000000-0000-4000-8000-000000000000/move`,
      { parentId: rootB },
    );
    expect(missing.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/folders/:fid/move 移回根（parentId=null）→ 200', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/folders/${childA}/move`, {
      parentId: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.parentId).toBeNull();
  });

  // ============ 文件夹：删除（文档归根 + 级联删子树） ============

  it('DELETE /api/v1/kbs/:id/folders/:fid 删除文件夹（文档归根 + 级联删子文件夹）→ 204', async () => {
    const rootD = await makeFolder(kbId(), '待删除目录');
    const subD = await makeFolder(kbId(), '待删除子目录', rootD);
    // 文档 B 移入 rootD（删除后应归根，不随文件夹消失）
    const moveDoc = await put(`/api/v1/kbs/${kbId()}/knowledge/${docB}`, {
      folderId: rootD,
    });
    expect(moveDoc.status).toBe(200);
    expect(moveDoc.body.folderId).toBe(rootD);
    const res = await del(`/api/v1/kbs/${kbId()}/folders/${rootD}`);
    expect(res.status).toBe(204);
    // 文件夹行（含子树）已删
    const folderRepo = dataSource.getRepository(KnowledgeFolder);
    const left = await folderRepo.find({
      where: { kbId: kbId(), id: rootD },
    });
    expect(left).toHaveLength(0);
    const leftSub = await folderRepo.find({
      where: { kbId: kbId(), id: subD },
    });
    expect(leftSub).toHaveLength(0);
    // 文档归根：docB.folderId=null，文档仍在
    const docDetail = await get(`/api/v1/kbs/${kbId()}/knowledge/${docB}`);
    expect(docDetail.status).toBe(200);
    expect(docDetail.body.folderId).toBeNull();
    // 重复删除 → 404
    const again = await del(`/api/v1/kbs/${kbId()}/folders/${rootD}`);
    expect(again.status).toBe(404);
  });

  // ============ 文档与文件夹：移入/移出 ============

  it('PUT /api/v1/kbs/:id/knowledge/:kid 把文档移入文件夹（folderId 更新）→ 200', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}`, {
      folderId: childA,
    });
    expect(res.status).toBe(200);
    expect(res.body.folderId).toBe(childA);
  });

  it('GET /api/v1/kbs/:id/knowledge?folderId=xxx 按文件夹筛选', async () => {
    const res = await get(
      `/api/v1/kbs/${kbId()}/knowledge?folderId=${childA}&pageSize=20`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(docA);
    // 不存在的文件夹 → 404（快速失败，与详情语义一致）
    const bad = await get(
      `/api/v1/kbs/${kbId()}/knowledge?folderId=00000000-0000-4000-8000-000000000000`,
    );
    expect(bad.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/knowledge/:kid 文档移回根（folderId=null）→ 200', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}`, {
      folderId: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.folderId).toBeNull();
    // 文件夹筛选同步为空
    const filtered = await get(
      `/api/v1/kbs/${kbId()}/knowledge?folderId=${childA}&pageSize=20`,
    );
    expect(filtered.body.total).toBe(0);
  });

  it('PUT /api/v1/kbs/:id/knowledge/:kid folderId 指向其它 KB 的文件夹 → 404（防跨 KB）', async () => {
    const kb2Res = await post('/api/v1/kbs', { name: '跨库文件夹测试库' });
    expect(kb2Res.status).toBe(201);
    kbIds.push(kb2Res.body.id as string);
    const foreignFolder = await makeFolder(
      kb2Res.body.id as string,
      '别人的文件夹',
    );
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}`, {
      folderId: foreignFolder,
    });
    expect(res.status).toBe(404);
  });

  // ============ 标签：CRUD ============

  it('POST /api/v1/kbs/:id/tags 创建标签（name + color）→ 201；缺省 color 用默认值', async () => {
    const withColor = await post(`/api/v1/kbs/${kbId()}/tags`, {
      name: '重要',
      color: '#ff0000',
    });
    expect(withColor.status).toBe(201);
    expect(withColor.body.name).toBe('重要');
    expect(withColor.body.color).toBe('#ff0000');
    expect(withColor.body.kbId).toBe(kbId());
    tagA = withColor.body.id as string;
    const defColor = await post(`/api/v1/kbs/${kbId()}/tags`, { name: '设计' });
    expect(defColor.status).toBe(201);
    expect(defColor.body.color).toBe('#3b82f6');
    tagB = defColor.body.id as string;
  });

  it('POST /api/v1/kbs/:id/tags 同 KB 重复标签名 → 409；非法 color → 400', async () => {
    const dup = await post(`/api/v1/kbs/${kbId()}/tags`, { name: '设计' });
    expect(dup.status).toBe(409);
    const badColor = await post(`/api/v1/kbs/${kbId()}/tags`, {
      name: '颜色非法',
      color: 'red',
    });
    expect(badColor.status).toBe(400);
  });

  it('GET /api/v1/kbs/:id/tags 标签列表（创建顺序）', async () => {
    const res = await get(`/api/v1/kbs/${kbId()}/tags`);
    expect(res.status).toBe(200);
    const names = (res.body as any[]).map((t) => t.name);
    expect(names).toEqual(['重要', '设计']);
  });

  it('PUT /api/v1/kbs/:id/tags/:tagId 更新名称/颜色 → 200；重名 → 409', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/tags/${tagA}`, {
      name: '紧急',
      color: '#00ff00',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('紧急');
    expect(res.body.color).toBe('#00ff00');
    const dup = await put(`/api/v1/kbs/${kbId()}/tags/${tagA}`, {
      name: '设计',
    });
    expect(dup.status).toBe(409);
    const missing = await put(
      `/api/v1/kbs/${kbId()}/tags/00000000-0000-4000-8000-000000000000`,
      { name: '无主' },
    );
    expect(missing.status).toBe(404);
  });

  // ============ 标签：批量打标/去标 ============

  it('PUT /api/v1/kbs/:id/knowledge/:kid/tags 批量打标（tagIds 数组，幂等）', async () => {
    const first = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}/tags`, {
      tagIds: [tagA, tagB],
    });
    expect(first.status).toBe(200);
    expect((first.body as any[]).map((t) => t.id).sort()).toEqual(
      [tagA, tagB].sort(),
    );
    // 幂等：重复打标结果一致，且关联行不翻倍（删旧插新语义）
    const second = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}/tags`, {
      tagIds: [tagA, tagB],
    });
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(2);
    const relRepo = dataSource.getRepository(KnowledgeTag);
    const rels = await relRepo.find({ where: { knowledgeId: docA } });
    expect(rels).toHaveLength(2);
    // 文档不存在 → 404
    const missingDoc = await put(
      `/api/v1/kbs/${kbId()}/knowledge/00000000-0000-4000-8000-000000000000/tags`,
      { tagIds: [tagA] },
    );
    expect(missingDoc.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/knowledge/:kid/tags 含其它 KB 的标签 → 400（防跨 KB 打标）', async () => {
    const foreignTag = await makeTag(kbIds[1], '外部标签');
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}/tags`, {
      tagIds: [tagB, foreignTag],
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/v1/kbs/:id/tags/:tagId 删除标签（解除全部关联）→ 204', async () => {
    const res = await del(`/api/v1/kbs/${kbId()}/tags/${tagA}`);
    expect(res.status).toBe(204);
    // 关联行已清理（docA 仅剩 tagB）
    const relRepo = dataSource.getRepository(KnowledgeTag);
    const rels = await relRepo.find({ where: { knowledgeId: docA } });
    expect(rels.map((r) => r.tagId)).toEqual([tagB]);
    // 标签行已删
    const tagRepo = dataSource.getRepository(Tag);
    const left = await tagRepo.find({ where: { kbId: kbId(), id: tagA } });
    expect(left).toHaveLength(0);
    // 重复删除 → 404
    const again = await del(`/api/v1/kbs/${kbId()}/tags/${tagA}`);
    expect(again.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/knowledge/:kid/tags 空数组去标签 → 200 返回空列表', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}/tags`, {
      tagIds: [],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    const relRepo = dataSource.getRepository(KnowledgeTag);
    const rels = await relRepo.find({ where: { knowledgeId: docA } });
    expect(rels).toHaveLength(0);
  });

  it('GET /api/v1/kbs/:id/knowledge?tagIds=xxx 按标签筛选（并集语义）', async () => {
    // 准备：docA 打 tagB，docC 打 tagC（tagC 新建；docB 不打标）
    tagC = await makeTag(kbId(), '归档');
    await put(`/api/v1/kbs/${kbId()}/knowledge/${docA}/tags`, {
      tagIds: [tagB],
    });
    await put(`/api/v1/kbs/${kbId()}/knowledge/${docC}/tags`, {
      tagIds: [tagC],
    });
    // 单标签：仅命中对应文档
    const one = await get(
      `/api/v1/kbs/${kbId()}/knowledge?tagIds=${tagB}&pageSize=20`,
    );
    expect(one.status).toBe(200);
    expect(one.body.total).toBe(1);
    expect(one.body.items[0].id).toBe(docA);
    // 多标签（逗号分隔）：并集 → 2 个文档（docA ∪ docC）
    const union = await get(
      `/api/v1/kbs/${kbId()}/knowledge?tagIds=${tagB},${tagC}&pageSize=20`,
    );
    expect(union.status).toBe(200);
    expect(union.body.total).toBe(2);
    const unionIds = (union.body.items as any[]).map((i) => i.id).sort();
    expect(unionIds).toEqual([docA, docC].sort());
  });

  it('GET /api/v1/kbs/:id/knowledge?tagIds=非法值 宽容忽略（不 500）', async () => {
    // 全部片段非法 → 解析层全部丢弃 → 无标签过滤 → 返回全部文档（不 500）
    const allInvalid = await get(
      `/api/v1/kbs/${kbId()}/knowledge?tagIds=not-a-uuid,also-bad&pageSize=20`,
    );
    expect(allInvalid.status).toBe(200);
    expect(allInvalid.body.total).toBe(3);
    // 混合（非法 + 合法）：非法片段丢弃，合法片段照常过滤（宽容策略：不报错）
    const mixed = await get(
      `/api/v1/kbs/${kbId()}/knowledge?tagIds=not-a-uuid,${tagB}&pageSize=20`,
    );
    expect(mixed.status).toBe(200);
    expect(mixed.body.total).toBe(1);
    expect(mixed.body.items[0].id).toBe(docA);
  });

  // ============ KB 删除级联 ============

  it('DELETE /api/v1/kbs/:id 删除 KB 级联删除文件夹/标签/关联（removeByKbInTx 聚合）', async () => {
    const kb3Res = await post('/api/v1/kbs', { name: '级联清理测试库' });
    expect(kb3Res.status).toBe(201);
    const kb3 = kb3Res.body.id as string;
    kbIds.push(kb3);
    const f = await makeFolder(kb3, '级联文件夹');
    await makeFolder(kb3, '级联子文件夹', f);
    const t = await makeTag(kb3, '级联标签');
    const d = await makeDoc(kb3, '级联文档');
    await put(`/api/v1/kbs/${kb3}/knowledge/${d}/tags`, { tagIds: [t] });
    await put(`/api/v1/kbs/${kb3}/knowledge/${d}`, { folderId: f });
    const delKb = await del(`/api/v1/kbs/${kb3}`);
    expect(delKb.status).toBe(204);
    // 四类子表行全部无残留
    const folderRepo = dataSource.getRepository(KnowledgeFolder);
    const folders = await folderRepo.find({ where: { kbId: kb3 } });
    expect(folders).toHaveLength(0);
    const tagRepo = dataSource.getRepository(Tag);
    const tags = await tagRepo.find({ where: { kbId: kb3 } });
    expect(tags).toHaveLength(0);
    const relRepo = dataSource.getRepository(KnowledgeTag);
    const rels = await relRepo.find({ where: { knowledgeId: d } });
    expect(rels).toHaveLength(0);
    const docRepo = dataSource.getRepository(Knowledge);
    const docs = await docRepo.find({ where: { kbId: kb3 } });
    expect(docs).toHaveLength(0);
  });
});

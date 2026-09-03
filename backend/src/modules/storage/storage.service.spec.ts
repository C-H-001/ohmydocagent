// StorageService 单元测试：本地磁盘存储的核心安全属性（质量审查重点——路径安全）——
// 1. save 布局 uploads/{kbId}/{knowledgeId}/{knowledgeId}.{ext}，返回相对路径（不依赖原始文件名，
//    避免重名覆盖与路径穿越）
// 2. getAbsolutePath 拦截 `..` 穿越（resolve 后必须仍在 uploadDir 内）
// 3. remove 对不存在文件静默（force），removeKbDirectory 递归清理 KB 目录
// 4. 非法 kbId/knowledgeId（非 UUID）拒绝落盘（目录路径拼接待校验，防目录穿越）
// 测试用临时目录（os.tmpdir + mkdtemp），不触碰 backend/uploads。
import { BadRequestException } from '@nestjs/common';
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from './storage.service.js';
import { LocalStorageBackend } from './local-storage.backend.js';

describe('StorageService', () => {
  let service: StorageService;
  let tmpRoot: string;

  const KB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const KNOWLEDGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'ohmydocagent-storage-test-'));
    service = new StorageService({
      get: (key: string) => (key === 'uploadDir' ? tmpRoot : undefined),
    } as never);
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('save：写入 uploads/{kbId}/{knowledgeId}/{knowledgeId}.{ext}，返回相对路径', async () => {
    const rel = await service.save(
      {
        originalname: '产品需求说明书.pdf',
        buffer: Buffer.from('pdf-bytes'),
        size: 10,
      },
      KB_ID,
      KNOWLEDGE_ID,
    );
    expect(rel).toBe(`${KB_ID}/${KNOWLEDGE_ID}/${KNOWLEDGE_ID}.pdf`);
    // 磁盘真实存在且内容一致
    const abs = path.join(tmpRoot, rel);
    const content = await readFile(abs);
    expect(content.toString()).toBe('pdf-bytes');
    // 存储文件名不含原始文件名（防重名/穿越的关键设计）
    expect(rel).not.toContain('产品需求说明书');
  });

  it('save：原始文件名含路径分隔符/.. 时不影响落盘路径（只用 knowledgeId+ext）', async () => {
    const rel = await service.save(
      {
        originalname: '..\\..\\..\\etc\\passwd.pdf',
        buffer: Buffer.from('x'),
        size: 1,
      },
      KB_ID,
      KNOWLEDGE_ID,
    );
    expect(rel).toBe(`${KB_ID}/${KNOWLEDGE_ID}/${KNOWLEDGE_ID}.pdf`);
    expect(rel).not.toContain('..');
    // 安全：写出的文件仍在 KB 目录内
    await expect(access(path.join(tmpRoot, rel))).resolves.toBeUndefined();
  });

  it('save：非 UUID 的 kbId/knowledgeId 拒绝落盘（防目录穿越）', async () => {
    await expect(
      service.save(
        { originalname: 'a.pdf', buffer: Buffer.from('x'), size: 1 },
        '../../escape',
        KNOWLEDGE_ID,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.save(
        { originalname: 'a.pdf', buffer: Buffer.from('x'), size: 1 },
        KB_ID,
        '..%2F..%2Fescape',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('getAbsolutePath（LocalStorageBackend）：正常相对路径可解析，`..` 穿越被拦截', () => {
    const local = new LocalStorageBackend({ get: (k: string) => (k === 'uploadDir' ? tmpRoot : undefined) } as never);
    const abs = local.getAbsolutePath(`${KB_ID}/${KNOWLEDGE_ID}/x.pdf`);
    expect(abs).toBe(path.join(tmpRoot, KB_ID, KNOWLEDGE_ID, 'x.pdf'));
    // 穿越到 uploadDir 之外 → 抛错（不返回越界路径）
    expect(() => local.getAbsolutePath('../evil.txt')).toThrow(
      BadRequestException,
    );
    expect(() =>
      local.getAbsolutePath(`${KB_ID}/../../../etc/passwd`),
    ).toThrow(BadRequestException);
  });

  it(`getAbsolutePath：'' / '.' / '..' 均拒绝（不允许解析到 uploadDir 根本身）`, () => {
    const local = new LocalStorageBackend({ get: (k: string) => (k === 'uploadDir' ? tmpRoot : undefined) } as never);
    expect(() => local.getAbsolutePath('')).toThrow(BadRequestException);
    expect(() => local.getAbsolutePath('.')).toThrow(BadRequestException);
    expect(() => local.getAbsolutePath('..')).toThrow(BadRequestException);
  });

  it('save/removeKbDirectory：大写 UUID 目录名小写规范化（防大小写不一致孤儿目录）', async () => {
    const rel = await service.save(
      { originalname: 'u.pdf', buffer: Buffer.from('u'), size: 1 },
      KB_ID.toUpperCase(),
      KNOWLEDGE_ID.toUpperCase(),
    );
    // 返回路径与磁盘目录一律小写（与 PG uuid 列落库一致）
    expect(rel).toBe(`${KB_ID}/${KNOWLEDGE_ID}/${KNOWLEDGE_ID}.pdf`);
    await expect(access(path.join(tmpRoot, rel))).resolves.toBeUndefined();
    // removeKbDirectory 同样接受大写（能清掉小写目录）
    await expect(
      service.removeKbDirectory(KB_ID.toUpperCase()),
    ).resolves.toBeUndefined();
    await expect(access(path.join(tmpRoot, KB_ID))).rejects.toThrow();
  });

  it('remove：删除文件；不存在时静默（force），不抛错', async () => {
    const rel = await service.save(
      { originalname: 'd.pdf', buffer: Buffer.from('data'), size: 4 },
      KB_ID,
      KNOWLEDGE_ID,
    );
    await expect(access(path.join(tmpRoot, rel))).resolves.toBeUndefined();
    await service.remove(rel);
    await expect(access(path.join(tmpRoot, rel))).rejects.toThrow();
    // 再删一次（文件已不存在）也不抛
    await expect(service.remove(rel)).resolves.toBeUndefined();
    // 空路径/越界路径：跳过不删（绝不删到 uploadDir 之外）
    await expect(service.remove('')).resolves.toBeUndefined();
    await expect(service.remove('../outside.txt')).resolves.toBeUndefined();
  });

  it('remove：底层删除失败（如目录非空）也静默吞掉并返回（删除失败仅记日志不阻断）', async () => {
    // 构造一个非空目录，rm 无 recursive 会失败（模拟文件删除异常）
    const dir = path.join(tmpRoot, KB_ID, KNOWLEDGE_ID, 'sub');
    await mkdir(dir, { recursive: true });
    const rel = path.join(KB_ID, KNOWLEDGE_ID, 'sub');
    // remove 不抛错（内部 catch + 记日志），调用方（文档删除）不会被文件清理阻塞
    await expect(service.remove(rel)).resolves.toBeUndefined();
  });

  it('removeEmptyDirectory：仅空目录可删；非空/不存在/越界全部静默（best-effort）', async () => {
    // 空目录可删
    const dir = `${KB_ID}/${KNOWLEDGE_ID}/empty`;
    await mkdir(path.join(tmpRoot, dir), { recursive: true });
    await expect(service.removeEmptyDirectory(dir)).resolves.toBeUndefined();
    await expect(access(path.join(tmpRoot, dir))).rejects.toThrow();
    // 再次删除（不存在）→ 静默
    await expect(service.removeEmptyDirectory(dir)).resolves.toBeUndefined();
    // 非空目录删不掉但也不抛（仅记日志）
    const nonEmpty = `${KB_ID}/${KNOWLEDGE_ID}/non-empty`;
    await mkdir(path.join(tmpRoot, nonEmpty), { recursive: true });
    await writeFile(path.join(tmpRoot, nonEmpty, 'a.txt'), 'x');
    await expect(
      service.removeEmptyDirectory(nonEmpty),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(tmpRoot, nonEmpty, 'a.txt')),
    ).resolves.toBeUndefined();
    // 空串/越界路径：跳过不删
    await expect(service.removeEmptyDirectory('')).resolves.toBeUndefined();
    await expect(
      service.removeEmptyDirectory('../outside'),
    ).resolves.toBeUndefined();
  });

  it('removeKbDirectory：递归清理整个 KB 目录；不存在时静默', async () => {
    const rel = await service.save(
      { originalname: 'k.pdf', buffer: Buffer.from('k'), size: 1 },
      KB_ID,
      KNOWLEDGE_ID,
    );
    await expect(access(path.join(tmpRoot, rel))).resolves.toBeUndefined();
    await service.removeKbDirectory(KB_ID);
    await expect(access(path.join(tmpRoot, KB_ID))).rejects.toThrow();
    // 重复清理/不存在 → 静默
    await expect(service.removeKbDirectory(KB_ID)).resolves.toBeUndefined();
    // 非法 kbId 拒绝清理（防目录穿越）
    await expect(service.removeKbDirectory('..%2F..%2Fescape')).rejects.toThrow(
      BadRequestException,
    );
  });
});

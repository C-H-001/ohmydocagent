// minio-storage.backend.spec.ts
// MinIO 存储后端核心路径单测（mock minio client——不真连 MinIO）：
// 保存返回相对路径、删除幂等、KB 前缀删除、读取、bucket 懒创建。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { MinioStorageBackend } from './minio-storage.backend.js';

const KB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup() {
  const client = {
    bucketExists: vi.fn().mockResolvedValue(true),
    makeBucket: vi.fn().mockResolvedValue(undefined),
    putObject: vi.fn().mockResolvedValue(undefined),
    removeObject: vi.fn().mockResolvedValue(undefined),
    removeObjects: vi.fn().mockResolvedValue(undefined),
    listObjectsV2: vi.fn(),
    getObject: vi.fn(),
  };
  const backend = new MinioStorageBackend({
    get: (k: string) => {
      const map: Record<string, string> = {
        'minio.bucket': 'test-bucket',
        'minio.endpoint': '127.0.0.1',
        'minio.port': '9000',
        'minio.accessKey': 'k',
        'minio.secretKey': 's',
      };
      return map[k];
    },
  } as never);
  // 注入 mock client
  (backend as any).client = client;
  return { backend, client };
}

describe('MinioStorageBackend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('save：putObject 到 bucket（key=相对路径），bucket 懒创建', async () => {
    const { backend, client } = setup();
    client.bucketExists.mockResolvedValueOnce(false);
    const rel = await backend.save(
      { originalname: 'a.pdf', buffer: Buffer.from('x'), size: 1 },
      KB_ID,
      KID,
    );
    expect(rel).toBe(`${KB_ID}/${KID}/${KID}.pdf`);
    expect(client.makeBucket).toHaveBeenCalledWith('test-bucket');
    expect(client.putObject).toHaveBeenCalledWith(
      'test-bucket',
      `${KB_ID}/${KID}/${KID}.pdf`,
      expect.any(Buffer),
      1,
      expect.objectContaining({ 'Content-Type': expect.any(String) }),
    );
  });

  it('save：非 UUID kbId 拒绝（防目录穿越）', async () => {
    const { backend } = setup();
    await expect(
      backend.save(
        { originalname: 'a.pdf', buffer: Buffer.from('x'), size: 1 },
        '../../escape',
        KID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('saveAttachment：attachments/{sessionId}/{attachmentId}.{ext}', async () => {
    const { backend, client } = setup();
    const rel = await backend.saveAttachment(
      { originalname: 'i.png', buffer: Buffer.from('p'), size: 1 },
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    expect(rel).toBe(
      'attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png',
    );
    expect(client.putObject).toHaveBeenCalled();
  });

  it('remove：removeObject 幂等（不存在静默）', async () => {
    const { backend, client } = setup();
    client.removeObject.mockRejectedValueOnce(new Error('NoSuchKey'));
    await expect(
      backend.remove(`${KB_ID}/${KID}/${KID}.pdf`),
    ).resolves.toBeUndefined(); // 失败记日志不抛
    expect(client.removeObject).toHaveBeenCalledWith(
      'test-bucket',
      `${KB_ID}/${KID}/${KID}.pdf`,
    );
  });

  it('removeKbDirectory：前缀 {kbId}/ 遍历删除', async () => {
    const { backend, client } = setup();
    // Readable.from 直接生成对象流（事件时序稳定）
    client.listObjectsV2.mockReturnValue(
      Readable.from([{ name: `${KB_ID}/a.pdf` }, { name: `${KB_ID}/b.txt` }]),
    );
    await backend.removeKbDirectory(KB_ID);
    expect(client.removeObjects).toHaveBeenCalledWith('test-bucket', [
      `${KB_ID}/a.pdf`,
      `${KB_ID}/b.txt`,
    ]);
  });

  it('readBuffer：getObject 流汇聚为 Buffer', async () => {
    const { backend, client } = setup();
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('hello'));
    stream.push(null);
    client.getObject.mockResolvedValue(stream);
    const buf = await backend.readBuffer(`${KB_ID}/${KID}/${KID}.pdf`);
    expect(buf.toString()).toBe('hello');
  });

  it('removeEmptyDirectory：no-op（对象存储无目录）', async () => {
    const { backend } = setup();
    await expect(backend.removeEmptyDirectory('x')).resolves.toBeUndefined();
  });
});

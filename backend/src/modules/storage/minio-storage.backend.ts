// minio-storage.backend.ts
// MinIO 对象存储后端（S3 兼容）：上传文件存入 bucket 对象（key=相对路径），
// 删除/读取按对象操作。路径语义与本地后端一致（`{kbId}/{knowledgeId}/...`、
// `attachments/{sessionId}/...`），数据库只存相对路径——两个后端可无缝切换。
//
// 安全设计（与本地后端对齐）：
// 1. key 由服务端 UUID 组成（{kbId}/{knowledgeId}/{knowledgeId}.{ext}），
//    原始文件名不参与——无路径穿越/重名覆盖注入面
// 2. kbId/knowledgeId/sessionId/attachmentId 校验 UUID 格式 + 小写规范化
// 3. 扩展名白名单（仅字母数字）
// 4. remove/removeKbDirectory 对不存在对象幂等（MinIO 删除不存在对象不报错）
import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageBackend, UploadedFileLike } from './storage-backend.interface.js';

/** UUID 格式（同本地后端） */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MinioStorageBackend implements StorageBackend, OnApplicationBootstrap {
  private readonly logger = new Logger(MinioStorageBackend.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;
  /** bucket 确认标志：懒创建（save 前 ensure），避免生命周期钩子不可靠 */
  private bucketReady = false;

  constructor(config: ConfigService) {
    // 嵌套配置读取（configuration.ts 的 minio 段：minio.endpoint/.port/.bucket...）
    this.bucket = config.get<string>('minio.bucket') ?? 'ohmydocagent';
    // 端点解析：endpoint 配置可能带协议/端口（如 127.0.0.1:9000 或 minio:9000）
    const endpoint = config.get<string>('minio.endpoint') ?? '127.0.0.1';
    const port = parseInt(config.get<string>('minio.port') ?? '9000', 10);
    const useSSL = config.get<string>('minio.useSSL') === 'true';
    this.client = new Minio.Client({
      endPoint: endpoint,
      port,
      useSSL,
      accessKey: config.get<string>('minio.accessKey') ?? 'ohmydocagent',
      secretKey: config.get<string>('minio.secretKey') ?? 'ohmydocagent-local-secret',
    });
  }

  /** 确保 bucket 存在（幂等懒创建；失败抛错让上传报明确错误） */
  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`MinIO bucket 已创建: ${this.bucket}`);
    }
    this.bucketReady = true;
  }

  /** 启动时预创建（Nest DI 管理时提前建好；懒创建兜底在 save 前） */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureBucket();
    } catch (err) {
      this.logger.warn(`MinIO bucket 预创建失败（将在首次上传时重试）: ${(err as Error).message}`);
    }
  }

  /** 保存知识文档：putObject(bucket, {kbId}/{knowledgeId}/{knowledgeId}.{ext}) */
  async save(
    file: UploadedFileLike,
    kbId: string,
    knowledgeId: string,
  ): Promise<string> {
    kbId = kbId.toLowerCase();
    knowledgeId = knowledgeId.toLowerCase();
    if (!UUID_RE.test(kbId) || !UUID_RE.test(knowledgeId)) {
      throw new BadRequestException('非法的知识库/文档 id');
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!/^\.[a-z0-9]{1,10}$/.test(ext)) {
      throw new BadRequestException('不支持的文件类型');
    }
    await this.ensureBucket();
    const key = `${kbId}/${knowledgeId}/${knowledgeId}${ext}`;
    await this.client.putObject(this.bucket, key, file.buffer, file.size, {
      'Content-Type': file.mimetype ?? 'application/octet-stream',
    });
    return key;
  }

  /** 保存文档图片资产（多模态）：{kbId}/{knowledgeId}/images/{key}.{ext} */
  async saveImage(
    kbId: string,
    knowledgeId: string,
    assetKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    kbId = kbId.toLowerCase();
    knowledgeId = knowledgeId.toLowerCase();
    if (!UUID_RE.test(kbId) || !UUID_RE.test(knowledgeId)) {
      throw new BadRequestException('非法的知识库/文档 id');
    }
    const safe = (assetKey || 'img').replace(/[^a-zA-Z0-9._-]/g, '_');
    // assetKey 可能已带扩展（parser 图名如 asset-1.jpg）——匹配则不重复追加
    const ext = MIME_EXT[mimeType] ?? '.png';
    const keyLower = safe.toLowerCase();
    const hasExt = Object.values(MIME_EXT).some((e) => keyLower.endsWith(e));
    await this.ensureBucket();
    const key = `${kbId}/${knowledgeId}/images/${hasExt ? safe : safe + ext}`;
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': mimeType || 'application/octet-stream',
    });
    return key;
  }

  /** 保存会话附件：attachments/{sessionId}/{attachmentId}.{ext} */
  async saveAttachment(
    file: UploadedFileLike,
    sessionId: string,
    attachmentId: string,
  ): Promise<string> {
    sessionId = sessionId.toLowerCase();
    attachmentId = attachmentId.toLowerCase();
    if (!UUID_RE.test(sessionId) || !UUID_RE.test(attachmentId)) {
      throw new BadRequestException('非法的会话/附件 id');
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!/^\.[a-z0-9]{1,10}$/.test(ext)) {
      throw new BadRequestException('不支持的文件类型');
    }
    await this.ensureBucket();
    const key = `attachments/${sessionId}/${attachmentId}${ext}`;
    await this.client.putObject(this.bucket, key, file.buffer, file.size, {
      'Content-Type': file.mimetype ?? 'application/octet-stream',
    });
    return key;
  }

  /** 删除对象（幂等：MinIO 删除不存在对象静默成功） */
  async remove(relativePath: string): Promise<void> {
    if (!relativePath) return;
    try {
      await this.client.removeObject(this.bucket, relativePath);
    } catch (err) {
      this.logger.warn(`MinIO 删除对象失败: ${relativePath}`, err as Error);
    }
  }

  /** 删除 KB 全部对象（前缀 {kbId}/ 遍历删除，幂等） */
  async removeKbDirectory(kbId: string): Promise<void> {
    const prefix = `${kbId.toLowerCase()}/`;
    try {
      const names: string[] = [];
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (obj) => { if (obj.name) names.push(obj.name); });
        stream.on('end', () => resolve());
        stream.on('error', (e) => reject(e));
      });
      if (names.length > 0) {
        await this.client.removeObjects(this.bucket, names);
      }
    } catch (err) {
      this.logger.warn(`MinIO 删除 KB 对象失败: ${kbId}`, err as Error);
    }
  }

  /** 对象存储无目录概念 → no-op（保持接口一致） */
  async removeEmptyDirectory(_relativePath: string): Promise<void> {
    // 无操作：MinIO 是扁平对象空间
  }

  /** 读取对象为 Buffer */
  async readBuffer(relativePath: string): Promise<Buffer> {
    const stream = await this.createReadStream(relativePath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** 读取对象为流（解析服务/签名端点用） */
  async createReadStream(relativePath: string): Promise<Readable> {
    try {
      return await this.client.getObject(this.bucket, relativePath);
    } catch (err) {
      throw new BadRequestException('文件不存在');
    }
  }
}

/** MIME → 文件扩展名（saveImage 用；白名单与解析服务一致） */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

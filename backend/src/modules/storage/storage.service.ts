// 存储服务门面（Task 1.2 + MinIO 支持）：按 STORAGE_BACKEND 配置委托
//   local → LocalStorageBackend（既有磁盘实现，见 local-storage.backend.ts）
//   minio → MinioStorageBackend（对象存储，见 minio-storage.backend.ts）
// 对外 API 保持一致（save/saveAttachment/remove/removeKbDirectory/removeEmptyDirectory
// + 新增 readBuffer/createReadStream 供解析/预览读取），调用方无需关心后端差异。
// 路径语义：一律相对路径（{kbId}/{knowledgeId}/{knowledgeId}.{ext}、
// attachments/{sessionId}/{attachmentId}.{ext}），DB 只存相对路径。
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { LocalStorageBackend } from './local-storage.backend.js';
import { MinioStorageBackend } from './minio-storage.backend.js';
import type {
  StorageBackend,
  UploadedFileLike,
} from './storage-backend.interface.js';

// 兼容导出：调用方从 storage.service 导入 UploadedFileLike（既有约定）
export type { UploadedFileLike } from './storage-backend.interface.js';

@Injectable()
export class StorageService implements StorageBackend {
  private readonly backend: StorageBackend;

  constructor(config: ConfigService) {
    const mode = config.get<string>('storageBackend') ?? 'local';
    this.backend =
      mode === 'minio' ? new MinioStorageBackend(config) : new LocalStorageBackend(config);
  }

  async save(
    file: UploadedFileLike,
    kbId: string,
    knowledgeId: string,
  ): Promise<string> {
    return this.backend.save(file, kbId, knowledgeId);
  }

  async saveAttachment(
    file: UploadedFileLike,
    sessionId: string,
    attachmentId: string,
  ): Promise<string> {
    return this.backend.saveAttachment(file, sessionId, attachmentId);
  }

  /** 保存文档图片资产（多模态 asset 落盘，见 storage-backend.interface） */
  async saveImage(
    kbId: string,
    knowledgeId: string,
    assetKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    return this.backend.saveImage(kbId, knowledgeId, assetKey, buffer, mimeType);
  }

  async remove(relativePath: string): Promise<void> {
    return this.backend.remove(relativePath);
  }

  async removeKbDirectory(kbId: string): Promise<void> {
    return this.backend.removeKbDirectory(kbId);
  }

  async removeEmptyDirectory(relativePath: string): Promise<void> {
    return this.backend.removeEmptyDirectory(relativePath);
  }

  /** 读取对象为 Buffer（解析器/预览用；MinIO 下从 bucket 拉取） */
  async readBuffer(relativePath: string): Promise<Buffer> {
    return this.backend.readBuffer(relativePath);
  }

  /** 读取对象为流（签名文件端点流式返回用） */
  async createReadStream(relativePath: string): Promise<Readable> {
    return this.backend.createReadStream(relativePath);
  }
}

// local-storage.backend.ts
// 本地磁盘存储后端（Task 1.2 既有逻辑迁移）：上传文件落盘 UPLOAD_DIR、
// 删除、KB 目录清理。安全设计见 storage.service.ts 文件头（目录 UUID 校验、
// 扩展名白名单、knowledgeId.ext 命名防穿越、大小写规范化）。
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageBackend, UploadedFileLike } from './storage-backend.interface.js';

/** UUID 格式（服务端生成 id 与 URL 参数共用，防目录穿越） */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LocalStorageBackend implements StorageBackend {
  private readonly logger = new Logger(LocalStorageBackend.name);
  /** 上传根目录绝对路径：UPLOAD_DIR 相对 backend cwd 解析 */
  private readonly uploadDir: string;

  constructor(config: ConfigService) {
    this.uploadDir = path.resolve(config.get<string>('uploadDir') ?? 'uploads');
  }

  /** 保存上传文件：UPLOAD_DIR/{kbId}/{knowledgeId}/{knowledgeId}.{ext}，返回相对路径 */
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
    const dir = path.join(this.uploadDir, kbId, knowledgeId);
    await mkdir(dir, { recursive: true });
    const filename = `${knowledgeId}${ext}`;
    await writeFile(path.join(dir, filename), file.buffer);
    return `${kbId}/${knowledgeId}/${filename}`;
  }

  /** 保存文档图片资产（多模态）：UPLOAD_DIR/{kbId}/{knowledgeId}/images/{key}.{ext} */
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
    const dir = path.join(this.uploadDir, kbId, knowledgeId, 'images');
    await mkdir(dir, { recursive: true });
    const filename = hasExt ? safe : `${safe}${ext}`;
    await writeFile(path.join(dir, filename), buffer);
    return `${kbId}/${knowledgeId}/images/${filename}`;
  }

  /** 保存会话附件：UPLOAD_DIR/attachments/{sessionId}/{attachmentId}.{ext} */
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
    const dir = path.join(this.uploadDir, 'attachments', sessionId);
    await mkdir(dir, { recursive: true });
    const filename = `${attachmentId}${ext}`;
    await writeFile(path.join(dir, filename), file.buffer);
    return `attachments/${sessionId}/${filename}`;
  }

  /** 删除文件（幂等：不存在静默） */
  async remove(relativePath: string): Promise<void> {
    if (!relativePath) return;
    let abs: string;
    try {
      abs = this.getAbsolutePath(relativePath);
    } catch {
      return;
    }
    try {
      await rm(abs, { force: true });
    } catch (err) {
      this.logger.warn(`删除文件失败: ${relativePath}`, err as Error);
    }
  }

  /** 删除 KB 目录（幂等：不存在静默；UUID 校验防误删） */
  async removeKbDirectory(kbId: string): Promise<void> {
    kbId = kbId.toLowerCase();
    if (!UUID_RE.test(kbId)) {
      throw new BadRequestException('非法的知识库 id');
    }
    const abs = path.join(this.uploadDir, kbId);
    try {
      await rm(abs, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`删除 KB 目录失败: ${kbId}`, err as Error);
    }
  }

  /** 删除空目录（best-effort 幂等） */
  async removeEmptyDirectory(relativePath: string): Promise<void> {
    if (!relativePath) return;
    let abs: string;
    try {
      abs = this.getAbsolutePath(relativePath);
    } catch {
      return;
    }
    try {
      await rmdir(abs);
    } catch {
      // 目录不存在/非空/删除失败全部静默
    }
  }

  /** 读取对象为 Buffer */
  async readBuffer(relativePath: string): Promise<Buffer> {
    return readFile(this.getAbsolutePath(relativePath));
  }

  /** 读取对象为流 */
  async createReadStream(relativePath: string): Promise<Readable> {
    return createReadStream(this.getAbsolutePath(relativePath));
  }

  /**
   * 相对路径 → 绝对路径（`..` 穿越防护：resolve 后必须落在 UPLOAD_DIR 内，
   * 且拒绝 uploadDir 根本身）。本地后端特定能力（对象存储无路径概念）。
   */
  getAbsolutePath(relativePath: string): string {
    const full = path.resolve(this.uploadDir, relativePath);
    if (full === this.uploadDir || !full.startsWith(this.uploadDir + path.sep)) {
      throw new BadRequestException('无效的文件路径');
    }
    return full;
  }
}

/** MIME → 文件扩展名（saveImage 用；白名单与解析服务一致） */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

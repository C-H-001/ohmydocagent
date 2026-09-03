// storage-backend.interface.ts
// 存储后端抽象（Task: MinIO 对象存储支持）：本地磁盘与 MinIO 实现同一契约。
// 路径语义：一律用**相对路径**（如 `{kbId}/{knowledgeId}/{knowledgeId}.pdf`、
// `attachments/{sessionId}/{attachmentId}.png`）——数据库只存相对路径，
// 后端负责映射到实际存储（本地：UPLOAD_DIR 下；MinIO：bucket 内对象 key）。
import { Readable } from 'node:stream';

/** 上传文件结构（multer memoryStorage File 子集） */
export interface UploadedFileLike {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype?: string;
}

export interface StorageBackend {
  /** 保存知识文档：返回相对路径 */
  save(file: UploadedFileLike, kbId: string, knowledgeId: string): Promise<string>;
  /** 保存文档图片资产（多模态 asset 落盘）：images/{assetKey}.{ext} 相对路径 */
  saveImage(
    kbId: string,
    knowledgeId: string,
    assetKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string>;
  /** 保存会话附件：返回相对路径 */
  saveAttachment(
    file: UploadedFileLike,
    sessionId: string,
    attachmentId: string,
  ): Promise<string>;
  /** 删除单个对象/文件（幂等） */
  remove(relativePath: string): Promise<void>;
  /** 删除知识库全部文件（幂等） */
  removeKbDirectory(kbId: string): Promise<void>;
  /** 删除空目录（本地语义；对象存储无目录 → no-op） */
  removeEmptyDirectory(relativePath: string): Promise<void>;
  /** 读取对象为 Buffer（解析器/预览用） */
  readBuffer(relativePath: string): Promise<Buffer>;
  /** 读取对象为流（签名文件端点流式返回用） */
  createReadStream(relativePath: string): Promise<Readable>;
}

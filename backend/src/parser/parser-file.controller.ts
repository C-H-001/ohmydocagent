// parser-file.controller.ts
// 解析服务文件访问端点：上传文件以「签名临时 URL」暴露给 ohmydocagent/parser 服务
// 拉取（GrpcParser 生成 token，本端点校验 HMAC + 过期时间后流式返回文件）。
//
// 安全：仅接受带有效签名的 token（ENCRYPTION_KEY 派生，10 分钟过期）；路径
// 限定 UPLOAD_DIR 内（StorageService 路径防护复用）；不对外暴露目录结构。
import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { StorageService } from '../modules/storage/storage.service.js';

@Injectable()
export class ParserFileGuard {
  constructor(private readonly config: ConfigService) {}
  /** 生成签名 URL（前端图片访问通道——<img> 无 header，用 Public 签名端点）：
   *  返回同源相对 URL `/api/v1/parser-files/{token}`（前端部署同源直出）。
   *  token 载荷与 verify 一致：`{relativePath}|{expires}|{HMAC}`（base64url）。 */
  signUrl(relativePath: string, ttlSeconds = 3600): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${relativePath}|${expires}`;
    const sig = createHmac('sha256', this.config.getOrThrow<string>('encryptionKey'))
      .update(payload)
      .digest('hex');
    const token = Buffer.from(`${payload}|${sig}`).toString('base64url');
    return `/api/v1/parser-files/${token}`;
  }

  /** 校验 token → 返回相对路径；非法抛 400（不泄露原因） */
  verify(token: string): string {
    let decoded: string;
    try {
      decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('无效的文件令牌');
    }
    // token 载荷格式：`{相对路径}|{过期时间戳}|{HMAC}`（GrpcParser.buildFileUrl 生成，
    // 注意路径本身含 `/` 但分隔符用 `|`）——必须解构 3 段，否则 sig 取到过期时间戳导致校验失败
    const [relativePath, expiresStr, sig] = decoded.split('|');
    if (!relativePath || !expiresStr || !sig) {
      throw new BadRequestException('无效的文件令牌');
    }
    const payload = `${relativePath}|${expiresStr}`;
    const expected = createHmac('sha256', this.config.getOrThrow<string>('encryptionKey'))
      .update(payload)
      .digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('无效的文件令牌');
    }
    if (Number(expiresStr) < Math.floor(Date.now() / 1000)) {
      throw new BadRequestException('文件令牌已过期');
    }
    return relativePath;
  }
}

@Controller('parser-files')
export class ParserFileController {
  constructor(
    private readonly guard: ParserFileGuard,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  /** 解析服务内部拉取端点（签名令牌，非用户功能） */
  @Public()
  @Get(':token')
  async serve(
    @Param('token') token: string,
    // passthrough: true——本方法返回 StreamableFile 由 Nest 写入响应；
    // 若用 passthrough:false 返回值被忽略、响应永不结束（请求挂起，
    // 生产实测导致 parser 下载超时 SOURCE_DOWNLOAD_FAILED）
    @Res({ passthrough: true }) res: Response,
  ) {
    // 签名令牌校验（HMAC + 过期）→ 存储后端无关读取（本地/MinIO 统一 createReadStream）
    const relativePath = this.guard.verify(token);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return new StreamableFile(await this.storage.createReadStream(relativePath));
  }
}

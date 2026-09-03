// grpc-parser.ts
// 真实解析服务接入（ohmydocagent/parser:fixed，MinerU 引擎）：
// 实现 ParserClient 接口，通过 gRPC 调用解析服务（契约见 proto/parser.proto）。
//
// 接入方式（Task 5.x 落地）：
//   1. 后端把上传文件以「签名临时 URL」暴露给解析服务（ParserFileController，
//      HMAC 令牌 + 10 分钟过期——解析服务按 source_url 拉取文件）
//   2. GrpcParser 调 Parser.Parse(ParseRequest) → 事件流（Progress/Block/
//      Asset/Completed/Error）→ Block 文本按 page/order 重组为 ParsedDocument
//   3. 配置切换：PARSER_URL 设置后 ParserModule 用本实现替换占位解析器
//
// 简化取舍（轻量模式）：
//   - Asset（图片块）暂不落盘（ParsedDocument 契约无图片字段，后续多模态再扩）
//   - 失败语义：事件流 Error → 抛错（ParseProcessor 现有失败重试语义承接）
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadSync } from '@grpc/proto-loader';
import {
  ChannelCredentials,
  loadPackageDefinition,
  type Client,
  type ClientReadableStream,
} from '@grpc/grpc-js';
import { createHmac } from 'node:crypto';
import type { ParseInput, ParsedDocument, ParsedImage, ParserClient } from './parser-client.interface.js';

// proto 文件相对本文件（编译后 dist/parser/proto/parser.proto——nest build 默认不拷贝
// 非 ts 文件，见 nest-cli.json assets 配置：本文件经 assets 拷贝到 dist）。
// fileURLToPath：Windows 下 URL.pathname 产生 '/F:/...' 盘符带斜杠路径（grpc
// load 报 ENOENT），平台化转换保证跨平台（生产 linux 无影响）。
import { fileURLToPath } from 'node:url';
const PROTO_PATH = fileURLToPath(new URL('./proto/parser.proto', import.meta.url));

/** 签名文件 URL 的有效期（秒）——解析服务按 URL 拉取，过期防泄露 */
const FILE_URL_TTL_SECONDS = 600;

/** gRPC 调用超时（毫秒）——MinerU CPU 解析大文档较慢 */
const GRPC_TIMEOUT_MS = 600_000; // VLM 多图并发描述可能较慢（600s）

interface ParseEvent {
  progress?: { stage: string; percent: number; message: string };
  block?: { type: string; text: string; page: number; order: number };
  asset?: {
    asset_key: string;
    mime_type: string;
    page: number;
    content?: Buffer | Uint8Array;
    description?: string;
  };
  completed?: { page_count: number; block_count: number };
  error?: { code: string; message: string };
}

@Injectable()
export class GrpcParser implements ParserClient {
  private readonly logger = new Logger(GrpcParser.name);
  private readonly client: Client;
  private readonly fileBaseUrl: string;
  private readonly signSecret: string;
  /** 默认引擎（PARSER_ENGINE 配置；仅支持 mineru） */
  private readonly engine: 'mineru';

  private readonly config: ConfigService;
  constructor(config: ConfigService) {
    this.config = config;
    // gRPC 目标（如 127.0.0.1:50051 或 compose 内 parser:50051）
    const target = config.getOrThrow<string>('parserUrl');
    // 后端自身地址（解析服务能访问到：dev 用 127.0.0.1:3000；compose 内用
    // http://backend:3000——见 deploy .env 注释）
    this.fileBaseUrl = (config.get<string>('parserFileBaseUrl') ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 签名密钥：复用 ENCRYPTION_KEY 派生（同 CryptoService 约定，避免新密钥面）
    this.signSecret = config.getOrThrow<string>('encryptionKey');
    const engine = config.get<string>('parserEngine');
    this.engine = 'mineru';
    this.logger.log(`真实解析服务已接入：${this.engine} @ ${target}（文件基址 ${this.fileBaseUrl}）`);

    const pkgDef = loadSync(PROTO_PATH, { keepCase: true, defaults: true });
    const proto = loadPackageDefinition(pkgDef) as any;
    this.client = new proto.ohmydocagent.parser.v1.Parser(target, ChannelCredentials.createInsecure());
  }

  /** 生成签名文件 URL：HMAC(path) + 过期时间，供解析服务拉取上传文件 */
  private buildFileUrl(relativePath: string): string {
    const expires = Math.floor(Date.now() / 1000) + FILE_URL_TTL_SECONDS;
    const payload = `${relativePath}|${expires}`;
    const sig = createHmac('sha256', this.signSecret).update(payload).digest('hex');
    const token = Buffer.from(`${payload}|${sig}`).toString('base64url');
    return `${this.fileBaseUrl}/api/v1/parser-files/${token}`;
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    // manual 类型：纯文本无需真实解析服务（占位语义直接返回）
    if (input.manualContent !== undefined) {
      return { text: input.manualContent };
    }

    let sourceUrl: string;
    let mimeType: string;
    if (input.url) {
      // URL 类型：直接交给解析服务拉取（解析服务端有 SSRF 防护，见其 router.py）
      sourceUrl = input.url;
      mimeType = mimeFromFileType(input.fileType);
    } else if (input.filePath) {
      // file 类型：签名临时 URL 暴露上传文件
      sourceUrl = this.buildFileUrl(input.filePath);
      mimeType = mimeFromFileType(input.fileType);
    } else {
      throw new Error('GrpcParser：无效输入（缺少 filePath/url/manualContent）');
    }

    // 引擎选择：ParseInput.engine 覆盖（未来 KB 级配置）→ PARSER_ENGINE 全局
    const engine = input.engine ?? this.engine;
    const events = await this.streamParse({
      job_id: `ohmydocagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source_url: sourceUrl,
      mime_type: mimeType,
      engine,
      // 图片/VLM 配置（图表 Caption 生成，对齐 WeKnora ImageMultimodal）：
      // parser 对图片调 VLM 生成 description（asset 事件）；未配 VLM 则 parser
      // 跳过图片处理（asset 事件数为 0）
      vlm_endpoint: this.config.get<string>('parserVlmEndpoint') ?? '',
      vlm_model: this.config.get<string>('parserVlmModel') ?? '',
      vlm_api_key: this.config.get<string>('parserVlmApiKey') ?? '',
    });

    // Block 文本重组：按 page/order 排序拼接
    const blocks = events
      .filter((e) => e.block)
      .map((e) => e.block!)
      .sort((a, b) => (a.page - b.page) || (a.order - b.order));
    const pages = new Map<number, string[]>();
    for (const b of blocks) {
      const arr = pages.get(b.page) ?? [];
      if (b.text) arr.push(b.text);
      pages.set(b.page, arr);
    }
    // 图片资产收集（Asset 事件：content + VLM description）——对齐 WeKnora
    // ImageMultimodal：content 由 parse.processor 存对象存储并登记 knowledge，
    // description 注入所在页文本尾部（等同 WeKnora image_caption 子块语义：
    // 图表描述可随正文分块检索——之前图表内容 OCR 进文本但无描述可召回的补强）
    const images: ParsedImage[] = [];
    const descByPage = new Map<number, string[]>();
    for (const ev of events) {
      if (!ev.asset) continue;
      const a = ev.asset;
      const content = a.content ? Buffer.from(a.content as Uint8Array) : Buffer.alloc(0);
      if (content.length === 0) continue; // 无字节的 asset 无存储价值（描述已单独注入）
      images.push({
        assetKey: a.asset_key,
        page: a.page,
        mimeType: a.mime_type,
        description: a.description?.trim() || undefined,
        content,
      });
      if (a.description && a.description.trim()) {
        const arr = descByPage.get(a.page) ?? [];
        arr.push(a.description.trim());
        descByPage.set(a.page, arr);
      }
    }
    // description 注入所在页文本尾部（独立段落；页面图表语义随上下文可检索）
    for (const [page, descs] of descByPage) {
      const arr = pages.get(page);
      if (arr) arr.push(...descs);
    }
    const text = [...pages.entries()]
      .sort(([a], [c]) => a - c)
      .map(([, lines]) => lines.join('\n'))
      .join('\n\n');
    return {
      text,
      pages: [...pages.entries()].map(([page, t]) => ({ page, text: t.join('\n') })),
      images: images.length > 0 ? images : undefined,
    };
  }

  /** gRPC 流式调用：收集事件直到 Completed/Error */
  private streamParse(req: Record<string, unknown>): Promise<ParseEvent[]> {
    return new Promise((resolve, reject) => {
      const events: ParseEvent[] = [];

      const call = (this.client as any).Parse(req) as ClientReadableStream<ParseEvent>;
      const timer = setTimeout(() => {
        call.cancel();
        reject(new Error(`解析服务超时（${GRPC_TIMEOUT_MS}ms）`));
      }, GRPC_TIMEOUT_MS);
      call.on('data', (ev: ParseEvent) => {
        if (ev.error) {
          clearTimeout(timer);
          reject(new Error(`解析失败：${ev.error.code} ${ev.error.message}`));
          return;
        }
        events.push(ev);
      });
      call.on('end', () => {
        clearTimeout(timer);
        resolve(events);
      });
      call.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`解析服务连接失败：${err.message}`));
      });
    });
  }
}

/** 文件扩展名 → MIME（解析服务按 MIME 路由；白名单与 KnowledgeService 一致） */
function mimeFromFileType(fileType: string): string {
  switch (fileType.toLowerCase()) {
    case 'pdf': return 'application/pdf';
    case 'doc': case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'md': case 'markdown': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

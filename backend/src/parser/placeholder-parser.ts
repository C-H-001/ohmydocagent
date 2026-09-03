// 占位解析器（Task 1.4）：P1 内置文本抽取，实现 ParserClient 契约。
// 分发：pdf → pdf-parse（v2 重写版，PDFParse 类）；docx → mammoth.extractRawText；
// md/txt → 直读文件；图片 → 空文本（占位，后续接 OCR/VLM）；url → fetch 拉取
// （返回原文，注释见 parseUrl）；manual → 直接返回正文。
// 后期替换为真实解析服务（ohmydocagent/parser）时，新实现同样实现 ParserClient，
// 在 ParserModule 中替换 provider 即可，processor 无需改动。
//
// 安全登记（P5 部署安全清单）：URL 拉取的 SSRF 加固（阻断私网 IP/内网地址——
// fetch 前解析 host 拒绝 RFC1918/保留地址段，并限制重定向目标）P1 不实现；
// 本地开发 URL 导入多为公网地址，生产部署前必须补上。
import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { StorageService } from '../modules/storage/storage.service.js';
import {
  ParseInput,
  ParsedDocument,
  ParserClient,
} from './parser-client.interface.js';

/** URL 拉取超时（毫秒） */
const URL_FETCH_TIMEOUT_MS = 10_000;
/** URL 内容大小上限（字节，5MB）——导出供测试边界用例复用 */
export const URL_MAX_BYTES = 5 * 1024 * 1024;

@Injectable()
export class PlaceholderParser implements ParserClient {
  private readonly logger = new Logger(PlaceholderParser.name);

  constructor(private readonly storage: StorageService) {}

  async parse(input: ParseInput): Promise<ParsedDocument> {
    // manual：正文直接作为解析结果（Task 1.5 分块消费）
    if (input.manualContent !== undefined && input.manualContent !== null) {
      return { text: input.manualContent };
    }
    // url：fetch 拉取（占位实现返回原文，真实服务负责结构化抽取）
    if (input.url) {
      return this.parseUrl(input.url);
    }
    if (!input.filePath) {
      throw new Error('缺少解析来源：filePath/url/manualContent 至少一个');
    }
    switch (input.fileType) {
      case 'pdf':
        return this.parsePdf(input.filePath);
      case 'docx':
        return this.parseDocx(input.filePath);
      case 'md':
      case 'markdown':
      case 'txt':
        return this.parseTextFile(input.filePath);
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'webp':
        // 图片解析 P1 占位：返回空文本（后续接 OCR/VLM 服务；真实解析服务可提取）
        this.logger.warn(
          `图片解析暂未实现（占位返回空文本）: ${input.filePath}`,
        );
        return { text: '' };
      case 'doc':
        // 旧版二进制 Word 格式：mammoth 不支持，P1 明确报错提示转换
        throw new Error('暂不支持解析 .doc 格式，请转换为 .docx 后重新上传');
      default:
        throw new Error(`不支持的解析类型: ${input.fileType}`);
    }
  }

  /** pdf：pdf-parse 抽取文本（PDFParse 类，getText 返回全文 + 分页） */
  private async parsePdf(filePath: string): Promise<ParsedDocument> {
    // 存储后端无关读取（本地/MinIO 统一走 readBuffer）
    const data = await this.storage.readBuffer(filePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return { text: result.text };
    } finally {
      // 释放 pdfjs worker 等资源，避免长驻进程句柄泄漏
      await parser.destroy().catch(() => undefined);
    }
  }

  /** docx：mammoth.extractRawText 抽取纯文本 */
  private async parseDocx(filePath: string): Promise<ParsedDocument> {
    const buffer = await this.storage.readBuffer(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }

  /** md/txt：直接读文件内容作为解析结果（纯文本无需解析） */
  private async parseTextFile(filePath: string): Promise<ParsedDocument> {
    const text = (await this.storage.readBuffer(filePath)).toString('utf8');
    return { text };
  }

  /**
   * url：fetch 拉取（http/https，10s 超时，5MB 上限）。
   * 返回原文（不剥 HTML 标签）——占位语义：保证「URL 文档有文本可分块」，
   * 结构化抽取（标题/正文去噪）留给真实解析服务。
   * 流式限流（Task 1.4 质量整改）：旧实现 res.arrayBuffer() 先把响应全量收进
   * 内存再 subarray 截断——超限内容（如 100MB）峰值内存超限；改为逐 chunk 累积，
   * 累计超限立即 controller.abort() 中断下载并抛错（不浪费带宽/内存）。
   * SSRF 加固列入 P5 部署安全清单（见文件头注释）。
   */
  private async parseUrl(url: string): Promise<ParsedDocument> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('URL 格式不合法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议的 URL: ${parsed.protocol}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(`拉取 URL 失败: HTTP ${res.status}`);
      }
      // 流式读取：每收一个 chunk 检查累计长度，超限即 abort 中断并抛错
      // （content-length 预检不可靠——头可能缺失/虚报，故以实际字节数为准）
      let received = 0;
      const chunks: Buffer[] = [];
      if (res.body) {
        for await (const chunk of res.body) {
          const buf = Buffer.from(chunk);
          received += buf.length;
          if (received > URL_MAX_BYTES) {
            controller.abort(); // 中断下载，停止后续传输
            throw new Error(`响应超过 5MB 上限: ${url}`);
          }
          chunks.push(buf);
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      return { text };
    } catch (err) {
      if (controller.signal.aborted) {
        // 超限错误抛出前已 abort：需优先透传原始错误（避免被误判为超时）
        if (err instanceof Error && err.message.startsWith('响应超过 5MB')) {
          throw err;
        }
        throw new Error(`拉取 URL 超时（${URL_FETCH_TIMEOUT_MS}ms）: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

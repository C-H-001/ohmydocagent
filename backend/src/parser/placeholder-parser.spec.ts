// PlaceholderParser 单元测试（Task 1.4）：用真实 fixture（backend/test/fixtures/）验证
// 各文件类型文本抽取；URL 拉取用 mock fetch 覆盖（SSRF 加固登记 P5 部署安全清单，
// 见 placeholder-parser.ts 注释）；图片占位返回空文本（后续接 OCR/VLM）。
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageService } from '../modules/storage/storage.service.js';
import { PlaceholderParser, URL_MAX_BYTES } from './placeholder-parser.js';

/** 测试用的上传根目录 = fixtures 目录（PlaceholderParser 经 StorageService 解析相对路径） */
const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures',
);

describe('PlaceholderParser', () => {
  let parser: PlaceholderParser;
  // ConfigService mock：只提供 uploadDir（StorageService 构造时读取）
  const configMock = {
    get: vi.fn((key: string) =>
      key === 'uploadDir' ? fixturesDir : undefined,
    ),
  };

  beforeEach(() => {
    parser = new PlaceholderParser(
      new StorageService(configMock as unknown as ConfigService),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pdf：pdf-parse 抽取文本（真实最小 PDF fixture）', async () => {
    const result = await parser.parse({
      filePath: 'sample.pdf',
      fileType: 'pdf',
    });
    expect(result.text).toContain('OhMyDocAgent parser test PDF content');
  });

  it('pdf：损坏的 PDF 抛错（Invalid PDF structure）', async () => {
    await expect(
      parser.parse({ filePath: 'corrupt.pdf', fileType: 'pdf' }),
    ).rejects.toThrow(/Invalid PDF/i);
  });

  it('docx：mammoth 抽取纯文本（真实最小 docx fixture）', async () => {
    const result = await parser.parse({
      filePath: 'sample.docx',
      fileType: 'docx',
    });
    expect(result.text).toContain('OhMyDocAgent docx parser test');
    expect(result.text).toContain('second paragraph');
  });

  it('md/txt：直接返回文件内容', async () => {
    const md = await parser.parse({ filePath: 'sample.md', fileType: 'md' });
    expect(md.text).toContain('markdown 内容');
    const txt = await parser.parse({ filePath: 'sample.txt', fileType: 'txt' });
    expect(txt.text).toContain('plain text notes');
  });

  it('图片：占位返回空文本（后续接 OCR/VLM，注释说明）', async () => {
    // 图片分支不读文件（返回空文本占位），文件无需真实存在
    const result = await parser.parse({
      filePath: 'sample.png',
      fileType: 'png',
    });
    expect(result.text).toBe('');
  });

  it('manual：直接返回 manualContent', async () => {
    const result = await parser.parse({
      fileType: 'manual',
      manualContent: '手动内容',
    });
    expect(result.text).toBe('手动内容');
  });

  it('url：mock fetch 拉取 HTML 返回原文（不剥标签——占位语义，注释说明）', async () => {
    const html = '<html><body><p>OhMyDocAgent html content</p></body></html>';
    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await parser.parse({
      fileType: 'url',
      url: 'https://example.com/doc',
    });
    expect(result.text).toBe(html);
    // 验证请求携带了 10s 超时信号（AbortSignal.timeout 语义）
    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { signal?: AbortSignal },
    ];
    expect(requestUrl).toBe('https://example.com/doc');
    expect(init.signal).toBeDefined();
  });

  it('url：非 http/https 协议拒绝', async () => {
    await expect(
      parser.parse({ fileType: 'url', url: 'ftp://example.com/a' }),
    ).rejects.toThrow(/http/);
  });

  it('url：HTTP 错误状态抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    await expect(
      parser.parse({ fileType: 'url', url: 'https://example.com/missing' }),
    ).rejects.toThrow(/404/);
  });

  it('url：流式读取超 5MB 上限 → 中断并抛错（质量整改：不整包缓冲）', async () => {
    // mock 流式响应：分 3 块 2MB 发送（累计 6MB > 5MB 上限）——模拟超大响应
    // 在读到第 3 块时触发超限中断。旧实现 arrayBuffer() 会把全量收进内存再
    // 截断，流式实现应在超限点 abort 停止传输。
    const chunk = new Uint8Array(2 * 1024 * 1024).fill(97); // 'a' × 2MB
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(chunk);
        ctrl.enqueue(chunk);
        ctrl.enqueue(chunk);
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      parser.parse({ fileType: 'url', url: 'https://example.com/huge' }),
    ).rejects.toThrow(/5MB/);
    // 仍走单次请求（超限在读取阶段发现，不重发）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('url：恰好 5MB 内容可正常读取（边界：超限判定为严格大于）', async () => {
    // 精确 5MB：分段流式读取不应误伤
    const fiveMb = new Uint8Array(URL_MAX_BYTES);
    // 用 5 × 1MB 分块发送（验证跨 chunk 累计长度判定）
    const mb = 1024 * 1024;
    const stream = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < 5; i++)
          ctrl.enqueue(fiveMb.subarray(i * mb, (i + 1) * mb));
        ctrl.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const result = await parser.parse({
      fileType: 'url',
      url: 'https://example.com/exact',
    });
    expect(result.text.length).toBe(URL_MAX_BYTES);
  });

  it('doc：占位不支持（明确报错提示转换为 docx）', async () => {
    await expect(
      parser.parse({ filePath: 'x.doc', fileType: 'doc' }),
    ).rejects.toThrow(/docx/);
  });
});

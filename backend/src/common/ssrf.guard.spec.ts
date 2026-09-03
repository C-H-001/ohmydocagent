// backend/src/common/ssrf.guard.spec.ts
// assertSafeBaseUrl SSRF 防护单元测试（Task 2.3 质量审查整改）。
// 断言维度：
// - http/https 放行（公网域名/公网 IP）
// - ftp 等非 http(s) 协议 → 拒绝
// - 公网域名放行（mock dns.lookup 返回公网 IP）
// - 域名解析到私网（10.x / 169.254.x）→ 拒绝
// - 私网 IP 字面量 → 拒绝（云元数据端点 169.254.169.254 典型攻击面）
// - localhost / 127.0.0.1 / ::1 回环 → 放行（Ollama 本地部署核心场景）
// - 域名解析失败 → 拒绝（fail-safe：无法验证目标安全）
//
// DNS mock：node:dns/promises 的 lookup 用 vi.mock 整体替换，返回地址通过
// dnsMock.addresses 可变（vi.hoisted 共享状态）——不同用例注入不同解析结果。
import { describe, expect, it, vi } from 'vitest';

/** DNS 解析结果的可变持有者：用例间共享，设置不同地址模拟不同解析 */
const dnsMock = vi.hoisted(() => ({
  addresses: ['93.184.216.34'], // 默认公网 IP（example.com）
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () =>
    dnsMock.addresses.map((address) => ({ address, family: 4 })),
  ),
}));

import { assertSafeBaseUrl } from './ssrf.guard.js';

describe('assertSafeBaseUrl（SSRF 防护）', () => {
  it('http/https 公网 URL 放行（不抛异常）', async () => {
    await expect(
      assertSafeBaseUrl('https://api.deepseek.com'),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeBaseUrl('http://api.example.com:8080/v1'),
    ).resolves.toBeUndefined();
  });

  it('ftp 等非 http/https 协议 → 拒绝（BadRequestException）', async () => {
    await expect(assertSafeBaseUrl('ftp://files.example.com')).rejects.toThrow(
      /仅支持 http\/https/,
    );
    await expect(assertSafeBaseUrl('file:///etc/passwd')).rejects.toThrow(
      /仅支持 http\/https/,
    );
  });

  it('非合法 URL → 拒绝（BadRequestException）', async () => {
    await expect(assertSafeBaseUrl('not-a-url')).rejects.toThrow(
      /不是合法的 URL/,
    );
    await expect(assertSafeBaseUrl('')).rejects.toThrow(/不是合法的 URL/);
  });

  it('公网域名放行（mock lookup 返回公网 IP）', async () => {
    dnsMock.addresses = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
    await expect(
      assertSafeBaseUrl('https://example.com'),
    ).resolves.toBeUndefined();
  });

  it('域名解析到私网 10.x → 拒绝（mock lookup 返回 10.0.0.5）', async () => {
    dnsMock.addresses = ['10.0.0.5'];
    await expect(
      assertSafeBaseUrl('https://internal.example.com'),
    ).rejects.toThrow(/解析到私网\/保留地址.*10\.0\.0\.5/);
  });

  it('域名解析到云元数据 169.254.x → 拒绝（mock lookup 返回 169.254.169.254）', async () => {
    dnsMock.addresses = ['169.254.169.254'];
    await expect(
      assertSafeBaseUrl('https://metadata.internal'),
    ).rejects.toThrow(/解析到私网\/保留地址.*169\.254\.169\.254/);
  });

  it('域名解析到链路本地 IPv6 fe80:: → 拒绝', async () => {
    dnsMock.addresses = ['fe80::1'];
    await expect(
      assertSafeBaseUrl('https://ipv6-linklocal.internal'),
    ).rejects.toThrow(/解析到私网\/保留地址/);
  });

  it('私网 IP 字面量 → 拒绝（10/8、172.16/12、192.168/16、169.254/16）', async () => {
    for (const url of [
      'http://10.0.0.1:80',
      'http://172.16.0.1:80',
      'http://172.31.255.254:80',
      'http://192.168.1.1:80',
      // 阿里云 ECS 元数据端点：SSRF 典型攻击面（窃取 IAM 凭证）
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    ]) {
      await expect(assertSafeBaseUrl(url)).rejects.toThrow(/私网\/保留地址/);
    }
  });

  it('公网 IP 字面量放行', async () => {
    await expect(
      assertSafeBaseUrl('http://93.184.216.34:11434'),
    ).resolves.toBeUndefined();
  });

  it('localhost / 127.0.0.1 / ::1 回环放行（Ollama 本地部署核心场景）', async () => {
    await expect(
      assertSafeBaseUrl('http://127.0.0.1:11434'),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeBaseUrl('http://localhost:11434'),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeBaseUrl('http://[::1]:11434'),
    ).resolves.toBeUndefined();
    // 127/8 整段都是回环（127.0.0.2 同属回环网段）
    await expect(
      assertSafeBaseUrl('http://127.0.0.2:11434'),
    ).resolves.toBeUndefined();
  });

  it('域名解析失败（ENOTFOUND）→ 拒绝（fail-safe：无法验证目标安全）', async () => {
    // lookup 抛错：模拟 DNS 不可用/域名不存在
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockRejectedValueOnce(
      Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    await expect(
      assertSafeBaseUrl('https://no-such-host.invalid'),
    ).rejects.toThrow(/域名解析失败/);
  });
});

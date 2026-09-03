// backend/src/common/ssrf.guard.ts
// 模型供应商出站请求 SSRF 防护（Task 2.3 质量审查整改）：
// assertSafeBaseUrl(url) 在 provider 发起 fetch 前校验目标地址——拒绝
// 「指向内网/云元数据端点」的 baseUrl（如 http://169.254.169.254/ 窃取阿里云
// ECS IAM 凭证）。baseUrl 用户可控（任何登录用户可新增模型 / POST /models/test
// 直传完整配置），不能信任 DTO 层校验就放行——调用层必须兜底。
//
// 校验规则：
// 1. 协议：仅 http/https（拒绝 ftp 等非预期协议）；
// 2. 回环地址（127.0.0.1/localhost/::1）**放行**——Ollama 本地部署
//    （http://127.0.0.1:11434）是核心预期场景，SSRF 防护不能一刀切禁回环；
// 3. IP 字面量：直接按网段判断（10/8、172.16/12、192.168/16、127/8、
//    169.254/16、fc00::/7 等私网/保留段 → 拒绝）；
// 4. 域名：dns.lookup 解析出全部地址后逐段检查——任一落在私网/保留段即拒绝。
//
// 已知局限（注释登记，勿当可消除而忽略）：
// - DNS rebinding（TOCTOU）：单次 lookup 与后续 fetch 之间域名可被重新解析到
//   内网（lookup 放行公网 → fetch 时已指向 169.254.169.254）。单进程内无法
//   完全消除——生产环境建议 provider 请求经代理/网关或专用出网环境（如
//   egress proxy 只允许公网目标），P1 本地开发可接受本防护（见任务书决策）。
// - IPv6 复杂地址（内嵌 IPv4 的杂糅写法）依赖 URL 标准库归一化，理论上有
//   绕过空间——同上，生产走代理兜底。
//
// 错误形态：BadRequestException（400）——配置错误而非供应商故障，前端可读；
// provider 的 testConnection 会把该异常捕获为 { ok: false, error } 返回。
import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** IPv4 私网/保留网段判断（含 0/8、CGNAT、TEST-NET 等；注释见文件头） */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  // 解析异常（非 4 段/越界）→ 视为不安全（宁可误伤不放行）
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 本网络
  if (a === 10) return true; // 10/8 私网
  if (a === 127) return true; // 127/8 回环（isLoopbackHostname 已单独放行，此处兜底）
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF 协议保留
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 组播 + 240/4 保留 + 255 广播
  return false;
}

/** IPv6 私网/保留网段判断（ULA/链路本地/组播/文档段 + IPv4 映射地址） */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4 映射地址（::ffff:a.b.c.d）：提取尾段 IPv4 按 IPv4 规则判断
  // （DNS 解析一般返回纯 IPv4/纯 IPv6，此处兜底防御杂糅写法）
  const v4Mapped = lower.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  if (lower === '::') return true; // 未指定地址
  if (lower === '::1') return true; // 回环（isLoopbackHostname 已单独放行，此处兜底）
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  )
    return true; // fe80::/10 链路本地
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA 唯一本地地址
  if (lower.startsWith('ff')) return true; // 组播
  if (lower.startsWith('2001:db8')) return true; // 2001:db8::/32 文档示例段
  if (lower.startsWith('64:ff9b:')) return true; // 64:ff9b::/96 NAT64 前缀（可映射私网）
  return false;
}

/** 回环判断：localhost（RFC 6761）与 127/8、::1——Ollama 本地部署放行（见文件头） */
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (isIP(lower) === 4) {
    return lower.split('.')[0] === '127';
  }
  if (isIP(lower) === 6) {
    return lower === '::1' || lower.startsWith('::ffff:127.');
  }
  return false;
}

/** 任一地址落在私网/保留网段 → true（DNS 解析结果逐段判断用） */
function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

/**
 * 校验出站目标 URL 的安全性（provider 每次 fetch 前调用，见各 provider 注释）：
 * 协议限定 http/https；回环放行；非回环 IP 字面量/域名解析结果落在私网或
 * 保留网段 → 400 拒绝。DNS rebinding 局限见文件头注释。
 */
export async function assertSafeBaseUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('baseUrl 不是合法的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(
      `baseUrl 仅支持 http/https 协议（收到 ${parsed.protocol.replace(':', '')}）`,
    );
  }
  // IPv6 字面量 hostname 带方括号（new URL('http://[::1]:11434').hostname === '[::1]'）
  let hostname = parsed.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  // 回环放行：Ollama 本地部署（http://127.0.0.1:11434）是核心预期场景
  if (isLoopbackHostname(hostname)) return;

  // IP 字面量：直接按网段判断（无需 DNS）
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 || ipVersion === 6) {
    if (isPrivateAddress(hostname)) {
      throw new BadRequestException(
        `baseUrl 指向私网/保留地址（${hostname}），已拦截（SSRF 防护）`,
      );
    }
    return;
  }

  // 域名：解析全部地址后逐段判断——任一私网即拒绝
  let addresses: string[];
  try {
    const result = await lookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    // DNS 解析失败：无法验证目标安全 → 拒绝（fail-safe；请求反正无法成功）
    throw new BadRequestException(
      `baseUrl 域名解析失败（${hostname}），已拦截（SSRF 防护）`,
    );
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new BadRequestException(
        `baseUrl 域名 ${hostname} 解析到私网/保留地址（${addr}），已拦截（SSRF 防护）`,
      );
    }
  }
}

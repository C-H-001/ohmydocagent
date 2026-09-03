// backend/src/modules/chat/sse/sse.service.ts
// SSE 写入器（Task 2.4）：封装 Express res 的 event/data 行格式
// （'event: <type>\ndata: <JSON>\n\n'，SSE 规范），聊天事件协议见
// chat-event.types.ts。
// - 每请求实例化（绑定 res）——res 是请求级对象，本类是无共享状态的纯写入
//   助手，不做 DI provider（控制器 new 即可，见 session.controller.ts）。
// - headers 设计（SSE 必需 + 反代适配）：
//   Content-Type text/event-stream（媒体类型必需）；Cache-Control no-cache
//   （防代理/浏览器缓存流式响应）；Connection keep-alive；X-Accel-Buffering no
//   （nginx 反代 SSE 必需——nginx 默认 buffering 攒满缓冲才转发，破坏实时性）。
// - 时序决策：writeHead 只暂存 headers，flushHeaders 立即发送响应头——
//   控制器先做会话归属校验（404/403 JSON）再创建本实例，保证错误响应先于
//   SSE 流（见 session.controller.ts 注释）。
// - flush：Node http 的 write 走内核缓冲，flushHeaders 首次发送头；后续每次
//   write 后调用 res.flush?.()。当前应用未注册 compression 中间件（见
//   app.setup.ts）——Express 原生 res 无 flush 方法，?. 短路使本调用实际为
//   no-op；保留调用点以兼容未来接入 compression（届时自动启用压缩缓冲刷新）。
// - 心跳（Task 2.4 质量审查整改 #2）：构造时启动 setInterval，每 15s 写一行
//   SSE 注释（': heartbeat\n\n'，客户端忽略的保活行）——长空闲（无 delta 时）
//   会被代理/网关按空闲超时断开，心跳维持连接；end() 时 clearInterval 停止。
//   间隔常量 HEARTBEAT_INTERVAL_MS 供测试注入短间隔/单测 fake timers 验证。
// - 断连处理（Task 2.4 质量审查整改 #1）：res 'close' 事件在「正常完成」与
//   「客户端提前断开」都会触发——用 res.writableEnded 区分（正常完成时 end()
//   已调用、writableEnded=true；断连时响应未结束、writableEnded=false）。
//   断连 → 置 disconnected 标志 + 通知 onDisconnect 注册的监听器（编排器借此
//   abort 生成，烧 token 止损）；send/end 在断连后跳过写入——对已销毁 socket
//   写数据会触发未处理的 'error' 事件（进程崩溃风险）。res.destroyed 兜底
//   close 事件早于监听器注册的竞态（close 错过 → 仍能在 send 时识别连接已死）。
import type { Response } from 'express';
import type { ChatEvent } from './chat-event.types.js';

/** 心跳间隔（毫秒）：SSE 长空闲会被代理/网关按空闲超时断开（常见 30-60s），
 * 取 15s 为保守下限——注释行体积可忽略（': heartbeat\n\n' 每 15s 一次）。
 * 测试可注入更短间隔（构造参数），或单测用 fake timers 推进验证（见
 * sse.service.spec.ts）。 */
export const HEARTBEAT_INTERVAL_MS = 15000;

/** Express res + 中间件增强（compression 提供 flush，Express 原生类型无此
 * 方法——显式声明可选，运行时用 ?. 调用，不可用则跳过，见文件头 flush 注释） */
type SseResponse = Response & { flush?: () => void };

export class SseService {
  /** 断连已发生（res close 且 writableEnded=false）：send/end 跳过写入 */
  private disconnected = false;
  /** 已 end（正常收尾）：后续 send 跳过（防 end 后误写） */
  private ended = false;
  /** 心跳定时器（end() 时 clearInterval，防止泄漏/持续写已关连接） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 断连监听器（编排器注册：abort 生成控制器） */
  private readonly disconnectListeners: Array<() => void> = [];

  constructor(
    private readonly res: SseResponse,
    heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {
    // writeHead 只暂存 headers（首个 write/flushHeaders 才真正发送）；创建
    // 本实例时归属校验已通过（见控制器注释），立即 flushHeaders 让客户端
    // 尽早拿到 200 + content-type 开始解析流
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();
    // 断连监听（见文件头注释：close 在正常完成与断连都触发，writableEnded 区分）
    this.res.on('close', () => this.handleClose());
    // 心跳：长空闲保活（见文件头注释；end() 时清除）
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      heartbeatIntervalMs,
    );
  }

  /** close 事件处理：区分正常完成（end 已调用，writableEnded=true，忽略）与
   * 客户端断连（响应未结束，writableEnded=false）→ 置标志 + 通知监听器 */
  private handleClose(): void {
    if (this.res.writableEnded || this.ended) return; // 正常结束，非断连
    this.disconnected = true;
    for (const cb of this.disconnectListeners) cb();
  }

  /** 注册断连回调（编排器传 controller.abort）。已断连（close 事件早于注册的
   * 竞态）→ 立即调用一次——调用方（编排器）据此在生成开始前 abort 信号 */
  onDisconnect(cb: () => void): void {
    if (this.disconnected) {
      cb();
      return;
    }
    this.disconnectListeners.push(cb);
  }

  /** 是否已断连（编排器判断是否继续转发/落库；发送本身由 send 的守卫兜底） */
  isDisconnected(): boolean {
    return this.disconnected;
  }

  /** 发送一个聊天事件：event: <type> 行 + data: <JSON> 行 + 空行（事件分隔） */
  send(event: ChatEvent): void {
    // 断连/已结束后跳过写入：对已销毁 socket 写会触发未处理 error（见文件头
    // 断连注释）；res.destroyed 兜底 close 事件竞态（见 handleClose 注释）
    if (this.disconnected || this.ended || this.res.destroyed) return;
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    // 刷新内核/压缩缓冲（当前 Express 无 compression——res.flush 不存在，
    // ?. 短路为 no-op；保留调用点兼容未来接入，见文件头 flush 注释）
    this.res.flush?.();
  }

  /** 心跳注释行（': heartbeat\n\n'）：SSE 注释行被客户端忽略，用于保持连接
   * 活跃（防代理/网关空闲超时断开，见文件头注释） */
  heartbeat(): void {
    if (this.disconnected || this.ended || this.res.destroyed) return;
    this.res.write(': heartbeat\n\n');
    this.res.flush?.();
  }

  /** 结束流（正常完成或出错后调用）：清除心跳定时器 + res.end()。Node http
   * end 幂等，但本类用 ended 标志去重（也防 end 后 close 被误判为断连） */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // 断连后 res 已随连接销毁：end 无害但跳过更干净（避免在死连接上操作）
    if (!this.disconnected && !this.res.destroyed) {
      this.res.end();
    }
  }
}

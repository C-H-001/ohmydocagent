// SseService 单元测试（Task 2.4）：mock Express res（writeHead/write/end/
// flushHeaders/flush/on/writableEnded/destroyed），断言——
// - 构造：writeHead(200, SSE 必需 headers：Content-Type text/event-stream /
//   Cache-Control no-cache / Connection keep-alive / X-Accel-Buffering no)
//   + flushHeaders 立即发送响应头（客户端尽早拿到 200 开始解析流）
// - send：写 `event: <type>\ndata: <JSON>\n\n`（SSE 规范：事件行 + 数据行 +
//   空行分隔）+ flush 刷新内核/压缩缓冲
// - heartbeat：写注释行 ': heartbeat\n\n'（代理保活）
// - 心跳调度（质量审查整改 #2）：构造启动 setInterval 每 15s 写心跳行；
//   end() 清除定时器（fake timers 推进验证）
// - 断连处理（质量审查整改 #1）：close 事件 + writableEnded=false → 触发
//   onDisconnect 回调 + 置 disconnected（send/end 跳过写入——对已销毁 socket
//   写会触发未处理 error）；正常结束（writableEnded=true）不触发断连回调
// - end：res.end() 结束流 + 清除心跳定时器
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseService } from './sse.service.js';

/** 组装 mock Express Response：记录 writeHead/write/end/flushHeaders/flush 调用，
 * on 捕获事件监听器（close 事件由 emitClose 手动触发模拟客户端断连/正常收尾） */
function mockRes() {
  const listeners: Record<string, () => void> = {};
  const writeHead = vi.fn();
  const write = vi.fn();
  const end = vi.fn();
  const flushHeaders = vi.fn();
  const flush = vi.fn();
  const on = vi.fn((event: string, cb: () => void) => {
    listeners[event] = cb;
  });
  const res = {
    writeHead,
    write,
    end,
    flushHeaders,
    flush,
    on,
    writableEnded: false,
    destroyed: false,
  };
  return {
    res: res as never,
    writeHead,
    write,
    end,
    flushHeaders,
    flush,
    listeners,
    /** 触发 close 事件（模拟连接关闭——正常完成或客户端断连） */
    emitClose() {
      listeners['close']?.();
    },
    /** 标记正常结束（模拟 res.end() 后 writableEnded=true） */
    markEnded() {
      res.writableEnded = true;
    },
    /** 标记连接销毁（模拟客户端断开后 socket 销毁） */
    markDestroyed() {
      res.destroyed = true;
    },
  };
}

describe('SseService（SSE 写入器）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('构造：writeHead 设置 SSE 必需 headers（Content-Type/Cache-Control/Connection/X-Accel-Buffering）并立即 flushHeaders', () => {
    const { res, writeHead, flushHeaders } = mockRes();
    const sse = new SseService(res);
    sse.end(); // 清除心跳定时器（防泄漏，见 end 语义测试）
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }),
    );
    expect(flushHeaders).toHaveBeenCalledTimes(1);
  });

  it('send：写 `event: <type>\\ndata: <JSON>\\n\\n` 行格式 + flush 刷新缓冲', () => {
    const { res, write, flush } = mockRes();
    const sse = new SseService(res);
    sse.send({ type: 'delta', text: '你好' });
    // SSE 规范：事件行（event: 类型）+ 数据行（data: JSON）+ 空行（\n\n 事件分隔）
    expect(write).toHaveBeenCalledWith(
      'event: delta\ndata: {"type":"delta","text":"你好"}\n\n',
    );
    expect(flush).toHaveBeenCalledTimes(1);
    sse.end();
  });

  it('send：stage/done/error 事件同样按 event+data 双行格式写出（data 含完整事件体）', () => {
    const { res, write } = mockRes();
    const sse = new SseService(res);
    sse.send({ type: 'stage', stage: 'generate', status: 'start' });
    sse.send({
      type: 'done',
      messageId: 'm-1',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    sse.send({ type: 'error', code: 'chat_model_error', message: '上游失败' });
    expect(write).toHaveBeenNthCalledWith(
      1,
      'event: stage\ndata: {"type":"stage","stage":"generate","status":"start"}\n\n',
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      'event: done\ndata: {"type":"done","messageId":"m-1","usage":{"inputTokens":1,"outputTokens":2}}\n\n',
    );
    expect(write).toHaveBeenNthCalledWith(
      3,
      'event: error\ndata: {"type":"error","code":"chat_model_error","message":"上游失败"}\n\n',
    );
    sse.end();
  });

  it('heartbeat：写 SSE 注释行（反向代理/网关保活）', () => {
    const { res, write } = mockRes();
    const sse = new SseService(res);
    sse.heartbeat();
    expect(write).toHaveBeenCalledWith(': heartbeat\n\n');
    sse.end();
  });

  it('心跳调度：构造启动 setInterval 每 15s 写心跳行；end 后清除（fake timers）', () => {
    vi.useFakeTimers();
    const { res, write } = mockRes();
    const sse = new SseService(res);
    // 构造只 flushHeaders，不写心跳（首次心跳在 15s 后）
    expect(write).not.toHaveBeenCalled();
    // 推进 15s：第一行心跳（长空闲保活——防代理/网关按空闲超时断开）
    vi.advanceTimersByTime(15000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(': heartbeat\n\n');
    // 再推进 15s：第二行
    vi.advanceTimersByTime(15000);
    expect(write).toHaveBeenCalledTimes(2);
    // end：清除定时器——再推进 30s 不再写
    sse.end();
    vi.advanceTimersByTime(30000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('心跳调度：短间隔注入可用（测试/配置按需）', () => {
    vi.useFakeTimers();
    const { res, write } = mockRes();
    const sse = new SseService(res, 100);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledWith(': heartbeat\n\n');
    sse.end();
  });

  it('断连：close 且响应未结束（writableEnded=false）→ 触发 onDisconnect 回调', () => {
    const { res, listeners, emitClose } = mockRes();
    const sse = new SseService(res);
    // 构造时已注册 close 监听（用于区分正常完成与断连，见 sse.service.ts 注释）
    expect(listeners['close']).toBeTypeOf('function');
    const onDisconnect = vi.fn();
    sse.onDisconnect(onDisconnect);
    expect(onDisconnect).not.toHaveBeenCalled();
    // 模拟客户端断开：close 触发且响应未结束（writableEnded=false）
    emitClose();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(sse.isDisconnected()).toBe(true);
  });

  it('断连后 send/end 跳过写入（对已销毁 socket 写会触发未处理 error）', () => {
    const { res, write, end, emitClose } = mockRes();
    const sse = new SseService(res);
    sse.send({ type: 'delta', text: '已发送的块' });
    emitClose(); // 客户端断开
    // 断连后的事件写入被守卫跳过（连接已关）
    sse.send({ type: 'delta', text: '不该发出的块' });
    sse.heartbeat();
    sse.end(); // end 同样跳过（res 已随连接销毁）
    expect(write).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
  });

  it('断连竞态：close 早于 onDisconnect 注册 → 注册时立即回调（编排器据此在生成开始前 abort）', () => {
    const { res, emitClose } = mockRes();
    const sse = new SseService(res);
    emitClose(); // 客户端在编排器注册前就断开了
    const onDisconnect = vi.fn();
    sse.onDisconnect(onDisconnect);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('断连兜底：close 事件错过但 socket 已销毁 → send 跳过写入（res.destroyed 检查）', () => {
    const { res, write, markDestroyed } = mockRes();
    const sse = new SseService(res);
    // 模拟 close 事件在监听器注册前已发生（构造前的极端竞态）——未置
    // disconnected 标志，但 res.destroyed 兜底识别连接已死
    markDestroyed();
    sse.send({ type: 'delta', text: '写不进去的块' });
    expect(write).not.toHaveBeenCalled();
  });

  it('正常结束：close 且响应已结束（writableEnded=true）→ 不触发断连回调', () => {
    const { res, emitClose, markEnded } = mockRes();
    const sse = new SseService(res);
    const onDisconnect = vi.fn();
    sse.onDisconnect(onDisconnect);
    // 正常收尾：end() 后连接关闭，close 事件触发——writableEnded=true，非断连
    sse.end();
    markEnded();
    emitClose();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(sse.isDisconnected()).toBe(false);
  });

  it('end：调用 res.end 结束流并清除心跳定时器（重复 end 幂等）', () => {
    vi.useFakeTimers();
    const { res, end, write } = mockRes();
    const sse = new SseService(res);
    sse.end();
    sse.end(); // 幂等：第二次 no-op
    expect(end).toHaveBeenCalledTimes(1);
    // end 后定时器已清除：推进时间不再写心跳
    vi.advanceTimersByTime(60000);
    expect(write).not.toHaveBeenCalled();
  });
});

// e2e 轮询助手（Task 1.4）：解析/向量化等异步队列任务无法用同步断言等待，
// 用 waitFor 轮询（默认 200ms 间隔 / 10s 超时）直到条件满足或超时抛错。
// 后续 e2e（Task 1.5+ 分块、Task 1.6 向量化）复用此助手。
// 容错（Task 1.4 质量整改）：predicate 抛错（瞬时 DB 抖动/连接重置）时
// 不终止轮询——catch 后记入 lastError 继续轮询直到超时，防偶发 flake；
// 超时后若存在最近一次异常一并带出，便于区分「条件未满足」与「一直在抛错」。
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    description?: string;
  } = {},
): Promise<void> {
  const { timeoutMs = 10000, intervalMs = 200 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      // 瞬时异常（如 DB 连接抖动）：记录后继续轮询，不把偶发错误放大成失败
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = lastError
    ? `（最近一次 predicate 异常: ${(lastError as Error).message ?? lastError}）`
    : '';
  throw new Error(
    `waitFor 超时（${timeoutMs}ms）：${options.description ?? '条件未满足'}${detail}`,
  );
}

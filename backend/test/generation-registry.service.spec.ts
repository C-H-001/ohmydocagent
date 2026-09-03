// GenerationRegistry 单元测试（Task 2.10 停止生成）：生成中任务注册表
// （sessionId → AbortController）——stop 端点经 registry 定位并 abort 活动
// 生成（烧 token 止损）；生成完成/异常后 finally 注销（防泄漏）。覆盖：
// register/isActive/stop（abort + 返回语义）/unregister（含「旧生成的 finally
// 不注销新注册」的竞态防御）/幂等 stop（前端连点安全）/重复注册防御。
import { describe, expect, it } from 'vitest';
import { GenerationRegistry } from '../src/modules/chat/sse/generation-registry.service.js';

describe('GenerationRegistry（生成任务注册表）', () => {
  it('register 后 isActive 为 true；stop 触发 abort 并返回 { stopped: true }', () => {
    const registry = new GenerationRegistry();
    const controller = new AbortController();
    registry.register('s1', controller);
    expect(registry.isActive('s1')).toBe(true);
    const res = registry.stop('s1');
    expect(res).toEqual({ stopped: true });
    expect(controller.signal.aborted).toBe(true);
  });

  it('stop 幂等：未注册/已注销/已 abort 的活动 → { stopped: false, reason: no_active_generation }（选 200 幂等而非 409，前端连点安全，见服务注释）', () => {
    const registry = new GenerationRegistry();
    // 未注册（无活动生成）
    expect(registry.stop('s1')).toEqual({
      stopped: false,
      reason: 'no_active_generation',
    });
    // 已 abort（stop 后再 stop：第一次已中止，第二次幂等返回 false）
    const controller = new AbortController();
    registry.register('s1', controller);
    registry.stop('s1');
    expect(registry.stop('s1')).toEqual({
      stopped: false,
      reason: 'no_active_generation',
    });
  });

  it('unregister 注销后 stop 返回 stopped false（完成/异常的 finally 清理，防泄漏）', () => {
    const registry = new GenerationRegistry();
    const controller = new AbortController();
    registry.register('s1', controller);
    registry.unregister('s1', controller);
    expect(registry.isActive('s1')).toBe(false);
    expect(registry.stop('s1')).toEqual({
      stopped: false,
      reason: 'no_active_generation',
    });
  });

  it('unregister 竞态防御：旧生成的 finally 不注销新生成的注册（controller 匹配才删）', () => {
    const registry = new GenerationRegistry();
    const oldController = new AbortController();
    registry.register('s1', oldController);
    // 重复注册（并发生成防御）：旧生成被中止，新生成接管注册
    const newController = new AbortController();
    registry.register('s1', newController);
    expect(oldController.signal.aborted).toBe(true);
    // 旧生成的 finally 到达：unregister(旧 controller) 不应删掉新注册
    registry.unregister('s1', oldController);
    expect(registry.isActive('s1')).toBe(true);
    // stop 仍能中止新生成
    expect(registry.stop('s1')).toEqual({ stopped: true });
    expect(newController.signal.aborted).toBe(true);
    // 新生成的 finally 到达：正常注销
    registry.unregister('s1', newController);
    expect(registry.isActive('s1')).toBe(false);
  });
});

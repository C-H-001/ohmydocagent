// backend/src/modules/chat/sse/generation-registry.service.ts
// 生成中任务注册表（Task 2.10 停止生成）：sessionId → AbortController 的内存
// Map——POST /chat/sessions/:id/stop 经 registry 定位并 abort 该会话的活动
// 生成（abort 信号经编排器 → Agent → 供应商 fetch，烧 token 止损）；生成
// 完成/异常后由编排器 finally 注销（防泄漏）。
//
// 决策（多实例部署登记）：单进程内存 Map——当前单实例部署，stop 请求打到
// 本实例即可命中注册表。多实例（负载均衡）部署时 stop 可能路由到非生成实例，
// 需 Redis pub/sub 广播（或按实例路由），登记为 P5 部署评估项（见实施计划
// Task 2.10 注释）。
//
// 幂等语义（决策，选 200 幂等而非 409）：stop 是「尽力而为」操作——无活动
// 生成返回 { stopped: false, reason: 'no_active_generation' }（200 而非 409）。
// 理由：前端连点/重复点击 stop 不应视为错误分支（409 需要前端区分并处理冲突
// 状态）；stop 的结果本身是「是否真的中止了生成」——false 时前端按已停止/
// 无生成展示即可。若未来需要严格语义（如「生成已被用户抢停」提示）可改 409，
// 属向后兼容变更，当前不引入。
//
// 并发生成防御（重复注册）：同会话第二次 register（前端连点发送）→ 旧生成
// 先 abort（停止烧 token），新生成接管注册。unregister 带 controller 参数：
// 只注销「本 controller 注册的条目」——防旧生成的 finally 在竞态下误删新
// 生成的注册（旧 finally 的 unregister(旧) 与当前条目 controller(新) 不匹配，
// 跳过删除）。
import { Injectable } from '@nestjs/common';

/** stop 结果：stopped=true 已中止活动生成；false 无活动生成（reason 说明） */
export interface StopResult {
  stopped: boolean;
  /** stopped=false 的原因（当前唯一值：no_active_generation 无活动生成） */
  reason?: string;
}

@Injectable()
export class GenerationRegistry {
  /** 活动生成：sessionId → 编排器该次 runStream 的 AbortController */
  private readonly active = new Map<string, AbortController>();

  /**
   * 注册生成任务（编排器 runStream 开始时调用）：同会话已有活动生成（并发
   * 连点发送的防御）→ 先 abort 旧生成（停止烧 token），新生成接管注册。
   */
  register(sessionId: string, controller: AbortController): void {
    const prev = this.active.get(sessionId);
    if (prev) {
      // 并发生成防御：旧生成先中止（其编排器会把已累积部分落库 + 向自己的
      // socket 发收尾事件——连接仍开则正常收尾，见编排器 abort 处理注释）
      prev.abort();
    }
    this.active.set(sessionId, controller);
  }

  /**
   * 停止生成（POST /chat/sessions/:id/stop 调用）：定位该会话的活动生成 →
   * abort（烧 token 止损）。幂等：无活动生成（未注册/已注销/已 abort）→
   * { stopped: false, reason: 'no_active_generation' }（见文件头幂等决策注释）。
   */
  stop(sessionId: string): StopResult {
    const controller = this.active.get(sessionId);
    if (!controller || controller.signal.aborted) {
      return { stopped: false, reason: 'no_active_generation' };
    }
    controller.abort();
    return { stopped: true };
  }

  /** 是否仍有活动生成（stop 后 abort 未完成注销的窗口内返回 false——abort
   * 已触发即视为不再活动；测试/调试辅助，编排器不依赖） */
  isActive(sessionId: string): boolean {
    const controller = this.active.get(sessionId);
    return controller !== undefined && !controller.signal.aborted;
  }

  /**
   * 注销生成任务（编排器 runStream 的 finally 调用）：仅当条目仍是本
   * controller 注册时删除——防「旧生成的 finally 注销新生成的注册」竞态
   * （见文件头并发生成防御注释）。
   */
  unregister(sessionId: string, controller: AbortController): void {
    if (this.active.get(sessionId) === controller) {
      this.active.delete(sessionId);
    }
  }
}

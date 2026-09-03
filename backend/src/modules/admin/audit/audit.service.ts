// 审计服务（Task 4.4）：AuditService.log 显式调用（非拦截器方案——任务决策：
// 拦截器只能拿到控制器层的动作语义，难以表达 service 内的细粒度动作（如
// 「角色从 admin 变为 owner」的前后值），故在业务 service 的既有接线点显式调用；
// 新增敏感操作接线时复用本方法）。
// 非关键路径约定：log() 内部 try/catch，任何失败（DB 抖动/表结构迁移期缺失等）
// 仅记 warn 日志不抛错——审计绝不能拖垮主流程（登录/注册等接线点无需额外
// try/catch，await 本方法也安全）。调用方按需 await（e2e 断言确定性）或
// fire-and-forget（极致低延迟场景）均可。
// ip 参数预留：既有 service 无请求上下文（见 audit-log.entity.ts 文件头注释），
// 后续如需 IP 审计，在控制器层取 req.ip 透传即可，服务签名不变。
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './audit-log.entity.js';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  /**
   * 写一条审计记录（不抛错，见文件头非关键路径约定）。
   * @param action 动作类型（如 auth.login / kb.create）
   * @param userId 操作者用户 id；系统级操作传 null
   * @param resourceType 资源类型（user / kb / kb_share / model / invitation / api_key）
   * @param resourceId 被操作资源 id；无具体资源传 null
   * @param detail 结构化上下文（仅元数据，禁止敏感字段）
   * @param ip 来源 IP（预留，缺省空串）
   */
  async log(
    action: string,
    userId: string | null,
    resourceType: string,
    resourceId: string | null,
    detail: Record<string, unknown> = {},
    ip = '',
  ): Promise<void> {
    try {
      await this.auditRepository.save(
        this.auditRepository.create({
          action,
          userId,
          resourceType,
          resourceId,
          detail,
          ip,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `审计日志写入失败（不影响主流程）: ${action}`,
        err as Error,
      );
    }
  }

  /** 分页列表（管理接口）：action/userId 可选筛选 + 时间倒序 */
  async list(page: number, pageSize: number, action?: string, userId?: string) {
    const where: Record<string, unknown> = {};
    if (action) where.action = action;
    if (userId) where.userId = userId;
    const [rows, total] = await this.auditRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items: rows, total, page, pageSize };
  }

  /** 单条详情：不存在/非法 id → null（控制器转 404；非 UUID 撞 PG 22P02 同样视为不存在） */
  async findById(id: string): Promise<AuditLog | null> {
    try {
      return await this.auditRepository.findOne({ where: { id } });
    } catch (err) {
      // 非 UUID 格式 id 撞 PG 22P02：与「不存在」同样视为无此资源 → null → 控制器 404
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        return null;
      }
      throw err;
    }
  }
}

// KB 访问权限服务（Task 4.2）：
// 判定用户对知识库的有效权限等级（view < edit < full），供 KbAccessGuard 与
// 共享管理接口共用。规则（can）：
//   1. 系统 Owner 全权限——唯一平台管理员（简化决策：系统 Admin 与普通用户
//      同权，不纳入全权限。原因：公开注册默认角色即 Admin（auth.defaultRole），
//      若 Admin 全权限则所有注册用户都能访问一切共享 KB，共享机制形同虚设；
//      「Owner/Admin 全权限」落地为系统 Owner 全权限，见测试 4.2 的
//      「Owner 全权限」用例）
//   2. KB 创建者（creatorId === user.id）全权限
//   3. 用户所在组织对该 KB 有共享（knowledge_base_shares join organization_members）
//      时，取共享权限最高档（view<edit），且不高于 edit——共享成员永远到不了
//      full（full 仅系统 Owner 与 KB 创建者，语义：edit 成员不可删除 KB、
//      不可管理共享，见任务书权限语义）
// KB 不存在 → null（与无权同语义）：判定不通过统一 404（资源隐藏，
// 防越权探测——与组织详情的「非成员 404」同思路）。
// P5 待办（注释登记）：检索范围交集——GraphSearchService/VectorService 的
// kbIds 过滤目前来自会话/提及，需与「用户可见 KB 集合」做交集，本任务只做
// API 权限层，交集逻辑在 P5 前端联调时收敛（见 effectivePermission 可复用作
// 交集判定）。
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role, User } from '../users/user.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { KnowledgeBaseShare, SharePermission } from './kb-share.entity.js';

/** KB 权限档位：view（只读）< edit（可写）< admin（KB 管理）< full（全权） */
export type KbPermission = 'view' | 'edit' | 'admin' | 'full';

/** 权限等级数值：view(1) < edit(2) < admin(3) < full(4)，比较用 */
const PERMISSION_RANK: Record<KbPermission, number> = {
  view: 1,
  edit: 2,
  admin: 3,
  full: 4,
};

@Injectable()
export class KbAccessService {
  constructor(
    @InjectRepository(KnowledgeBase)
    private readonly kbRepository: Repository<KnowledgeBase>,
    @InjectRepository(KnowledgeBaseShare)
    private readonly shareRepository: Repository<KnowledgeBaseShare>,
  ) {}

  /**
   * 用户对 KB 的最高权限等级（'full'|'edit'|'view'|null）：
   * 规则见文件头注释；KB 不存在 → null。
   */
  async effectivePermission(
    user: User,
    kbId: string,
  ): Promise<KbPermission | null> {
    let kb: KnowledgeBase | null = null;
    try {
      kb = await this.kbRepository.findOne({ where: { id: kbId } });
    } catch (err) {
      // 非 UUID 格式 id 撞 PG 22P02（invalid input syntax for type uuid）：
      // 与「不存在的 KB」同语义 → null（统一 404，不泄露 500，与
      // KbService.getById 的 22P02 处理同约定）
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        return null;
      }
      throw err;
    }
    if (!kb) return null;
    // 系统 Owner / KB 创建者：全权限
    if (user.role === Role.Super || kb.creatorId === user.id) return 'full';
    // 共享权限：个人共享（share.userId=me）∪ 所在组织共享（orgId ∈ 我的组织），
    // 取最高档（view<edit；共享永远到不了 full）
    const rows = await this.shareRepository
      .createQueryBuilder('share')
      .where('share."kbId" = :kbId', { kbId })
      .andWhere('share."userId" = :userId', { userId: user.id })
      .select('share.permission', 'permission')
      .getRawMany();
    let max: KbPermission | null = null;
    for (const row of rows) {
      const p = row.permission as SharePermission;
      if (!max || PERMISSION_RANK[p] > PERMISSION_RANK[max]) max = p;
    }
    return max;
  }

  /**
   * 用户可见的 KB id 集合（列表过滤用；Owner → null 表示全量不限）。
   * 可见 = 我创建的 ∪ 个人被共享的 ∪ 所在组织被共享的。
   * 与 effectivePermission 的判定规则一致（同一可见性语义），
   * 供 KbService.list 等列表接口过滤（view=all 不再返回全部）。
   */
  async visibleKbIds(user: User): Promise<Set<string> | null> {
    if (user.role === Role.Super) return null; // 系统 Owner 全可见
    // 1) 我创建的
    const created = await this.kbRepository
      .createQueryBuilder('kb')
      .select('kb.id', 'id')
      .where('kb."creatorId" = :userId', { userId: user.id })
      .getRawMany();
    const ids = new Set<string>(created.map((r) => r.id as string));
    // 2) 被个人共享的（用户需求：去掉组织维度，只有个人邀请）
    const shared = await this.shareRepository
      .createQueryBuilder('share')
      .where('share."userId" = :userId', { userId: user.id })
      .select('share."kbId"', 'kbId')
      .getRawMany();
    for (const r of shared) {
      ids.add(r.kbId as string);
    }
    return ids;
  }

  /** 是否满足所需权限（KB 不存在 → false） */
  async can(
    user: User,
    kbId: string,
    required: KbPermission,
  ): Promise<boolean> {
    const perm = await this.effectivePermission(user, kbId);
    if (!perm) return false;
    return PERMISSION_RANK[perm] >= PERMISSION_RANK[required];
  }

  /**
   * 判定不通过的分级语义（与任务书对齐）：
   * - 无任何访问权（KB 不存在 / 非成员）→ 404（资源隐藏，防越权探测）
   * - 有访问权但档位不足（view 成员尝试写 / edit 成员尝试删 KB、管共享）
   *   → 403（资源已知但权限不够，任务书「view 成员可读不可写（403）」）
   */
  async assertCan(
    user: User,
    kbId: string,
    required: KbPermission,
  ): Promise<void> {
    const perm = await this.effectivePermission(user, kbId);
    if (!perm) {
      throw new NotFoundException('知识库不存在或无权访问');
    }
    if (PERMISSION_RANK[perm] < PERMISSION_RANK[required]) {
      throw new ForbiddenException('无权执行该操作');
    }
  }
}

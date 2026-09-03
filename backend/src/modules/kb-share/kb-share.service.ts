// 知识库共享服务（个人邀请，用户需求：去掉组织维度）：
// - create：仅 full 权限（KB 创建者/系统 super）可共享；目标用户按 email
//   或 userId 指定；重复共享（kbId+userId 唯一）409（并发兜底撞 23505）
// - list：admin 及以上可查看共享列表（KBAdmin 可见成员，含 userName join）；
//   增删改仍是 full 专属（成员管理 = KBOwner 专属）
// - update：仅 full；改权限（view↔edit↔admin）；share 不属于该 kb → 404
// - remove：仅 full；撤销共享（删除）
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../admin/audit/audit.service.js';
import { User } from '../users/user.entity.js';
import { CreateShareDto } from './dto/create-share.dto.js';
import { UpdateShareDto } from './dto/update-share.dto.js';
import { KbAccessService } from './kb-access.service.js';
import { KnowledgeBaseShare } from './kb-share.entity.js';

@Injectable()
export class KbShareService {
  constructor(
    @InjectRepository(KnowledgeBaseShare)
    private readonly shareRepository: Repository<KnowledgeBaseShare>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly kbAccessService: KbAccessService,
    // Task 4.4 审计（全局模块直接注入，见 audit.module.ts 注释）
    private readonly audit: AuditService,
  ) {}

  /** 创建共享：201 返回完整实体；KB 不存在/非成员 404、档位不足 403（assertCan 分级语义） */
  async create(kbId: string, dto: CreateShareDto, user: User) {
    // 共享管理是 full 专属（KB 创建者/系统 super），view/edit/admin 成员不可管理共享
    await this.kbAccessService.assertCan(user, kbId, 'full');
    // 个人邀请：userId 或 email 二选一（DTO @ValidateIf 互斥，服务层兜底）
    let targetUserId = dto.userId ?? null;
    if (!targetUserId && !dto.email) {
      throw new BadRequestException('请指定要邀请的用户');
    }
    if (dto.email && !targetUserId) {
      const invited = await this.userRepository.findOne({
        where: { email: dto.email.toLowerCase() },
      });
      if (!invited) {
        throw new NotFoundException(`用户 ${dto.email} 未注册，请先邀请其注册`);
      }
      targetUserId = invited.id;
    }
    if (targetUserId && targetUserId === user.id) {
      throw new BadRequestException('不能共享给自己（创建者已拥有全部权限）');
    }
    try {
      const share = this.shareRepository.create({
        kbId,
        userId: targetUserId,
        permission: dto.permission,
        createdById: user.id,
      });
      const saved = await this.shareRepository.save(share);
      // 审计：KB 共享变更（创建）
      await this.audit.log('kb.share.create', user.id, 'kb_share', saved.id, {
        kbId,
        userId: targetUserId,
        permission: dto.permission,
      });
      return saved;
    } catch (err) {
      // 并发双共享兜底：后落库者撞 (kbId,userId) 唯一索引（23505）→ 409
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('该用户已被邀请到该知识库');
      }
      throw err;
    }
  }

  /** 共享列表（含 userName）：admin 及以上可看（KBAdmin 可见成员） */
  async list(kbId: string, user: User) {
    // admin 及以上可看共享列表（KBAdmin 可见成员；增删改仍是 full 专属）
    await this.kbAccessService.assertCan(user, kbId, 'admin');
    const shares = await this.shareRepository.find({
      where: { kbId },
      order: { createdAt: 'DESC' },
    });
    // 用户名一次查询避免 N+1（用户已删时兜底空串）
    const userIds = [
      ...new Set(shares.map((s) => s.userId).filter((x): x is string => !!x)),
    ];
    const users = userIds.length
      ? await this.userRepository.find({ where: { id: In(userIds) } })
      : [];
    const userNameMap = new Map(users.map((u) => [u.id, u.email]));
    return shares.map((s) => ({
      ...s,
      userName: s.userId ? (userNameMap.get(s.userId) ?? '') : '',
    }));
  }

  /** 改权限（view↔edit↔admin）：仅 full 权限；share 不属于该 kb → 404 */
  async update(kbId: string, shareId: string, dto: UpdateShareDto, user: User) {
    await this.kbAccessService.assertCan(user, kbId, 'full');
    const share = await this.shareRepository.findOne({
      where: { id: shareId, kbId },
    });
    if (!share) throw new NotFoundException('共享不存在');
    share.permission = dto.permission;
    const saved = await this.shareRepository.save(share);
    // 审计：KB 共享变更（改权限）
    await this.audit.log('kb.share.update', user.id, 'kb_share', share.id, {
      kbId,
      userId: share.userId,
      permission: dto.permission,
    });
    return saved;
  }

  /** 撤销共享（删除）：仅 full 权限；share 不属于该 kb → 404 */
  async remove(kbId: string, shareId: string, user: User): Promise<void> {
    await this.kbAccessService.assertCan(user, kbId, 'full');
    const share = await this.shareRepository.findOne({
      where: { id: shareId, kbId },
    });
    if (!share) throw new NotFoundException('共享不存在');
    await this.shareRepository.delete({ id: shareId });
    // 审计：KB 共享变更（撤销）
    await this.audit.log('kb.share.remove', user.id, 'kb_share', shareId, {
      kbId,
      userId: share.userId,
    });
  }
}

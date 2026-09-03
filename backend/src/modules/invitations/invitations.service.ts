// backend/src/modules/invitations/invitations.service.ts
// 邀请数据访问与业务规则：
// - create：邮箱已注册/已有待使用邀请 → 409；生成一次性 token（32 字节 hex）与过期时间
// - list：分页列表，token 脱敏为 tokenPreview（完整 token 仅创建响应返回一次）
// - revoke：撤销即删除（删除后 lookup/consume 查不到即 400，token 立即失效）
// - lookup：公开校验（有效返回 email/role/expiresAt，不返回 token 本身）
// - consume：原子消费（UPDATE ... WHERE token/used=false/email/expiresAt>now，
//   affected=1 才算成功，天然防并发双用），供 AuthService.registerByInvite 在事务内调用
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import { AuditService } from '../admin/audit/audit.service.js';
import { Role } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { Invitation } from './invitation.entity.js';

/** 列表单条记录：token 脱敏预览 + 状态计算字段（used/expired/valid） */
export interface InvitationListItem {
  id: string;
  email: string;
  role: Role;
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
  status: 'used' | 'expired' | 'valid';
  tokenPreview: string;
}

/** 邮箱规范化（与 AuthService 的 M2 约定一致：trim + 小写），避免同邮箱大小写差异重复邀请 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(Invitation)
    private readonly invitationsRepository: Repository<Invitation>,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
    // Task 4.4 审计（全局模块直接注入，见 audit.module.ts 注释）
    private readonly audit: AuditService,
  ) {}

  /** 创建邀请：返回含完整 token 的实体（完整 token 仅创建响应返回一次） */
  async create(
    dto: CreateInvitationDto,
    creatorId: string,
  ): Promise<Invitation> {
    const email = normalizeEmail(dto.email);
    // 目标邮箱已注册 → 409
    if (await this.usersService.findByEmail(email)) {
      throw new ConflictException('该邮箱已注册');
    }
    // 已有「未使用且未过期」的同邮箱邀请 → 409（过期/已使用的旧邀请不阻塞重新邀请）
    const pending = await this.invitationsRepository.findOne({
      where: { email, used: false },
    });
    if (pending) {
      if (pending.expiresAt.getTime() > Date.now()) {
        throw new ConflictException('该邮箱已有待使用邀请');
      }
      // 过期但未使用的旧邀请：partial unique index（email WHERE used=false，见
      // Invitation 实体）下会阻塞新邀请插入（撞唯一约束），先清理过期残留再插入，
      // 保持「过期不阻塞重新邀请」语义（已使用的旧邀请 used=true 不满足谓词，无需处理）
      await this.invitationsRepository
        .createQueryBuilder()
        .delete()
        .where('"email" = :email AND "used" = false AND "expiresAt" <= now()', {
          email,
        })
        .execute();
    }
    // 角色兜底：DTO 已限制仅 admin，服务层再防一手（Owner 只能初始化/转移产生）
    const role = dto.role ?? Role.Member;
    if (role === Role.Super) {
      throw new BadRequestException('Owner 不能通过邀请产生');
    }
    // 一次性 token：32 字节 CSPRNG hex（64 字符）
    const token = randomBytes(32).toString('hex');
    const ttlDays = this.config.get<number>('invite.ttlDays') ?? 7;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    try {
      const invitation = this.invitationsRepository.create({
        email,
        role,
        token,
        used: false,
        expiresAt,
        createdById: creatorId,
      });
      const saved = await this.invitationsRepository.save(invitation);
      // 审计：创建邀请（不记 token 本身——审计表非密文容器）
      await this.audit.log(
        'invitation.create',
        creatorId,
        'invitation',
        saved.id,
        {
          email,
          role,
          ttlDays,
        },
      );
      return saved;
    } catch (err) {
      // M1 同款兜底：并发下两个 create 同时通过 pending 检查后都执行 insert，
      // 后落库者撞 partial unique index（code 23505）→ 统一转 409，避免 500 与
      // 数据库错误细节泄露
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('该邮箱已有待使用邀请');
      }
      throw err;
    }
  }

  /** 分页列表：token 脱敏为 tokenPreview（•••• + 后 6 位），附状态计算字段 */
  async list(
    page: number,
    pageSize: number,
  ): Promise<{
    items: InvitationListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const [rows, total] = await this.invitationsRepository.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const items = rows.map((row) => {
      const status: InvitationListItem['status'] = row.used
        ? 'used'
        : row.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'valid';
      return {
        id: row.id,
        email: row.email,
        role: row.role,
        used: row.used,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        status,
        // 脱敏：完整 token 只出现在创建响应，列表仅给尾号提示便于人工对账
        tokenPreview: `••••${row.token.slice(-6)}`,
      };
    });
    return { items, total, page, pageSize };
  }

  /** 撤销邀请：删除记录后 token 立即失效（lookup/consume 查不到即 400）；不存在返回 404 */
  async revoke(id: string): Promise<void> {
    try {
      const result = await this.invitationsRepository.delete({ id });
      if (!result.affected) {
        throw new NotFoundException('邀请不存在');
      }
    } catch (err) {
      // 非 UUID 格式的 id 撞 PG 22P02（invalid input syntax for type uuid），
      // 与「不存在的邀请」同样视为无此资源 → 404，不泄露内部错误
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('邀请不存在');
      }
      throw err;
    }
  }

  /** 公开校验 token：有效返回 email/role/expiresAt（不返回 token 本身） */
  async lookup(
    token: string,
  ): Promise<{ email: string; role: Role; expiresAt: Date }> {
    const invitation = await this.invitationsRepository.findOne({
      where: { token },
    });
    if (
      !invitation ||
      invitation.used ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('邀请无效或已过期');
    }
    return {
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * 原子消费邀请（供 AuthService.registerByInvite 在事务内调用）：
   * UPDATE invitations SET used=true WHERE token=:token AND used=false AND email=:email
   * AND expiresAt > now()，affected=1 才算成功。
   * PG 行锁 + READ COMMITTED 下，并发双用只有一个事务能 affected=1
   * （另一个在首事务提交后重评估 WHERE 不命中），天然防重复注册。
   * expiresAt 用 MoreThan 运算符而非裸 SQL 片段：camelCase 列名由 TypeORM 正确加引号。
   */
  async consume(
    token: string,
    email: string,
    manager: EntityManager,
  ): Promise<Invitation> {
    const result = await manager
      .createQueryBuilder()
      .update(Invitation)
      .set({ used: true })
      .where({
        token,
        used: false,
        email,
        expiresAt: MoreThan(new Date()),
      })
      .returning('*')
      .execute();
    if (!result.affected || result.affected === 0 || !result.raw?.length) {
      throw new BadRequestException('邀请无效、已使用或已过期');
    }
    return result.raw[0] as Invitation;
  }
}

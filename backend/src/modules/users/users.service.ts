// backend/src/modules/users/users.service.ts
// 用户数据访问层：按邮箱/ID 查询、创建、公开信息脱敏、分页列表、角色调整与所有权转移。
// Task 0.7 语义：系统恒有且仅有一个 Owner（init 产生；transfer 事务内原子交换），
// updateRole 只允许幂等设置，破坏唯一 Owner 不变量的变更一律 400；
// transferOwnership 用事务 + SELECT ... FOR UPDATE 锁两行，并发双转移只有一个成功。
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { paginate, Paginated } from '../../common/pagination.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { Role, User } from './user.entity.js';

/** 对外公开的用户信息（绝不含 passwordHash 等敏感字段） */
export type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    // 所有权转移需要事务（+ FOR UPDATE 并发兜底）：DataSource 由 TypeOrmModule.forRoot 全局提供
    private readonly dataSource: DataSource,
    // Task 4.4 审计（全局模块直接注入，见 audit.module.ts 注释）
    private readonly audit: AuditService,
  ) {}

  /**
   * 按邮箱查询（含 passwordHash）：登录校验密码时需要。
   * passwordHash 列是 select:false，必须 addSelect 显式取出，否则拿不到。
   */
  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }

  /** 按 ID 查询（不含 passwordHash）：鉴权/me 等场景使用 */
  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * 是否存在任意用户：首次部署初始化状态判定（无用户时允许创建 Owner）使用。
   * exists() 只探测一条记录（LIMIT 1），比 count() 语义更省——只需布尔判断。
   */
  exists(): Promise<boolean> {
    return this.usersRepository.exists();
  }

  /**
   * 创建用户：密码 bcrypt 哈希（12 轮），角色由调用方显式指定。
   * manager 可选：register-by-invite 在事务内创建用户（见 AuthService.registerByInvite），
   * 保证「原子消费邀请 + 创建用户」整体提交/回滚；缺省走仓库（普通注册/初始化）。
   */
  async create(
    email: string,
    password: string,
    name: string,
    role: Role,
    manager?: EntityManager,
  ): Promise<User> {
    // bcrypt 加盐哈希：轮数 12 是安全与性能的常见平衡点
    const passwordHash = await bcrypt.hash(password, 12);
    if (manager) {
      // 事务内创建（register-by-invite）：EntityManager.create 需显式传实体类
      const user = manager.create(User, { email, passwordHash, name, role });
      return manager.save(user);
    }
    const user = this.usersRepository.create({
      email,
      passwordHash,
      name,
      role,
    });
    return this.usersRepository.save(user);
  }

  /** 脱敏：去掉 passwordHash，其余字段原样返回（用于注册/me 等响应） */
  toPublicUser(user: User): PublicUser {
    const { passwordHash, ...publicUser } = user;
    void passwordHash; // 显式消费，避免未使用变量告警
    return publicUser;
  }

  /**
   * 更新个人资料（Task 4.6）：昵称/头像 URL 只更新传入字段（undefined 跳过）。
   * 返回脱敏公开形态；不存在 → 404。
   */
  async updateProfile(
    userId: string,
    name?: string,
    avatarUrl?: string,
  ): Promise<PublicUser> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    if (name !== undefined) user.name = name;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    return this.toPublicUser(await this.usersRepository.save(user));
  }

  /**
   * 修改密码（Task 4.6）：校验旧密码（bcrypt 比对，失败 400 统一消息避免
   * 区分「用户不存在/旧密码错误」）+ 新密码 bcrypt 哈希落库（12 轮）。
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const withHash = await this.findByEmail(user.email);
    const oldOk = await bcrypt.compare(
      oldPassword,
      withHash?.passwordHash ?? '',
    );
    if (!oldOk) {
      throw new BadRequestException('旧密码错误');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await this.usersRepository.save(user);
  }

  /**
   * 分页用户列表（Owner/Admin 管理接口）：createdAt DESC，返回脱敏公开形态。
   * 分页结构复用 common/pagination 约定：{ items, total, page, pageSize }。
   */
  async list(page: number, pageSize: number): Promise<Paginated<PublicUser>> {
    const result = await paginate(this.usersRepository, page, pageSize, {
      order: { createdAt: 'DESC' },
    });
    return { ...result, items: result.items.map((u) => this.toPublicUser(u)) };
  }

  /**
   * 角色调整（仅 Owner，RolesGuard 已拦截 + 服务层兜底）：
   * - 目标不存在 → 404；目标是操作者自己 → 400（防止自升/自降绕过语义）
   * - 角色未变化 → 幂等返回 200（不写库）
   * - 把 Admin 提升为 Owner → 400「系统只能有一个 Owner，请使用所有权转移」
   *   （提升会产生第二个 Owner，破坏唯一 Owner 不变量）
   * - 把唯一 Owner 降级为 Admin → 400「系统必须保留一个 Owner」
   *   （降级会使系统无 Owner，破坏不变量；更换 Owner 请走所有权转移）
   * 唯一 Owner 不变量由 init（首次创建）/ transfer（原子交换）两条路径共同保证，
   * 本接口在正常状态下只允许幂等设置，任何破坏不变量的变更都被显式拒绝。
   */
  async updateRole(id: string, role: Role, actor: User): Promise<PublicUser> {
    if (actor.role !== Role.Super) {
      throw new ForbiddenException('仅 Owner 可修改用户角色');
    }
    let target: User | null;
    try {
      target = await this.usersRepository.findOne({ where: { id } });
    } catch (err) {
      // 非 UUID 格式 id 撞 PG 22P02：与「不存在」同样视为无此资源 → 404（不泄露内部错误）
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('用户不存在');
      }
      throw err;
    }
    if (!target) {
      throw new NotFoundException('用户不存在');
    }
    if (target.id === actor.id) {
      throw new BadRequestException('不能修改自己的角色');
    }
    if (target.role === role) {
      // 幂等：角色未变化，直接返回当前公开信息（不写库）
      return this.toPublicUser(target);
    }
    // 审计：实际发生角色变更时记一条（幂等分支不记，避免噪音）
    await this.audit.log('user.role.change', actor.id, 'user', target.id, {
      from: target.role,
      to: role,
      actor: actor.email,
    });
    if (role === Role.Super) {
      // 目标当前是 Admin，提升后系统将有两个 Owner → 拒绝，引导走所有权转移
      throw new BadRequestException('系统只能有一个 Owner，请使用所有权转移');
    }
    // 目标当前是 Owner 且被降级 → 系统将没有 Owner → 拒绝
    throw new BadRequestException('系统必须保留一个 Owner');
  }

  /**
   * 所有权转移（仅 Owner，RolesGuard 已拦截 + 服务层兜底）：
   * 事务内原子交换：当前 Owner → Admin，目标 → Owner；返回 { previousOwner, newOwner } 公开形态。
   * 并发兜底：事务内 SELECT ... FOR UPDATE 锁住原 Owner 与目标两行（pessimistic_write），
   * 两个并发 transfer 串行执行——后到者在首事务提交后重读行数据：
   * 若原 Owner 已降级 → 403；若目标已被提升为 Owner → 400。无论如何只有一个成功，杜绝双 Owner。
   */
  async transferOwnership(
    targetUserId: string,
    actor: User,
  ): Promise<{ previousOwner: PublicUser; newOwner: PublicUser }> {
    if (actor.role !== Role.Super) {
      throw new ForbiddenException('仅 Owner 可转移所有权');
    }
    if (targetUserId === actor.id) {
      throw new BadRequestException('不能将所有权转移给自己');
    }
    return this.dataSource.transaction(async (manager) => {
      // 事务内锁定候选两行（actor + target）：getMany 生成 SELECT ... FOR UPDATE
      const locked = await manager
        .createQueryBuilder(User, 'user')
        .setLock('pessimistic_write')
        .where('user.id IN (:...ids)', { ids: [actor.id, targetUserId] })
        .getMany();
      const target = locked.find((u) => u.id === targetUserId);
      if (!target) {
        throw new NotFoundException('目标用户不存在');
      }
      if (target.role === Role.Super) {
        // 重复转移/竞态兜底：目标已是 Owner（正常态唯一 Owner 就是 actor，此处防御异常态）
        throw new BadRequestException('目标用户已是 Owner');
      }
      const currentOwner = locked.find((u) => u.id === actor.id);
      if (!currentOwner || currentOwner.role !== Role.Super) {
        // 并发兜底：行锁重读后发现原 Owner 已被另一事务降级 → 拒绝本次转移
        throw new ForbiddenException('仅 Owner 可转移所有权');
      }
      // 死锁安全隐含前提：所有并发转移共享 actor 行（同一 Owner），
      // 即使各事务锁定顺序不同，也只有一个事务能持有 actor 行锁，不会互相等待形成环；
      // 若未来允许多 Owner（解锁唯一 Owner 不变量），多个转移可能以不同顺序锁定
      // 不同 id 对（id IN 列表无固定序），存在死锁风险——届时需按 id 排序锁定。
      // 原子交换角色（同一事务内，行锁已持有，并发转移串行化）：
      // 直接改内存实体后 save——save() 是 @UpdateDateColumn 生效的显式契约
      // （manager.update() 在 TypeORM 1.1.0 也会自动追加 updated_at=CURRENT_TIMESTAMP，
      // 但 save() 不依赖该版本行为，升级/迁移时语义更稳）；行锁持有期间无并发写，无竞态。
      currentOwner.role = Role.Member;
      target.role = Role.Super;
      await manager.save([currentOwner, target]);
      const previousOwner = await manager.findOneByOrFail(User, {
        id: currentOwner.id,
      });
      const newOwner = await manager.findOneByOrFail(User, {
        id: target.id,
      });
      // 审计：所有权转移（事务内写但走独立连接——失败仅记日志不阻断；
      // 即便主事务回滚该记录仍保留，语义为「尝试过的转移」）
      await this.audit.log(
        'user.ownership.transfer',
        actor.id,
        'user',
        target.id,
        {
          previousOwner: previousOwner.email,
          newOwner: newOwner.email,
        },
      );
      return {
        previousOwner: this.toPublicUser(previousOwner),
        newOwner: this.toPublicUser(newOwner),
      };
    });
  }
}

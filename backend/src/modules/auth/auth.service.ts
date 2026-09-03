// backend/src/modules/auth/auth.service.ts
// 认证核心逻辑：注册/登录/签发 token/刷新（旋转）/登出（撤销）
// refresh token 存 Redis（rt:{userId}:{jti}），可撤销、可旋转、可幂等登出。
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { RedisService } from '../../redis/redis.service.js';
import { AuditService } from '../admin/audit/audit.service.js';
import { LookupInvitationDto } from '../invitations/dto/lookup-invitation.dto.js';
import { RegisterByInviteDto } from '../invitations/dto/register-by-invite.dto.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { Role, User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import {
  REFRESH_TOKEN_KEY_PREFIX,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants.js';
import { InitDto } from './dto/init.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';

/** refreshToken 的 payload 结构：sub 用户 ID + jti 唯一标识（Redis 键的一部分） */
interface RefreshPayload {
  sub: string;
  jti: string;
}

/**
 * 登录计时均衡用占位哈希（I2：防账户枚举计时侧信道）。
 * 预生成的真实 bcrypt hash（12 轮），对任意密码比对都返回 false；
 * 用户不存在时也执行一次 bcrypt.compare，使「密码错误」与「用户不存在」
 * 两个分支耗时接近，攻击者无法通过响应时间差枚举账户是否存在。
 */
const DUMMY_HASH =
  '$2b$12$wmagnmnaNPvDKgG8JU39weSYa7oljgMre8Lm2aOFv03URWF8CfV1y';

/**
 * refresh 旋转的原子 Lua 脚本（C1：防并发重放）。
 * KEYS[1] = rt:{sub}:{jti}。
 * 「校验存在 → 删除」在一个原子步骤内完成：同一 jti 的并发 refresh 中
 * 只有一个能返回 1（拿到旋转权），其余返回 0 被 401 拒绝，旧 token 无法重放。
 * 选择 Lua 而非 getdel：脚本把「值必须是 '1'」的存在性语义显式固化，
 * 且不依赖 ioredis 具体命令封装，可读性与可维护性更好。
 * 删除与写入新 jti 之间仍有毫秒级窗口，但原子校验已保证窗口内
 * 旧 token 的校验必然失败（键已被本请求删除），因此该窗口无安全影响。
 */
const ROTATE_SCRIPT = `
if redis.call('GET', KEYS[1]) == '1' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** 邮箱规范化（M2）：trim + 小写，注册/登录入参统一处理，避免同一邮箱因大小写/空白重复注册 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly invitationsService: InvitationsService,
    private readonly dataSource: DataSource,
    // Task 4.4 审计（全局模块直接注入）：登录/注册/邀请消费成功各记一条
    // （审计非关键路径——AuditService.log 内部吞错，await 安全）
    private readonly audit: AuditService,
  ) {}

  /**
   * 系统是否已初始化：存在任意用户即视为已初始化。
   * 前端据此决定是否进入首次部署初始化流程（init-status 接口）。
   */
  async isInitialized(): Promise<boolean> {
    // 存在任意用户即视为已初始化：exists() 只探测一条记录（LIMIT 1），
    // 比 count() 语义更省——不关心总数，只需要布尔判断
    return await this.usersService.exists();
  }

  /**
   * 首次部署初始化：系统无用户时创建 Owner 账号并签发 token。
   * 已初始化后调用一律 409——Owner 只能由初始化/转移产生（见 Task 0.7），
   * 公开注册默认 Admin（register），此处直接指定 Owner，不走注册的默认角色逻辑，
   * 防止绕过角色限制提权。
   */
  async init(dto: InitDto) {
    if (await this.isInitialized()) {
      throw new ConflictException('系统已初始化');
    }
    const email = normalizeEmail(dto.email);
    try {
      const user = await this.usersService.create(
        email,
        dto.password,
        dto.name ?? '',
        Role.Super,
      );
      return this.buildAuthResponse(user);
    } catch (err) {
      // 并发初始化兜底：两个 init 请求同时通过 isInitialized 检查后，
      // 后落库者撞 PG 唯一约束（code 23505），统一转 409「系统已初始化」，
      // 避免并发双 Owner 时 500 与数据库错误细节泄露（与 register 的 M1 同模式）
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('系统已初始化');
      }
      throw err;
    }
  }

  /**
   * 注册新用户。
   * 默认角色来自配置 auth.defaultRole（I3 配置化，默认 Admin）—— Owner 只能由
   * 初始化/转移产生（见 Task 0.5/0.7），避免公开注册接口被用于提权。
   */
  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('该邮箱已被注册');
    }
    const role = this.config.get<Role>('auth.defaultRole') ?? Role.Member;
    try {
      const user = await this.usersService.create(
        email,
        dto.password,
        dto.name ?? '',
        role,
      );
      // 审计：注册成功（仅元数据，不记密码相关字段）
      await this.audit.log('auth.register', user.id, 'user', user.id, {
        email,
        role,
      });
      return this.buildAuthResponse(user);
    } catch (err) {
      // M1：并发注册兜底——两个请求同时通过 findByEmail 查重后，后落库者撞 PG
      // 唯一约束（code 23505），统一转 409，避免 500 与数据库错误细节泄露
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '23505'
      ) {
        throw new ConflictException('该邮箱已被注册');
      }
      throw err;
    }
  }

  /** 登录：校验邮箱 + 密码，失败统一报「邮箱或密码错误」避免枚举用户是否存在 */
  async login(dto: LoginDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.usersService.findByEmail(email);
    // I2：用户不存在时也对占位哈希做一次 bcrypt.compare，两分支耗时相近，
    // 响应时间无法区分账户是否存在
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !passwordOk) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    // 审计：登录成功（失败不记——防审计表被爆破尝试灌满）
    await this.audit.log('auth.login', user.id, 'user', user.id, { email });
    return this.buildAuthResponse(user);
  }

  /** 公开：校验邀请 token，返回绑定邮箱/角色/过期时间（不返回 token 本身） */
  async lookupInvitation(dto: LookupInvitationDto) {
    return this.invitationsService.lookup(dto.token);
  }

  /**
   * 邀请注册：事务内「原子消费邀请 → 创建用户（角色=邀请指定角色）→ 签发 token」。
   * 事务保证：任一步失败整体回滚，邀请不会被消耗（前端可重试）；
   * consume 的 UPDATE 条件（used=false / email 匹配 / 未过期）在 PG 行锁下原子，
   * 并发双用只有一个请求 affected=1，其余 400，天然防重复注册。
   */
  async registerByInvite(dto: RegisterByInviteDto) {
    const email = normalizeEmail(dto.email);
    return this.dataSource.transaction(async (manager) => {
      // 1. 原子消费：affected=0（token 无效/已用/过期/邮箱不匹配）→ 400，事务回滚
      const invitation = await this.invitationsService.consume(
        dto.token,
        email,
        manager,
      );
      // 2. 创建用户：角色必须来自邀请（DTO 已限制仅 admin），杜绝提权路径
      let user: User;
      try {
        user = await this.usersService.create(
          email,
          dto.password,
          dto.name ?? '',
          invitation.role,
          manager,
        );
      } catch (err) {
        // M1 同款兜底：并发下「邮箱已注册」由 PG 唯一约束（23505）捕获 → 409；
        // 异常导致事务回滚，上一步的 used=true 一并撤销，邀请保持可用
        if (
          (err as { driverError?: { code?: string } })?.driverError?.code ===
          '23505'
        ) {
          throw new ConflictException('该邮箱已被注册');
        }
        throw err;
      }
      // 3. 签发 token：失败同样整体回滚，邀请不消耗
      const response = this.buildAuthResponse(user);
      // 审计：邀请消费成功（事务内写但走独立连接——审计失败不影响主事务；
      // 即便主事务回滚，该审计仍保留，语义为「尝试过的消费」）
      await this.audit.log(
        'invitation.consume',
        user.id,
        'invitation',
        invitation.id,
        {
          email,
          role: invitation.role,
        },
      );
      return response;
    });
  }

  /**
   * 刷新 accessToken：校验 refreshToken 签名 + Redis 中 jti 仍有效（未被登出/旋转），
   * 成功后旋转：原子删除旧 jti 并签发新的一对 token（Lua 脚本见 ROTATE_SCRIPT）。
   */
  async refresh(dto: RefreshDto) {
    const payload = await this.verifyRefreshToken(dto.refreshToken);
    const key = this.refreshKey(payload.sub, payload.jti);
    // 原子「校验存在 → 删除」：返回 1 说明本请求拿到旋转权；0 说明已被登出/旋转，拒绝重放
    const rotated = await this.redis.getClient().eval(ROTATE_SCRIPT, 1, key);
    if (rotated !== 1) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }
    return this.buildAuthResponse(user);
  }

  /** 登出：删除 Redis 中的 jti，refreshToken 立即失效（幂等，无效 token 直接忽略） */
  async logout(dto: RefreshDto): Promise<void> {
    const payload = await this.verifyRefreshToken(dto.refreshToken);
    await this.redis.del(this.refreshKey(payload.sub, payload.jti));
  }

  /** 签发 accessToken（2h）+ refreshToken（7d，Redis 存 jti 以便撤销） */
  private async buildAuthResponse(user: User) {
    const secret = this.config.getOrThrow<string>('jwt.secret');
    // accessToken payload 精简为 { sub }（M3）：JwtStrategy 每次请求都查库返回
    // 最新用户，token 内冗余 email/role 只会形成过期快照；RBAC 判定统一走数据库
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id },
      { secret, expiresIn: this.config.get('jwt.expiresIn') },
    );
    const jti = randomUUID();
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, jti },
      { secret, expiresIn: this.config.get('jwt.refreshExpiresIn') },
    );
    await this.redis.set(
      this.refreshKey(user.id, jti),
      '1',
      REFRESH_TOKEN_TTL_SECONDS,
    );
    return {
      accessToken,
      refreshToken,
      user: this.usersService.toPublicUser(user),
    };
  }

  /** 校验 refreshToken 签名/过期，失败统一抛 401（不区分原因，避免泄露细节） */
  private async verifyRefreshToken(token: string): Promise<RefreshPayload> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.secret'),
      });
    } catch {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }
    // M5：refreshToken 必须携带 sub + jti（撤销/旋转的唯一依据），缺失直接 401
    if (!payload.sub || !payload.jti) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }
    return payload;
  }

  private refreshKey(userId: string, jti: string): string {
    return `${REFRESH_TOKEN_KEY_PREFIX}${userId}:${jti}`;
  }
}

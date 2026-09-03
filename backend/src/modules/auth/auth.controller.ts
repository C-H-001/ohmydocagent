// backend/src/modules/auth/auth.controller.ts
// 认证路由：注册/登录/刷新/初始化/登出为公开接口（@Public），/me 需要登录态
// 公开认证端点统一加 ThrottlerGuard + @Throttle 限流（I4：防凭证填充/爆破）；
// ThrottlerGuard 未注册为全局 APP_GUARD（限流参数见 AppModule，guard 仅此处显式挂载）
import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ConfigService } from '@nestjs/config';
import { LookupInvitationDto } from '../invitations/dto/lookup-invitation.dto.js';
import { RegisterByInviteDto } from '../invitations/dto/register-by-invite.dto.js';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { InitDto } from './dto/init.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  // 公开：初始化状态查询——存在任意用户即视为已初始化（见 AuthService.isInitialized），
  // 供前端判断是否需要进入首次部署初始化流程。
  // 与头部注释政策一致：公开认证端点统一挂 ThrottlerGuard（I4），
  // 状态轮询较轻，限额放宽到 60 次/分钟/IP
  @Public()
  @Get('init-status')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async initStatus() {
    return { initialized: await this.authService.isInitialized() };
  }

  // 公开：首次部署初始化（创建 Owner，仅系统无用户时可调用，之后一律 409，见 AuthService.init）
  // 限流：10 次/分钟/IP，防暴力尝试
  @Public()
  @Post('init')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  init(@Body() dto: InitDto, @Headers('x-init-token') initToken?: string) {
    // 生产初始化安全（Task 0.5 登记项）：配置了 INIT_TOKEN 时必须携带匹配的
    // X-Init-Token 头，防止公网部署被抢先初始化（管理员初始化前攻击者接管）。
    const expected = this.configService.get<string>('initToken');
    if (expected && initToken !== expected) {
      throw new UnauthorizedException('初始化令牌无效');
    }
    return this.authService.init(dto);
  }

  @Public()
  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // 公开：邀请 token 校验（注册前确认邀请有效性，返回绑定邮箱/角色/过期时间）。
  // 限流 30 次/分钟/IP：防 token 暴力枚举
  @Public()
  @Post('invitations/lookup')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  lookupInvitation(@Body() dto: LookupInvitationDto) {
    return this.authService.lookupInvitation(dto);
  }

  // 公开：邀请注册（token 一次性/可过期/可撤销，邮箱必须与邀请绑定一致）
  @Public()
  @Post('register-by-invite')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  registerByInvite(@Body() dto: RegisterByInviteDto) {
    return this.authService.registerByInvite(dto);
  }

  @Public()
  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto);
  }

  // 公开：登出只依赖 refreshToken（销毁 Redis 中的 jti），无需携带 accessToken
  @Public()
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.authService.logout(dto);
  }

  /** 当前登录用户信息（JwtStrategy 已查库确认用户存在，这里取库中最新数据脱敏返回） */
  @Get('me')
  me(@CurrentUser() user: User) {
    return this.usersService.toPublicUser(user);
  }
}

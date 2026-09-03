// backend/src/modules/auth/jwt.strategy.ts
// passport-jwt 策略：从 Authorization: Bearer <token> 取 JWT 并校验签名/过期，
// validate 返回的值挂到 req.user（@CurrentUser() 读取）。
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';

/**
 * accessToken 的 payload 结构（签发见 AuthService.buildAuthResponse）。
 * 精简为 { sub }（M3）：JwtStrategy 每次请求都查库返回最新用户，
 * token 内不携带 email/role 等冗余快照字段（避免角色变更后 token 仍含旧值）。
 */
export interface JwtPayload {
  sub: string; // 用户 ID
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // 过期 token 直接拒绝
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  /**
   * 每次请求都查库确认用户仍存在：用户被删除/停用后其 token 立即失效，
   * 而不是等到 token 自然过期（与 refresh 撤销机制互补）。
   */
  async validate(payload: JwtPayload): Promise<User> {
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }
    return user;
  }
}

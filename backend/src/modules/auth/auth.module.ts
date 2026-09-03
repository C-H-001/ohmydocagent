// backend/src/modules/auth/auth.module.ts
// 认证模块：JWT 签名（全局 JwtService）+ passport-jwt 策略 + AuthService/Controller。
// 全局 JwtAuthGuard 在 AppModule 通过 APP_GUARD 注册，策略在此模块注册。
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { RedisModule } from '../../redis/redis.module.js';
import { InvitationsModule } from '../invitations/invitations.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [
    UsersModule,
    // 邀请模块：AuthService.registerByInvite/lookupInvitation 依赖其 Service
    InvitationsModule,
    RedisModule,
    // passport 默认策略 jwt：AuthGuard('jwt') 直接可用
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // 全局 JwtModule：secret 从集中配置读取，后续模块（如文档分享）可直接注入 JwtService
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}

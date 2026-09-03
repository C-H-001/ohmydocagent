// backend/src/modules/invitations/invitations.module.ts
// 邀请模块：提供邀请 CRUD 与原子消费；AuthModule 依赖其 Service 实现邀请注册
// （AuthService.registerByInvite 在事务内调用 InvitationsService.consume）
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { Invitation } from './invitation.entity.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Invitation]), UsersModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}

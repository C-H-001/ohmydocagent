// 模型用量模块：ModelUsage 实体 + 服务 + 查询控制器。
// GET /me/model-usage：当前用户自己的用量（所有登录用户）；
// GET /admin/model-usage：全部用户用量（super 专属）。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity.js';
import { ModelUsage } from './model-usage.entity.js';
import { ModelUsageService } from './model-usage.service.js';
import { UsageController } from './usage.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([ModelUsage, User])],
  controllers: [UsageController],
  providers: [ModelUsageService],
  exports: [ModelUsageService],
})
export class UsageModule {}

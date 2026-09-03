// 全局设置 + 系统信息模块（Task 4.6）：SystemSetting 实体 + 读写服务/控制器 +
// 系统信息健康探测。依赖：RedisModule/Neo4jModule（系统信息健康探测的 ping/
// run，按需注入约定）；DataSource 由 TypeOrmModule.forRoot 全局提供。
// 个人资料（GET/PUT /settings/profile、POST /settings/change-password）按任务
// 简化决策放 users 模块（users/profile.controller.ts——用户自身资源归用户域，
// 与全局配置域分离，见该文件注释）。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Neo4jModule } from '../../../neo4j/neo4j.module.js';
import { RedisModule } from '../../../redis/redis.module.js';
import {
  SettingsController,
  SystemInfoController,
} from './system-setting.controller.js';
import { SystemInfoService } from './system-info.service.js';
import { SystemSetting } from './system-setting.entity.js';
import { SystemSettingService } from './system-setting.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemSetting]),
    RedisModule,
    Neo4jModule,
  ],
  controllers: [SettingsController, SystemInfoController],
  providers: [SystemSettingService, SystemInfoService],
  exports: [SystemSettingService],
})
export class SettingsModule {}

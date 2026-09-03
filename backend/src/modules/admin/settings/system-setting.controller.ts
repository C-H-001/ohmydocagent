// 全局设置 + 系统信息路由（Task 4.6）：
// - GET/PUT /admin/settings：全局配置读写（@Roles(Owner, Admin) 类级声明，
//   全局 RolesGuard 生效）；PUT 请求体为 { values: { key: value, ... } } 部分
//   更新，逐 key 校验（未知 key/类型不符/范围越界 → 400，见 service 注释）
// - GET /system/info：版本 + PG/Redis/Neo4j 健康状态（@Roles(Owner, Admin)——
//   管理面板可见；运维探活若需免认证可后续单独开 @Public 端点）
import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsDefined, IsObject } from 'class-validator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { Role, User } from '../../users/user.entity.js';
import { SystemInfoService } from './system-info.service.js';
import { SystemSettingService } from './system-setting.service.js';

/** 设置更新请求体：values 为 key→value 部分更新（逐 key 校验在 service 层） */
export class UpdateSettingsDto {
  @IsDefined({ message: 'values 必填' })
  @IsObject({ message: 'values 必须是对象' })
  values!: Record<string, unknown>;
}

@Roles(Role.Super)
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settingService: SystemSettingService) {}

  /** 读取全部配置（DB 值合并注册表默认值） */
  @Get()
  get() {
    return this.settingService.getSettings();
  }

  /** 更新配置（部分更新；PUT 幂等语义：重复提交相同值结果一致） */
  @Put()
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() user: User) {
    return this.settingService.updateSettings(dto.values, user.id);
  }
}

@Roles(Role.Super)
@Controller('system')
export class SystemInfoController {
  constructor(private readonly systemInfoService: SystemInfoService) {}

  /** 系统信息：版本 + 三服务健康 */
  @Get('info')
  info() {
    return this.systemInfoService.info();
  }
}

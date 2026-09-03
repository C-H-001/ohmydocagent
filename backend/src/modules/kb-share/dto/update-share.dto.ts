// 修改 KB 共享请求体：仅权限字段（view|edit）
import { IsIn } from 'class-validator';
import { SharePermission } from '../kb-share.entity.js';

export class UpdateShareDto {
  @IsIn([SharePermission.View, SharePermission.Edit, SharePermission.Admin], {
    message: '权限只能是 view、edit 或 admin',
  })
  permission!: SharePermission;
}

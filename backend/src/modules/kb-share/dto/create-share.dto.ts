// 创建 KB 共享请求体：个人邀请（userId 或 email 二选一）+ 权限
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { SharePermission } from '../kb-share.entity.js';

export class CreateShareDto {
  // 个人邀请目标：userId（已知用户）或 email（按邮箱找人，未注册则提示）
  @ValidateIf((o: CreateShareDto) => !o.email)
  @IsNotEmpty({ message: '请指定共享给用户' })
  @IsString({ message: 'userId 必须是字符串' })
  @IsUUID(undefined, { message: 'userId 必须是合法的 UUID' })
  userId?: string;

  // 按邮箱邀请个人（与 orgId/userId 互斥；服务层按 email 解析用户）
  @ValidateIf((o: CreateShareDto) => !o.userId)
  @IsNotEmpty({ message: '请填写被邀请人的邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @IsIn([SharePermission.View, SharePermission.Edit, SharePermission.Admin], {
    message: '权限只能是 view、edit 或 admin',
  })
  permission!: SharePermission;
}

// backend/src/modules/invitations/dto/create-invitation.dto.ts
// 创建邀请请求体：目标邮箱 + 可选角色（仅 admin）
import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { Role } from '../../users/user.entity.js';

export class CreateInvitationDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  // 角色可选，默认 admin；显式限制仅允许 admin——Owner 只能由初始化/转移产生
  // （见 Task 0.5/0.7），绝不能通过邀请注册提权（服务层对 Role.Super 再做兜底校验）
  @IsOptional()
  @IsIn([Role.Member], {
    message: '邀请角色只能是 admin（Owner 不能通过邀请产生）',
  })
  role?: Role;
}

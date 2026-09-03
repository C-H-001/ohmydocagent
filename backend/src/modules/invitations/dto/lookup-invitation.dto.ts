// backend/src/modules/invitations/dto/lookup-invitation.dto.ts
// 邀请 token 校验请求体（公开接口，注册前确认邀请有效性）
import { IsString } from 'class-validator';

export class LookupInvitationDto {
  @IsString({ message: '邀请令牌必须是字符串' })
  token!: string;
}

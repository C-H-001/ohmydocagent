// backend/src/modules/invitations/dto/register-by-invite.dto.ts
// 邀请注册请求体：token + 邮箱（必须与邀请绑定邮箱一致）+ 密码 + 昵称
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterByInviteDto {
  @IsString({ message: '邀请令牌必须是字符串' })
  token!: string;

  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  // 与公开注册同强度：至少 8 位且同时包含字母和数字
  @IsString({ message: '密码必须是字符串' })
  @MinLength(8, { message: '密码至少 8 位' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: '密码必须同时包含字母和数字',
  })
  password!: string;

  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @MaxLength(50, { message: '昵称最长 50 个字符' })
  name?: string;
}

// backend/src/modules/auth/dto/register.dto.ts
// 注册请求体校验：邮箱格式、密码强度、昵称长度（中文错误消息）
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  // 复杂度规则：至少 8 位且同时包含字母和数字（够用即可，避免过度约束影响体验）
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

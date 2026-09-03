// 修改密码请求体：旧密码必填 + 新密码强度（与注册同规则：至少 8 位且同时
// 包含字母和数字，见 auth/dto/register.dto.ts 注释）
import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString({ message: '旧密码必须是字符串' })
  @IsNotEmpty({ message: '旧密码不能为空' })
  oldPassword!: string;

  @IsString({ message: '新密码必须是字符串' })
  @MinLength(8, { message: '新密码至少 8 位' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: '新密码必须同时包含字母和数字',
  })
  newPassword!: string;
}

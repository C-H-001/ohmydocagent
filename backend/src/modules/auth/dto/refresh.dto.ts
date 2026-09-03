// backend/src/modules/auth/dto/refresh.dto.ts
// 刷新/登出请求体校验（中文错误消息）
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshDto {
  @IsString({ message: 'refreshToken 必须是字符串' })
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  refreshToken!: string;
}

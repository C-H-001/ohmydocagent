// 更新个人资料请求体：昵称/头像 URL 可选（只更新传入字段）
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @MaxLength(50, { message: '昵称最长 50 个字符' })
  name?: string;

  @IsOptional()
  @IsUrl({}, { message: '头像地址必须是合法的 URL' })
  @MaxLength(500, { message: '头像地址最长 500 个字符' })
  avatarUrl?: string;
}

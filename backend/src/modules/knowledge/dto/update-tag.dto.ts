// 更新标签请求体：name/color 均可选（语义为「只更新传入字段」，服务层按
// undefined 判定跳过，与 UpdateKnowledgeDto 一致）。
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateTagDto {
  @IsOptional()
  @IsString({ message: '标签名必须是字符串' })
  @IsNotEmpty({ message: '标签名不能为空' })
  @Matches(/\S/, { message: '标签名不能为空白' })
  @MaxLength(50, { message: '标签名最长 50 个字符' })
  name?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color 必须是 #RRGGBB 十六进制色值',
  })
  color?: string;
}

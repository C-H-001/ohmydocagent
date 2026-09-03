// 创建标签请求体：name 必填（非空白，最长 50），color 可选（#RRGGBB，缺省默认蓝）。
// 知识库内重名由服务层查重（409）+ DB 唯一索引兜底（见 Tag 实体注释）。
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateTagDto {
  @IsString({ message: '标签名必须是字符串' })
  @IsNotEmpty({ message: '标签名不能为空' })
  @Matches(/\S/, { message: '标签名不能为空白' })
  @MaxLength(50, { message: '标签名最长 50 个字符' })
  name: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color 必须是 #RRGGBB 十六进制色值',
  })
  color?: string;
}

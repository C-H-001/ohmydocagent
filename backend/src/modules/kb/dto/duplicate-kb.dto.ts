// 复制知识库请求体：可选 name 覆盖副本名称（不传则默认「原名称 副本」）。
// 空 body 也合法（POST 动作语义：默认命名复制），故全部字段可选且无必填校验。
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class DuplicateKbDto {
  @IsOptional()
  @IsString({ message: '名称必须是字符串' })
  @IsNotEmpty({ message: '名称不能为空' })
  // 与 CreateKbDto 同步：显式传入纯空白名称（如 '   '）同样 400
  @Matches(/\S/, { message: '名称不能为空白' })
  @MaxLength(100, { message: '名称最长 100 个字符' })
  name?: string;
}

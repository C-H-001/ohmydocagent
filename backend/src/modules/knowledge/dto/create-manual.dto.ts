// 手动创建文档请求体：标题必填（≤200，去首尾空白后不可为空）、正文必填（≤100000）
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateManualDto {
  @IsString({ message: '标题必须是字符串' })
  @IsNotEmpty({ message: '标题不能为空' })
  // IsNotEmpty 拦不住纯空白（'   '），\S 匹配保证标题至少含一个非空白字符
  @Matches(/\S/, { message: '标题不能为空白' })
  @MaxLength(200, { message: '标题最长 200 个字符' })
  title!: string;

  @IsString({ message: '内容必须是字符串' })
  @IsNotEmpty({ message: '内容不能为空' })
  @Matches(/\S/, { message: '内容不能为空白' })
  // 手动正文上限 100KB（防超大请求体打满内存；真实长文建议走文件上传）
  @MaxLength(100000, { message: '内容最长 100000 个字符' })
  content!: string;
}

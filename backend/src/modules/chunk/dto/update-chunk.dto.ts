// 分块编辑请求体（Task 1.9）：content 必填。
// 校验语义：@IsString（类型）、@IsNotEmpty（空串 400）、@MaxLength(20000)
// （中文注释块上限——分块默认 chunkSize=800，编辑放宽到 20000 兼容手动拼接
// 的长内容，但防超大 body 拖垮向量化/存储；与 CreateManualDto 的正文上限
// 同量级，见该 DTO 注释）。
// @Transform trim（质量审查整改）：防纯空白内容——'   ' trim 后为空串，由
// @IsNotEmpty 拦下 400（ValidationPipe transform:true 下先转换后校验，非字符串
// 值经 typeof 守卫原样放行给 @IsString 判定）。
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateChunkDto {
  @IsString({ message: '内容必须是字符串' })
  @IsNotEmpty({ message: '内容不能为空' })
  @MaxLength(20000, { message: '内容最长 20000 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  content: string;
}

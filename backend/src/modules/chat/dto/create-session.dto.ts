// 创建会话请求体：title 可选（缺省时服务层用默认「新会话」）、kbIds 可选。
// 决策：kbIds 宽松校验——只校验「是 uuid 数组（≤50 个）」，不校验知识库存在
// （P1 无 KB 权限体系，@提及/选择器在 UI 层保证有效；若服务端强校验存在性，
// 前端选择器与 RAG 上下文维护会出现「KB 刚删、会话打不开」的体验问题）。
// title 校验（质量审查整改）：@MinLength(1) 拦空串；@Transform trim 把纯空白
// '   ' 转成空串再被 @MinLength 拦下（ValidationPipe transform:true 下先转换
// 后校验，非字符串值经 typeof 守卫原样放行给 @IsString 判定，与
// update-chunk.dto 既有模式一致）。空串/纯空白都不能绕过默认值「新会话」。
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSessionDto {
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MinLength(1, { message: '标题不能为空' })
  @MaxLength(100, { message: '标题最长 100 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @IsOptional()
  @IsArray({ message: 'kbIds 必须是数组' })
  @ArrayMaxSize(50, { message: 'kbIds 最多 50 个' })
  @IsUUID('4', { each: true, message: 'kbIds 每项必须是合法 UUID' })
  kbIds?: string[];
}

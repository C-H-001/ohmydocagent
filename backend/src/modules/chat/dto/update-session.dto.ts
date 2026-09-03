// 更新会话请求体：全部字段可选（语义为「只更新传入的字段」，服务层按
// undefined 判定跳过）。@nestjs/mapped-types 不在 workspace 依赖中（与
// UpdateKbDto 同理由：为单个 DTO 增加新依赖不划算，YAGNI），手写同构
// Partial 类——字段与 CreateSessionDto 一一对应但全部可选（校验规则同步，
// 保证更新也不接受非法值），pinned 为会话独有字段（置顶开关，显式
// @IsOptional() @IsBoolean()，与 title/kbIds 并列）。
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateSessionDto {
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

  @IsOptional()
  @IsBoolean({ message: 'pinned 必须是布尔值' })
  pinned?: boolean;
}

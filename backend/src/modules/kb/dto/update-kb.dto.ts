// 更新知识库请求体：全部字段可选（语义为「只更新传入的字段」，服务层按
// undefined 判定跳过）。未引入 @nestjs/mapped-types 的 PartialType——该包
// 不在 workspace 依赖中，为单个 DTO 增加新依赖不划算（YAGNI），手写同构
// Partial 类：字段与 CreateKbDto 一一对应但全部可选（含与 CreateKbDto
// 相同的校验规则，保证更新也不接受非法值）。
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ExtractConfigDto } from './extract-config.dto.js';

export class UpdateKbDto {
  @IsOptional()
  @IsString({ message: '名称必须是字符串' })
  @IsNotEmpty({ message: '名称不能为空' })
  // 与 CreateKbDto 同步：纯空白名称（如 '   '）同样 400（IsNotEmpty 拦不住）
  @Matches(/\S/, { message: '名称不能为空白' })
  @MaxLength(100, { message: '名称最长 100 个字符' })
  name?: string;

  @IsOptional()
  @IsString({ message: '描述必须是字符串' })
  @MaxLength(500, { message: '描述最长 500 个字符' })
  description?: string;

  @IsOptional()
  @IsObject({ message: '分块配置必须是对象' })
  chunkingConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject({ message: '图谱抽取配置必须是对象' })
  // 与 CreateKbDto 同步的内层校验（enabled 必须为布尔，见 extract-config.dto.ts 注释）
  @ValidateNested()
  @Type(() => ExtractConfigDto)
  extractConfig?: ExtractConfigDto;
}

// 创建知识库请求体：名称必填（≤100，去首尾空白后不可为空），描述/分块配置可选
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

export class CreateKbDto {
  @IsString({ message: '名称必须是字符串' })
  @IsNotEmpty({ message: '名称不能为空' })
  // IsNotEmpty 只拦截空串/undefined，纯空白（如 '   '）会漏过——
  // 补 "/\S/" 匹配保证名称至少含一个非空白字符，与 400 语义承诺一致
  @Matches(/\S/, { message: '名称不能为空白' })
  @MaxLength(100, { message: '名称最长 100 个字符' })
  name!: string;

  @IsOptional()
  @IsString({ message: '描述必须是字符串' })
  @MaxLength(500, { message: '描述最长 500 个字符' })
  description?: string;

  // P1 接受任意对象（不校验结构，避免过度约束影响体验）；
  // Task 1.5 定义 ChunkingConfig schema（chunkSize/chunkOverlap/separators）后，
  // 在此用 class-validator 嵌套校验收口（@ValidateNested + @Type）
  @IsOptional()
  @IsObject({ message: '分块配置必须是对象' })
  chunkingConfig?: Record<string, unknown>;

  // Task 3.2：图谱抽取配置（{ enabled: boolean }，KB 级开关——默认开启，
  // enabled=false 关闭上传即建图）。质量审查整改：内层校验 enabled 必须为
  // 布尔（@ValidateNested + @Type 转换嵌套对象为 ExtractConfigDto 再校验，
  // 见 extract-config.dto.ts 注释）——拦截 { enabled: 'yes' } 等误传，
  // 消费侧判定语义确定（详见该文件注释）
  @IsOptional()
  @IsObject({ message: '图谱抽取配置必须是对象' })
  @ValidateNested()
  @Type(() => ExtractConfigDto)
  extractConfig?: ExtractConfigDto;
}

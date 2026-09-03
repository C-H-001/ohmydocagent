// 混合检索请求 DTO（Task 1.6）：query 必填非空；topK 可选 1~50（默认 10，
// 控制器/服务层兜底）。ValidationPipe whitelist+transform 已全局挂载
// （见 app.setup.ts）——非法字段 400、topK 自动转型为 number。
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** topK 上限：单次检索最多返回 50 条（对话 RAG 与前端调试共用此端点，
 * 限制防止一次拉取过大 payload；对话检索另有自己的截断逻辑） */
export const HYBRID_SEARCH_TOP_K_MAX = 50;

export class HybridSearchDto {
  /** 检索查询词（必填非空，空串/缺失 400） */
  @IsString()
  @IsNotEmpty({ message: '检索查询词不能为空' })
  query: string;

  /** 返回条数：1~50，缺省 10（@IsOptional 不校验缺省值，由服务层兜底） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HYBRID_SEARCH_TOP_K_MAX)
  topK?: number;
}

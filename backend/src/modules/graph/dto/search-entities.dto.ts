// 实体搜索查询参数（Task 3.3）：keyword 必填非空、≤50 字。
// 空串/缺失/超长由全局 ValidationPipe 拦成 400（接口契约：搜索无结果 → []
// 由服务层保证，见 graph.service.ts）；50 字是实体名搜索的合理上限——实体名
// 是 LLM 抽取的短语（人/产品/术语），长关键词无实际检索价值。
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SearchEntitiesDto {
  @IsString({ message: 'keyword 必须是字符串' })
  @IsNotEmpty({ message: 'keyword 不能为空' })
  @MaxLength(50, { message: 'keyword 最长 50 个字符' })
  keyword: string;
}

// 批量打标/去标请求体（Task 1.8）：ids 文档数组 + tagIds 标签数组。
// tagIds 语义与单条 SetKnowledgeTagsDto 一致（全量替换，幂等）；
// 空数组 = 批量去标（清除选中文档的全部标签）。tagIds 上限 100。
// 跨 KB 标签在服务层校验 → 400（严格，见 batchSetTags 注释）。
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';
import { BatchIdsDto } from './batch-ids.dto.js';

export class BatchSetTagsDto extends BatchIdsDto {
  @IsArray({ message: 'tagIds 必须是数组' })
  @IsUUID('4', { each: true, message: 'tagIds 每项必须是合法 UUID' })
  @ArrayMaxSize(100, { message: 'tagIds 最多 100 个' })
  tagIds: string[];
}

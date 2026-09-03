// 批量打标/去标请求体：tagIds 数组（全量替换语义——服务层事务内插新删旧，幂等），
// 空数组 = 清除全部标签。每项必须是合法 UUID（跨 KB 标签在服务层校验 → 400）；
// 上限 100 个（防超大数组拖垮事务，与既有 DTO 长度防护一致，见 ListKnowledgeDto）。
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class SetKnowledgeTagsDto {
  @IsArray({ message: 'tagIds 必须是数组' })
  @IsUUID('4', { each: true, message: 'tagIds 每项必须是合法 UUID' })
  @ArrayMaxSize(100, { message: 'tagIds 最多 100 个' })
  tagIds: string[];
}

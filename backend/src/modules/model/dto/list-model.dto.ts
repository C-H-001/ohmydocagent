// 模型列表查询 DTO（Task 2.3）：GET /models?type=chat 按用途类型筛选。
// 模型是系统级配置、数量有限（个位数），列表不分页（与用户/文档等
// 分页列表区分——模型管理页一次拉全量即可）。
import { IsIn, IsOptional } from 'class-validator';
import { MODEL_TYPES } from '../model.entity.js';
import type { ModelType } from '../model.entity.js';

export class ListModelDto {
  /** 用途类型筛选（chat/embedding/rerank）；不传返回全部 */
  @IsOptional()
  @IsIn([...MODEL_TYPES], {
    message: '非法 type（仅支持 chat / embedding / rerank）',
  })
  type?: ModelType;
}

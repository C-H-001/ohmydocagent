// 分块列表查询参数（Task 1.5）：仅分页（page/pageSize，上限 100）。
// Task 1.9 编辑/版本管理后可能追加筛选（如 indexStatus 向量化状态）；
// 继承 PaginationDto 复用既有分页校验（page ≥ 1、pageSize ≤ 100）。
import { PaginationDto } from '../../../common/pagination.js';

export class ListChunkDto extends PaginationDto {}

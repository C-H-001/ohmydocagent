// 会话列表查询参数：直接复用统一 PaginationDto（page/pageSize），
// 无会话独有筛选条件（Task 2.1 无 keyword/类型筛选；需要时在此扩展）。
import { PaginationDto } from '../../../common/pagination.js';

export class ListSessionDto extends PaginationDto {}

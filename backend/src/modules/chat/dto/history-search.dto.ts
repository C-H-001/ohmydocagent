// 历史搜索查询参数（Task 2.11）：keyword 必填 + 分页（复用 PaginationDto）。
// keyword 校验（决策）：@Transform trim 把纯空白 '   ' 转成空串再被
// @MinLength(1) 拦下（与 send-message.dto 的 content 校验同模式：ValidationPipe
// transform:true 下先转换后校验）；上限 100 字符（列表页关键词搜索的常规长度
// 限制，防超长输入拖慢 ILIKE 全表扫描）。缺失 → @IsString 对 undefined 判 400。
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../../../common/pagination.js';

export class HistorySearchDto extends PaginationDto {
  @IsString({ message: '关键词必须是字符串' })
  @MinLength(1, { message: '关键词不能为空' })
  @MaxLength(100, { message: '关键词最长 100 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  keyword: string;
}

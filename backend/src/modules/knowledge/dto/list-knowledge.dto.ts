// 文档列表查询参数：分页（继承 PaginationDto）+ 筛选（type/status 精确匹配、
// keyword 对 title 的 ILIKE 模糊匹配、folderId 文件夹、tagIds 标签并集）。
// 非法枚举值启动即 400（枚举白名单收口）。
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/pagination.js';

export class ListKnowledgeDto extends PaginationDto {
  @IsOptional()
  @IsIn(['file', 'url', 'manual'], { message: 'type 只能是 file/url/manual' })
  type?: string;

  @IsOptional()
  @IsIn(['pending', 'parsing', 'ready', 'failed'], {
    message: 'status 只能是 pending/parsing/ready/failed',
  })
  status?: string;

  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(100, { message: 'keyword 最长 100 个字符' })
  keyword?: string;

  /** 标签筛选（Task 1.3）：逗号分隔的 tagIds 字符串（并集语义，见 list 注释） */
  @IsOptional()
  @IsString({ message: 'tagIds 必须是字符串（逗号分隔）' })
  @MaxLength(2000, { message: 'tagIds 过长' })
  tagIds?: string;

  /** 文件夹筛选（Task 1.3）：精确匹配 folderId，folder 必须属于该 KB（404） */
  @IsOptional()
  @IsUUID('4', { message: 'folderId 必须是合法 UUID' })
  folderId?: string;
}

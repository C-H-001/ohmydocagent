// 知识库列表查询参数（Task 1.10）：在 PaginationDto（page/pageSize）之上增加
// view 视图筛选——all（全部，默认）/ mine（我创建的）/ favorite（我收藏的）/
// recent（我最近访问的）。非法值由 @IsEnum 拦成 400（ValidationPipe whitelist
// 只放行声明字段，未知查询参数被剥离）。
// 默认 'all'：view 缺省时与 Task 1.1 的列表语义一致（全部 + 置顶优先），
// 既有调用方（GET /kbs 不带 view）零改动兼容。
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/pagination.js';

/** view 合法取值（服务层与 DTO 共用同一枚举，避免两处字符串漂移） */
export const KB_VIEWS = ['all', 'mine', 'favorite', 'recent'] as const;
export type KbView = (typeof KB_VIEWS)[number];

export class ListKbDto extends PaginationDto {
  @IsOptional()
  @IsEnum(KB_VIEWS, { message: 'view 必须是 all|mine|favorite|recent 之一' })
  view: KbView = 'all';
}

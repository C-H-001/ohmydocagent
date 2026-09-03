// backend/src/common/pagination.ts
// 分页统一约定（计划 B 节）：?page=1&pageSize=20 → { items, total, page, pageSize }。
// PaginationDto：查询参数校验（page 从 1 起、pageSize 上限 100，经 ValidationPipe
// transform 把字符串转为数字）；paginate()：仓库层 findAndCount 助手，返回统一结构。
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { FindManyOptions, ObjectLiteral, Repository } from 'typeorm';

/** 分页查询参数 DTO：直接用于 @Query() 注入（ValidationPipe whitelist+transform 生效） */
export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 最小为 1' })
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 最小为 1' })
  @Max(100, { message: 'pageSize 最大为 100' })
  pageSize = 10;
}

/** 统一分页响应结构：items + total + 回显的 page/pageSize */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 分页查询助手：封装 findAndCount 的 skip/take 推导。
 * findOptions 仅透传排序/条件等（禁止再传 skip/take，由本函数接管）。
 */
export async function paginate<T extends ObjectLiteral>(
  repo: Repository<T>,
  page: number,
  pageSize: number,
  findOptions: Omit<FindManyOptions<T>, 'skip' | 'take'> = {},
): Promise<Paginated<T>> {
  const [rows, total] = await repo.findAndCount({
    ...findOptions,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { items: rows, total, page, pageSize };
}

// 历史统计查询参数（Task 2.11）：days 可选（缺省 30，范围 1..365）。
// 决策：统计窗口按消息 createdAt ≥ now - days 过滤（引用即 KB 使用证据，
// 口径见 chat-history.service.ts 文件头注释）；days 上限 365 防止一次统计
// 窗口过大（无界聚合拖慢 SQL；需要更长窗口时前端可分多次拉取）。
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class HistoryStatsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'days 必须是整数' })
  @Min(1, { message: 'days 最小为 1' })
  @Max(365, { message: 'days 最大为 365' })
  days = 30;
}

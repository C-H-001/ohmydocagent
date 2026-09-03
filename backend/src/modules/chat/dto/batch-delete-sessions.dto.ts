// 批量删除会话请求体：ids 会话 id 数组（1~100 个）。
// 决策：@IsUUID('4', { each: true }) 严格校验——非法 UUID 直接 400（与既有
// BatchIdsDto 同模式：不合法 id 若透传给 PG uuid IN 子查询会撞 22P02 → 500，
// DTO 层拦截为友好 400）。上限 100（防超大数组拖垮事务）。
// 跨用户宽容语义（只删本人的、跳过他人 id）在服务层完成，见 SessionService.removeBatch。
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class BatchDeleteSessionsDto {
  @IsArray({ message: 'ids 必须是数组' })
  @ArrayMinSize(1, { message: 'ids 至少 1 个' })
  @ArrayMaxSize(100, { message: 'ids 最多 100 个' })
  @IsUUID('4', { each: true, message: 'ids 每项必须是合法 UUID' })
  ids: string[];
}

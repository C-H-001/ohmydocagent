// 分块回滚请求体（Task 1.9）：revision 必填（目标版本号）。
// 校验语义：@IsInt（整数）+ @Min(0)（0 表示原始版本——目标内容 =
// chunk.sourceContent，无对应历史行，见 ChunkService.revert 与
// chunk-revision.entity.ts 注释；版本历史行从 1 起，正数对应历史行）。
// 目标版本「不存在」的 404 语义在服务层（revision ≥ 0 但超出历史范围），
// 与 DTO 的 400 分工：格式错 400（含负数/非整数）、值域内但无此版本 404
// （读设计，见 ChunkService.revert 注释）。
import { IsInt, Min } from 'class-validator';

export class RevertChunkDto {
  @IsInt({ message: 'revision 必须是整数' })
  @Min(0, { message: 'revision 最小为 0（0 = 回滚到原始版本）' })
  revision: number;
}

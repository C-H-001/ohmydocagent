// 批量移动文件夹请求体（Task 1.8）：ids 文档数组 + folderId 目标文件夹。
// 决策：folderId 必填（@IsDefined——移动语义必须有明确目标），null = 移回根
// （folderId 列 nullable，与单条 update 的 folderId=null 语义一致——批量接口
// 支持 null，避免前端「全选移回根」要多调 N 次单条接口）。
// 注意 @IsDefined 的副作用：属性带 @IsDefined 后 class-validator 会对 null/
// undefined 也执行其它校验器（isUUID(null)=false → 400），故 @IsUUID 需用
// @ValidateIf 在 null 时跳过（null 合法 = 移回根；undefined 仍被 @IsDefined 拒绝）。
// folderId 属于其它 KB 在服务层校验 → 404（严格，见 batchMove 注释）。
import { IsDefined, IsUUID, ValidateIf } from 'class-validator';
import { BatchIdsDto } from './batch-ids.dto.js';

export class BatchMoveDto extends BatchIdsDto {
  @IsDefined({ message: 'folderId 必填（null = 移回根）' })
  @ValidateIf((o) => o.folderId !== null)
  @IsUUID('4', { message: 'folderId 必须是合法 UUID' })
  folderId: string | null;
}

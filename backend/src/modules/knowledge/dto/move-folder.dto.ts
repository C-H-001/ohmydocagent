// 移动文件夹请求体：parentId 目标父级 id，null/缺省 = 移回根级。
// 决策：null 与缺省都按「移到根」处理——前端拖拽到根区域可能只发空对象，
// 服务层统一 newParentId = dto.parentId ?? null（幂等友好）。
// 环检测（移动到自身/子孙 → 400）在服务层完成，见 moveFolder 注释。
import { IsOptional, IsUUID } from 'class-validator';

export class MoveFolderDto {
  @IsOptional()
  @IsUUID('4', { message: 'parentId 必须是合法 UUID' })
  parentId?: string | null;
}

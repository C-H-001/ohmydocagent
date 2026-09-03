// 实体详情查询参数（Task 3.3）：kbId 必填——实体按 kbId+name 复合唯一
// （见 graph.types.ts / initSchema 约束），无 kbId 无法定位实体。
// 缺失/非 UUID → 400（ValidationPipe；KB 存在性校验在服务层 → 404）。
import { IsUUID } from 'class-validator';

export class EntityDetailQueryDto {
  @IsUUID('4', { message: 'kbId 必须是合法 UUID' })
  kbId: string;
}

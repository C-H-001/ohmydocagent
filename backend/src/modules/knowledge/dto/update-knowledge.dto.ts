// 更新文档请求体：全部字段可选（语义为「只更新传入的字段」，服务层按 undefined
// 判定跳过）。本任务支持标题更新（重命名）与文件夹归属更新（folderId，Task 1.3）；
// 正文/来源等更新在后续任务按需扩展。
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateKnowledgeDto {
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @IsNotEmpty({ message: '标题不能为空' })
  // 与 CreateManualDto 同步：纯空白标题同样 400
  @Matches(/\S/, { message: '标题不能为空白' })
  @MaxLength(200, { message: '标题最长 200 个字符' })
  title?: string;

  /** 文件夹归属（Task 1.3）：null = 移回根（folderId 列 nullable）；
   * @IsOptional 跳过 null 校验（null 合法），非空值必须是合法 UUID */
  @IsOptional()
  @IsUUID('4', { message: 'folderId 必须是合法 UUID' })
  folderId?: string | null;
}

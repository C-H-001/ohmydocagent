// 重命名文件夹请求体：name 必填（PUT 全量语义——当前仅支持名称更新）。
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateFolderDto {
  @IsString({ message: '文件夹名称必须是字符串' })
  @IsNotEmpty({ message: '文件夹名称不能为空' })
  @Matches(/\S/, { message: '文件夹名称不能为空白' })
  @MaxLength(100, { message: '文件夹名称最长 100 个字符' })
  name: string;
}

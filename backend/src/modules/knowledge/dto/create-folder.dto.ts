// 新建文件夹请求体：name 必填（非空白，最长 100），parentId 可选（缺省=根级）。
// 同级同名由服务层查重（409，见 KnowledgeService.ensureFolderNameUnique）。
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateFolderDto {
  @IsString({ message: '文件夹名称必须是字符串' })
  @IsNotEmpty({ message: '文件夹名称不能为空' })
  @Matches(/\S/, { message: '文件夹名称不能为空白' })
  @MaxLength(100, { message: '文件夹名称最长 100 个字符' })
  name: string;

  @IsOptional()
  @IsUUID('4', { message: 'parentId 必须是合法 UUID' })
  parentId?: string;
}

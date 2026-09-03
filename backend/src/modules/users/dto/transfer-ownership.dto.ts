// backend/src/modules/users/dto/transfer-ownership.dto.ts
// 所有权转移请求体：目标用户 id（仅 Owner 可调用，见 RolesGuard + UsersService）。
import { IsUUID } from 'class-validator';

export class TransferOwnershipDto {
  @IsUUID('all', { message: '目标用户 id 必须是合法的 UUID' })
  targetUserId!: string;
}

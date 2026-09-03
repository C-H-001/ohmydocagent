// backend/src/modules/users/dto/update-role.dto.ts
// 角色调整请求体：目标角色（owner/admin 二选一）。
// 唯一 Owner 不变量（系统恒有且仅有一个 Owner）由服务层判定（见 UsersService.updateRole）：
// 破坏不变量的角色变更（提升出第二个 Owner / 降级掉唯一 Owner）一律 400。
import { IsEnum } from 'class-validator';
import { Role } from '../user.entity.js';

export class UpdateRoleDto {
  @IsEnum(Role, { message: '角色只能是 owner 或 admin' })
  role!: Role;
}

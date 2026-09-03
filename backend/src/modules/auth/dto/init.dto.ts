// backend/src/modules/auth/dto/init.dto.ts
// 首次部署初始化请求体：与 RegisterDto 同构（email/password/name），
// 直接继承复用其校验规则，避免逐字节重复维护两套装饰器。
// 后续若初始化需要独立字段（如公司名/邀请码等），再拆开单独定义，
// 避免影响公开注册接口的演化。
import { RegisterDto } from './register.dto.js';

export class InitDto extends RegisterDto {}

// KB 访问守卫（Task 4.2）：全局挂载（AppModule APP_GUARD，与 RolesGuard 同模式，
// 见 app.module.ts 注册顺序注释），仅对声明了 @RequireKbPermission 的端点生效：
// 未声明自动放行。判定走 KbAccessService.assertCan——分级语义：无访问权
// （KB 不存在/非成员）统一 404（资源隐藏），有访问权但档位不足（view 写 /
// edit 删库管共享）403（见 kb-access.service.ts assertCan 注释）。
// kbId 解析（resolveKbId）支持四种形态：
//   - params.kbId：kbs/:kbId/...（knowledge/chunk 列表等）
//   - params.id：kbs/:id（KB 详情/更新/删除、kbs/:id/shares 共享管理）
//   - query.kbId：graphs/entities/:name?kbId=...（图谱实体详情，P5 挂载点预留）
//   - params.chunkId：chunks/:chunkId（分块编辑/回滚/版本历史——分块路由无
//     kbId 路径参数，先按 chunk 行反查 kbId，见 chunk.controller.ts 注释）
// 执行顺序：JwtAuthGuard（挂 user）→ RolesGuard → KbAccessGuard（本守卫），
// 保证运行时 request.user 已由 JwtStrategy 填充。
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chunk } from '../chunk/chunk.entity.js';
import { User } from '../users/user.entity.js';
import { KbAccessService, KbPermission } from './kb-access.service.js';
import { KB_PERMISSION_KEY } from './kb-permission.decorator.js';

@Injectable()
export class KbAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly kbAccessService: KbAccessService,
    // 分块路由（chunks/:chunkId）无 kbId 路径参数，需按 chunk 行反查
    @InjectRepository(Chunk)
    private readonly chunkRepository: Repository<Chunk>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // handler 优先，其次类级：取 @RequireKbPermission 声明的档位
    const required = this.reflector.getAllAndOverride<KbPermission>(
      KB_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      // 未声明：无 KB 权限要求（全局 JwtAuthGuard 已保证登录），放行
      return true;
    }
    const req = context.switchToHttp().getRequest();
    const user = req.user as User;
    if (!user) {
      // 理论不可达（JwtAuthGuard 先执行），防御性兜底
      throw new UnauthorizedException('未登录');
    }
    const kbId = await this.resolveKbId(req);
    if (!kbId) {
      // 无 kbId 可解析：视为无权访问的资源（统一 404 隐藏，不泄露路由形态）
      throw new NotFoundException('知识库不存在或无权访问');
    }
    await this.kbAccessService.assertCan(user, kbId, required);
    return true;
  }

  /** 从请求解析 kbId：路径参数 kbId/id、query kbId、或 chunkId 反查（见文件头） */
  private async resolveKbId(req: any): Promise<string | null> {
    const { params, query } = req;
    if (params?.kbId) return params.kbId;
    if (params?.id) return params.id;
    if (query?.kbId) return query.kbId;
    if (params?.chunkId) {
      try {
        const chunk = await this.chunkRepository.findOne({
          where: { id: params.chunkId },
          select: { kbId: true },
        });
        return chunk?.kbId ?? null;
      } catch (err) {
        // 非 UUID 格式 chunkId 撞 PG 22P02：视为无此资源 → null（统一 404）
        if (
          (err as { driverError?: { code?: string } })?.driverError?.code ===
          '22P02'
        ) {
          return null;
        }
        throw err;
      }
    }
    return null;
  }
}

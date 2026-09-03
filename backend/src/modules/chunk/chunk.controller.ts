// 分块路由（Task 1.5 + Task 1.9）：全部需登录（全局 JwtAuthGuard 默认拦截）。
// - 列表：GET /kbs/:kbId/knowledge/:kid/chunks（kbId/kid 双重限定防跨 KB 越权
//   读取，404 语义在 ChunkService.listChunks）
// - 编辑/版本历史/回滚（Task 1.9）：顶层路由——PUT /chunks/:chunkId、
//   GET /chunks/:chunkId/revisions、POST /chunks/:chunkId/revert。
//   路由形态决策（见任务书）：kbId 由 chunk 行反查（chunk 属于哪个 KB 由行内
//   kbId 决定），无需 kbId/kid 双重限定；越权防护：Task 4.2 已挂载全局
//   KbAccessGuard（见 kb-access.guard.ts 的 chunkId 反查分支——无 kbId 路径
//   参数，先按 chunk.id 读 chunk 行取 kbId 再交由 KbAccessService 判定）。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { RequireKbPermission } from '../kb-share/kb-permission.decorator.js';
import { ListChunkDto } from './dto/list-chunk.dto.js';
import { UpdateChunkDto } from './dto/update-chunk.dto.js';
import { RevertChunkDto } from './dto/revert-chunk.dto.js';
import { ChunkService } from './chunk.service.js';

@Controller()
export class ChunkController {
  constructor(private readonly chunkService: ChunkService) {}

  /** 分块列表：按 chunkIndex 升序 + 分页（含 pre/next 链表字段）。
   * Task 4.2：view 权限可读 */
  @RequireKbPermission('view')
  @Get('kbs/:kbId/knowledge/:kid/chunks')
  list(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
    @Query() query: ListChunkDto,
  ) {
    return this.chunkService.listChunks(kbId, kid, query.page, query.pageSize);
  }

  /** 编辑分块内容（Task 1.9）：content 更新 + contentRevision 自增 +
   * indexStatus=processing（触发单块重新向量化）；editorId = 当前登录用户。
   * Task 4.2：edit 权限可写（KbAccessGuard 经 chunk 行反查 kbId） */
  @RequireKbPermission('edit')
  @Put('chunks/:chunkId')
  updateContent(
    @Param('chunkId') chunkId: string,
    @Body() dto: UpdateChunkDto,
    @CurrentUser() user: User,
  ) {
    return this.chunkService.updateContent(chunkId, dto.content, user.id);
  }

  /** 版本历史（Task 1.9）：revision 升序全量返回（含 content/editorId/createdAt）。
   * Task 4.2：view 权限可读 */
  @RequireKbPermission('view')
  @Get('chunks/:chunkId/revisions')
  listRevisions(@Param('chunkId') chunkId: string) {
    return this.chunkService.listRevisions(chunkId);
  }

  /** 回滚到指定版本（Task 1.9）：追加式新版本（body: { revision }）。
   * @HttpCode(200)：同步返回更新后的 chunk（非创建语义，POST 默认 201 不合）。
   * Task 4.2：edit 权限可写 */
  @RequireKbPermission('edit')
  @Post('chunks/:chunkId/revert')
  @HttpCode(200)
  revert(
    @Param('chunkId') chunkId: string,
    @Body() dto: RevertChunkDto,
    @CurrentUser() user: User,
  ) {
    return this.chunkService.revert(chunkId, dto.revision, user.id);
  }
}

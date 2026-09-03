// 知识文档路由（Task 1.2 + Task 1.3，全部需登录——全局 JwtAuthGuard 默认拦截）：
// 创建：POST /kbs/:kbId/file（multipart 上传）、POST /kbs/:kbId/url、POST /kbs/:kbId/manual
// 列表/详情/更新/删除：GET/PUT/DELETE /kbs/:kbId/knowledge[/:kid]
// 文件夹（Task 1.3）：POST/GET /kbs/:kbId/folders、PUT /kbs/:kbId/folders/:folderId、
//   PUT /kbs/:kbId/folders/:folderId/move、DELETE /kbs/:kbId/folders/:folderId
// 标签（Task 1.3）：POST/GET /kbs/:kbId/tags、PUT/DELETE /kbs/:kbId/tags/:tagId、
//   PUT /kbs/:kbId/knowledge/:kid/tags（批量打标/去标）
// 状态/摘要/重新解析（Task 1.7）：GET /kbs/:kbId/knowledge/:kid/stages（解析
//   时间线）、POST /kbs/:kbId/knowledge/:kid/regenerate-summary（重新生成摘要）、
//   POST /kbs/:kbId/knowledge/:kid/reparse（重新解析）——后两者 202 Accepted
//   （异步任务入队成功，前端轮询 stages/status/summary 更新）
// 批量操作（Task 1.8）：POST /kbs/:kbId/knowledge/batch-delete（批量删除）、
//   POST /kbs/:kbId/knowledge/batch-reparse（批量重新解析，202）、
//   PUT /kbs/:kbId/knowledge/batch-tags（批量打标/去标）、
//   POST /kbs/:kbId/knowledge/batch-move（批量移动文件夹）——批量路由必须注册
//   在 knowledge/:kid 之前（Express 按注册顺序匹配，否则 PUT batch-tags 会被
//   :kid='batch-tags' 吞掉）
// 上传用 FileInterceptor + 内存存储（multer 默认即 memoryStorage，文件不大——
// P1 限 50MB，超限由 multer 抛 PayloadTooLargeException（413））
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RequireKbPermission } from '../kb-share/kb-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { StorageService, UploadedFileLike } from '../storage/storage.service.js';
import { CreateManualDto } from './dto/create-manual.dto.js';
import { CreateFolderDto } from './dto/create-folder.dto.js';
import { CreateTagDto } from './dto/create-tag.dto.js';
import { BatchIdsDto } from './dto/batch-ids.dto.js';
import { BatchMoveDto } from './dto/batch-move.dto.js';
import { BatchSetTagsDto } from './dto/batch-set-tags.dto.js';
import { ListKnowledgeDto } from './dto/list-knowledge.dto.js';
import { MoveFolderDto } from './dto/move-folder.dto.js';
import { SetKnowledgeTagsDto } from './dto/set-knowledge-tags.dto.js';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto.js';
import { UpdateFolderDto } from './dto/update-folder.dto.js';
import { UpdateTagDto } from './dto/update-tag.dto.js';
import { MAX_UPLOAD_BYTES, KnowledgeService } from './knowledge.service.js';

// Task 4.2 权限挂载：类级 @RequireKbPermission('view') 作只读兜底（文档/分块/
// 图谱/检索相关读接口全部 view 起步），写接口在 handler 上覆盖为 edit——
// 全局 KbAccessGuard 按 getAllAndOverride(handler, class) 取 handler 优先，
// 与 RolesGuard 同模式。权限语义：view 可读（详情/列表/图谱），edit 可上传/
// 编辑分块/重解析，见 kb-access.service.ts 文件头注释。
@RequireKbPermission('view')
@Controller('kbs/:kbId')
export class KnowledgeController {
  constructor(
    private readonly knowledgeService: KnowledgeService,
    // 原文件读取（PDF 原文预览：view 权限 + 流式返回）
    private readonly storageService: StorageService,
  ) {}

  /** 上传文件创建文档：201 返回完整实体（type=file, status=pending） */
  @RequireKbPermission('edit')
  @Post('file')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      // 内存存储：multer 默认即 memoryStorage（不显式 import 'multer' 的
      // memoryStorage——该包未自带类型，默认行为一致且省去类型 shim）
      limits: { fileSize: MAX_UPLOAD_BYTES }, // 超限抛 413（PayloadTooLargeException）
    }),
  )
  uploadFile(
    @Param('kbId') kbId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: User,
    // 文档级分块配置（multipart 文本字段，JSON 字符串——覆盖 KB 级配置；
    // 缺省跟随 KB，见 parse.processor 注释）
    @Body() body: Record<string, unknown>,
  ) {
    return this.knowledgeService.createFromFile(
      kbId,
      file,
      user.id,
      typeof body?.chunkingConfig === 'string' ? body.chunkingConfig : '',
      typeof body?.parserEngine === 'string' ? body.parserEngine : '',
    );
  }

  /** 手动创建文档：201，type=manual */
  @RequireKbPermission('edit')
  @Post('manual')
  @HttpCode(201)
  createManual(
    @Param('kbId') kbId: string,
    @Body() dto: CreateManualDto,
    @CurrentUser() user: User,
  ) {
    return this.knowledgeService.createManual(kbId, dto, user.id);
  }

  /** 分页列表：type/status/keyword 筛选，默认 createdAt DESC */
  @Get('knowledge')
  list(@Param('kbId') kbId: string, @Query() query: ListKnowledgeDto) {
    return this.knowledgeService.list(kbId, query);
  }

  // ==================== 批量操作（Task 1.8） ====================
  // 注意：批量路由必须注册在 knowledge/:kid 之前（Express 按注册顺序匹配，
  // 否则 PUT knowledge/batch-tags 会被 :kid='batch-tags' 吞掉）

  /** 批量删除（宽容跳过跨 KB id）：200 返回 { deleted } */
  @RequireKbPermission('edit')
  @Post('knowledge/batch-delete')
  @HttpCode(200)
  batchDelete(
    @Param('kbId') kbId: string,
    @Body() dto: BatchIdsDto,
  ): Promise<{ deleted: number }> {
    return this.knowledgeService.batchDelete(kbId, dto.ids);
  }

  /** 批量重新解析（宽容跳过处理中/跨 KB id）：202 返回 { queued, skipped, failed }。
   * queued = 已重置（队列投递 best-effort，与单条 reparse 一致——入队失败仅记
   * 日志不阻断，见 enqueueParse 注释）；failed = 重置/入队阶段抛错的条数
   * （部分失败语义：前 k-1 条已应用不整批 500，客户端按计数提示可重试，操作幂等） */
  @RequireKbPermission('edit')
  @Post('knowledge/batch-reparse')
  @HttpCode(202)
  batchReparse(
    @Param('kbId') kbId: string,
    @Body() dto: BatchIdsDto,
  ): Promise<{ queued: number; skipped: number; failed: number }> {
    return this.knowledgeService.batchReparse(kbId, dto.ids);
  }

  /** 批量打标/去标（tagIds 空数组 = 批量去标）：200 返回 { updated, failed }
   * （failed = 打标抛错的条数，部分失败可重试——操作幂等） */
  @RequireKbPermission('edit')
  @Put('knowledge/batch-tags')
  batchSetTags(
    @Param('kbId') kbId: string,
    @Body() dto: BatchSetTagsDto,
  ): Promise<{ updated: number; failed: number }> {
    return this.knowledgeService.batchSetTags(kbId, dto.ids, dto.tagIds);
  }

  /** 批量移动文件夹（folderId 必填，null = 移回根）：200 返回 { moved } */
  @RequireKbPermission('edit')
  @Post('knowledge/batch-move')
  @HttpCode(200)
  batchMove(
    @Param('kbId') kbId: string,
    @Body() dto: BatchMoveDto,
  ): Promise<{ moved: number }> {
    return this.knowledgeService.batchMove(kbId, dto.ids, dto.folderId);
  }

  /** 详情 */
  @Get('knowledge/:kid')
  getById(@Param('kbId') kbId: string, @Param('kid') kid: string) {
    return this.knowledgeService.getById(kbId, kid);
  }

  /** 原文件下载/预览（view 权限；PDF 等二进制供前端原文展示，流式返回）。
   *   Content-Type 按扩展名；不存在/非文件类型 404 */
  @Get('knowledge/:kid/file')
  async downloadFile(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
    @Res() res: Response,
  ) {
    const doc = await this.knowledgeService.getById(kbId, kid);
    if (doc.type !== 'file' || !doc.filePath) {
      throw new NotFoundException('文档不是文件类型');
    }
    const stream = await this.storageService.createReadStream(doc.filePath);
    const ext = doc.filePath.split('.').pop()?.toLowerCase() ?? '';
    const mime =
      { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' }[ext] ??
      'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(doc.title || 'file')}.${ext}"`,
    );
    stream.pipe(res);
  }

  /** 更新（本任务仅标题重命名） */
  @RequireKbPermission('edit')
  @Put('knowledge/:kid')
  update(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.knowledgeService.update(kbId, kid, dto);
  }

  /** 删除（硬删除，含磁盘文件清理）：204 无响应体 */
  @RequireKbPermission('edit')
  @Delete('knowledge/:kid')
  @HttpCode(204)
  async remove(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
  ): Promise<void> {
    await this.knowledgeService.remove(kbId, kid);
  }

  /** 解析时间线（Task 1.7）：parserStages 各阶段（extract→chunk→embed→summary）
   * + 状态摘要（status/chunkCount/summary/updatedAt——summary 字段使前端无需
   * 再单独查详情即可渲染当前摘要）；文档不存在 → 404 */
  @Get('knowledge/:kid/stages')
  getStages(@Param('kbId') kbId: string, @Param('kid') kid: string) {
    return this.knowledgeService.getStages(kbId, kid);
  }

  /** 重新生成摘要（Task 1.7）：202 Accepted——摘要异步重新生成（入队 SUMMARY），
   * 前端轮询 stages/summary 更新；文档不存在 → 404 */
  @RequireKbPermission('edit')
  @Post('knowledge/:kid/regenerate-summary')
  @HttpCode(202)
  async regenerateSummary(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
  ): Promise<{ queued: true }> {
    await this.knowledgeService.regenerateSummary(kbId, kid);
    return { queued: true };
  }

  /** 重新解析（Task 1.7）：202 Accepted——事务内清旧建新后入队 PARSE 异步完成；
   * 处理中（pending/parsing）→ 409 防并发双跑；文档不存在 → 404 */
  @RequireKbPermission('edit')
  @Post('knowledge/:kid/reparse')
  @HttpCode(202)
  async reparse(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
  ): Promise<{ queued: true }> {
    await this.knowledgeService.reparse(kbId, kid);
    return { queued: true };
  }

  /** 批量打标/去标（Task 1.3）：tagIds 数组全量替换（幂等），返回文档当前标签 */
  @RequireKbPermission('edit')
  @Put('knowledge/:kid/tags')
  setKnowledgeTags(
    @Param('kbId') kbId: string,
    @Param('kid') kid: string,
    @Body() dto: SetKnowledgeTagsDto,
  ) {
    return this.knowledgeService.setKnowledgeTags(kbId, kid, dto);
  }

  // ==================== 文件夹（Task 1.3） ====================

  /** 新建文件夹（根或指定 parentId 子级）：201 返回完整实体 */
  @RequireKbPermission('edit')
  @Post('folders')
  @HttpCode(201)
  createFolder(@Param('kbId') kbId: string, @Body() dto: CreateFolderDto) {
    return this.knowledgeService.createFolder(kbId, dto);
  }

  /** 文件夹树（children 嵌套，根级为顶层数组） */
  @Get('folders')
  listFolders(@Param('kbId') kbId: string) {
    return this.knowledgeService.listFolders(kbId);
  }

  /** 重命名文件夹 */
  @RequireKbPermission('edit')
  @Put('folders/:folderId')
  renameFolder(
    @Param('kbId') kbId: string,
    @Param('folderId') folderId: string,
    @Body() dto: UpdateFolderDto,
  ) {
    return this.knowledgeService.renameFolder(kbId, folderId, dto);
  }

  /** 移动文件夹到其他父级（parentId=null 移回根；环检测 400） */
  @RequireKbPermission('edit')
  @Put('folders/:folderId/move')
  moveFolder(
    @Param('kbId') kbId: string,
    @Param('folderId') folderId: string,
    @Body() dto: MoveFolderDto,
  ) {
    return this.knowledgeService.moveFolder(kbId, folderId, dto);
  }

  /** 删除文件夹（文档归根 + 级联删子树）：204 无响应体 */
  @RequireKbPermission('edit')
  @Delete('folders/:folderId')
  @HttpCode(204)
  async deleteFolder(
    @Param('kbId') kbId: string,
    @Param('folderId') folderId: string,
  ): Promise<void> {
    await this.knowledgeService.deleteFolder(kbId, folderId);
  }

  // ==================== 标签（Task 1.3） ====================

  /** 创建标签（name + color）：201 返回完整实体 */
  @RequireKbPermission('edit')
  @Post('tags')
  @HttpCode(201)
  createTag(@Param('kbId') kbId: string, @Body() dto: CreateTagDto) {
    return this.knowledgeService.createTag(kbId, dto);
  }

  /** 标签列表（创建顺序） */
  @Get('tags')
  listTags(@Param('kbId') kbId: string) {
    return this.knowledgeService.listTags(kbId);
  }

  /** 更新标签（名称/颜色） */
  @RequireKbPermission('edit')
  @Put('tags/:tagId')
  updateTag(
    @Param('kbId') kbId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.knowledgeService.updateTag(kbId, tagId, dto);
  }

  /** 删除标签（解除全部关联）：204 无响应体 */
  @RequireKbPermission('edit')
  @Delete('tags/:tagId')
  @HttpCode(204)
  async deleteTag(
    @Param('kbId') kbId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    await this.knowledgeService.deleteTag(kbId, tagId);
  }
}

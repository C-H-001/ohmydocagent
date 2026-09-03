// 模型管理路由（Task 2.3，全部需登录——全局 JwtAuthGuard 默认拦截）：
// - POST /models 新增（201）、GET /models 列表（?type= 筛选）、
//   GET /models/:id 详情、PUT /models/:id 更新（PATCH 语义）、
//   DELETE /models/:id 删除（204）
// - PUT /models/:id/default 设为默认（每 type 唯一默认）
// - POST /models/test 连通性测试（body 完整配置，不保存）、
//   POST /models/:id/test 已保存模型连通性测试、
//   POST /models/:id/debug 模型调试（固定测试消息返回生成文本）
// 权限（用户需求：模型管理归 super）：列表/详情所有登录用户可用（聊天模型
// 选择器依赖 GET /models），新增/更新/删除/默认/测试/调试仅 super（@Roles 标注）。
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
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role, User } from '../users/user.entity.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { CreateModelDto } from './dto/create-model.dto.js';
import { ListModelDto } from './dto/list-model.dto.js';
import { TestModelDto } from './dto/test-model.dto.js';
import { UpdateModelDto } from './dto/update-model.dto.js';
import { ModelService } from './model.service.js';

@Controller('models')
export class ModelController {
  constructor(private readonly modelService: ModelService) {}

  /** 新增模型（BYOK：创建「我的模型」；super 创建全局时传 userId=null） */
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateModelDto, @CurrentUser() user: User) {
    return this.modelService.create(dto, user.id);
  }

  /** 列表（BYOK：我的模型 + 全局默认（super 配置，兜底）） */
  @Get()
  list(@Query() query: ListModelDto, @CurrentUser() user: User) {
    return this.modelService.list(query.type, user.id, user.role);
  }

  /** 详情：脱敏视图；不存在/无权 404 */
  @Get(':id')
  getById(@Param('id') id: string, @CurrentUser() user: User) {
    return this.modelService.getById(id, user.id, user.role);
  }

  /** 更新（只更新传入字段；apiKey 语义见 UpdateModelDto 注释） */
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateModelDto, @CurrentUser() user: User) {
    return this.modelService.update(id, dto, user.id, user.role);
  }

  /** 删除（允许删默认模型：删除即该 type 无默认，见 ModelService 设计决策）：204 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() user: User): Promise<void> {
    await this.modelService.remove(id, user.id, user.role);
  }

  /** 设为默认：每 type 唯一（设置新默认时旧默认自动清除） */
  @Put(':id/default')
  setDefault(@Param('id') id: string, @CurrentUser() user: User) {
    return this.modelService.setDefault(id, user.id, user.role);
  }

  /**
   * 连通性测试（不保存）：body 完整连接配置直传供应商探活。
   * 201（POST 语义统一）返回 { ok: true } 或 { ok: false, error }。
   * 路由顺序：声明在 POST /models/:id/test 之前（同为 POST models 下，
   * 'test' 单段与 ':id/test' 两段不冲突，但保持可读顺序）
   */
  @Post('test')
  @HttpCode(201)
  testConnection(@Body() dto: TestModelDto) {
    return this.modelService.testConnection(dto);
  }

  /** 已保存模型连通性测试：解密 key 后探活（同上返回 { ok } | { ok, error }） */
  @Post(':id/test')
  @HttpCode(201)
  testSaved(@Param('id') id: string, @CurrentUser() user: User) {
    return this.modelService.testSavedModel(id, user.id, user.role);
  }

  /** 模型调试：固定测试消息 → 返回实际生成文本（{ output }） */
  @Post(':id/debug')
  @HttpCode(201)
  debug(@Param('id') id: string, @CurrentUser() user: User) {
    return this.modelService.debug(id, user.id, user.role);
  }
}

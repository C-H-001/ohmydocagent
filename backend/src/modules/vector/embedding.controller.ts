import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireKbPermission } from '../kb-share/kb-permission.decorator.js';
import { User } from '../users/user.entity.js';
import { EmbeddingBindingService } from './embedding-binding.service.js';

class RebuildEmbeddingDto {
  @IsUUID('4', { message: '请选择有效的向量模型' })
  modelId!: string;
}

@Controller('kbs/:kbId/embedding')
export class EmbeddingController {
  constructor(private readonly bindings: EmbeddingBindingService) {}

  @Get()
  @RequireKbPermission('view')
  state(@Param('kbId') kbId: string) {
    return this.bindings.getState(kbId);
  }

  @Post('rebuild')
  @RequireKbPermission('full')
  rebuild(
    @Param('kbId') kbId: string,
    @CurrentUser() user: User,
    @Body() dto: RebuildEmbeddingDto,
  ) {
    return this.bindings.startRebuild(kbId, user.id, dto.modelId);
  }

  @Post('activate')
  @RequireKbPermission('full')
  activate(@Param('kbId') kbId: string, @CurrentUser() user: User) {
    return this.bindings.activate(kbId, user.id);
  }

  @Post('rollback')
  @RequireKbPermission('full')
  rollback(@Param('kbId') kbId: string, @CurrentUser() user: User) {
    return this.bindings.rollback(kbId, user.id);
  }

  @Post('cancel')
  @RequireKbPermission('full')
  cancel(@Param('kbId') kbId: string, @CurrentUser() user: User) {
    return this.bindings.cancel(kbId, user.id);
  }
}

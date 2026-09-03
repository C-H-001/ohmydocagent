// 队列仪表盘模块（Task 4.3）：注册 QueueAdminService/Controller。
// 五条队列实例来源：各队列的单点注册/导出模块（ParseQueueModule/
// EmbedQueueModule/SummaryQueueModule/TitleQueueModule/GraphQueueModule）——
// 本模块只 import 复用，不做 registerQueue（避免同一队列双实例，见
// parse-queue.module.ts 注释）。
import { Module } from '@nestjs/common';
import { GraphQueueModule } from '../../graph/graph-queue.module.js';
import { EmbedQueueModule } from '../../parse/embed-queue.module.js';
import { ParseQueueModule } from '../../parse/parse-queue.module.js';
import { SummaryQueueModule } from '../../parse/summary-queue.module.js';
import { TitleQueueModule } from '../../chat/title-queue.module.js';
import { QueueAdminController } from './queue-admin.controller.js';
import { QueueAdminService } from './queue-admin.service.js';

@Module({
  imports: [
    ParseQueueModule,
    EmbedQueueModule,
    SummaryQueueModule,
    TitleQueueModule,
    GraphQueueModule,
  ],
  controllers: [QueueAdminController],
  providers: [QueueAdminService],
})
export class QueueModule {}

// 存储模块（Task 1.2）：本地磁盘存储服务，供 KnowledgeService（文档落盘/清理）
// 与 KbService（KB 删除级联的目录清理）消费；无控制器，纯服务出口
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

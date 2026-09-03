// backend/src/neo4j/neo4j.module.ts
// Neo4j 模块：提供 Neo4jService 供按需注入（全局不需要，使用方自行 import）
import { Module } from '@nestjs/common';
import { Neo4jService } from './neo4j.service.js';

@Module({
  providers: [Neo4jService],
  exports: [Neo4jService],
})
export class Neo4jModule {}

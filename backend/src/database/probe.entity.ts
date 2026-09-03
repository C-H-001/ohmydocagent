// backend/src/database/probe.entity.ts
// 最小探针实体：仅用于验证 TypeORM 连接与原生查询
import { Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('probe')
export class ProbeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
}

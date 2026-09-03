// 文件夹实体（Task 1.3）：parentId 自引用树，null=根级。
// 名称唯一性决策：同一 KB 同父级下名称唯一。PG 唯一索引对 NULL 不冲突
// （根级 parentId=null 的同名会漏网），故用两个部分唯一索引在 DB 层兜底并发：
// - 非根级：UNIQUE (kbId, parentId, name) WHERE "parentId" IS NOT NULL
// - 根级：  UNIQUE (kbId, name) WHERE "parentId" IS NULL
// 服务层仍先查重（409 友好错误，见 KnowledgeService.ensureFolderNameUnique），
// 部分唯一索引兜底并发（撞 23505 时捕获转 409，见 createFolder）。
// 注意：TypeORM @Index 的 where 选项原样拼进 CREATE INDEX ... WHERE（见
// PostgresQueryRunner.createIndexSql），where 子句必须用数据库列名——本项目未配置
// snake_case 命名策略，列名即 camelCase 属性名（如 "parentId"），需加引号，已实测生效。
// kbId/parentId 为普通 uuid 列（无外键），KB/文件夹级联删除由服务层事务承担。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('knowledge_folders')
// 查询索引（listFolders 按 kbId 全量取 + 内存组装树，此索引加速按 KB 查询）
@Index('idx_knowledge_folders_kb_parent', ['kbId', 'parentId'])
// 部分唯一索引 1：非根级同级同名唯一（parentId 非空）
@Index(
  'idx_knowledge_folders_kb_parent_name_unique',
  ['kbId', 'parentId', 'name'],
  { unique: true, where: '"parentId" IS NOT NULL' },
)
// 部分唯一索引 2：根级同名唯一（普通唯一索引对 NULL 不冲突，根级 parentId=null
// 的同名会漏网，必须单独用 WHERE "parentId" IS NULL 的部分索引兜底）
@Index('idx_knowledge_folders_kb_name_unique_root', ['kbId', 'name'], {
  unique: true,
  where: '"parentId" IS NULL',
})
export class KnowledgeFolder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属知识库 id（无外键，级联删除由服务层事务承担，见 KbService.remove 注释） */
  @Column({ type: 'uuid' })
  kbId: string;

  /** 父文件夹 id：null=根级（自引用树） */
  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  /** 文件夹名称（同一 KB 同父级下唯一，服务层查重 409） */
  @Column()
  name: string;

  /** 同级排序（前端拖拽排序用，本任务创建默认 0，后续任务按需更新） */
  @Column({ default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

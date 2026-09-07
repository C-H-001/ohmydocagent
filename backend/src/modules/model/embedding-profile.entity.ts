import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ModelProvider } from './model.entity.js';

/** 向量空间配置的不可变快照；凭据仅通过 modelId 从模型读取。 */
@Entity('embedding_profiles')
@Check(
  'chk_embedding_profiles_dimension',
  '"dimension" >= 1 AND "dimension" <= 4000',
)
@Index('idx_embedding_profiles_owner_fingerprint', ['ownerId', 'fingerprint'], {
  unique: true,
})
export class EmbeddingProfile {
  @PrimaryGeneratedColumn('uuid')
  readonly id: string;

  @Column({ type: 'uuid', update: false })
  readonly ownerId: string;

  @Column({ type: 'uuid', update: false })
  readonly modelId: string;

  @Column({ type: 'varchar', update: false })
  readonly provider: ModelProvider;

  @Column({ type: 'varchar', update: false })
  readonly baseUrl: string;

  @Column({ type: 'varchar', update: false })
  readonly modelName: string;

  @Column({ type: 'integer', update: false })
  readonly dimension: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb", update: false })
  readonly extraConfig: Record<string, unknown>;

  @Column({ type: 'varchar', update: false })
  readonly fingerprint: string;

  @CreateDateColumn({ type: 'timestamp', update: false })
  readonly createdAt: Date;
}

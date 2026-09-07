import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EmbeddingProfile } from '../model/embedding-profile.entity.js';
import { EmbeddingProfileService } from '../model/embedding-profile.service.js';
import { EmbeddingIndexService } from './embedding-index.service.js';

export type EmbeddingProfileSummary = Pick<
  EmbeddingProfile,
  'id' | 'modelId' | 'modelName' | 'dimension'
>;
export interface EmbeddingBindingState {
  active: EmbeddingProfileSummary | null;
  pending: EmbeddingProfileSummary | null;
  previous: EmbeddingProfileSummary | null;
  totalChunks: number;
  indexedChunks: number;
  pendingIndexedChunks: number;
  legacyChunks: number;
  error: string | null;
  status: 'unbound' | 'ready' | 'building' | 'failed';
}

interface BindingRow {
  id: string;
  creatorId: string;
  embeddingModelId: string | null;
  activeEmbeddingProfileId: string | null;
  pendingEmbeddingProfileId: string | null;
  previousEmbeddingProfileId: string | null;
}
interface Coverage {
  totalChunks: number;
  indexedChunks: number;
  pendingIndexedChunks: number;
  legacyChunks: number;
  unsettledKnowledge: number;
}
type Sql = Pick<DataSource, 'query'>;

// 只允许本服务自己生成的消息进入 HTTP 响应；依赖异常始终统一脱敏。
class BindingFault extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
  }
}

@Injectable()
export class EmbeddingBindingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly profiles: EmbeddingProfileService,
    private readonly index: EmbeddingIndexService,
  ) {}

  async getState(kbId: string): Promise<EmbeddingBindingState> {
    return this.safely(() =>
      this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        const kb = await this.readKb(manager, kbId);
        const loaded = await this.loadProfiles(kb);
        const byId = new Map(loaded.map((profile) => [profile.id, profile]));
        const active = byId.get(kb.activeEmbeddingProfileId ?? '') ?? null;
        const pending = byId.get(kb.pendingEmbeddingProfileId ?? '') ?? null;
        const previous = byId.get(kb.previousEmbeddingProfileId ?? '') ?? null;
        const counts = await this.coverage(manager, kbId, active, pending);
        const target = pending ?? active;
        const indexed = pending
          ? counts.pendingIndexedChunks
          : counts.indexedChunks;
        const indexReady = target
          ? await this.index.isReady(target.dimension)
          : false;
        const covered = indexed === counts.totalChunks;
        // 已恢复完整覆盖及可用索引时，不让旧失败任务永久污染状态。
        const failed =
          target && !(covered && indexReady)
            ? await this.hasCurrentFailure(manager, kbId, target)
            : false;
        const status: EmbeddingBindingState['status'] = !target
          ? 'unbound'
          : failed
            ? 'failed'
            : pending ||
                !covered ||
                !indexReady ||
                counts.unsettledKnowledge > 0
              ? 'building'
              : 'ready';
        return {
          active: this.summary(active),
          pending: this.summary(pending),
          previous: this.summary(previous),
          totalChunks: counts.totalChunks,
          indexedChunks: counts.indexedChunks,
          pendingIndexedChunks: counts.pendingIndexedChunks,
          legacyChunks: counts.legacyChunks,
          error: failed ? '向量构建失败，请检查模型配置后重试重建' : null,
          status,
        };
      }),
    );
  }

  async startRebuild(
    kbId: string,
    userId: string,
    modelId: string,
  ): Promise<EmbeddingBindingState> {
    return this.safely(async () => {
      const initial = await this.readKb(this.dataSource, kbId);
      this.assertOwner(initial, userId);
      const profile = await this.profiles.createProfile(
        modelId,
        initial.creatorId,
      );
      this.assertProfile(profile, initial.creatorId);
      await this.dataSource.transaction(async (manager) => {
        const kb = await this.readKb(manager, kbId, true);
        this.assertOwner(kb, userId);
        this.assertProfile(profile, kb.creatorId);
        if (
          kb.pendingEmbeddingProfileId &&
          kb.pendingEmbeddingProfileId !== profile.id
        ) {
          throw new BindingFault('已有其他向量配置正在重建，请先完成或取消');
        }
        if (kb.activeEmbeddingProfileId !== profile.id) {
          await manager.query(
            `UPDATE knowledge_bases SET "pendingEmbeddingProfileId"=$2 WHERE id=$1`,
            [kbId, profile.id],
          );
        }
        // 同一 KB 锁内检查活跃任务，重复点击不重复排队；failed/done 允许重试。
        await manager.query(
          `INSERT INTO embedding_jobs ("kbId", "profileId", "knowledgeId", status)
          SELECT $1, $2, NULL, 'pending'
          WHERE NOT EXISTS (SELECT 1 FROM embedding_jobs WHERE "kbId"=$1 AND "profileId"=$2
            AND "knowledgeId" IS NULL AND "chunkId" IS NULL AND status IN ('pending','running'))`,
          [kbId, profile.id],
        );
      });
      return this.getState(kbId);
    });
  }

  async activate(kbId: string, userId: string): Promise<EmbeddingBindingState> {
    return this.safely(async () => {
      await this.dataSource.transaction(async (manager) => {
        const kb = await this.readKb(manager, kbId, true);
        this.assertOwner(kb, userId);
        if (!kb.pendingEmbeddingProfileId)
          throw new BindingFault('没有待启用的向量配置');
        const profile = await this.profiles.getProfile(
          kb.pendingEmbeddingProfileId,
        );
        this.assertProfile(profile, kb.creatorId);
        await this.assertSwitchable(manager, kbId, profile);
        await manager.query(
          `UPDATE knowledge_bases SET "previousEmbeddingProfileId"="activeEmbeddingProfileId",
          "activeEmbeddingProfileId"=$2, "pendingEmbeddingProfileId"=NULL, "embeddingModelId"=$3
          WHERE id=$1`,
          [kbId, profile.id, profile.modelId],
        );
        await this.restoreChunkReadiness(manager, kbId, profile);
      });
      return this.getState(kbId);
    });
  }

  async rollback(kbId: string, userId: string): Promise<EmbeddingBindingState> {
    return this.safely(async () => {
      await this.dataSource.transaction(async (manager) => {
        const kb = await this.readKb(manager, kbId, true);
        this.assertOwner(kb, userId);
        if (kb.pendingEmbeddingProfileId)
          throw new BindingFault('重建期间不能回滚，请先完成或取消');
        if (!kb.previousEmbeddingProfileId)
          throw new BindingFault('没有可回滚的向量配置');
        const profile = await this.profiles.getProfile(
          kb.previousEmbeddingProfileId,
        );
        this.assertProfile(profile, kb.creatorId);
        await this.assertSwitchable(manager, kbId, profile);
        await manager.query(
          `UPDATE knowledge_bases SET "previousEmbeddingProfileId"="activeEmbeddingProfileId",
          "activeEmbeddingProfileId"=$2, "embeddingModelId"=$3 WHERE id=$1`,
          [kbId, profile.id, profile.modelId],
        );
        await this.restoreChunkReadiness(manager, kbId, profile);
      });
      return this.getState(kbId);
    });
  }

  async cancel(kbId: string, userId: string): Promise<EmbeddingBindingState> {
    return this.safely(async () => {
      await this.dataSource.transaction(async (manager) => {
        const kb = await this.readKb(manager, kbId, true);
        this.assertOwner(kb, userId);
        if (!kb.pendingEmbeddingProfileId) return;
        await manager.query(
          `UPDATE knowledge_bases SET "pendingEmbeddingProfileId"=NULL WHERE id=$1`,
          [kbId],
        );
        await manager.query(
          `UPDATE embedding_jobs SET status='done', error=NULL, "updatedAt"=now()
          WHERE "kbId"=$1 AND "profileId"=$2 AND status IN ('pending','running','failed')`,
          [kbId, kb.pendingEmbeddingProfileId],
        );
      });
      return this.getState(kbId);
    });
  }

  async ensureWritableProfiles(kbId: string): Promise<EmbeddingProfile[]> {
    return this.safely(async () => {
      const initial = await this.readKb(this.dataSource, kbId);
      if (this.profileIds(initial).length) return this.loadProfiles(initial);
      await this.assertNoLegacy(this.dataSource, kbId);
      let modelId = initial.embeddingModelId;
      if (!modelId) {
        const rows = await this.dataSource.query<{ id: string }[]>(
          `SELECT id FROM models
          WHERE "userId"=$1 AND enabled=true AND type='embedding' AND "isDefault"=true
          ORDER BY "createdAt", id LIMIT 1`,
          [initial.creatorId],
        );
        modelId = rows[0]?.id ?? null;
      }
      if (!modelId)
        throw new BindingFault(
          '知识库创建者尚未配置私有默认向量模型，请显式选择模型重建',
        );
      // createProfile 校验指定模型属于 KB owner、enabled、embedding；不走全局默认。
      const candidate = await this.profiles.createProfile(
        modelId,
        initial.creatorId,
      );
      this.assertProfile(candidate, initial.creatorId);
      return this.dataSource.transaction(async (manager) => {
        const current = await this.readKb(manager, kbId, true);
        if (this.profileIds(current).length) return this.loadProfiles(current);
        await this.assertNoLegacy(manager, kbId);
        if (
          current.creatorId !== initial.creatorId ||
          current.embeddingModelId !== initial.embeddingModelId
        ) {
          throw new BindingFault('知识库模型配置已变更，请重试');
        }
        this.assertProfile(candidate, current.creatorId);
        await manager.query(
          `UPDATE knowledge_bases SET "activeEmbeddingProfileId"=$2, "embeddingModelId"=$3
          WHERE id=$1`,
          [kbId, candidate.id, candidate.modelId],
        );
        return [candidate];
      });
    });
  }

  private async readKb(
    sql: Sql,
    kbId: string,
    lock = false,
  ): Promise<BindingRow> {
    const rows = await sql.query<BindingRow[]>(
      `SELECT id, "creatorId", "embeddingModelId",
      "activeEmbeddingProfileId", "pendingEmbeddingProfileId", "previousEmbeddingProfileId"
      FROM knowledge_bases WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [kbId],
    );
    if (!rows[0]) throw new BindingFault('知识库不存在', 404);
    return rows[0];
  }

  private assertOwner(kb: BindingRow, userId: string): void {
    if (!userId || kb.creatorId !== userId)
      throw new BindingFault('仅知识库创建者可以修改向量绑定', 403);
  }

  private assertProfile(profile: EmbeddingProfile, ownerId: string): void {
    if (!profile || !ownerId || profile.ownerId !== ownerId)
      throw new BindingFault('向量配置不属于知识库创建者');
  }

  private profileIds(kb: BindingRow): string[] {
    return [
      ...new Set(
        [
          kb.activeEmbeddingProfileId,
          kb.pendingEmbeddingProfileId,
          kb.previousEmbeddingProfileId,
        ].filter((id): id is string => !!id),
      ),
    ];
  }

  private async loadProfiles(kb: BindingRow): Promise<EmbeddingProfile[]> {
    return Promise.all(
      this.profileIds(kb).map(async (id) => {
        const profile = await this.profiles.getProfile(id);
        this.assertProfile(profile, kb.creatorId);
        return profile;
      }),
    );
  }

  private summary(
    profile: EmbeddingProfile | null,
  ): EmbeddingProfileSummary | null {
    if (!profile) return null;
    const { id, modelId, modelName, dimension } = profile;
    return { id, modelId, modelName, dimension };
  }

  private async coverage(
    sql: Sql,
    kbId: string,
    active: EmbeddingProfile | null,
    pending: EmbeddingProfile | null,
  ): Promise<Coverage> {
    const rows = await sql.query<Coverage[]>(
      `SELECT count(*)::int AS "totalChunks",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=c.id
        AND e."kbId"=c."kbId" AND e."profileId"=$2 AND e.dimension=$3
        AND e."contentRevision"=c."contentRevision" AND e.embedding IS NOT NULL))::int AS "indexedChunks",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=c.id
        AND e."kbId"=c."kbId" AND e."profileId"=$4 AND e.dimension=$5
        AND e."contentRevision"=c."contentRevision" AND e.embedding IS NOT NULL))::int AS "pendingIndexedChunks",
      count(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS "legacyChunks",
      (SELECT count(*)::int FROM knowledge WHERE "kbId"=$1 AND status IN ('pending','parsing')) AS "unsettledKnowledge"
      FROM chunks c WHERE c."kbId"=$1`,
      [
        kbId,
        active?.id ?? null,
        active?.dimension ?? null,
        pending?.id ?? null,
        pending?.dimension ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new BindingFault('无法读取知识库向量覆盖情况');
    return {
      totalChunks: Number(row.totalChunks),
      indexedChunks: Number(row.indexedChunks),
      pendingIndexedChunks: Number(row.pendingIndexedChunks),
      legacyChunks: Number(row.legacyChunks),
      unsettledKnowledge: Number(row.unsettledKnowledge),
    };
  }

  private async assertSwitchable(
    sql: Sql,
    kbId: string,
    profile: EmbeddingProfile,
  ): Promise<void> {
    if (!(await this.index.isReady(profile.dimension)))
      throw new BindingFault('目标向量索引尚未就绪');
    const counts = await this.coverage(sql, kbId, profile, null);
    if (counts.unsettledKnowledge !== 0)
      throw new BindingFault('仍有文档等待解析或正在解析，暂不能切换');
    if (counts.indexedChunks !== counts.totalChunks)
      throw new BindingFault(
        '目标配置尚未覆盖所有分块的最新内容，请等待重建完成',
      );
  }

  private async restoreChunkReadiness(
    sql: Sql,
    kbId: string,
    profile: EmbeddingProfile,
  ): Promise<void> {
    // 与 active 切换同事务提交，恢复旧 failed/processing 分块的关键词检索资格。
    await sql.query(
      `UPDATE chunks c SET "indexStatus"='ready'
      WHERE c."kbId"=$1 AND c."indexStatus" IS DISTINCT FROM 'ready'
        AND EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=c.id
          AND e."kbId"=c."kbId" AND e."profileId"=$2 AND e.dimension=$3
          AND e."contentRevision"=c."contentRevision" AND e.embedding IS NOT NULL)`,
      [kbId, profile.id, profile.dimension],
    );
  }

  private async assertNoLegacy(sql: Sql, kbId: string): Promise<void> {
    const rows = await sql.query<{ legacyChunks: number }[]>(
      `SELECT count(*)::int AS "legacyChunks"
      FROM chunks WHERE "kbId"=$1 AND embedding IS NOT NULL`,
      [kbId],
    );
    if (Number(rows[0]?.legacyChunks) > 0) {
      throw new BindingFault(
        '知识库存在来源未知的旧向量，请显式选择模型重建后再入库',
      );
    }
  }

  private async hasCurrentFailure(
    sql: Sql,
    kbId: string,
    profile: EmbeddingProfile,
  ): Promise<boolean> {
    // 只读失败存在性，不读/返回任务 error（可能含供应商响应或凭据）。
    const rows = await sql.query<{ id: string }[]>(
      `SELECT j.id FROM embedding_jobs j
      WHERE j."kbId"=$1 AND j.status='failed' AND (j."profileId" IS NULL OR j."profileId"=$2)
        AND ((j."knowledgeId" IS NULL AND j."chunkId" IS NULL) OR EXISTS (
          SELECT 1 FROM chunks c WHERE c."kbId"=$1
            AND (j."knowledgeId" IS NULL OR j."knowledgeId"=c."knowledgeId")
            AND (j."chunkId" IS NULL OR j."chunkId"=c.id)
            AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e."chunkId"=c.id
              AND e."kbId"=c."kbId" AND e."profileId"=$2 AND e.dimension=$3
              AND e."contentRevision"=c."contentRevision" AND e.embedding IS NOT NULL)))
        AND NOT EXISTS (SELECT 1 FROM embedding_jobs retry WHERE retry."kbId"=j."kbId"
          AND (retry."profileId" IS NULL OR retry."profileId"=$2)
          AND retry.status IN ('pending','running','done')
          AND (retry."knowledgeId" IS NULL OR retry."knowledgeId"=j."knowledgeId")
          AND (retry."chunkId" IS NULL OR retry."chunkId"=j."chunkId")
          AND (retry."updatedAt", retry."createdAt", retry.id) > (j."updatedAt", j."createdAt", j.id))
      ORDER BY j."updatedAt" DESC, j."createdAt" DESC, j.id DESC LIMIT 1`,
      [kbId, profile.id, profile.dimension],
    );
    return rows.length > 0;
  }

  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BindingFault)
        throw new HttpException(error.message, error.status);
      throw new ServiceUnavailableException(
        '向量绑定操作失败，请检查模型配置后重试',
      );
    }
  }
}

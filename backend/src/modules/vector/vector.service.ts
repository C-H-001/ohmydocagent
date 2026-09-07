import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmbeddingProfileService } from '../model/embedding-profile.service.js';
import { segmentQuery } from '../../common/utils/chinese-seg.js';
import { HYBRID_SEARCH_TOP_K_MAX } from './dto/hybrid-search.dto.js';
import { SearchScopeService } from './search-scope.service.js';
import type { AuthorizedSearchScope } from './search-scope.service.js';
import { checkedDimension } from './embedding-index.service.js';

export const VECTOR_WEIGHT = 0.6;
export const KEYWORD_WEIGHT = 0.4;
export const MIN_VECTOR_SCORE = 0.05;
export interface HybridSearchItem {
  chunkId: string;
  content: string;
  kbId: string;
  knowledgeId: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
  type?: string;
  assetKey?: string;
  imageInfo?: {
    url: string;
    caption?: string;
    page?: number;
    mimeType?: string;
    assetKey?: string;
  } | null;
}
interface SearchRow {
  id: string;
  content: string;
  kbId: string;
  knowledgeId: string;
  score: number | string;
  type?: string;
  assetKey?: string | null;
  imageInfo?: HybridSearchItem['imageInfo'];
}
const FIELDS =
  'c.id,c.content,c."kbId",c."knowledgeId",c.type,c."assetKey",c."imageInfo"';

/** 不同配置分别向量化，关键词只查询一次；模型分数按排名融合。 */
@Injectable()
export class VectorService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly profiles: EmbeddingProfileService,
    private readonly scopes: SearchScopeService,
  ) {}

  authorizeScope(
    kbIds: string[],
    knowledgeIds: string[],
    userId?: string,
  ): Promise<AuthorizedSearchScope> {
    return this.scopes.resolve(kbIds, knowledgeIds, userId);
  }

  private scopeClause(scope: AuthorizedSearchScope, params: unknown[]): string {
    const parts: string[] = [];
    if (scope.fullKbIds.length) {
      params.push(scope.fullKbIds);
      parts.push(`c."kbId"=ANY($${params.length}::uuid[])`);
    }
    if (scope.knowledgeIds.length) {
      params.push(scope.knowledgeIds);
      parts.push(`c."knowledgeId"=ANY($${params.length}::uuid[])`);
    }
    return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
  }

  private async searchProfile(
    scope: AuthorizedSearchScope,
    kbIds: string[],
    profileId: string,
    query: string,
    k: number,
  ): Promise<SearchRow[]> {
    const profile = await this.profiles.getProfile(profileId);
    const d = checkedDimension(profile.dimension);
    const { vectors } = await this.profiles.embed(profileId, [query]);
    const params: unknown[] = [`[${vectors[0].join(',')}]`, profileId, kbIds];
    const filter = this.scopeClause(scope, params);
    params.push(k);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, k * 2)}`);
      await manager.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
      await manager.query("SET LOCAL statement_timeout = '15s'");
      return manager.query<SearchRow[]>(
        `WITH candidates AS MATERIALIZED (
          SELECT ${FIELDS},e.embedding FROM chunk_embeddings e
          JOIN chunks c ON c.id=e."chunkId" AND c."kbId"=e."kbId"
          JOIN knowledge_bases kb ON kb.id=c."kbId" AND kb."activeEmbeddingProfileId"=e."profileId"
          WHERE e.dimension=${d} AND e."profileId"=$2 AND e."kbId"=ANY($3::uuid[])
            AND e."contentRevision"=c."contentRevision" AND ${filter}
          ORDER BY e.embedding::halfvec(${d}) <=> $1::halfvec(${d}) LIMIT $${params.length}
        ) SELECT id,content,"kbId","knowledgeId",type,"assetKey","imageInfo",
          1-(embedding <=> $1::vector) AS score FROM candidates
          ORDER BY embedding <=> $1::vector,id`,
        params,
      );
    });
  }

  private async keywordRows(
    scope: AuthorizedSearchScope,
    query: string,
    k: number,
  ): Promise<SearchRow[]> {
    const terms = segmentQuery(query)
      .map((t) => t.replace(/[&|!():'*]/g, ' ').trim())
      .filter(Boolean);
    if (!terms.length) return [];
    const params: unknown[] = [terms.map((t) => `${t}:*`).join(' & ')];
    const fallbacks = terms.map((term) => {
      params.push(term);
      return `c.content ILIKE '%' || $${params.length} || '%'`;
    });
    const scopeFilter = this.scopeClause(scope, params);
    params.push(k);
    return this.dataSource.query<SearchRow[]>(
      `SELECT ${FIELDS},ts_rank_cd(to_tsvector('simple',c."keywordText"),to_tsquery('simple',$1)) AS score
       FROM chunks c WHERE c."indexStatus"='ready' AND ${scopeFilter}
         AND (to_tsvector('simple',c."keywordText") @@ to_tsquery('simple',$1) OR ${fallbacks.join(' OR ')})
       ORDER BY score DESC,c."chunkIndex",c.id LIMIT $${params.length}`,
      params,
    );
  }

  async hybridSearch(
    kbIds: string[],
    query: string,
    topK: number,
    knowledgeIds?: string[],
    vectorThreshold?: number,
    userId?: string,
  ): Promise<HybridSearchItem[]> {
    const scope = await this.scopes.resolve(kbIds, knowledgeIds ?? [], userId);
    if (!scope.bindings.length) return [];
    const k = Math.min(
      Math.max(Number.isFinite(topK) ? Math.floor(topK) : 10, 1),
      HYBRID_SEARCH_TOP_K_MAX,
    );
    const groups = new Map<string, { profileId: string; kbIds: string[] }>();
    for (const binding of scope.bindings) {
      // 旧向量没有可靠来源证明，不能使用创建者当前默认模型解释它们。
      if (!binding.activeEmbeddingProfileId) continue;
      const key = binding.activeEmbeddingProfileId;
      const group = groups.get(key) ?? { profileId: key, kbIds: [] };
      group.kbIds.push(binding.id);
      groups.set(key, group);
    }
    const routes: SearchRow[][] = [];
    const entries = [...groups.values()];
    const keywordResult = this.keywordRows(scope, query, k * 2).then(
      (rows) => ({ rows }),
      (error) => ({ error }),
    );
    // 多模型检索有界并发，避免一次多库请求占满数据库连接。
    for (let i = 0; i < entries.length; i += 3) {
      routes.push(
        ...(await Promise.all(
          entries
            .slice(i, i + 3)
            .map((g) =>
              this.searchProfile(scope, g.kbIds, g.profileId, query, k * 2),
            ),
        )),
      );
    }
    const keyword = await keywordResult;
    if ('error' in keyword) throw keyword.error;
    const merged = new Map<string, HybridSearchItem>();
    const put = (
      row: SearchRow,
      rank: number,
      kind: 'vectorScore' | 'keywordScore',
    ) => {
      const item = merged.get(row.id) ?? {
        chunkId: row.id,
        content: row.content,
        kbId: row.kbId,
        knowledgeId: row.knowledgeId,
        vectorScore: 0,
        keywordScore: 0,
        score: 0,
        ...(row.type === 'image'
          ? {
              type: row.type,
              assetKey: row.assetKey ?? undefined,
              imageInfo: row.imageInfo,
            }
          : {}),
      };
      item[kind] = Math.max(item[kind], 61 / (60 + rank));
      item.score =
        VECTOR_WEIGHT * item.vectorScore + KEYWORD_WEIGHT * item.keywordScore;
      merged.set(row.id, item);
    };
    for (const route of routes)
      route
        .filter((r) => Number(r.score) >= (vectorThreshold ?? MIN_VECTOR_SCORE))
        .forEach((r, i) => put(r, i + 1, 'vectorScore'));
    keyword.rows.forEach((r, i) => put(r, i + 1, 'keywordScore'));
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, k);
  }
}

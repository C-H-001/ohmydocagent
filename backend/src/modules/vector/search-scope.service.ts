import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface SearchBinding {
  id: string;
  creatorId: string;
  activeEmbeddingProfileId: string | null;
}
export interface AuthorizedSearchScope {
  fullKbIds: string[];
  knowledgeIds: string[];
  bindings: SearchBinding[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SearchScopeService {
  constructor(private readonly dataSource: DataSource) {}

  async resolve(
    kbIds: string[],
    knowledgeIds: string[],
    userId?: string,
  ): Promise<AuthorizedSearchScope> {
    if (kbIds.length === 0 && knowledgeIds.length === 0)
      return { fullKbIds: [], knowledgeIds: [], bindings: [] };
    if (!userId || !UUID.test(userId))
      throw new NotFoundException('知识库不存在或无权访问');
    if (
      kbIds.length > 100 ||
      knowledgeIds.length > 100 ||
      [...kbIds, ...knowledgeIds].some((id) => !UUID.test(id))
    ) {
      throw new BadRequestException('检索范围无效');
    }
    const fullKbIds = [...new Set(kbIds.map((id) => id.toLowerCase()))];
    const files = [...new Set(knowledgeIds.map((id) => id.toLowerCase()))];
    const docs = files.length
      ? await this.dataSource.query<{ id: string; kbId: string }[]>(
          'SELECT id, "kbId" FROM knowledge WHERE id=ANY($1::uuid[])',
          [files],
        )
      : [];
    if (docs.length !== files.length)
      throw new NotFoundException('文档不存在或无权访问');
    const requested = [...new Set([...fullKbIds, ...docs.map((d) => d.kbId)])];
    const bindings = await this.dataSource.query<SearchBinding[]>(
      `SELECT kb.id, kb."creatorId", kb."activeEmbeddingProfileId"
       FROM knowledge_bases kb JOIN users u ON u.id=$2
       WHERE kb.id=ANY($1::uuid[]) AND (u.role::text='super' OR kb."creatorId"=$2
         OR EXISTS(SELECT 1 FROM knowledge_base_shares s WHERE s."kbId"=kb.id AND s."userId"=$2))`,
      [requested, userId],
    );
    if (bindings.length !== requested.length)
      throw new NotFoundException('知识库不存在或无权访问');
    return { fullKbIds, knowledgeIds: files, bindings };
  }
}

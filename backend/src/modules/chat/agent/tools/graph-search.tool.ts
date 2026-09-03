// search_graph 工具（Task: 对齐 WeKnora query_knowledge_graph——图谱检索与
// 语义检索解耦为独立工具）。设计背景：kb-search 原先把图谱作为第三路与向量/
// 关键词做 RRF 融合（graphWeight 最高）——实测图谱噪声（实体命中无关体育/
// 媒体文章）会以最高权重压过语义召回的正确答案（MultiHop Q8：底层纯 hybrid
// 能召回 Jordan Poyer 答案 chunk，融合后却只剩 Messi/电影等噪声）。故拆分：
//   - search_kb：纯语义/文档内容检索（向量+关键词）
//   - search_graph：纯图谱检索（实体关系/跨文档实体网络）
// 工作流（hybrid→graph，固定顺序，见 agent-orchestrator 系统提示）：
//   1) 事实/内容/引用 → search_kb（文本召回 + 引用 [n]）
//   2) 实体关系/多跳/跨文档关联 → search_graph（实体网络 + 关联文档）
// search_graph 只输出实体关系上下文与关联 chunk（不产生 [n] 引用——它回答
// "X 与 Y 什么关系"，正文引用仍由 search_kb 的 [n] 承担）。
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Chunk } from '../../../chunk/chunk.entity.js';
import { GraphSearchService } from '../../../graph/graph-search.service.js';
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool.interface.js';

/** 实体解析关键词上限（query 切词用——对齐 graph-search 的 MAX_ENTITY_KEYWORDS） */
const MAX_ENTITY_KEYWORDS = 6;

/** 关联 chunk 内容上限（字符/条）：防图谱关联大块内容撑爆模型上下文 */
const GRAPH_CHUNK_PREVIEW = 300;

@Injectable()
export class GraphSearchTool implements Tool {
  private readonly logger = new Logger(GraphSearchTool.name);

  readonly definition = {
    name: 'search_graph',
    description:
      '查询企业知识库的知识图谱：探索实体之间的关联关系与跨文档实体网络。' +
      '适合"X 与 Y 是什么关系"、"与 X 相关的有哪些实体/概念"、"问题涉及多个实体间的' +
      '多跳关联"等场景。' +
      '**工作流**：先 search_kb 检索文本内容；当问题需要跨文档实体关联/关系推断时，' +
      '再用本工具查图谱补充实体网络信息。' +
      '返回实体的关系描述与关联文档片段；无图谱命中时返回空（请继续用 search_kb）。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '查询内容（实体名、或包含实体名的自然语言问题）',
        },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly graphSearchService: GraphSearchService,
    @InjectRepository(Chunk)
    private readonly chunkRepo: Repository<Chunk>,
  ) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const kbIds = ctx.scope?.kbIds ?? ctx.kbIds;
    if (!query) {
      return { content: '', status: 'done', references: [] };
    }
    if (kbIds.length === 0) {
      return {
        content: '当前会话未关联知识库，无法查询图谱。',
        status: 'done',
        references: [],
      };
    }
    try {
      // 实体解析：优先 query 切词（图谱实体为名词短语——对 query 直接按
      // 分隔符切词即可命中，无需额外 LLM 调用；WeKnora query_knowledge_graph
      // 同款「query 即实体/关系查询」语义）
      const keywords = query
        .split(/[\s,，。;；:：!！?？、]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1)
        .slice(0, MAX_ENTITY_KEYWORDS);
      const g = await this.graphSearchService.graphRetrieveByEntities(keywords, kbIds);
      if (g.chunkIds.length === 0 && !g.entityContext) {
        return { content: '', status: 'done', references: [] };
      }
      // 关联 chunk 内容预览（实体命中的文档片段——给模型实体落地的事实依据）
      let chunkPreview = '';
      if (g.chunkIds.length > 0) {
        const chunks = await this.chunkRepo.find({
          where: { id: In(g.chunkIds.slice(0, 5)), kbId: In(kbIds) },
          select: { id: true, content: true, knowledgeId: true },
        });
        if (chunks.length > 0) {
          const byId = new Map(g.chunkIds.map((id, i) => [id, i]));
          chunkPreview =
            '\n关联文档片段：\n' +
            chunks
              .sort((a, b) => (byId.get(a.id) ?? 99) - (byId.get(b.id) ?? 99))
              .slice(0, 4)
              .map((c, i) =>
                `[G${i + 1}] ${c.content.slice(0, GRAPH_CHUNK_PREVIEW)}${c.content.length > GRAPH_CHUNK_PREVIEW ? '…' : ''}`,
              )
              .join('\n');
        }
      }
      const content =
        `[知识图谱] ${g.entityContext || '命中实体无关系描述'}` + chunkPreview;
      return { content, status: 'done', references: [] };
    } catch (err) {
      // 图谱查询失败：静默降级（返回空——模型继续用 search_kb）
      this.logger.warn(
        `图谱查询失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { content: '', status: 'done', references: [] };
    }
  }
}

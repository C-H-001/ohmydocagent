// 聊天历史服务（Task 2.11）：历史搜索 + 按知识库统计 + 清空全部会话。
// - search：关键词全文搜索当前用户全部会话的消息（user + assistant）——
//   content ILIKE %keyword%（关键词中的 LIKE 通配符 %/_/\ 转义：PG 默认
//   反斜杠转义，防用户输入 '%' 匹配全库或 '_' 单字符通配扩大结果集）；
//   会话标题批量补查（一次 IN 查询而非 N+1）；摘要截断 200 字符（列表预览）
// - stats：按知识库聚合引用统计。口径（任务书决策）：统计基于 references
//   （引用即 KB 使用证据），user 消息的 kbIds 不直接计（会话级而非消息级）。
//   RagReference 只有 knowledgeId 没有 kbId（Task 2.6 结构决策——避免前端
//   契约变更，见 rag.types.ts），故聚合经 references jsonb 展开 → join
//   knowledge 表反查 kbId（k.id::text = ref->>'knowledgeId' 文本比较：
//   references 里是 uuid 字符串，避免 uuid=text 隐式转型歧义，且引用的
//   knowledgeId 非 uuid 时不会撞 22P02；知识库/文档已删的孤儿引用 join 不上
//   自然不计，不报错）。messageCount = 引用该 KB 的 assistant 消息数
//   （COUNT DISTINCT m.id——同消息多文档引用只算 1 条消息）；citationCount =
//   引用总条数（同消息多引用计数）。kbName 从 knowledge_bases 批量补查
//   （KB 已删则省略字段，孤儿 kbId 前端展示降级）。聚合的 knowledge join 再经
//   knowledge_bases 归属过滤（kb2."creatorId" = 当前用户，纵深防御——references
//   伪造他人 KB 引用也不会计入，见 stats 方法内注释）。days 过滤（createdAt ≥
//   now - days，DTO 层限 1..365）。搜索/统计全部按当前用户隔离（join
//   sessions.userId 过滤）——他人数据不可见。
// - clearAll：清空当前用户全部会话（含消息、附件行 + 磁盘）——危险操作，
//   API 层不加 confirm 参数（决策：由前端二次确认，见控制器注释；服务端
//   幂等可重放：重复调用对无会话用户返回 { deleted: 0 }）；返回 { deleted }
//   删除数；附件级联复用 SessionService.remove 语义（事务前收集磁盘路径 +
//   事务后尽力清理，fs 与 DB 非原子——失败仅记日志，孤儿文件可后续清理）。
// - 规模评估（质量审查整改）：search 的 content ILIKE '%keyword%' 是前导通配
//   模式——content 列无 GIN 索引时不走索引（逐行扫描），设计假设为单用户
//   消息量级（数千至数万条可接受）；若未来单用户消息量显著增长（数十万+），
//   需评估 pg_trgm 扩展 + GIN（gin_trgm_ops）支撑 ILIKE '%…%'，或引入 ES 等
//   专用检索。stats 的聚合按用户隔离且有 createdAt 窗口，量级与 search 同源。
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Paginated } from '../../common/pagination.js';
import { clampSurrogateBoundary } from '../../common/unicode.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';

/** 历史搜索摘要最大长度（列表页预览；与 ReferencesService 的引用摘要同一
 * 截断语义：200 字符 + '…' 省略号，见 references.service.ts 文件头注释） */
export const HISTORY_SNIPPET_MAX_LENGTH = 200;

/** 历史搜索单条记录（列表页预览契约） */
export interface HistorySearchItem {
  messageId: string;
  sessionId: string;
  /** 所属会话标题（列表页展示所属会话；批量补查，见 search 注释） */
  sessionTitle: string;
  role: 'user' | 'assistant' | 'system';
  /** 内容摘要（>200 截断 + '…'） */
  content: string;
  createdAt: Date;
}

/** 按知识库聚合统计单条（kbName 可选：KB 已删时省略字段） */
export interface KbStatsItem {
  kbId: string;
  kbName?: string;
  /** 引用该 KB 的 assistant 消息数（同消息多文档引用只算 1 条） */
  messageCount: number;
  /** 引用总条数（同消息多引用计数） */
  citationCount: number;
}

/** 摘要截断：>200 截到 200 + '…'（提示截断语义，与 references 截断一致，
 * 见 references.service.ts truncate 注释）；≤200 原样。截断点经
 * clampSurrogateBoundary 钳制（Task 2.2 质量审查整改的公共工具，见
 * common/unicode.ts）——直接 slice(0,200) 可能把 emoji 等非 BMP 字符的
 * 代理对劈开，两侧出现孤立代理（摘要乱码）；clamp 后切点回退到代理对
 * 起点，配对整体被丢弃而非劈开。导出供单测——列表预览的纯函数（Task
 * 2.11 单测覆盖，见 chat-history.service.spec.ts）。 */
export function truncateSnippet(content: string): string {
  return content.length > HISTORY_SNIPPET_MAX_LENGTH
    ? `${content.slice(
        0,
        clampSurrogateBoundary(content, HISTORY_SNIPPET_MAX_LENGTH),
      )}…`
    : content;
}

/** LIKE 通配符转义（导出供单测，Task 2.11 质量审查整改）：PG 默认反斜杠
 * 转义——用户输入的 %/_ 转成字面量（防 '%' 匹配全库 / '_' 单字符通配扩大
 * 结果集）；'\' 自身先转义防绕过转义序列。测试见 chat-history.service.spec.ts
 * 与 chat-history.e2e-spec.ts（50%折扣 命中 / 50X 不误中）。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

@Injectable()
export class ChatHistoryService {
  constructor(
    // stats 聚合 SQL（jsonb 展开 + join 反查 kbId）与 clearAll 事务
    private readonly dataSource: DataSource,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    // kbName 补查（knowledge_bases 表，见文件头 stats 注释）
    @InjectRepository(KnowledgeBase)
    private readonly kbRepository: Repository<KnowledgeBase>,
  ) {}

  /**
   * 历史搜索（Task 2.11）：关键词全文搜索当前用户全部会话的消息
   * （user + assistant），content ILIKE %keyword%（通配符转义见文件头注释）；
   * createdAt DESC + id 决胜键（同秒消息排序稳定，复用 Task 1.10 经验）；
   * 会话标题批量补查（一次 IN 查询而非 N+1）；摘要截断 200。返回统一
   * Paginated<HistorySearchItem> 结构（与分页约定一致，见 common/pagination）。
   * 数据隔离：join sessions 限定本人会话——他人消息不可见（越权防护，
   * 见 e2e「他人数据不可见」用例）。
   */
  async search(
    userId: string,
    keyword: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<HistorySearchItem>> {
    const qb = this.messageRepository
      .createQueryBuilder('m')
      // join sessions 限定本人会话（数据隔离；join 只做过滤不选列）
      .innerJoin(Session, 's', 's.id = m."sessionId"')
      .where('s."userId" = :userId', { userId })
      .andWhere('m.role IN (:...roles)', { roles: ['user', 'assistant'] })
      .andWhere('m.content ILIKE :pattern', {
        pattern: `%${escapeLike(keyword)}%`,
      })
      .orderBy('m."createdAt"', 'DESC')
      .addOrderBy('m.id', 'DESC');
    qb.limit(pageSize).offset((page - 1) * pageSize);
    // getManyAndCount：一次取分页实体 + 全量总数（count 忽略 limit/offset）
    const [rows, total] = await qb.getManyAndCount();
    if (rows.length === 0) {
      return { items: [], total, page, pageSize };
    }
    // 会话标题批量补查（一次 IN 查询而非 N+1；标题用于列表页展示所属会话）
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
    const sessions = await this.sessionRepository.find({
      where: { id: In(sessionIds) },
      select: { id: true, title: true },
    });
    const titleMap = new Map(sessions.map((s) => [s.id, s.title]));
    const items = rows.map((m) => ({
      messageId: m.id,
      sessionId: m.sessionId,
      sessionTitle: titleMap.get(m.sessionId) ?? '',
      role: m.role,
      content: truncateSnippet(m.content),
      createdAt: m.createdAt,
    }));
    return { items, total, page, pageSize };
  }

  /**
   * 按知识库聚合统计（Task 2.11）：口径见文件头注释——references jsonb 展开
   * → join knowledge 反查 kbId → 按 kbId 聚合。messageCount = 引用该 KB 的
   * assistant 消息数（COUNT DISTINCT m.id），citationCount = 引用总条数
   * （同消息多引用计数）。days 窗口过滤消息 createdAt（≥ now - days）。
   * 返回按 messageCount DESC + kbId ASC 排序（使用量大的 KB 在前，kbId
   * 决胜键保证排序稳定）；kbName 批量补查（KB 已删则省略字段——孤儿 kbId
   * 不报错，前端展示降级）。无引用数据 → 空数组（不补查）。
   */
  async stats(userId: string, days: number): Promise<KbStatsItem[]> {
    // 聚合 SQL（参数化防注入）：
    // - jsonb_typeof 守卫：references 非数组（含 NULL）时展开为空集合——
    //   jsonb_array_elements 对非数组输入会抛错，守卫先行降级；
    // - k.id::text = ref->>'knowledgeId' 文本比较：避免 uuid=text 隐式转型
    //   歧义，且引用中 knowledgeId 非 uuid 时不会撞 22P02（见文件头注释）；
    // - make_interval(days => $2)：参数化天数（防注入，比字符串拼接安全）；
    // - knowledge_bases kb2 归属过滤（纵深防御，质量审查整改）：join
    //   kb2."creatorId" = $1 限定 KB 归属当前用户——即使 references 的
    //   knowledgeId 被伪造指向他人 KB，也不会计入本用户统计（上游工具层
    //   ReferencesService 已限本人知识库，此处为第二道防线，成本低）
    const rows = (await this.dataSource.query(
      `SELECT k."kbId" AS "kbId",
              COUNT(DISTINCT m.id)::int AS "messageCount",
              COUNT(*)::int AS "citationCount"
       FROM messages m
       JOIN sessions s ON s.id = m."sessionId"
       JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(m.references) = 'array'
              THEN m.references ELSE '[]'::jsonb END
       ) AS ref ON TRUE
       JOIN knowledge k ON k.id::text = ref->>'knowledgeId'
       JOIN knowledge_bases kb2 ON kb2.id = k."kbId"
         AND kb2."creatorId" = $1
       WHERE s."userId" = $1
         AND m.role = 'assistant'
         AND m."createdAt" >= now() - make_interval(days => $2)
       GROUP BY k."kbId"
       ORDER BY "messageCount" DESC, "kbId" ASC`,
      [userId, days],
    )) as Array<{ kbId: string; messageCount: number; citationCount: number }>;
    if (rows.length === 0) {
      return [];
    }
    // kbName 批量补查（knowledge_bases；KB 已删 → 省略字段，见文件头注释）
    const kbs = await this.kbRepository.find({
      where: { id: In(rows.map((r) => r.kbId)) },
      select: { id: true, name: true },
    });
    const nameMap = new Map(kbs.map((k) => [k.id, k.name]));
    return rows.map((r) => ({
      kbId: r.kbId,
      ...(nameMap.has(r.kbId) ? { kbName: nameMap.get(r.kbId) } : {}),
      messageCount: r.messageCount,
      citationCount: r.citationCount,
    }));
  }

  /**
   * 清空当前用户全部会话（Task 2.11）：删除全部会话（含消息、附件行 + 磁盘）。
   * 危险操作确认语义（决策，见任务书）：API 层不加 confirm 参数——HTTP 层由
   * 前端二次确认（浏览器对话框/弹窗），服务端不加额外的确认参数（幂等可
   * 重放：重复调用对无会话用户返回 { deleted: 0 }，不会误删他人数据——范围
   * 恒为当前用户）。
   */
  async clearAll(userId: string): Promise<{ deleted: number }> {
    // deleted 口径（质量审查整改）：返回「事务前 find 到的会话数」
    // （ids.length），而非受影响删除行数——删除走 manager.delete 不返回
    // affected 行数；并发高报：同一用户并行两次 clearAll 可能 find 到同一
    // 批会话、两次都返回非 0，但事务内按 id 删除幂等（第二次 0 行），不误
    // 删他人数据。对账以「删后会话归零」为准（见 e2e 断言），deleted 仅作
    // 进度提示语义。
    // 先查本人全部会话（归属范围 = 当前用户，他人会话不受影响）
    const sessions = await this.sessionRepository.find({
      where: { userId },
      select: { id: true },
    });
    const ids = sessions.map((s) => s.id);
    if (ids.length === 0) {
      return { deleted: 0 };
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Message, { sessionId: In(ids) });
      await manager.delete(Session, { id: In(ids) });
    });
    return { deleted: ids.length };
  }
}

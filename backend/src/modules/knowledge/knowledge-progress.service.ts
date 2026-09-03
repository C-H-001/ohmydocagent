// 解析进度写回服务（Task 1.4）：独立的 knowledge 状态/进度更新入口，由
// ParseProcessor 消费——与 KnowledgeService 解耦（解析管线只改 status/parsedText/
// parserStages/error，不触碰业务 CRUD；KnowledgeService 不依赖本服务，模块依赖
// 方向无环）。后续 EMBED/SUMMARY 等管线的进度写回也复用本服务（或在此扩展）。
// 原子写（Task 1.4 质量整改）：updateProgress 把 status/error/parsedText +
// parserStages 追加合并为单条 UPDATE——旧实现 appendStage + repo.update 两条独立
// 语句，崩溃可能落在中间态（如 stage 已追加但 status 未更新），且重试时产生噪音
// 写。单语句 = 全有或全无，无中间态。
// parserStages 用 SQL jsonb 数组追加（原子），避免 read-modify-write 并发竞态
// （同文档重试/重新入队时两个阶段写可能交错，追加语义天然安全）；追加同时
// 裁剪保留最近 PARSER_STAGES_LIMIT 条（同一表达式内完成，不引入竞态，
// 见该常量注释）。
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Knowledge } from './knowledge.entity.js';

/** 解析阶段记录（Task 1.7 正式做 stages API，本任务先写入字段） */
export interface ParserStage {
  stage: string;
  status: 'running' | 'done' | 'failed';
  at: string;
  detail?: string;
}

/** 单次原子进度写回参数（updateProgress）：status/error/parsedText/chunkCount/
 * summary 按需更新（未传入的字段保持原值），stage 传入则追加一条解析阶段记录。
 * 语义约定（实体不变量：error 非空 ⇔ status=failed，见 knowledge.entity.ts）：
 * - status='parsing'/'ready' 时 error 必须为空串——markParsing/saveParsedText
 *   显式传 error='' 清残留（重试成功后不得保留上次失败原因）
 * - parsedText 只在 saveParsedText 写入；markFailed 不触碰（保留已解析文本，
 *   供后续管线（如 Task 1.5 分块）重试复用）
 * - chunkCount（Task 1.5）只在分块阶段写入：分块完成 = 块数，空文本 = 0
 * - summary（Task 1.7）只在摘要管线写入：SummaryProcessor 生成后落库，
 *   与 summary done 阶段同一条 UPDATE（原子，见 summary.processor.ts 注释） */
export interface ProgressUpdate {
  status?: string;
  error?: string;
  parsedText?: string | null;
  chunkCount?: number;
  summary?: string | null;
  stage?: ParserStage;
}

/** 错误信息落库长度上限（防异常堆栈/超长消息撑爆行宽；error 列是 text，够用即可） */
const ERROR_MAX_LENGTH = 2000;

/** parserStages 时间线保留上限（质量审查整改）：重试/重新生成反复追加时时间线
 * 无界增长（列宽与 stages API 响应都会膨胀）——追加时在 SQL 内裁剪保留最近
 * 50 条（reparse 会整体重置时间线，正常单轮文档远低于上限；上限只约束异常
 * 场景的反复尝试/重生成）。裁剪与追加同一条 UPDATE 原子完成（不引入
 * read-modify-write 竞态，见文件头 updateProgress 注释的 jsonb 追加语义） */
const PARSER_STAGES_LIMIT = 50;

@Injectable()
export class KnowledgeProgressService {
  constructor(
    @InjectRepository(Knowledge)
    private readonly repo: Repository<Knowledge>,
  ) {}

  /** 标记解析中：status=parsing + 清空残留 error（新尝试开始，旧失败原因不再
   * 反映当前状态）+ parserStages 追加 extract running */
  async markParsing(id: string): Promise<void> {
    await this.updateProgress(id, {
      status: 'parsing',
      error: '',
      stage: {
        stage: 'extract',
        status: 'running',
        at: new Date().toISOString(),
      },
    });
  }

  /** 保存解析结果：parsedText 落库 + error 清空（重试成功后不得残留上次失败
   * 原因——实体不变量 error 非空 ⇔ status=failed）+ parserStages 追加 extract done。
   * status 保持 parsing——本任务口径：Task 1.5 分块完成后才置 ready */
  async saveParsedText(id: string, text: string): Promise<void> {
    await this.updateProgress(id, {
      status: 'parsing',
      error: '',
      parsedText: text,
      stage: {
        stage: 'extract',
        status: 'done',
        at: new Date().toISOString(),
      },
    });
  }

  /** 标记失败：status=failed + error 记录 + 指定解析阶段 failed
   * （detail 原因）。stageName 区分失败发生在哪个阶段：'extract'（Task 1.4
   * 解析）或 'chunk'（Task 1.5 分块）——错误落库时间线保持真实。
   * 不触碰 parsedText（保留现场供排查/重试） */
  async markFailed(
    id: string,
    error: string,
    stageName: string = 'extract',
  ): Promise<void> {
    const message = error.slice(0, ERROR_MAX_LENGTH);
    await this.updateProgress(id, {
      status: 'failed',
      error: message,
      stage: {
        stage: stageName,
        status: 'failed',
        detail: message,
        at: new Date().toISOString(),
      },
    });
  }

  /** 原子进度写回（Task 1.4 质量整改）：status/error/parsedText/chunkCount +
   * parserStages 追加合并为单条 UPDATE（见文件头注释）。SQL 形态
   * （saveParsedText 全量场景）：
   * UPDATE knowledge SET status=$1, error=$2,
   *   "parserStages" = (SELECT jsonb_agg(elem ORDER BY pos) FROM
   *     (SELECT elem, pos FROM jsonb_array_elements(
   *        COALESCE("parserStages",'[]'::jsonb) || $3::jsonb)
   *      WITH ORDINALITY AS t(elem, pos) ORDER BY pos DESC LIMIT 50) kept),
   *   "parsedText"=$4 WHERE id=$5
   * - parserStages 用 jsonb 数组拼接 + COALESCE 兜底 NULL（实体默认 '[]'，防御
   *   旧数据/未来 nullable 改动）；stage 未传入时跳过该列（未提供字段保持原值）
   * - 注意：本项目未配置 snake_case 命名策略，列名即属性名（camelCase），
   *   原始 SQL 片段中必须加双引号（PG 会把未加引号的标识符小写化）
   * - manager（Task 1.5）：解析管线的分块阶段把「chunk 写入 + 最终状态更新」
   *   放进同一事务（dataSource.transaction），本方法复用该事务的 EntityManager
   *   执行 UPDATE——若仍用自身 repo（主连接），UPDATE 会游离在事务外，与 chunk
   *   插入非原子（崩溃可能落在「块已写但状态未 ready」的中间态） */
  async updateProgress(
    id: string,
    changes: ProgressUpdate,
    manager?: EntityManager,
  ): Promise<void> {
    // 只更新传入字段（TypeORM set() 会跳过 undefined，见 QueryBuilder 实现——
    // 未传字段保持原值，避免覆盖其它管线写入的状态）
    const set: Record<string, unknown> = {};
    if (changes.status !== undefined) set.status = changes.status;
    if (changes.error !== undefined) set.error = changes.error;
    if (changes.parsedText !== undefined) set.parsedText = changes.parsedText;
    if (changes.chunkCount !== undefined) set.chunkCount = changes.chunkCount;
    if (changes.summary !== undefined) set.summary = changes.summary;
    if (changes.stage !== undefined) {
      // jsonb 数组拼接（追加语义天然并发安全）+ 保留上限裁剪（同一表达式内完成，
      // 原子）；:stage 参数化无注入面。裁剪 SQL：jsonb_array_elements WITH
      // ORDINALITY 给元素编号 → 按编号倒序 LIMIT 50（保留最近 50 条）→
      // jsonb_agg ORDER BY 编号恢复时间线顺序（oldest-first，与追加语义一致）。
      // 引用自身列名时用 COALESCE 兜底 NULL（同原追加表达式）；子查询内引用
      // 外层 UPDATE 行的 "parserStages" 列——SET 表达式按行求值，行为正确
      set.parserStages = () =>
        `(SELECT jsonb_agg(elem ORDER BY pos) FROM (SELECT elem, pos FROM jsonb_array_elements(COALESCE("parserStages", '[]'::jsonb) || :stage::jsonb) WITH ORDINALITY AS t(elem, pos) ORDER BY pos DESC LIMIT ${PARSER_STAGES_LIMIT}) kept)`;
    }
    const source = manager ? manager.getRepository(Knowledge) : this.repo;
    const qb = source
      .createQueryBuilder()
      .update(Knowledge)
      .set(set)
      .where('id = :id', { id });
    if (changes.stage !== undefined) {
      qb.setParameter('stage', JSON.stringify(changes.stage));
    }
    await qb.execute();
  }
}

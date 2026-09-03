// @提及解析服务（Task 2.9）：解析 user 消息中的 @kb:<uuid> 与 @file:<uuid>
// 标记（前端 @选择器生成）→ 返回提及范围（kbIds/knowledgeIds）+ 清理后的
// 文本（cleanedText 移除提及标记，作为传给 LLM 的 user 消息内容）。
//
// 设计决策（任务书规定 + 注释）：
// - 前缀小写精确匹配（@kb:/@file: 严格小写——前端 @选择器固定输出小写前缀；
//   大写 @KB: 不识别，保留原文不误删；UUID 本身大小写不敏感，归一化为小写
//   返回——PG uuid 列落库一律小写，与 StorageService 目录小写规范化同一约定）
// - 无效提及（@kb: 后跟非 uuid）从文本移除 + 注释（宽容语义）：前端选择器
//   理论上只生成合法 id，但用户可能手输/粘贴被截断——移除避免 LLM 看到垃圾
//   标记，不报 400（报 400 会让整条消息不可发送，体验差）
// - 正则严格校验 UUID v4（质量审查整改）：版本位固定 4、变体位 [89ab]——
//   @kb:123 / @file:not-a-uuid / @kb:xxx你好 / 非 v4 uuid（版本位不是 4）一律
//   不算合法提及（不进 kbIds/knowledgeIds，避免非 uuid 文本混入检索范围导致
//   SQL 解析错误或合法检索失效），整段走 INVALID_RE 从文本移除；UUID 本身
//   大小写不敏感（字符类双写大小写：v4 版本位 '4' 无大小写差异，变体位
//   [89ab] 补 AB 大写）
// - 移除后残留空白折叠（提及标记处可能留双空格——'请检索 @kb:x 资料' →
//   '请检索  资料' → '请检索 资料'，中文文本无连续空格语义，折叠无害）
import { Injectable } from '@nestjs/common';

/** @提及解析结果：检索范围（kbIds = @kb:X 提及的知识库；knowledgeIds =
 * @file:F 提及的文档 id）+ 移除提及标记后的文本（传给 LLM 的内容） */
export interface MentionParseResult {
  /** 提及的知识库 id（@kb:X，去重 + 小写归一化） */
  kbIds: string[];
  /** 提及的文档 id（@file:F，即 chunks.knowledgeId，去重 + 小写归一化） */
  knowledgeIds: string[];
  /** 移除全部提及标记（合法 + 非法）后的文本（空白折叠 + trim） */
  cleanedText: string;
}

@Injectable()
export class MentionService {
  /** @kb:<uuid v4> 提及（质量审查整改：严格 v4 校验——版本位 4 + 变体位
   * [89ab]，非 v4 文本/非 uuid 不捕获，走 INVALID_RE 移除；UUID 大小写
   * 不敏感，捕获组 36 字符，见文件头注释） */
  private static readonly KB_RE =
    /@kb:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/g;
  /** @file:<uuid v4> 提及（同上） */
  private static readonly FILE_RE =
    /@file:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})/g;
  /** 非法提及标记移除用（宽容语义）：合法提及已先被 KB_RE/FILE_RE 整段移除，
   * 此处剩余的 @kb:/@file: 前缀必为非法值（@kb:123 / @kb:not-a-uuid /
   * @kb:xxx你好 / 非 v4 uuid 等，见文件头严格 v4 校验注释）——移除避免 LLM
   * 看到垃圾标记；`[^\s@]*` 匹配到下一个空白或 @ 为止（合法先移除后，此处
   * 不会误伤已收集的合法提及） */
  private static readonly INVALID_RE = /@(?:kb|file):[^\s@]*/g;

  /**
   * 解析 @提及：收集合法 UUID（去重 + 小写）+ 移除全部提及标记。
   * 移除顺序：先移除合法提及（KB_RE/FILE_RE——已收集，整段删除不粘连前后
   * 文本，如「请检索@kb:x资料」→「请检索资料」），再移除剩余非法提及
   * （INVALID_RE——此时不会再命中合法提及，见文件头无效提及决策）；最后
   * 折叠提及移除残留的连续空白并 trim。幂等/纯函数（无状态，可安全注入
   * 多个消费方）。
   */
  parse(text: string): MentionParseResult {
    const kbIds = [...text.matchAll(MentionService.KB_RE)].map((m) =>
      m[1].toLowerCase(),
    );
    const knowledgeIds = [...text.matchAll(MentionService.FILE_RE)].map((m) =>
      m[1].toLowerCase(),
    );
    // 统一移除提及标记（合法先移、非法兜底，见方法头注释）+ 空白折叠 + trim
    const cleanedText = text
      .replace(MentionService.KB_RE, '')
      .replace(MentionService.FILE_RE, '')
      .replace(MentionService.INVALID_RE, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    return {
      kbIds: [...new Set(kbIds)],
      knowledgeIds: [...new Set(knowledgeIds)],
      cleanedText,
    };
  }
}

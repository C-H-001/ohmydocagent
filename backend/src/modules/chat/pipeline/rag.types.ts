// RAG 管线共享类型（Task 2.5）：引用结构 + 管线返回结果。
// RagReference 是前后端契约的一部分（Task 2.6 细化引用展示/前端悬浮摘要/跳转
// 定位）：同文档多分块合并为一个引用（chunks 位置数组）+ 正文 [n] 兜底对齐
// + URL 类型文档 sourceUrl。构建/对齐逻辑见 references.service.ts。

/** 引用来源（Task 2.6）：
 * - index 为 [n] 编号：build 时按文档首次出现顺序 1..N 分配（与系统提示中的
 *   [n] 一一对应）；align 剔除未引用项后**保留原文编号不重映射**——正文已含
 *   [n] 无法改写，前端按 index 匹配（语义见 references.service.ts 注释）
 * - content 为分块内容（build 时截断到 REFERENCE_CONTENT_MAX_LENGTH=200，
 *   前端悬浮摘要与 prompt 共用一份截断后的内容，见 references.service.ts 注释）
 * - chunks 为同文档合并时保留的全部位置（score 降序；前端点击引用可定位到
 *   同文档各块）；单块文档也为单元素数组（前端处理统一）
 * - url 仅 URL 导入类型文档有值（sourceUrl 透传，补查 knowledge 表获取） */
export interface RagReference {
  /** [n] 编号：回答中 [1]/[2]… 引用的映射键（build 分配；align 后保留原值） */
  index: number;
  /** 主引用分块 id（同文档合并时 = 组内最高分块，见 references.service.ts） */
  chunkId: string;
  /** 所属知识库 id（「打开文档」跳转 KB 详情用） */
  kbId: string;
  /** 所属文档 id（knowledge 表） */
  knowledgeId: string;
  /** 文档标题（knowledge 表补查，管线 merge 前批量 WHERE id IN 获取） */
  knowledgeTitle: string;
  /** 主引用分块内容（截断 200 字符后；前端悬浮摘要用） */
  content: string;
  /** 融合检索分（仅排序参考，绝对值无跨库可比性，见 vector.service.ts 注释） */
  score: number;
  /** 同文档合并时保留的全部块位置（score 降序；前端跳转定位用，Task 2.6） */
  chunks?: { chunkId: string; score: number }[];
  /** URL 导入类型文档的 sourceUrl（可选；非 url 类型无此字段） */
  url?: string;
  /** 主引用块类型（Task: 多模态）：'image' = 图片 caption 块（content=VLM
   *  描述）；缺省 'text'（旧消息 jsonb 无此字段——前端降级渲染） */
  type?: 'text' | 'image';
  /** 图片相关度（type='image' 的主块所在页；文本块无页信息缺省） */
  page?: number;
  /** 引用聚合的图片（对齐 WeKnora 引用带 image_info）：组内 image caption
   *  块命中时收集 { url, caption, assetKey }——url 为存储相对路径，前端经
   *  签名图片端点加载（见 ParserFileGuard.signUrl）；旧消息无此字段 → 前端
   *  降级（无图纯文字，向后兼容） */
  images?: { url: string; caption?: string; assetKey?: string }[];
}

/** RAG 管线运行结果：编排器据此落库 assistant 消息（content/references/
 * reasoning）与透传 done 事件的 usage。断连路径返回已累积的部分内容
 * （content 为空串表示尚未生成任何正文），编排器落库 partial assistant。 */
export interface RagPipelineResult {
  /** 生成正文（delta 累积全文；断连时是已生成前缀） */
  content: string;
  /** 深度思考内容（Task 2.8；未输出为 null） */
  reasoning: string | null;
  /** 引用来源（merge 产物；无结果/无 kbIds 为空数组） */
  references: RagReference[];
  /** token 用量（chatStream 末尾 chunk 携带时透传；无则省略字段） */
  usage?: { inputTokens?: number; outputTokens?: number };
}

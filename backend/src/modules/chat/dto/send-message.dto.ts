// 发送对话消息请求体（Task 2.4）：content 必填。
// 校验落实 Task 2.2 质量审查整改的 M-3 TODO（message.service.ts 文件头登记）：
// - @MinLength(1)：拦空串；@Transform trim 把纯空白 '   ' 转成空串再被拦截
//   （与 create-session.dto 的 title 校验同模式：ValidationPipe transform:true
//   下先转换后校验）；
// - @MaxLength(20000)：对齐前端输入框上限（超长消息白烧上游 token，见
//   title.processor 的 TITLE_INPUT_MAX_LENGTH 防御注释——端点层是入参校验，
//   LLM 输入层还有各自的截断防御，双层）。
// 校验失败 → 400 JSON：ValidationPipe 在控制器方法前执行，SSE 尚未开始，
// 异常过滤器可正常写 JSON 响应（见 session.controller.ts 的 @Res 注释）。
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SendMessageDto {
  @IsString({ message: '消息内容必须是字符串' })
  @MinLength(1, { message: '消息内容不能为空' })
  @MaxLength(20000, { message: '消息内容最长 20000 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  content: string;

  /** Web 搜索开关（Task 2.8）：默认 true（开启）；false 时 Agent 系统提示与
   * 工具定义不含 web_search（LLM 无联网能力）——前端可提供开关。可选字段：
   * 缺省/非布尔值（校验拦截非法类型）按 true 处理 */
  @IsOptional()

  /** 附件 id 列表（Task 2.9）：发送消息引用已上传附件（图片/文件）——编排器
   * 把附件信息拼入 user 消息上下文（图片多模态 P2 先文本占位降级，见
   * agent-orchestrator.service.ts buildAttachmentHint 注释）。宽容语义：
   * 不存在/跨会话/他人的 id 被忽略（附件加载按会话 + 归属过滤，见
   * attachment.service.ts listByIds 注释） */
  @IsOptional()
  @IsArray({ message: 'attachmentIds 必须是数组' })
  @ArrayMaxSize(20, { message: 'attachmentIds 最多 20 个' })
  @IsUUID('4', { each: true, message: 'attachmentIds 每项必须是合法 UUID' })
  attachmentIds?: string[];

  /** @提及知识库范围（Task 2.9，前端 @选择器生成）：与 content 内嵌 @kb:xxx
   * 解析结果合并去重（双通道——服务端 parse + 显式数组），限定 search_kb
   * 检索范围（有提及时覆盖会话 kbIds），见 agent-orchestrator.service.ts
   * run 注释。宽松校验：只校验 uuid 数组格式，不校验知识库存在（与
   * CreateSessionDto.kbIds 同一决策） */
  @IsOptional()
  @IsArray({ message: 'mentionKbIds 必须是数组' })
  @ArrayMaxSize(50, { message: 'mentionKbIds 最多 50 个' })
  @IsUUID('4', { each: true, message: 'mentionKbIds 每项必须是合法 UUID' })
  mentionKbIds?: string[];

  /** @提及文档范围（Task 2.9，knowledgeId）：同上，@file:xxx 对应（限定检索
   * 到该文件的 chunks） */
  @IsOptional()
  @IsArray({ message: 'mentionKnowledgeIds 必须是数组' })
  @ArrayMaxSize(50, { message: 'mentionKnowledgeIds 最多 50 个' })
  @IsUUID('4', {
    each: true,
    message: 'mentionKnowledgeIds 每项必须是合法 UUID',
  })
  mentionKnowledgeIds?: string[];
}

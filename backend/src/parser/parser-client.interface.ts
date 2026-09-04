// 解析服务契约：任何实现（真实 gRPC 解析服务）
// 都返回统一结构。后期接入 ohmydocagent/parser 真实服务时，只需实现本接口并在
// ParserModule 中替换 provider，解析管线（ParseProcessor）无需改动。
export interface ParsedImage {
  /** parser 侧图片键（asset_key，如 asset-1） */
  assetKey: string;
  /** 图片所在页（1-based） */
  page: number;
  /** MIME（image/png 等） */
  mimeType: string;
  /** VLM 生成的图片描述（图表 Caption；parser 未配 VLM/失败可为空） */
  description?: string;
  /** 图片二进制（消费方存对象存储后登记 knowledge/chunk） */
  content: Buffer;
}

export interface ParsedDocument {
  /** 抽取的纯文本（Task 1.5 分块消费） */
  text: string;
  /** 文档标题（占位实现不提取，后期真实服务可返回） */
  title?: string;
  /** 分页文本（pdf 类文档可分页返回；占位实现暂不填充） */
  pages?: { page: number; text: string }[];
  /** 图片资产（多模态：对齐 WeKnora ImageMultimodal——content 存对象
   *  存储 + description 登记 knowledge/chunk，供 OCR/Caption 检索） */
  images?: ParsedImage[];
}

/** 解析输入：三种来源互斥（file 用 filePath+fileType；url 用 url；manual 用 manualContent） */
export interface ParseInput {
  /** 相对 UPLOAD_DIR 的落盘路径（file 类型；url/manual 为 undefined） */
  filePath?: string;
  /** 文件扩展名（pdf/docx/md/txt/png/...，白名单见 KnowledgeService） */
  fileType: string;
  /** URL 类型：源地址（http/https，协议白名单在实现内兜底） */
  url?: string;
  /** manual 类型：手动创建正文 */
  manualContent?: string;
  /** 真实解析引擎（GrpcParser 用；缺省按 PARSER_ENGINE 配置，仅 mineru） */
  engine?: 'mineru';
}

export interface ParserClient {
  parse(input: ParseInput): Promise<ParsedDocument>;
}

/** ParserClient 的 DI 令牌：接口是 TS 类型，运行时需显式令牌（Symbol 防字符串撞名） */
export const PARSER_CLIENT = Symbol('PARSER_CLIENT');

// 图谱抽取配置（Task 3.2）：KB 级开关 { enabled: boolean }。
// 质量审查整改：此前接受任意对象不校验结构（服务层按 { enabled?: boolean }
// 消费，非法类型静默——如 { enabled: 'yes' } 会被消费侧 `enabled === false`
// 判定为「未显式关闭」→ 当作开启，语义含糊）。Task 3.2 中 extractConfig
// 结构已定型（仅 enabled 一个键），内层校验成本低且能拦截误传：
// - enabled 必须为布尔（缺省 = 开启，见 kb.entity.ts extractConfig 注释）；
// - 消费侧（ParseProcessor.enqueueGraph / ExtractProcessor.process）用
//   `config?.enabled === false` 严格判定关闭：DTO 校验保证 HTTP 入口的
//   enabled 非布尔即 400，消费侧只剩 true/undefined 两种「开启」形态——
//   判定语义确定（默认开启的产品契约，见 graph-extraction.e2e-spec.ts）。
import { IsBoolean, IsOptional } from 'class-validator';

export class ExtractConfigDto {
  /** 图谱抽取开关：缺省 = 开启（上传即建图的产品核心能力，见 kb.entity.ts
   * extractConfig 注释）；显式 false = 关闭（存量图保留，只拦新文档入队） */
  @IsOptional()
  @IsBoolean({ message: '图谱抽取开关 enabled 必须是布尔值' })
  enabled?: boolean;
}

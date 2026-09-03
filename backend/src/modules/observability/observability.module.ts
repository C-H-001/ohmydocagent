// 观测模块（评测链路，可选）：LangfuseService——生产默认关闭（LANGFUSE_ENABLED
// 缺省 false → no-op），评测环境独立镜像运行 Langfuse 后开启。
import { Global, Module } from '@nestjs/common';
import { LangfuseService } from './langfuse.service.js';

@Global()
@Module({
  providers: [LangfuseService],
  exports: [LangfuseService],
})
export class ObservabilityModule {}

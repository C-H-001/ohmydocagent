// 解析服务模块：PARSER_CLIENT 抽象实现——经 gRPC 对接解析服务（GrpcParser，
// 见 parser/README.md）。PARSER_URL 必须配置（未配置启动报错）。
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule } from '../modules/storage/storage.module.js';
import { PARSER_CLIENT } from './parser-client.interface.js';
import { ParserFileController } from './parser-file.controller.js';
import { ParserFileGuard } from './parser-file.controller.js';
import { GrpcParser } from './grpc-parser.js';

@Module({
  imports: [StorageModule],
  controllers: [ParserFileController],
  providers: [
    ParserFileGuard,
    {
      provide: PARSER_CLIENT,
      useFactory: (config: ConfigService) => {
        const target = config.get<string>('parserUrl');
        if (!target) {
          throw new Error(
            'PARSER_URL 未配置：文档解析依赖解析服务（见 parser/README.md——' +
              '设置 PARSER_URL 为解析服务 gRPC 地址）',
          );
        }
        return new GrpcParser(config);
      },
      inject: [ConfigService],
    },
  ],
  exports: [PARSER_CLIENT, ParserFileGuard],
})
export class ParserModule {}

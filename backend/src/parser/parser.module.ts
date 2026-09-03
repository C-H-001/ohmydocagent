// 解析服务模块：PARSER_CLIENT 抽象实现按配置切换——
//   PARSER_URL 设置 → 真实解析服务（GrpcParser，ohmydocagent/parser:fixed）；
//   未设置 → 占位解析器（PlaceholderParser，pdf-parse/mammoth）。
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule } from '../modules/storage/storage.module.js';
import { PARSER_CLIENT } from './parser-client.interface.js';
import { ParserFileController } from './parser-file.controller.js';
import { ParserFileGuard } from './parser-file.controller.js';
import { GrpcParser } from './grpc-parser.js';
import { PlaceholderParser } from './placeholder-parser.js';
import { StorageService } from '../modules/storage/storage.service.js';

@Module({
  imports: [StorageModule],
  controllers: [ParserFileController],
  providers: [
    ParserFileGuard,
    {
      provide: PARSER_CLIENT,
      useFactory: (config: ConfigService, storage: StorageService) => {
        const target = config.get<string>('parserUrl');
        if (target) {
          return new GrpcParser(config);
        }
        return new PlaceholderParser(storage);
      },
      inject: [ConfigService, StorageService],
    },
  ],
  exports: [PARSER_CLIENT, ParserFileGuard],
})
export class ParserModule {}

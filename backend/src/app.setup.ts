import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * 应用级统一配置入口。
 *
 * 未来的全局 Filter / Guard / Interceptor / 日志等都在这里挂载，
 * 使 main.ts 与 e2e 测试走同一套真实应用配置，避免配置漂移。
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  // TODO: P5 生产环境按域名白名单收紧 CORS
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}

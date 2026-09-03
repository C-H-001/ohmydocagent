import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // PORT 统一从 ConfigService 读取（configuration.ts 为唯一配置源），消除双源；
  // configuration 工厂始终提供 port 默认值，故用 getOrThrow 保证类型安全
  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>('port'));
}
await bootstrap();

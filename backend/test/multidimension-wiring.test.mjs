import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VectorModule } from '../dist/modules/vector/vector.module.js';
import { VectorService } from '../dist/modules/vector/vector.service.js';
import { EmbeddingBindingService } from '../dist/modules/vector/embedding-binding.service.js';
import { AuditService } from '../dist/modules/admin/audit/audit.service.js';
import { testUrl, withDatabase, uuid } from './helpers/multidim-db.mjs';

test(
  '真实模块依赖可组装，多维度控制器服务不依赖应用全局默认模型',
  { skip: !testUrl },
  async () =>
    withDatabase(async (ds) => {
      class Infra {}
      Global()(Infra);
      Module({
        providers: [
          { provide: DataSource, useValue: ds },
          {
            provide: ConfigService,
            useValue: new ConfigService({
              encryptionKey: 'isolated-test-only',
            }),
          },
          { provide: AuditService, useValue: { log: async () => {} } },
        ],
        exports: [DataSource, ConfigService, AuditService],
      })(Infra);
      const module = await Test.createTestingModule({
        imports: [Infra, VectorModule],
      }).compile();
      try {
        assert.deepEqual(
          await module
            .get(VectorService)
            .hybridSearch([], '问题', 5, [], uuid(1)),
          [],
        );
        await assert.rejects(
          module.get(EmbeddingBindingService).getState(uuid(2)),
          { status: 404 },
        );
      } finally {
        await module.close();
      }
    }),
);

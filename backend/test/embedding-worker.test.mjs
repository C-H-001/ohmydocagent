import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedProcessor } from '../dist/modules/parse/embed.processor.js';
test('outbox 文档任务仍记录向量化时间线', async () => {
  const stages = [];
  const worker = new EmbedProcessor(
    {
      query: async () => [
        {
          knowledgeId: 'doc',
          profileId: null,
          status: 'pending',
          activeEmbeddingProfileId: 'p',
        },
      ],
    },
    { processJob: async () => ({ embedded: 2 }) },
    {
      updateProgress: async (id, data) => {
        assert.equal(id, 'doc');
        stages.push(data.stage.status);
      },
    },
  );
  assert.deepEqual(await worker.process({ data: { embeddingJobId: 'job' } }), {
    embedded: 2,
  });
  assert.deepEqual(stages, ['running', 'done']);
});
test('已完成的持久化任务重复消费不调用模型或污染时间线', async () => {
  const worker = new EmbedProcessor(
    { query: async () => [{ status: 'done' }] },
    { processJob: () => assert.fail('已完成任务不得重做') },
    { updateProgress: () => assert.fail('不得追加阶段') },
  );
  assert.deepEqual(await worker.process({ data: { embeddingJobId: 'job' } }), {
    embedded: 0,
  });
});

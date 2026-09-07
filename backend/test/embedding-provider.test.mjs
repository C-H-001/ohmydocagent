import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { LLMProviderFactory } from '../dist/modules/model/providers/llm-provider.factory.js';
import { OpenAICompatibleProvider } from '../dist/modules/model/providers/openai-compatible.provider.js';
import { OllamaProvider } from '../dist/modules/model/providers/ollama.provider.js';

const config = {
  baseUrl: 'https://example.com',
  apiKey: '',
  modelName: 'test-model',
};
const vectors = [
  [1, 0],
  [0, -2],
];
let requests;
let responseBody;
let rawBody;
let lookups;

// SSRF guard resolves DNS before fetch. Mock both boundaries; never contact a model
// or depend on external DNS. node:test runs these top-level tests sequentially.
beforeEach(() => {
  requests = [];
  lookups = [];
  responseBody = {};
  rawBody = undefined;
  mock.method(dns, 'lookup', async (hostname) => {
    lookups.push(hostname);
    assert.equal(hostname, 'example.com');
    return [{ address: '93.184.215.14', family: 4 }];
  });
  syncBuiltinESMExports();
  mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    return new Response(rawBody ?? JSON.stringify(responseBody), {
      status: 200,
    });
  });
});

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function factory() {
  return new LLMProviderFactory(
    new OpenAICompatibleProvider(),
    new OllamaProvider(),
    { decrypt: () => 'decrypted-key' },
  );
}

function model(extraConfig = {}, overrides = {}) {
  return {
    ...config,
    type: 'embedding',
    provider: 'openai-compatible',
    apiKeyEncrypted: '',
    extraConfig,
    ...overrides,
  };
}

const implementations = [
  [
    'OpenAI',
    OpenAICompatibleProvider,
    (items) => ({ data: items.map((embedding) => ({ embedding })) }),
  ],
  ['Ollama', OllamaProvider, (items) => ({ embeddings: items })],
];

for (const [name, Provider, wrap] of implementations) {
  test(`${name}: empty batch skips DNS and fetch even without bound config`, async () => {
    assert.deepEqual(await new Provider().embed([]), []);
    assert.equal(requests.length, 0);
    assert.equal(lookups.length, 0);
  });

  test(`${name}: accepts finite consistent nonzero vectors and preserves model override`, async () => {
    responseBody = wrap(vectors);
    const provider = new Provider({ ...config, embeddingDimensions: 2 });
    assert.deepEqual(await provider.embed(['a', 'b'], 'other-model'), vectors);
    assert.deepEqual(requests[0].body, {
      model: 'other-model',
      input: ['a', 'b'],
    });
    assert.equal(
      requests[0].url,
      `${config.baseUrl}/${name === 'OpenAI' ? 'embeddings' : 'api/embed'}`,
    );
  });

  const invalid = [
    ['no vectors', []],
    ['too few', [[1, 2]]],
    [
      'too many',
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    ],
    ['empty vector', [[], [1, 2]]],
    ['missing vector', [null, [1, 2]]],
    ['not an array', ['bad', [1, 2]]],
    ['inconsistent dimensions', [[1], [1, 2]]],
    [
      'zero vector',
      [
        [0, -0],
        [1, 2],
      ],
    ],
    [
      'string component',
      [
        ['1', 2],
        [1, 2],
      ],
    ],
    [
      'null component',
      [
        [null, 2],
        [1, 2],
      ],
    ],
    [
      'boolean component',
      [
        [true, 2],
        [1, 2],
      ],
    ],
    [
      'object component',
      [
        [{}, 2],
        [1, 2],
      ],
    ],
  ];
  for (const [reason, items] of invalid) {
    test(`${name}: rejects ${reason}`, async () => {
      responseBody = wrap(items);
      await assert.rejects(
        new Provider(config).embed(['a', 'b']),
        /向量|维度|数量|有限|finite/i,
      );
    });
  }

  test(`${name}: rejects numeric overflow (Infinity after JSON parse)`, async () => {
    rawBody = JSON.stringify(
      wrap([
        [1, 'OVERFLOW'],
        [1, 2],
      ]),
    ).replace('"OVERFLOW"', '1e400');
    await assert.rejects(
      new Provider(config).embed(['a', 'b']),
      /向量|有限|finite/i,
    );
  });

  for (const body of [null, {}, { data: null, embeddings: null }]) {
    test(`${name}: rejects malformed response ${JSON.stringify(body)}`, async () => {
      responseBody = body;
      await assert.rejects(new Provider(config).embed(['a']), /数组|格式/);
    });
  }

  test(`${name}: validates configured output dimensions without enabling override`, async () => {
    responseBody = wrap(vectors);
    const provider = factory().create(
      model(
        { dimensions: 3 },
        {
          provider: name === 'OpenAI' ? 'openai-compatible' : 'ollama',
        },
      ),
    );
    await assert.rejects(provider.embed(['a', 'b']), /维度/);
    assert.equal('dimensions' in requests[0].body, false);
  });

  test(`${name}: chat request stays unchanged despite embedding options`, async () => {
    responseBody = {
      choices: [{ message: { content: 'pong' } }],
      message: { content: 'pong' },
    };
    const provider = new Provider({
      ...config,
      embeddingDimensions: 2,
      supportsDimensionOverride: true,
    });
    assert.equal(
      await provider.chat([{ role: 'user', content: 'ping' }]),
      'pong',
    );
    assert.deepEqual(
      requests[0].body,
      name === 'OpenAI'
        ? {
            model: config.modelName,
            messages: [{ role: 'user', content: 'ping' }],
            temperature: 0.7,
          }
        : {
            model: config.modelName,
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
            options: {},
          },
    );
  });
}

for (const extra of [
  {},
  { dimensions: 2 },
  { dimensions: 2, supportsDimensionOverride: false },
  { supportsDimensionOverride: true },
]) {
  test(`OpenAI: does not send dimensions for ${JSON.stringify(extra)}`, async () => {
    responseBody = { data: [{ embedding: [1, 0] }] };
    await factory().create(model(extra)).embed(['a']);
    assert.equal('dimensions' in requests[0].body, false);
  });
}

for (const dimensions of [1, 2, 4000]) {
  test(`factory/OpenAI: explicitly enabled dimensions=${dimensions} sent upstream`, async () => {
    const vector = Array(dimensions).fill(1);
    responseBody = { data: [{ embedding: vector }] };
    const provider = factory().create(
      model(
        { dimensions, supportsDimensionOverride: true },
        { apiKeyEncrypted: 'cipher' },
      ),
    );
    assert.deepEqual(await provider.embed(['a']), [vector]);
    assert.equal(requests[0].body.dimensions, dimensions);
    assert.equal(requests[0].headers.Authorization, 'Bearer decrypted-key');
  });
}

for (const dimensions of [
  0,
  -1,
  1.5,
  4001,
  '2',
  null,
  true,
  NaN,
  Infinity,
  {},
  [],
]) {
  test(`factory: rejects dimensions ${String(dimensions)}`, () => {
    assert.throws(
      () => factory().create(model({ dimensions })),
      /dimensions|维度/,
    );
  });
}

for (const flag of ['true', 'false', 0, 1, null, {}, []]) {
  test(`factory: rejects nonboolean override ${JSON.stringify(flag)}`, () => {
    assert.throws(
      () => factory().create(model({ supportsDimensionOverride: flag })),
      /supportsDimensionOverride|boolean|布尔/,
    );
  });
}

for (const type of ['chat', 'rerank']) {
  test(`factory: does not read embedding config for ${type}`, () => {
    const extra = {
      get dimensions() {
        throw new Error('must not read dimensions');
      },
      get supportsDimensionOverride() {
        throw new Error('must not read override');
      },
    };
    const capture = { withConfig: (value) => value };
    const f = new LLMProviderFactory(capture, capture, {});
    assert.deepEqual(f.create(model(extra, { type })), config);
  });
}

test('OpenAI: indexed responses reorder vectors and preserve usage', async () => {
  responseBody = {
    data: [
      { index: 1, embedding: vectors[1] },
      { index: 0, embedding: vectors[0] },
    ],
    usage: { total_tokens: 7 },
  };
  const provider = new OpenAICompatibleProvider(config);
  assert.deepEqual(await provider.embedWithUsage(['a', 'b']), {
    vectors,
    totalTokens: 7,
  });
  assert.deepEqual(await provider.embed(['a', 'b']), vectors);
});

for (const indices of [
  [0, 0],
  [0, 2],
  [-1, 1],
  [0.5, 1],
  ['0', 1],
  [null, 1],
  [undefined, 1],
]) {
  test(`OpenAI: rejects invalid or partial indices ${JSON.stringify(indices)}`, async () => {
    responseBody = {
      data: indices.map((index, i) => ({ index, embedding: vectors[i] })),
    };
    await assert.rejects(
      new OpenAICompatibleProvider(config).embed(['a', 'b']),
      /index|索引/,
    );
  });
}

test('OpenAI: rejects malformed data entry', async () => {
  responseBody = { data: [null] };
  await assert.rejects(
    new OpenAICompatibleProvider(config).embed(['a']),
    /向量|格式/,
  );
});

test('OpenAI: embedWithUsage shares validation and empty batch handling', async () => {
  assert.deepEqual(await new OpenAICompatibleProvider().embedWithUsage([]), {
    vectors: [],
    totalTokens: 0,
  });
  assert.equal(requests.length, 0);
  responseBody = { data: [{ embedding: [0, 0] }] };
  await assert.rejects(
    new OpenAICompatibleProvider(config).embedWithUsage(['a']),
    /向量/,
  );
});

test('Ollama: configured override is rejected before DNS or fetch', async () => {
  responseBody = { embeddings: [[1, 0]] };
  await assert.rejects(async () => {
    const provider = factory().create(
      model(
        { dimensions: 2, supportsDimensionOverride: true },
        { provider: 'ollama' },
      ),
    );
    await provider.embed(['a']);
  }, /Ollama.*(?:override|dimensions|维度|支持)/);
  assert.equal(requests.length, 0);
  assert.equal(lookups.length, 0);
});

test('Ollama: directly bound override is rejected even without dimensions', async () => {
  await assert.rejects(
    new OllamaProvider({ ...config, supportsDimensionOverride: true }).embed([
      'a',
    ]),
    /Ollama.*(?:override|dimensions|维度|支持)/,
  );
  assert.equal(requests.length, 0);
  assert.equal(lookups.length, 0);
});

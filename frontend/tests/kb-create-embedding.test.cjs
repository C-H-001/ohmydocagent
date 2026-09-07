// Run from the repository root: node --test --test-isolation=none frontend/tests/kb-create-embedding.test.cjs
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { JSDOM } = require('jsdom')

for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
    })
    module._compile(outputText, filename)
  }
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { MemoryRouter } = require('react-router-dom')
const { AuthProvider } = require('../src/store/auth.tsx')
const KnowledgeBasesView = require('../src/views/kb/KnowledgeBasesView.tsx').default
const ownerId = '11111111-1111-4111-8111-111111111111'
const firstId = '22222222-2222-4222-8222-222222222222'
const secondId = '33333333-3333-4333-8333-333333333333'
const model = (overrides = {}) => ({ id: firstId, name: '我的嵌入模型', modelName: 'embed-real-v1', userId: ownerId, enabled: true, type: 'embedding', isDefault: false, provider: 'openai-compatible', baseUrl: '', apiKeyEncrypted: '', extraConfig: { dimensions: 768 }, createdAt: '', updatedAt: '', ...overrides })
let root, container, requests, modelResponse
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url), 'http://localhost')
  const path = parsed.pathname.replace('/api/v1', '')
  const body = options.body ? JSON.parse(options.body) : undefined
  requests.push({ path, query: parsed.search, method: options.method, body })
  let result
  if (path === '/auth/me') result = { id: ownerId, name: '创建者', email: 'owner@example.com', role: 'member', createdAt: '', updatedAt: '' }
  else if (path === '/auth/init-status') result = { initialized: true }
  else if (path === '/models') result = await modelResponse()
  else if (path === '/kbs' && options.method === 'GET') result = { items: [], total: 0, page: 1, pageSize: 100 }
  else if (path === '/kbs' && options.method === 'POST') result = { ...body, id: 'created-kb' }
  else throw new Error(`Unexpected request: ${options.method} ${path}`)
  return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
}
async function mount() {
  requests = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(AuthProvider, null, React.createElement(KnowledgeBasesView)))))
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = null
})
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text)
const radio = id => [...container.querySelectorAll('input[name="embedding"]')].find(el => el.value === id)
const created = () => requests.filter(r => r.path === '/kbs' && r.method === 'POST')
async function click(el) { assert.ok(el, 'control must exist'); await act(async () => el.click()) }
async function change(el, value) {
  assert.ok(el, 'input must exist')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function toModels() {
  await click(button('新建知识库'))
  await change(container.querySelector('input[placeholder="例如：技术文档库 / 产品需求库"]'), '研究资料')
  await click(button('下一步'))
  await click(button('下一步'))
}
async function toFinal() { await click(button('下一步')); await click(button('下一步')) }
async function closeWizard() { await click(container.querySelector('h2').parentElement.parentElement.querySelector('button')) }

test('loads on open and lists only own enabled embedding models with API names and dimensions', async () => {
  modelResponse = () => [model(), model({ id: secondId, name: '自动维度模型', modelName: 'embed-auto', extraConfig: {} }), model({ id: 'other', userId: 'someone-else' }), model({ id: 'global', userId: null }), model({ id: 'disabled', enabled: false }), model({ id: 'chat', type: 'chat' })]
  await mount()
  assert.equal(requests.some(r => r.path === '/models'), false)
  await click(button('新建知识库'))
  assert.deepEqual(requests.filter(r => r.path === '/models').map(r => r.query), ['?type=embedding'])
  await change(container.querySelector('input[placeholder="例如：技术文档库 / 产品需求库"]'), '研究资料')
  await click(button('下一步')); await click(button('下一步'))
  assert.deepEqual([...container.querySelectorAll('input[name="embedding"]')].map(el => el.value), [firstId, secondId])
  assert.match(container.textContent, /我的嵌入模型/)
  assert.match(container.textContent, /embed-real-v1/)
  assert.match(container.textContent, /768 维/)
  assert.match(container.textContent, /自动维度模型/)
  assert.doesNotMatch(container.textContent, /绑定|预留|仅作展示|dim=/)
})

test('requires a selection when no default exists and posts the selected model ID', async () => {
  modelResponse = () => [model()]
  await mount(); await toModels()
  assert.equal(button('下一步').disabled, true)
  await click(button('下一步'))
  assert.match(container.textContent, /步骤 3 \/ 5/)
  assert.equal(created().length, 0)
  await click(radio(firstId))
  await toFinal(); await click(button('创建知识库'))
  assert.equal(created().length, 1)
  assert.equal(created()[0].body.embeddingModelId, firstId)
  assert.equal(created()[0].body.name, '研究资料')
  assert.equal('embeddingModel' in created()[0].body, false)
})

test('blocks model step while loading or empty and allows retry', async () => {
  let resolveModels
  modelResponse = () => new Promise(resolve => { resolveModels = resolve })
  await mount(); await toModels()
  assert.equal(button('下一步').disabled, true)
  assert.match(container.textContent, /加载/)
  await act(async () => resolveModels([]))
  assert.match(container.textContent, /暂无.*模型/)
  assert.equal(button('下一步').disabled, true)
  assert.equal(created().length, 0)
  modelResponse = () => [model({ isDefault: true })]
  await click(button('重试'))
  assert.equal(radio(firstId)?.checked, true)
  assert.equal(button('下一步').disabled, false)
})

test('model load failure blocks creation until retry succeeds', async () => {
  modelResponse = () => new Response(JSON.stringify({ message: '模型服务不可用' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  await mount(); await toModels()
  assert.equal(button('下一步').disabled, true)
  assert.match(container.textContent, /模型.*失败|模型服务不可用/)
  await click(button('下一步'))
  assert.equal(created().length, 0)
  modelResponse = () => [model({ isDefault: true })]
  await click(button('重试'))
  await toFinal(); await click(button('创建知识库'))
  assert.equal(created()[0].body.embeddingModelId, firstId)
})

test('reopening preserves a valid selection and replaces an invalid one with a real default', async () => {
  modelResponse = () => [model({ isDefault: true }), model({ id: secondId, name: '另一个模型', modelName: 'another-real' })]
  await mount(); await toModels()
  assert.equal(radio(firstId)?.checked, true)
  await click(radio(secondId)); await closeWizard(); await toModels()
  assert.equal(radio(secondId)?.checked, true)
  await closeWizard()
  modelResponse = () => [model({ isDefault: true })]
  await toModels()
  assert.equal(radio(firstId)?.checked, true)
})

test('late model response from a closed wizard cannot overwrite a reopened wizard', async () => {
  let resolveOld
  modelResponse = () => new Promise(resolve => { resolveOld = resolve })
  await mount(); await toModels(); await closeWizard()
  modelResponse = () => [model({ id: secondId, name: '最新模型', isDefault: true })]
  await toModels()
  await act(async () => resolveOld([model({ isDefault: true })]))
  assert.deepEqual([...container.querySelectorAll('input[name="embedding"]')].map(el => el.value), [secondId])
  assert.equal(radio(secondId)?.checked, true)
})

test('final submit is blocked when a reopened wizard is reloading or loses its selected model', async () => {
  modelResponse = () => [model({ isDefault: true })]
  await mount(); await toModels(); await toFinal(); await closeWizard()
  let resolveModels
  modelResponse = () => new Promise(resolve => { resolveModels = resolve })
  // The existing empty-state entry keeps the previous wizard step.
  await click([...container.querySelectorAll('button')].filter(el => el.textContent.trim() === '新建知识库')[1])
  assert.match(container.textContent, /步骤 5 \/ 5/)
  assert.equal(button('创建知识库').disabled, true)
  await click(button('创建知识库'))
  await act(async () => resolveModels([]))
  assert.equal(button('创建知识库').disabled, true)
  await click(button('创建知识库'))
  assert.equal(created().length, 0)
})

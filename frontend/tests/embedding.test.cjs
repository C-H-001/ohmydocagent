// Run from the repository root (Node 24): node --test --test-isolation=none frontend/tests/embedding.test.cjs
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
const SettingsView = require('../src/views/settings/SettingsView.tsx').default
let root, container, requests
const user = { id: 'me', name: '测试用户', email: 'me@example.com', role: 'member', createdAt: '', updatedAt: '' }
let sessionUser = user
let respond
globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace('/api/v1', '')
  const body = options.body ? JSON.parse(options.body) : undefined
  requests.push({ path, method: options.method, body })
  let result
  if (path === '/auth/me') result = sessionUser
  else if (path === '/auth/init-status') result = { initialized: true }
  else result = await respond(path, options.method, body)
  return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
}
async function mount(component, authUser = user) {
  sessionUser = authUser
  requests = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(AuthProvider, null, component))))
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = null
})
function button(text) { return [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text) }
async function click(el) { assert.ok(el, 'control should exist'); await act(async () => el.click()) }
async function change(el, value) {
  assert.ok(el, 'input should exist')
  await act(async () => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

test('embedding model creation exposes optional dimensions and saves both settings', async () => {
  respond = () => []
  await mount(React.createElement(SettingsView))
  await click(button('模型管理'))
  await click(button('新增模型'))
  await change([...container.querySelectorAll('select')].find(el => el.value === 'chat'), 'embedding')
  const dimension = container.querySelector('input[aria-label="输出维度"]')
  assert.ok(dimension, 'embedding models need an output dimension input')
  await change(dimension, '1024')
  await click(container.querySelector('[role="switch"][aria-label="模型支持指定输出维度"]'))
  await change(container.querySelector('input[placeholder="例如：DeepSeek V3"]'), '向量模型')
  await change(container.querySelector('input[placeholder^="deepseek-chat"]'), 'embed-v1')
  await click(button('保存'))
  assert.deepEqual(requests.find(r => r.method === 'POST' && r.path === '/models').body.extraConfig, { dimensions: 1024, supportsDimensionOverride: true })
})

const profile = { id: 'profile-1', modelId: 'embed-1', modelName: '当前模型', dimension: 768 }
const state = (overrides = {}) => ({ active: profile, pending: null, previous: null, totalChunks: 3, indexedChunks: 3, pendingIndexedChunks: 0, legacyChunks: 0, error: null, status: 'ready', ...overrides })
const model = (overrides = {}) => ({ id: 'embed-1', name: '我的向量模型', modelName: 'embed-v1', type: 'embedding', enabled: true, userId: 'me', provider: 'openai-compatible', baseUrl: '', apiKeyEncrypted: '', isDefault: false, extraConfig: {}, createdAt: '', updatedAt: '', ...overrides })
const embeddingComponent = (permission = 'full', kbId = 'kb-1', creatorId = 'me') => React.createElement(require('../src/views/kb/EmbeddingSettings.tsx').default, { kbId, permission, creatorId })

test('embedding endpoints use the contract methods and bodies', async () => {
  const { embeddingApi } = require('../src/api/kb.ts')
  assert.ok(embeddingApi, 'embedding API must be available')
  requests = []
  respond = () => state()
  await embeddingApi.get('kb-1')
  await embeddingApi.rebuild('kb-1', 'embed-1')
  await embeddingApi.activate('kb-1')
  await embeddingApi.rollback('kb-1')
  await embeddingApi.cancel('kb-1')
  assert.deepEqual(requests, [
    { path: '/kbs/kb-1/embedding', method: 'GET', body: undefined },
    { path: '/kbs/kb-1/embedding/rebuild', method: 'POST', body: { modelId: 'embed-1' } },
    { path: '/kbs/kb-1/embedding/activate', method: 'POST', body: {} },
    { path: '/kbs/kb-1/embedding/rollback', method: 'POST', body: {} },
    { path: '/kbs/kb-1/embedding/cancel', method: 'POST', body: {} },
  ])
})

test('members see the binding and dimension without management controls or model requests', async () => {
  for (const permission of ['view', 'edit', 'admin', undefined]) {
    respond = () => state()
    await mount(embeddingComponent(permission ?? 'unknown'))
    assert.match(container.textContent, /当前模型/)
    assert.match(container.textContent, /768/)
    assert.equal(container.querySelector('select'), null)
    assert.equal(button('重建向量'), undefined)
    assert.equal(requests.filter(r => r.path.startsWith('/models')).length, 0)
    await act(async () => root.unmount())
    root = null
    container.remove()
  }
})

test('owner changes the model through rebuild only, and applies the completed result', async () => {
  let current = state({ active: null, indexedChunks: 0, legacyChunks: 3, status: 'unbound' })
  respond = (path, method) => {
    if (path.startsWith('/models')) return [model(), model({ id: 'disabled', enabled: false }), model({ id: 'other', userId: 'other' }), model({ id: 'public', userId: null }), model({ id: 'chat', type: 'chat' })]
    if (method === 'POST' && path.endsWith('/rebuild')) current = state({ active: null, pending: profile, indexedChunks: 0, pendingIndexedChunks: 3, status: 'ready' })
    if (method === 'POST' && path.endsWith('/activate')) current = state()
    return current
  }
  await mount(embeddingComponent())
  assert.equal(container.querySelector('select') === null, true, 'current configuration is read-only')
  assert.equal(requests.filter(r => r.path.startsWith('/models')).length, 0)
  await click(button('重建向量'))
  const select = container.querySelector('select')
  assert.deepEqual([...select.options].map(o => o.value), ['', 'embed-1'])
  await change(select, 'embed-1')
  assert.equal(requests.filter(r => r.method === 'POST').length, 0, 'selecting a model must not change the live configuration')
  await click(button('开始重建'))
  assert.deepEqual(requests.find(r => r.path.endsWith('/rebuild')).body, { modelId: 'embed-1' })
  assert.equal(requests.filter(r => r.path.endsWith('/activate')).length, 0)
  assert.equal(container.querySelector('select'), null)
  await click(button('应用重建结果'))
  assert.match(container.textContent, /当前模型/)
  assert.equal(button('应用重建结果'), undefined)
})

test('editing a model preserves unrelated extraConfig and blank dimensions remove the override', async () => {
  const saved = model({ extraConfig: { dimensions: 768, supportsDimensionOverride: true, batchSize: 16, nested: { custom: true } } })
  respond = () => [saved]
  await mount(React.createElement(SettingsView))
  await click(button('模型管理'))
  await click(container.querySelector('button[aria-label="编辑模型"]'))
  assert.equal(container.querySelector('input[aria-label="输出维度"]').value, '768')
  assert.equal(container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true')
  await change(container.querySelector('input[aria-label="输出维度"]'), '')
  await click(button('保存'))
  const payload = requests.find(r => r.method === 'PUT' && r.path === '/models/embed-1').body
  assert.deepEqual(payload.extraConfig, { supportsDimensionOverride: true, batchSize: 16, nested: { custom: true } })
  assert.equal('apiKey' in payload, false)
  assert.deepEqual(saved.extraConfig, { dimensions: 768, supportsDimensionOverride: true, batchSize: 16, nested: { custom: true } })
})

test('invalid dimensions block save and connection test; 1 and 4000 are accepted', async () => {
  respond = (path) => path === '/models/test' ? { ok: true } : []
  await mount(React.createElement(SettingsView))
  await click(button('模型管理'))
  await click(button('新增模型'))
  await change([...container.querySelectorAll('select')].find(el => el.value === 'chat'), 'embedding')
  await change(container.querySelector('input[placeholder="例如：DeepSeek V3"]'), '向量模型')
  await change(container.querySelector('input[placeholder^="deepseek-chat"]'), 'embed-v1')
  for (const value of ['0', '-1', '4001', '1.5', '1e3', 'abc']) {
    await change(container.querySelector('input[aria-label="输出维度"]'), value)
    await click(button('保存'))
    await click(button('测试连通'))
  }
  assert.equal(requests.filter(r => r.method === 'POST').length, 0)
  for (const value of ['1', '4000']) {
    await change(container.querySelector('input[aria-label="输出维度"]'), value)
    await click(button('测试连通'))
  }
  assert.deepEqual(requests.filter(r => r.method === 'POST').map(r => r.body.extraConfig.dimensions), [1, 4000])
})

test('chat and rerank edits remove embedding fields and retain other extraConfig', async () => {
  for (const type of ['chat', 'rerank']) {
    respond = () => [model({ type, extraConfig: { dimensions: 768, supportsDimensionOverride: true, custom: 42 } })]
    await mount(React.createElement(SettingsView))
    await click(button('模型管理'))
    await click(container.querySelector('button[aria-label="编辑模型"]'))
    assert.equal(container.querySelector('input[aria-label="输出维度"]'), null)
    await click(button('保存'))
    assert.deepEqual(requests.find(r => r.method === 'PUT').body.extraConfig, { custom: 42 })
    await act(async () => root.unmount())
    root = null
    container.remove()
  }
})

test('switching the add form from embedding to chat or rerank strips embedding settings', async () => {
  respond = () => []
  await mount(React.createElement(SettingsView))
  await click(button('模型管理'))
  await click(button('新增模型'))
  const type = [...container.querySelectorAll('select')].find(el => el.value === 'chat')
  await change(type, 'embedding')
  await change(container.querySelector('input[aria-label="输出维度"]'), '1024')
  await click(container.querySelector('[role="switch"]'))
  await change(container.querySelector('input[placeholder="例如：DeepSeek V3"]'), '模型')
  await change(container.querySelector('input[placeholder^="deepseek-chat"]'), 'model-v1')
  for (const target of ['chat', 'rerank']) {
    await change(type, target)
    await click(button('测试连通'))
  }
  assert.deepEqual(requests.filter(r => r.path === '/models/test').map(r => r.body.extraConfig), [{}, {}])
})

test('building polls no faster than 5 seconds and stops at ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let gets = 0
  respond = path => path.startsWith('/models') ? [model()] : (++gets < 3 ? state({ pending: profile, pendingIndexedChunks: 1, status: 'building' }) : state({ pending: profile, pendingIndexedChunks: 3 }))
  await mount(embeddingComponent())
  assert.equal(button('应用重建结果').disabled, true)
  await act(async () => t.mock.timers.tick(4999))
  assert.equal(gets, 1)
  await act(async () => t.mock.timers.tick(1))
  assert.equal(gets, 2)
  await act(async () => t.mock.timers.tick(5000))
  assert.equal(gets, 3)
  assert.equal(button('应用重建结果').disabled, false)
  await act(async () => t.mock.timers.tick(20000))
  assert.equal(gets, 3)
})

test('unmounting a building component stops its polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  respond = path => path.startsWith('/models') ? [model()] : state({ pending: profile, status: 'building' })
  await mount(embeddingComponent())
  await act(async () => root.unmount())
  root = null
  const count = requests.length
  await act(async () => t.mock.timers.tick(20000))
  assert.equal(requests.length, count)
})

test('cancelling a rebuild keeps the current configuration and does not invoke rollback', async () => {
  const previous = { ...profile, id: 'old', modelName: '上一模型', dimension: 512 }
  let current = state({ pending: { ...profile, id: 'next' }, previous, status: 'failed', error: '上游向量请求失败' })
  respond = (path, method) => {
    if (path.startsWith('/models')) return [model()]
    if (method === 'POST' && path.endsWith('/cancel')) current = state({ previous })
    if (method === 'POST' && path.endsWith('/rollback')) current = state({ active: previous, previous: profile })
    return current
  }
  await mount(embeddingComponent())
  assert.match(container.querySelector('[role="alert"]').textContent, /上游向量请求失败/)
  assert.equal(button('应用重建结果').disabled, true)
  await click(button('取消重建'))
  assert.match(container.querySelector('dl').textContent, /当前向量库设置：当前模型 · 768 维/)
  assert.equal(button('取消重建'), undefined)
  assert.equal(requests.filter(r => r.path.endsWith('/rollback')).length, 0)
})

test('server refusal to activate keeps the active binding and reports the API error', async () => {
  const { ToastHost } = require('../src/components/ui.tsx')
  respond = (path, method) => {
    if (path.startsWith('/models')) return [model()]
    if (method === 'POST') return new Response(JSON.stringify({ message: '索引尚未就绪' }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    return state({ pending: { ...profile, id: 'next', dimension: 1024 }, pendingIndexedChunks: 3 })
  }
  await mount(React.createElement(React.Fragment, null, embeddingComponent(), React.createElement(ToastHost)))
  await click(button('应用重建结果'))
  assert.match(container.textContent, /索引尚未就绪/)
  assert.match(container.querySelector('dl').textContent, /当前向量库设置：当前模型 · 768 维/)
  assert.ok(button('应用重建结果'))
})

test('a late poll cannot overwrite a successful cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolvePoll, gets = 0
  respond = (path, method) => {
    if (path.startsWith('/models')) return [model()]
    if (method === 'POST') return state()
    if (++gets === 2) return new Promise(resolve => { resolvePoll = resolve })
    return state({ pending: profile, status: 'building' })
  }
  await mount(embeddingComponent())
  await act(async () => t.mock.timers.tick(5000))
  await click(button('取消重建'))
  await act(async () => resolvePoll(state({ pending: profile, status: 'building' })))
  assert.equal(button('取消重建'), undefined)
  await act(async () => t.mock.timers.tick(10000))
  assert.equal(gets, 2)
})

test('a non-creator super with full permission is read-only and does not load models', async () => {
  respond = path => path.startsWith('/models') ? [model()] : state({ pending: profile, previous: profile })
  await mount(embeddingComponent('full', 'kb-1', 'other-owner'), { ...user, role: 'super' })
  assert.match(container.querySelector('dl').textContent, /当前向量库设置：当前模型 · 768 维/)
  assert.equal(container.querySelector('select') === null, true, 'non-creator super must not see a model selector')
  for (const label of ['重建向量', '开始重建', '应用重建结果', '取消重建']) {
    assert.equal(button(label) === undefined, true, `non-creator super must not see ${label}`)
  }
  assert.equal(requests.filter(r => r.path.startsWith('/models') || r.method === 'POST').length, 0)
})

test('closing the model selection does not start a rebuild or change the current configuration', async () => {
  respond = (path, method) => {
    if (path.startsWith('/models')) return [model()]
    return state()
  }
  await mount(embeddingComponent())
  await click(button('重建向量'))
  await change(container.querySelector('select'), 'embed-1')
  await click(button('取消'))
  assert.equal(container.querySelector('select'), null)
  assert.equal(requests.filter(r => r.method === 'POST').length, 0)
  assert.match(container.querySelector('dl').textContent, /当前向量库设置：当前模型 · 768 维/)
})

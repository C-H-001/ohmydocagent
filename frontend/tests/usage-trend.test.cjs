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
class ResizeObserver {
  constructor(callback) { this.callback = callback }
  observe(target) { this.callback([{ target, contentRect: { width: 800, height: 300 } }]) }
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
})
window.ResizeObserver = ResizeObserver
window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300 })
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { MemoryRouter } = require('react-router-dom')
const { AuthProvider } = require('../src/store/auth.tsx')
const SettingsView = require('../src/views/settings/SettingsView.tsx').default
const { UsageTrendChart } = require('../src/views/settings/UsageTrendChart.tsx')
const { usageApi } = require('../src/api/settings.ts')
const days = [
  { date: '2026-09-05', models: { alpha: { name: '模型 A', calls: 2, tokens: 200 } } },
  { date: '2026-09-06', models: { alpha: { name: '模型 A', calls: 1, tokens: 100 }, beta: { name: '模型 B', calls: 4, tokens: 400 } } },
]
let respond, requests, root, container
globalThis.fetch = async (url) => {
  const path = String(url).replace('/api/v1', '')
  requests.push(path)
  let body
  if (path === '/auth/me') body = { id: 'me', name: '测试用户', email: 'me@example.com', role: 'member' }
  else if (path === '/auth/init-status') body = { initialized: true }
  else if (path === '/me/model-usage') body = { items: [], totalCalls: 7, totalTokens: 700 }
  else if (path.startsWith('/me/model-usage/trend')) body = await respond(path)
  else body = []
  return body instanceof Response ? body : new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
async function mount(element) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(element))
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = null
  container?.remove()
})

test('趋势 API 按生产协议解包 items 数组，并传递 days 参数', async () => {
  requests = []; respond = () => ({ items: days })
  assert.deepEqual(await usageApi.trend(14), days)
  assert.deepEqual(requests, ['/me/model-usage/trend?days=14'])
})

test('完整模型用量页使用真实图表和 API 适配器渲染包装响应', async () => {
  requests = []; respond = () => ({ items: days })
  await mount(React.createElement(MemoryRouter, null, React.createElement(AuthProvider, null, React.createElement(SettingsView))))
  const tab = [...container.querySelectorAll('button')].find(el => el.textContent.trim() === '模型用量')
  assert.ok(tab, '用量入口必须可用')
  await act(async () => tab.click())
  assert.match(container.textContent, /每日用量趋势/)
  assert.match(container.textContent, /模型 A/)
  assert.match(container.textContent, /模型 B/)
  assert.match(container.textContent, /区间调用总量7 次/)
  assert.match(container.textContent, /单日峰值5 次/)
  assert.ok(container.querySelector('svg.recharts-surface'), '应渲染真实图表')
  const token = [...container.querySelectorAll('button')].find(el => el.textContent.trim() === 'Token')
  await act(async () => token.click())
  assert.match(container.textContent, /区间Token总量700/)
})

test('合法空趋势响应显示空状态而非页面异常', async () => {
  requests = []; respond = () => ({ items: [] })
  await mount(React.createElement(UsageTrendChart))
  assert.match(container.textContent, /暂无趋势数据/)
})

test('格式异常不会进入图表状态，页面显示错误且重试后能恢复', async () => {
  requests = []; respond = () => ({ items: null })
  await mount(React.createElement(UsageTrendChart))
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /数据格式/)
  respond = () => ({ items: days })
  const retry = [...container.querySelectorAll('button')].find(el => el.textContent.trim() === '重试')
  assert.ok(retry)
  await act(async () => retry.click())
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.match(container.textContent, /区间调用总量7 次/)
})

test('HTTP 失败保留局部错误提示，不使整个设置页崩溃', async () => {
  requests = []; respond = () => new Response(JSON.stringify({ message: '用量服务暂不可用' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  await mount(React.createElement(UsageTrendChart))
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /用量服务暂不可用/)
})

test('趋势适配器拒绝缺失或损坏的日期、模型和数值字段', async () => {
  for (const payload of [null, {}, days, { items: [null] }, { items: [{ date: '2026-09-06', models: null }] },
    { items: [{ date: '2026-09-06', models: { alpha: { calls: '2', tokens: 100 } } }] }]) {
    requests = []; respond = () => payload
    await assert.rejects(usageApi.trend(), /用量趋势数据格式异常/)
  }
})

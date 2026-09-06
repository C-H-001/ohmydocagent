const BASE = "http://127.0.0.1:3000/api/v1";
async function main() {
  const login = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "eval-local@docmind.local", password: "EvalLocal2026!" }) })).json();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${login.accessToken}` };
  // 找 KB 发对话（产生 usage_event）
  const kbs = await (await fetch(`${BASE}/kbs`, { headers: H })).json();
  const kb = (kbs.items || [])[0];
  if (kb) {
    const sess = await (await fetch(`${BASE}/chat/sessions`, { method: "POST", headers: H, body: JSON.stringify({ title: "trend-test" }) })).json();
    const resp = await fetch(`${BASE}/chat/sessions/${sess.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content: "1+1=? 只回答数字", webSearchEnabled: false }) });
    await resp.text();
    console.log("对话发送（应产生 usage_event）");
  }
  await new Promise(r => setTimeout(r, 3000));
  const t = await (await fetch(`${BASE}/me/model-usage/trend?days=7`, { headers: H })).json();
  const items = t.items || [];
  console.log("trend 天数:", items.length);
  const last = items[items.length - 1];
  console.log("最后一天:", last.date, "| 模型数:", Object.keys(last.models).length);
  for (const [id, p] of Object.entries(last.models)) {
    console.log("  ", id.slice(0,8), "calls:", p.calls, "tokens:", p.tokens, "name:", p.name);
  }
}
main().catch(e => console.log("ERR:", e.message.slice(0, 120)));

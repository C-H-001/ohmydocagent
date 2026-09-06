const BASE = "http://127.0.0.1:3000/api/v1";
async function main() {
  const login = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "eval-local@docmind.local", password: "EvalLocal2026!" }) })).json();
  const H = { Authorization: `Bearer ${login.accessToken}` };
  const kbs = await (await fetch(`${BASE}/kbs`, { headers: H })).json();
  const kb = (kbs.items || [])[0];
  const sess = await (await fetch(`${BASE}/chat/sessions`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ title: "u2" }) })).json();
  // 读 SSE 流看 usage
  const resp = await fetch(`${BASE}/chat/sessions/${sess.id}/messages`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ content: "2+2=?", webSearchEnabled: false }) });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith("data:")) continue;
      try { const ev = JSON.parse(l.slice(5).trim()); if (ev.type === "done") usage = ev.usage; } catch {}
    }
  }
  console.log("done usage:", JSON.stringify(usage));
}
main().catch(e => console.log("ERR:", e.message.slice(0, 150)));

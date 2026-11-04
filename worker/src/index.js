// 家庭旅遊手帳 — AI 中繼伺服器（Cloudflare Worker）
//
// 為什麼需要它：AI 的 API 金鑰不能放在 GitHub Pages 的網頁裡（等於公開給所有人）。
// 金鑰只存在這個 Worker 的 Secret，網頁透過這裡呼叫 AI。預設用 Gemini，也可以切換成 Claude。
//
// 安全機制：
// 1. 只接受 ALLOWED_ORIGINS 列出的網址（你的 GitHub Pages）。
// 2. 每個請求都要帶 Firebase 憑證（ID token），這裡會驗證簽章，並確認是家人：Email 在 FAMILY_EMAILS 名單內，或帶著正確的家庭代碼（FAMILY_KEY）。
// 3. 只做五種固定任務（推薦機場、推薦餐廳景點、排一天的行程路線、計算地點之間的交通、把想去清單排進哪一天、推薦當地必買），提示詞在伺服器端組好，不能拿來當通用聊天機器人。
// 4. 限制回覆長度；可選擇綁定 KV 做每人每日次數上限。
//
// 需要設定的環境變數（wrangler.toml 的 [vars] 或 Cloudflare 後台）：
//   FIREBASE_PROJECT_ID  Firebase 專案 ID
//   FAMILY_EMAILS        家人的 Google 帳號 Email，用逗號分隔
//   ALLOWED_ORIGINS      允許的網址，用逗號分隔，例如 https://你的帳號.github.io
//   AI_PROVIDER          gemini（預設）或 claude
//   GEMINI_MODEL         （選填）預設 gemini-3.8-flash
//   CLAUDE_MODEL         （選填）預設 claude-sonnet-5-5
//   DAILY_LIMIT          （選填）每人每日次數，預設 40；需綁定 KV「USAGE」才會生效
// Secret（用 `npx wrangler secret put 名稱` 設定，不要寫進檔案）：
//   GEMINI_API_KEY       使用 Gemini 時
//   ANTHROPIC_API_KEY    使用 Claude 時
//   FAMILY_KEY           （選填）家庭連結的代碼，和 Firebase 規則裡的一樣，至少 16 個字元
//   DRIVE_SECRET         （選填）自動存到 Google 雲端硬碟用，要和 Apps Script 的 SECRET 一樣
// 自動存到 Google 雲端硬碟（選填）：
//   DRIVE_SCRIPT_URL     Apps Script 部署後的網址（https://script.google.com/macros/s/…/exec）

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache = { keys: null, exp: 0 };

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = list(env.ALLOWED_ORIGINS);
    const cors = allowed.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Family-Key", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400" }
      : {};
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

    if (req.method === "OPTIONS") return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === "/health") return reply(200, { ok: true });
    if (req.method !== "POST" || !["/ai", "/drive"].includes(url.pathname)) return reply(404, { error: "not_found" });
    if (!allowed.includes(origin)) return reply(403, { error: "bad_origin" });

    // 1) 驗證 Firebase 登入
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    let claims;
    try { claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); }
    catch (e) { return reply(401, { error: "bad_token" }); }
    const email = String(claims.email || "").toLowerCase();
    const byEmail = !!claims.email_verified && list(env.FAMILY_EMAILS).map(s => s.toLowerCase()).includes(email);
    const byLink = String(env.FAMILY_KEY || "").length >= 16 && sameText(req.headers.get("X-Family-Key") || "", env.FAMILY_KEY);
    if (!byEmail && !byLink) return reply(403, { error: "not_family" });

    // 存到 Google 雲端硬碟（轉給你自己的 Apps Script）
    if (url.pathname === "/drive") return driveProxy(req, env, reply, byEmail ? email : "家庭連結");

    // 2) 每日次數（選填，需綁定 KV：USAGE）
    if (env.USAGE) {
      const key = `u:${claims.sub}:${new Date().toISOString().slice(0, 10)}`;
      const used = Number(await env.USAGE.get(key)) || 0;
      if (used >= (Number(env.DAILY_LIMIT) || 40)) return reply(429, { error: "daily_limit" });
      await env.USAGE.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
    }

    // 3) 組提示詞
    let body;
    try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
    const p = clean(body?.params || {});
    let prompt;
    if (body?.task === "airports") prompt = airportsPrompt(p);
    else if (body?.task === "suggest") prompt = suggestPrompt(p);
    else if (body?.task === "dayplan") prompt = dayplanPrompt(p);
    else if (body?.task === "legs") prompt = legsPrompt(p);
    else if (body?.task === "wishplan") prompt = wishPrompt(p);
    else if (body?.task === "shopping") prompt = shopPrompt(p);
    else return reply(400, { error: "bad_task" });

    // 4) 呼叫 AI（預設 Gemini；AI_PROVIDER = "claude" 時改用 Claude）
    let text;
    try { text = (env.AI_PROVIDER || "gemini").toLowerCase() === "claude" ? await callClaude(env, prompt) : await callGemini(env, prompt); }
    catch (e) { console.log("ai error", e.message); return reply(502, { error: e.message === "busy" ? "busy" : "upstream" }); }
    const json = extractJson(text);
    if (!json) return reply(502, { error: "bad_output" });
    return reply(200, json);
  },
};

const SYSTEM = "你是熟悉台灣旅客需求的旅遊規劃師，回答一律使用台灣繁體中文。只推薦實際存在、你有把握的地點與航線，不確定就不要列出。只輸出要求的 JSON，不要任何其他文字或 Markdown。";

/* ---------- Gemini（Google AI Studio 的 API 金鑰） ---------- */
async function callGemini(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error("no_key");
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const headers = { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" };
  // 新版 Interactions API
  let r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST", headers,
    body: JSON.stringify({ model, system_instruction: SYSTEM, input: prompt, generation_config: { thinking_level: "low" } }),
  });
  // 舊版 generateContent（新版不可用時的備援）
  if (r.status === 404 || r.status === 400) {
    console.log("interactions fallback", r.status, (await r.text()).slice(0, 300));
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers,
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
    });
  }
  if (!r.ok) { console.log("gemini", r.status, (await r.text()).slice(0, 500)); throw new Error(r.status === 429 ? "busy" : "upstream"); }
  return pickText(await r.json());
}

/* ---------- Claude（Claude Console 的 API 金鑰） ---------- */
async function callClaude(env, prompt) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("no_key");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || env.MODEL || "claude-sonnet-5-5", max_tokens: 2500, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) { console.log("anthropic", r.status, (await r.text()).slice(0, 500)); throw new Error(r.status === 429 ? "busy" : "upstream"); }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// 從各種回應格式中找出模型輸出的文字：先找 output_text，再收集所有 text 欄位，從最後一段往前找含 JSON 的那段
function pickText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const texts = [];
  const walk = (o, key) => {
    if (!o || key === "input" || key === "system_instruction" || key === "usage" || key === "usage_metadata" || key === "usageMetadata") return;
    if (Array.isArray(o)) { o.forEach(x => walk(x)); return; }
    if (typeof o === "object") {
      if (o.thought === true || o.type === "thought" || o.type === "thinking") return; // 略過思考內容
      for (const [k, v] of Object.entries(o)) {
        if ((k === "text" || k === "output_text") && typeof v === "string") texts.push(v);
        else walk(v, k);
      }
    }
  };
  walk(data);
  for (let i = texts.length - 1; i >= 0; i--) if (extractJson(texts[i])) return texts[i];
  return texts.join("\n");
}

/* ---------- Google 雲端硬碟（Apps Script 代存） ---------- */
async function driveProxy(req, env, reply, email) {
  if (!env.DRIVE_SCRIPT_URL || !env.DRIVE_SECRET) return reply(501, { error: "drive_not_set" });
  let b;
  try { b = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  const action = b?.action === "ping" ? "ping" : "save";
  const trip = String(b?.trip || "").slice(0, 120);
  if (!trip) return reply(400, { error: "bad_request" });
  const payload = { secret: env.DRIVE_SECRET, action, trip, sub: String(b?.sub || "").slice(0, 120), by: email };
  if (action === "save") {
    const data = String(b?.data || "");
    if (!data) return reply(400, { error: "bad_request" });
    if (data.length > 45 * 1024 * 1024) return reply(413, { error: "too_large" });
    Object.assign(payload, { filename: String(b?.filename || "檔案").slice(0, 160), mimeType: String(b?.mimeType || "application/octet-stream").slice(0, 100), data, replace: !!b?.replace });
  }
  let r;
  try { r = await fetch(env.DRIVE_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "follow" }); }
  catch { return reply(502, { error: "drive_failed" }); }
  const j = await r.json().catch(() => null);
  if (!j?.ok) { console.log("drive", r.status, j?.error); return reply(502, { error: j?.error === "bad_secret" ? "drive_secret" : "drive_failed" }); }
  return reply(200, { ok: true, url: j.url || "", folderUrl: j.folderUrl || "" });
}

/* ---------- prompts ---------- */
function airportsPrompt(p) {
  return `旅行地：${p.destination}
從台灣 ${p.origin || "TPE"} 機場出發${p.month ? `，${p.month} 出發` : ""}，${p.travelers || 2} 人。
請找出飛往這個旅行地可以考慮的機場（2 到 4 個），比較：
- 哪個離旅行地最近（到主要景點或市中心的交通時間最短）
- 哪個最划算（把機票行情加上從機場到旅行地的交通費和時間一起算，例如有廉價航空直飛、但交通比較遠的機場）
同一個機場可以同時是最近和最划算。也請判斷從台灣其他機場（桃園 TPE、台中 RMQ、高雄 KHH、松山 TSA）出發是否明顯更好。
票價請給一般行情的範圍（新台幣、每人來回），不要假裝是即時價格。
只回覆 JSON：
{"summary":"一句話結論","airports":[{"code":"三碼","name":"機場中文名","tags":["nearest","value"],"direct":true,"airlines":["從出發機場直飛的航空公司"],"fareRange":"每人來回約 NT$8,000–14,000","transfer":"到旅行地的交通方式、時間與單程費用","why":"為什麼推薦或要注意什麼"}],"originTip":"出發機場建議，沒有就留空字串"}
tags 只能用 "nearest"（最近）和 "value"（最划算），可為空陣列。依推薦程度排序。`;
}
function suggestPrompt(p) {
  const want = { food: "只要餐廳，6 間，涵蓋早午晚餐或點心", sight: "只要景點、體驗或當地觀光行程，6 個" }[p.kind] || "餐廳和景點／觀光行程都要，約 3 間餐廳（含午餐、晚餐）和 3 個景點或體驗";
  return `請為一個台灣家庭推薦行程。
旅行地：${p.destination}
日期：Day ${p.dayIndex || 1}，${p.date || "未定"}（請考慮該季節天氣與公休）
同行：${p.travelers || 1} 人，${p.who || "未說明"}
喜好：${(p.likes || []).join("、") || "不拘"}
總預算：${p.budget || "未定"} ${p.currency || "TWD"}
這天已排的行程：${(p.items || []).join("；") || "還沒有"}
${p.prevLast ? `前一天最後一站：${p.prevLast}` : ""}
額外需求：${p.extra || "無"}
請推薦：${want}。
要求：地點要在這天行程附近、順路；建議時間要填進空檔，不和已排時間衝突；只推薦營業多年、評價穩定的店家或景點。
perPerson 是每人大約花費（新台幣整數），免費填 0。
只回覆 JSON：
{"suggestions":[{"name":"中文名稱","nameLocal":"當地語言原名","cat":"food 或 ticket 或 tour 或 shop","area":"所在區域","address":"當地地址（不確定就留空字串）","time":"HH:MM","duration":"例如 1 小時","perPerson":800,"why":"為什麼適合這個家庭","tip":"實用提醒，例如要預約、公休日"}]}`;
}

function dayplanPrompt(p){
  return `請為一個台灣家庭安排旅行中某一天的行程和交通路線。
旅行地：${p.destination}
今天：Day ${p.dayIndex} / 共 ${p.totalDays} 天，日期 ${p.date||"未定"}（請考慮季節、天氣、公休與日落時間）
同行：${p.travelers} 人，${p.who||"未說明"}
喜好：${(p.likes||[]).join("、")||"不拘"}
總預算：${p.budget||"未定"} ${p.currency||"TWD"}
今天的大致規劃：${p.theme||"未填，請依旅行地安排合適的一天"}
行程節奏：${p.pace==="tight"?"緊湊（約 08:30 出門、21:00 前回旅館，可以排 6～7 個點）":"悠閒（約 10:00 出門、19:00 前回旅館，最多 3～4 個點，點和點之間留緩衝，中午可以休息）"}
今晚住宿：${p.hotel||"未定"}${p.prevHotel&&p.prevHotel!==p.hotel?`（前一晚住：${p.prevHotel}，今天要換旅館）`:""}
${p.arrival?`抵達資訊：${p.arrival}`:""}
已固定、不能更動的行程：${(p.fixed||[]).join("；")||"無"}
前一天規劃：${p.prevTheme||"無"}；隔天規劃：${p.nextTheme||"無"}
要求：
- 依「今天的大致規劃」安排，從早上（或抵達、固定行程結束後）到晚上回旅館；三餐要排進去。
- 已固定的行程照原時間保留，不要重複列出，新的安排不能和它們時間衝突。
- 每一站寫出從上一站過去的交通方式和大約分鐘數，第一站從旅館（或機場、固定行程地點）出發；路線要順，不走回頭路，考慮小孩或長輩的體力。
- 只排實際存在、你有把握的地點與交通方式；不確定的就寫成「附近的餐廳」這類一般描述。
- perPerson 是每人大約花費（新台幣整數），免費填 0。
只回覆 JSON，不要其他文字：
{"summary":"一句話說明今天怎麼安排","stops":[{"time":"HH:MM","end":"HH:MM","name":"中文名稱","nameLocal":"當地語言原名","cat":"food 或 ticket 或 tour 或 shop 或 stay 或 move 或 other","area":"所在區域","address":"當地地址（不確定就留空字串）","perPerson":0,"note":"在這裡做什麼、注意事項","move":{"mode":"步行 或 電車 或 巴士 或 計程車 或 自駕 或 船","minutes":15,"detail":"例如：搭 JR 仙石線到松島海岸站"}}],"tips":["當天的實用提醒"]}`;
}

function legsPrompt(p){
  return `請幫一個台灣家庭規劃旅行中兩個地點之間的交通方式。
旅行地：${p.destination}
日期：${p.date||"未定"}
同行：${p.travelers} 人，${p.who||"未說明"}
需要規劃的路段（依順序）：
${(p.pairs||[]).map((x,i)=>`${i}. ${x.fromTime||""} 從「${x.fromName}」${x.fromAddr?`（${x.fromAddr}）`:""} 到「${x.toName}」${x.toAddr?`（${x.toAddr}）`:""}${x.toTime?`，希望 ${x.toTime} 前到`:""}`).join("\n")}
每段選一個最適合這個家庭的方式（大眾運輸優先，太遠或不方便才建議計程車；帶小孩或長輩時少轉乘、少走路），寫出搭什麼線、在哪站上下車、大約幾分鐘、每人大約多少錢。不確定的就給合理估計，不要編造不存在的路線名稱。
只回覆 JSON：
{"legs":[{"i":0,"mode":"步行 或 電車 或 地鐵 或 巴士 或 計程車 或 自駕 或 船 或 纜車","minutes":15,"detail":"例如：JR 仙石線 仙台站 → 松島海岸站","cost":"例如：每人約 ¥420"}]}`;
}

function wishPrompt(p){
  const tight=p.pace==="tight";
  return `你是幫台灣家庭排旅行行程的規劃師。家人先收集了想去的餐廳和地點，分成「一定要去」和「想去」兩種，請建議每一個排在第幾天、幾點。
旅行地：${p.destination}
同行：${p.travelers} 人，${p.who||"未說明"}；喜好：${(p.likes||[]).join("、")||"不拘"}
行程節奏：${tight?"緊湊——每天約 08:30 出門、21:00 前回旅館，同一天可以排 6～7 個點，每個點停留時間抓短一點，交通銜接緊一點":"悠閒——每天約 10:00 出門、19:00 前回旅館，同一天（含已排行程）最多 3～4 個點，每個點之間留 30～60 分鐘緩衝，中午可以休息"}
每天的狀況：
${(p.days||[]).map(d=>`Day ${d.day}（${d.date||"日期未定"} ${d.weekday||""}）規劃：${d.theme||"未填"}；住宿：${d.hotel||"未定"}；已排：${d.items.length?d.items.join("；"):"還沒有"}`).join("\n")}
要排的地方：
${(p.wishes||[]).map(w=>`${w.i}. 【${w.prio}】${w.name}（${w.cat}）${w.addr?`地址：${w.addr}`:""}${w.note?`；備註：${w.note}`:""}`).join("\n")}
排法：
1. 先排「一定要去」：每一個都要排進去。必要時可以調整「想去」的位置來讓出時間；只有在真的不可能（例如所有日子都公休）時才填 day:null，並說明原因。
2. 再把「想去」插進剩下的時間：只有在時間可控的範圍內才排——不能和已排行程或其他新排的點重疊、不能超出上面節奏的出門和回旅館時間、要留得出交通時間；排不下就填 day:null，why 寫「時間排不下」和原因，不要硬塞。
3. 地點：排在當天其他行程或旅館附近、順路的那一天，不要讓家人來回跑。
4. 時間：餐廳排在用餐時間（午餐 11:30–13:30、晚餐 17:30–20:00，備註有指定就照備註）；景點考慮營業時間、該星期幾是否公休、日落時間。
5. 配合每天的規劃（例如主題樂園日、抵達日、最後一天），這些日子少排一點。
只回覆 JSON，不要其他文字：
{"summary":"一句話說明怎麼分配","plans":[{"i":0,"day":2,"time":"12:00","duration":"約 1 小時","why":"為什麼排在這天這個時間，或為什麼排不下","warn":"要注意的事，例如週一公休、要預約；沒有就空字串"}]}`;
}

function shopPrompt(p){
  return `你是熟悉當地的旅遊達人，請推薦台灣家庭去這個地方旅行時值得買的東西（伴手禮、當地特產、藥妝、零食、生活用品等）。
旅行地：${p.destination}
日期：${p.dates||"未定"}（請考慮季節限定商品）
同行：${p.travelers} 人，${p.who||"未說明"}；喜好：${(p.likes||[]).join("、")||"不拘"}
已經在清單裡、不要重複推薦：${(p.have||[]).join("、")||"無"}
請推薦 8 樣，只推薦實際存在、在當地容易買到的東西，價格給一般行情（當地幣別和約多少新台幣）。
只回覆 JSON，不要其他文字：
{"items":[{"name":"中文名稱","nameLocal":"當地語言名稱","where":"在哪裡買，例如：機場免稅店、唐吉訶德、百貨公司地下街","price":"價格參考，例如：¥1,080（約 NT$230）","why":"為什麼推薦，一句話","tip":"實用提醒，例如：保存期限短、限定季節；沒有就空字串"}]}`;
}

/* ---------- helpers ---------- */
function sameText(a, b) {                    // 固定時間比對，避免從回應時間猜出家庭代碼
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function list(v) { return String(v || "").split(",").map(s => s.trim()).filter(Boolean); }
function clean(o, depth = 0) {
  if (depth > 3) return null;
  if (typeof o === "string") return o.slice(0, 200);
  if (typeof o === "number") return Number.isFinite(o) ? o : 0;
  if (typeof o === "boolean") return o;
  if (Array.isArray(o)) return o.slice(0, 30).map(x => clean(x, depth + 1));
  if (o && typeof o === "object") { const r = {}; for (const [k, v] of Object.entries(o).slice(0, 20)) r[k.slice(0, 30)] = clean(v, depth + 1); return r; }
  return null;
}
function extractJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const decodePart = s => JSON.parse(new TextDecoder().decode(b64url(s)));

async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("jwks");
  const maxAge = Number((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1]) || 3600;
  jwksCache = { keys: (await r.json()).keys, exp: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

// 驗證 Firebase ID token（RS256），依 Firebase 文件要求檢查 kid、簽章、aud、iss、exp、iat、sub
export async function verifyFirebaseToken(token, projectId) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || !projectId) throw new Error("format");
  const header = decodePart(parts[0]), payload = decodePart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("alg");
  const jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("kid");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("sig");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("aud");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("iss");
  if (!(payload.exp > now)) throw new Error("exp");
  if (!(payload.iat <= now + 300) || !(payload.auth_time <= now + 300)) throw new Error("iat");
  if (!payload.sub) throw new Error("sub");
  return payload;
}

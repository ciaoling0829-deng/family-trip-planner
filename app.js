// 家庭旅遊手帳 — GitHub Pages 版
// 資料：Firebase（Firestore 即時同步、Storage 存原檔照片影片、Google 登入）
// AI 推薦：透過 Cloudflare Worker 中繼呼叫 Gemini（或 Claude）API（金鑰只存在 Worker，不在這裡）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, doc, collection, onSnapshot, setDoc, addDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import * as CFG from "./config.js";
const { FIREBASE_CONFIG, AI_PROXY_URL, DEFAULT_ORIGIN } = CFG;
const LINK_MODE = (CFG.ACCESS_MODE||"google")==="link";

/* ---------- constants ---------- */
const CATS = {
  tour:{label:"團費",v:"--c-tour"}, move:{label:"交通",v:"--c-move"}, stay:{label:"住宿",v:"--c-stay"},
  food:{label:"餐飲",v:"--c-food"}, ticket:{label:"門票",v:"--c-ticket"}, shop:{label:"購物",v:"--c-shop"}, other:{label:"其他",v:"--c-other"}
};
const QUICK = ["護照","機票／電子票","外幣現金","信用卡","手機充電器","行動電源","轉接頭","常備藥","保暖外套","手套圍巾","暖暖包","盥洗用品","換洗衣物","雨傘","購物袋"];
const REASONS = ["泡溫泉","看雪","賞楓","賞櫻","吃美食","逛街購物","親子同樂","帶長輩放鬆","看海玩水","自然風景","拍照打卡","歷史文化","主題樂園","慶生／紀念日","機票便宜","離台灣近","沒去過"];
const LIKES = ["溫泉","美食","購物","自然風景","親子","文化古蹟","海島","賞雪","賞楓／賞花","主題樂園","長輩友善","輕鬆不趕"];
const ORIGINS = [["TPE","桃園"],["RMQ","台中"],["KHH","高雄"],["TSA","松山"]];
const AIRPORTS = ["TPE 桃園","RMQ 台中","KHH 高雄","TSA 松山","NRT 東京成田","HND 東京羽田","KIX 大阪關西","NGO 名古屋","FUK 福岡","CTS 札幌新千歲","OKA 沖繩那霸","SDJ 仙台","KIJ 新潟","HKD 函館","ICN 首爾仁川","PUS 釜山","CJU 濟州","BKK 曼谷","CNX 清邁","SGN 胡志明市","DAD 峴港","SIN 新加坡","HKG 香港","MFM 澳門","HUN 花蓮","TTT 台東","MZG 澎湖","KNH 金門"];
const WD = ["日","一","二","三","四","五","六"];
const SUBS = ["items","comments","packing","journal","media","snapshots","fares","dayplans","wishes","entries","shopping"];

/* ---------- firebase ---------- */
const configured = !String(FIREBASE_CONFIG.apiKey).includes("請填入");
let app, auth, db, storage;
if (configured) {
  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  storage = getStorage(app);
}

/* ---------- state & helpers ---------- */
const S = { user:null, trips:[], tripId:null, trip:null, items:[], comments:[], packing:[], journal:{}, dayplans:{}, wishes:[], entries:[], shopping:[], media:[], snaps:[], fares:[], ideas:[], users:{}, tab:"plan", day:0, online:navigator.onLine, synced:false };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = (n, cur) => { const c = cur || S.trip?.currency || "TWD"; try { return new Intl.NumberFormat("zh-TW",{style:"currency",currency:c,maximumFractionDigits:0}).format(Math.round(n||0)); } catch { return c+" "+Math.round(n||0).toLocaleString(); } };
const mb = b => (b/1024/1024).toFixed(1)+" MB";
const dayDate = i => { const t=S.trip; if(!t?.startDate) return null; const d=new Date(t.startDate+"T00:00:00"); d.setDate(d.getDate()+i); return d; };
const dLabel = d => d ? `${d.getMonth()+1}/${d.getDate()}（${WD[d.getDay()]}）` : "";
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const addDays = (s,n) => { const d=new Date(s+"T00:00:00"); d.setDate(d.getDate()+n); return iso(d); };
const costOf = it => (Number(it.actual)>0 ? Number(it.actual) : Number(it.est)||0);
const folderName = i => `${(S.trip?.title||"我的旅行").trim()}Day${i+1}`;
const stamp = t => { const w=new Date(t); return `${w.getMonth()+1}/${w.getDate()} ${String(w.getHours()).padStart(2,"0")}:${String(w.getMinutes()).padStart(2,"0")}`; };
const stampBy = () => ({ by:S.user?.uid||null, at:Date.now() });
const nameOf = uid => uid && uid===S.user?.uid ? "我" : (S.users[uid]?.nick || S.users[uid]?.name || "家人");
const avatarOf = uid => S.users[uid]?.photo || "";
const iata = v => String(v||"").toUpperCase().replace(/[^A-Z]/g,"").slice(0,3);
let toastT; function toast(m){ const t=$("toast"); t.textContent=m; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,2600); }
const store = { get(k){ try{ return localStorage.getItem(k); }catch{ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch{} } };

/* ---------- data layer ---------- */
const tripDoc = () => doc(db,"trips",S.tripId);
const subCol = c => collection(db,"trips",S.tripId,c);
async function put(col,id,body){
  if(col==="trip") return setDoc(tripDoc(), body);
  if(col==="ideas") return id ? setDoc(doc(db,"ideas",id),body) : addDoc(collection(db,"ideas"),body);
  return id ? setDoc(doc(subCol(col),id),body) : addDoc(subCol(col),body);
}
async function del(col,id){
  if(col==="ideas") return deleteDoc(doc(db,"ideas",id));
  return deleteDoc(doc(subCol(col),id));
}
async function guard(fn){
  try{ await fn(); return true; }
  catch(e){
    console.warn(e);
    if(e?.code==="permission-denied") toast("這個帳號沒有權限，請確認已加入家人名單");
    else toast("沒有存到，請檢查網路後再試一次");
    return false;
  }
}

let unsubTrip = [];
function subscribeTrip(id){
  unsubTrip.forEach(u=>u()); unsubTrip=[];
  S.tripId=id; S.trip=null; S.items=[]; S.comments=[]; S.packing=[]; S.journal={}; S.dayplans={}; S.wishes=[]; S.entries=[]; S.shopping=[]; S.media=[]; S.snaps=[]; S.fares=[]; S.day=0;
  if(!id){ render(); return; }
  store.set("lastTrip",id);
  const err = e => { console.warn(e); setSync(false,"同步中斷，請重新整理"); };
  unsubTrip.push(onSnapshot(tripDoc(),{includeMetadataChanges:true},s=>{ S.trip=s.exists()?s.data():null; S.synced=!s.metadata.fromCache; render(); },err));
  for(const c of SUBS){
    unsubTrip.push(onSnapshot(subCol(c),s=>{
      const rows=s.docs.map(d=>({id:d.id,...d.data()}));
      if(c==="journal") S.journal=Object.fromEntries(rows.map(r=>[r.id,r]));
      else if(c==="dayplans") S.dayplans=Object.fromEntries(rows.map(r=>[r.id,r]));
      else if(c==="snapshots") S.snaps=rows;
      else S[c]=rows;
      render(); if(c==="items"){ refreshOpenSheet("suggest"); refreshOpenSheet("route"); refreshOpenSheet("wishes"); } else refreshOpenSheet(c);
    },err));
  }
}

/* ---------- family link (no sign-in) ---------- */
const KEY_RE=/^[A-Za-z0-9_-]{16,80}$/;
function keyFrom(text){ const t=String(text||"").trim(); const m=t.match(/[#&?]k=([A-Za-z0-9_-]{16,80})/); return m?m[1]:(KEY_RE.test(t)?t:""); }
let FAMILY_KEY=(()=>{ const k=keyFrom(location.hash); if(k){ store.set("familyKey",k); return k; } return store.get("familyKey")||""; })();
const familyLink = () => `${location.origin}${location.pathname}#k=${FAMILY_KEY}`;
const keyHeader = () => LINK_MODE&&FAMILY_KEY?{"X-Family-Key":FAMILY_KEY}:{};
function newFamilyKey(){ const a=new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a,b=>"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[b%57]).join(""); }
let linkErr="";
function showLinkGate(err){
  if(err!==undefined) linkErr=err;
  $("gate").hidden=false; $("app").hidden=true; $("btnSignIn").hidden=true;
  $("gateMsg").textContent="用家人傳給你的連結打開就能用，不用登入。";
  $("gateErr").textContent=linkErr;
  const box=$("gateLink"); box.hidden=false;
  box.innerHTML=`<label class="sub" for="gateKey" style="text-align:left">貼上家庭連結或家庭代碼</label>
    <input id="gateKey" placeholder="https://…#k=… 或代碼" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="primary" type="button" id="btnJoin">開啟</button>
    <details class="fold" style="text-align:left;margin-top:8px"><summary><span class="sub">我是建立者，要產生家庭代碼</span></summary><div class="fold-body" id="newKeyBox"></div></details>`;
  $("btnJoin").onclick=()=>{ const k=keyFrom($("gateKey").value); if(!k){ $("gateErr").textContent="這不是有效的家庭連結，請確認有完整複製（含 #k= 後面那一串）。"; return; } FAMILY_KEY=k; store.set("familyKey",k); history.replaceState(null,"",location.pathname+"#k="+k); linkErr=""; $("gateErr").textContent=""; startLink(); };
  const nk=box.querySelector("details"); nk.addEventListener("toggle",()=>{ if(!nk.open) return; const k=newFamilyKey(); $("newKeyBox").innerHTML=`<p class="sub" style="margin:0 0 6px">這是一組新的家庭代碼。照 README「不用登入：家庭連結」的步驟，把它填進 Firebase 規則和 Worker 的 FAMILY_KEY，再把下面的連結傳給家人。</p><div class="code-box" id="nkCode">${k}</div><div class="code-box">${esc(location.origin+location.pathname)}#k=${k}</div><button class="ghost" type="button" id="nkCopy">複製代碼</button>`; $("nkCopy").onclick=()=>copyText(k,"已複製家庭代碼"); });
}
async function copyText(t,msg){ try{ await navigator.clipboard.writeText(t); toast(msg||"已複製"); }catch{ toast("請長按文字自己複製"); } }
let joining=false;
async function startLink(){
  if(!FAMILY_KEY){ showLinkGate(); return; }
  $("gateLink").hidden=true; $("gateMsg").textContent="正在開啟…"; $("gateErr").textContent="";
  if(!auth.currentUser){ try{ await signInAnonymously(auth); }catch(e){ console.warn(e); showLinkGate(e?.code==="auth/operation-not-allowed"?"Firebase 還沒開啟「匿名」登入方式，請看 README。":"連線失敗，請檢查網路後再試一次。"); } }
}
async function joinWithKey(user){
  try{ await setDoc(doc(db,"access",user.uid),{key:FAMILY_KEY,at:Date.now()}); linkErr=""; return true; }
  catch(e){ console.warn(e); if(e?.code==="permission-denied"){ store.set("familyKey",""); FAMILY_KEY=""; showLinkGate("這個家庭連結已經失效或不正確，請向家人要最新的連結。"); } else showLinkGate("連線失敗，請檢查網路後再試一次。"); return false; }
}
function leaveLink(){ store.set("familyKey",""); FAMILY_KEY=""; history.replaceState(null,"",location.pathname); signOut(auth); }
function whoSheet(){
  const cur=S.users[S.user?.uid]?.nick||"";
  openSheet(`<h2>你是誰？</h2>
  <p class="sub" style="margin-top:-6px">家人看到你的留言、日記和照片時會顯示這個名稱，之後可以在 ⚙ 設定裡修改。</p>
  <form class="form" id="whoF"><label>名稱<input id="who_name" maxlength="20" value="${esc(cur)}" placeholder="例如：媽媽、小美"></label>
  <div class="quick" style="margin-top:0">${["爸爸","媽媽","哥哥","姐姐","弟弟","妹妹","爺爺","奶奶","外公","外婆"].map(n=>`<button type="button" data-whopick="${n}">${n}</button>`).join("")}</div>
  <div class="sheet-actions"><button class="primary" type="submit">好了</button></div></form>`,"who");
  document.querySelectorAll("[data-whopick]").forEach(b=>b.onclick=()=>{ $("who_name").value=b.dataset.whopick; });
  $("whoF").onsubmit=async e=>{ e.preventDefault(); const n=$("who_name").value.trim().slice(0,20); if(!n){ $("who_name").focus(); return; } if(await guard(()=>setDoc(doc(db,"users",S.user.uid),{nick:n},{merge:true}))){ closeSheet(); toast(`嗨，${n}！`); } };
}

/* ---------- auth ---------- */
function showGate(msg,err){
  $("gate").hidden=false; $("app").hidden=true;
  $("gateMsg").textContent=msg||"全家一起排行程、控制預算、記錄旅行。";
  $("gateErr").textContent=err||"";
  $("btnSignIn").hidden=!configured;
}
async function signIn(){
  const provider=new GoogleAuthProvider(); provider.setCustomParameters({prompt:"select_account"});
  $("gateErr").textContent="";
  try{ await signInWithPopup(auth,provider); }
  catch(e){
    if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment","auth/cancelled-popup-request"].includes(e?.code)){
      try{ await signInWithRedirect(auth,provider); return; }catch(e2){ console.warn(e2); }
    }
    if(e?.code!=="auth/popup-closed-by-user") $("gateErr").textContent="登入沒有完成，請再試一次。如果在主畫面 App 一直失敗，請改用 Safari 開啟網頁登入。";
    console.warn(e);
  }
}
function bootAuth(){
  if(!configured){ showGate("還沒有設定 Firebase。","請依照 README 的步驟，把 Firebase 設定填進 config.js。"); return; }
  if(!LINK_MODE) getRedirectResult(auth).catch(e=>console.warn(e));
  if(LINK_MODE){ $("btnSignIn").hidden=true; $("gate").hidden=false; $("app").hidden=true; startLink(); } else showGate();
  onAuthStateChanged(auth, async user=>{
    S.user=user;
    if(!user){ unsubTrip.forEach(u=>u()); unsubTrip=[]; if(LINK_MODE){ if(FAMILY_KEY) startLink(); else showLinkGate(); } else showGate(); return; }
    if(LINK_MODE){ if(!FAMILY_KEY){ showLinkGate(); return; } if(joining) return; joining=true; const ok=await joinWithKey(user); joining=false; if(!ok) return; }
    $("gate").hidden=true; $("app").hidden=false;
    $("meName").textContent=LINK_MODE?"用家庭連結使用中":`${user.displayName||""}（${user.email}）`;
    if(user.photoURL){ $("meAvatar").src=user.photoURL; $("meAvatar").hidden=false; }
    try{ await setDoc(doc(db,"users",user.uid),LINK_MODE?{at:Date.now()}:{name:user.displayName||user.email,photo:user.photoURL||"",email:user.email,at:Date.now()},{merge:true}); }
    catch(e){
      if(e?.code==="permission-denied"){ await signOut(auth); showGate("",`${user.email} 還沒有被加入家人名單。請請建立者把這個 Email 加進 Firebase 規則。`); return; }
    }
    let askedWho=false;
    onSnapshot(collection(db,"users"),s=>{ S.users=Object.fromEntries(s.docs.map(d=>[d.id,d.data()])); render(); if(LINK_MODE&&!askedWho&&!S.users[user.uid]?.nick&&!s.metadata?.fromCache){ askedWho=true; setTimeout(()=>{ if($("sheet").hidden) whoSheet(); },400); } });
    onSnapshot(collection(db,"ideas"),s=>{ S.ideas=s.docs.map(d=>({id:d.id,...d.data()})); render(); refreshOpenSheet("ideas"); });
    onSnapshot(collection(db,"trips"),s=>{
      S.trips=s.docs.map(d=>({id:d.id,...d.data()})).filter(t=>!t.archived).sort((a,b)=>(b.at||0)-(a.at||0));
      if(!S.tripId || !S.trips.some(t=>t.id===S.tripId)){
        const last=store.get("lastTrip"); const pick=S.trips.find(t=>t.id===last)||S.trips[0];
        subscribeTrip(pick?.id||null);
      }
      refreshOpenSheet("trips"); render();
    });
  });
}
window.addEventListener("online",()=>{ S.online=true; render(); });
window.addEventListener("offline",()=>{ S.online=false; render(); });
function setSync(ok,text){ $("syncDot").classList.toggle("off",!ok); $("syncText").textContent=text; }

/* ---------- AI (via Cloudflare Worker) ---------- */
async function ai(task, params){
  if(!AI_PROXY_URL) throw {code:"no_proxy"};
  const token=await auth.currentUser.getIdToken();
  let res;
  try{ res=await fetch(AI_PROXY_URL.replace(/\/$/,"")+"/ai",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json",...keyHeader()},body:JSON.stringify({task,params})}); }
  catch{ throw {code:"network"}; }
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw {code:data.error||("http_"+res.status)};
  return data;
}
const aiError = e => ({
  no_proxy:"還沒有設定 AI 中繼伺服器，請在 config.js 填入 AI_PROXY_URL。",
  network:"連不到 AI 中繼伺服器，請檢查網路。",
  not_family:"這個帳號不在家人名單，無法使用推薦。",
  daily_limit:"今天的推薦次數已用完，明天再試。",
  bad_token:"登入已過期，請重新整理頁面。",
  upstream:"AI 暫時沒有回應，請稍後再試。",
  busy:"AI 現在比較忙（可能超過免費額度的每分鐘次數），請稍後再試。",
  bad_origin:"中繼伺服器沒有允許這個網址，請檢查 Worker 的 ALLOWED_ORIGINS。",
}[e?.code] || "推薦沒有產生成功，請再試一次。");

/* ---------- render ---------- */
function render(){
  if(!S.user) return;
  const t=S.trip;
  if(!S.online) setSync(false,"離線中，恢復網路後會自動同步");
  else if(S.tripId && !S.synced) setSync(false,"同步中…");
  else setSync(true,"已同步，家人修改會即時出現");
  $("hTitle").textContent = t ? (t.title||"我的旅行") : "新的旅行";
  $("hDates").textContent = t ? `${t.destination||""}${t.startDate?`　${dLabel(dayDate(0))} – ${dLabel(dayDate((t.days||1)-1))}`:""}・${t.travelers||1} 人` : "";
  $("btnTrips").hidden = S.trips.length<1;
  if(t && S.day >= (t.days||1)) S.day=0;
  renderPlan(); renderBudget(); renderTalk(); renderJournal();
  $("fab").hidden = S.tab!=="plan" || !t;
  $("ideaCount").hidden=!S.ideas.length; $("ideaCount").textContent=S.ideas.length;
  $("fareCount").hidden=!S.fares.length; $("fareCount").textContent=S.fares.length;
  renderWishBar(); renderShopBar(); renderSaveBtn(); renderDrivePanel();
}
function renderPlan(){
  const t=S.trip;
  if(!t){
    $("days").innerHTML=""; $("dayTitle").textContent=""; $("dayCost").textContent=""; $("btnSuggest").hidden=true; $("dayPlan").innerHTML="";
    $("timeline").innerHTML=`<div class="empty">還沒有建立旅行。<br><br><button class="primary sm" type="button" data-newtrip>建立新的旅行</button><br><br>還沒決定去哪裡？<button class="link" type="button" data-openideas>把想去的地方列出來讓家人投票</button></div>`;
    return;
  }
  const n=t.days||1;
  let chips=""; for(let i=0;i<n;i++){ const d=dayDate(i); chips+=`<button class="day-chip" type="button" data-day="${i}" aria-pressed="${i===S.day}"><b>Day ${i+1}</b><span>${d?`${d.getMonth()+1}/${d.getDate()} 週${WD[d.getDay()]}`:"未設日期"}</span></button>`; }
  $("days").innerHTML=chips;
  const list=S.items.filter(x=>x.day===S.day).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99"));
  $("dayTitle").textContent=`Day ${S.day+1}　${dLabel(dayDate(S.day))}`;
  $("btnSuggest").hidden=false; $("dayPlan").innerHTML=dayPlanCard();
  const dc=list.reduce((s,x)=>s+costOf(x),0);
  $("dayCost").textContent= dc ? `本日 ${money(dc)}` : "";
  let html="";
  if(S.day===0 && t.flightOut && !S.items.some(x=>x.flightItem)) html+=infoCard("去程航班",t.flightOut);
  if(!list.length) html+=`<div class="empty">這一天還沒有安排。按右下角「＋ 新增行程」，或按上方「推薦這天的餐廳和景點」。</div>`;
  const ov=new Set(); { const tl=list.filter(x=>x.time&&x.end); for(const A of tl) for(const B of list) if(B!==A&&B.time&&toMin(B.time)>=toMin(A.time)&&toMin(B.time)<toMin(A.end)){ ov.add(A.id); ov.add(B.id); } }
  let prevIt=null;
  for(const it of list){
    if(prevIt && !isFlight(prevIt) && !isFlight(it)) html+=legRow(prevIt,it);
    prevIt=it;
    const c=CATS[it.cat]||CATS.other; const open=S.comments.filter(x=>x.itemId===it.id&&!x.resolved).length; const cost=costOf(it);
    html+=`<button class="item" type="button" data-item="${esc(it.id)}" style="--cat:var(${c.v})">
      <span class="t">${esc(it.time||"—")}${it.end?`<span class="t-end">${esc(it.end)}</span>`:""}</span>
      <span class="card"><span class="ttl">${esc(it.title)}</span>
        <span class="meta"><span class="chip">${c.label}</span>${ov.has(it.id)?`<span class="chip warn-chip">⚠️ 時間重疊</span>`:""}${cost?`<span class="num">${money(cost)}${Number(it.actual)>0?" 實付":""}</span>`:""}${open?`<span class="cmt-badge">${open} 則留言</span>`:""}</span>
        ${it.note?`<span class="note" style="display:block">${esc(it.note)}</span>`:""}
        ${it.addr&&!isUrl(it.addr)?`<span class="note" style="display:block">📍 ${esc(it.addr)}</span>`:""}
      </span></button>`;
  }
  if(S.day===n-1 && t.flightBack && !S.items.some(x=>x.flightItem)) html+=infoCard("回程航班",t.flightBack);
  if(legPairs(S.day).length && S.canWrite!==false) html+=`<div class="row-actions" style="justify-content:flex-end"><button class="link" type="button" data-relegs>${legPending[S.day]?"計算交通中…":"重新計算這天的交通"}</button></div>`;
  $("timeline").innerHTML=html;
}
const infoCard=(k,v)=>`<div class="item" style="--cat:var(--c-move)"><span class="t">✈</span><span class="card" style="background:var(--sunk)"><span class="sub">${k}</span><span class="ttl" style="display:block">${esc(v)}</span></span></div>`;

function renderBudget(){
  const el=$("tabBudget"), t=S.trip;
  if(!t){ el.innerHTML=`<div class="empty">先建立旅行並填入總預算。</div>`; return; }
  const budget=Number(t.budget)||0, est=S.items.reduce((s,x)=>s+(Number(x.est)||0),0), act=S.items.reduce((s,x)=>s+(Number(x.actual)||0),0), plan=S.items.reduce((s,x)=>s+costOf(x),0);
  const pct=budget?plan/budget:0, cls=pct>1?"bad":pct>=.9?"warn":"";
  let alerts="";
  if(budget&&pct>1) alerts+=`<div class="alert">目前規劃 ${money(plan)}，超出預算 ${money(plan-budget)}。</div>`;
  else if(budget&&pct>=.9) alerts+=`<div class="alert warn">已用掉預算的 ${Math.round(pct*100)}%，剩 ${money(budget-plan)}。</div>`;
  const byCat={}; for(const x of S.items){ const c=costOf(x); if(c) byCat[x.cat]=(byCat[x.cat]||0)+c; }
  const max=Math.max(1,...Object.values(byCat));
  const rows=Object.entries(CATS).filter(([k])=>byCat[k]).sort((a,b)=>byCat[b[0]]-byCat[a[0]]).map(([k,c])=>`<div class="cat-row" style="--cat:var(${c.v})"><span class="chip">${c.label}</span><span class="sub">${plan?Math.round(byCat[k]/plan*100):0}%</span><span class="num">${money(byCat[k])}</span><span class="mini"><i style="width:${byCat[k]/max*100}%"></i></span></div>`).join("");
  el.innerHTML=`${alerts}
  <div class="panel"><h3>總預算</h3>
    <div class="big"><span class="num">${money(plan)}</span><span class="sub">/ ${budget?money(budget):"尚未設定"}</span></div>
    <div class="bar"><i class="${cls}" style="width:${Math.min(100,pct*100)}%"></i></div>
    <div class="legend"><span>已規劃 ${Math.round(pct*100)}%</span><span>剩 ${money(budget-plan)}</span></div></div>
  <div class="per"><div><span class="sub">每人平均</span><span class="num">${money(plan/(t.travelers||1))}</span></div><div><span class="sub">已實際付款</span><span class="num">${money(act)}</span></div></div>
  <div class="panel"><h3>分類花費</h3><div class="cats">${rows||`<p class="sub" style="margin:0">還沒有花費。在行程裡填入「預估費用」就會出現在這裡。</p>`}</div></div>
  <p class="sub" style="margin:0 4px">「已規劃」以實付金額為準，還沒付的用預估金額計算。預估合計 ${money(est)}。</p>`;
}

function renderTalk(){
  const open=S.comments.filter(c=>!c.resolved).length;
  $("talkBadge").hidden=!open; $("talkBadge").textContent=open;
  const t=S.trip; $("packForm").hidden=!t; $("newCmt").disabled=$("sendCmt").disabled=!t;
  const pk=[...S.packing].sort((a,b)=>(a.done-b.done)||(a.at-b.at)); const done=pk.filter(p=>p.done).length;
  $("packCount").textContent=pk.length?`${done} / ${pk.length}`:"";
  $("packBar").style.width=pk.length?(done/pk.length*100)+"%":"0";
  $("packList").innerHTML=pk.length?pk.map(p=>`<li class="${p.done?"done":""}"><input type="checkbox" id="pk_${esc(p.id)}" data-pack="${esc(p.id)}" ${p.done?"checked":""} aria-label="${esc(p.text)}"><span>${esc(p.text)}</span><button class="x" type="button" data-unpack="${esc(p.id)}" aria-label="刪除 ${esc(p.text)}">×</button></li>`).join(""):`<li style="display:block;border:0"><span class="sub">${t?"清單是空的。輸入要帶的東西，或點下面的常用項目。":"先建立旅行。"}</span></li>`;
  const have=new Set(S.packing.map(p=>p.text));
  $("packQuick").innerHTML=t?QUICK.filter(q=>!have.has(q)).map(q=>`<button type="button" data-quick="${esc(q)}">＋ ${esc(q)}</button>`).join(""):"";
  const list=[...S.comments].sort((a,b)=>(a.resolved-b.resolved)||(b.at-a.at));
  $("thread").innerHTML=list.length?list.map(cmtHTML).join(""):`<div class="empty">還沒有留言。可以在這裡或點開任一行程留言。</div>`;
}
function cmtHTML(c){
  const it=S.items.find(x=>x.id===c.itemId); const av=avatarOf(c.by);
  return `<div class="cmt ${c.resolved?"done":""}">
    <div class="cmt-top">${av?`<img src="${esc(av)}" alt="" referrerpolicy="no-referrer">`:""}<b>${esc(nameOf(c.by))}</b><span class="num">${stamp(c.at)}</span></div>
    ${it?`<button class="cmt-ref" type="button" data-item="${esc(it.id)}">Day ${it.day+1}・${esc(it.title)}</button>`:""}
    <div style="white-space:pre-wrap">${esc(c.text)}</div>
    <div class="cmt-actions"><button class="link" type="button" data-resolve="${esc(c.id)}">${c.resolved?"重新打開":"標記已解決"}</button></div>
  </div>`;
}

/* ---------- journal ---------- */
const drafts={}; const editingDrive=new Set(); const driveDrafts={}; const uploading={};
function renderJournal(){
  const t=S.trip;
  const snaps=[...S.snaps].sort((a,b)=>b.at-a.at);
  $("snapCount").textContent=snaps.length?`${snaps.length} 個版本`:"";
  $("btnSnap").disabled=!t;
  $("snapList").innerHTML=snaps.map(s=>`<div class="snap"><span><span class="num">${stamp(s.at)}</span>　${esc(nameOf(s.by))}<br><span class="sub">${esc(s.trip?.title||"")}・${(s.items||[]).length} 個行程</span></span><button class="ghost" type="button" data-restore="${esc(s.id)}">還原</button></div>`).join("");
  const f=$("folders");
  if(!t){ f.innerHTML=`<div class="empty">先建立旅行，系統會依天數建立每天的資料夾。</div>`; return; }
  f.querySelectorAll("textarea[data-diary]").forEach(ta=>{ drafts[ta.dataset.diary]=ta.value; });
  f.querySelectorAll("input[id^='drive_']").forEach(inp=>{ driveDrafts[inp.id]=inp.value; });
  const ae=document.activeElement; const activeId=ae&&f.contains(ae)?ae.id:null;
  let html="";
  for(let i=0;i<(t.days||1);i++){
    const files=S.media.filter(m=>m.day===i).sort((a,b)=>a.at-b.at);
    const j=S.journal["d"+i]||{}; const val=drafts["d"+i] ?? (j.text||"");
    const up=uploading[i];
    html+=`<details class="panel fold" data-fold="d${i}" ${isOpen("d"+i)?"open":""}>
      <summary class="folder-head">
        <svg class="folder-ico" viewBox="0 0 36 30" aria-hidden="true"><path d="M2 5a3 3 0 0 1 3-3h8l3 3.5h15a3 3 0 0 1 3 3V25a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="currentColor" opacity=".9"/></svg>
        <div style="flex:1;min-width:0"><div class="folder-name">${esc(folderName(i))}</div><span class="fold-meta">${dLabel(dayDate(i))}・${files.length} 個檔案${dayEntries(i).length?`・${dayEntries(i).length} 則日記`:""}${S.journal["d"+i]?.driveUrl?"・有雲端連結":""}${i===todayIdx()?"・今天":""}</span>${dp(i).theme?`<span class="fold-theme">${esc(dp(i).theme)}</span>`:""}</div>
      </summary>
      <div class="fold-body folder">
      ${driveBlock(i)}
      ${entriesBlock(i)}
      ${loose(files).length?`<div class="sub">其他照片</div><div class="grid">${loose(files).map(m=>`<button class="thumb" type="button" data-media="${esc(m.id)}" aria-label="${esc(m.name)}">${m.type?.startsWith("video")?`<video src="${esc(m.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="tag">影片</span>`:`<img src="${esc(m.url)}" alt="" loading="lazy">`}</button>`).join("")}</div>`:""}
      <div class="row-actions"><label class="upload">＋ 上傳照片／影片<input type="file" accept="image/*,video/*" multiple data-upload="${i}"></label><span class="progress" id="prog_${i}">${up?esc(up.text):""}</span></div>
      ${up?`<div class="upbar"><i style="width:${up.pct||0}%"></i></div>`:""}
    </div>
    </details>`;
  }
  const tf=S.media.length, td=Array.from({length:t.days||1},(_,k)=>k).filter(k=>dayEntries(k).length).length;
  const range=t.startDate?`${dLabel(dayDate(0))} – ${dLabel(dayDate((t.days||1)-1))}・`:"";
  html=`<details class="panel fold trip-fold" data-fold="trip" ${isOpen("trip")?"open":""}>
    <summary><svg class="trip-ico" viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="9" width="24" height="18" rx="4" fill="currentColor"/><path d="M12 9V6.5A1.5 1.5 0 0 1 13.5 5h5A1.5 1.5 0 0 1 20 6.5V9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 16h24" stroke="var(--surface)" stroke-width="2"/></svg><div style="flex:1;min-width:0"><div class="trip-name">${esc(t.title||"我的旅行")}</div><span class="fold-meta">${range}${t.days||1} 天・${tf} 個檔案・${td} 天有日記</span></div></summary>
    <div class="fold-body trip-days">${html}</div>
  </details>`+`${S.trips.filter(x=>x.id!==S.tripId).map(x=>`<details class="panel fold trip-fold other" data-trippick="${esc(x.id)}"><summary><svg class="trip-ico" viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="9" width="24" height="18" rx="4" fill="currentColor"/><path d="M12 9V6.5A1.5 1.5 0 0 1 13.5 5h5A1.5 1.5 0 0 1 20 6.5V9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 16h24" stroke="var(--surface)" stroke-width="2"/></svg><div style="flex:1;min-width:0"><div class="trip-name">${esc(x.title||"未命名")}</div><span class="fold-meta">${esc(x.destination||"")}${x.startDate?"・"+esc(x.startDate):""}・點開會切換到這個旅行</span></div></summary></details>`).join("")}`;
  f.innerHTML=html;
  const hint=$("foldHint"); if(hint) hint.textContent="點標題可以展開或收合";
  document.querySelectorAll("section[data-tab='journal'] > details[data-fold]").forEach(d=>{ const o=isOpen(d.dataset.fold); if(d.open!==o) d.open=o; });
  if(activeId){ const el=$(activeId); if(el){ el.focus(); if(el.setSelectionRange&&el.value!=null) try{ el.setSelectionRange(el.value.length,el.value.length); }catch{} } }
}
function driveBlock(i){
  const url=S.journal["d"+i]?.driveUrl||"";
  if(url&&!editingDrive.has(i)) return `<div class="drive"><a class="drive-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 3.5h7l6 10.5-3.5 6h-12L2.5 14z"/><path d="M8.5 3.5 15 14.5M15.5 3.5 9 14.5M2.5 14h19"/></svg>打開 Google 雲端硬碟資料夾<span aria-hidden="true">↗</span></a><button class="link" type="button" data-editdrive="${i}">更改連結</button></div>`;
  if(!editingDrive.has(i)) return `<div class="drive"><button class="link" type="button" data-editdrive="${i}">＋ 加入 Google 雲端硬碟資料夾連結</button></div>`;
  return `<div class="drive-edit">
    <label class="sub" for="drive_${i}">在 Google 雲端硬碟建立「${esc(folderName(i))}」資料夾，按「分享」→「複製連結」後貼在這裡</label>
    <input id="drive_${i}" type="url" inputmode="url" value="${esc(driveDrafts["drive_"+i] ?? url)}" placeholder="https://drive.google.com/drive/folders/…">
    <div class="row-actions"><button class="primary sm" type="button" data-savedrive="${i}">儲存連結</button><button class="ghost" type="button" data-canceldrive="${i}">取消</button>${url?`<button class="link" type="button" data-cleardrive="${i}" style="color:var(--bad)">移除連結</button>`:""}</div>
  </div>`;
}
async function saveJournal(i,patch){
  const cur=S.journal["d"+i]||{};
  return guard(()=>put("journal","d"+i,{text:cur.text||"",driveUrl:cur.driveUrl||"",...patch,...stampBy()}));
}
function uploadFiles(day,files,entryId){
  const tid=S.tripId, folder=folderName(day);
  let i=0, ok=0, fail=[]; const toDrive=[]; let big=0;
  const next=()=>{
    if(i>=files.length){ delete uploading[day]; renderJournal(); if(fail.length) toast(`${fail.length} 個檔案沒有上傳成功：${fail.join("、")}`); else toast(`已上傳 ${ok} 個檔案到「${folder}」`); if(driveOpt("photos")&&(toDrive.length||big)) setTimeout(()=>syncPhotosToDrive(day,toDrive,big),1500); return; }
    const file=files[i++]; const safe=file.name.replace(/[\\/#?[\]*]/g,"_");
    const path=`trips/${tid}/${folder}/${Date.now()}_${safe}`;
    const task=uploadBytesResumable(sref(storage,path),file,{contentType:file.type||undefined});
    task.on("state_changed",s=>{ uploading[day]={text:`上傳中 ${i}/${files.length}・${mb(s.bytesTransferred)} / ${mb(s.totalBytes)}`,pct:s.totalBytes?s.bytesTransferred/s.totalBytes*100:0}; const p=$("prog_"+day); if(p){ p.textContent=uploading[day].text; const bar=p.closest(".folder")?.querySelector(".upbar i"); if(bar) bar.style.width=uploading[day].pct+"%"; else renderJournal(); } },
      e=>{ console.warn(e); fail.push(file.name); next(); },
      async()=>{ try{ const url=await getDownloadURL(task.snapshot.ref); await addDoc(collection(db,"trips",tid,"media"),{day,...(entryId?{entryId}:{}),path,url,name:file.name,type:file.type||"",size:file.size,folder,...stampBy()}); ok++; if(file.size<=30*1024*1024) toDrive.push(file); else big++; }catch(e){ console.warn(e); fail.push(file.name); } next(); });
  };
  uploading[day]={text:"準備上傳…",pct:0}; renderJournal(); next();
}
function mediaSheet(id){
  const m=S.media.find(x=>x.id===id); if(!m) return;
  openSheet(`<h2 style="font-size:16px;word-break:break-all">${esc(m.name)}</h2>
    <div class="viewer">${m.type?.startsWith("video")?`<video src="${esc(m.url)}" controls playsinline></video>`:`<img src="${esc(m.url)}" alt="${esc(m.name)}">`}</div>
    <p class="sub">${esc(m.folder||folderName(m.day))}・${mb(m.size||0)}・${esc(nameOf(m.by))} 於 ${stamp(m.at)} 上傳</p>
    <div class="sheet-actions"><a class="primary" style="text-align:center;text-decoration:none" href="${esc(m.url)}" target="_blank" rel="noopener">開啟原檔</a><button class="danger" type="button" id="rmBtn">刪除</button></div>
    <p class="est">開啟原檔後，長按照片或按分享，就能存到手機或 Google 雲端硬碟。</p>`);
  const rm=$("rmBtn"); let armed=false;
  rm.onclick=async()=>{ if(!armed){ armed=true; rm.textContent="再按一次確認刪除"; return; }
    try{ await deleteObject(sref(storage,m.path)); }catch(e){ if(e?.code!=="storage/object-not-found"){ toast("刪除失敗，請稍後再試"); return; } }
    if(await guard(()=>del("media",m.id))){ closeSheet(); toast("已刪除"); } };
}
async function saveSnapshot(auto){
  const body={trip:S.trip,items:S.items,packing:S.packing,dayplans:S.dayplans,hash:curHash(),auto:!!auto,...stampBy()};
  const ok=await guard(()=>put("snapshots",null,body));
  if(ok){ toast(auto?"已自動儲存一個版本":"已儲存目前的專案"); if(!auto) backupSnapshot(body); }
  return ok;
}
async function restoreSnapshot(id){
  const s=S.snaps.find(x=>x.id===id); if(!s) return;
  const ok=await guard(async()=>{
    const b=writeBatch(db);
    b.set(tripDoc(),s.trip);
    const keepI=new Set(s.items.map(x=>x.id)); S.items.filter(x=>!keepI.has(x.id)).forEach(x=>b.delete(doc(subCol("items"),x.id)));
    s.items.forEach(({id:iid,...r})=>b.set(doc(subCol("items"),iid),r));
    const keepP=new Set((s.packing||[]).map(x=>x.id)); S.packing.filter(x=>!keepP.has(x.id)).forEach(x=>b.delete(doc(subCol("packing"),x.id)));
    (s.packing||[]).forEach(({id:pid,...r})=>b.set(doc(subCol("packing"),pid),r));
    Object.entries(s.dayplans||{}).forEach(([k,{id:_x,...r}])=>b.set(doc(subCol("dayplans"),k),r));
    await b.commit();
  });
  if(ok){ closeSheet(); toast(`已還原到 ${stamp(s.at)} 的版本`); }
}

/* ---------- sheets ---------- */
let openSheetKind=null;
function openSheet(html,kind){ openSheetKind=kind||null; const foot=html.includes("data-close")?"":`<div class="sheet-foot"><button class="ghost" type="button" data-close>關閉</button></div>`; $("sheet").innerHTML=`<div class="sheet-bar"><div class="grab"></div><button class="sheet-x" type="button" data-close aria-label="關閉">✕</button></div>`+html+foot; $("sheet").hidden=false; $("scrim").hidden=false; $("sheet").scrollTop=0; }
function closeSheet(){ openSheetKind=null; $("sheet").querySelectorAll("video").forEach(v=>v.pause()); $("sheet").hidden=true; $("scrim").hidden=true; }
$("scrim").onclick=closeSheet;

function tripsSheet(){
  openSheet(`<h2>我們的旅行</h2><div id="tripList"></div>
  <div class="sheet-actions" style="margin-top:14px"><button class="primary" type="button" data-newtrip>＋ 建立新的旅行</button></div>`,"trips");
  refreshOpenSheet("trips");
}
function itemSheet(id,pre){
  const it=id?S.items.find(x=>x.id===id):{day:S.day,time:"",title:"",cat:"food",est:"",actual:"",note:"",...(pre||{})};
  if(!it) return;
  const n=S.trip?.days||1; let dayOpts=""; for(let i=0;i<n;i++) dayOpts+=`<option value="${i}" ${i===it.day?"selected":""}>Day ${i+1}　${dLabel(dayDate(i))}</option>`;
  const catOpts=Object.entries(CATS).map(([k,c])=>`<option value="${k}" ${k===it.cat?"selected":""}>${c.label}</option>`).join("");
  const cmts=id?S.comments.filter(c=>c.itemId===id).sort((a,b)=>a.at-b.at):[];
  openSheet(`<h2>${id?"編輯行程":pre?"排進行程":"新增行程"}</h2>
  <form class="form" id="itemForm">
    <label>名稱<input id="f_title" required value="${esc(it.title)}" placeholder="例如：參觀博物館"></label>
    <label>地址或 Google 地圖連結<input id="f_addr" value="${esc(it.addr||"")}" placeholder="貼上地址，或 Google 地圖的「分享」連結"></label>
    <div class="addr-row"><span class="sub">有地址，交通路線會更準</span><a class="link" id="f_find" href="${esc(mapsSearch(it.title?it:{title:"",addr:""}))}" target="_blank" rel="noopener noreferrer">在 Google 地圖找 ↗</a></div>
    <label>日期<select id="f_day">${dayOpts}</select></label>
    <div class="row2"><label>開始<input id="f_time" type="time" value="${esc(it.time)}"></label><label>結束（選填）<input id="f_end" type="time" value="${esc(it.end||"")}"></label></div>
    ${S.canWrite===false?"":`<div class="quick" style="margin-top:-4px" aria-label="快速設定停留時間">${[[30,"30 分"],[60,"1 小時"],[90,"1.5 小時"],[120,"2 小時"],[180,"3 小時"],[240,"半天"]].map(([m,n])=>`<button type="button" data-dur="${m}">＋${n}</button>`).join("")}</div>`}
    <label>分類<select id="f_cat">${catOpts}</select></label>
    <div class="row2"><label>預估費用<input id="f_est" type="number" inputmode="numeric" min="0" value="${esc(it.est||"")}" placeholder="0"></label><label>實際花費<input id="f_act" type="number" inputmode="numeric" min="0" value="${esc(it.actual||"")}" placeholder="付款後填"></label></div>
    <label>備註<textarea id="f_note" rows="2">${esc(it.note)}</textarea></label>
    <div class="sheet-actions"><button class="primary" type="submit">儲存</button><button class="ghost" type="button" data-close>取消</button>${id?`<button class="danger" type="button" id="delBtn">刪除</button>`:""}</div>
  </form>
  ${id&&S.canWrite!==false?`<details class="fold copy-box" id="copyBox"><summary><h3 style="margin:0;font-size:16px">📋 複製到其他時間</h3></summary>
    <div class="fold-body form">
      <p class="sub" style="margin:0">複製一份一樣的行程到別的時間，名稱、地址、分類、預估費用和備註都會帶過去。</p>
      <div class="row2"><label>複製到<select id="c_day">${dayOpts}</select></label><label>開始<input id="c_time" type="time" value="${esc(it.time||"")}"></label></div>
      <div class="quick" style="margin-top:-4px">${it.day<n-1?`<button type="button" data-cquick="next">隔天同一時間</button>`:""}<button type="button" data-cquick="all">每天同一時間</button></div>
      <p class="sub" id="c_hint" style="margin:0"></p>
      <div class="sheet-actions"><button class="primary" type="button" id="c_go">複製</button></div>
    </div></details>`:""}
  ${id?`<h2 style="margin-top:22px;font-size:17px">留言（${cmts.length}）</h2>
  <div class="thread">${cmts.map(cmtHTML).join("")||`<p class="sub" style="margin:0">對這個行程有意見嗎？留言給大家。</p>`}</div>
  <div class="composer" style="margin-top:10px"><textarea id="itemCmt" rows="2" placeholder="寫下你的想法"></textarea><button class="primary sm" type="button" id="itemCmtSend">送出</button></div>`:""}`);
  const upd=()=>{ const a=$("f_find"); if(a) a.href=mapsSearch({title:$("f_title").value.trim(),addr:$("f_addr").value.trim()}); };
  $("f_title")?.addEventListener("input",upd); $("f_addr")?.addEventListener("input",upd);
  let durM=(it.time&&it.end)?toMin(it.end)-toMin(it.time):0;
  $("f_time")?.addEventListener("change",()=>{ const s=$("f_time").value; if(s&&durM>0) $("f_end").value=addMin(s,durM); });
  $("f_end")?.addEventListener("change",()=>{ const s=$("f_time").value,e=$("f_end").value; durM=s&&e?toMin(e)-toMin(s):0; });
  document.querySelectorAll("#itemForm [data-dur]").forEach(b=>b.onclick=()=>{ const s=$("f_time").value; if(!s){ toast("先填開始時間"); $("f_time").focus(); return; } durM=Number(b.dataset.dur); $("f_end").value=addMin(s,durM); });
  const cDay=$("c_day"), cTime=$("c_time");
  if(cDay&&cTime){
    const durC=(it.time&&it.end)?toMin(it.end)-toMin(it.time):0;
    let allDays=false;
    const hint=()=>{ const d=Number(cDay.value), s=cTime.value; const h=$("c_hint"); if(!h) return;
      if(allDays){ h.textContent=`會複製到其他 ${n-1} 天的 ${s||"同一時間"}${durC&&s?`–${addMin(s,durC)}`:""}`; return; }
      if(!s){ h.textContent="沒有填開始時間，會複製成沒有時間的行程"; return; }
      const e=durC?addMin(s,durC):""; const clash=dayList(d).filter(x=>x.id!==it.id&&x.time&&(e?(toMin(x.time)<toMin(e)&&toMin(x.end||x.time)>toMin(s)):(x.end?toMin(s)>=toMin(x.time)&&toMin(s)<toMin(x.end):x.time===s)));
      h.innerHTML=`Day ${d+1}　${esc(s)}${e?"–"+esc(e):""}${clash.length?`<br><span style="color:var(--bad)">⚠️ 會和「${esc(clash[0].title)}」時間重疊</span>`:""}`; };
    cDay.onchange=()=>{ allDays=false; hint(); }; cTime.oninput=hint; hint();
    document.querySelectorAll("[data-cquick]").forEach(b=>b.onclick=()=>{ cTime.value=it.time||""; if(b.dataset.cquick==="next"){ allDays=false; cDay.value=String(Math.min(n-1,it.day+1)); } else allDays=true; hint(); });
    $("c_go").onclick=async()=>{
      const s=cTime.value; const days=allDays?Array.from({length:n},(_,k)=>k).filter(k=>k!==it.day&&!dayList(k).some(x=>x.title===it.title&&(x.time||"")===s)):[Number(cDay.value)];
      if(!days.length){ toast("其他天都已經有這個行程了"); return; }
      if(!allDays&&days[0]===it.day&&s===(it.time||"")){ toast("請換一個日期或時間"); return; }
      const {id:_i,wishId,flightItem,fareItem,fareId,leg,legHint,actual,...base}=it;
      $("c_go").disabled=true;
      const ok=await guard(async()=>{ for(const d of days) await put("items",null,{...base,day:d,time:s,end:durC&&s?addMin(s,durC):"",actual:0,copiedFrom:it.id,...stampBy()}); });
      if(ok){ closeSheet(); toast(allDays?`已複製到其他 ${days.length} 天`:`已複製到 Day ${days[0]+1}${s?" "+s:""}`); if(!allDays){ S.day=days[0]; render(); } days.forEach(d=>scheduleLegs(d)); }
      else $("c_go").disabled=false;
    };
  }
  $("itemForm").onsubmit=async e=>{ e.preventDefault();
    const body={addr:$("f_addr").value.trim(),...(it.wishId?{wishId:it.wishId}:{}),...(it.leg?{leg:it.leg}:{}),day:Number($("f_day").value),time:$("f_time").value,end:$("f_end").value,title:$("f_title").value.trim(),cat:$("f_cat").value,est:Number($("f_est").value)||0,actual:Number($("f_act").value)||0,note:$("f_note").value.trim(),...(it.fareItem?{fareItem:true}:{}),...(it.flightItem?{flightItem:true,fareId:it.fareId||""}:{}),...stampBy()};
    if(!body.title) return;
    if(body.end&&body.time&&toMin(body.end)<=toMin(body.time)){ toast("結束時間要晚於開始時間"); $("f_end").focus(); return; }
    if(body.end&&!body.time){ toast("先填開始時間"); $("f_time").focus(); return; }
    if(await guard(()=>put("items",id||null,body))){ S.day=body.day; closeSheet(); toast(id?"已儲存":"已新增"); render(); scheduleLegs(body.day); if(id&&it.day!==body.day) setTimeout(()=>scheduleLegs(it.day),2500); } };
  if(id){
    const d=$("delBtn"); let armed=false;
    d.onclick=async()=>{ if(!armed){ armed=true; d.textContent="再按一次確認刪除"; return; } if(await guard(()=>del("items",id))){ closeSheet(); toast("已刪除"); scheduleLegs(it.day); } };
    $("itemCmtSend").onclick=async()=>{ const v=$("itemCmt").value.trim(); if(!v) return; if(await guard(()=>put("comments",null,{text:v,itemId:id,resolved:false,...stampBy()}))){ toast("留言已送出"); itemSheet(id); } };
  }
}

function tripSheet(prefill,{isNew}={}){
  const base=isNew?{title:"",destination:"",startDate:"",days:3,budget:"",currency:"TWD",travelers:2,airportFrom:DEFAULT_ORIGIN}:(S.trip||{});
  const t={...base,...(prefill||{})};
  const curs=["TWD","JPY","USD","KRW","EUR"].map(c=>`<option ${c===(t.currency||"TWD")?"selected":""}>${c}</option>`).join("");
  openSheet(`<h2>${isNew?"建立新的旅行":"旅行設定"}</h2>
  <form class="form" id="tripForm">
    <label>專案名稱<input id="t_title" required value="${esc(t.title)}" placeholder="例如：東北之旅"></label>
    <label>旅行地<input id="t_dest" value="${esc(t.destination)}" placeholder="例如：日本東北、韓國釜山"></label>
    <div class="row2"><label>出發機場<select id="t_from">${ORIGINS.map(([c,n])=>`<option value="${c}" ${c===(t.airportFrom||DEFAULT_ORIGIN)?"selected":""}>${n}（${c}）</option>`).join("")}</select></label><label>抵達機場<input id="t_ap" maxlength="3" autocapitalize="characters" list="apListT" value="${esc(t.airportTo||"")}" placeholder="三碼，例如 SDJ"></label></div>
    <datalist id="apListT">${AIRPORTS.map(s=>`<option value="${s.slice(0,3)}">${s}</option>`).join("")}</datalist>
    <div id="apBoxT"></div>
    <div class="row2"><label>出發日<input id="t_start" type="date" value="${esc(t.startDate)}"></label><label>天數<input id="t_days" type="number" min="1" max="21" inputmode="numeric" value="${esc(t.days)}"></label></div>
    <div class="row2"><label>總預算<input id="t_budget" type="number" min="0" inputmode="numeric" value="${esc(t.budget)}" placeholder="0"></label><label>幣別<select id="t_cur">${curs}</select></label></div>
    <div class="row2"><label>人數<input id="t_trav" type="number" min="1" inputmode="numeric" value="${esc(t.travelers||1)}"></label><label>同行說明<input id="t_who" value="${esc(t.who||"")}" placeholder="例如 2 大 1 小、有長輩"></label></div>
    <div><div class="sub" style="margin-bottom:6px">喜好（推薦餐廳景點時會參考）</div><div class="tags" id="t_likes">${LIKES.map(l=>`<button type="button" data-tlike="${esc(l)}" aria-pressed="${(t.likes||[]).includes(l)}">${esc(l)}</button>`).join("")}</div></div>
    <label>去程航班<input id="t_fo" value="${esc(t.flightOut||"")}" placeholder="航空公司、班次、起降時間"></label>
    <label>回程航班<input id="t_fb" value="${esc(t.flightBack||"")}"></label>
    <div class="sheet-actions"><button class="primary" type="submit">${isNew?"建立":"儲存"}</button><button class="ghost" type="button" data-close>取消</button>${!isNew?`<button class="ghost" type="button" id="archBtn">封存這個旅行</button>`:""}</div>
  </form>`);
  airportPicker($("apBoxT"),{getDest:()=>$("t_dest").value.trim(),getOrigin:()=>$("t_from").value,getMonth:()=>($("t_start").value||"").slice(0,7),getPax:()=>Number($("t_trav").value)||1,onPick:code=>{ $("t_ap").value=code; toast(`已選 ${code}，記得按「${isNew?"建立":"儲存"}」`); }});
  $("tripForm").onsubmit=async e=>{ e.preventDefault();
    const body={...(isNew?{}:S.trip||{}),title:$("t_title").value.trim(),destination:$("t_dest").value.trim(),airportFrom:$("t_from").value,airportTo:iata($("t_ap").value),startDate:$("t_start").value,days:Math.max(1,Math.min(21,Number($("t_days").value)||1)),budget:Number($("t_budget").value)||0,currency:$("t_cur").value,travelers:Math.max(1,Number($("t_trav").value)||1),who:$("t_who").value.trim(),likes:[...document.querySelectorAll("#t_likes [data-tlike][aria-pressed='true']")].map(b=>b.dataset.tlike),flightOut:$("t_fo").value.trim(),flightBack:$("t_fb").value.trim()};
    if(!body.title) return;
    if(isNew){
      try{ const r=await addDoc(collection(db,"trips"),{...body,...stampBy()}); closeSheet(); subscribeTrip(r.id); toast("旅行已建立"); }
      catch(e){ console.warn(e); toast("建立失敗，請確認帳號在家人名單內"); }
    } else if(await guard(()=>put("trip",null,body))){ closeSheet(); toast("已儲存"); }
  };
  const ab=$("archBtn"); if(ab){ let armed=false; ab.onclick=async()=>{ if(!armed){ armed=true; ab.textContent="再按一次確認封存"; return; } if(await guard(()=>put("trip",null,{...S.trip,archived:true}))){ closeSheet(); S.tripId=null; toast("已封存"); } }; }
}

/* ---------- airport recommendation ---------- */
function airportPicker(box,{getDest,getOrigin,getMonth,getPax,onPick}){
  const st={busy:false,res:null,err:""};
  const draw=()=>{
    let h=`<button class="link" type="button" data-ap-go>✈ 推薦最近和最划算的機場</button>`;
    if(st.busy) h=`<div class="empty" style="padding:14px"><span class="spinner"></span>正在比較附近的機場…</div>`;
    else if(st.err) h+=`<div class="alert warn" style="margin-top:8px">${esc(st.err)}</div>`;
    else if(st.res){
      h=`<div class="ap-out">${st.res.summary?`<div class="sub">${esc(st.res.summary)}</div>`:""}
      ${(st.res.airports||[]).map((a,i)=>`<div class="ap">
        <div class="ap-top"><b><span class="ap-code">${esc(iata(a.code))}</span>　${esc(a.name||"")}</b><div class="badges">${(a.tags||[]).includes("nearest")?`<span class="near">最近</span>`:""}${(a.tags||[]).includes("value")?`<span class="value">最划算</span>`:""}${a.direct?`<span>有直飛</span>`:`<span>需轉機</span>`}</div></div>
        ${a.transfer?`<div style="font-size:14px">到目的地：${esc(a.transfer)}</div>`:""}
        <div class="facts">${a.fareRange?`<span>票價參考 <b>${esc(a.fareRange)}</b></span>`:""}${Array.isArray(a.airlines)&&a.airlines.length?`<span>${esc(a.airlines.join("、"))}</span>`:""}</div>
        ${a.why?`<div class="sub">${esc(a.why)}</div>`:""}
        <div class="row-actions"><button class="ghost" type="button" data-ap-pick="${i}">用這個機場</button></div>
      </div>`).join("")}
      ${st.res.originTip?`<div class="est">出發地建議：${esc(st.res.originTip)}</div>`:""}
      <div class="est">票價是一般行情參考，不是即時價格。選好機場後到「機票比價」查實際價格。</div>
      <button class="link" type="button" data-ap-go>重新推薦</button></div>`;
    }
    box.innerHTML=h;
  };
  box.addEventListener("click",async e=>{
    if(e.target.closest("[data-ap-go]")){
      const dest=getDest(); if(!dest){ st.err="請先輸入旅行地。"; draw(); return; }
      st.busy=true; st.err=""; draw();
      try{ st.res=await ai("airports",{destination:dest,origin:getOrigin(),month:getMonth(),travelers:getPax()}); if(!st.res?.airports?.length) st.err="這次沒有得到結果，請再試一次。"; }
      catch(err){ st.err=aiError(err); st.res=null; }
      st.busy=false; draw(); return;
    }
    const p=e.target.closest("[data-ap-pick]"); if(p&&st.res){ const a=st.res.airports[Number(p.dataset.apPick)]; if(a) onPick(iata(a.code)); }
  });
  draw();
}

/* ---------- destinations (family shortlist) ---------- */
function ideasSheet(){
  openSheet(`<h2>旅行地</h2>
  <p class="sub" style="margin:-4px 0 12px">輸入想去的地方，加入候選讓家人投票，或直接用它建立旅行。</p>
  <form class="form" id="destF">
    <label>想去的地方<input id="d_name" required placeholder="例如：日本東北、韓國釜山、花蓮"></label>
    <div class="row2"><label>抵達機場（選填）<input id="d_ap" maxlength="3" autocapitalize="characters" list="apList2" placeholder="例如 SDJ"></label><label>預計天數<input id="d_days" type="number" min="1" max="21" inputmode="numeric" value="${esc(S.trip?.days||5)}"></label></div>
    <datalist id="apList2">${AIRPORTS.map(s=>`<option value="${s.slice(0,3)}">${s}</option>`).join("")}</datalist>
    <div id="apBoxD"></div>
    <label>為什麼想去（選填，可點下面的選項）<input id="d_note" placeholder="例如：想泡溫泉、看雪"></label>
    <div class="quick" style="margin-top:-4px" id="d_chips">${REASONS.map(r=>`<button type="button" data-reason="${esc(r)}">＋ ${esc(r)}</button>`).join("")}</div>
    <div class="sheet-actions"><button class="primary" type="submit">加入候選</button><button class="ghost" type="button" id="d_use">用這個建立旅行</button></div>
  </form>
  <h2 style="margin-top:22px;font-size:17px">家人的候選清單</h2>
  <div id="ideaList" style="display:grid;gap:10px"></div>`,"ideas");
  refreshOpenSheet("ideas");
  airportPicker($("apBoxD"),{getDest:()=>$("d_name").value.trim(),getOrigin:()=>S.trip?.airportFrom||DEFAULT_ORIGIN,getMonth:()=>"",getPax:()=>S.trip?.travelers||2,onPick:code=>{ $("d_ap").value=code; }});
  const read=()=>({name:$("d_name").value.trim(),airport:iata($("d_ap").value),days:Math.max(1,Math.min(21,Number($("d_days").value)||5)),note:$("d_note").value.trim()});
  $("destF").onsubmit=async e=>{ e.preventDefault(); const d=read(); if(!d.name) return; if(S.ideas.some(x=>x.name===d.name)){ toast("已經在候選清單裡"); return; }
    if(await guard(()=>put("ideas",null,{...d,likes:[S.user.uid],...stampBy()}))){ $("destF").reset(); document.querySelectorAll("[data-reason]").forEach(b=>b.setAttribute("aria-pressed","false")); toast("已加入候選，家人都看得到"); } };
  $("d_use").onclick=()=>{ const d=read(); if(!d.name){ $("d_name").focus(); toast("請先輸入想去的地方"); return; } useIdea(d); };
}
function ideaCard(d){
  const liked=(d.likes||[]).includes(S.user?.uid);
  return `<div class="idea">
    <div class="idea-top"><b>${esc(d.name)}</b><span class="sub" style="white-space:nowrap">${(d.likes||[]).length} 人想去</span></div>
    <div class="facts">${d.airport?`<span>抵達 <b>${esc(d.airport)}</b></span>`:""}${d.days?`<span><b>${esc(d.days)}</b> 天</span>`:""}<span>${esc(nameOf(d.by))} 提議</span></div>
    ${d.note?`<div class="sub">${esc(d.note)}</div>`:""}
    <div class="row-actions">
      <button class="ghost" type="button" data-likeidea="${esc(d.id)}">${liked?"♥ 我想去":"♡ 我想去"}</button>
      <button class="ghost" type="button" data-useidea="${esc(d.id)}">用這個建立旅行</button>
      ${d.airport?`<button class="link" type="button" data-fareidea="${esc(d.airport)}">查機票</button>`:""}
      <button class="link" type="button" data-rmidea="${esc(d.id)}" style="color:var(--bad)">移除</button>
    </div></div>`;
}
function useIdea(d){ closeSheet(); tripSheet({title:`${d.name}之旅`,destination:d.name,days:d.days||5,airportTo:d.airport||""},{isNew:true}); }

/* ---------- day suggestions ---------- */
let sug={kind:"all",area:"",results:[],busy:false,day:null,err:"",tripId:null};
function suggestSheet(){
  const t=S.trip; if(!t) return;
  if(sug.day!==S.day||sug.tripId!==S.tripId) sug={kind:"all",area:"",results:[],busy:false,day:S.day,err:"",tripId:S.tripId};
  const list=S.items.filter(x=>x.day===S.day);
  openSheet(`<h2>推薦餐廳和景點</h2>
  <p class="sub" style="margin:-4px 0 12px">Day ${S.day+1}　${dLabel(dayDate(S.day))}・${esc(t.destination||t.title||"")}</p>
  <div class="form">
    <div><div class="sub" style="margin-bottom:6px">想找什麼</div><div class="tags">${[["all","都推薦"],["food","餐廳"],["sight","景點／觀光行程"]].map(([k,n])=>`<button type="button" data-skind="${k}" aria-pressed="${sug.kind===k}">${n}</button>`).join("")}</div></div>
    <label>附近區域或需求（選填）<input id="s_area" value="${esc(sug.area)}" placeholder="例如：松島附近、晚餐想吃海鮮、雨天備案"></label>
    <div class="sheet-actions"><button class="primary" type="button" id="s_go">${sug.results.length?"重新推薦":"幫我推薦"}</button></div>
    <p class="est" style="margin:0">AI 會參考這天已排的行程（${list.length} 項）、同行的人和喜好來推薦。營業時間和價格可能變動，加入前請點「地圖」確認。</p>
  </div>
  <div id="sugOut" style="display:grid;gap:12px;margin-top:16px"></div>`,"suggest");
  renderSug(); $("s_go").onclick=runSuggest;
}
function renderSug(){
  const out=$("sugOut"); if(!out||openSheetKind!=="suggest") return;
  if(sug.busy){ out.innerHTML=`<div class="empty"><span class="spinner"></span>正在找適合的地方…</div>`; return; }
  if(sug.err){ out.innerHTML=`<div class="alert warn">${esc(sug.err)}</div>`; return; }
  const added=new Set(S.items.filter(x=>x.day===sug.day).map(x=>x.title));
  out.innerHTML=sug.results.map((r,i)=>{
    const c=CATS[r.cat]||CATS.other; const q=encodeURIComponent(`${r.nameLocal||r.name} ${r.area||""} ${S.trip?.destination||""}`.trim());
    const done=added.has(r.name);
    return `<div class="idea" style="--cat:var(${c.v})">
      <div class="idea-top"><b style="font-size:17px">${esc(r.name)}</b><span class="chip">${c.label}</span></div>
      <div class="facts">${r.nameLocal&&r.nameLocal!==r.name?`<span>${esc(r.nameLocal)}</span>`:""}${r.area?`<span>${esc(r.area)}</span>`:""}${r.time?`<span>建議 <b>${esc(r.time)}</b></span>`:""}${r.duration?`<span>約 ${esc(r.duration)}</span>`:""}${r.perPerson?`<span>每人約 <b>${money(r.perPerson)}</b></span>`:`<span>免費或已含</span>`}</div>
      ${r.why?`<div style="font-size:14px">${esc(r.why)}</div>`:""}${r.tip?`<div class="est">提醒：${esc(r.tip)}</div>`:""}
      <div class="row-actions"><button class="ghost" type="button" data-wishsug="${i}">♡ 收藏</button><button class="ghost" type="button" data-addsug="${i}" ${done?"disabled":""}>${done?"已加入":"＋ 加入這天行程"}</button><a class="link" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener noreferrer">地圖 ↗</a></div>
    </div>`;
  }).join("");
}
async function runSuggest(){
  if(sug.busy) return;
  const t=S.trip, day=S.day; sug.area=$("s_area")?.value.trim()||"";
  const list=S.items.filter(x=>x.day===day).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99"));
  const prev=S.items.filter(x=>x.day===day-1).sort((a,b)=>(b.time||"").localeCompare(a.time||""))[0];
  sug.busy=true; sug.err=""; renderSug(); const go=$("s_go"); if(go) go.disabled=true;
  try{
    const r=await ai("suggest",{destination:t.destination||t.title,date:dayDate(day)?iso(dayDate(day)):"",dayIndex:day+1,travelers:t.travelers||1,who:t.who||"",likes:t.likes||[],budget:t.budget||0,currency:t.currency||"TWD",items:list.map(x=>`${x.time||"未定時間"} ${x.title}`),prevLast:prev?.title||"",kind:sug.kind,extra:sug.area});
    sug.results=(r?.suggestions||[]).filter(x=>x&&x.name).slice(0,8).map(x=>({...x,cat:CATS[x.cat]?x.cat:"other",perPerson:Number(x.perPerson)||0,time:/^\d{1,2}:\d{2}$/.test(x.time||"")?x.time.padStart(5,"0"):""}));
    if(!sug.results.length) sug.err="這次沒有得到推薦，請換個說法再試一次。";
  }catch(e){ sug.err=aiError(e); }
  sug.busy=false; renderSug(); const g2=$("s_go"); if(g2){ g2.disabled=false; g2.textContent="重新推薦"; }
}
async function addSuggestion(i){
  const r=sug.results[i]; if(!r) return;
  const body={day:sug.day,addr:r.address||"",time:r.time||"",end:endOf(r.time,r.duration),title:r.name,cat:r.cat,est:(r.perPerson||0)*(S.trip?.travelers||1),actual:0,note:[r.nameLocal&&r.nameLocal!==r.name?r.nameLocal:"",r.area,r.tip].filter(Boolean).join("・"),...stampBy()};
  if(await guard(()=>put("items",null,body))){ toast(`已加入 Day ${sug.day+1}`); scheduleLegs(sug.day); }
}

/* ---------- addresses + automatic transport between stops ---------- */
const isFlight = it => /^✈/.test(it?.title||"");
const isUrl = v => /^https?:\/\//i.test(String(v||"").trim());
function placeOf(it){
  if(it.addr && !isUrl(it.addr)) return it.addr;
  const m=String(it.title||"").match(/^前往(.+?)報到$/); const name=m?m[1]:it.title;
  return `${name} ${S.trip?.destination||""}`.trim();
}
const mapsSearch = it => it.addr && isUrl(it.addr) ? it.addr : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeOf(it))}`;
const TRAVEL = {步行:"walking",自駕:"driving",計程車:"driving"};
const mapsDir = (a,b,mode) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(placeOf(a))}&destination=${encodeURIComponent(placeOf(b))}&travelmode=${TRAVEL[mode]||"transit"}`;
const LEG_ICON = {步行:"🚶",電車:"🚃",地鐵:"🚇",巴士:"🚌",計程車:"🚕",自駕:"🚗",船:"⛴️",纜車:"🚡"};
const legKey = (a,b) => `${a.id}|${a.addr||a.title}|${b.addr||b.title}`;
function dayList(day){ return S.items.filter(x=>x.day===day).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99")); }
function legPairs(day){
  const list=dayList(day), out=[];
  for(let i=1;i<list.length;i++){ const a=list[i-1], b=list[i]; if(isFlight(a)||isFlight(b)) continue; out.push([a,b]); }
  return out;
}
const legPending = {};
function legRow(a,b){
  const L=b.leg;
  if(L && L.fromKey===legKey(a,b)){
    return `<div class="leg-row"><span>${LEG_ICON[L.mode]||"➜"} ${esc(L.mode||"")}${L.minutes?` 約 ${esc(L.minutes)} 分`:""}${L.detail?`・${esc(L.detail)}`:""}${L.cost?`・${esc(L.cost)}`:""}</span><a href="${esc(mapsDir(a,b,L.mode))}" target="_blank" rel="noopener noreferrer">路線 ↗</a></div>`;
  }
  if(legPending[b.day]) return `<div class="leg-row"><span><span class="spinner"></span>計算交通中…</span></div>`;
  return `<div class="leg-row"><span class="sub">交通</span><a href="${esc(mapsDir(a,b))}" target="_blank" rel="noopener noreferrer">查路線 ↗</a></div>`;
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
let legTimer=null, legBusy=false, legAgain=false;
const legQueue=new Set();
function scheduleLegs(day){ legQueue.add(day); clearTimeout(legTimer); legTimer=setTimeout(async()=>{ const ds=[...legQueue]; legQueue.clear(); for(const d of ds) await autoLegs(d); },1200); }
async function autoLegs(day,force){
  if(S.canWrite===false || !S.trip) return;
  if(legBusy){ legAgain=true; return; }
  const need=[]; const hint=[];
  for(const [a,b] of legPairs(day)){
    const key=legKey(a,b);
    if(!force && b.leg?.fromKey===key) continue;
    if(!force && b.legHint && b.legHint.fromName===a.title) hint.push([a,b]); else need.push([a,b]);
  }
  if(!need.length && !hint.length) return;
  legBusy=true;
  try{
    for(const [a,b] of hint){ const {id,legHint,...r}=b; await put("items",id,{...r,leg:{fromKey:legKey(a,b),mode:legHint.mode||"",minutes:legHint.minutes||"",detail:legHint.detail||"",cost:""}}); }
    if(need.length){
      legPending[day]=true; if(S.day===day) renderPlan();
      const t=S.trip;
      const params={destination:t.destination||t.title,date:dayDate(day)?iso(dayDate(day)):"",travelers:t.travelers||1,who:t.who||"",
        pairs:need.map(([a,b])=>({fromName:a.title,fromAddr:isUrl(a.addr)?"":(a.addr||""),fromTime:a.end||a.time||"",toName:b.title,toAddr:isUrl(b.addr)?"":(b.addr||""),toTime:b.time||""}))};
      let res=null; try{ res=await ai("legs",params); }catch(e){ console.warn(e); toast(aiError(e)); }
      for(const L of (res?.legs||[])){
        const pair=need[Number(L.i)]; if(!pair) continue; const [a,b]=pair;
        const cur=S.items.find(x=>x.id===b.id); if(!cur) continue;
        const {id,...r}=cur;
        await put("items",id,{...r,leg:{fromKey:legKey(a,b),mode:String(L.mode||"").slice(0,10),minutes:Number(L.minutes)||"",detail:String(L.detail||"").slice(0,120),cost:String(L.cost||"").slice(0,40)}});
      }
    }
  }catch(e){ console.warn(e); }
  legPending[day]=false; legBusy=false; if(S.day===day) renderPlan();
  if(legAgain){ legAgain=false; scheduleLegs(day); }
}

/* ---------- wishlist: collect places first, then let AI suggest the day and time ---------- */
const WCATS = [["food","餐廳"],["tour","景點"],["shop","購物"],["ticket","體驗／門票"],["other","其他"]];
let wishCat = "food";
const PRIOS = [["must","一定要去"],["want","想去"]];
let wishPrio = "want";
const prioOf = w => w.prio==="must"?"must":"want";
const prioBadge = w => `<span class="prio ${prioOf(w)}">${prioOf(w)==="must"?"一定要去":"想去"}</span>`;
const PACES = [["relaxed","悠閒","每天 10:00–19:00，最多 3～4 個點，點和點之間留緩衝"],["tight","緊湊","每天 08:30–21:00，可以排 6～7 個點"]];
const paceOf = () => S.trip?.pace==="tight"?"tight":"relaxed";
function paceChips(){ return `<div class="pace"><span class="sub">行程節奏</span><div class="tags">${PACES.map(([k,n])=>`<button type="button" data-pace="${k}" aria-pressed="${paceOf()===k}">${n}</button>`).join("")}</div><span class="sub" data-pacehint>${(PACES.find(x=>x[0]===paceOf())||PACES[0])[2]}</span></div>`; }
async function setPace(k){ if(!S.trip||paceOf()===k) return; const ok=await guard(()=>put("trip",null,{...S.trip,pace:k})); if(ok){ S.trip={...S.trip,pace:k}; document.querySelectorAll("[data-pace]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.pace===k)); document.querySelectorAll("[data-pacehint]").forEach(x=>x.textContent=(PACES.find(p=>p[0]===k)||PACES[0])[2]); toast(`已改成${k==="tight"?"緊湊":"悠閒"}行程`); } }
const wishItem = w => S.items.find(x=>x.wishId===w.id);
const wishOpen = () => (S.wishes||[]).filter(w=>!wishItem(w));
function renderWishBar(){
  const b=$("wishBar"); if(!b) return;
  b.hidden=!S.trip;
  const all=(S.wishes||[]).length, open=wishOpen().length, mustN=wishOpen().filter(w=>prioOf(w)==="must").length;
  b.innerHTML=`<span class="wb-ico" aria-hidden="true">♡</span><span class="wb-text"><b>想去清單</b><span class="sub">${all?(open?`${open} 個還沒排進行程${mustN?`（${mustN} 個一定要去）`:""}`:`都排進行程了（${all} 個）`):"先收集想去的餐廳和地點，再幫你排到哪一天"}</span></span>${open?`<span class="wb-n">${open}</span>`:""}<span aria-hidden="true" class="sub">›</span>`;
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
function wishParams(list){
  const t=S.trip, n=t.days||1, days=[];
  for(let i=0;i<n;i++){
    const d=dayDate(i);
    days.push({day:i+1,date:d?iso(d):"",weekday:d?"週"+WD[d.getDay()]:"",theme:dp(i).theme||"",hotel:dp(i).hotel||"",
      items:dayList(i).map(x=>`${x.time||"未定時間"}${x.end?"–"+x.end:""} ${x.title}${x.addr&&!isUrl(x.addr)?`（${x.addr}）`:""}`)});
  }
  return {destination:t.destination||t.title,travelers:t.travelers||1,who:t.who||"",likes:t.likes||[],days,
    pace:paceOf(),wishes:list.map((w,i)=>({i,prio:prioOf(w)==="must"?"一定要去":"想去",name:w.name,cat:(WCATS.find(c=>c[0]===w.cat)||WCATS[4])[1],addr:isUrl(w.addr)?"":(w.addr||""),note:w.note||""}))};
}
let wp={list:[],res:null,busy:false,err:"",summary:""};
function wishesSheet(){
  const ro=S.canWrite===false;
  openSheet(`<h2>想去清單</h2>
  <p class="sub" style="margin-top:-6px">先把想去的餐廳和地點收集起來，再讓 AI 依地點和營業時間，建議排在第幾天的什麼時候。全家都可以一起加。</p>
  ${ro?"":`<form class="form" id="wishF">
    <label>名稱<input id="w_name" required placeholder="例如：牛舌 喜助、松島魚市場" autocomplete="off"></label>
    <div><div class="sub" style="margin-bottom:6px">類型</div><div class="tags" id="w_cats">${WCATS.map(([k,n])=>`<button type="button" data-wcat="${k}" aria-pressed="${k===wishCat}">${n}</button>`).join("")}</div></div>
    <div><div class="sub" style="margin-bottom:6px">有多想去</div><div class="tags" id="w_prios">${PRIOS.map(([k,n])=>`<button type="button" data-wprio="${k}" aria-pressed="${k===wishPrio}">${k==="must"?"⭐ ":""}${n}</button>`).join("")}</div></div>
    <label>地址或 Google 地圖連結（選填，有填會排得更準）<input id="w_addr" placeholder="貼上地址或 Google 地圖的「分享」連結"></label>
    <label>想什麼時候去、備註（選填）<input id="w_note" placeholder="例如：想吃晚餐、要預約、下雨備案、週末人多"></label>
    <div class="sheet-actions"><button class="primary" type="submit">加入清單</button></div>
  </form>`}
  <div class="wp-head"><h3>還沒排進行程 <span class="sub num" id="wishOpenN"></span></h3></div>
  ${ro?"":`<div class="wp-tools">${paceChips()}<div class="wp-go"><button class="primary sm" type="button" data-wishauto id="wpAuto">⚡ 一鍵排進行程</button><button class="ghost" type="button" data-wishplan id="wpGo">先看建議</button></div><p class="est" style="margin:0">一鍵排進行程：「一定要去」會全部排入，「想去」只在時間排得下時才插入，排不下的會留在清單裡告訴你原因。</p></div>`}
  <div id="wishOut" style="display:grid;gap:10px"></div>
  <div id="wishList" style="display:grid;gap:10px"></div>
  <details class="fold" id="wishDoneBox" style="margin-top:12px"><summary><h3 style="margin:0">已排進行程 <span class="sub num" id="wishDoneN"></span></h3></summary><div id="wishDone" style="display:grid;gap:10px;margin-top:10px"></div></details>`,"wishes");
  renderWishes();
  const f=$("wishF"); if(f) f.onsubmit=async e=>{ e.preventDefault();
    const name=$("w_name").value.trim(); if(!name) return;
    if((S.wishes||[]).some(w=>w.name===name&&!wishItem(w))){ toast("已經在清單裡"); return; }
    if(await guard(()=>put("wishes",null,{name,cat:wishCat,prio:wishPrio,addr:$("w_addr").value.trim(),note:$("w_note").value.trim(),...stampBy()}))){ $("w_name").value=""; $("w_addr").value=""; $("w_note").value=""; $("w_name").focus(); toast("已加入想去清單"); }
  };
}
function wishCard(w){
  const c=CATS[w.cat]||CATS.other; const it=wishItem(w); const ro=S.canWrite===false;
  const map=w.addr&&isUrl(w.addr)?w.addr:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(((w.addr&&!isUrl(w.addr))?w.addr:w.name)+" "+(S.trip?.destination||""))}`;
  return `<div class="idea" style="--cat:var(${c.v})">
    <div class="idea-top"><b style="font-size:16px">${esc(w.name)}</b><span class="badges">${prioBadge(w)}<span class="chip">${(WCATS.find(x=>x[0]===w.cat)||WCATS[4])[1]}</span></span></div>
    ${w.addr&&!isUrl(w.addr)?`<div class="note">📍 ${esc(w.addr)}</div>`:""}
    ${w.note?`<div class="sub">${esc(w.note)}</div>`:""}
    <div class="facts">${it?`<span><b>已排 Day ${it.day+1}${it.time?" "+esc(it.time):""}</b></span>`:""}<span>${esc(nameOf(w.by))} 加的</span></div>
    <div class="row-actions">
      ${it?`<button class="ghost" type="button" data-wishgo="${esc(it.id)}">看這天的行程</button>`:(ro?"":`<button class="ghost" type="button" data-wishmanual="${esc(w.id)}">自己排</button>`)}
      <a class="link" href="${esc(map)}" target="_blank" rel="noopener noreferrer">地圖 ↗</a>
      ${ro||it?"":`<button class="link" type="button" data-wishprio="${esc(w.id)}">${prioOf(w)==="must"?"改成想去":"改成一定要去"}</button><button class="link" type="button" data-wishrm="${esc(w.id)}" style="color:var(--bad)">刪除</button>`}
    </div>
  </div>`;
}
function renderWishes(){
  if(openSheetKind!=="wishes") return;
  const open=wishOpen().sort((a,b)=>(prioOf(a)==="must"?0:1)-(prioOf(b)==="must"?0:1)||a.at-b.at), done=(S.wishes||[]).filter(w=>wishItem(w)).sort((a,b)=>(wishItem(a).day-wishItem(b).day)||String(wishItem(a).time).localeCompare(String(wishItem(b).time)));
  const n1=$("wishOpenN"), n2=$("wishDoneN"); if(n1) n1.textContent=open.length||""; if(n2) n2.textContent=done.length||"";
  const go=$("wpGo"); if(go){ go.disabled=wp.busy||!open.length; go.textContent=wp.res&&!wp.auto?"重新建議":"先看建議"; }
  const au=$("wpAuto"); if(au){ au.disabled=wp.busy||!open.length; au.innerHTML=wp.busy?`<span class="spinner"></span>安排中…`:"⚡ 一鍵排進行程"; }
  const L=$("wishList"); if(L) L.innerHTML=open.length?open.map(wishCard).join(""):`<p class="sub" style="margin:0">${(S.wishes||[]).length?"都排進行程了。":"清單是空的。在上面輸入想去的地方，或在「找餐廳景點」的推薦裡按「♡ 收藏」。"}</p>`;
  const D=$("wishDone"); if(D) D.innerHTML=done.map(wishCard).join("");
  const box=$("wishDoneBox"); if(box) box.hidden=!done.length;
  renderWishPlan();
}
function renderWishPlan(){
  const out=$("wishOut"); if(!out) return;
  if(wp.busy){ out.innerHTML=`<div class="empty"><span class="spinner"></span>正在看每個地點離哪一天最近、什麼時候去最好…</div>`; return; }
  if(wp.err){ out.innerHTML=`<div class="alert warn">${esc(wp.err)}</div>`; return; }
  if(!wp.res){ out.innerHTML=""; return; }
  const n=S.trip?.days||1;
  const rows=wp.res.map((r,k)=>({...r,k,w:wp.list[r.i]})).filter(r=>r.w&&(S.wishes||[]).some(x=>x.id===r.w.id)&&!wishItem(r.w));
  if(!rows.length){ out.innerHTML=`<div class="alert warn" style="border-left-color:var(--ok)">建議的地點都排進行程了。</div>`; wp.res=null; return; }
  const can=rows.filter(r=>r.day);
  out.innerHTML=`<div class="wp-box">
    ${wp.summary?`<div style="font-size:15px">${esc(wp.summary)}</div>`:""}
    ${wp.auto?`<div class="wp-done">✅ 已排入 ${wp.added||0} 個地點。下面是這次排不下的，可以自己選天數加入，或改成「緊湊」再排一次。</div>`:""}
    ${can.length&&S.canWrite!==false?`<div class="row-actions"><button class="primary sm" type="button" data-wpall>全部照建議加入（${can.length}）</button><button class="link" type="button" data-wpclear>不用了</button></div>`:""}
    ${rows.map(r=>{
      let opts=`<option value="">先不排</option>`; for(let i=0;i<n;i++) opts+=`<option value="${i+1}" ${r.day===i+1?"selected":""}>Day ${i+1}　${dLabel(dayDate(i))}${dp(i).theme?"・"+esc(dp(i).theme.slice(0,10)):""}</option>`;
      return `<div class="idea wp-row">
        <div class="idea-top"><b>${esc(r.w.name)}</b><span class="badges">${prioBadge(r.w)}${r.day?`<span class="pill">Day ${r.day}${r.time?" "+esc(r.time):""}</span>`:`<span class="chip">${prioOf(r.w)==="must"?"排不進去":"時間排不下"}</span>`}</span></div>
        ${r.why?`<div style="font-size:14px">${esc(r.why)}</div>`:""}
        ${r.warn?`<div class="est">⚠️ ${esc(r.warn)}</div>`:""}
        ${S.canWrite!==false?`<div class="wp-edit"><label class="sub">排在<select id="wp_d${r.k}">${opts}</select></label><label class="sub">時間<input id="wp_t${r.k}" type="time" value="${esc(r.time||"")}"></label></div>
        <div class="row-actions"><button class="ghost" type="button" data-wpadd="${r.k}">＋ 加入行程</button>${r.duration?`<span class="sub">${esc(r.duration)}</span>`:""}</div>`:""}
      </div>`;
    }).join("")}
  </div>`;
}
async function runWishPlan(auto){
  if(wp.busy) return;
  const list=wishOpen().sort((a,b)=>(prioOf(a)==="must"?0:1)-(prioOf(b)==="must"?0:1)||a.at-b.at).slice(0,20);
  if(!list.length) return;
  wp={list,res:null,busy:true,err:"",summary:"",auto:!!auto,added:0}; renderWishes();
  try{
    const r=await ai("wishplan",wishParams(list));
    const n=S.trip?.days||1;
    const plans=(r?.plans||[]).map(x=>({i:Number(x.i),day:Number.isInteger(Number(x.day))&&Number(x.day)>=1&&Number(x.day)<=n?Number(x.day):null,time:/^\d{1,2}:\d{2}$/.test(x.time||"")?String(x.time).padStart(5,"0"):"",duration:String(x.duration||"").slice(0,20),why:String(x.why||"").slice(0,160),warn:String(x.warn||"").slice(0,100)})).filter(x=>list[x.i]);
    const seen=new Set(); wp.res=plans.filter(x=>!seen.has(x.i)&&seen.add(x.i)); wp.summary=String(r?.summary||"").slice(0,160);
    if(!wp.res.length) wp.err="這次沒有排出建議，請再試一次。";
  }catch(e){ console.warn(e); wp.err=aiError(e); }
  wp.busy=false; renderWishes();
  if(auto&&wp.res?.length) await addWishPlans(wp.res.map((r,k)=>k),true);
}
function wishToItem(w,day,time,r){
  return {day,time:time||"",end:endOf(time,r?.duration),title:w.name,cat:w.cat||"other",addr:w.addr||"",est:0,actual:0,note:[w.note,r?.duration,r?.warn].filter(Boolean).join("・"),wishId:w.id,...stampBy()};
}
async function addWishPlans(keys,auto){
  const days=new Set(); let added=0, skipped=0; const addedI=new Set();
  const ok=await guard(async()=>{
    for(const k of keys){
      const r=wp.res?.[k]; const w=r&&wp.list[r.i]; if(!w||wishItem(w)) continue;
      const dSel=$("wp_d"+k), tSel=$("wp_t"+k);
      const day=dSel?Number(dSel.value):r.day, time=tSel?tSel.value:r.time;
      if(!day){ skipped++; continue; }
      await put("items",null,wishToItem(w,day-1,time,r)); days.add(day-1); added++; addedI.add(r.i);
    }
  });
  if(ok&&auto){ wp.added=added; const left=(wp.res||[]).filter(r=>wp.list[r.i]&&!addedI.has(r.i)&&!wishItem(wp.list[r.i])); const mustLeft=left.filter(r=>prioOf(wp.list[r.i])==="must").length; toast(added?`已排入 ${added} 個地點${left.length?`，${left.length} 個${mustLeft?"（含一定要去）":""}這次排不下`:""}`:"這次沒有排得下的地點"); }
  if(ok){ if(auto){} else if(added) toast(`已加入 ${added} 個地點到行程${skipped?`，${skipped} 個先不排`:""}`); else if(skipped) toast("請先選要排在哪一天"); days.forEach(d=>scheduleLegs(d)); setTimeout(renderWishes,300); }
}

/* ---------- shopping lists: must-buy + recommended, each item with a note ---------- */
let shopList = "must";
const shopRows = l => (S.shopping||[]).filter(x=>(x.list==="rec"?"rec":"must")===l).sort((a,b)=>(a.bought?1:0)-(b.bought?1:0)||(a.at-b.at));
/* ---------- shopping images: small thumbnail, tap to view ---------- */
function openLightbox(src,caption){
  let lb=$("lightbox");
  if(!lb){
    lb=document.createElement("div"); lb.id="lightbox"; lb.className="lightbox"; lb.hidden=true;
    lb.setAttribute("role","dialog"); lb.setAttribute("aria-modal","true"); lb.setAttribute("aria-label","圖片");
    lb.innerHTML=`<button type="button" class="lb-x" aria-label="關閉">✕</button><img alt=""><p class="lb-cap"></p>`;
    document.body.appendChild(lb);
    lb.addEventListener("click",e=>{ if(e.target.tagName!=="IMG") closeLightbox(); });
    document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&!lb.hidden) closeLightbox(); });
  }
  lb.querySelector("img").src=src; lb.querySelector("img").alt=caption||""; lb.querySelector(".lb-cap").textContent=caption||"";
  lb.hidden=false; lb.querySelector(".lb-x").focus();
}
function closeLightbox(){ const lb=$("lightbox"); if(lb){ lb.hidden=true; lb.querySelector("img").removeAttribute("src"); } }
async function shrinkImage(file,max=1280){
  try{
    const bmp=await createImageBitmap(file);
    const sc=Math.min(1,max/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas"); c.width=Math.max(1,Math.round(bmp.width*sc)); c.height=Math.max(1,Math.round(bmp.height*sc));
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.85));
    if(blob&&blob.size) return blob;
  }catch(e){ console.warn("shrink",e); }
  return file;
}
const shopImgErr = e => ({too_large:"圖片太大了，請換一張",unsupported_type:"這種圖片格式不支援，請換一張 JPG 或 PNG",quota_or_state:"雲端空間已滿，請先刪除一些照片"}[e?.code] || "圖片沒有上傳成功，請再試一次");
const canShopImg = () => true;
const shopSrc = x => x.img || "";
async function uploadShopImg(file){ const blob=await shrinkImage(file); const ext=blob.type==="image/jpeg"?"jpg":((file.name.split(".").pop()||"img").toLowerCase()); const path=`trips/${S.tripId}/shopping/${Date.now()}.${ext}`; const task=uploadBytesResumable(sref(storage,path),blob,{contentType:blob.type||file.type||"image/jpeg"}); await new Promise((ok,no)=>task.on("state_changed",()=>{},no,ok)); return {img:await getDownloadURL(task.snapshot.ref),imgPath:path}; }
async function delShopImg(x){ if(x.imgPath) try{ await deleteObject(sref(storage,x.imgPath)); }catch(e){ console.warn(e); } }
function renderShopBar(){
  const b=$("shopBar"); if(!b) return;
  b.hidden=!S.trip;
  const must=shopRows("must"), rec=shopRows("rec"), got=must.filter(x=>x.bought).length;
  b.innerHTML=`<span class="wb-ico" aria-hidden="true">🛍</span><span class="wb-text"><b>購物清單</b><span class="sub">${must.length||rec.length?`一定要買 ${must.length} 項${must.length?`（已買 ${got}）`:""}・推薦 ${rec.length} 項`:"記下一定要買的東西，也可以讓 AI 推薦當地必買"}</span></span>${must.length-got>0?`<span class="wb-n">${must.length-got}</span>`:""}<span aria-hidden="true" class="sub">›</span>`;
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
function shopParams(){
  const t=S.trip, n=t.days||1;
  return {destination:t.destination||t.title,dates:dayDate(0)?`${iso(dayDate(0))} 起 ${n} 天`:"",travelers:t.travelers||1,who:t.who||"",likes:t.likes||[],have:(S.shopping||[]).map(x=>x.name).slice(0,40)};
}
let shopAi={busy:false,err:"",n:0};
function shoppingSheet(){
  const ro=S.canWrite===false;
  openSheet(`<h2>購物清單</h2>
  <p class="sub" style="margin-top:-6px">分成「一定要買」和「推薦購買」，每一項都可以加備註，例如幫誰買、要買幾個、在哪裡買。買到了就打勾。</p>
  ${ro?"":`<form class="form" id="shopF">
    <label>要買什麼<input id="s_name" required placeholder="例如：白色戀人、合利他命、Tokyo Banana" autocomplete="off"></label>
    <div><div class="sub" style="margin-bottom:6px">放進哪個清單</div><div class="tags">${[["must","⭐ 一定要買"],["rec","推薦購買"]].map(([k,n])=>`<button type="button" data-slist="${k}" aria-pressed="${k===shopList}">${n}</button>`).join("")}</div></div>
    <label>備註（選填）<input id="s_note" placeholder="例如：幫媽媽買 2 盒、機場免稅店比較便宜"></label>
    ${canShopImg()?`<div class="row-actions"><label class="upload">📷 附上圖片（選填）<input type="file" id="s_img" accept="image/*"></label><span class="sub" id="s_imgn"></span></div>`:""}
    <div class="sheet-actions"><button class="primary" type="submit">加入清單</button></div>
  </form>`}
  <div class="wp-head"><h3>⭐ 一定要買 <span class="sub num" id="shopMustN"></span></h3></div>
  <ul class="shop-list" id="shopMust"></ul>
  <div class="wp-head"><h3>推薦購買 <span class="sub num" id="shopRecN"></span></h3>${ro?"":`<button class="primary sm" type="button" data-shopai id="shopAiBtn">✨ 推薦當地必買</button>`}</div>
  <div id="shopAiMsg"></div>
  <ul class="shop-list" id="shopRec"></ul>`,"shopping");
  renderShopping();
  const si=$("s_img"); if(si) si.onchange=()=>{ $("s_imgn").textContent=si.files[0]?`已選：${si.files[0].name}`:""; };
  const f=$("shopF"); if(f) f.onsubmit=async e=>{ e.preventDefault();
    const name=$("s_name").value.trim(); if(!name) return;
    if((S.shopping||[]).some(x=>x.name===name)){ toast("清單裡已經有了"); return; }
    const fileEl=$("s_img"); const file=fileEl?.files?.[0]; let imgF={};
    if(file){ const btn=f.querySelector("button[type=submit]"); btn.disabled=true; btn.textContent="上傳圖片中…"; try{ imgF=await uploadShopImg(file); }catch(err){ console.warn(err); toast(shopImgErr(err)); btn.disabled=false; btn.textContent="加入清單"; return; } btn.disabled=false; btn.textContent="加入清單"; }
    if(await guard(()=>put("shopping",null,{name,list:shopList,note:$("s_note").value.trim(),bought:false,...imgF,...stampBy()}))){ $("s_name").value=""; $("s_note").value=""; if(fileEl){ fileEl.value=""; $("s_imgn").textContent=""; } $("s_name").focus(); toast(shopList==="must"?"已加入一定要買":"已加入推薦購買"); }
  };
}
function shopRow(x){
  const ro=S.canWrite===false; const rec=x.list==="rec";
  const info=[x.where&&`🏪 ${x.where}`,x.price&&`💰 ${x.price}`].filter(Boolean);
  return `<li class="shop-item ${x.bought?"done":""} ${shopSrc(x)?"has-img":""}">
    <input type="checkbox" id="sb_${esc(x.id)}" data-sbought="${esc(x.id)}" ${x.bought?"checked":""} ${ro?"disabled":""} aria-label="買到了：${esc(x.name)}">
    ${shopSrc(x)?`<button class="shop-thumb" type="button" data-simg="${esc(x.id)}" aria-label="放大看 ${esc(x.name)} 的圖片"><img src="${esc(shopSrc(x))}" alt="" loading="lazy"></button>`:""}
    <div class="shop-main">
      <button class="shop-name" type="button" data-sedit="${esc(x.id)}" ${ro?"disabled":""}><b>${esc(x.name)}</b>${x.nameLocal&&x.nameLocal!==x.name?`<span class="sub">${esc(x.nameLocal)}</span>`:""}</button>
      ${x.note?`<div class="shop-note">📝 ${esc(x.note)}</div>`:""}
      ${info.length?`<div class="facts">${info.map(i=>`<span>${esc(i)}</span>`).join("")}</div>`:""}
      ${x.why?`<div class="sub">${esc(x.why)}</div>`:""}
      ${x.tip?`<div class="est">提醒：${esc(x.tip)}</div>`:""}
      ${ro?"":`<div class="row-actions"><button class="link" type="button" data-sedit="${esc(x.id)}">${x.note?"改備註":"＋ 備註"}</button><button class="link" type="button" data-smove="${esc(x.id)}">${rec?"⭐ 移到一定要買":"移到推薦"}</button></div>`}
    </div>
  </li>`;
}
function renderShopping(){
  if(openSheetKind!=="shopping") return;
  const must=shopRows("must"), rec=shopRows("rec");
  const mn=$("shopMustN"), rn=$("shopRecN"); if(mn) mn.textContent=must.length?`${must.filter(x=>x.bought).length}/${must.length}`:""; if(rn) rn.textContent=rec.length||"";
  const M=$("shopMust"); if(M) M.innerHTML=must.length?must.map(shopRow).join(""):`<li class="sub" style="list-style:none">還沒有。在上面輸入名稱，或把推薦的移過來。</li>`;
  const R=$("shopRec"); if(R) R.innerHTML=rec.length?rec.map(shopRow).join(""):`<li class="sub" style="list-style:none">按「✨ 推薦當地必買」，AI 會依旅行地和季節推薦伴手禮和特產。</li>`;
  const btn=$("shopAiBtn"); if(btn){ btn.disabled=shopAi.busy; btn.innerHTML=shopAi.busy?`<span class="spinner"></span>推薦中…`:(rec.length?"✨ 再推薦一些":"✨ 推薦當地必買"); }
  const msg=$("shopAiMsg"); if(msg) msg.innerHTML=shopAi.busy?`<div class="empty" style="margin-bottom:8px"><span class="spinner"></span>正在找${esc(S.trip?.destination||"當地")}值得買的東西…</div>`:shopAi.err?`<div class="alert warn" style="margin-bottom:8px">${esc(shopAi.err)}</div>`:"";
}
async function runShopAi(){
  if(shopAi.busy||!S.trip) return;
  shopAi={busy:true,err:"",n:0}; renderShopping();
  try{
    const r=await ai("shopping",shopParams());
    const have=new Set((S.shopping||[]).map(x=>x.name));
    const list=(r?.items||[]).filter(x=>x&&x.name&&!have.has(String(x.name))).slice(0,10);
    const ok=await guard(async()=>{ for(const x of list) await put("shopping",null,{name:String(x.name).slice(0,60),nameLocal:String(x.nameLocal||"").slice(0,60),where:String(x.where||"").slice(0,80),price:String(x.price||"").slice(0,60),why:String(x.why||"").slice(0,120),tip:String(x.tip||"").slice(0,100),list:"rec",note:"",bought:false,ai:true,...stampBy()}); });
    shopAi.n=list.length; if(ok) toast(list.length?`推薦了 ${list.length} 樣`:"沒有新的推薦了");
  }catch(e){ console.warn(e); shopAi.err=aiError(e); }
  shopAi.busy=false; renderShopping();
}
function shopItemSheet(id){
  const x=(S.shopping||[]).find(v=>v.id===id); if(!x) return;
  openSheet(`<h2>${esc(x.name)}</h2>
  ${x.nameLocal&&x.nameLocal!==x.name?`<p class="sub" style="margin-top:-6px">${esc(x.nameLocal)}</p>`:""}
  <form class="form" id="shopEditF">
    <label>名稱<input id="se_name" required value="${esc(x.name)}"></label>
    <label>備註<textarea id="se_note" rows="3" placeholder="例如：幫阿姨買 3 盒、要找抹茶口味、退稅要滿 ¥5,000">${esc(x.note||"")}</textarea></label>
    <div class="shop-imgedit">${shopSrc(x)?`<button class="shop-thumb lg" type="button" data-simg="${esc(x.id)}" aria-label="放大看圖片"><img src="${esc(shopSrc(x))}" alt=""></button>`:""}<div style="display:grid;gap:6px">${canShopImg()?`<label class="upload" style="justify-self:start">📷 ${shopSrc(x)?"更換圖片":"附上圖片"}<input type="file" id="se_img" accept="image/*"></label>`:""}<span class="sub" id="se_imgn"></span>${shopSrc(x)&&canShopImg()?`<button class="link" type="button" id="se_rmimg" style="color:var(--bad);justify-self:start">移除圖片</button>`:""}</div></div>
    <div><div class="sub" style="margin-bottom:6px">清單</div><div class="tags">${[["must","⭐ 一定要買"],["rec","推薦購買"]].map(([k,n])=>`<button type="button" data-selist="${k}" aria-pressed="${(x.list==="rec"?"rec":"must")===k}">${n}</button>`).join("")}</div></div>
    <label class="shop-check"><input type="checkbox" id="se_bought" ${x.bought?"checked":""}> 已經買到了</label>
    ${x.where||x.price||x.why?`<div class="sub">${[x.where&&"🏪 "+esc(x.where),x.price&&"💰 "+esc(x.price),x.why&&esc(x.why)].filter(Boolean).join("<br>")}</div>`:""}
    <div class="sheet-actions"><button class="primary" type="submit">儲存</button><button class="ghost" type="button" data-shopback>返回清單</button><button class="danger" type="button" id="se_del">刪除</button></div>
  </form>`,"shopitem");
  let list=x.list==="rec"?"rec":"must";
  document.querySelectorAll("[data-selist]").forEach(b=>b.onclick=()=>{ list=b.dataset.selist; document.querySelectorAll("[data-selist]").forEach(y=>y.setAttribute("aria-pressed",y===b)); });
  $("shopEditF").onsubmit=async e=>{ e.preventDefault(); const name=$("se_name").value.trim(); if(!name) return;
    let imgF={}; const file=$("se_img")?.files?.[0];
    if(file){ const btn=$("shopEditF").querySelector("button[type=submit]"); btn.disabled=true; btn.textContent="上傳圖片中…"; try{ imgF=await uploadShopImg(file); }catch(err){ console.warn(err); toast(shopImgErr(err)); btn.disabled=false; btn.textContent="儲存"; return; } }
    else if(rmImg) imgF={img:"",imgPath:""};
    const {id:_,...r}=x; if(await guard(()=>put("shopping",id,{...r,...imgF,name,note:$("se_note").value.trim(),list,bought:$("se_bought").checked}))){ if((file||rmImg)&&x.img) delShopImg(x); toast("已儲存"); shoppingSheet(); } };
  const sei=$("se_img"); if(sei) sei.onchange=()=>{ $("se_imgn").textContent=sei.files[0]?`儲存後會換成：${sei.files[0].name}`:""; };
  let rmImg=false; const rb=$("se_rmimg"); if(rb) rb.onclick=()=>{ rmImg=true; if(sei) sei.value=""; $("se_imgn").textContent="儲存後會移除圖片"; };
  const d=$("se_del"); let armed=false; d.onclick=async()=>{ if(!armed){ armed=true; d.textContent="再按一次確認刪除"; return; } if(await guard(()=>del("shopping",id))){ delShopImg(x); toast("已刪除"); shoppingSheet(); } };
}

/* ---------- journal cards: time-stamped entries inside each day ---------- */
const canW = () => S.canWrite!==false;
const nowHM = () => { const d=new Date(); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
const newEntryId = () => "e"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function dayEntries(i){
  const list=(S.entries||[]).filter(e=>e.day===i).sort((a,b)=>(a.time||"99:99").localeCompare(b.time||"99:99")||(a.at-b.at));
  const j=S.journal?.["d"+i];
  return j?.text ? [{id:"legacy"+i,day:i,time:"",text:j.text,legacy:true,by:j.by,at:j.at},...list] : list;
}
const entryOf = id => (S.entries||[]).find(e=>e.id===id) || (/^legacy\d+$/.test(id)?dayEntries(Number(id.slice(6))).find(e=>e.id===id):null);
const loose = files => files.filter(m=>!m.entryId||!(S.entries||[]).some(e=>e.id===m.entryId));
function entryCard(e){
  const photos=S.media.filter(m=>m.entryId===e.id).sort((a,b)=>a.at-b.at);
  const first=String(e.text||"").split("\n")[0];
  return `<details class="entry fold" data-fold="e:${esc(e.id)}" ${isOpen("e:"+e.id)?"open":""}>
    <summary><span class="e-time">${esc(e.time||"—")}</span><span class="e-line">${esc(first||(photos.length?"照片":""))}</span>${photos.length?`<span class="e-ph">📷 ${photos.length}</span>`:""}</summary>
    <div class="fold-body">
      ${e.place?`<div class="sub">📍 ${esc(e.place)}</div>`:""}
      ${String(e.text||"").split("\n").slice(1).join("\n").trim()?`<div class="e-text">${esc(String(e.text).split("\n").slice(1).join("\n").trim())}</div>`:""}
      ${photos.length?`<div class="grid">${photos.map(m=>`<button class="thumb" type="button" data-media="${esc(m.id)}" aria-label="${esc(m.name)}">${m.type?.startsWith("video")?`<video src="${esc(m.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="tag">影片</span>`:`<img src="${esc(m.url)}" alt="" loading="lazy">`}</button>`).join("")}</div>`:""}
      <div class="row-actions"><span class="sub">${esc(nameOf(e.by))}${e.at?"・"+stamp(e.at):""}</span>${canW()?`<button class="link" type="button" data-editentry="${esc(e.id)}">編輯</button>`:""}</div>
    </div>
  </details>`;
}
function entriesBlock(i){
  const list=dayEntries(i);
  return `<div class="entries">${list.length?list.map(entryCard).join(""):`<p class="sub" style="margin:0">還沒有日記。按下面的按鈕寫第一則，時間會自動帶入。</p>`}</div>
    ${canW()?`<button class="ghost e-add" type="button" data-newentry="${i}">＋ 寫一則日記</button>`:""}`;
}
function entrySheet(id,day){
  const e=id?entryOf(id):{day,time:nowHM(),text:"",place:""};
  if(!e) return;
  const n=S.trip?.days||1; let opts=""; for(let i=0;i<n;i++) opts+=`<option value="${i}" ${i===e.day?"selected":""}>Day ${i+1}　${dLabel(dayDate(i))}</option>`;
  const its=dayList(e.day).filter(x=>x.time);
  openSheet(`<h2>${id?"編輯日記":"寫一則日記"}</h2>
  <p class="sub" style="margin-top:-6px">${esc(folderName(e.day))}　${dLabel(dayDate(e.day))}</p>
  <form class="form" id="entryF">
    <div class="row2"><label>時間（自動帶入，可以改）<input id="e_time" type="time" value="${esc(e.time||"")}"></label><label>哪一天<select id="e_day">${opts}</select></label></div>
    ${its.length?`<div><div class="sub" style="margin-bottom:6px">從這天的行程帶入時間和地點（選填）</div><div class="quick" style="margin-top:0" id="e_items">${its.map(x=>`<button type="button" data-eitem="${esc(x.id)}">${esc(x.time)} ${esc(String(x.title).replace(/^✈\s*/,"").slice(0,16))}</button>`).join("")}</div></div>`:""}
    <label>地點（選填）<input id="e_place" value="${esc(e.place||"")}" placeholder="例如：成田機場、園區裡的咖啡廳"></label>
    <label>寫點什麼<textarea id="e_text" rows="4" placeholder="例如：到達日本！大家都很興奮">${esc(e.text||"")}</textarea></label>
    ${true?`<label class="upload" style="justify-self:start">＋ 附上照片／影片<input type="file" id="e_files" accept="image/*,video/*" multiple></label><span class="sub" id="e_fn"></span>`:""}
    <div class="sheet-actions"><button class="primary" type="submit">儲存</button><button class="ghost" type="button" data-close>取消</button>${id?`<button class="danger" type="button" id="e_del">刪除</button>`:""}</div>
  </form>`,"entry");
  const box=$("e_items"); if(box) box.onclick=ev=>{ const b=ev.target.closest("[data-eitem]"); if(!b) return; const it=S.items.find(x=>x.id===b.dataset.eitem); if(!it) return; $("e_time").value=it.time||""; $("e_place").value=String(it.title).replace(/^✈\s*/,""); box.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed",x===b)); };
  $("e_day").onchange=()=>{ const v=Number($("e_day").value); const keep={time:$("e_time").value,place:$("e_place").value,text:$("e_text").value}; if(!id){ entrySheet(null,v); $("e_time").value=keep.time; $("e_place").value=keep.place; $("e_text").value=keep.text; } };
  const fi=$("e_files"); if(fi) fi.onchange=()=>{ $("e_fn").textContent=fi.files.length?`已選 ${fi.files.length} 個檔案`:""; };
  $("entryF").onsubmit=async ev=>{ ev.preventDefault();
    const text=$("e_text").value.trim(); const files=fi?[...fi.files]:[];
    if(!text&&!files.length){ $("e_text").focus(); toast("寫點什麼或附上照片"); return; }
    const sb=stampBy(); const eid=(!id||e.legacy)?newEntryId():id; const dayV=Number($("e_day").value);
    const body={day:dayV,time:$("e_time").value,place:$("e_place").value.trim(),text,by:e.by||sb.by,at:e.at||sb.at,editedAt:Date.now()};
    const ok=await guard(async()=>{ await put("entries",eid,body); if(e.legacy) await saveJournal(e.day,{text:""}); });
    if(!ok) return;
    folds=[...new Set([...(folds||[...document.querySelectorAll("details[data-fold][open]")].map(x=>x.dataset.fold)),"trip","d"+dayV,"e:"+eid])]; saveFolds();
    closeSheet(); toast(id?"已儲存":"日記已新增"); renderJournal();
    if(files.length) uploadFiles(dayV,files,eid);
  };
  const eDel=$("e_del"); if(eDel){ let armed=false; eDel.onclick=async()=>{ if(!armed){ armed=true; eDel.textContent="再按一次確認刪除"; return; }
    const ok=e.legacy?await saveJournal(e.day,{text:""}):await guard(()=>del("entries",id));
    if(ok){ closeSheet(); toast("已刪除，附上的照片會留在「其他照片」"); renderJournal(); } }; }
}

/* ---------- journal: collapsible sections ---------- */
const FOLD_KEY="tripFolds2";
let folds=(()=>{ try{ const v=JSON.parse(localStorage.getItem(FOLD_KEY)||"null"); return Array.isArray(v)?v:null; }catch{ return null; } })();
function saveFolds(){ try{ localStorage.setItem(FOLD_KEY,JSON.stringify(folds||[])); }catch{} }
function todayIdx(){ const t=S.trip; if(!t?.startDate) return -1; const d=Math.floor((Date.now()-new Date(t.startDate+"T00:00:00"))/864e5); return d>=0&&d<(t.days||1)?d:-1; }
const isOpen = k => folds ? folds.includes(k) : (k==="trip"||k==="d"+Math.max(0,todayIdx()));
document.addEventListener("toggle",e=>{
  const d=e.target; if(!(d instanceof HTMLDetailsElement)||!d.dataset.fold) return;
  const cur=new Set(folds||[...document.querySelectorAll("details[data-fold][open]")].map(x=>x.dataset.fold));
  if(d.open) cur.add(d.dataset.fold); else cur.delete(d.dataset.fold);
  folds=[...cur]; saveFolds();
},true);
document.addEventListener("toggle",e=>{ const d=e.target; if(d instanceof HTMLDetailsElement && d.dataset.trippick && d.open){ subscribeTrip(d.dataset.trippick); folds=[...new Set([...(folds||[]),"trip"])]; saveFolds(); toast("已切換旅行"); } },true);
function foldAll(open){
  const keys=[...document.querySelectorAll("section[data-tab='journal'] details[data-fold]")].map(d=>d.dataset.fold);
  folds=open?keys:[]; saveFolds();
  document.querySelectorAll("section[data-tab='journal'] details[data-fold]").forEach(d=>{ d.open=open; });
}

/* ---------- day plans: rough plan per day + route suggestion ---------- */
const THEMES = ["抵達後先到旅館放行李、休息","旅館附近散步、吃晚餐","前往主要景點","主題樂園玩一整天","購物逛街","溫泉放鬆","移動日（換城市）","自由活動","親子景點","最後一天：退房、買伴手禮、去機場"];
const dp = i => (S.dayplans||{})["d"+i] || {};
function dayPlanCard(){
  const t=S.trip; if(!t) return "";
  const p=dp(S.day);
  if(!p.theme && !p.hotel) return `<button class="dp-empty" type="button" data-editplans>＋ 寫下這天的大致規劃<span class="sub">例如：下飛機先到旅館放行李，附近逛逛</span></button>`;
  return `<button class="dp-card" type="button" data-editplans>
    <span class="dp-label">這天的規劃</span>
    ${p.theme?`<span class="dp-theme">${esc(p.theme)}</span>`:""}
    ${p.hotel?`<span class="sub">住宿：${esc(p.hotel)}</span>`:""}
  </button>`;
}
function plansSheet(){
  const t=S.trip; if(!t) return;
  const n=t.days||1; let rows="";
  for(let i=0;i<n;i++){
    const p=dp(i);
    rows+=`<div class="leg">
      <b>Day ${i+1}　${dLabel(dayDate(i))}</b>
      <label class="sub">大致規劃<textarea id="pl_t${i}" rows="2" placeholder="例如：${esc(i===0?"下飛機先到旅館放行李，附近逛逛":i===n-1?"退房、買伴手禮、去機場":"前往主要景點")}" ${S.canWrite===false?"disabled":""}>${esc(p.theme||"")}</textarea></label>
      ${S.canWrite===false?"":`<div class="quick" style="margin-top:0">${THEMES.map(x=>`<button type="button" data-plantheme="${i}" data-val="${esc(x)}">＋ ${esc(x)}</button>`).join("")}</div>`}
      <label class="sub">住宿（選填，排路線時會從這裡出發、回到這裡）<input id="pl_h${i}" value="${esc(p.hotel||"")}" placeholder="例如：仙台站前 Dormy Inn" ${S.canWrite===false?"disabled":""}></label>
    </div>`;
  }
  openSheet(`<h2>整趟的大致規劃</h2>
  <p class="sub" style="margin-top:-6px">先寫下每天想做什麼，再到每一天按「依規劃排行程和路線」，AI 會幫你排時間和交通。</p>
  <div style="display:grid;gap:10px">${rows}</div>
  ${S.canWrite===false?"":`<div class="sheet-actions sheet-foot" style="margin-top:12px"><button class="primary" type="button" id="plSave">儲存規劃</button><button class="ghost" type="button" data-close>取消</button></div>`}`,"plans");
  const el=$("pl_t"+S.day); if(el) setTimeout(()=>el.scrollIntoView({block:"center"}),50);
  const sv=$("plSave"); if(sv) sv.onclick=async()=>{
    sv.disabled=true;
    const ok=await guard(async()=>{ for(let i=0;i<n;i++){ const theme=$("pl_t"+i).value.trim(), hotel=$("pl_h"+i).value.trim(); const cur=dp(i); if(theme!==(cur.theme||"")||hotel!==(cur.hotel||"")) await put("dayplans","d"+i,{theme,hotel,...stampBy()}); } });
    if(ok){ closeSheet(); toast("規劃已儲存"); render(); } else sv.disabled=false;
  };
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
let route={day:null,tripId:null,res:null,busy:false,err:""};
function dayPlanParams(){
  const t=S.trip, day=S.day, n=t.days||1;
  const fixed=S.items.filter(x=>x.day===day).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99")).map(x=>`${x.time||"未定時間"}${x.end?"–"+x.end:""} ${x.title}`);
  const arr=S.items.find(x=>x.day===day&&x.flightItem&&/^抵達/.test(x.title));
  return {destination:t.destination||t.title,date:dayDate(day)?iso(dayDate(day)):"",dayIndex:day+1,totalDays:n,travelers:t.travelers||1,who:t.who||"",likes:t.likes||[],budget:t.budget||0,currency:t.currency||"TWD",
    pace:paceOf(),theme:dp(day).theme||"",hotel:dp(day).hotel||"",prevHotel:day>0?dp(day-1).hotel||"":"",prevTheme:day>0?dp(day-1).theme||"":"",nextTheme:day<n-1?dp(day+1).theme||"":"",
    arrival:arr?`${arr.time} ${arr.title}`:"",fixed};
}
function routeSheet(){
  const t=S.trip; if(!t) return;
  if(route.day!==S.day||route.tripId!==S.tripId) route={day:S.day,tripId:S.tripId,res:null,busy:false,err:""};
  const p=dp(S.day);
  openSheet(`<h2>排這天的行程和路線</h2>
  <p class="sub" style="margin-top:-6px">Day ${S.day+1}　${dLabel(dayDate(S.day))}・${esc(t.destination||t.title||"")}</p>
  <div class="dp-card" style="cursor:default"><span class="dp-label">這天的規劃</span><span class="dp-theme">${esc(p.theme||"還沒寫，AI 會自己安排合適的一天")}</span>${p.hotel?`<span class="sub">住宿：${esc(p.hotel)}</span>`:""}</div>
  <div style="margin-top:10px">${paceChips()}</div>
  <div class="row-actions" style="margin-top:10px"><button class="primary sm" type="button" id="rtGo">${route.res?"重新排":"幫我排"}</button><button class="link" type="button" data-editplans>修改規劃</button></div>
  <p class="est">已排的行程（例如航班）會保留原時間，AI 只會排在空檔。地點和交通時間請點「地圖路線」確認。</p>
  <div id="rtOut" style="display:grid;gap:10px;margin-top:8px"></div>`,"route");
  renderRoute(); $("rtGo").onclick=runRoute;
}
const MODE_ICON={步行:"🚶",電車:"🚃",巴士:"🚌",計程車:"🚕",自駕:"🚗",船:"⛴️"};
function mapsRoute(stops,hotel){
  const dest=S.trip?.destination||"";
  const q=s=>`${s.nameLocal||s.name} ${s.area||""}`.trim();
  const pts=stops.filter(s=>s.cat!=="move").map(q);
  if(hotel) { pts.unshift(hotel+" "+dest); pts.push(hotel+" "+dest); }
  if(pts.length<2) return "";
  const origin=pts[0], destination=pts[pts.length-1], way=pts.slice(1,-1).slice(0,8);
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}${way.length?`&waypoints=${encodeURIComponent(way.join("|"))}`:""}&travelmode=transit`;
}
function renderRoute(){
  const out=$("rtOut"); if(!out||openSheetKind!=="route") return;
  if(route.busy){ out.innerHTML=`<div class="empty"><span class="spinner"></span>正在排時間和交通…</div>`; return; }
  if(route.err){ out.innerHTML=`<div class="alert warn">${esc(route.err)}</div>`; return; }
  const r=route.res; if(!r){ out.innerHTML=""; return; }
  const have=new Set(S.items.filter(x=>x.day===route.day).map(x=>x.title));
  const left=r.stops.filter(s=>!have.has(s.name)).length;
  const link=mapsRoute(r.stops,dp(route.day).hotel);
  out.innerHTML=`${r.summary?`<div style="font-size:15px">${esc(r.summary)}</div>`:""}
  <div class="row-actions">${S.canWrite!==false?`<button class="primary sm" type="button" data-rtall ${left?"":"disabled"}>${left?`全部加入這天（${left} 站）`:"都加入了"}</button>`:""}${link?`<a class="ghost" style="text-decoration:none" href="${esc(link)}" target="_blank" rel="noopener noreferrer">地圖路線 ↗</a>`:""}</div>
  <div class="route">${r.stops.map((s,i)=>{
    const c=CATS[s.cat]||CATS.other; const m=s.move||{}; const done=have.has(s.name);
    return `${m.mode||m.minutes?`<div class="rt-move">${MODE_ICON[m.mode]||"➜"} ${esc(m.mode||"")}${m.minutes?` 約 ${esc(m.minutes)} 分`:""}${m.detail?`・${esc(m.detail)}`:""}</div>`:""}
    <div class="item rt-stop" style="--cat:var(${c.v})">
      <span class="t">${esc(s.time||"")}${s.end?`<br><span class="sub">–${esc(s.end)}</span>`:""}</span>
      <span class="card"><span class="ttl">${esc(s.name)}</span>
        <span class="meta"><span class="chip">${c.label}</span>${s.area?`<span>${esc(s.area)}</span>`:""}${s.perPerson?`<span class="num">每人約 ${money(s.perPerson)}</span>`:""}</span>
        ${s.note?`<span class="note" style="display:block">${esc(s.note)}</span>`:""}
        ${S.canWrite!==false?`<span class="row-actions" style="margin-top:6px"><button class="ghost" type="button" data-rtadd="${i}" ${done?"disabled":""}>${done?"已加入":"＋ 加入"}</button></span>`:""}
      </span></div>`;
  }).join("")}</div>
  ${Array.isArray(r.tips)&&r.tips.length?`<div class="panel" style="padding:12px 14px"><b style="font-size:14px">提醒</b><ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${r.tips.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></div>`:""}`;
}
async function runRoute(){
  if(route.busy) return;
  route.busy=true; route.err=""; renderRoute(); const go=$("rtGo"); if(go) go.disabled=true;
  try{
    const r=await ai("dayplan",dayPlanParams());
    const stops=(r?.stops||[]).filter(s=>s&&s.name).slice(0,14).map(s=>({...s,cat:CATS[s.cat]?s.cat:(s.cat==="stay"?"stay":"other"),perPerson:Number(s.perPerson)||0,time:/^\d{1,2}:\d{2}$/.test(s.time||"")?s.time.padStart(5,"0"):"",end:/^\d{1,2}:\d{2}$/.test(s.end||"")?s.end.padStart(5,"0"):""}));
    route.res=stops.length?{summary:r.summary||"",stops,tips:(r.tips||[]).slice(0,5)}:null;
    if(!stops.length) route.err="這次沒有排出行程，請把規劃寫具體一點再試一次。";
  }catch(e){ route.err=aiError(e); console.warn(e); }
  route.busy=false; renderRoute(); const g2=$("rtGo"); if(g2){ g2.disabled=false; g2.textContent="重新排"; }
}
function stopToItem(s,prevName){
  const m=s.move||{};
  const mv=m.mode||m.minutes?`從上一站：${m.mode||""}${m.minutes?` 約 ${m.minutes} 分`:""}${m.detail?`（${m.detail}）`:""}`:"";
  return {day:route.day,addr:s.address||"",...(prevName&&(m.mode||m.minutes)?{legHint:{fromName:prevName,mode:m.mode||"",minutes:Number(m.minutes)||"",detail:m.detail||""}}:{}),time:s.time||"",end:s.end||endOf(s.time,s.duration),title:s.name,cat:s.cat,est:(s.perPerson||0)*(S.trip?.travelers||1),actual:0,note:[s.nameLocal&&s.nameLocal!==s.name?s.nameLocal:"",s.end?`到 ${s.end}`:"",s.note,mv].filter(Boolean).join("・"),...stampBy()};
}
async function addRouteStops(idx){
  const r=route.res; if(!r) return;
  const have=new Set(S.items.filter(x=>x.day===route.day).map(x=>x.title));
  const list=(idx==null?r.stops:[r.stops[idx]]).filter(s=>s&&!have.has(s.name));
  const ok=await guard(async()=>{ for(const s of list){ const k=r.stops.indexOf(s); await put("items",null,stopToItem(s,k>0?r.stops[k-1].name:"")); } });
  if(ok){ toast(idx==null?`已加入 ${list.length} 站到 Day ${route.day+1}`:`已加入 Day ${route.day+1}`); setTimeout(renderRoute,300); scheduleLegs(route.day); }
}

/* ---------- fares ---------- */
let fareForm=null;
function faresSheet(to){
  const t=S.trip||{};
  fareForm={from:t.airportFrom||fareForm?.from||DEFAULT_ORIGIN,to:iata(to||t.airportTo||fareForm?.to||""),out:t.startDate||fareForm?.out||"",back:t.startDate?addDays(t.startDate,(t.days||1)-1):(fareForm?.back||""),pax:t.travelers||fareForm?.pax||2};
  openSheet(`<h2>機票比價</h2>
  <div class="form">
    <div class="row2"><label>出發機場<input id="fa_from" value="${esc(fareForm.from)}" maxlength="3" autocapitalize="characters" list="apList" placeholder="TPE"></label><label>抵達機場<input id="fa_to" value="${esc(fareForm.to)}" maxlength="3" autocapitalize="characters" list="apList" placeholder="例如 NRT"></label></div>
    <div id="apBoxF"></div>
    <div class="row2"><label>去程<input id="fa_out" type="date" value="${esc(fareForm.out)}"></label><label>回程<input id="fa_back" type="date" value="${esc(fareForm.back)}"></label></div>
    <label>人數<input id="fa_pax" type="number" min="1" max="9" inputmode="numeric" value="${esc(fareForm.pax)}"></label>
    <datalist id="apList">${AIRPORTS.map(s=>`<option value="${s.slice(0,3)}">${s}</option>`).join("")}</datalist>
  </div>
  <h3 style="font-size:15px;margin:16px 0 8px">到這些網站查即時票價</h3>
  <div class="links" id="fareLinks"></div>
  <p class="est">會開新分頁搜尋。查到價格後，回來把報價記在下面，全家一起比較。</p>
  <h2 style="margin-top:20px;font-size:17px">報價比較</h2>
  <div id="fareList" style="display:grid;gap:10px"></div>
  <details style="margin-top:12px" id="fareAdd"><summary class="link" style="cursor:pointer;list-style:none">＋ 記錄一筆報價</summary>
  <form class="form" id="fareF" style="margin-top:10px">
    <div class="row2"><label>航空公司<input id="q_air" required placeholder="例如 星宇航空"></label><label>總價（全部人數）<input id="q_price" type="number" min="0" inputmode="numeric" required></label></div>
    <div class="leg"><b>去程</b>
      <div class="row2"><label>班次<input id="q_onum" placeholder="例如 IT254" autocapitalize="characters"></label><label>日期<input id="q_odate" type="date" value="${esc(fareForm.out)}"></label></div>
      <div class="row2"><label>起飛時間<input id="q_odep" type="time"></label><label>抵達時間（當地）<input id="q_oarr" type="time"></label></div>
    </div>
    <div class="leg"><b>回程</b>
      <div class="row2"><label>班次<input id="q_rnum" placeholder="例如 IT229" autocapitalize="characters"></label><label>日期<input id="q_rdate" type="date" value="${esc(fareForm.back)}"></label></div>
      <div class="row2"><label>起飛時間（當地）<input id="q_rdep" type="time"></label><label>抵達時間<input id="q_rarr" type="time"></label></div>
      <div class="row2"><label>從哪個機場回<input id="q_rfrom" maxlength="3" autocapitalize="characters" list="apList" value="${esc(fareForm.to)}"></label><label>回到哪個機場<input id="q_rto" maxlength="3" autocapitalize="characters" list="apList" value="${esc(fareForm.from)}"></label></div>
    </div>
    <div class="row2"><label>託運行李<input id="q_bag" placeholder="每人 23kg"></label><label>查到的網站<input id="q_site" placeholder="例如 Trip.com"></label></div>
    <label>備註<input id="q_note" placeholder="例如 直飛、可退改"></label>
    <div class="sheet-actions"><button class="primary" type="submit">加入比較</button></div>
  </form></details>`,"fares");
  updateFareLinks(); refreshOpenSheet("fares");
  ["fa_from","fa_to","fa_out","fa_back","fa_pax"].forEach(id=>$(id).addEventListener("input",updateFareLinks));
  airportPicker($("apBoxF"),{getDest:()=>S.trip?.destination||"",getOrigin:()=>iata($("fa_from").value)||DEFAULT_ORIGIN,getMonth:()=>($("fa_out").value||"").slice(0,7),getPax:()=>Number($("fa_pax").value)||1,onPick:code=>{ $("fa_to").value=code; updateFareLinks(); }});
  $("fareF").onsubmit=async e=>{ e.preventDefault();
    const v=id=>$(id).value.trim();
    const o={num:v("q_onum").toUpperCase(),date:v("q_odate"),dep:v("q_odep"),arr:v("q_oarr"),from:fareForm.from,to:fareForm.to};
    const r={num:v("q_rnum").toUpperCase(),date:v("q_rdate"),dep:v("q_rdep"),arr:v("q_rarr"),from:IATA(v("q_rfrom"))||fareForm.to,to:IATA(v("q_rto"))||fareForm.from};
    const body={airline:$("q_air").value.trim(),price:Number($("q_price").value)||0,o,r,out:legText(o),back:legText(r),bag:$("q_bag").value.trim(),site:$("q_site").value.trim(),note:$("q_note").value.trim(),route:`${fareForm.from}-${fareForm.to}`,pax:fareForm.pax,...stampBy()};
    if(!body.airline||!body.price) return;
    if(!S.tripId){ toast("請先建立旅行"); return; }
    if(await guard(()=>put("fares",null,body))){ $("fareF").reset(); $("fareAdd").open=false; toast("已加入比較"); } };
}
function updateFareLinks(){
  const g=id=>$(id)?.value?.trim()||"";
  fareForm={from:iata(g("fa_from")),to:iata(g("fa_to")),out:g("fa_out"),back:g("fa_back"),pax:Math.max(1,Number(g("fa_pax"))||1)};
  const {from,to,out,back,pax}=fareForm; const el=$("fareLinks"); if(!el) return;
  if(from.length!==3||to.length!==3||!out){ el.innerHTML=`<p class="sub" style="grid-column:1/-1;margin:0">填入出發、抵達機場三碼和去程日期後，這裡會出現比價連結。不知道飛哪個機場？按上面的「推薦最近和最划算的機場」。</p>`; return; }
  const yymmdd=s=>s.slice(2).replace(/-/g,"");
  const q=encodeURIComponent(`Flights from ${from} to ${to} on ${out}${back?` through ${back}`:""} ${pax} adults`);
  const L=[["Google 航班",`https://www.google.com/travel/flights?q=${q}&hl=zh-TW&curr=TWD`],
    ["Skyscanner",`https://www.skyscanner.com.tw/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yymmdd(out)}/${back?yymmdd(back)+"/":""}?adultsv2=${pax}&cabinclass=economy`],
    ["Trip.com",`https://tw.trip.com/flights/showfarefirst?dcity=${from.toLowerCase()}&acity=${to.toLowerCase()}&ddate=${out}${back?`&rdate=${back}&triptype=rt`:"&triptype=ow"}&class=y&quantity=${pax}&locale=zh-TW&curr=TWD`],
    ["KAYAK",`https://www.kayak.com.tw/flights/${from}-${to}/${out}${back?"/"+back:""}/${pax}adults`]];
  el.innerHTML=L.map(([n,u])=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${n}<span aria-hidden="true">↗</span></a>`).join("");
}
/* ---------- put a chosen flight into the itinerary ---------- */
const IATA = v => String(v||"").toUpperCase().replace(/[^A-Z]/g,"").slice(0,3);
const apName = c => ((AIRPORTS.find(s=>s.startsWith(c+" "))||"").slice(4)) || c;
const legText = l => [l.num, l.dep&&l.dep, l.from&&l.to?`${l.from} → ${l.to}`:"", l.arr?`${l.arr} 抵達`:""].filter(Boolean).join(" ");
const toMin = t => { const [h,m]=String(t).split(":").map(Number); return h*60+m; };
const fromMin = m => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
const addMin = (t,m) => { if(!/^\d{1,2}:\d{2}$/.test(t||"")) return ""; let x=toMin(t)+Number(m||0); if(x>1439) x=1439; return fromMin(x); };
function parseDur(s){ s=String(s||"").replace(/一個半小時/g,"1.5小時").replace(/半小時/g,"30分").replace(/一/g,"1").replace(/[兩二]/g,"2").replace(/三/g,"3").replace(/四/g,"4"); if(/半天/.test(s)) return 240; if(/整天|全天/.test(s)) return 480; let m=0; const h=s.match(/(\d+(?:\.\d+)?)\s*(?:個)?\s*(?:小時|hr|h)/i); if(h) m+=Math.round(parseFloat(h[1])*60); const mi=s.match(/(\d+)\s*分/); if(mi) m+=Number(mi[1]); return m; }
const endOf = (t,dur) => { const m=parseDur(dur); return t&&m?addMin(t,m):""; };
function dayOf(date,fallback){ const t=S.trip; if(!date||!t?.startDate) return fallback; const d=Math.round((new Date(date+"T00:00:00")-new Date(t.startDate+"T00:00:00"))/864e5); return d>=0&&d<(t.days||1)?d:fallback; }
function shift(day,time,minus){ let m=toMin(time)-minus; if(m<0){ if(day>0){ day--; m+=1440; } else return {day,time:"00:00",prev:fromMin(m+1440)}; } return {day,time:fromMin(m)}; }
function flightPlan(f){
  const t=S.trip||{}; const last=(t.days||1)-1; const items=[]; const pax=f.pax||t.travelers||"";
  const o=f.o||{}, r=f.r||{};
  const dOut=dayOf(o.date,0), dRet=dayOf(r.date,last);
  const extra=[f.site,f.bag&&"行李 "+f.bag,f.note].filter(Boolean).join("・");
  if(o.dep){
    const pre=shift(dOut,o.dep,150);
    items.push({day:pre.day,time:pre.time,end:pre.day===dOut?o.dep:"",addr:`${apName(o.from)}機場`,title:`前往${apName(o.from)}機場報到`,cat:"move",est:0,note:pre.prev?`紅眼班機：前一天 ${pre.prev} 前要到機場`:"國際線建議起飛前 2.5 小時到機場"});
    items.push({day:dOut,time:o.dep,end:o.arr&&toMin(o.arr)>toMin(o.dep)?o.arr:"",title:`✈ 去程 ${o.num||f.airline} ${o.from} → ${o.to}`,cat:"move",est:f.price,note:[`${f.airline}・${pax} 人來回機票`,o.arr&&`${o.arr} 抵達`,extra].filter(Boolean).join("・")});
    if(o.arr) items.push({day:Math.min(last,dOut+(toMin(o.arr)<toMin(o.dep)?1:0)),time:o.arr,addr:`${apName(o.to)}機場`,title:`抵達${apName(o.to)}（${o.to}），入境`,cat:"move",est:0,note:""});
  }
  if(r.dep){
    const pre=shift(dRet,r.dep,150);
    items.push({day:pre.day,time:pre.time,end:pre.day===dRet?r.dep:"",addr:`${apName(r.from)}機場`,title:`前往${apName(r.from)}機場報到`,cat:"move",est:0,note:pre.prev?`紅眼班機：前一天 ${pre.prev} 前要到機場`:"國際線建議起飛前 2.5 小時到機場"});
    items.push({day:dRet,time:r.dep,end:r.arr&&toMin(r.arr)>toMin(r.dep)?r.arr:"",title:`✈ 回程 ${r.num||f.airline} ${r.from} → ${r.to}`,cat:"move",est:o.dep?0:f.price,note:[r.arr&&`${r.arr} 抵達`,o.dep?"":`${f.airline}・${pax} 人來回機票`].filter(Boolean).join("・")});
  }
  if(!items.length) items.push({day:0,time:"",title:`機票：${f.airline}（${pax} 人）`,cat:"move",est:f.price,note:extra});
  return items;
}
function useFare(id){
  const f=S.fares.find(x=>x.id===id); if(!f) return;
  if(!S.trip){ toast("請先建立旅行"); return; }
  const plan=flightPlan(f); const old=S.items.filter(x=>x.flightItem||x.fareItem);
  const needDates=!S.trip.startDate&&f.o?.date;
  openSheet(`<h2>把這班機放進行程？</h2>
    <p class="sub" style="margin-top:-6px">${esc(f.airline)}・${money(f.price,"TWD")}${f.o?.date?`・去 ${esc(f.o.date)}`:""}${f.r?.date?`・回 ${esc(f.r.date)}`:""}</p>
    <div style="display:grid;gap:8px">${plan.map(it=>`<div class="idea" style="padding:10px 12px"><div class="facts"><span><b>Day ${it.day+1}</b></span><span class="num">${esc(it.time||"—")}</span>${it.est?`<span class="num">${money(it.est,"TWD")}</span>`:""}</div><div>${esc(it.title)}</div>${it.note?`<div class="est">${esc(it.note)}</div>`:""}</div>`).join("")}</div>
    ${old.length?`<p class="sub">之前放進行程的 ${old.length} 筆航班項目會被換掉。</p>`:""}
    ${needDates?`<p class="sub">旅行還沒設定出發日，會用去程日期 ${esc(f.o.date)} 當作 Day 1。</p>`:""}
    ${!f.o?.dep?`<p class="sub">這筆報價沒有填起飛時間，只會加入機票費用。想放進時間表的話，請刪掉重新記錄並填上班次和時間。</p>`:""}
    <div class="sheet-actions"><button class="primary" type="button" id="doFare">確定加入行程</button><button class="ghost" type="button" data-close>取消</button></div>`);
  $("doFare").onclick=()=>applyFare(f);
}
async function applyFare(f){
  const btn=$("doFare"); if(btn) btn.disabled=true;
  const t={...S.trip};
  if(!t.startDate&&f.o?.date){ t.startDate=f.o.date; if(f.r?.date){ const n=Math.round((new Date(f.r.date+"T00:00:00")-new Date(f.o.date+"T00:00:00"))/864e5)+1; if(n>0&&n<=21) t.days=n; } }
  const ok=await guard(async()=>{
    await put("trip",null,{...t,flightOut:f.out||t.flightOut||"",flightBack:f.back||t.flightBack||"",fareId:f.id,airportFrom:f.o?.from||t.airportFrom||"",airportTo:f.o?.to||t.airportTo||""});
    S.trip=t;
    for(const x of S.items.filter(x=>x.flightItem||x.fareItem)) await del("items",x.id);
    for(const it of flightPlan(f)) await put("items",null,{...it,actual:0,flightItem:true,fareId:f.id,...stampBy()});
  });
  if(ok){ closeSheet(); S.day=dayOf(f.o?.date,0); toast("航班已放進行程，機票費用也加進預算了"); render(); scheduleLegs(S.day); }
  else if(btn) btn.disabled=false;
}

function refreshOpenSheet(kind){
  if(kind!==openSheetKind||$("sheet").hidden) return;
  if(kind==="suggest"){ renderSug(); return; }
  if(kind==="route"){ renderRoute(); return; }
  if(kind==="wishes"){ renderWishes(); return; }
  if(kind==="shopping"){ renderShopping(); return; }
  if(kind==="trips"){ const el=$("tripList"); if(!el) return; el.innerHTML=S.trips.length?S.trips.map(t=>`<button class="trip-row" type="button" data-pick="${esc(t.id)}" aria-current="${t.id===S.tripId}"><span><b>${esc(t.title||"未命名")}</b><span class="sub">${esc(t.destination||"")}${t.startDate?"・"+esc(t.startDate):""}</span></span><span aria-hidden="true">›</span></button>`).join(""):`<p class="sub">還沒有旅行。</p>`; }
  if(kind==="ideas"){ const el=$("ideaList"); if(!el) return; const list=[...S.ideas].sort((a,b)=>((b.likes||[]).length-(a.likes||[]).length)||(b.at-a.at)); el.innerHTML=list.length?list.map(ideaCard).join(""):`<p class="sub" style="margin:0">還沒有候選地。輸入想去的地方並按「加入候選」，家人就能一起投票。</p>`; }
  if(kind==="fares"){ const el=$("fareList"); if(!el) return; const list=[...S.fares].sort((a,b)=>a.price-b.price); const min=list[0]?.price;
    el.innerHTML=list.length?list.map((f,i)=>`<div class="fare ${i===0?"best":""}">
      <div><b>${esc(f.airline)}</b>${i===0&&list.length>1?`<span class="pill">最便宜</span>`:""}${S.trip?.fareId===f.id?`<span class="pill" style="background:var(--lantern);color:#2a1d05">已採用</span>`:""}</div>
      <div class="price">${money(f.price,"TWD")}</div>
      <div class="full">${f.pax?`${f.pax} 人・每人 ${money(f.price/f.pax,"TWD")}`:""}${i>0?`・比最便宜貴 ${money(f.price-min,"TWD")}`:""}</div>
      ${f.out?`<div class="full">去：${esc(f.out)}</div>`:""}${f.back?`<div class="full">回：${esc(f.back)}</div>`:""}
      ${f.bag||f.site||f.note?`<div class="full">${[f.bag&&"行李 "+f.bag,f.site,f.note].filter(Boolean).map(esc).join("・")}</div>`:""}
      <div class="full row-actions" style="margin-top:4px"><button class="ghost" type="button" data-usefare="${esc(f.id)}">放進行程</button><button class="link" type="button" data-rmfare="${esc(f.id)}" style="color:var(--bad)">刪除</button></div>
    </div>`).join(""):`<p class="sub" style="margin:0">還沒有報價。</p>`; }
}

/* ---------- PDF ---------- */
function pdfHTML(){
  const t=S.trip, n=t.days||1; let days="";
  for(let i=0;i<n;i++){
    const list=S.items.filter(x=>x.day===i).sort((a,b)=>(a.time||"99").localeCompare(b.time||"99"));
    days+=`<h2>Day ${i+1}　${dLabel(dayDate(i))}</h2>`;
    if(dp(i).theme||dp(i).hotel) days+=`<p style="margin:0 0 8px;font-size:13px;color:#7a5b1c">${dp(i).theme?"規劃："+esc(dp(i).theme):""}${dp(i).theme&&dp(i).hotel?"　":""}${dp(i).hotel?"住宿："+esc(dp(i).hotel):""}</p>`;
    if(i===0&&t.flightOut) days+=`<p style="margin:0 0 6px;font-size:13px">✈ 去程：${esc(t.flightOut)}</p>`;
    days+=list.length?`<table><tr><th style="width:96px">時間</th><th>行程</th><th style="width:60px">分類</th><th class="r" style="width:110px">費用</th></tr>${list.map(x=>`<tr><td>${esc(x.time||"")}${x.end?"–"+esc(x.end):""}</td><td>${esc(x.title)}${x.note?`<div style="color:#666;font-size:12px">${esc(x.note)}</div>`:""}</td><td>${(CATS[x.cat]||CATS.other).label}</td><td class="r">${costOf(x)?money(costOf(x)):"—"}</td></tr>`).join("")}</table>`:`<p style="color:#888;font-size:13px">（尚未安排）</p>`;
    const j=S.journal["d"+i];
    if(j?.driveUrl) days+=`<p style="font-size:12px;color:#2F6B55;margin:6px 0;word-break:break-all">雲端相簿（${esc(folderName(i))}）：${esc(j.driveUrl)}</p>`;
    const ents=dayEntries(i); if(ents.length) days+=`<div style="font-size:13px;background:#F6F3EA;padding:8px 10px;border-radius:6px;display:grid;gap:4px">${ents.map(x=>`<div style="white-space:pre-wrap">📓 <b>${esc(x.time||"")}</b> ${x.place?"［"+esc(x.place)+"］":""}${esc(x.text||"")}</div>`).join("")}</div>`;
    if(i===n-1&&t.flightBack) days+=`<p style="margin:6px 0 0;font-size:13px">✈ 回程：${esc(t.flightBack)}</p>`;
  }
  const plan=S.items.reduce((s,x)=>s+costOf(x),0); const byCat={}; for(const x of S.items){ const c=costOf(x); if(c) byCat[x.cat]=(byCat[x.cat]||0)+c; }
  const open=S.comments.filter(c=>!c.resolved);
  return `<div class="pdf-page">
    <div style="font-size:13px;color:#2F6B55;letter-spacing:.08em">${esc(t.destination||"")}</div>
    <h1>${esc(t.title||"我的旅行")}</h1>
    <div style="font-size:14px;color:#555">${t.startDate?`${dLabel(dayDate(0))} – ${dLabel(dayDate(n-1))}・`:""}${n} 天・${t.travelers||1} 人</div>
    ${days}
    <h2>預算</h2>
    <table><tr><th>分類</th><th class="r">金額</th></tr>${Object.entries(CATS).filter(([k])=>byCat[k]).map(([k,c])=>`<tr><td>${c.label}</td><td class="r">${money(byCat[k])}</td></tr>`).join("")}
    <tr><th>合計</th><th class="r">${money(plan)}</th></tr><tr><td>總預算</td><td class="r">${money(t.budget)}</td></tr><tr><td>剩餘</td><td class="r">${money((t.budget||0)-plan)}</td></tr><tr><td>每人平均</td><td class="r">${money(plan/(t.travelers||1))}</td></tr></table>
    ${(S.shopping||[]).length?`<h2>購物清單</h2>${[["must","一定要買"],["rec","推薦購買"]].map(([k,n])=>{ const L=shopRows(k); return L.length?`<p style="margin:6px 0 2px;font-size:13px;font-weight:700">${n}</p>${L.map(x=>`<div style="font-size:13px">${x.bought?"☑":"☐"} ${esc(x.name)}${x.note?`<span style="color:#7a5b1c">（${esc(x.note)}）</span>`:""}${x.where?`<span style="color:#888">・${esc(x.where)}</span>`:""}</div>`).join("")}`:""; }).join("")}`:""}
    ${S.packing.length?`<h2>行李清單</h2><div style="columns:2;font-size:13px">${S.packing.map(p=>`<div>${p.done?"☑":"☐"} ${esc(p.text)}</div>`).join("")}</div>`:""}
    ${open.length?`<h2>待討論</h2><ul style="font-size:13px;padding-left:18px">${open.map(c=>{const it=S.items.find(x=>x.id===c.itemId);return `<li>${it?`［Day ${it.day+1} ${esc(it.title)}］`:""}${esc(c.text)}</li>`}).join("")}</ul>`:""}
    <p style="font-size:11px;color:#999;margin-top:24px">產生時間 ${new Date().toLocaleString("zh-TW")}</p></div>`;
}
async function buildPdf(){
    const stage=$("pdfStage"); stage.innerHTML=pdfHTML();
    if(document.fonts?.ready) await document.fonts.ready;
    const canvas=await window.html2canvas(stage.firstElementChild,{scale:2,backgroundColor:"#ffffff"});
    stage.innerHTML="";
    const { jsPDF }=window.jspdf; const pdf=new jsPDF({unit:"pt",format:"a4"});
    const pw=pdf.internal.pageSize.getWidth(), ph=pdf.internal.pageSize.getHeight(), sliceH=Math.floor(canvas.width*ph/pw);
    for(let y=0,p=0;y<canvas.height;y+=sliceH,p++){
      const c=document.createElement("canvas"); c.width=canvas.width; c.height=Math.min(sliceH,canvas.height-y);
      c.getContext("2d").drawImage(canvas,0,y,canvas.width,c.height,0,0,canvas.width,c.height);
      if(p) pdf.addPage(); pdf.addImage(c.toDataURL("image/jpeg",0.92),"JPEG",0,0,pw,c.height*pw/canvas.width);
    }
    const name=(S.trip.title||"旅行").replace(/[\\/:*?"<>|]/g,"")+".pdf";
    return {blob:pdf.output("blob"),name};
}
async function makePdf(){
  if(!S.trip){ $("pdfMsg").textContent="請先建立旅行。"; return; }
  const btn=$("btnPdf"), msg=$("pdfMsg"); btn.disabled=true; msg.textContent="正在產生 PDF…";
  try{
    const {blob,name}=await buildPdf(); const file=new File([blob],name,{type:"application/pdf"});
    if(driveOpt("pdf")&&DRIVE.state!=="notset") driveSave({filename:`${safeName(S.trip.title)}_行程表.pdf`,mimeType:"application/pdf",blob,replace:true}).then(r=>{ if(r) toast("PDF 也存到雲端硬碟了"); });
    if(navigator.canShare?.({files:[file]})){ await navigator.share({files:[file],title:S.trip.title}); msg.textContent="可以選「儲存到檔案」→ Google 雲端硬碟。"; }
    else { const a=document.createElement("a"); a.href=URL.createObjectURL(file); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000); msg.textContent="PDF 已下載。"; }
  }catch(e){ msg.textContent=e?.name==="AbortError"?"已取消。":"PDF 沒有產生成功，請稍後再試。"; console.warn(e); }
  finally{ btn.disabled=false; }
}

/* ---------- Google Drive auto backup (through the Worker and your Apps Script) ---------- */
const DRIVE={state:"unknown",folderUrl:"",msg:"",trip:""};
const driveOpt = k => (S.trip?.drive||{})[k]!==false;
const safeName = s => String(s||"旅行").replace(/[\\/:*?"<>|]/g,"").trim()||"旅行";
const blobToB64 = b => new Promise((ok,no)=>{ const r=new FileReader(); r.onload=()=>ok(String(r.result).split(",")[1]||""); r.onerror=no; r.readAsDataURL(b); });
const driveErr = e => ({drive_not_set:"中繼伺服器還沒設定雲端硬碟（DRIVE_SCRIPT_URL、DRIVE_SECRET）。",drive_secret:"密碼不一致：Apps Script 的 SECRET 要和 Worker 的 DRIVE_SECRET 一樣。",too_large:"檔案太大，沒有存到雲端硬碟。",network:"連不到中繼伺服器，請檢查網路。",no_proxy:"還沒設定中繼伺服器（config.js 的 AI_PROXY_URL）。",not_family:"這個帳號不在家人名單。",bad_token:"登入過期，請重新整理頁面。"}[e?.code]||"存到雲端硬碟失敗，請按「測試連線」檢查。");
async function driveCall(body){
  if(!AI_PROXY_URL) throw {code:"no_proxy"};
  const token=await auth.currentUser.getIdToken();
  let res; try{ res=await fetch(AI_PROXY_URL.replace(/\/$/,"")+"/drive",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json",...keyHeader()},body:JSON.stringify(body)}); }catch{ throw {code:"network"}; }
  const j=await res.json().catch(()=>({})); if(!res.ok) throw {code:j.error||("http_"+res.status)}; return j;
}
function driveFail(e){ console.warn("drive",e); DRIVE.state=(e?.code==="drive_not_set"||e?.code==="no_proxy")?"notset":"error"; DRIVE.msg=driveErr(e); renderDrivePanel(); }
async function driveSave({sub="",filename,mimeType,blob,replace=false}){
  if(DRIVE.state==="notset"||!S.trip) return null;
  try{
    const j=await driveCall({action:"save",trip:safeName(S.trip.title),sub,filename,mimeType:mimeType||blob.type||"application/octet-stream",data:await blobToB64(blob),replace});
    DRIVE.state="ok"; DRIVE.msg=""; if(!sub&&j.folderUrl){ DRIVE.folderUrl=j.folderUrl; DRIVE.trip=S.trip.title; } renderDrivePanel(); return j;
  }catch(e){ driveFail(e); return null; }
}
async function drivePing(){
  if(!S.trip) return; DRIVE.state="checking"; renderDrivePanel();
  try{ const j=await driveCall({action:"ping",trip:safeName(S.trip.title)}); DRIVE.state="ok"; DRIVE.msg=""; DRIVE.folderUrl=j.folderUrl||""; DRIVE.trip=S.trip.title; renderDrivePanel(); toast(`已連線，「${S.trip.title}」資料夾準備好了`); }
  catch(e){ driveFail(e); }
}
function renderDrivePanel(){ ["drivePanel","drivePanel2"].forEach(id=>renderDriveInto($(id))); }
function renderDriveInto(el){ if(!el) return;
  const t=S.trip; if(!t){ el.innerHTML=`<p class="sub" style="margin:0">先建立旅行。</p>`; return; }
  if(DRIVE.trip&&DRIVE.trip!==t.title){ DRIVE.folderUrl=""; DRIVE.trip=""; }
  const st={ok:`<span class="dot"></span><span>已連線，檔案會存到「${esc(t.title)}」資料夾</span>`,checking:`<span class="spinner"></span><span>檢查中…</span>`,notset:`<span class="dot off"></span><span>還沒設定。請照 README「自動存到 Google 雲端硬碟」的步驟設定一次。</span>`,error:`<span class="dot off"></span><span>${esc(DRIVE.msg||"連線失敗")}</span>`,unknown:`<span class="dot off"></span><span>還沒檢查連線</span>`}[DRIVE.state];
  const opt=(k,label)=>`<label class="shop-check"><input type="checkbox" data-driveopt="${k}" ${driveOpt(k)?"checked":""}> ${label}</label>`;
  el.innerHTML=`<p class="sub" style="margin:0 0 10px">會在你的雲端硬碟資料夾裡自動建立「${esc(t.title)}」資料夾；每天的照片放進「${esc(folderName(0))}」這樣的子資料夾，備份檔放在「專案存檔」。</p>
    <div class="drive-status">${st}</div>
    <div style="display:grid;gap:8px;margin:12px 0">${opt("snap","按「儲存目前的專案」時，自動存行程表 PDF 和備份檔")}${opt("pdf","按「產生行程 PDF」時，也存一份")}${opt("photos","上傳照片和影片時，同步到每天的資料夾（30 MB 以下）")}</div>
    <div class="row-actions"><button class="ghost" type="button" data-driveping>測試連線</button>${DRIVE.folderUrl?`<a class="link" href="${esc(DRIVE.folderUrl)}" target="_blank" rel="noopener noreferrer">打開「${esc(t.title)}」資料夾 ↗</a>`:""}</div>`;
}
async function backupSnapshot(body){
  if(!driveOpt("snap")||DRIVE.state==="notset"||!S.trip) return;
  const st=new Date().toLocaleString("sv-SE").slice(0,16).replace(" ","_").replace(":","");
  const a=await driveSave({sub:"專案存檔",filename:`${safeName(S.trip.title)}_${st}.json`,mimeType:"application/json",blob:new Blob([JSON.stringify(body,null,2)],{type:"application/json"})});
  if(!a) return;
  let pdf=null; try{ const p=await buildPdf(); pdf=await driveSave({filename:`${safeName(S.trip.title)}_行程表.pdf`,mimeType:"application/pdf",blob:p.blob,replace:true}); }catch(e){ console.warn(e); }
  toast(pdf?`已備份到雲端硬碟「${S.trip.title}」資料夾`:`備份檔已存到雲端硬碟，行程表 PDF 沒有存成功`);
}
async function syncPhotosToDrive(day,files,big){
  if(DRIVE.state==="notset"||!files.length) return;
  let n=0, url="";
  for(const f of files){ const j=await driveSave({sub:folderName(day),filename:f.name,mimeType:f.type,blob:f}); if(!j) break; n++; url=j.folderUrl||url; }
  if(n){ toast(`${n} 個檔案也同步到雲端硬碟「${folderName(day)}」了${big?`（${big} 個超過 30 MB 沒有同步）`:""}`); if(url&&!S.journal["d"+day]?.driveUrl) saveJournal(day,{driveUrl:url}); }
}

/* ---------- settings + save button ---------- */
const PREF_KEY="tripPrefs";
const HOST_THEME=document.documentElement.getAttribute("data-theme");
let prefs=(()=>{ try{ return JSON.parse(localStorage.getItem(PREF_KEY)||"{}")||{}; }catch{ return {}; } })();
function savePrefs(){ try{ localStorage.setItem(PREF_KEY,JSON.stringify(prefs)); }catch{} }
function applyPrefs(){
  const r=document.documentElement;
  if(prefs.theme==="light"||prefs.theme==="dark") r.setAttribute("data-theme",prefs.theme);
  else if(HOST_THEME) r.setAttribute("data-theme",HOST_THEME); else r.removeAttribute("data-theme");
  document.body.style.zoom=({large:"1.12",xl:"1.25"})[prefs.text]||"";
}
applyPrefs();
const AUTO_DEF={on:false,every:30,keep:20};
const autoCfg = () => ({...AUTO_DEF,...(S.trip?.autosave||{})});
function hashOf(o){
  const norm=v=>Array.isArray(v)?v.map(norm):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().filter(k=>!["autosave","drive","pace"].includes(k)).map(k=>[k,norm(v[k])])):v;
  const items=[...(o.items||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const packing=[...(o.packing||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const s=JSON.stringify(norm({trip:o.trip||null,items,packing,dayplans:o.dayplans||{}}));
  let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0; return String(h>>>0);
}
const curHash = () => hashOf({trip:S.trip,items:S.items,packing:S.packing,dayplans:S.dayplans});
const lastSnap = () => [...(S.snaps||[])].sort((a,b)=>b.at-a.at)[0];
const isDirty = () => { if(!S.trip) return false; const l=lastSnap(); if(!l) return S.items.length>0||S.packing.length>0; return (l.hash||hashOf(l))!==curHash(); };
function renderSaveBtn(){
  const b=$("btnSave"); if(!b) return;
  const ro=S.canWrite===false;
  b.disabled=!S.trip||ro||saving;
  const d=isDirty(); b.classList.toggle("dirty",d);
  b.setAttribute("aria-label",d?"儲存目前的專案（有還沒儲存的修改）":"儲存目前的專案");
  b.title=d?"有還沒儲存的修改":"已經是最新的版本";
}
let saving=false;
async function saveNow(auto){
  if(saving||!S.trip||S.canWrite===false) return false;
  saving=true; renderSaveBtn(); const b=$("btnSave"); if(b&&!auto) b.classList.add("busy");
  const ok=await saveSnapshot(auto);
  saving=false; if(b) b.classList.remove("busy"); renderSaveBtn();
  if(ok) prune();
  return ok;
}
async function prune(){
  const keep=Number(autoCfg().keep)||0; if(!keep) return;
  const autos=[...(S.snaps||[])].filter(s=>s.auto).sort((a,b)=>b.at-a.at);
  for(const s of autos.slice(keep)) try{ await del("snapshots",s.id); }catch(e){ console.warn(e); }
}
function autoTick(){
  const c=autoCfg(); if(!c.on||!S.trip||S.canWrite===false||saving) return;
  if(!isDirty()) return;
  const l=lastSnap(); if(l&&Date.now()-l.at<Number(c.every)*60000) return;
  if(Date.now()-(lastEdit||0)<45000) return;      // 等大家停手 45 秒再存
  saveNow(true);
}
let lastEdit=0;
document.addEventListener("input",()=>{ lastEdit=Date.now(); },true);
setInterval(autoTick,60000);
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden"){ lastEdit=0; autoTick(); } });
function settingsSheet(){
  const t=S.trip, c=autoCfg(), l=lastSnap(), ro=S.canWrite===false;
  const chips=(key,opts,cur)=>`<div class="tags">${opts.map(([k,n])=>`<button type="button" data-pref="${key}" data-val="${k}" aria-pressed="${(cur||opts[0][0])===k}">${n}</button>`).join("")}</div>`;
  openSheet(`<h2>設定</h2>
  <section class="set-sec"><h3>我的名稱</h3>
    <p class="sub">家人看到你留言、寫日記、上傳照片時，會顯示這個名稱。</p>
    <form class="inline-row" id="nameF"><label class="sub" style="flex:1">顯示名稱<input id="set_name" maxlength="20" value="${esc((S.users[S.user?.uid]?.nick||S.user?.displayName||""))}" placeholder="例如：媽媽、小美" ${(S.user?.uid||null)?"":"disabled"}></label><button class="primary sm" type="submit" ${(S.user?.uid||null)?"":"disabled"}>儲存名稱</button></form>
    ${(S.user?.uid||null)?"":`<p class="est">登入後才能設定名稱。</p>`}
  </section>
  <section class="set-sec"><h3>這趟旅行</h3>
    <div class="set-rows">
      <button class="set-row" type="button" data-settrip><span><b>旅行設定</b><span class="sub">${t?esc(t.title)+"・名稱、日期、人數、預算、航班":"還沒建立旅行"}</span></span><span aria-hidden="true">›</span></button>
      <button class="set-row" type="button" data-settrips><span><b>切換或建立旅行</b><span class="sub">目前有 ${S.trips.length} 個旅行</span></span><span aria-hidden="true">›</span></button>
    </div>
  </section>
  <section class="set-sec"><h3>儲存</h3>
    <div class="set-status">${l?`上次儲存：${stamp(l.at)}・${esc(nameOf(l.by))}${l.auto?"（自動）":""}`:"還沒有儲存過"}　${isDirty()?`<span class="pill" style="background:var(--lantern);color:#2a1d05">有修改還沒存</span>`:(l?`<span class="sub">已是最新</span>`:"")}</div>
    <button class="primary" type="button" data-savenow ${!t||ro?"disabled":""} style="margin-top:10px">💾 現在儲存一個版本</button>
    <label class="shop-check" style="margin-top:12px"><input type="checkbox" id="set_auto" ${c.on?"checked":""} ${!t||ro?"disabled":""}> 有修改時自動儲存版本</label>
    <div class="row2" style="margin-top:8px"><label class="sub">多久存一次<select id="set_every" ${!t||ro?"disabled":""}>${[15,30,60,120].map(m=>`<option value="${m}" ${Number(c.every)===m?"selected":""}>每 ${m>=60?m/60+" 小時":m+" 分鐘"}</option>`).join("")}</select></label>
      <label class="sub">自動版本最多保留<select id="set_keep" ${!t||ro?"disabled":""}>${[[10,"10 個"],[20,"20 個"],[50,"50 個"],[0,"全部保留"]].map(([v,n])=>`<option value="${v}" ${Number(c.keep)===v?"selected":""}>${n}</option>`).join("")}</select></label></div>
    <p class="est">自動儲存是整趟旅行共用的設定。版本都在「日誌 → 專案存檔」，可以隨時還原；手動按 💾 存的版本不會被自動刪掉。按 💾 存的版本也會照下面的設定備份到 Google 雲端硬碟；自動儲存的版本只存在 App 裡。</p>
    <div class="set-sub"><h4>Google 雲端硬碟備份</h4><div id="drivePanel2"></div></div>
  </section>
  <section class="set-sec"><h3>顯示（只影響這支手機）</h3>
    <div class="sub" style="margin-bottom:6px">外觀</div>${chips("theme",[["auto","跟隨系統"],["light","淺色"],["dark","深色"]],prefs.theme)}
    <div class="sub" style="margin:12px 0 6px">字體大小</div>${chips("text",[["normal","標準"],["large","大"],["xl","特大"]],prefs.text)}
  </section>
  ${LINK_MODE?`<section class="set-sec"><h3>家庭連結</h3><p class="sub">用這個連結打開就能使用，不用登入。拿到連結的人都能看和修改這趟旅行，只傳給家人。</p><div class="code-box">${esc(familyLink())}</div><div class="row-actions"><button class="primary sm" type="button" data-copylink>複製家庭連結</button><button class="ghost" type="button" data-leavelink>這支手機不再使用</button></div></section>`:""}${LINK_MODE?"":`<section class="set-sec"><h3>帳號</h3><div class="row-actions">${S.user?.photoURL?`<img class="avatar" src="${esc(S.user.photoURL)}" alt="" referrerpolicy="no-referrer">`:""}<span class="sub" style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(S.user?.email||"")}</span><button class="ghost" type="button" data-signout>登出</button></div></section>`}
  <p class="est" style="text-align:center;margin-top:18px">家庭旅遊手帳</p>`,"settings");
  const nf=$("nameF"); if(nf) nf.onsubmit=async e=>{ e.preventDefault(); const n=$("set_name").value.trim().slice(0,20); if(!n){ toast("請輸入名稱"); return; } if(await guard(()=>setDoc(doc(db,"users",S.user.uid),{nick:n},{merge:true}))){ toast(`之後會顯示「${n}」`); render(); } };
  let cfg=autoCfg();
  const saveAuto=async patch=>{ if(!S.trip) return; cfg={...cfg,...patch}; S.trip={...S.trip,autosave:cfg}; await guard(()=>put("trip",null,{...S.trip,autosave:cfg})); };
  const a=$("set_auto"); if(a) a.onchange=()=>saveAuto({on:a.checked}).then(()=>toast(a.checked?"已開啟自動儲存":"已關閉自動儲存"));
  const ev=$("set_every"); if(ev) ev.onchange=()=>saveAuto({every:Number(ev.value)});
  const kp=$("set_keep"); if(kp) kp.onchange=()=>saveAuto({keep:Number(kp.value)});
  renderDrivePanel();
}

/* ---------- events ---------- */
document.addEventListener("click",async e=>{
  const T=s=>e.target.closest(s);
  let el;
  if((el=T("[data-go]"))){ S.tab=el.dataset.go; document.querySelectorAll("[data-go]").forEach(b=>b.setAttribute("aria-selected",b===el)); document.querySelectorAll("section[data-tab]").forEach(s=>s.hidden=s.dataset.tab!==S.tab); render(); window.scrollTo(0,0); return; }
  if((el=T("[data-day]"))){ S.day=Number(el.dataset.day); renderPlan(); return; }
  if((el=T("[data-item]"))){ itemSheet(el.dataset.item); return; }
  if((el=T("[data-media]"))){ mediaSheet(el.dataset.media); return; }
  if(T("[data-close]")){ closeSheet(); return; }
  if(T("[data-newtrip]")){ tripSheet(null,{isNew:true}); return; }
  if((el=T("[data-pick]"))){ subscribeTrip(el.dataset.pick); closeSheet(); return; }
  if(T("[data-openideas]")){ ideasSheet(); return; }
  if(T("[data-suggest]")){ suggestSheet(); return; }
  if((el=T("[data-reason]"))){ const inp=$("d_note"); if(!inp) return; const parts=inp.value.split("、").map(x=>x.trim()).filter(Boolean); const r=el.dataset.reason; const i=parts.indexOf(r); if(i>=0) parts.splice(i,1); else parts.push(r); inp.value=parts.join("、"); el.setAttribute("aria-pressed",i<0); return; }
  if(e.target.closest("[data-editplans]")){ plansSheet(); return; }
  if(e.target.closest("[data-relegs]")){ autoLegs(S.day,true); return; }
  { const th=e.target.closest("[data-plantheme]"); if(th){ const ta=$("pl_t"+th.dataset.plantheme); if(ta){ const v=th.dataset.val; ta.value=ta.value.trim()?ta.value.trim().replace(/[，。、]$/,"")+"，"+v:v; } return; } }
  if(e.target.closest("[data-route]")){ routeSheet(); return; }
  if(e.target.closest("[data-rtall]")){ e.target.closest("[data-rtall]").disabled=true; await addRouteStops(null); return; }
  { const ra=e.target.closest("[data-rtadd]"); if(ra){ ra.disabled=true; await addRouteStops(Number(ra.dataset.rtadd)); return; } }
  { const ne=e.target.closest("[data-newentry]"); if(ne){ entrySheet(null,Number(ne.dataset.newentry)); return; } }
  { const ee=e.target.closest("[data-editentry]"); if(ee){ entrySheet(ee.dataset.editentry); return; } }
  if(e.target.closest("[data-shop]")){ shoppingSheet(); return; }
  { const sl=e.target.closest("[data-slist]"); if(sl){ shopList=sl.dataset.slist; document.querySelectorAll("[data-slist]").forEach(b=>b.setAttribute("aria-pressed",b===sl)); return; } }
  if(e.target.closest("[data-shopai]")){ runShopAi(); return; }
  { const im=e.target.closest("[data-simg]"); if(im){ const x=(S.shopping||[]).find(v=>v.id===im.dataset.simg); if(x&&shopSrc(x)) openLightbox(shopSrc(x),x.name); return; } }
  { const se=e.target.closest("[data-sedit]"); if(se){ shopItemSheet(se.dataset.sedit); return; } }
  { const sm=e.target.closest("[data-smove]"); if(sm){ const x=(S.shopping||[]).find(v=>v.id===sm.dataset.smove); if(!x) return; const {id,...r}=x; const to=x.list==="rec"?"must":"rec"; if(await guard(()=>put("shopping",id,{...r,list:to}))) toast(to==="must"?"已移到一定要買":"已移到推薦購買"); return; } }
  if(e.target.closest("[data-shopback]")){ shoppingSheet(); return; }
  if(e.target.closest("[data-wishes]")){ wishesSheet(); return; }
  { const c=e.target.closest("[data-wcat]"); if(c){ wishCat=c.dataset.wcat; document.querySelectorAll("[data-wcat]").forEach(b=>b.setAttribute("aria-pressed",b===c)); return; } }
  { const pr=e.target.closest("[data-wprio]"); if(pr){ wishPrio=pr.dataset.wprio; document.querySelectorAll("[data-wprio]").forEach(b=>b.setAttribute("aria-pressed",b===pr)); return; } }
  { const tp=e.target.closest("[data-wishprio]"); if(tp){ const w=(S.wishes||[]).find(x=>x.id===tp.dataset.wishprio); if(!w) return; const {id,...r}=w; await guard(()=>put("wishes",id,{...r,prio:prioOf(w)==="must"?"want":"must"})); return; } }
  { const pc=e.target.closest("[data-pace]"); if(pc){ await setPace(pc.dataset.pace); return; } }
  if(e.target.closest("[data-wishauto]")){ runWishPlan(true); return; }
  if(e.target.closest("[data-wishplan]")){ runWishPlan(); return; }
  if(e.target.closest("[data-wpall]")){ e.target.closest("[data-wpall]").disabled=true; await addWishPlans((wp.res||[]).map((r,k)=>k)); return; }
  if(e.target.closest("[data-wpclear]")){ wp.res=null; renderWishes(); return; }
  { const a=e.target.closest("[data-wpadd]"); if(a){ a.disabled=true; await addWishPlans([Number(a.dataset.wpadd)]); return; } }
  { const m=e.target.closest("[data-wishmanual]"); if(m){ const w=(S.wishes||[]).find(x=>x.id===m.dataset.wishmanual); if(w) itemSheet(null,{title:w.name,cat:w.cat||"other",addr:w.addr||"",note:w.note||"",wishId:w.id}); return; } }
  { const r=e.target.closest("[data-wishrm]"); if(r){ await guard(()=>del("wishes",r.dataset.wishrm)); return; } }
  { const g=e.target.closest("[data-wishgo]"); if(g){ const it=S.items.find(x=>x.id===g.dataset.wishgo); if(it){ S.day=it.day; closeSheet(); render(); window.scrollTo(0,0); } return; } }
  { const s=e.target.closest("[data-wishsug]"); if(s){ const r=sug.results[Number(s.dataset.wishsug)]; if(!r) return; if((S.wishes||[]).some(w=>w.name===r.name)){ toast("已經在想去清單裡"); return; } s.disabled=true;
      if(await guard(()=>put("wishes",null,{name:r.name,cat:CATS[r.cat]?r.cat:"other",addr:r.address||"",note:[r.nameLocal&&r.nameLocal!==r.name?r.nameLocal:"",r.tip].filter(Boolean).join("・"),...stampBy()}))){ s.textContent="♥ 已收藏"; toast("已收藏到想去清單"); } return; } }
  { const fa=e.target.closest("[data-foldall]"); if(fa){ foldAll(fa.dataset.foldall==="1"); return; } }
  { const pf=e.target.closest("[data-pref]"); if(pf){ prefs[pf.dataset.pref]=pf.dataset.val; savePrefs(); applyPrefs(); document.querySelectorAll(`[data-pref="${pf.dataset.pref}"]`).forEach(b=>b.setAttribute("aria-pressed",b===pf)); return; } }
  if(e.target.closest("[data-settrip]")){ S.trip?tripSheet():tripSheet(null,{isNew:true}); return; }
  if(e.target.closest("[data-savenow]")){ const ok=await saveNow(false); if(ok&&openSheetKind==="settings") settingsSheet(); return; }
  if(e.target.closest("[data-settrips]")){ tripsSheet(); return; }
  if(e.target.closest("[data-copylink]")){ copyText(familyLink(),"已複製家庭連結，可以貼到 LINE 群組"); return; }
  if(e.target.closest("[data-leavelink]")){ const b=e.target.closest("[data-leavelink]"); if(b.dataset.armed){ closeSheet(); leaveLink(); } else { b.dataset.armed="1"; b.textContent="再按一次確認"; } return; }
  if(e.target.closest("[data-signout]")){ signOut(auth); return; }
  if(T("[data-driveping]")){ drivePing(); return; }
  if((el=T("[data-tlike]"))){ el.setAttribute("aria-pressed",el.getAttribute("aria-pressed")!=="true"); return; }
  if((el=T("[data-skind]"))){ sug.kind=el.dataset.skind; document.querySelectorAll("[data-skind]").forEach(b=>b.setAttribute("aria-pressed",b===el)); return; }
  if((el=T("[data-addsug]"))){ el.disabled=true; await addSuggestion(Number(el.dataset.addsug)); return; }
  if((el=T("[data-resolve]"))){ const c=S.comments.find(x=>x.id===el.dataset.resolve); if(!c) return; const {id,...r}=c; await guard(()=>put("comments",id,{...r,resolved:!c.resolved})); if(!$("sheet").hidden&&c.itemId) itemSheet(c.itemId); return; }
  if((el=T("[data-quick]"))){ await guard(()=>put("packing",null,{text:el.dataset.quick,done:false,...stampBy()})); return; }
  if((el=T("[data-unpack]"))){ await guard(()=>del("packing",el.dataset.unpack)); return; }
  if((el=T("[data-savediary]"))){ const i=el.dataset.savediary; if(await saveJournal(i,{text:$("diary_"+i).value})){ delete drafts["d"+i]; toast("日記已儲存"); } return; }
  if((el=T("[data-editdrive]"))){ const i=Number(el.dataset.editdrive); editingDrive.add(i); renderJournal(); $("drive_"+i)?.focus(); return; }
  if((el=T("[data-canceldrive]"))){ const i=Number(el.dataset.canceldrive); editingDrive.delete(i); delete driveDrafts["drive_"+i]; renderJournal(); return; }
  if((el=T("[data-cleardrive]"))){ const i=Number(el.dataset.cleardrive); if(await saveJournal(i,{driveUrl:""})){ editingDrive.delete(i); delete driveDrafts["drive_"+i]; renderJournal(); toast("已移除連結"); } return; }
  if((el=T("[data-savedrive]"))){ const i=Number(el.dataset.savedrive); const v=$("drive_"+i).value.trim(); let u;
    try{ u=new URL(v); }catch{ toast("這不是有效的網址，請貼上完整連結"); return; }
    if(u.protocol!=="https:"||!/(^|\.)google\.com$/.test(u.hostname)){ toast("請貼上 Google 雲端硬碟的資料夾連結"); return; }
    if(await saveJournal(i,{driveUrl:u.href})){ editingDrive.delete(i); delete driveDrafts["drive_"+i]; renderJournal(); toast("連結已儲存，家人都看得到"); } return; }
  if((el=T("[data-restore]"))){ const s=S.snaps.find(x=>x.id===el.dataset.restore); if(!s) return;
    openSheet(`<h2>還原到這個版本？</h2><p>${stamp(s.at)} 由 ${esc(nameOf(s.by))} 儲存的「${esc(s.trip?.title||"")}」，共 ${(s.items||[]).length} 個行程。</p><p class="sub">目前的行程、旅行設定和行李清單會被這個版本取代。日記、照片和留言不受影響。建議先按「儲存目前的專案」留一份。</p><div class="sheet-actions"><button class="primary" type="button" id="doRestore">確定還原</button><button class="ghost" type="button" data-close>取消</button></div>`);
    $("doRestore").onclick=()=>restoreSnapshot(s.id); return; }
  if((el=T("[data-likeidea]"))){ const d=S.ideas.find(x=>x.id===el.dataset.likeidea); if(!d) return; const me=S.user.uid; const likes=(d.likes||[]).includes(me)?d.likes.filter(x=>x!==me):[...(d.likes||[]),me]; const {id,...r}=d; await guard(()=>put("ideas",id,{...r,likes})); return; }
  if((el=T("[data-useidea]"))){ const d=S.ideas.find(x=>x.id===el.dataset.useidea); if(d) useIdea(d); return; }
  if((el=T("[data-fareidea]"))){ faresSheet(el.dataset.fareidea); return; }
  if((el=T("[data-rmidea]"))){ await guard(()=>del("ideas",el.dataset.rmidea)); return; }
  if((el=T("[data-usefare]"))){ await useFare(el.dataset.usefare); return; }
  if((el=T("[data-rmfare]"))){ await guard(()=>del("fares",el.dataset.rmfare)); return; }
});
document.addEventListener("change",async e=>{
  const dopt=e.target.closest("[data-driveopt]"); if(dopt&&S.trip){ const k=dopt.dataset.driveopt; await guard(()=>put("trip",null,{...S.trip,drive:{...(S.trip.drive||{}),[k]:dopt.checked}})); return; }
  const sb=e.target.closest("[data-sbought]"); if(sb){ const x=(S.shopping||[]).find(v=>v.id===sb.dataset.sbought); if(!x) return; const {id,...r}=x; await guard(()=>put("shopping",id,{...r,bought:sb.checked})); return; }
  const pk=e.target.closest("[data-pack]"); if(pk){ const p=S.packing.find(x=>x.id===pk.dataset.pack); if(!p) return; const {id,...r}=p; await guard(()=>put("packing",id,{...r,done:pk.checked})); return; }
  const up=e.target.closest("[data-upload]"); if(up&&up.files?.length){ const files=[...up.files]; up.value=""; uploadFiles(Number(up.dataset.upload),files); }
});
document.addEventListener("input",e=>{ const ta=e.target.closest("textarea[data-diary]"); if(ta) drafts[ta.dataset.diary]=ta.value; });
$("packForm").onsubmit=async e=>{ e.preventDefault(); const v=$("packInput").value.trim(); if(!v) return; if(await guard(()=>put("packing",null,{text:v,done:false,...stampBy()}))) $("packInput").value=""; };
$("sendCmt").onclick=async()=>{ const v=$("newCmt").value.trim(); if(!v) return; if(await guard(()=>put("comments",null,{text:v,itemId:null,resolved:false,...stampBy()}))){ $("newCmt").value=""; toast("留言已送出"); } };
$("fab").onclick=()=>itemSheet(null);
$("btnSettings").onclick=settingsSheet;
$("btnSave").onclick=()=>saveNow(false);
$("btnTrips").onclick=tripsSheet;
$("btnIdeas").onclick=ideasSheet;
$("btnFares").onclick=()=>faresSheet();
$("btnSnap").onclick=()=>saveNow(false);
$("btnPdf").onclick=makePdf;
$("btnSignIn").onclick=signIn;
$("btnSignOut").onclick=()=>LINK_MODE?leaveLink():signOut(auth);

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
bootAuth();

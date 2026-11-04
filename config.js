// 家庭旅遊手帳 — 設定檔
// 這個檔案會公開在 GitHub 上。這裡的值都不是密碼，可以放心公開。
// ⚠️ 絕對不要把 Gemini 或 Claude 的 API 金鑰寫在這裡或任何網頁檔案裡，金鑰只放在 Cloudflare Worker 的 Secret。

export const FIREBASE_CONFIG = {
  // 從 Firebase 主控台 →「專案設定」→「你的應用程式」→ 網頁應用程式的 firebaseConfig 複製過來
  apiKey: "請填入",
  authDomain: "你的專案ID.firebaseapp.com",
  projectId: "你的專案ID",
  storageBucket: "你的專案ID.firebasestorage.app",
  messagingSenderId: "請填入",
  appId: "請填入",
};

// 怎麼進入 App：
//   "link"   用家庭連結開啟，不用登入（連結長這樣：https://你的帳號.github.io/family-trip/#k=家庭代碼）
//   "google" 用 Google 帳號登入，只有家人名單裡的 Email 可以用
// 家庭代碼不要寫在這裡，只放在 Firebase 規則、Worker 的 FAMILY_KEY 和你傳給家人的連結裡。
export const ACCESS_MODE = "link";

// Cloudflare Worker 部署後的網址（結尾不要加斜線），例如 https://trip-ai.你的帳號.workers.dev
export const AI_PROXY_URL = "";

// 預設出發機場：TPE 桃園、RMQ 台中、KHH 高雄、TSA 松山
export const DEFAULT_ORIGIN = "TPE";

# 家庭旅遊手帳

全家一起用 iPhone 規劃旅行的網頁 App。可以排每日行程、控制預算、比價機票、準備行李、寫旅行日記、上傳原檔照片和影片，最後輸出 PDF。家人修改時，每個人的畫面會即時更新。

推薦功能由 AI 提供（預設使用 Google Gemini 的免費額度，也可以改用 Claude）：
- 輸入旅行地後，推薦**最近**和**最划算**的機場
- 依每天已排好的行程，推薦附近的**餐廳和景點**
- 先把想去的餐廳和地點收進**想去清單**，再依地點和營業時間建議**排在第幾天、幾點**
  - 分成「一定要去」和「想去」，按**一鍵排進行程**：一定要去的全部排入，想去的只在時間排得下時插入
  - 可選**悠閒**（10:00–19:00、每天 3～4 個點）或**緊湊**（08:30–21:00、每天 6～7 個點）
- **購物清單**：分「一定要買」和「推薦購買」，AI 可依旅行地和季節推薦當地必買，每一項都能加備註、買到就打勾
- 依每天的**大致規劃**（例如「下飛機先到旅館放行李、附近逛逛」「主題樂園玩一整天」）排出**時間表和交通路線**

---

## 架構

```
iPhone（加入主畫面）
   │
   ├── GitHub Pages ──── 網頁本身（這個專案的檔案，不含任何密碼）
   │
   ├── Firebase ──────── 家庭連結或 Google 登入、行程資料即時同步、照片影片原檔
   │
   └── Cloudflare Worker ── 保管 AI 的 API 金鑰，替網頁呼叫 Gemini（或 Claude）
                            （驗證登入、只允許家人、只做固定的推薦任務）
```

**為什麼要多一個 Worker？** GitHub Pages 上的檔案所有人都看得到。如果把 API 金鑰寫在網頁裡，任何人都能拿去用，額度或費用會算在你的帳號上。所以金鑰只能放在 Worker 的加密設定（Secret）裡。

**家人要各自申請 AI 帳號嗎？** 不用。Worker 用你的 API 金鑰代為呼叫，家人只要打開家庭連結（或用 Google 帳號登入）就能用。

**家人需要登入嗎？** 預設不用。`config.js` 的 `ACCESS_MODE` 設成 `"link"` 時，家人打開你傳的**家庭連結**（`https://你的帳號.github.io/family-trip/#k=家庭代碼`）就能直接用，第一次只會問「你是誰？」好顯示名稱。改成 `"google"` 則要用 Google 帳號登入，只有家人名單裡的 Email 能用。（Claude.ai 的訂閱帳號不能這樣共用，所以這裡用的是 API 金鑰。）

---

## 需要準備的帳號

| 服務 | 用途 | 費用 |
|---|---|---|
| GitHub | 放網頁 | 免費 |
| Firebase（Google） | 登入、資料、照片影片 | 有免費額度；照片儲存需要升級成「Blaze 依用量付費」方案 |
| Cloudflare | Worker 中繼伺服器 | 免費方案就夠用 |
| Google AI Studio | Gemini API 金鑰（預設） | 有免費額度 |
| Claude Console（選用） | 想改用 Claude 時才需要 | 依使用量計費 |

---

## 設定步驟

### 步驟 1：建立 Firebase 專案

1. 到 [Firebase 主控台](https://console.firebase.google.com/) 建立新專案，名稱自訂，例如 `family-trip`。
2. 在專案首頁按「</>」新增**網頁應用程式**，複製畫面上的 `firebaseConfig`，貼進本專案的 `config.js` 裡的 `FIREBASE_CONFIG`。
3. **Authentication**：
   - 「開始使用」→「登入方式」→ 啟用 **匿名**（家庭連結模式用，家人不會看到任何登入畫面）。
   - 想用 Google 帳號登入的話，也啟用 **Google**。
   - 「設定」→「已授權的網域」→ 新增 `你的GitHub帳號.github.io`。
4. **Firestore Database**：
   - 「建立資料庫」→ 位置選 `asia-east1（台灣）` → 以正式版模式啟動。
   - 「規則」分頁 → 貼上 `firebase/firestore.rules` 的內容。
   - **家庭連結模式**：把 `familyKey()` 裡的「請換成你的家庭代碼」換成你的家庭代碼（見下方「家庭代碼怎麼來」）。
   - **Google 登入模式**：把 `isFamily()` 裡的 Email 換成家人的 Google 帳號（全部小寫）。
   - 按「發布」。

   **家庭代碼怎麼來**：打開 App（還沒有代碼時會看到「貼上家庭連結」畫面）→ 點「我是建立者，要產生家庭代碼」，會產生一組 24 個字元的亂碼。也可以自己編一組，只要 16 個字元以上、只用英文字母和數字。
5. **Storage（照片和影片）**：
   - 新專案要先升級成 **Blaze 方案** 才能使用 Storage。升級後仍有免費額度。
   - 位置選美國區域（例如 `US-CENTRAL1`），才能使用 Google Cloud 的「Always Free」免費額度。
   - 「規則」分頁 → 貼上 `firebase/storage.rules`，家庭代碼和 Email 名單要和上一步一樣 → 按「發布」。
   - 建議到 Google Cloud 的「帳單 → 預算與快訊」設一個每月預算提醒，例如 NT$100。

### 步驟 2：申請 Gemini API 金鑰（免費）

1. 用你的 Google 帳號登入 [Google AI Studio](https://aistudio.google.com/)，按「Get API key」→「Create API key」，先暫時記下來。
2. 免費額度有每分鐘、每天的次數限制。一般家庭使用夠用，實際限制可以在 AI Studio 的 Rate limit 頁面查看。
3. **注意隱私**：Google 會用免費方案送出的內容來改善它的產品。推薦時只會送出旅行地、日期、人數、喜好和當天行程名稱，不會送出照片、日記或留言。不希望這樣的話，可以在 AI Studio 開啟付費方案。
4. **不要**把金鑰貼進這個專案的任何檔案，也不要傳給別人。

> 想改用 Claude：到 [Claude Console](https://platform.claude.com/) 建立 API 金鑰並設定花費上限，然後在步驟 3 把 `AI_PROVIDER` 改成 `claude`，並改設定 `ANTHROPIC_API_KEY`。

### 步驟 3：部署 Cloudflare Worker

需要先在電腦安裝 [Node.js](https://nodejs.org/)（LTS 版本）。

```bash
cd worker
npx wrangler login                        # 開瀏覽器登入 Cloudflare
```

編輯 `worker/wrangler.toml`：
- `FIREBASE_PROJECT_ID`：Firebase 專案 ID（在 config.js 裡的 `projectId`）
- `FAMILY_EMAILS`：家人的 Google 帳號，用逗號分隔
- `ALLOWED_ORIGINS`：`https://你的GitHub帳號.github.io`
- `AI_PROVIDER`：維持 `gemini`
- `GEMINI_MODEL`：預設 `gemini-3.8-flash`。如果 Google 之後更換模型名稱，到 [Gemini 價格頁](https://ai.google.dev/gemini-api/docs/pricing) 找標示「Free of charge」的 Flash 模型改填。

接著執行：

```bash
npx wrangler secret put GEMINI_API_KEY   # 貼上步驟 2 的金鑰（只存在 Cloudflare，不會進 GitHub）
npx wrangler deploy
```

部署完成後會顯示網址，例如 `https://trip-ai.你的帳號.workers.dev`。
- 用瀏覽器打開 `網址/health`，看到 `{"ok":true}` 就代表成功。
- 把這個網址填進 `config.js` 的 `AI_PROXY_URL`。

（選填）每人每日推薦次數上限：

```bash
npx wrangler kv namespace create USAGE
```

把顯示的 id 填進 `wrangler.toml` 的 `[[kv_namespaces]]` 區塊並取消註解，再執行一次 `npx wrangler deploy`。預設每人每天 40 次，可以用 `DAILY_LIMIT` 修改。

### 步驟 4：放上 GitHub Pages

1. 在 GitHub 建立新的 repository，例如 `family-trip`。
2. 把這個資料夾的所有檔案上傳（包含已填好的 `config.js`）。
3. 到 repository 的「Settings → Pages」，Source 選「Deploy from a branch」，Branch 選 `main`、資料夾選 `/ (root)` → Save。
4. 約 1 分鐘後，網址會是 `https://你的GitHub帳號.github.io/family-trip/`。

### 步驟 5：給家人使用

**家庭連結模式（預設，不用登入）**

1. 確認家庭代碼已經填進三個地方：`firestore.rules`、`storage.rules`，以及 Worker 的 Secret（在 `worker` 資料夾執行 `npx wrangler secret put FAMILY_KEY`）。
2. 把家庭連結 `https://你的GitHub帳號.github.io/family-trip/#k=家庭代碼` 傳到 LINE 群組。之後也可以在 App 的 ⚙ 設定 →「家庭連結」按「複製家庭連結」。
3. 家人點開後選「用 Safari 開啟」→ 按「分享」→「加入主畫面」。
4. 從主畫面開啟，第一次會問「你是誰？」，選一個名稱就能用了。如果主畫面 App 打開時要求貼上連結，把 LINE 裡的家庭連結整段貼上即可（只要一次）。

注意：**拿到家庭連結的人都能看和修改這趟旅行**，也能使用 AI 推薦，所以只傳給家人。連結外流時：換一組新的家庭代碼（改兩個規則檔和 Worker 的 `FAMILY_KEY`），再把新連結傳給家人，舊連結會立刻失效，資料不會不見。

**Google 登入模式**

1. 把 `config.js` 的 `ACCESS_MODE` 改成 `"google"`。
2. 確認家人的 Email 已經加進三個地方：`firestore.rules`、`storage.rules` 和 Worker 的 `FAMILY_EMAILS`。
3. 把網址傳給家人，加入主畫面後用自己的 Google 帳號登入。

---

### 步驟 6（選填）：自動存到 Google 雲端硬碟

設定好之後，檔案會自動存到你指定的雲端硬碟資料夾，並依旅行名稱建立子資料夾：

```
你的資料夾
└── 東京迪士尼生日之旅
    ├── 東京迪士尼生日之旅_行程表.pdf      ← 每次存檔都換成最新的一份
    ├── 專案存檔
    │   └── 東京迪士尼生日之旅_2026-11-04_1445.json   ← 每次存檔留一份備份
    ├── 東京迪士尼生日之旅Day1             ← 上傳到 Day1 的照片和影片
    └── 東京迪士尼生日之旅Day2
```

這是用你自己 Google 帳號裡的一小段 Apps Script 來存檔，所以**家人不用另外授權**，不管誰按存檔，檔案都會存進你的資料夾。

1. 打開 [script.google.com](https://script.google.com/)，用**擁有這個資料夾的 Google 帳號**登入，按「新專案」。
2. 刪掉原本的內容，貼上本專案 `google-drive/Code.gs` 的全部內容。
3. 修改最上面兩行：
   - `ROOT_FOLDER_ID`：已經填好你的資料夾（`1J0Gcjle9APGk-xTHq-JVdPbE-SLiBQa5`）。換資料夾時，填資料夾網址 `folders/` 後面那一串。
   - `SECRET`：改成一串很長、只有你知道的亂碼，例如 30 個以上的英數字。
4. 按「部署」→「新增部署作業」→ 類型選「網頁應用程式」：
   - 執行身分：**我**
   - 誰可以存取：**所有人**（只有知道網址和 SECRET 的中繼伺服器能存檔）
   - 按「部署」，第一次會要求授權存取你的雲端硬碟，按「允許」。（會看到「Google 尚未驗證這個應用程式」，因為這是你自己寫的程式，按「進階」→「前往」即可。）
5. 複製部署後的網址（`https://script.google.com/macros/s/…/exec`），填進 `worker/wrangler.toml` 的 `DRIVE_SCRIPT_URL`。
6. 在 `worker` 資料夾執行：
   ```bash
   npx wrangler secret put DRIVE_SECRET   # 貼上和步驟 3 一樣的 SECRET
   npx wrangler deploy
   ```
7. 打開 App →「輸出」→「自動存到 Google 雲端硬碟」→ 按「測試連線」，看到「已連線」就完成了。

在這裡可以分別開關三個項目：存專案時備份、產生 PDF 時也存一份、上傳照片時同步到每天的資料夾。設定是整趟旅行共用的。

注意：
- **照片同步上限是 30 MB**，超過的檔案只會存在 App 的雲端相簿，可以用「手動存檔的方法」自己放進雲端硬碟。
- **旅行改名後**，之後的檔案會存到新名稱的資料夾，舊資料夾不會自動改名。
- **你的資料夾是用「知道連結的人都能查看」分享的**，拿到連結的人都看得到裡面的照片和行程。只想給家人看的話，到雲端硬碟把一般存取權改成「限制」，再分別加入家人的帳號。
- 之後修改 `Code.gs` 的話，要按「部署」→「管理部署作業」→ 編輯 → 版本選「新版本」，網址不會變。

## 更新 App

修改檔案並上傳到 GitHub 後，把 `sw.js` 第一行的 `VERSION` 加 1（例如 `v1` 改成 `v2`）。家人下次開啟就會拿到新版。

---

## 已知限制

- **主畫面 App 的登入**（只有 Google 登入模式）：iPhone 上 GitHub Pages 和 Firebase 是不同網域，App 會用彈出視窗登入，失敗時會改用整頁跳轉。這部分還沒有在 iPhone 實機測試。如果加到主畫面後一直登入失敗，最穩定的做法是改用 Firebase Hosting 放網頁：authDomain 和網頁同一個網域，登入問題就不會發生。
- **推薦內容不是即時資料**：機場的票價是一般行情，餐廳景點來自 AI 的知識。實際價格請到「機票比價」的連結查詢，營業時間請點「地圖」確認。
- **PDF** 會轉成圖片，所以 PDF 裡的文字不能選取或搜尋。

---

## 檔案說明

| 檔案 | 說明 |
|---|---|
| `index.html` | 頁面結構 |
| `styles.css` | 外觀（支援深色模式） |
| `app.js` | 主要程式：行程、預算、留言、日誌、機票比價、推薦、PDF |
| `config.js` | Firebase 設定和 Worker 網址（不含密碼） |
| `manifest.webmanifest`、`sw.js`、`icons/` | 讓 App 可以加到主畫面 |
| `firebase/firestore.rules`、`firebase/storage.rules` | 資料和照片的存取權限 |
| `worker/` | Cloudflare Worker 中繼伺服器（Gemini／Claude 都支援，也負責轉存到雲端硬碟） |
| `google-drive/Code.gs` | 貼到 Google Apps Script 的程式，負責把檔案存進你的雲端硬碟資料夾 |

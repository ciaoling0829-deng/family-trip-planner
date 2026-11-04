/**
 * 家庭旅遊手帳 — 自動存到 Google 雲端硬碟
 *
 * 這段程式放在你自己的 Google 帳號（script.google.com），用你的身分把檔案存進你的資料夾。
 * 家人不需要另外授權，存檔時一律存到下面這個資料夾裡：
 *   你的資料夾 / 旅行名稱 / 檔案
 *   你的資料夾 / 旅行名稱 / 旅行名稱Day1 / 照片
 *   你的資料夾 / 旅行名稱 / 專案存檔 / 備份檔
 *
 * 設定方式請看 README 的「自動存到 Google 雲端硬碟」。
 */

// 你的資料夾 ID：資料夾網址 https://drive.google.com/drive/folders/ 後面那一串
const ROOT_FOLDER_ID = "1J0Gcjle9APGk-xTHq-JVdPbE-SLiBQa5";

// 請改成一串很長、只有你知道的亂碼，並且和 Cloudflare Worker 的 DRIVE_SECRET 設成一樣
const SECRET = "請改成一串很長的亂碼";

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET.indexOf("請改成") === 0 || req.secret !== SECRET) return out({ ok: false, error: "bad_secret" });

    const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);                       // 避免兩個人同時存檔時建出兩個同名資料夾
    let trip, folder;
    try {
      trip = child(root, clean(req.trip || "未命名旅行"));
      folder = req.sub ? child(trip, clean(req.sub)) : trip;
    } finally { lock.releaseLock(); }

    if (req.action === "ping") return out({ ok: true, folderUrl: trip.getUrl() });

    const name = clean(req.filename || "檔案");
    const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mimeType || "application/octet-stream", name);
    if (req.replace) {                          // 行程表 PDF 只保留最新一份
      const old = folder.getFilesByName(name);
      while (old.hasNext()) old.next().setTrashed(true);
    }
    const file = folder.createFile(blob);
    if (req.by) file.setDescription("由 " + req.by + " 從家庭旅遊手帳存入");
    return out({ ok: true, url: file.getUrl(), folderUrl: folder.getUrl() });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

// 用瀏覽器打開網址時顯示的訊息（確認部署成功用）
function doGet() { return out({ ok: true, message: "家庭旅遊手帳的雲端硬碟服務已啟用" }); }

function child(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function clean(s) { return String(s).replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "未命名"; }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

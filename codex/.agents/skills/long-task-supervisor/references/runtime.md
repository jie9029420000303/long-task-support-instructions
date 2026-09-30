# Codex 監督啟動與事件協定

## 一次性啟動

使用者只說「研究定案，啟動監督」即可。監督在本對話建一份 task-owned `input.json`，勿要求使用者填 schema：

```json
{
  "projectRoot": "/absolute/project",
  "allowedRoots": ["/absolute/project", "/absolute/executor-workspace"],
  "supervisorId": "this real Codex thread id",
  "executorId": "the real created or selected Codex thread id",
  "executorCursor": "只在綁定既有執行對話時，啟動前 wait_threads(timeoutMs:0) 讀得的當前游標；新建對話省略",
  "executorBaselineTurnId": "同一次快照的 latestTurn.id；用來排除已有回合，新建對話省略",
  "contract": {
    "goal": "已定案的使用者目標原文",
    "authorization": "本次監督、代答及執行授權原文",
    "criteria": [
      {"id": "A1", "requirement": "驗收條文原文", "source": "訊息 ID 或檔案與位置", "verify": "可重現的查核方法"}
    ],
    "sources": [{"path": "/absolute/source-snapshot", "sha256": "the real SHA-256"}]
  }
}
```

先保存來源快照，再實際計算 SHA-256。來源是已定案文件與對話摘錄，不能用會持續變動的進度 log 充當鎖定條文。允許根目錄只列本次已授權的專案／工作區。Run 目錄建議 `<projectRoot>/.codex/long-task-supervisor/<executorId>`，不要在真實專案寫合成測試資料。

```text
node <installed-skill>/scripts/supervise.cjs init RUN INPUT.json
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node <installed-skill>/scripts/run-watch.cjs RUN
node <installed-skill>/scripts/supervise.cjs status RUN
node <installed-skill>/scripts/supervise.cjs decision RUN DECISION.json
node <installed-skill>/scripts/supervise.cjs stop RUN
```

`run-watch.cjs` 在 App 持有的本機工具 session 執行，使用可回傳 session ID 的背景命令方式；不要用父程序立即退出的 detached 啟動。等待期間是本機程式而非模型。啟動後 status 必須同時是 active、readVerified，且指定 executorId 正確，才回報已啟動。若平台權限需要核准，走該工具的原生核准機制；沒有權限時如實回報，不能繞過本機 socket 限制。

綁定既有執行對話時，先以 `wait_threads({targets:[{threadId:executorId}],timeoutMs:0})` 同時取當前 `cursor` 與 `latestTurn.id`，分別寫入 `executorCursor`、`executorBaselineTurnId`，從下一個新回合才開始監看；通知 API 即使游標未變仍會附上舊的 latestTurn，因此必須以 ID 排除它。新建執行對話須監看其第一個完成回合，不填這兩欄。

## 執行對話的事件

執行技能把一行結構化標記放在**最終回覆**，每次只交最小狀態：

```text
LONG_TASK_EVENT {"kind":"progress","nextAction":"接下來要執行的具體工作"}
LONG_TASK_EVENT {"kind":"question"}
LONG_TASK_EVENT {"kind":"blocked"}
LONG_TASK_EVENT {"kind":"submission","revision":"sha256:<候選清單檔的 SHA-256>","manifest":"<候選清單檔絕對路徑>"}
```

`progress` 只讓背景程式依 `nextAction` 發一則簡短續接訊息，不喚醒監督模型；相同下一步連續三次則轉成停滯事件交監督。普通進度應在回合中通報；回合結束仍有工作才使用 `progress`。執行回合結束卻沒有標記、標記格式有誤時會作為異常事件送來，避免無聲停止。新事件只傳摘要及契約／證據路徑，不重貼全部歷史。

送驗前用 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...` 產生候選清單及**可直接貼在最終回覆末尾的完整事件行**；不要手寫或截短雜湊。清單至少列一個檔案，包含本次候選版所有直接修改的交付檔。監督接收時會重算清單及每個候選檔，變動後必須另建清單並重交，不得拼接舊證據。

## 判定與收件

監督收到事件後直接在 `RUN/decision-<eventId>.json` 寫決策。`disposition` 為 `accept`、`reject`、`reply`、`observe` 或 `needs_user`；`eventId` 必須精確相同。退件與代答有 `reply`；接受另有 `revision` 及逐條 `results`。每條結果含 `id`、`status:"PASS"`、`method`、`expected`、`actual` 與至少一個 `evidence:[{"path":"絕對路徑","sha256":"真實檔案雜湊"}]`。可用獨立測試輸出、瀏覽器／視覺證據或原始資料查核檔；只寫 PASS 不構成證據。執行上方 `decision` 命令檢查成功，才可宣稱全數通過。

監看可能在決策檔寫入後、`decision` 命令執行前就已處理它；此時命令仍須對保存的同一事件與決策雜湊回傳 `valid:true, processed:true`。若檔案事後改動則拒絕，不能把競速造成的「無待決事件」誤當驗收失敗。

背景程式只把 `reject` 或 `reply` 傳給精確執行對話，並讀回完整訊息保存 receipt。執行者問到待核准動作而仍有其他工作可做時，監督用 `reply` 指明可逆方案、暫停的具體動作與繼續項目；**不可用 `needs_user` 凍結整條主線**。純確認、已知阻塞且無需再發訊時用 `observe`，即使當下只剩待核准事項也繼續接新事件。`needs_user` 保留當前 pending 並暫停消費新事件，只在已有使用者指示確實需要整體暫停時使用；不是一般待核准事項的預設。送達不明只讀回對帳，不重送。接受後關閉該 run 的監看；執行對話即使先自稱完成也不得讓監督狀態提前完成。

`observe`（記錄後繼續監看）必須有非空 `reason`；可附 `pendingApprovals` 非空字串陣列，逐項保存仍待核准的具體動作。不得含 `reply`、`delivery`、`revision`、`results`。背景程式保存完整決策及雜湊、清除該 pending，再繼續等新事件；不向執行者發訊、不接受候選、不把待核准改成授權。範例：

```json
{"eventId":"原事件識別值","disposition":"observe","reason":"執行者只確認收到；已知核准事項未變，不需再回覆。","pendingApprovals":["正式發布仍待使用者明確授權"]}
```

使用者之後提供核准時，先核對原話與操作範圍，再以新的唯一 `LONG_TASK_DELIVERY` 標記、原生 App 傳訊及讀回交給執行者，保存送達與決策帳；不要改已處理的 observe 決策。這是使用者新答覆的交接，日常事件仍由 resident watcher 傳訊。`STOP` 仍優先，不自行清除或重啟。

## 派工檢查事件

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼的最終回覆事件。監督核對快照和真實來源後，照原流程寫具體 reply 決策；不要自行傳訊。resident watcher 在真正送出前重查，目前已解決的事件會記為 obsolete，不送舊指示；同一事件中仍有未處理問題則重新形成事件。外部 `dispatch-preflight` 僅供唯讀查核，不改 daemon state。新 run 預設啟用；既有 run 使用 `attach-dispatch`，不改驗收契約，也不因掛載而清 STOP 或重新啟動。

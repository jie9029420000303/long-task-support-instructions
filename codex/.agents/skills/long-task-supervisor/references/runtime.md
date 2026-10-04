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

## 15 分鐘主動進度查核

無模型 watcher 在監督與執行兩邊都靜默 15 分鐘後查核，工具輸出或游標變動不算新訊息。先核對最新對話、派工快照、在途工作與未達條目。仍有可行工作或證據不足時用 `reply`，填 `progressCheck.evidence`、`finding`、`guidance`，guidance 原文須在 reply；不要重問已有授權或已提出的核准題。

只剩已核對、未變的等待時用 `observe`，填非空 reason、`progressCheck.evidence`、`finding` 與下節 wait。背景保持接收新事件，不能因省 Token 停止 watcher。新執行訊息、新的使用者答覆、條件檔變動或既定期限到達會解除靜默等待並再查核；監督自己結束回合不解除等待。一般 observe 不會永久取消進度查核。

### checked wait（已核對的等待）

`wait:{kind:"user_approval",conditions:[]}` 用於已提出且沒有其他可行工作的使用者核准。外部結果用 `kind:"external_result"`，至少有可觀察條件檔 `conditions:[{path:"絕對路徑",sha256:"當下實際雜湊"}]` 或已有依據的 `resumeAt`。等待尚未出現的檔案時 sha256 填 null。只能列本 run 允許根目錄內的檔案；用具體結果或授權檔，勿列每次輪詢都改的 daemon-state。resumeAt 只承接原訂工作／業務期限，不自行設定新門檻。等待仍不是 PASS 或授權，STOP 優先。

### 延遲收件恢復

App 持有的 `run-watch.cjs` 遇 needs_reconcile 且有 saved inflight 時，以既有退避重啟只讀對帳；該 delivery 不再送第二次。沒有 inflight、STOP、stopped、accepted 不自動復活。外部操作只有排隊時仍不可聲稱模型已讀。恢復不代表整個 App 父程序可自行復活。

## 原契約、使用者修訂與舊 run 接入

先讀 [授權承接](authorization.md)，核對真實使用者原文。`supervise.cjs effective-contract RUN` 輸出原契約加已核准修訂的有效範圍、排除項、授權更新及 contractStateSha256。監督、執行、派工查核和最後接受都讀同一有效範圍。

在原監督的安全停點（無 pending、無 inflight、舊 watcher 與 dispatch writer 已退出，STOP/accepted/stopped 不改）用 `supervise.cjs amend RUN INPUT.json` 登記修訂。INPUT 含 id、原 contractSha256、authority:{role:"user",quote:"逐字原話",locator:"原對話訊息／文件位置",at:"來源時間",source:{path:"允許根目錄內的原文快照",sha256:"實算雜湊"}}、changes:[{id:"原條文ID",action:"exclude/replace/restore"}]。replace 另填完整 requirement、verify；授權更新用 action:"authorization"、固定 id、scope、instruction。代理提案不能冒填 role:user，來源檔須含原話，語意與操作範圍由監督實際查原對話核實。工具只檢查來源完整性，不能證明任意檔案作者真是使用者。

修訂另存不可改寫的 contract-amendments.jsonl，保留原 contract.json；遺失、變動、衝突皆先對帳，不清檔重置。接受決策必須帶當前 contractStateSha256，結果只對有效條文逐條 PASS；排除項明列 EXCLUDED 及核准來源，不能偽填 PASS。

舊 run 的結果帳用 `supervise.cjs attach-acceptance RUN ACCEPTANCE.json` 接入。原執行者準備目前實際候選與逐條狀態，涵蓋有效條文及 EXCLUDED 項；未測 PENDING，已跑但不足判定 INCONCLUSIVE，缺口 FAIL／BLOCKED，不能憑執行次數補成 PASS。工具保存結果歷史、保留既有派工快照與條文，最後才標記 acceptance 已接入。若已有歷史不得清空或覆蓋舊實測。

接入後原監督與執行者都讀回有效契約、摘要與新規則，再以原游標、pending、receipt 續接唯一 watcher；安裝檔案一致不代表現役已切換。不得由另一對話直接改 live run，也不自動清除 STOP。

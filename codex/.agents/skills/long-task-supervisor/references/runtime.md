# Codex 監督啟動與事件協定

## 一次性啟動

使用者明確說「研究定案，啟動監督並建立執行對話」，或明確指定要綁定的既有執行對話即可。`create_thread` 與往另一對話傳訊都要有使用者直接授權；把原話、來源位置、目標專案／對話與用途寫入契約，不能把一般查狀態或「監看」擴成建立新 task。監督在本對話建一份 task-owned `input.json`，勿要求使用者填 schema：

```json
{
  "projectRoot": "/absolute/project",
  "allowedRoots": ["/absolute/project", "/absolute/executor-workspace"],
  "supervisorId": "this real Codex thread id",
  "executorId": "the real created or selected Codex thread id",
  "executorCursor": "只在綁定既有執行對話時，啟動前 wait_threads(timeoutMs:0) 讀得的當前游標；新建對話省略",
  "executorBaselineTurnId": "同一次快照的 latestTurn.id；用來排除已有回合，新建對話省略",
  "loginSites": [
    {"name": "Jira", "url": "https://example.atlassian.net/jira", "loggedOutPattern": "login|登入"},
    {"name": "uat2 GDB-AI MCP", "check": "唯讀檢查指令，見 login_expired", "login": "失效時怎麼恢復"}
  ],
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

同一任務從舊 run 續接時不填 `contract`，改填 `"inheritFrom": "<舊 run 絕對路徑>"`（見下方「原契約、使用者修訂與舊 run 接入」的「換 run 續接同一任務」）；兩個都給或都沒給，init 拒絕。

`loginSites` 必填：SKILL 啟動第 1 步在準備目錄預檢過的同一份清單（格式見下方 `login_expired`），init 檢查格式後寫成 `RUN/login-sites.json`；本任務不用任何登入時填 `[]`。續接舊 run 也要重新預檢並填這一欄，登入清單不隨 `inheritFrom` 帶過來。

建立或綁定前先依[模型路由](model-routing.md)選定並傳入執行模型；Claude 監督不依賴 App 全域預設。模型路線另記在啟動 prompt 與 sidecar，不將執行設定改寫進已鎖定的驗收條文。

先保存來源快照，再實際計算 SHA-256。來源是已定案文件與對話摘錄，不能用會持續變動的進度 log 充當鎖定條文。允許根目錄只列本次已授權的專案／工作區。Run 目錄建議 `<projectRoot>/.codex/long-task-supervisor/<executorId>`，不要在真實專案寫合成測試資料。

```text
node <installed-skill>/scripts/login-check.cjs PREP_DIR_OR_RUN
node <installed-skill>/scripts/supervise.cjs init RUN INPUT.json
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node <installed-skill>/scripts/run-watch.cjs RUN
node <installed-skill>/scripts/supervise.cjs status RUN
node <installed-skill>/scripts/supervise.cjs decision RUN DECISION.json
node <installed-skill>/scripts/supervise.cjs pending RUN CHANGE.json
node <installed-skill>/scripts/supervise.cjs ask RUN
node <installed-skill>/scripts/supervise.cjs shown RUN KEY...
node <installed-skill>/scripts/supervise.cjs stop RUN "<使用者原話>"
```

`run-watch.cjs` 在 App 持有的本機工具 session 執行，使用可回傳 session ID 的背景命令方式；不要用父程序立即退出的 detached 啟動。等待期間是本機程式而非模型。啟動後 status 必須同時是 active、readVerified，且指定 executorId 正確，才回報已啟動。若平台權限需要核准，走該工具的原生核准機制；沒有權限時如實回報，不能繞過本機 socket 限制。

綁定既有執行對話時，先以 `wait_threads({targets:[{threadId:executorId}],timeoutMs:0})` 同時取當前 `cursor` 與 `latestTurn.id`，分別寫入 `executorCursor`、`executorBaselineTurnId`，從下一個新回合才開始監看；通知 API 即使游標未變仍會附上舊的 latestTurn，因此必須以 ID 排除它。新建執行對話須監看其第一個完成回合，不填這兩欄。

## 執行對話的事件

執行技能把一行結構化標記放在**最終回覆**，每次只交最小狀態：

```text
LONG_TASK_EVENT {"kind":"progress","nextAction":"接下來要執行的具體工作"}
LONG_TASK_EVENT {"kind":"waiting","nextAction":"背景工作完成後要做的事","waitMinutes":15}
LONG_TASK_EVENT {"kind":"progress","nextAction":"背景工作完成後要做的事","waitMinutes":15}
LONG_TASK_EVENT {"kind":"question"}
LONG_TASK_EVENT {"kind":"blocked"}
LONG_TASK_EVENT {"kind":"submission","revision":"sha256:<候選清單檔的 SHA-256>","manifest":"<候選清單檔絕對路徑>"}
```

普通 `progress` 只讓背景程式依 `nextAction` 發一則簡短續接訊息，不喚醒監督模型；相同下一步連報兩次則轉成停滯事件交監督。純背景工作已在執行、期限內不需要模型介入時使用 `waiting`，或相容的 `progress + waitMinutes`；`waitMinutes` 必須是 1～120 分鐘，到期前不發續接，結果變化或到期才產生 `continue` 事件。等待不是 PASS，也不會關閉監督自己的進度時鐘。文字若包含權限審查、使用者核准、push、merge、發布等真正阻塞，即使標成 `waiting` 也改送監督。普通進度應在回合中通報；回合結束仍有工作才使用事件標記。執行回合結束卻沒有標記、標記格式有誤時會作為異常事件送來，避免無聲停止。事件標記那一行本身是完整 JSON 即可，標記後面另起一行的文字會被忽略。新事件先持久保存完整原文，喚醒只傳事件識別、雜湊及 `supervise.cjs context RUN EVENT_ID`；不附整段處理規則或歷史。context 只接受目前待決事件，一次提供 brief 與授權來源；送驗才載完整有效契約。舊版未確認送達的 prompt 保留原文對帳，不在升級時改寫或重送。

監督一次只處理一個事件。等待 API 只回報最新回合，所以背景程式每讀到一個新的完成回合，就從對話紀錄往回補讀（最多 8 個回合，到上一個已處理回合為止）：前一事件未決期間或兩次讀取之間完成的提問、阻塞、送驗、無標記或格式錯誤的回合，依完成先後排進 `eventQueue`，前一事件決策後依序成為待決事件，排在派工檢查與進度時鐘前面；已被後續回合取代的一般進度與等待、沒有最終回覆的回合只記為已處理，不再續接。brief 的 `eventQueue` 列出排隊事件，儀表板顯示件數。佇列裡有較新的送驗時不能接受目前這份（程式會拒絕）：用 observe 寫明「被排隊中的送驗 <id> 取代」，再處理那一份。佇列裡沒有送驗、只有提問或阻塞等事件時，送驗的 context 另附它們的完整原文（`queued`），接受照常；背景程式把它們記為驗收時一併結案（resolved 的 `closedWithAcceptance`），監督把它們列進給使用者的收尾清單。

送驗前用 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...` 產生候選清單及**可直接貼在最終回覆末尾的完整事件行**；不要手寫或截短雜湊。清單至少列一個檔案，包含本次候選版所有直接修改的交付檔。監督接收時會重算清單及每個候選檔，變動後必須另建清單並重交，不得拼接舊證據。

## 判定與收件

監督收到事件後直接在 `RUN/decision-<eventId>.json` 寫決策。`disposition` 為 `accept`、`reject`、`reply`、`observe` 或 `needs_user`；`eventId` 必須精確相同。退件與代答有 `reply`；接受另有 `revision` 及逐條 `results`。每條結果含 `id`、`status:"PASS"`、`method`、`expected`、`actual` 與至少一個 `evidence:[{"path":"絕對路徑","sha256":"真實檔案雜湊"}]`。可用獨立測試輸出、瀏覽器／視覺證據或原始資料查核檔；只寫 PASS 不構成證據。執行上方 `decision` 命令檢查成功，才可宣稱全數通過。

監看可能在決策檔寫入後、`decision` 命令執行前就已處理它；此時命令仍須對保存的同一事件與決策雜湊回傳 `valid:true, processed:true`。若檔案事後改動則拒絕，不能把競速造成的「無待決事件」誤當驗收失敗。

決策檔沒通過檢查時，背景程式不套用也不結束：原檔保留，錯誤記在 daemon-state 的 `decisionErrors`（context 的 `brief.decisionError`），事件維持待決；同一版本 45 秒後仍在，就以原事件附錯誤原文喚醒監督一次。監督修正後覆寫同一個決策檔，先用 `decision` 命令檢查通過再結束回合。

背景程式只把 `reject` 或 `reply` 傳給精確執行對話，並讀回完整訊息保存 receipt。執行者問到待核准動作而仍有其他工作可做時，監督用 `reply` 指明可逆方案、暫停的具體動作與繼續項目；**不可用 `needs_user` 凍結整條主線**。純確認、已知阻塞且無需再發訊時用 `observe`，即使當下只剩待核准事項也繼續接新事件。`needs_user` 保留當前 pending 並暫停消費新事件，只在已有使用者指示確實需要整體暫停時使用；不是一般待核准事項的預設。送達不明只讀回對帳，不重送。接受後關閉該 run 的監看；執行對話即使先自稱完成也不得讓監督狀態提前完成。

送往監督的事件讀回確認後，若 45 秒仍沒有監督模型輸出、decision 不存在且沒有 `STOP`，resident watcher 送一次獨立的短喚醒訊息，只引用原 `LONG_TASK_DELIVERY` 識別；不得複製或重送原業務事件。模型已有輸出、decision 已出現或 STOP 存在時不補送；每個事件至多一次。這是漏啟動備援，不是固定 heartbeat。它和監看同在監督對話自己的工作階段，只在監督對話保持載入時有效，不能用來對抗 App 卸載或暫停對話；那由下方「保持載入」處理。

`observe`（記錄後繼續監看）必須有非空 `reason`；不得含 `reply`、`delivery`、`revision`、`results` 或 `pendingApprovals`（待決事項登記在[待決帳](#待決帳)，決策帶這欄會被拒）。背景程式保存完整決策及雜湊、清除該 pending，再繼續等新事件；不向執行者發訊、不接受候選、不把待核准改成授權。範例：

```json
{"eventId":"原事件識別值","disposition":"observe","reason":"執行者只確認收到；正式發布仍待使用者授權，已在待決帳 release-approval，不需再回覆。"}
```

使用者之後提供核准時，先核對原話與操作範圍，用 `amend`（action:"authorization"）登記並帶 `pendingKeys` 一併結掉待決帳對應項（見下方「原契約、使用者修訂與舊 run 接入」），再以新的唯一 `LONG_TASK_DELIVERY` 標記、原生 App 傳訊及讀回交給執行者，保存送達與決策帳；不要改已處理的 observe 決策。這是使用者新答覆的交接，日常事件仍由 resident watcher 傳訊。`STOP` 仍優先，不自行清除或重啟。

## 待決帳

要使用者決定或本人動手的事登記在 `RUN/pending-decisions.json`，只經監督對話的 `supervise.cjs pending` 寫入（程式核對呼叫者是原監督對話）；背景程式與儀表板只讀。一份變更檔可含四種清單，任一項不合格整份都不寫入：

```json
{"raise":[{"key":"r24-r21-relogin","kind":"credential","ask":"R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？","recommend":"A 兩個都重登：你在兩個視窗各輸入一次信箱和驗證碼，約 2 小時跑完","why":"驗證碼只有你收得到；不重登就得縮小驗收","options":["A 兩個都重登","B 只重登 uat2","C 列已知缺口"]}],
 "reopen":[{"key":"deploy-window","fact":"主機維護時段改到週六，原答案的時段已不能用"}],
 "withdraw":[{"key":"webhook-fix","reason":"修訂 AMEND-AUTH-OLD-R21-JIRA-FULLACCESS-20261011 的「代我回答所有執行對話」涵蓋，監督採根因修正"}],
 "answer":[{"key":"r24-r21-relogin","choice":"A","quote":"R24R21: A 兩個都重登"}]}
```

- `kind` 只能是 irreversible（不可逆）、paid（付費）、delete（刪除，測試中間產物除外）、credential（帳號或憑證）、external（對外發送）、prohibition（推翻禁令）、acceptance（改驗收條文）、user_action（要本人動手）、major_change（上層規則要先確認的重大變更）；其他類程式拒收，由監督自己決定。kind 只逼監督寫出理由，不證明真的該問。`ask`、`recommend`、`why` 必填，`options` 選填。
- 同一 key 再 raise 是更新原項；kind、ask、recommend、why、options 完全相同時不算變動，不留歷史、不需重列。已回答或已撤下的 key 只能用 `reopen` 附改變題目的新事實重開，舊答案留在 history。問題文字和任何一項相同（不論狀態）的會被拒：未決的請更新那個 key，已結的請 reopen 那個 key。換了說法的重複，由監督對照 context 附的完整清單自己判斷。
- 使用者的回答要登記成授權或驗收修訂（同意某動作、給授權範圍、改驗收條文）時，唯一做法是 `supervise.cjs amend RUN FILE`，在修訂 JSON 加 `pendingKeys`（它回答的待決 key，每項是 key 字串或 `{"key":…,"choice":…}`）：一步登記修訂並以修訂 id 結案這些項（`answer.amendmentId`），不再另跑 `pending` 的 `answer`。任一 key 不在待決帳、已撤下或已由別的回答結案時整筆不寫，修訂帳與待決帳都不變；同一修訂重送只結案仍未決的項，修訂不重複登記。先 `answer` 原話再另做 `amend`，兩邊會連不起來（2026-10-15 IA 10 項待決的 `answer.amendmentId` 全空）。`pending` 的 `answer` 只用於不需登記修訂的回答（例如本人已切好權限選單），或結掉已被先前登記的修訂解決的項目（附那筆 `amendmentId`）。
- `answer` 的 `quote` 是本回合收到的使用者原話（本對話輸入或別的對話轉來，規則同 pause）；不是本回合收到的，另附 `source:{path,sha256}` 指向允許根目錄內、含這句原話的已存原文快照，或改用已登記修訂的 `amendmentId`。`withdraw` 寫明為什麼監督能自己決定、依據哪份授權或修訂，或哪個事件讓它不再需要（例如 `permission_changed` 的事件識別）。
- 問使用者：`supervise.cjs ask RUN` 只讀，回 `{items,new,repeat}`：`items` 是全部未決項，全部寫在同一則回覆；`new` 是還沒列過或列過後改過的 key；`repeat:true` 表示全都列過且沒變，不再問。列出的同一回合執行 `supervise.cjs shown RUN <key…>`，key 必須正好是全部未決項才記為已列，少列、多列都拒絕。
- `context` 與 `brief` 的 `pendingDecisions` 有 `open`（完整未決項）、`closed`（已答／已撤下的 key、問題與答案）、`unpresented`（還沒列給使用者的 key）；檔案損壞時改附 `error`，修好前 `pending` 拒絕寫入。`監督儀表板.md` 的「待你決定」節顯示同一份未決清單，`pending`、`shown` 寫入後立即更新。
- 舊版 run 的待決帳檔還沒建立時，`pendingDecisions.legacy` 列出歷次決策的 pendingApprovals 文字；監督依決策帳與現況把仍未決的以新格式登記一次（都已解決就送 `{"raise":[]}`），之後不再出現。舊文字有的是全表、有的是增量，所以程式不自動匯入。

## 派工檢查事件

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼的最終回覆事件。監督核對快照和真實來源後，照原流程寫具體 reply 決策；不要自行傳訊。resident watcher 在真正送出前重查，目前已解決的事件會記為 obsolete，不送舊指示；同一事件中仍有未處理問題則重新形成事件。外部 `dispatch-preflight` 僅供唯讀查核，不改 daemon state。新 run 預設啟用；既有 run 使用 `attach-dispatch`，不改驗收契約，也不因掛載而清 STOP 或重新啟動。

## 主動進度查核

監督有自己的進度時鐘，不以執行者說的等待或步調為準。時鐘分層：背景程式每分鐘用程式確認工作有在動、在途包是否超過 AI 時程基準，每 30 分鐘在 `RUN/clock.jsonl` 留一筆查核紀錄（活動時間、各包經過／基準、發現的問題，另列 `open`：當下仍未解決的問題，包括已通報過的）；只有發現問題才產生 `progress_review` 送進本對話，`reasons` 標明原因：

- `executor_blocked`：執行對話的指令發出 5 分鐘仍沒有結果、這段期間沒有任何指令跑完，程序清單裡也找不到它在跑，這只是可能卡住的線索。先核對原工具結果及上層授權；沒有明確拒絕不得推定需要本人處理。工具確實要求本人確認時才用 `observe` 記錄拒絕原文與受阻動作，集中交由原監督向使用者說明。
- `machine_slept`：綁定後電腦睡眠 5 分鐘以上，例如用電池闔蓋，整場因此停住。監督請使用者接電源、不要闔蓋，用 `observe`，並把停擺時長記進決策帳與驗收報告。綁定前的睡眠不算。
- `silence`：兩個對話、執行端子代理與在跑的測試程序全部靜止 15 分鐘。監督對執行端事件（送驗、提問、阻塞等；進度查核與派工檢查不算）的判定套用時間（`lastDecisionAt`：送出 reply／reject，或記下 observe）也算活動起點：15 分鐘從上述最後活動與 `lastDecisionAt` 取較晚者起算，事件等監督判定期間執行端是在等判定，不算靜止（2026-10-15 GDB 兩次送驗驗了 21、27 分鐘後退件，接收器重掛就立刻誤發 silence）。工具輸出或游標變動不算新訊息；子代理以它在 `CODEX_HOME/sessions` 的紀錄為準；測試程序是派工快照中非代理的在途包，以 evidence 檔（例如紀錄檔）的更新時間為準，透過資源帳本啟動、程序還活著的，即使不寫紀錄也算在動。
- `wait_changed`：已核對的等待條件變了（見下節）。
- `overdue`：在途工作包扣掉電腦睡眠後的經過時間達 AI 時程基準 1.5 倍時叫醒一次，達 3 倍再叫醒一次，不論該包是否仍有產出或程序還在跑（Jay 2026-10-13）。同一包每一級最多通知一次，第一次查到就已過 3 倍時只叫醒一次。執行端重估寫入新基準後，只有重估把該級的叫醒時點（`startedAt` 加該倍數的基準分鐘）往後延到比先前叫醒過的都晚（範圍擴大或換新階段）才算新基準、重新起算那一級（去重鍵仍是 `overdue:<包>@<startedAt>/<分鐘>x<級數>`，舊 run 已叫醒的紀錄升級後照樣算數）；基準改小或只是重算數字不重叫（2026-10-15 IA 一包 3 倍叫醒後基準由 26 改成 19.5 分，4 分鐘後同級又叫醒一次）。叫醒時，其他在途、已達基準 1.2 倍的包一併交監督分析，這些包的 1.5 倍那一級記為已叫醒、之後不再各自叫醒；3 倍那一級照舊各自叫醒（Jay 2026-10-15；IA 同批基準相近的 4 包 7 分鐘內陸續到 1.5 倍，原本叫醒 3 次）。一併列出的包在事件的 `nearOverdue`：只列已達 1.2 倍、未滿 1.5 倍、這次把 1.5 倍記為已叫醒的包；已過 1.5 倍的包看 `pace`。處理方式見[單次事件處理](event-review.md)。子代理紀錄已顯示做完、只是派工快照沒更新的包不算落後，記為 `snapshot_stale`。
- `no_event_hour`：距離執行對話上一次真正事件（任何完成回合送出的 LONG_TASK_EVENT）已滿 1 小時，扣掉電腦睡眠；每段安靜期只問一次，新事件回來就重新計時；監督對執行端事件（送驗、提問、阻塞等）的判定套用時（送出 reply／reject 或記下 observe，`lastDecisionAt`）也重新計時：等判定的時間不算安靜；進度查核與派工檢查的判定不重新計時。用途是抓「預估時長報得過長，超時永遠不會觸發」的情況，所以執行端看起來仍在動也照樣觸發。處理方式見[單次事件處理](event-review.md)。
- `baseline_missing`：在途工作包沒有基準時長；同一包只通知一次，請執行端補上。
- `process_stalled`：在跑的測試程序 15 分鐘沒有產出，而且查不到它還活著。例如故障演練依設計等待租約時，程序還在就不算停住。
- `resource_underused`：派工快照宣告的真實資源（主機排查名額、測試身分）還有空位，卻有依賴已全部完成、可立即開跑的包在等同一個資源；監督評估能否並行。可立即開跑＝就緒包須 `independent`、`safe`、依賴全部完成、排他資源沒被在途包占用；受阻包只算 kind 為 `resource_conflict` 的；且它用到的每個已宣告資源空位都夠它的 units。`resourceUnderused[].waiting` 只列這些包；依賴還沒完成或實際互斥的等待包不算。同一資源的可派包集合沒變就不再叫醒，包開始或結束只改變已用名額時不重叫（2026-10-15 IA 19 次叫醒中 15 次監督判 observe，因為舊去重以已用數與等待清單為準）。
- `repeat`：綁定後同一條指令連續失敗 3 次。處理過一次進度查核後重新計數。
- `idle_with_work`：執行端與所有子代理都停了 5 分鐘（扣掉電腦睡眠；停頓從執行端最後活動或監督對它事件的判定套用時（`lastDecisionAt`）起算，取較晚者），派工快照卻還有未通過的驗收條件（FAIL／PENDING／INCONCLUSIVE）或就緒包。執行端只在輪詢背景程序或等待工具時也算停；真正下指令、改檔或思考都算活動。每段停頓通知一次，事件附 `idleWithWork:{idleMinutes,openCriteria,readyPackages}`。監督核對後用 reply 請執行端把能並行的派出去（依驗收條件分線、查核與測試交子代理、批次派工），或說明為何只能依序；剩下的都只差使用者核准或外部結果時用 observe。這類事件不是 silence，observe 不需 wait。
- `unplanned_criteria`：未通過的驗收條件 10 分鐘沒有任何 ready／inFlight／blocked／returned 工作包用 `acceptanceIds` 標到它（扣掉電腦睡眠），執行端在忙也照樣觸發。同一組條件只通知一次，事件附 `unplannedCriteria:{criteria,freeCapacity,minutes}`，freeCapacity 是快照驗證過的子代理席位減在途包數。監督用 reply 逐條點名要派的工作包；只剩等使用者核准或暫停中不發，暫停解除後重新計時。
- `doc_budget`：派工快照的 `docBudget`（文件時間預算＝開發實測分鐘 × 1.5，2026-10-15 定案；格式見[派工快照協定](dispatch.md#文件時間預算)）從 `startedAt` 起算、扣掉電腦睡眠，用掉一半時叫醒一次（`stage:"half"`），用完時再叫醒一次（`stage:"spent"`）；事件附 `docBudget:{stage,startedAt,devMinutes,budgetMinutes,usedMinutes,basis}`。同一份預算每一級只叫醒一次，`startedAt` 或 `minutes` 改變才算新預算；等使用者核准時不發。

事件附 `pace`（每個在途包的開始時間、扣掉睡眠後的經過分鐘、睡眠分鐘、基準分鐘、比值、是否已做完、程序是否還活著、執行端與監督各自算的基準及是否差超過一半、子代理已輸出 token、最後活動時間、本場各模型實測每秒輸出 token）、`executorBlocked`、`machineSlept`、`overdue`、`nearOverdue`、`baselineMissing`、`processStalled`、`resourceUnderused`、`failedCommands` 與各類最後活動時間（含監督最近一次判定套用的 `lastDecisionAt`）。

處理步驟要少：先 `supervise.cjs context RUN EVENT_ID` 一次取得事件、監看狀態、各包速度、執行端最後幾段話、派工現況與最近決策，不逐檔探查；需要時再讀相關原始證據。落後、重複或證據不足時用 `reply`，填 `progressCheck.evidence`、`finding`、`guidance`；guidance 是已授權範圍內的具體加速建議，例如拆包並行、只跑受影響測試、停止重試改換做法、先收回整合已完成成果、補基準或更新快照，原文須在 reply。進度正常時用 `observe`，附 reason、`progressCheck.evidence`、`finding`，不傳訊、不打斷執行者。不要重問已有授權或已提出的核准題。

背景程式在送出決策前重查：`silence`、`wait_changed` 事件遇到執行對話的新訊息即過期，記為 obsolete、不送舊指示；`overdue`、`baseline_missing`、`process_stalled`、`repeat` 等仍核對對應問題，不因新活動過期；STOP 一律優先。

AI 時程基準＝預估輸出 token ÷ 本場同模型實測每秒輸出 token（只算子代理回合內的時間，不算回合之間的等待），加上已量測的工具時間（完整測試、部署等）。`scripts/pace.cjs status RUN` 列出在途包與基準；`pace.cjs estimate RUN --model <模型> [--tokens N] [--tool-minutes M]` 產生快照用的基準。本場同模型已完成的子代理少於 3 個時，用技能內建的實測預設值。不用人類開發經驗估時；執行端寫進派工快照的基準，監督以同一公式重算覆核，差超過一半先請執行端說明依據。

`silence`、`wait_changed` 核對後只剩已核對、未變的等待時才用 `observe`，填非空 reason、`progressCheck.evidence`、`finding` 與下節 wait；其他原因的 `observe` 不需要 wait。背景保持接收新事件，不能因省 Token 停止 watcher。新執行訊息、新的使用者答覆、條件檔變動或既定期限到達會解除靜默等待並再查核；監督自己結束回合不解除等待。一般 observe 不會永久取消進度查核。

### checked wait（已核對的等待）

`wait:{kind:"user_approval",conditions:[]}` 用於已提出且沒有其他可行工作的使用者核准。外部結果用 `kind:"external_result"`，至少有可觀察條件檔 `conditions:[{path:"絕對路徑",sha256:"當下實際雜湊"}]` 或已有依據的 `resumeAt`。等待尚未出現的檔案時 sha256 填 null。只能列本 run 允許根目錄內的檔案；用具體結果或授權檔，勿列每次輪詢都改的 daemon-state。resumeAt 只承接原訂工作／業務期限，不自行設定新門檻。等待仍不是 PASS 或授權，STOP 優先。

### 延遲收件恢復

App 持有的 `run-watch.cjs` 遇 needs_reconcile 且有 saved inflight 時，以既有退避重啟只讀對帳；送達對帳時若目標對話正在跑回合（訊息排在回合後面），每 15 秒再查一次，等回合結束收進去為止，不判為無法確認、不重開監看。該 delivery 預設不再送第二次。唯一例外是能證明遺失：目標對話在本機有紀錄檔、目前閒置、送出後已有回合結束，所有紀錄段落卻都沒有該送達標記（例如訊息排在進行中的回合後面，該回合被中斷而丟失）。這時重送一次並記入 `lostDeliveries`；重送後仍對不到，或缺任何一項證據，照舊停在 needs_reconcile。沒有 inflight、STOP、stopped、accepted 不自動復活。外部操作只有排隊時仍不可聲稱模型已讀。恢復不代表整個 App 父程序可自行復活。

## 原契約、使用者修訂與舊 run 接入

鎖定來源完成正式版本歸檔後，只有內容雜湊完全相同時可用 `supervise.cjs relocate-sources RUN INPUT.json` 登記精確搬移。輸入逐項綁定原絕對路徑、歸檔後絕對路徑與原 SHA-256；歸檔檔案必須位於 run 的允許根目錄。這只處理檔案搬移，不改契約內容、驗收條文或授權；不得用同名搜尋、未綁定候選或不同雜湊代替原來源。

先讀 [授權承接](authorization.md)，核對真實使用者原文。`supervise.cjs effective-contract RUN` 輸出原契約加已核准修訂的有效範圍、排除項、授權更新及 contractStateSha256。監督、執行、派工查核和最後接受都讀同一有效範圍。

在原監督的安全停點（無 pending、無 inflight、舊 watcher 與 dispatch writer 已退出，STOP/accepted/stopped 不改）用 `supervise.cjs amend RUN INPUT.json` 登記修訂。使用者的修訂或授權一收到就登記，不等下一個事件：① `status` 的 `pending` 與 `inflight` 都是 null 才停監看，有 pending 先完成它的決策並等背景程式套用，有 inflight 就等背景程式對帳完成；② 停 `run-watch.cjs` 父程序（`runtime-state.json` 的 pid，它會一併停掉 `native-watch.cjs`），確認父程序與 `watcher.lock` 的 pid 都已退出；③ `amend`，停的瞬間又出現 pending 或 inflight 時 amend 會拒絕，就重掛一組讓它處理完再從 ① 重來；④ 只重掛一組 `run-watch.cjs`，`status` 回 active 後再把授權交給執行主線。INPUT 含 id、原 contractSha256、authority:{role:"user",quote:"逐字原話",locator:"原對話訊息／文件位置",at:"來源時間",source:{path:"允許根目錄內的原文快照",sha256:"實算雜湊"}}、changes:[{id:"原條文ID",action:"exclude/replace/restore"}]。replace 另填完整 requirement、verify；授權更新用 action:"authorization"、固定 id、scope、instruction。這筆修訂回答了待決帳的哪幾項，就加 `pendingKeys:["待決 key",…]`，修訂寫入後程式以這筆修訂的 id 結掉它們（見[待決帳](#待決帳)），不另跑 `pending` 的 `answer`。代理提案不能冒填 role:user，來源檔須含原話，語意與操作範圍由監督實際查原對話核實。工具只檢查來源完整性，不能證明任意檔案作者真是使用者。

修訂另存不可改寫的 contract-amendments.jsonl，保留原 contract.json；遺失、變動、衝突皆先對帳，不清檔重置。接受決策必須帶當前 contractStateSha256，結果只對有效條文逐條 PASS；排除項明列 EXCLUDED 及核准來源，不能偽填 PASS。

**換 run 續接同一任務**（Claude 長任務搬到 Codex、換監督或執行對話）：`input.json` 不填 `contract`，改填 `inheritFrom:"<舊 run 絕對路徑>"`。`init` 原樣複製舊 run 的 `contract.json`、`contract-amendments.jsonl`、`source-relocations.json` 與 `pending-decisions.json`，逐項重算原契約來源與每筆修訂的使用者原文快照；任一份遺失、變動或不在 `allowedRoots` 內，一次列出全部並拒絕建立。舊 run 的監看（Codex 是 `run-watch.cjs` 父程序與其 `native-watch.cjs`，兩個都要停）、派工寫入或契約更新仍在跑也拒絕。建立後新 run 的 contractStateSha256 與舊 run 相同，`authorization` 附 `inheritedFrom`。不要拿 `effective-contract` 的輸出重寫新契約：修訂的原話、定位與雜湊會消失，新 run 登記第一筆修訂後，寫進契約的授權更新也會被蓋掉，所以 init 拒收帶 `authorizationUpdates`、`excluded` 或 `contractStateSha256` 的契約。舊 run 原地保留，不改不刪。

`inheritFrom` 只帶走已登記的修訂。init 之後、掛監看之前就是安全停點，依序：① 核對舊監督的決策帳與舊 run 目錄，舊版技能只存成檔案、沒登記的使用者授權，逐份回原對話核對原話後，在新 run 用 `amend`（action:"authorization"）補登，來源指向舊 run 的原文快照；② 本次換 run 的使用者原話同樣登記；①②解決了承接來的待決項時，在那份 amend 帶 `pendingKeys` 一併結案；③ 承接來的待決帳若有項目已被舊 run 登記過的修訂解決，用 `pending` 的 `answer` 附那筆 `amendmentId` 結案；④ 再 `attach-acceptance`、掛監看、把 run 路徑交給執行者，並要求執行者先讀 `supervise.cjs authorization RUN` 同步授權表。

舊 run 的結果帳用 `supervise.cjs attach-acceptance RUN ACCEPTANCE.json` 接入。原執行者準備目前實際候選與逐條狀態，涵蓋有效條文及 EXCLUDED 項；未測 PENDING，已跑但不足判定 INCONCLUSIVE，缺口 FAIL／BLOCKED，不能憑執行次數補成 PASS。工具保存結果歷史、保留既有派工快照與條文，最後才標記 acceptance 已接入。若已有歷史不得清空或覆蓋舊實測。

接入後原監督與執行者都讀回有效契約、摘要與新規則，再以原游標、pending、receipt 續接唯一 watcher；安裝檔案一致不代表現役已切換。不得由另一對話直接改 live run，也不自動清除 STOP。


時鐘叫醒不改驗收門檻、不減少工作範圍；時鐘不是人工驗收。指令成功清除該指令失敗計數，只有未被成功打斷的三次失敗才算 repeat。

## 指令期限、權限模式、排程、登入、限速、儀表板與暫停

以下都由背景程式不呼叫模型地查核，有問題才產生 `progress_review`；處理方式見 event-review。

- `instruction_overdue`：監督送出 reply／reject 後開始計時，期限是 decision 的 `instruction.deadlineMinutes`，沒填則 30 分鐘，扣掉電腦睡眠。期限內只要有執行端的真正事件，或派工快照的 `updatedAt` 晚於送出時間，就算有動靜。逾時發第一次（`misses=1`），再過一個期限發第二次（`misses=2`），之後不再追這則。只差使用者核准期間不發逾時通知，但有動靜照樣結案，核准等待解除後不會把已完成的指示誤報為逾時。
- `permission_review`／`permission_changed`：從執行對話紀錄的 `turn_context` 與 `thread_settings_applied` 讀權限模式，從工具輸出讀「rejected due to unacceptable risk」拒絕原文。自動審查下開工通知一次，之後只有新的工作項目被擋才再通知（同一程式與子指令，或同一工具，算同一項）；重複被擋只記在儀表板的累計次數。工具輸出只是引用到那段字（例如讀技能說明）不算被擋：真正的拒絕必附審查理由（Reason）或 Auto-review denied。介面上的權限選單要在該對話輸入框送出一則訊息才會套用到回合，只切選單不會改到背景送來的回合（2026-10-11 實測三個對話選了仍是自動審查）；使用者切選單後由監督原生傳訊送的續接能否套用新模式，尚待實測，處理方式見[授權承接](authorization.md#平台自動審查擋下操作時)。讀到執行端的回合是完全存取（`approval_policy=never`）後發一次 `permission_changed`。
- `automation_found`：啟動時及每 30 分鐘讀 `CODEX_HOME/automations/*/automation.toml`，找出 ACTIVE 且 `target_thread_id` 或 prompt 指向監督／執行對話的排程；同一排程同一版本只通知一次。
- `login_expired`：`RUN/login-sites.json`（init 依 `loginSites` 寫入）列出本任務會用到的每個登入，格式 `{"sites":[…]}`，每筆是下列其一。網站：`{"name":"網站名","url":"https://…","loggedOutPattern":"登出時網址或標題會出現的正規式"}`，用 chrome-relay 在使用者已登入的 Chrome 另開背景分頁，讀落點網址與標題後只關閉該分頁。非瀏覽器的登入或權限（CLI／API token、ssh、MCP 授權、測試身分、chrome-relay 連線等）：`{"name":"名稱","check":"唯讀檢查指令"}`，在系統暫存目錄以 `/bin/sh -c` 執行，60 秒逾時，輸出一律丟棄、不寫進 run 目錄；結束碼 0＝有效、1＝已失效，其他（126／127 找不到指令、當掉、名稱打錯被攔下）或逾時＝檢查本身出錯（`error`），不當成登出。指令只有在確定是認證失效時才 exit 1；連不到主機、網路逾時、服務沒回應等回其他非 0 碼（判 `error`），否則會把連線問題誤報成要使用者重登（2026-10-15 GDB 的 ssh 檢查以結束碼 255 一律判失效，直連主機被擋、網路逾時也是 255，被誤判 `logged_out`）。指令只讀狀態：不呼叫模型、不開登入視窗、不寫資料，也不把 token 寫在指令裡；用不會被管線吃掉錯誤的寫法，例如 `out=$(CLAUDE_CONFIG_DIR=$HOME/.gateway-uat-clients/uat2 claude mcp get gateway) || exit 3; case "$out" in *Connected*) exit 0;; *) exit 1;; esac`（2026-10-13 GDB 的 uat2／uat3 以 `claude mcp get` 判斷已驗證）；ssh 以輸出分辨，例如 `out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 user@host true 2>&1) && exit 0; case "$out" in *"Permission denied"*) exit 1;; *) exit 3;; esac`（只有金鑰或帳號被拒才判失效，連不到主機、逾時等其他非 0 回 3）。Codex MCP 的 OAuth 是否仍有效目前沒有唯讀檢查指令（`codex mcp list` 只顯示 `Auth: OAuth`，代表權杖存在、不代表有效），是已知缺口，不寫成 check、也不宣稱有在看。兩種都可加 `login`（失效時怎麼恢復，給執行端或使用者看）。開工預檢與清單有變動後跑 `node <installed-skill>/scripts/login-check.cjs DIR`（init 前 DIR 是準備目錄，之後是 RUN）：不受每小時限制、立刻全部實測，印出 `needsAction`；目錄或清單不存在、格式不對時印原因並以 2 結束。它逐筆依序檢查（網站每筆最久約 2.5 分鐘，指令每筆最多 60 秒），登入多時加長指令逾時或放背景跑。背景程式每小時再全部實測一次，結果寫入 `RUN/login-status.json`；同一個登入每進入一種失效狀態（`logged_out` 或 `error`）通知一次，狀態換了再通知，恢復有效後重新計算。執行端以 `question` 交來新的登入時，監督補進這個檔並跑一次 `login-check.cjs RUN`。檢查只偵測、通知，不會自動續期登入。平台自己帳號的錯誤（例如執行對話回合的 401 OAuth 過期）屬 `platform_error`，不列在這裡。
- 限速換模型：讀 opencodex 的 `usage.jsonl`，以「對話 ID 的 SHA-256 前 32 碼」對應監督、執行對話與其子代理，看到 429／rate-limit 就記錄該系列的限速與恢復時間，寫入 `RUN/model-fallback.json`。背景程式（重新）啟動時回看檔尾一段：某對話最新一筆模型請求仍是被拒、且在 5 小時內，就當成現行限速；被拒後已有成功請求的不算。監督或執行對話被拒時，送一則短訊並帶 `model` 參數，讓它改用下一個模型接續；恢復時間到了，下一則送給它的訊息帶回原模型。子代理被拒時，通知執行端改用新模型重派。全部可用模型都被限速時發 `rate_limited_all`。binding 的 `modelFallback` 設為 false 可關閉。
- `platform_error`（平台錯誤回合，2026-10-14 定案）：執行對話的回合被平台錯誤中斷時，rollout 的 `task_complete` 帶 `error:{message,codex_error_info}`，App 把對話標成 `systemError`、回合 `failed`，不算完成回合，所以不會成為事件（2026-09-23～10-14 全機 65 筆：串流中斷或伺服器過載 17、429 重試用完 13、用量上限 9、opencodex 路由錯誤 6、連線失敗 7、全部 OAuth 帳號限速 5、提供者停用 3、API 額度上限 3、內容政策 2；用量上限 9 筆都寫明恢復時間「try again at …」）。錯誤後 2 分鐘（扣掉電腦睡眠）執行對話自己的紀錄沒有新的工作，發一次 `platform_error`，附 `platformError:{who,since,kind,status,text}`，kind 是 `codex_error_info`；限速換模型或排隊訊息常在監看迴圈內讓它恢復，恢復了就結案、不叫醒。是否恢復只看執行對話紀錄裡錯誤之後的工作，解除暫停不算恢復；錯誤未恢復前 brief 的 `platformError` 與儀表板「平台錯誤」一直附原文。同一筆錯誤只通知一次，只差使用者核准（checked wait 的 kind 為 user_approval）期間不發。子代理的非限速平台錯誤由執行對話自己重派，子代理限速照上一條換模型。
- `監督儀表板.md`：每分鐘更新一次，包括監看狀態、執行對話權限、限速換模型、平台錯誤、等待中的指示、逐條驗收、在途工作與剩餘時間。剩餘時間依「沒有量測就不填估計值」：只用派工快照裡剩餘工作包的 AI 時程基準並註明依據——剩下的都是在途包且都有未超過的基準時，取各包「基準減已跑時間」最晚的一包；還有就緒或受阻包（尚無基準）、在途包沒填基準或已超過基準時，顯示「未估」並列出這些包；不以每小時通過條數換算剩餘條數（多數條目要等部署後一起通過，2026-10-15 GDB 因此顯示 19.7 小時，嚴重高估）。
- 暫停：`supervise.cjs pause RUN "<使用者原話>"` 寫入 `PAUSED.json`。暫停期間不送時鐘與派工事件，執行對話交回的真正事件照常處理；`supervise.cjs resume RUN "<使用者原話>"` 解除暫停並重新起算各時鐘。pause 與 stop 都要附使用者原話，程式在監督對話紀錄中核對這句話是本回合收到的（使用者輸入或別的對話轉來）；壓縮後重現的舊訊息會被拒絕。
- 保持載入：App 會卸載閒置約 3 小時的對話並終止它啟動的程序（2026-10-12 量到）；App 在記憶體壓力下是否也會暫停 Codex 對話，目前未量測。監看必須在監督對話自己的工作階段啟動；監督連續閒置 150 分鐘（`CODEX_KEEPALIVE_MS`）時，監看送一則 `LONG_TASK_KEEPALIVE` 短訊讓監督對話保持載入，每段閒置一則。保持載入和喚醒備援分開：這則短訊是讓對話不被卸載；事件送達 45 秒的補喚醒跟監看同在這個工作階段，對話被卸載或暫停時一起停，只在對話保持載入時有效，所以不能當作對抗卸載的手段。
- 等監督裁決：執行端回報即使標成 `progress` 或 `waiting`，內容在等監督裁決、決定或回覆時，改當 `question` 立即交給監督。另外，只剩等使用者核准（checked wait 的 kind 為 user_approval）時，不發 `no_event_hour` 和 `idle_with_work`。
- 線上狀態：使用者 10 分鐘內在監督對話打過字，context 的 `brief.user.online` 為 true。brief 另附 `pendingDecisions`（完整待決帳，見[待決帳](#待決帳)）、`eventQueue`（排隊的執行對話事件）與 `decisionError`（目前事件上一版決策檔沒通過檢查的原因）。

# Claude Desktop Code 監督啟動與事件協定

監督先保存已定案對話、規格與附件的原文快照，建立 `contract`：`goal`、`authorization`、`criteria:[{id,requirement,source,verify}]`、`sources:[{path,sha256}]`。本次 `executorPrompt` 是可直接在**另一個 Claude Desktop Code 對話**送出的完整指示，首行帶 `LONG_TASK_BIND:<uuid>`；不能從背景 CLI 建立執行主線。若桌面原生工具可建立對話就用它，否則交付 prompt 檔及桌面操作入口，讓使用者在新桌面對話送出。監督必須用桌面對話清單／搜尋核對顯示中的 `local_...` ID，並在本機 transcript 看到同一標記的 `user` 訊息及 `entrypoint=claude-desktop`；`claude --resume` 或 CLI 清單不構成桌面可見證據。

`input.json` 需要 `projectRoot`、`allowedRoots`、監督工具環境的 `supervisorId`、監督桌面對話 `supervisorDesktopId`、桌面執行的 transcript `executorId`、桌面對話 `executorDesktopId`、`executorMarker`、`executorPrompt`、`loginSites`、`contract`（同一任務從舊 run 續接時不填 `contract`，改填 `inheritFrom`，見[換 run 續接同一任務](#換-run-續接同一任務)）。Claude `auto` 模式可能用臨時工具子 session；`init` 解析可見原監督對話。執行對話與監督對話必須不同，來源及工作區須逐項核對。

`loginSites` 必填：SKILL 啟動第 1 步在準備目錄預檢過的同一份清單（格式見下方 `login_expired`），init 檢查格式後寫成 `RUN/login-sites.json`，格式不對就一次列出問題、不建 run 目錄；本任務不用任何登入時填 `[]`。續接舊 run 也要重新預檢並填這一欄，登入清單不隨 `inheritFrom` 帶過來。

```text
node <installed-skill>/scripts/login-check.cjs PREP_DIR_OR_RUN
node <installed-skill>/scripts/supervise.cjs init RUN INPUT.json
node <installed-skill>/scripts/claude-watch.cjs RUN
node <installed-skill>/scripts/claude-hold.cjs RUN
node <installed-skill>/scripts/supervise.cjs status RUN
node <installed-skill>/scripts/supervise.cjs context RUN EVENT_ID
node <installed-skill>/scripts/supervise.cjs decision RUN DECISION.json
node <installed-skill>/scripts/supervise.cjs authorization RUN
node <installed-skill>/scripts/supervise.cjs pending RUN CHANGE.json
node <installed-skill>/scripts/supervise.cjs ask RUN
node <installed-skill>/scripts/supervise.cjs shown RUN KEY...
node <installed-skill>/scripts/supervise.cjs pause RUN "<使用者原話>"
node <installed-skill>/scripts/supervise.cjs resume RUN ["<使用者原話>"]
node <installed-skill>/scripts/supervise.cjs stop RUN "<使用者原話>"
```

`context` 一次回傳待決事件、brief（含完整[待決帳](#待決帳)與執行端排隊事件 `eventQueue`）、授權來源、[單次事件處理](event-review.md)規則與 decisionPath，送驗才附完整有效契約與排在它後面的事件原文（`queue`）；事件還在排隊時只回 `queued:true`、排第幾與目前要先處理的事件（見[原生事件交接](#原生事件交接)）。`brief` 仍可單獨使用。`authorization` 只列有效授權與補充的來源位置，續接舊 run 的另附 `inheritedFrom`。`pending`、`ask`、`shown` 見[待決帳](#待決帳)；pause、resume、stop 見[暫停與停止](#指令期限權限模式排程登入限速儀表板與暫停)。

第二、三行必須作為**監督桌面對話的背景 Bash 工具**執行，不能由 CLI detached 程序代替。`claude-watch.cjs` 是事件接收器：它讀同一執行 transcript 的新完整回合，輸出 `LONG_TASK_WAKE` 後結束；原桌面監督對話收到背景完成通知後，讀背景輸出與 `daemon-state.json`，確認同一事件 ID 再作判斷。`model="<synthetic>"`、零模型用量的 `No response requested.` 不算成功：那是 App 暫停過的對話恢復時補上的空回覆。App 的記憶體管理（`~/Library/Logs/Claude/main.log` 的 `CliGovernor … pressure evicting`、`Pausing session (governor_evict)`）會暫停沒有模型回合、也沒有背景指令在跑的對話並結束它的程序，有背景指令在跑的對話則跳過（`Skipping pause … active background task(s)`）。接收器必須結束才發得出完成通知，結束那一刻監督對話正好成了這種閒置對話：2026-10-07、10-13 兩次、10-14 共 4 次，監督都在接收器結束後數秒內被暫停，通知沒能啟動模型回合，最長停 4.8 小時。所以另掛整場不結束的保持載入 `claude-hold.cjs RUN`：它不呼叫模型、只讀 STOP、`daemon-state.json` 的 phase 與自己的 `hold.json`，不寫 run 狀態；run 被 accepted、stopped、出現 STOP 或 run 目錄已不存在時印一行 `LONG_TASK_HOLD_END` 後結束；同一 run 已有活的保持載入時，新開的那個印 `LONG_TASK_HOLD_ALREADY` 立即結束；其他讀檔失敗每 10 秒重試，連續 5 分鐘都失敗才印 `LONG_TASK_HOLD_ERROR` 並以非 0 結束。`status.active` 要求事件接收器與保持載入都在跑，`status.hold` 單看保持載入。普通讀取不啟動模型；一次只掛一個接收器、一個保持載入。每次處理事件、送達確認及 `decision` 後只重掛接收器。未掛好背景工具或 `status.active` 為假，不得稱持續監看。

保持載入的輸出：收到 `LONG_TASK_HOLD_END` 時先跑 `supervise.cjs status RUN`，phase 確實是 accepted／stopped 或 run 有 STOP 才一句話結束回合，否則補掛 `claude-hold.cjs RUN`。`LONG_TASK_HOLD_ALREADY` 表示已有一個在跑，不必處理。輸出沒有 END／ALREADY 行就結束（被停掉、`LONG_TASK_HOLD_ERROR` 或其他非預期結束）時，看 `status.hold`，為 false 就補掛。清除殘留的背景程式只用 TaskStop 或接收器的 PID，不用名稱比對（例如 `pkill -f`）。改監督新 run 或放棄舊 run 時，依使用者原話 `supervise.cjs stop` 結束舊 run，或用 TaskStop 停掉它的保持載入；run 一直沒有結束，保持載入就不會結束。

待實測（尚未在真實 App 驗證，不宣稱已驗證）：①有保持載入在跑時，記憶體壓力不會暫停監督對話；②保持載入在跑時，接收器結束仍會發完成通知並啟動真實模型回合。以上依 main.log 推論。驗證步驟：在隔離的桌面 Code 對話建一個暫存資料夾並寫入 `daemon-state.json`（內容 `{"phase":"watching"}`），用背景 Bash 掛 `claude-hold.cjs <該資料夾>`，再掛一個約 20 秒後結束的背景指令（代替接收器），然後結束回合；確認完成通知產生的是真實模型回合（transcript 的 `message.model` 是 claude 模型，不是 `<synthetic>`），並查 main.log：該對話在這段期間沒有 `Pausing session`；最後在資料夾放 STOP，確認保持載入印 `LONG_TASK_HOLD_END` 結束。第一場真實長任務另核對：每次接收器結束後，監督都在數秒內起真實模型回合。

## 執行對話的事件

執行者每個完成回合在**最終回覆末尾**放一行：

```text
LONG_TASK_EVENT {"kind":"progress","nextAction":"接下來要執行的具體工作"}
LONG_TASK_EVENT {"kind":"question"}
LONG_TASK_EVENT {"kind":"blocked"}
LONG_TASK_EVENT {"kind":"waiting","nextAction":"正在等待的背景工作與完成後動作","waitMinutes":30}
LONG_TASK_EVENT {"kind":"submission","revision":"sha256:<候選清單檔的 SHA-256>","manifest":"<候選清單檔絕對路徑>"}
```

若工作正在執行而回合尚未結束，背景監看保持安靜。若完成回合仍有可執行工作，`progress` 附下一步，監督用桌面原生跨對話傳訊送一則短續接。純背景等待可用 `waiting`，或相容的 `progress` 加 `waitMinutes`（1～120）：分鐘數用 `scripts/pace.cjs` 依等待中工作包的剩餘 AI 時程基準算出，不憑人類開發經驗填；宣告的等待不會暫停監督自己的進度時鐘，也不補發保活續接；同一回覆只要還有待決、授權遭拒或其他阻塞，改用 `question` 或 `blocked`，把背景工作寫在正文中。監督仍須讀完整回覆，不可只依標籤忽略阻塞。沒有事件或格式錯誤送監督處理，不能算完成。送驗前執行 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...`，用輸出的完整事件行；改版後另建清單並重交。

監督寫 `RUN/decision-<eventId>.json`。`eventId` 精確相同，`disposition` 為 `accept`、`reject`、`reply`、`observe` 或 `needs_user`。執行者問到待核准動作、但仍有其他工作可做時，使用 `reply` 指明已決定的可逆方案、暫停的具體動作與繼續項目，**不可用 `needs_user` 凍結整條主線**。純確認、已知阻塞且無需再發訊時使用 `observe`，即使當下只剩待核准事項，也須繼續接收新事件。`reject/reply` 有具體 `reply`；`accept` 有同一 `revision` 和每條 `PASS` 的 `method`、`expected`、`actual`、`evidence:[{path,sha256}]`。需向執行者續接、退件或代答時，訊息首行加入 `LONG_TASK_DELIVERY:<eventId>`，呼叫桌面原生送訊工具，保存它回報的 `delivered` 或 `queued` 及 `messageId` 到 `decision.delivery`。`delivered` 時 `decision` 檢查標記已進精確執行 transcript；只有 `queued` 時，桌面主機會把訊息扣到執行端本回合結束才寫入，`decision` 先記為待對帳（`status` 的 `unconfirmedDeliveries`），重新掛監看後由 watcher 讀到同一標記時確認。已排隊不可聲稱執行者已讀；遲遲未確認者列在進度查核事件，先對帳，不重送。`needs_user` 是保留當前 pending、暫停消費新事件的相容操作，只在確實需要整體暫停且已有使用者指示時使用；不是一般待核准事項的預設。

`needs_user` 決策另填 `wholeRunPauseSource`，記下使用者要求整案暫停的原文訊息／文件位置；沒有此欄，程式拒絕決策。個別待核准操作使用 `reply` 或 `observe`。

## 原生事件交接

綁定完成後，監督把精確 run 路徑及本節交給執行對話。執行者在需要代答、阻塞判斷或送驗時，先保存事件，再以桌面原生跨對話工具喚醒監督，補足背景通知可能無法啟動模型的情況。只有 `question`、`blocked`、`submission` 走這條路徑；純背景等待與一般進度維持原有監看，不傳保活訊息。

1. 為本次事件產生唯一 UUID，另存 `EVENT.json`：`id`、`kind`、完整回覆正文 `text`，送驗另含 `candidate.cjs` 產生的 `revision`、`manifest`。事件 ID 不因重試改變；正文不含最後的 `LONG_TASK_EVENT` 行。
2. 執行 `node <skill>/scripts/handoff.cjs prepare <ABS_RUN> <ABS_EVENT_JSON>`。程式先存原文並放進 run 的持久佇列（每個事件一個 `handoff-request-<id>.json`，依送出先後），再與 watcher 以同一鎖交接：監督手上沒有待決事件時，佇列最前面的事件成為 pending；監督還在處理前一個事件時，本事件留在佇列（輸出 `queued:true` 與 `ahead`：前面的事件與排第幾），等該事件決策、watcher 重掛後依序成為 pending，不報錯、不遺失（2026-10-12／13 A 開發 22 次 prepare 有 7 次被「Another event is already pending」拒絕，一則提問和一則補件送驗沒送到監督）。事件存進 pending 或佇列後，才輸出 `ready:true` 及原生傳訊所需的精確目的地與短訊。這一步不呼叫模型或 CLI。
3. 只有本次回傳 `ready:true` 才呼叫桌面原生傳訊一次，原樣使用 `targetDesktopId`、`message`。傳訊資格在呼叫前已落檔；中斷後再次 prepare 不會給第二次資格。`queued:true` 也照送這一則短訊（它會叫醒可能沒醒的監督），然後續做其他工作，不重試、不換 ID、不改請使用者處理。`ready:false`、錯誤或送達不明均先查事件、pending、佇列、收據及精確監督 transcript，不盲重送、不換新 ID 重試。
4. 原生工具回傳後另存 `{eventId,marker,status,messageId}`，其中 `status` 是 `delivered`、`queued` 或 `unknown`；unknown 可不含 messageId。執行 `node <skill>/scripts/handoff.cjs receipt <ABS_RUN> <ABS_RECEIPT_JSON>` 保存結果。已排隊不代表模型已讀。
5. 最終回覆使用已保存正文，加上 prepare 回傳的 `finalEventLine`。監督收到短訊先執行 `supervise.cjs context RUN <eventId>`：已是 pending 就核對同 ID／雜湊後依原契約處理；回 `queued:true` 時先處理它指出的目前事件，決策後重掛 watcher（沒有活的 watcher 才掛，不掛第二個），排隊事件依序送到。佇列裡有較新的送驗時，`decision` 拒絕接受目前候選：目前送驗記 observe（原因寫「被排隊中的送驗 <id> 取代」），再處理那份送驗；佇列只有提問或阻塞時驗收照常，context 附它們的原文，接受時它們一併結案（`decision` 回 `closedWithAcceptance`），列進給使用者的收尾清單。最終回覆的明確 ID 還在佇列時視為鏡像略過，未知的明確 ID 改成 `protocol_error` 交監督，不讓 watcher 當掉。背景通知、原生通知及 transcript 重播只處理同一事件一次；已有 decision 就不再回訊。代答／退件後按上節保存 delivery、執行 decision，再重掛唯一桌面背景 watcher；全數驗收才 accept。

`STOP` 或 accepted 禁止新交接；不得移除 STOP、自動重啟已停止任務。既有 run 由原監督在 pending 已處理、舊 watcher 已退出的安全停點切換並告知原執行者；禁止外部直接改 live run。原生交接需要執行對話正在運作且具備可用原生傳訊工具；兩端皆被暫停、App 關閉、原生送訊拒絕或只有背景派工檢查事件時，仍不能保證自動恢復，必須據實回報，不能新增第三個模型輪詢者或週期 prompt。

`observe` 決策必須有非空 `reason`；不得含 `reply`、`delivery`、`revision` 或 `results`。任何決策都不得帶 `pendingApprovals`：待核准事項登記在[待決帳](#待決帳)，決策帶這欄會被拒（v0.25.1 前已處理的舊決策照舊有效）。`decision` 保存完整決策及雜湊、清除該 pending，不傳訊、不接受候選；完成後由原監督桌面對話重新掛唯一背景 watcher。範例：

```json
{"eventId":"原事件識別值","disposition":"observe","reason":"執行者只確認收到；正式主機 AI 金鑰付費使用已在待決帳 ai-key-billing，不需再回覆。"}
```

使用者之後提供核准時，先核對原話與操作範圍，用 `pending` 的 `answer` 結掉待決帳該項（授權類依[原契約、使用者修訂與舊 run 接入](#原契約使用者修訂與舊-run-接入)先登記修訂），再以新的唯一 `LONG_TASK_DELIVERY` 標記、原生桌面傳訊及讀回交給執行者，更新決策帳；不要修改已處理的 observe 決策。`STOP` 仍有最高優先，不自行清除或重啟。

決策檔已處理後，同一檔重查會回傳 `processed:true`；事後改動會被拒絕。背景工具停止、App 關閉或綁定檔損壞時停止宣稱即時監看，從既有狀態及 transcript 對帳後續接。

## 待決帳

要使用者決定的事登記在 `RUN/pending-decisions.json`，只經監督對話的 `supervise.cjs pending` 寫入（執行對話寫不進去）；背景程式、儀表板與狀態面板只讀。一份變更檔可含四種清單：

```json
{"raise":[{"key":"r24-r21-relogin","kind":"credential","ask":"R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？","recommend":"A 兩個都重登：你在兩個視窗各輸入一次信箱和驗證碼，約 2 小時跑完","why":"驗證碼只有你收得到；不重登就得縮小驗收","options":["A 兩個都重登","B 只重登 uat2","C 列已知缺口"]}],
 "reopen":[{"key":"jira-notice","fact":"通知對象從 3 人變成 12 人，超出原核准範圍"}],
 "withdraw":[{"key":"webhook-fix","reason":"修訂 AMEND-AUTH-OLD-R21-JIRA-FULLACCESS-20261011 的「代我回答所有執行對話」涵蓋，監督採根因修正"}],
 "answer":[{"key":"r24-r21-relogin","choice":"A","quote":"R24R21: A 兩個都重登"}]}
```

- `kind` 只能是 irreversible（不可逆）、paid（付費）、delete（刪除，測試中間產物除外）、credential（帳號或憑證）、external（對外發送）、prohibition（推翻禁令）、acceptance（改驗收條文）、user_action（要本人動手，例如切權限選單、重新登入、按只有本人能按的確認框）、major_change（上層規則要先確認的重大變更）；其他類程式拒收，由監督自己決定。kind 只是逼監督寫出為什麼要使用者決定，不代表程式能判斷該不該問。`ask`、`recommend`、`why` 必填，`options` 選填。
- 同一 key 再 raise 是更新原項；內容完全相同時不算變動，不會再出卡。已回答或已撤下的 key 用 `reopen` 附 `fact`（改變題目的新事實）才重開，舊答案留在 history。和任何一項（含已結項）問題文字相同的會被拒：未決的請更新那個 key，已結的請 reopen 它。去重靠固定 key 與 context 附的完整清單，換句話問同一件事要靠監督自己對清單。
- `answer` 的 `quote` 是本回合收到的使用者原話（本對話真人輸入或別的對話轉來，規則同 pause）；不是本回合的話，改附 `source:{path,sha256}`（允許根目錄內含這句原話的快照），或用已登記修訂的 `amendmentId`。`withdraw` 寫明為什麼監督能自己決定、依據哪份授權、修訂或事件（例如 `permission_changed` 的事件 ID）。整份變更任一項不合格就整份不寫。
- `supervise.cjs ask RUN` 回 `{items,new,repeat}`：`items` 是全部未決項，全部放進同一張選擇卡；`new` 是上次出卡後新增或改過的 key；`repeat:true` 表示全都列過且沒變，不再出卡。`ask` 只讀不記；出卡後執行 `supervise.cjs shown RUN <全部未決 key>`，key 必須正好是全部未決項（少列、多列、重複都拒絕），程式才把它們記為已列。只列子集就記不上，避免沒列到的項目從此被當成問過。
- `context` 與 `brief` 的 `pendingDecisions` 有 `open`（完整未決項）、`closed`（已答／已撤下的 key、問題與答案摘要）、`unpresented`（還沒列給使用者或列過後又改的 key）；檔案壞掉時附 `error`，先修復再登記。`監督儀表板.md` 的「待你決定」節與狀態面板顯示同一份未決清單。
- 舊版 run（v0.25.1 前開的）還沒有待決帳時，`pendingDecisions.legacy` 列出歷次決策 `pendingApprovals` 的原文：依決策帳與現況把仍待決的事以新格式登記一次（舊文字有的是全表、有的是增量，所以程式不自動匯入），都已解決時送 `{"raise":[]}`；登記後這段就不再出現。

## 派工檢查事件

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼在最終回覆的事件種類；執行端已完成的回覆先處理，沒有待結算的回覆時才做派工稽核。收到事件後先查快照與真實來源；在桌面原生送訊**緊接之前**執行事件提供的 `preflightArgv`（argv 陣列，不將含空白路徑直接拼成 shell）：

```text
node "<skill>/scripts/supervise.cjs" dispatch-preflight "<RUN>" "<EVENT_ID>"
```

只在 `current:true` 時送具體指示並照原協定保存 delivery、執行 decision。`current:false` 表示事件已過期，程式清除該 pending 並保留尚未處理的問題；不送訊、不為舊事件寫決策，重新掛 watcher。preflight 與桌面傳訊是兩個步驟，中間仍有狀態改變的時間窗，執行者收到後也須核對，不宣稱原子送達保證。監督只在需要處理事件或自己的進度時鐘到點時醒來（見[主動進度查核](#主動進度查核)），不以定時模型回合保活。

## 主動進度查核

監督有自己的進度時鐘，不以執行者宣告的等待為準：`waiting` 或 `progress` 加 `waitMinutes` 只是參考，到期仍另以 `continue` 喚醒。時鐘分層：背景程式每分鐘用程式確認工作有在動、在途包是否超過 AI 時程基準，每 30 分鐘在 `RUN/clock.jsonl` 留一筆查核紀錄（活動時間、各包經過／基準、發現的問題）；只有發現問題才輸出 `progress_review` 喚醒模型，`reasons` 標明原因：

- `executor_blocked`：執行者的前景指令發出 5 分鐘仍沒有結果、這段期間沒有任何指令跑完，程序清單裡也找不到它在跑，這只是可能卡住的線索。先核對執行 transcript 中真實的工具結果及上層授權；沒有明確拒絕不得推定需要本人處理。工具確實停在要本人確認的地方時，才用 `observe` 記錄拒絕原文與受阻動作，登記待決帳（`user_action`），請使用者到該執行對話按確認（附對話標題與要按的按鈕）；這是平台限定本人操作的例外，不請他打字。這時傳訊給執行者，它收不到。
- `machine_slept`：綁定後電腦睡眠 5 分鐘以上，例如用電池闔蓋，整場因此停住。監督請使用者接電源、不要闔蓋，並把停擺時長記進決策帳與驗收報告。綁定前的睡眠不算。
- `silence`：執行者、背景子代理（含 Dynamic workflows 派出的代理，紀錄在 `subagents/workflows/<runId>/`）與在跑的測試程序全部靜止 15 分鐘。測試程序是派工快照中非代理的在途包，以 evidence 檔（例如紀錄檔）的更新時間為準；透過資源帳本啟動、程序還活著的，即使不寫紀錄也算在動。
- `overdue`：在途工作包扣掉電腦睡眠後的經過時間達 AI 時程基準 1.5 倍時叫醒一次，達 3 倍再叫醒一次，不論該包是否仍有產出或程序還在跑（Jay 2026-10-13）。同一基準（`startedAt` 與執行端填的分鐘數）每一級最多通知一次；第一次看到就已超過 3 倍時只通知一次；執行端重估寫入新基準後，新基準重新計算 1.5 倍與 3 倍。限速中不叫醒，重置後再通知。處理方式見[單次事件處理](event-review.md)。子代理紀錄已顯示做完、只是派工快照沒更新的包不算落後，記為 `snapshot_stale`。
- `no_event_hour`：距離執行對話上一次真正事件（任何完成回合送出的 LONG_TASK_EVENT）已滿 1 小時，扣掉電腦睡眠；每段安靜期只問一次，新事件回來就重新計時。用途是抓「預估時長報得過長，超時永遠不會觸發」的情況，所以執行端看起來仍在動也照樣觸發。只剩等使用者核准（checked wait 的 kind 為 user_approval）或限速中不發。處理方式見[單次事件處理](event-review.md)。
- `baseline_missing`：在途工作包沒有基準時長；同一包只通知一次，請執行端補上。
- `process_stalled`：在跑的測試程序 15 分鐘沒有產出，而且查不到它還活著。例如故障演練依設計等待租約時，程序還在就不算停住。
- `resource_underused`：派工快照宣告的真實資源（主機排查名額、測試身分）還有空位，卻有就緒或受阻的工作在等同一個資源；監督評估能否並行，例如同一身分同時跑兩題、但同一題號不同時跑。
- `repeat`：同一條指令連續失敗 3 次；同一指令成功即清除它的失敗計數，處理過一次進度查核後重新計數。同一個 `nextAction` 連報兩次則直接成為 `stalled` 事件。
- `idle_with_work`：執行端與所有子代理都停了 5 分鐘（扣掉電腦睡眠；只有背景指令在跑也算停），派工快照卻還有未通過的驗收條件（FAIL／PENDING／INCONCLUSIVE）或就緒包。執行端只在輪詢背景（`TaskOutput`、`BashOutput`、只有 sleep 的 Bash 等）時也算停；真正下指令、改檔或思考都算活動。每段停頓通知一次，只剩等使用者核准時不發，事件附 `idleWithWork:{idleMinutes,openCriteria,readyPackages}`。監督核對後用 reply 請執行端把能並行的派出去（依驗收條件分線、查核與測試交子代理、批次派工），或說明為何只能依序；剩下的都只差使用者核准或外部結果時用 observe。這類事件不是 silence，observe 不需 wait。
- `unplanned_criteria`：快照 `acceptance.items` 中 FAIL／PENDING／INCONCLUSIVE 的條件，10 分鐘（扣掉電腦睡眠）沒有任何 ready／inFlight／blocked／returned 工作包用 `acceptanceIds` 標到它，執行端在忙也照樣觸發。同一組條件只通知一次，事件附 `unplannedCriteria:{criteria,freeCapacity,minutes}`，freeCapacity 是快照驗證過的子代理席位減在途包數。監督用 reply 逐條點名要派的工作包；只剩等使用者核准或暫停中不發，暫停解除後重新計時。
- `instruction_overdue`、`permission_review`、`permission_changed`、`automation_found`、`login_expired`、`rate_limit_reset`、`platform_error`、`executor_model`：見[下節](#指令期限權限模式排程登入限速儀表板與暫停)。

事件附 `pace`（每個在途包的開始時間、扣掉睡眠後的經過分鐘、睡眠分鐘、基準分鐘、比值、是否已做完、程序是否還活著、執行端與監督各自算的基準及是否差超過一半、子代理已輸出 token、最後活動時間、本場各模型實測每秒輸出 token）、`executorBlocked`、`machineSlept`、`overdue`、`baselineMissing`、`processStalled`、`resourceUnderused`、`failedCommands`、`declaredWaitMinutes`、各類最後活動時間與尚未確認的送達。`clock.jsonl` 每筆另列 `open`：當下仍未解決的問題，包括已通報過的，去重只決定要不要喚醒模型。等待到期的 `continue` 事件帶 `dueAt`（到期時間）與 `declaredAt`（宣告時間），`at` 是事件產生時間。

每次喚醒的模型回合都會重讀整段監督對話的快取（GDB 實測每次呼叫約 47.5 萬 token），所以處理步驟要少：① `supervise.cjs context RUN EVENT_ID` 一次取得事件、brief（監看狀態、各包速度、執行端最後幾段話、派工現況與最近決策）、授權來源與 event-review 規則，不逐檔探查，需要時再讀相關原始證據；② 同一個 Bash 先跑 `progress-preflight`（progress_review 事件）再寫決策並執行 `decision`；需回訊時在 preflight 後、decision 前送原生訊息；③ 同一則回覆並行送出背景 `claude-watch.cjs RUN` 與 `supervise.cjs status RUN --wait-active 10`（brief 的 `status.hold` 為 false 時，同一則回覆再加背景 `claude-hold.cjs RUN`，即 context 的 `holdArgv`）；④ 回報。

AI 時程基準＝預估輸出 token ÷ 本場同模型實測每秒輸出 token，加上已量測的工具時間（完整測試、部署等）。`scripts/pace.cjs status RUN` 列出在途包與基準；`pace.cjs estimate RUN --model <模型> [--tokens N] [--tool-minutes M]` 產生快照用的基準。本場同模型已完成的子代理少於 3 個時，用技能內建的實測預設值。不用人類開發經驗估時；執行端寫進派工快照的基準，監督以同一公式重算覆核，差超過一半先請執行端說明依據。

先核對實際工作：子代理是否仍在輸出、輸出速度、測試與程序紀錄。決策前執行 `supervise.cjs progress-preflight RUN EVENT_ID`：`silence`、`wait_changed` 類事件遇到執行對話的新活動即過期；`overdue`、`baseline_missing`、`process_stalled`、`repeat` 本來就是為忙碌中的執行者設計，仍核對對應問題，不因新活動過期；STOP 一律優先。落後、重複或證據不足時用 reply，附 progressCheck.evidence、finding、guidance；guidance 是已授權範圍內的具體加速建議，例如拆包並行、只跑受影響測試、停止重試改換做法、先收回整合已完成成果，實際原生訊息必須含 guidance。進度正常時用 observe，附 reason、progressCheck.evidence、finding，不傳訊、不打斷執行者；`silence` 類事件的 observe 仍須依下段保存 wait。

只剩已核對的等待時用 observe，填 reason、progressCheck.evidence、finding 及 `wait:{kind:"user_approval",conditions:[]}`；外部結果用 external_result，必須列允許根目錄內的條件檔 conditions:[{path,sha256}] 或有原訂期限來源的 resumeAt。尚未出現的結果檔 sha256 填 null，不自行新增期限。決策後重掛唯一背景 watcher；它繼續讀執行事件、使用者在監督對話的新答覆及條件檔，條件變動立即解除等待。監督自身的工具輸出或結束回合不解除等待，也不催促同一條未變核准。

**面板不替監督打字**：狀態面板 mod（`claude-code/plugins/lt-status`）只顯示監看狀態。它跑在監督對話自己的程序裡，對話被 App 暫停時它也一起停；2026-10-08 加的 3 分鐘代打字備援，遇上 3 次暫停 0 次觸發，另有 2 次在監督已在驗收時誤觸發，所以拿掉，改用開頭的保持載入消除暫停的原因。

**外部送訊**：觀察者或其他對話要傳訊給進行中的監督或執行對話時，只用會排隊的桌面原生傳訊。對方忙碌時會等它這輪結束才送達；直接插入的跨對話傳訊會中斷對方正在跑的工具呼叫。

背景接收須保持運作，不因減少模型回合停止監看；避免為 idle watcher 外包會定時殺掉接收器的 timeout 命令。使用當前 App 真正支援的長期背景工具及事件完成通知，核對 status.active。若平台強制終止背景工具，據實記錄失效與原生交接途徑，不能保證 App 內部的喚醒，不能另建定時模型 heartbeat 或改由 CLI 代替桌面主線。

## 原契約、使用者修訂與舊 run 接入

鎖定來源完成正式版本歸檔後，只有內容雜湊完全相同時可用 `supervise.cjs relocate-sources RUN INPUT.json` 登記精確搬移。輸入逐項綁定原絕對路徑、歸檔後絕對路徑與原 SHA-256；歸檔檔案必須位於 run 的允許根目錄。這只處理檔案搬移，不改契約內容、驗收條文或授權；不得用同名搜尋、未綁定候選或不同雜湊代替原來源。

先讀 [授權承接](authorization.md)，核對真實使用者原文。`supervise.cjs effective-contract RUN` 輸出原契約加已核准修訂的有效範圍、排除項、授權更新及 contractStateSha256。監督、執行、派工查核和最後接受都讀同一有效範圍。

在原監督的安全停點（無 pending、無 inflight、舊 watcher 與 dispatch writer 已退出，STOP/accepted/stopped 不改）用 `supervise.cjs amend RUN INPUT.json` 登記修訂。使用者的修訂與授權收到就登記，不等下一個事件，也不只存成檔案或寫在決策帳（那樣換 run 續接、壓縮後的程式與執行端授權表都讀不到）：正在處理事件時，在 `decision` 之後、重掛接收器之前登記；接收器在跑時，先用 TaskStop 停掉它、確認它的 PID 已退出（停掉時若剛交出事件，先處理該事件），立刻登記，再重掛唯一一個接收器；保持載入不是寫入者，不必停。登記後才把授權交給執行端，並用 `pending` 撤下被它解決的待決項。INPUT 含 id、原 contractSha256、authority:{role:"user",quote:"逐字原話",locator:"原對話訊息／文件位置",at:"來源時間",source:{path:"允許根目錄內的原文快照",sha256:"實算雜湊"}}、changes:[{id:"原條文ID",action:"exclude/replace/restore/add"}]。replace 另填完整 requirement、verify；add 新增條件，id 不得與既有條文重複，同樣必填 requirement、verify；授權更新用 action:"authorization"、固定 id、scope、instruction。代理提案不能冒填 role:user，來源檔須含原話，語意與操作範圍由監督實際查原對話核實。工具只檢查來源完整性，不能證明任意檔案作者真是使用者。

修訂另存不可改寫的 contract-amendments.jsonl，保留原 contract.json；遺失、變動、衝突皆先對帳，不清檔重置。接受決策必須帶當前 contractStateSha256，結果只對有效條文逐條 PASS；排除項明列 EXCLUDED 及核准來源，不能偽填 PASS。

### 換 run 續接同一任務

同一任務改由新 run 續接（Codex 長任務搬到 Claude、換監督或執行對話）時，`input.json` 不填 `contract`，改填 `inheritFrom:"<舊 run 絕對路徑>"`。`init` 原樣複製舊 run 的 `contract.json`、`contract-amendments.jsonl`、`source-relocations.json` 與 `pending-decisions.json`，逐項重算原契約來源與每筆修訂的使用者原文快照；任一份遺失、變動或不在 `allowedRoots` 內，一次列出全部問題並拒絕，不建新 run 目錄；舊 run 的接收器、派工寫入、契約更新或 Codex 的 run-watch 父程序仍在跑也拒絕。建立後新 run 的 contractStateSha256 與舊 run 相同，`binding.json`、`authorization` 附 `inheritedFrom`（來源 run、平台、修訂 ID、授權 ID），`init` 回 `inherited` 摘要；舊 run 原地保留，不改不刪。不要拿 `effective-contract` 的輸出重寫新契約：修訂的原話、定位與雜湊會消失，新 run 登記第一筆修訂後，寫進契約的授權也會被蓋掉，所以帶 `authorizationUpdates`、`excluded` 或 `contractStateSha256` 的 `contract` 會被拒。`inheritFrom` 只用於同一任務；新任務自建契約，不自動繼承舊任務的授權。登入清單不隨 `inheritFrom` 帶過來：換 run 前照 SKILL 啟動第 1 步重新預檢，`loginSites` 填這次實測的清單（2026-10-13 GDB 的 v117 run 沒有登入清單，整場沒有任何登入檢查）。

`inheritFrom` 只帶得走已登記的修訂與授權。init 之後、掛接收器之前（這時就是安全停點）依序：① 核對舊監督的決策帳與舊 run 目錄，舊版技能只存成檔案、沒登記的使用者授權（例如 `Jay*.md`、user-approval／user-update 檔），逐份回原對話核對原話後，在新 run 用 `amend`（action:"authorization"）補登，來源指向舊 run 的原文快照（2026-10-13 GDB 搬家只帶有效契約，漏了 6 份授權原文，新監督因此一直轉問使用者）；② 本次換 run 的使用者原話同樣登記；③ 承接來的待決帳若有已被授權解決的項目，用 `pending` 撤下；④ 再 `attach-acceptance`、掛接收器與保持載入，把 run 路徑交給執行者，要求它先讀 `supervise.cjs authorization RUN` 同步授權表。

舊 run 的結果帳用 `supervise.cjs attach-acceptance RUN ACCEPTANCE.json` 接入。原執行者準備目前實際候選與逐條狀態，涵蓋有效條文及 EXCLUDED 項；未測 PENDING，已跑但不足判定 INCONCLUSIVE，缺口 FAIL／BLOCKED，不能憑執行次數補成 PASS。工具保存結果歷史、保留既有派工快照與條文，最後才標記 acceptance 已接入。若已有歷史不得清空或覆蓋舊實測。

接入後原監督與執行者都讀回有效契約、摘要與新規則，再以原游標、pending、receipt 續接唯一 watcher；安裝檔案一致不代表現役已切換。不得由另一對話直接改 live run，也不自動清除 STOP。

## 指令期限、權限模式、排程、登入、限速、儀表板與暫停

以下都由背景程式不呼叫模型地查核，有問題才產生 `progress_review`；處理方式見[單次事件處理](event-review.md)。

- `instruction_overdue`：監督送出 reply／reject 後開始計時，期限是 decision 的 `instruction.deadlineMinutes`（1～240），沒填則 30 分鐘，扣掉電腦睡眠。期限內只要執行端有完成回合，或派工快照的 `updatedAt` 晚於送出時間，就算有動靜。逾時發第一次（`misses=1`），再過一個期限發第二次（`misses=2`），之後不再追這則。只差使用者核准期間不發逾時通知，但有動靜照樣結案，核准等待解除後不會把已完成的指示誤報為逾時。
- `permission_review`／`permission_changed`：從執行 transcript 讀權限模式（`permissionMode`）。是 `auto` 時開工通知一次；之後只有新的工作項目被自動模式分類器拒絕才再通知（同一程式與子指令，或同一工具，算同一項），事件附 `permission:{permissionMode,newRejections:[{item,reason,at}]}`。拒絕的判準是工具結果出現「Permission for this action was denied by the Claude Code auto mode classifier」；工具輸出只是引用到這段字（例如讀技能說明）不算。「auto mode cannot determine the safety … temporarily unavailable」是分類器暫時無法使用，不是拒絕，照常重試。背景程式從執行對話新進來的訊息列讀權限模式；使用者在該對話的權限選單切換後（不必打字），監督用原生跨對話傳訊送一則續接，請執行端重跑被擋的操作，這則訊息列就帶新模式。切成 `bypassPermissions` 後發一次 `permission_changed`。權限模式是使用者的安全設定，監督不得自行切換（使用者 2026-10-11 定案），處理見 [authorization.md](authorization.md#平台自動模式擋下操作時)。待實測：只切選單、由監督送的訊息列是否就帶執行端的新模式（2026-09-30 一次觀察：執行對話沒有真人輸入，監督送的訊息列已帶 `bypassPermissions`，但同列 `origin.fromMode` 是 bypass，是否受發送端模式影響尚未驗證）。
- `automation_found`：監督或執行對話出現 `turnOrigin=scheduled` 的回合（由排程送進來的）。scheduled-tasks 排程用工具設成停用（不刪除），並告訴使用者名稱與原因；對話內的 `/loop` 或 cron 沒有停用選項，只告訴使用者名稱與原因，由他決定是否停掉，監督不自行刪除。
- `login_expired`：`RUN/login-sites.json`（init 依 `loginSites` 寫入）列出本任務會用到的每個登入，格式 `{"sites":[…]}`，每筆是下列其一。網站：`{"name":"網站名","url":"https://…","loggedOutPattern":"登出時網址或標題會出現的正規式"}`，用 chrome-relay 在使用者已登入的 Chrome 另開背景分頁，讀落點網址與標題後只關閉該分頁。非瀏覽器的登入或權限（CLI／API token、ssh、MCP 授權、測試身分、chrome-relay 連線等）：`{"name":"名稱","check":"唯讀檢查指令"}`，在系統暫存目錄以 `/bin/sh -c` 執行，60 秒逾時，輸出一律丟棄、不寫進 run 目錄；結束碼 0＝有效、1＝已失效，其他（126／127 找不到指令、當掉、名稱打錯被攔下）或逾時＝檢查本身出錯（`error`），不當成登出。指令只讀狀態：不呼叫模型、不開登入視窗、不寫資料，也不把 token 寫在指令裡；用不會被管線吃掉錯誤的寫法，例如 `out=$(CLAUDE_CONFIG_DIR=$HOME/.gateway-uat-clients/uat2 claude mcp get gateway) || exit 3; case "$out" in *Connected*) exit 0;; *) exit 1;; esac`（Claude CLI 設定檔裡的 MCP 授權以 `claude mcp get` 判斷，2026-10-13 GDB 的 uat2／uat3 已驗證）。Codex MCP 的 OAuth 是否仍有效目前沒有唯讀檢查指令（`codex mcp list` 只顯示 `Auth: OAuth`，代表權杖存在、不代表有效），是已知缺口，不寫成 check、也不宣稱有在看。兩種都可加 `login`（失效時怎麼恢復，給執行端或使用者看）。開工預檢與清單有變動後跑 `node <installed-skill>/scripts/login-check.cjs DIR`（init 前 DIR 是準備目錄，之後是 RUN）：不受每小時限制、立刻全部實測，印出 `needsAction`；目錄或清單不存在、格式不對時印原因並以 2 結束。它逐筆依序檢查（網站每筆最久約 2.5 分鐘，指令每筆最多 60 秒），登入多時用背景 Bash 或加長 Bash 逾時。背景程式每小時再全部實測一次，結果寫入 `RUN/login-status.json`；同一個登入每進入一種失效狀態（`logged_out` 或 `error`）通知一次，狀態換了再通知，恢復有效後重新計算；事件的 `loggedOut` 每筆附 `status`、`detail` 與 `login`。執行端以 `question` 交來新的登入（名稱、唯讀檢查指令、失效時怎麼恢復）時，監督補進這個檔並跑一次 `login-check.cjs RUN`。檢查只偵測、通知，不會自動續期登入。平台自己帳號的錯誤（例如執行對話回合的 401 OAuth 過期）屬 `platform_error`，不列在這裡。
- `rate_limit_reset`／`platform_error`（平台錯誤回合，2026-10-14 定案）：Claude 自己的重試（`system` 列 `subtype=api_error`）用完後，以一筆錯誤列結束回合：assistant 列 `isApiErrorMessage`、`error`、`model=<synthetic>`、`stop_reason=stop_sequence`，不是 `end_turn`，所以不會成為 LONG_TASK_EVENT（2026-09-23～10-14 全機 55 筆：`authentication_failed` 34、`server_error` 11、`rate_limit` 7、`unknown` 3）。限速且文字寫明重置時間（「resets 3:40am (Asia/Taipei)」或每週的「resets Oct 5 at 8pm (Asia/Taipei)」）時，執行端或其子代理撞到都由背景程式記下重置時間；監督與執行端用同一帳號，監督也被限，所以限速期間不叫醒模型，silence、overdue 等計時暫停；到重置時間才發 `rate_limit_reset`，附 `rateLimit:{since,until,basis,text}`。執行端自己的紀錄在限速之後又有工作，等待就提前結束、不發 `rate_limit_reset`（2026-10-03 每一則寫明兩天後才重置的週限速，執行端都在 4～23 分鐘內恢復工作）。不換模型、不換帳號；桌面版同一帳號，改用 API key 會另外計費。其他錯誤（登入過期、連不到 API、伺服器錯誤、讀不到重置時間的限速，例如額度上限或「Server is temporarily limiting requests」）只看執行對話主線：錯誤後 2 分鐘（扣掉電腦睡眠）執行端沒有新的工作列，發一次 `platform_error`，附 `platformError:{who,since,kind,status,text}`；排隊訊息或背景工作通知常在 2 分鐘內先讓它恢復，恢復了就結案、不叫醒。同一筆錯誤只通知一次；限速中或只剩等使用者核准（checked wait 的 kind 為 user_approval）時不發；暫停解除後重新計 2 分鐘。子代理的非限速平台錯誤由執行端自己重派，不叫醒監督。
- `executor_model`：執行 transcript 的 assistant 列實際模型（`message.model`）不是 Opus，或推理（`effort`）低於 high（low、medium）時通知一次；使用者自己調高到 xhigh／max 不算。監督用 `mcp__ccd_session_mgmt__set_session_model` 與 `set_session_effort` 切換，從執行端下一回合生效；使用者明確指定的模型優先。子代理模型由 `lt-*` 子代理定義鎖定 Sonnet，不在此處理。
- `監督儀表板.md`：背景監看執行中每分鐘更新 `RUN/監督儀表板.md`，包括監看狀態、保持載入、執行對話權限、限速、平台錯誤、等待中的指示、逐條驗收、在途工作，以及用已通過條數推算的預估完成時間和算法。開工時監督用桌面工具把它開給使用者看（例如 `mcp__ccd_view__show_pane` 的 file 窗格或 `mcp__ccd_host__open_in_editor`），查看不會叫醒模型。Claude 監看在每個事件後結束、由監督重掛，所以背景監看停止期間不會更新。
- 暫停與停止：`supervise.cjs pause RUN "<使用者原話>"` 寫入 `PAUSED.json`。暫停期間不送時鐘與派工事件，執行對話交回的真正事件照常處理；`supervise.cjs resume RUN ["<使用者原話>"]` 解除暫停並重新起算各時鐘。pause 與 stop 都要附使用者原話，程式核對這句話出現在監督對話本回合的真人輸入（`origin.kind=human`）或別的對話轉來的訊息（`origin.kind=peer`）中；壓縮摘要列不算，不符就拒絕。
- 等監督裁決：執行端回報即使標成 `progress` 或 `waiting`，內容在等監督裁決、決定或回覆時，背景程式改當 `question` 交給監督。只剩等使用者核准（checked wait 的 kind 為 user_approval）時，不發 `no_event_hour` 和 `idle_with_work`。
- 線上狀態：使用者 10 分鐘內在監督對話有真人輸入，`brief.user.online` 為 true，`brief.user.lastInputAt` 是最後輸入時間。brief 另有 `paused`、`executor.settings{permissionMode,model,effort}`、`reviewRejections`、`instruction`、`rateLimit`、`platformError`、`automations`、儀表板路徑、`pendingDecisions`（見[待決帳](#待決帳)）與 `eventQueue`（排在 pending 後面的執行端事件）。
- 保持載入：Claude 桌面版不是按閒置時間卸載，而是在記憶體壓力下暫停沒有模型回合、也沒有背景指令在跑的對話（見開頭的 `claude-hold.cjs`）。保持載入是不呼叫模型的背景程序，不送保活回合。App 被關閉、電腦重開或對話被手動關掉時保持載入也會消失，只能在監督下次被喚醒時依 `status.hold` 補掛，這段期間不得稱持續監看；App 因同時開的對話數達上限而暫停對話時，是否也看背景指令，目前未實測。
- 壓縮：Claude 壓縮對話時，在同一份 transcript 寫入 `compact_boundary` 與 `isCompactSummary` 摘要列。摘要列不是送達證據、不是使用者新輸入，也不是 pause／stop 可用的原話；目前是否暫停、授權到哪裡，以 run 的 `PAUSED.json`、有效契約與決策帳為準。

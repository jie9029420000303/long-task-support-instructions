# 常用格式摘要

壓縮後只重讀這一頁（使用者 2026-10-29 定案）。這裡只收常用的格式與指令；規則以 SKILL.md 和各 references 為準，本頁沒寫到的才回頭讀原文件。`<skill>` 是已安裝技能的 `scripts` 目錄，`RUN` 是本 run 目錄。

## 執行端

- 最終回覆最後一行放事件（一次一行）：`LONG_TASK_EVENT {"kind":"progress","nextAction":"下一步具體工作"}`，或 `LONG_TASK_EVENT {"kind":"waiting","nextAction":"結果出來後要做的事","waitMinutes":15}`（1～120 分鐘；剩下的工作全部都要等背景結果時才用，會立刻交監督審查）。寫明下一步要直接續做時，先在原執行 Bash register `{"kind":"progress","nextAction":…}` 並用回傳的 event；沒登記的 `progress` 會立刻交監督。
- 提問、阻塞、送驗走原生交接：存 `EVENT.json`（`id` UUID、`kind`、完整正文 `text`，送驗另含 `candidate.cjs` 給的 `revision`、`manifest`）→ `node <skill>/handoff.cjs prepare RUN <EVENT.json>` → 回 `ready:true` 或 `queued:true` 時用原生傳訊送 `targetDesktopId`、`message` 一次 → `handoff.cjs receipt RUN <收據檔>` → 最終回覆加 `finalEventLine`。
- 送驗清單：`node <skill>/candidate.cjs <新版清單絕對路徑> <候選檔>...`。
- 一般結果與可自行處理的失敗先回執行主線，完成通知＋定期讀狀態補漏並存，倒數不是最早續接時間；依[執行層完成通知](execution-wake.md)登記工作包資源或 `waitFor:[{"ledger":"/允許根目錄/resources.json","id":"r1"}]`。在原執行 Bash 跑 `node <skill>/execution-watch.cjs register RUN <等待輸入JSON>`，只在 watcherAlive=false 時背景啟動回傳的 watchArgv；最終事件使用回傳的 event。收到 `LONG_TASK_EXECUTION_RESUME:<UUID>` 先讀 state 檔、跑 `execution-watch.cjs receipt RUN UUID`，再核對原始結果與續做。

- 工作包檔 `<狀態目錄>/wp/<id>.md`：`[工作包] id=WP-X；依賴：WP-Y`、`[狀態] {"list":"inFlight","handle":"agent:<id>","baseline":{"minutes":20,"startedAt":"<ISO 時間>","basis":"pace.cjs 估算"}}`、`[驗收條目] A1、A2`、`[共用資源] 帳號:… 瀏覽器:…`。文件工作包在狀態加 `"doc":true`；主線自己做的包 `handle` 寫 `main`。
- 改狀態：`node <skill>/dispatch.cjs mark RUN <狀態目錄> WP-X '<狀態 JSON>'`；派出時加 `--estimate <模型>[:<預估輸出 token>[:<工具分鐘>]]`，同一步填好 `baseline`，不另跑 `pace.cjs estimate`。同時交回多包用一次 `collect RUN <狀態目錄> WP-A <結果A> WP-B <結果B>`。
- 收包（一步完成標記、證據、驗收表與快照，先驗格式，有錯什麼都不寫）：`node <skill>/dispatch.cjs collect RUN <狀態目錄> WP-X <結果檔絕對路徑>`，結果檔 `{"status":{"list":"completed","handle":"agent:<id>","evidence":["/絕對路徑"]},"acceptance":[{"id":"A1","status":"PASS","evidence":["/絕對路徑"]}]}`。
- 子代理一交回就收包、補派下一包；等子代理時先做紀錄或準備下一包，介面定好後可平行的包同時派。
- 收包、啟動長測試或等待前，也從全部未完成條件與最新指示找尚未拆包的工作；核對授權、依賴與資源後可派即派，不能並行記理由。使用支援 `#` 註解的 shell 時，實際長測試呼叫的第一個非空行寫 `# LONG_TASK_LONG_TEST`，下一行才執行原指令；它只是監督查核線索，不輸出指令內容。工具或 shell 不支援時照原方式執行、未辨識視為未知；平台審查拒絕時不得以刪標記或換路徑、工具重試繞過。
- 開發與真實環境測試期間只出中途候選：以 commit 部署到已授權環境、只跑受影響範圍的測試，不合併發版分支、不打版號、不發 Release；不擋後續情境的缺陷先收清單、同一場走完一次修；定版由監督判定，定版後才正式發版、部署定版並重驗受影響項目（產品要靠版本字串辨識新舊時用預發行版本字串）。
- 開發中只記事實紀錄（改了什麼、commit 或版號、部署讀回值），不寫文件；帶版本內容的文件（手冊、發版說明、證據索引、授權依據清單、執行單與數值卡）定版前列 blocked（kind `dependency`，等定版），定版後依最終結果一次寫；空席依序給測試、查核與下一批實作。
- 主線只調度：預估超過 5 分鐘的測試、要讀回大量輸出的查核與證據整理派子代理；正式主機與現場電腦的部署留主線，輸出寫進檔案、只讀摘要。
- 文件時間預算（派工快照 `docBudget`）：`{"startedAt":"<ISO 時間>","devMinutes":76,"minutes":114,"basis":"開發 76 分鐘 × 1.5","estimate":[{"item":"說明 .md","minutes":40},{"item":"Archify 流程圖與圖片檢查","minutes":60}]}`。開寫前逐項估時；只算真正在寫文件的時間。
- 可撤回、自己有推薦的執行細節不等監督答覆：照推薦先做並繼續其他工作，回合結束時補報做了什麼與改回方法；改驗收、刪除或永久改動既有資料、未授權的付費／帳號密碼／正式部署、改寫 Git 歷史、非測試的正式對外發送不適用，只停該動作，等待期間做監督點名的其他工作。

- 新定案登記、壓縮續接、收包及等待前，用 `dispatch.cjs reconcile RUN` 核對有效決策、可派包與前置；核對後在原 mark／collect／from-wp 命令加 `--reviewed "核對依據與結果"`。未定案討論不改既有派工原則，真實阻塞只停該動作。
- `capacity.verified` 記實際總席位；已有節流用 `capacity.throttle:{limit,reason,evidence,reviewWhen}` 另記，沿用限制數字及來源，不自行改設定。
- 受阻只限四種，`kind` 寫 `dependency`／`external`（前置結果還沒出來）、`user`（要使用者本人）、`resource_conflict`（資源被占用）、`time`（條文明定要真等的時長），evidence 寫具體原因；排在後面不算受阻，列 ready 或拆準備包。宣告等待或說沒有可並行工作前，逐包列出原因與已派的準備包。
- 時間條件（排程、間隔、逾時、到期、N 天）直接觸發或縮短時間驗，週期至少看到兩次，正式值用設定讀回或自動化測試確認；只有條文明定觀察時長才真等；不自行排「幾點以後」。
- 時間取系統時鐘（同一步 `TZ=Asia/Taipei date '+%F %T'`），不推估、不寫 05:5x；時間欄位用含時區的 ISO（例如 `2026-11-10T12:30:00+08:00`），不能晚於現在。

## 監督

- 處理事件：`node <skill>/supervise.cjs context RUN <事件 ID>`，決策寫到它給的 `decisionPath`；reply／reject 傳訊前先依 runtime 執行只讀 `decision-preflight`，核對同一事件、契約／授權及待送內容，通過後才用原生工具傳送、記回執，再跑 `supervise.cjs decision RUN <決策檔>`。預檢不是平台層傳訊強制閘。
- 決策檔（`eventId` 與事件相同）：
  - 代答或退件：`{"eventId":"…","disposition":"reply","reply":"具體指示","instruction":{"what":"…","doneWhen":"…","deadlineMinutes":30}}`；退件把 disposition 換成 `reject`。
  - 記錄後繼續：`{"eventId":"…","disposition":"observe","reason":"…"}`。進度查核另加 `"progressCheck":{"evidence":["查了什麼"],"finding":"結論"}`；靜默類只剩已知等待時再加 `"wait":{"kind":"user_approval","conditions":[]}`（外部結果用 `external_result`，附條件檔或 `resumeAt`）。
  - 進度查核要執行端動作：`disposition` 用 `reply`，`progressCheck` 加 `guidance`，`reply` 要包含這句 guidance。
  - 驗收：`{"eventId":"…","disposition":"accept","revision":"sha256:…","contractStateSha256":"<有修訂時必填>","results":[{"id":"A1","status":"PASS","method":"…","expected":"…","actual":"…","evidence":[{"path":"/絕對路徑","sha256":"…"}]}]}`，每條驗收都要列。
- 所有進度事件均核對 `brief.agentActivity`、未完成條件、最新指示、未拆工作及真實依賴／資源；`parallel_test_review` 是一次長測試呼叫線索，代理來源未知、空快照、零代理或主線在跑都不單獨判違規。只交辦可隔離的工作；無可做或已結束就記依據，維持原測試範圍。
- 有推薦且在本案授權範圍內、不受禁令或適用專案規則限制時就照推薦直接回覆執行端；只有推薦的那條路本身要改驗收條件、刪除或永久改動既有資料，或碰到開工時沒授權或超出上限的付費、帳號密碼、正式部署，以及改寫 Git 歷史、寄信與對客戶或公開的正式發送、推翻使用者禁令、使用者自設的核准關卡、本人須到場或動手或只有他知道的事實、沒有明確推薦的超出契約目標或範圍的變更（有明確推薦時照推薦，用 `delegate` 登記、不等使用者），或本案有效授權、禁令及適用專案規則明寫監督不得代確認，才登記待決帳問使用者；契約範圍內的其他事依規格代決，用 `delegate` 登記後直接回覆。
- 待決帳：`supervise.cjs pending RUN <變更檔>`，變更檔 `{"raise":[{"key":"k","kind":"acceptance","ask":"…","recommend":"…","why":"…","options":["…"]}],"reopen":[{"key":"k","fact":"新事實"}],"withdraw":[{"key":"k","reason":"…"}],"answer":[{"key":"k","choice":"A","quote":"使用者原話"}],"delegate":[{"key":"k","ask":"…","choice":"監督的選擇","basis":"契約條文或選擇原則","revert":"怎麼改回"}]}`。kind：irreversible、paid、delete、credential、external、prohibition、acceptance、user_action、major_change、gate；代決的 kind 選填。
- 問使用者：`supervise.cjs ask RUN`，把全部未決項寫在同一則，先前已列而未答的可簡述題意、推薦與後果；背景事件沒有新進展或新決定時不重問，回合結尾只用一句話說明仍在監看或等待。出卡的同回合跑 `supervise.cjs shown RUN <全部 key>`（背景程式還沒推過的題目一併推到小秘書；背景程式在監督處理完事件後也會自己推）。`brief.questionPush` 不是 null 時，下一則給使用者的回覆先說推播沒送出。
- 授權或驗收修訂：`supervise.cjs amend RUN <檔>`，檔案 `{"id":"AMEND-…","contractSha256":"<binding 裡的值>","authority":{"role":"user","quote":"原話","locator":"訊息位置","at":"<含時區的 ISO 時間，例如 2026-11-10T08:48:00+08:00>"},"changes":[{"action":"authorization","id":"…","scope":"…","instruction":"…"}],"pendingKeys":["k"]}`；`changes` 另有 add、replace、exclude、restore。原文快照依 authorization.md。
- 每次決策後重掛唯一的背景接收器 `claude-watch.cjs RUN`（沒有活的才掛），結束回合前 `supervise.cjs status RUN` 的 `active` 要是 true。
- 時間：用 `brief.now`、`status.nowTaipei` 或同一步的 `TZ=Asia/Taipei date`；amend 的 `authority.at` 要含時區的完整 ISO 時間、不晚於現在，否則程式拒收。指令輸出前面的語系警告不要當成結果。
- `all_blocked` 或 `brief.allBlocked` 不是 null：逐包核對受阻四種原因，排在後面的請改 ready、拆準備包並當輪派出；不接受籠統的「沒有可並行工作」。
- 時間條件用直接觸發或縮短時間驗（監督代決，不問使用者）；不自排「幾點以後」；驗收收尾附上線後觀察清單。
- 候選版與定版：執行端為中途候選發正式版時請它改以 commit 部署；真實環境情境在同一個候選走完一輪、沒有要改程式的新缺陷與未決新需求時，用 reply 通知定版；定版後才跑整套、正式發版與寫帶版本內容的文件，候選上的真實環境結果依影響清單沿用，契約寫明同一版本的項目照條文在定版後做。
- 登記要問使用者的事時，同一則回覆點名執行端接著做的不相關工作；等使用者核准的 wait 填 `"dependsOn":[{"id":"條文 ID","pendingKey":"待決 key","reason":"為何依賴"}]`，涵蓋每個未通過條文且沒有可派工作包，才會靜音閒置與整點提醒。

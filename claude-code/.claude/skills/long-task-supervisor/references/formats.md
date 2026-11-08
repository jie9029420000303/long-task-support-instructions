# 常用格式摘要

壓縮後只重讀這一頁（使用者 2026-10-29 定案）。這裡只收常用的格式與指令；規則以 SKILL.md 和各 references 為準，本頁沒寫到的才回頭讀原文件。`<skill>` 是已安裝技能的 `scripts` 目錄，`RUN` 是本 run 目錄。

## 執行端

- 最終回覆最後一行放事件（一次一行）：`LONG_TASK_EVENT {"kind":"progress","nextAction":"下一步具體工作"}`，或 `LONG_TASK_EVENT {"kind":"waiting","nextAction":"結果出來後要做的事","waitMinutes":15}`（1～120 分鐘；剩下的工作全部都要等背景結果時才用，會立刻交監督審查）。寫明下一步要直接續做時，先在原執行 Bash register `{"kind":"progress","nextAction":…}` 並用回傳的 event；沒登記的 `progress` 會立刻交監督。
- 提問、阻塞、送驗走原生交接：存 `EVENT.json`（`id` UUID、`kind`、完整正文 `text`，送驗另含 `candidate.cjs` 給的 `revision`、`manifest`）→ `node <skill>/handoff.cjs prepare RUN <EVENT.json>` → 回 `ready:true` 或 `queued:true` 時用原生傳訊送 `targetDesktopId`、`message` 一次 → `handoff.cjs receipt RUN <收據檔>` → 最終回覆加 `finalEventLine`。
- 送驗清單：`node <skill>/candidate.cjs <新版清單絕對路徑> <候選檔>...`。
- 一般結果與可自行處理的失敗先回執行主線，完成通知＋定期讀狀態補漏並存，倒數不是最早續接時間；依[執行層完成通知](execution-wake.md)登記工作包資源或 `waitFor:[{"ledger":"/允許根目錄/resources.json","id":"r1"}]`。在原執行 Bash 跑 `node <skill>/execution-watch.cjs register RUN <等待輸入JSON>`，只在 watcherAlive=false 時背景啟動回傳的 watchArgv；最終事件使用回傳的 event。收到 `LONG_TASK_EXECUTION_RESUME:<UUID>` 先讀 state 檔、跑 `execution-watch.cjs receipt RUN UUID`，再核對原始結果與續做。

- 工作包檔 `<狀態目錄>/wp/<id>.md`：`[工作包] id=WP-X；依賴：WP-Y`、`[狀態] {"list":"inFlight","handle":"agent:<id>","baseline":{"minutes":20,"startedAt":"<ISO 時間>","basis":"pace.cjs 估算"}}`、`[驗收條目] A1、A2`、`[共用資源] 帳號:… 瀏覽器:…`。文件工作包在狀態加 `"doc":true`；主線自己做的包 `handle` 寫 `main`。
- 改狀態：`node <skill>/dispatch.cjs mark RUN <狀態目錄> WP-X '<狀態 JSON>'`。
- 收包（一步完成標記、證據、驗收表與快照，先驗格式，有錯什麼都不寫）：`node <skill>/dispatch.cjs collect RUN <狀態目錄> WP-X <結果檔絕對路徑>`，結果檔 `{"status":{"list":"completed","handle":"agent:<id>","evidence":["/絕對路徑"]},"acceptance":[{"id":"A1","status":"PASS","evidence":["/絕對路徑"]}]}`。
- 子代理一交回就收包、補派下一包；等子代理時先做紀錄或準備下一包，介面定好後可平行的包同時派。
- 收包、啟動長測試或等待前，也從全部未完成條件與最新指示找尚未拆包的工作；核對授權、依賴與資源後可派即派，不能並行記理由。使用支援 `#` 註解的 shell 時，實際長測試呼叫的第一個非空行寫 `# LONG_TASK_LONG_TEST`，下一行才執行原指令；它只是監督查核線索，不輸出指令內容。工具或 shell 不支援時照原方式執行、未辨識視為未知；平台審查拒絕時不得以刪標記或換路徑、工具重試繞過。
- 開發中只記事實紀錄（改了什麼、版號、部署讀回值），不寫文件；全部非文件驗收通過後，依最終結果一次寫文件。
- 文件時間預算（派工快照 `docBudget`）：`{"startedAt":"<ISO 時間>","devMinutes":76,"minutes":114,"basis":"開發 76 分鐘 × 1.5","estimate":[{"item":"說明 .md","minutes":40},{"item":"Archify 流程圖與圖片檢查","minutes":60}]}`。開寫前逐項估時；只算真正在寫文件的時間。
- 提問 30 分鐘沒人答：可撤回的執行細節照自己的推薦做、事後補報；改驗收、刪除或永久改動既有資料、未授權的付費／帳號密碼／正式部署、改寫 Git 歷史、非測試的正式對外發送不適用，繼續等並先做別的。

- 新定案登記、壓縮續接、收包及等待前，用 `dispatch.cjs reconcile RUN` 核對有效決策、可派包與前置；核對後在原 mark／collect／from-wp 命令加 `--reviewed "核對依據與結果"`。未定案討論不改既有派工原則，真實阻塞只停該動作。
- `capacity.verified` 記實際總席位；已有節流用 `capacity.throttle:{limit,reason,evidence,reviewWhen}` 另記，沿用限制數字及來源，不自行改設定。

## 監督

- 處理事件：`node <skill>/supervise.cjs context RUN <事件 ID>`，決策寫到它給的 `decisionPath`；reply／reject 傳訊前先依 runtime 執行只讀 `decision-preflight`，核對同一事件、契約／授權及待送內容，通過後才用原生工具傳送、記回執，再跑 `supervise.cjs decision RUN <決策檔>`。預檢不是平台層傳訊強制閘。
- 決策檔（`eventId` 與事件相同）：
  - 代答或退件：`{"eventId":"…","disposition":"reply","reply":"具體指示","instruction":{"what":"…","doneWhen":"…","deadlineMinutes":30}}`；退件把 disposition 換成 `reject`。
  - 記錄後繼續：`{"eventId":"…","disposition":"observe","reason":"…"}`。進度查核另加 `"progressCheck":{"evidence":["查了什麼"],"finding":"結論"}`；靜默類只剩已知等待時再加 `"wait":{"kind":"user_approval","conditions":[]}`（外部結果用 `external_result`，附條件檔或 `resumeAt`）。
  - 進度查核要執行端動作：`disposition` 用 `reply`，`progressCheck` 加 `guidance`，`reply` 要包含這句 guidance。
  - 驗收：`{"eventId":"…","disposition":"accept","revision":"sha256:…","contractStateSha256":"<有修訂時必填>","results":[{"id":"A1","status":"PASS","method":"…","expected":"…","actual":"…","evidence":[{"path":"/絕對路徑","sha256":"…"}]}]}`，每條驗收都要列。
- 所有進度事件均核對 `brief.agentActivity`、未完成條件、最新指示、未拆工作及真實依賴／資源；`parallel_test_review` 是一次長測試呼叫線索，代理來源未知、空快照、零代理或主線在跑都不單獨判違規。只交辦可隔離的工作；無可做或已結束就記依據，維持原測試範圍。
- 有推薦且在本案授權範圍內、不受禁令或適用專案規則限制時就照推薦直接回覆執行端；只有推薦的那條路本身要改驗收條件、刪除或永久改動既有資料，或碰到開工時沒授權的付費、帳號密碼、正式部署，以及改寫 Git 歷史、非測試的正式對外發送、推翻使用者禁令、本人須動手，或實際適用規則須先確認的重大內容／設計／資訊架構變更，或本案有效授權與專案規則要求確認時，才登記待決帳問使用者。既定目標與授權內的技術路線由監督依使用者禁令及專案既有授權自行比較、測試並判定。
- 待決帳：`supervise.cjs pending RUN <變更檔>`，變更檔 `{"raise":[{"key":"k","kind":"acceptance","ask":"…","recommend":"…","why":"…","options":["…"]}],"reopen":[{"key":"k","fact":"新事實"}],"withdraw":[{"key":"k","reason":"…"}],"answer":[{"key":"k","choice":"A","quote":"使用者原話"}]}`。kind：irreversible、paid、delete、credential、external、prohibition、acceptance、user_action、major_change。
- 問使用者：`supervise.cjs ask RUN`，把全部未決項寫在同一則，先前已列而未答的可簡述題意、推薦與後果；背景事件沒有新進展或新決定時不重問，回合結尾只用一句話說明仍在監看或等待。出卡的同回合跑 `supervise.cjs shown RUN <全部 key>`（程式同時用小秘書推播一則）。
- 授權或驗收修訂：`supervise.cjs amend RUN <檔>`，檔案 `{"id":"AMEND-…","contractSha256":"<binding 裡的值>","authority":{"role":"user","quote":"原話","locator":"訊息位置","at":"<ISO 時間>"},"changes":[{"action":"authorization","id":"…","scope":"…","instruction":"…"}],"pendingKeys":["k"]}`；`changes` 另有 add、replace、exclude、restore。原文快照依 authorization.md。
- 每次決策後重掛唯一的背景接收器 `claude-watch.cjs RUN`（沒有活的才掛），結束回合前 `supervise.cjs status RUN` 的 `active` 要是 true。

# 常用格式摘要

壓縮後只重讀這一頁（使用者 2026-10-29 定案）。這裡只收常用的格式與指令；規則以 SKILL.md 和各 references 為準，本頁沒寫到的才回頭讀原文件。`<skill>` 是已安裝技能的 `scripts` 目錄，`RUN` 是本 run 目錄。

## 執行端

- 最終回覆最後一行放事件（一次一行）：
  - `LONG_TASK_EVENT {"kind":"progress","nextAction":"下一步具體工作"}`
  - `LONG_TASK_EVENT {"kind":"waiting","nextAction":"結果出來後要做的事","waitMinutes":15}`（1～120 分鐘；剩下的工作全部都要等背景結果時才用，會立刻交監督審查）
  - `LONG_TASK_EVENT {"kind":"question"}`、`LONG_TASK_EVENT {"kind":"blocked"}`
  - 送驗：`node <skill>/candidate.cjs <新版清單絕對路徑> <候選檔>...`，把它印出的 submission 行原樣貼上。
- `progress` 一律立即續接，附 `waitMinutes` 也不等待。一般結果與可自行處理的失敗先回執行主線，完成通知＋定期讀狀態補漏並存，倒數不是最早續接時間；依[執行層完成通知](execution-wake.md)用工作包資源或 `waitFor:[{"ledger":"/允許根目錄/resources.json","id":"r1"}]` 登記。

- 工作包檔 `<狀態目錄>/wp/<id>.md`：`[工作包] id=WP-X；依賴：WP-Y`、`[狀態] {"list":"inFlight","handle":"agent:<id>","baseline":{"minutes":20,"startedAt":"<ISO 時間>","basis":"pace.cjs 估算"}}`、`[驗收條目] A1、A2`、`[共用資源] 帳號:… 瀏覽器:…`。文件工作包在狀態加 `"doc":true`；主線自己做的包 `handle` 寫 `main`。
- 改狀態：`node <skill>/dispatch.cjs mark RUN <狀態目錄> WP-X '<狀態 JSON>'`。
- 收包（一步完成標記、證據、驗收表與快照，先驗格式，有錯什麼都不寫）：`node <skill>/dispatch.cjs collect RUN <狀態目錄> WP-X <結果檔絕對路徑>`，結果檔 `{"status":{"list":"completed","handle":"agent:<id>","evidence":["/絕對路徑"]},"acceptance":[{"id":"A1","status":"PASS","evidence":["/絕對路徑"]}]}`。
- 新定案登記、壓縮續接及收包後，用 `node <skill>/dispatch.cjs reconcile RUN` 對照有效決策、可派包、已完成的前置與未分派條件；核對後在原 mark／collect／from-wp 命令加 `--reviewed "核對依據與結果"`，不另寫一份帳。未定案討論不改目標、授權、驗收或積極派工原則；只停確實受阻的動作。
- 容量：`capacity.verified` 只記核實的總子代理席位；已有暫時節流另記 `capacity.throttle:{limit,reason,evidence,reviewWhen}`，不改平台或本機設定，不自行新增／放寬數值限制。收包與條件變更時重新核對節流依據。
- 子代理一交回就收包、補派下一包；長測試或等待前也查全部未完成項與最新指示，能隔離且依賴已滿足的先派，不能並行記理由。受監督的 shell 長測試，在支援註解的 shell 中須於原指令前加獨立一行 `# LONG_TASK_LONG_TEST` 再接原指令；不支援註解的 shell 照原方式執行，缺標記不阻止測試，也不代表沒有長測試。平台拒絕的命令不可藉刪標記、換工具或路徑繞過。現役舊 run 的格式摘要不會自動更新，應於安全時點核對後合併該任務相關的新指引，不整份覆蓋既有摘要。
- 開發中只記事實紀錄（改了什麼、版號、部署讀回值），不寫文件；全部非文件驗收通過後，依最終結果一次寫文件。
- 文件時間預算（派工快照 `docBudget`）：`{"startedAt":"<ISO 時間>","devMinutes":76,"minutes":114,"basis":"開發 76 分鐘 × 1.5","estimate":[{"item":"說明 .md","minutes":40},{"item":"Archify 流程圖與圖片檢查","minutes":60}]}`。開寫前逐項估時；只算真正在寫文件的時間。
- 提問 30 分鐘沒人答：可撤回的執行細節照自己的推薦做、事後補報；改驗收、刪除或永久改動既有資料、未授權的付費／帳號密碼／正式部署、改寫 Git 歷史、非測試的正式對外發送不適用，繼續等並先做別的。
- 受阻只限四種，`kind` 寫 `dependency`／`external`（前置結果還沒出來）、`user`（要使用者本人）、`resource_conflict`（資源被占用）、`time`（條文明定要真等的時長），evidence 寫具體原因；排在後面不算受阻，列 ready 或拆準備包。宣告等待或說沒有可並行工作前，逐包列出原因與已派的準備包。
- 時間條件（排程、間隔、逾時、到期、N 天）直接觸發或縮短時間驗，週期至少看到兩次，正式值用設定讀回或自動化測試確認；只有條文明定觀察時長才真等；不自行排「幾點以後」。
- 時間取系統時鐘（同一步 `TZ=Asia/Taipei date '+%F %T'`），不推估、不寫 05:5x；時間欄位用含時區的 ISO（例如 `2026-11-10T12:30:00+08:00`），不能晚於現在。

## 監督

- 每個回合第一步（背景程式要求一句話結束回合的短訊除外）：用可回傳 session ID 的背景命令單獨跑 `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node <skill>/run-watch.cjs RUN`（不加 `cd`、分號、`&&` 或管線，工作目錄用工具參數）。印 `alreadyRunning` 是監看在跑；印 `ended` 是 run 已結束，不重掛；沒有立即結束就是已重掛或接管了留下的監看，這個 session 不要結束（見 runtime「監看中斷」）。
- 處理事件：`node <skill>/supervise.cjs context RUN <事件 ID>`，決策寫到它給的 `decisionPath`，寫完跑 `supervise.cjs decision RUN <決策檔>`，通過才結束回合；已有答案先提交、確認送達，再處理延展討論。只有模型輸出、沒有決策不算處理完。
- 決策檔（`eventId` 與事件相同）：
  - 代答或退件：`{"eventId":"…","disposition":"reply","reply":"具體指示","instruction":{"what":"…","doneWhen":"…","deadlineMinutes":30}}`；退件把 disposition 換成 `reject`。
  - 記錄後繼續：`{"eventId":"…","disposition":"observe","reason":"…"}`。進度查核另加 `"progressCheck":{"evidence":["查了什麼"],"finding":"結論"}`；靜默類只剩已知等待時再加 `"wait":{"kind":"user_approval","conditions":[]}`（外部結果用 `external_result`，附條件檔或 `resumeAt`）。
  - 進度查核要執行端動作：`disposition` 用 `reply`，`progressCheck` 加 `guidance`，`reply` 要包含這句 guidance。
- 進度查核不只看主線是否在動；一併看 `brief.agentActivity` 的實際活動線索、未驗收項、最新指示及未拆工作，核對依賴與排他資源。來源不完整或空清單不等於零代理；長測試線索也不等於違規或必須重跑全套。
  - 驗收：`{"eventId":"…","disposition":"accept","revision":"sha256:…","contractStateSha256":"<有修訂時必填>","results":[{"id":"A1","status":"PASS","method":"…","expected":"…","actual":"…","evidence":[{"path":"/絕對路徑","sha256":"…"}]}]}`，每條驗收都要列。
- 有推薦且在本案授權範圍內、不受禁令或適用專案規則限制時就照推薦直接回覆執行端；只有推薦的那條路本身要改驗收條件、刪除或永久改動既有資料，或碰到開工時沒授權或超出上限的付費、帳號密碼、正式部署，以及改寫 Git 歷史、寄信與對客戶或公開的正式發送、推翻使用者禁令、使用者自設的核准關卡、本人須到場或動手或只有他知道的事實、超出契約目標或範圍的變更，或本案有效授權、禁令及適用專案規則明寫監督不得代確認，才登記待決帳問使用者；契約範圍內的其他事依規格代決，用 `delegate` 登記後直接回覆。
- 待決帳：`supervise.cjs pending RUN <變更檔>`，變更檔 `{"raise":[{"key":"k","kind":"acceptance","ask":"…","recommend":"…","why":"…","options":["…"]}],"reopen":[{"key":"k","fact":"新事實"}],"withdraw":[{"key":"k","reason":"…"}],"answer":[{"key":"k","choice":"A","quote":"使用者原話"}],"delegate":[{"key":"k","ask":"…","choice":"監督的選擇","basis":"契約條文或選擇原則","revert":"怎麼改回"}]}`。kind：irreversible、paid、delete、credential、external、prohibition、acceptance、user_action、major_change、gate；代決的 kind 選填。
- 問使用者：`supervise.cjs ask RUN`，把全部未決項寫在同一則，先前已列而未答的可簡述題意、推薦與後果；列出當回合跑 `supervise.cjs shown RUN <全部 key>`（背景程式還沒推過的題目一併推到小秘書；背景程式在監督處理完事件後也會自己推）。`brief.questionPush` 不是 null 時，下一則給使用者的回覆先說推播沒送出。背景事件沒有新進展或新決定時不重問，回合結尾只用一句話說明仍在監看或等待。
- 授權或驗收修訂：`supervise.cjs amend RUN <檔>`，檔案 `{"id":"AMEND-…","contractSha256":"<binding 裡的值>","authority":{"role":"user","quote":"原話","locator":"訊息位置","at":"<含時區的 ISO 時間，例如 2026-11-10T08:48:00+08:00>"},"changes":[{"action":"authorization","id":"…","scope":"…","instruction":"…"}],"pendingKeys":["k"]}`；`changes` 另有 add、replace、exclude、restore。原文快照依 authorization.md。監看在跑時直接跑、不停監看；回 `queued` 就等本對話的 `LONG_TASK_AMEND_RECORDED` 再交主線，收到 `LONG_TASK_AMEND_FAILED` 就修正輸入後重跑。
- 每個回合結束前：`supervise.cjs status RUN` 的 `active` 為 true 才可稱監看啟動；`watch.orphaned` 為 true 就跑 `watch.remountCommand` 接管；同時看 `pendingDecision` 是否仍有漏交決策，先處理原事件；若狀態不明，先核對 PID、心跳與收件，不另行手動重掛，其他已授權工作繼續。新 run 尚未啟動過時先核對無舊程序與鎖，再依啟動步驟首次啟動（見 runtime「監看中斷」）。
- 收到 `LONG_TASK_WATCH_RECOVERED`、`LONG_TASK_KEEPALIVE` 或 `LONG_TASK_MODEL_RESTORED`：用一句話結束回合。
- 時間：用 `brief.now`、`status.nowTaipei` 或同一步的 `TZ=Asia/Taipei date`；amend 的 `authority.at` 要含時區的完整 ISO 時間、不晚於現在，否則程式拒收。指令輸出前面的語系警告不要當成結果。
- `all_blocked` 或 `brief.allBlocked` 不是 null：逐包核對受阻四種原因，排在後面的請改 ready、拆準備包並當輪派出；不接受籠統的「沒有可並行工作」。
- 時間條件用直接觸發或縮短時間驗（監督代決，不問使用者）；不自排「幾點以後」；驗收收尾附上線後觀察清單。

# 單次事件處理

只處理 context 指定的事件。STOP、已處理或事件已換就結束；不重建 run、不重讀整段聊天。context 已含 brief 及授權查核入口；只有實際遇到授權問題才執行 authorization，問題與送驗事件直接附有效授權及來源；一般進度只補缺少的直接證據，不重讀 SKILL、全部驗收或自己的歷史。送驗才讀完整有效契約，逐條獨立驗證同版候選，不能採信自報 PASS；換版沿用的項目查影響清單、沿用紀錄、原始變更與像素比對報告，不重開瀏覽器重驗；最終放行的送驗由監督分功能段落全套驗收、不沿用（[換版與有效證據](acceptance.md#換版與有效證據)）。文件類成品的送驗依 [acceptance.md 的文件類成品](acceptance.md#文件類成品)：先查內容、內容全對才查外觀；單件驗過用 reply 放行下游，整包且全部條文通過才 accept；樣片、樣張不轉給使用者先看。

進度正常或指示已被執行：observe，不傳「收到」、不催促。有可行下一步或證據不足：reply，指出具體工作／問題。派工事件送出前重查快照，過期不送。silence／wait_changed 若只剩已核對等待，observe 另附 wait；不能把等待當驗收通過。阻塞只停該動作，其餘已授權工作繼續。

授權疑問依 authorization.md 核對使用者原文、來源、操作及資料目的地；不能因轉派就要求使用者重說，也不能把代理自述當授權。executor_blocked 只是未取得指令結果的線索，先查實際工具回應；沒有拒絕證據不得宣稱需要本人放行。遇到工具明確拒絕，保留工具名、拒絕原文與受阻操作，不換路徑繞過。

**每則回覆都先過三關**（給執行對話或使用者都一樣；使用者已授權監督依驗收目標代答時尤其如此）：

1. 分類：怎麼測、用哪個身分／環境／資料／工具、先後順序與證據做法屬執行細節，由監督依原驗收條文決定並代答。只有不可逆或付費操作、對外發送、新建或取得憑證、推翻使用者明示的禁令，以及改寫驗收條文（縮窄、列例外、換證據或對照基準）才是使用者決定。本任務自己產生的測試中間產物（暫存容器與資料卷、測試票與紀錄、草稿、已被取代的中間輸出）必要時刪除已有使用者預設授權，不算使用者決定：由產生它的執行端照做（監督只刪自己建的驗證副本），刪前記入刪除清冊；決策帳、驗收證據、測試結果、清冊、版本控制歷史與證據引用到的測試物件不刪；「不准刪東西」這類泛用禁令只保護非本任務建立的資源，點名特定資源或明說包含測試中間產物的禁令才優先（[authorization.md](authorization.md#測試中間產物的刪除)）。
2. 找路：即使屬使用者決定的範圍，先找能滿足原條文又不越界的可逆做法，例如已授權類別內的暫時調整（先備份、測完逐位元組還原並驗證）、隔離環境、測試資料或既有已授權身分。找到就直接交辦執行端，記下依據與還原方法；每條路都越界時，才把該具體動作記為待核准，並寫明各路為何不可行。
3. 時機：屬使用者決定且找不到可逆路的事，用 `supervise.cjs pending` 登記到待決帳（先對 `brief.pendingDecisions`：同一件事更新原 key，已答的不重問），並指示執行端續做其他項；何時、怎麼問使用者依 SKILL 第 4 點：`supervise.cjs ask` 回的全部未決項一次列完，不用會停住回合的提問工具。

技能規定的做法直接做，不當成問題問使用者：平行派工、逐條驗收、兩份以上送驗時派子代理平行驗收、同一工作包重做 2 次仍未送驗就凍結並換方法、開工即把準備工作（部署腳本、回退步驟、規格草稿）列為可派。不請使用者到別的對話打字或轉貼；權限切換與只有本人能按的確認依 SKILL「少打擾使用者」第 2、5 點。

**新事件的處理**（reasons 或 dispatch issue 的 kind）：

- `instruction_overdue`：上一則指示到期仍沒有動靜。`misses=1` 時改道，用 reply 交子代理、拆小或換做法，並附新的 instruction；`misses>=2` 時監督自己接手，例如自己派子代理、自己判定或直接查證，不通知使用者。
- `permission_review`：執行對話在「自動審查」權限下（`brief.executorPermission`），或平台審查剛拒絕了操作（`newRejections` 有拒絕原文）。這不是授權不足，依 [authorization.md](authorization.md#平台自動審查擋下操作時) 處理：用 `supervise.cjs pending` 登記（kind `user_action`，同一件事更新原 key），依 SKILL 第 4 點的時機和其他未決項一起問：「請在『對話標題』的權限選單選完全存取，只切選單、不必打字，切好在這裡說一聲」；不給授權文字，不請他到執行對話打字，其他不受影響的工作照常推進。只剩這個等待時用 observe 並附 `wait:{kind:"user_approval",conditions:[]}`，等待期間不會再每小時叫醒。他說切好後，用 `answer` 記下原話，再用原生跨對話傳訊送一則附新 `LONG_TASK_DELIVERY` 的續接，請執行端重跑被擋的操作。
- `permission_changed`：執行端的回合已是完全存取。切換後的續接已要執行端重跑被擋操作時用 observe，否則用 reply 要它重跑，不需要等使用者回覆；待決帳的權限項還開著就用 `withdraw` 寫明此事件識別撤下。
- `automation_found`：有排程正在操作本監督或執行對話。用 Codex App 的 automation_update 把它設成 PAUSED（不刪除），在回覆裡告訴使用者排程名稱和原因，然後 observe。
- `login_expired`：`loggedOut` 列出要處理的登入，`status` 分兩種。`logged_out`（已失效）：開工時使用者給的總括重登授權（有效契約的授權更新）或[先實際使用已授權的登入](authorization.md#先實際使用已授權的登入)涵蓋、不需本人輸入密碼或驗證碼者，用 reply 請執行端依該筆 `login` 自行恢復，恢復後監督跑 `login-check.cjs RUN` 確認；需要本人時用 `supervise.cjs pending` 登記（kind `user_action`，寫名稱與 `url` 或 `login` 的處理方式），依 SKILL 第 4 點的時機問。`error`（檢查本身跑不起來，例如 chrome-relay 沒連上、指令找不到、連不到主機或逾時）不是登出：監督自己重跑 `login-check.cjs RUN` 找原因、修好 `RUN/login-sites.json` 裡的檢查，修不好才登記。其他工作照常推進。
- `rate_limited_all`：可用的模型都在限速中。記下恢復時間，有不受影響的工作就交辦；沒有就 observe，附 resumeAt 等到恢復時間。不改全域設定。
- `platform_error`：執行對話的回合被平台錯誤中斷，2 分鐘沒有恢復（`platformError.text` 是錯誤原文，`kind` 是 `codex_error_info`）。brief 的執行端最後幾段話在錯誤之後已有新回合就 observe。限速類錯誤（`usage_limit_exceeded`、429、「rate-limited」）到這裡代表換模型沒讓它恢復（已全部限速、`modelFallback` 關閉或該請求不經 opencodex）：原文寫明恢復時間（例如「try again at Oct 14th, 2026 12:03 PM」）時，observe 附 `wait:{kind:"external_result",conditions:[],resumeAt:<該時間換算的 ISO 時間>}`，不 reply、不請使用者處理，到時背景程式以 `wait_changed` 叫醒，再請執行端從中斷處接續；沒寫恢復時間的照其他錯誤處理。其他錯誤用 reply 請執行端從中斷處接續，不重做已完成部分。續接後同一錯誤又出現（brief 的最近決策已有同一錯誤的 platform_error），或錯誤本身要本人處理（沒寫恢復時間的帳號用量或 API 額度上限、提供者停用或路由設定、需重新登入）時，才用 `supervise.cjs pending` 登記到待決帳（kind `user_action`；要新建或取得憑證，例如換 API key，用 `credential`），在本對話告訴使用者要做的具體動作，並 observe 附 `wait:{kind:"user_approval",conditions:[]}`；執行端被這個錯誤卡住、已沒有其他可做的工作，所以當下就問。不請使用者到執行對話打字，除限速換模型外不換模型或帳號。
- `overdue`、`no_event_hour`（進度查核原因）：`overdue` 列出的包已達基準 1.5 倍或 3 倍（看 pace 的 ratio；同一包每一級最多叫醒一次，重估把該級的叫醒時點往後延到比先前叫醒過的都晚才重新起算），同一事件的 `nearOverdue` 也一併列出其他已達 1.2 倍、還沒到 1.5 倍的在途包：它們的 1.5 倍那一級記為已分析、不會再各自叫醒（3 倍照舊各自叫醒），所以這次要逐包一起分析，不能只看觸發的那一包；`no_event_hour` 是距上一次真正執行事件已滿 1 小時。先用 pace 以同一公式重算基準，對照執行端填的時長、子代理實際輸出與測試或程序紀錄，判斷四件事：仍在跑、只是估短；卡關（等權限、工具呼叫沒有回傳、程序已停）；可否加速（拆包並行、只跑受影響測試、換做法）；範圍是否擴大（例如同一包接著做下一階段，卻沿用前一階段的基準）。重估過的包看 basis 的重估原因與次數，對照子代理紀錄的實際開始時間判斷累計是否失控。卡關或可加速時 reply 具體指示；範圍擴大、基準明顯估短或過長、產出與進度不符或證據不足時，reply 請執行端回報完成到哪、剩下什麼，用 `pace.cjs estimate` 重估並更新派工快照（能獨立的新範圍拆成新工作包）；只是估短而仍正常產出，或只剩已核對的使用者核准或外部結果等待時用 observe 並寫明理由。這類事件不是 silence，observe 不需 wait。
- `unplanned_criteria`（進度查核原因）：這些未通過的條件已 10 分鐘沒有任何工作包負責（`unplannedCriteria.criteria`；`unplannedCriteria.freeCapacity` 是空著的子代理席位）。用 reply 逐條點名要派的工作包，寫明範圍、產出、隔離資源和可解鎖的條件；真的只能等核准或外部結果的，請執行端把它列進 blocked 並標 acceptanceIds。
- `doc_budget`（進度查核原因）：文件時間預算過半（`docBudget.stage` 為 `half`）或用完（`spent`）。`half`：核對剩下的工作放不放得進另一半——簡報與影片是否已在 .md 送驗後開工、退件是否一次列完、重送是否只驗差異、有沒有工作在等判定；有落差就用 reply 給具體做法，進度正常用 observe。`spent`：不延長預算；把現況（已完成項、剩餘項、再需多久與依據）與選項（照原範圍追加時間、改由使用者指定的交付範圍、維持現狀）登記進待決帳交使用者決定，執行端不受影響的工作照常進行；使用者同意追加時，請執行端把同意處寫進 `docBudget.approval`。
- `recurring_rework`：同一包重做 2 次仍沒送驗，用 reply 凍結它，指定新做法或改派其他模型／子代理。

將 eventId、disposition 寫入 context 的 decisionPath；`brief.decisionError` 有值表示上一版決策檔沒通過檢查（附錯誤原文），修正後覆寫同一檔。observe 填非空 reason，不含 reply；待決事項只登記在待決帳，決策檔不帶 pendingApprovals（程式會拒絕）。reply／reject 填具體 reply，並盡量附 `instruction:{what,doneWhen,deadlineMinutes}`（期限預設 30 分鐘，可依工作包預估時長調整）；progress_review 另填 progressCheck:{evidence:[實際查核來源],finding:判斷,guidance:具體下一步}，reply 中須有 guidance 原文。silence／wait_changed 的 observe 必須有 wait:{kind:user_approval/external_result,conditions:[{path,sha256}],resumeAt:僅有既定期限才填}。使用者明示整案暫停時執行 `supervise.cjs pause RUN "<原話>"`，暫停期間不會叫醒模型；needs_user 只在仍須凍結當前事件時使用。

accept 填同版 revision、contractStateSha256（有效契約有此欄時）及逐條 results:[{id,status:"PASS",method,expected,actual,evidence:[{path,sha256}]}]。`brief.eventQueue` 有較新的送驗時不接受這一份，observe 寫明「被排隊中的送驗 <id> 取代」；context 的 `queued`（排在它後面、不是送驗的事件，例如提問或阻塞）不擋接受：讀完原文，驗收時一併結案並列進給使用者的收尾清單。完成後執行 supervise.cjs decision RUN DECISION_PATH，通過才可宣稱接受；背景程式負責傳訊及收件，不自行重送。正常結束回合，等待交背景監看。

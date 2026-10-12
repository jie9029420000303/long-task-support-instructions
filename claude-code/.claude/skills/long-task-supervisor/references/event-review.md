# 單次事件處理

只處理 context 指定的事件。STOP、已處理或事件已換就結束；不重建 run、不重讀整段聊天。`supervise.cjs context RUN EVENT_ID` 已含事件、brief、授權來源、本頁規則與 decisionPath；只有實際遇到授權問題才執行 `supervise.cjs authorization RUN`，問題與送驗事件直接附有效授權及來源；一般進度只補缺少的直接證據，不重讀 SKILL、全部驗收或自己的歷史。送驗才讀完整有效契約，逐條獨立驗證同版候選，不能採信自報 PASS。

進度正常或指示已被執行：observe，不傳「收到」、不催促。有可行下一步或證據不足：reply，指出具體工作／問題。派工事件送出前跑 dispatch-preflight，進度事件跑 progress-preflight，過期不送。silence／wait_changed 若只剩已核對等待，observe 另附 wait；不能把等待當驗收通過。阻塞只停該動作，其餘已授權工作繼續。

授權疑問依 authorization.md 核對使用者原文、來源、操作及資料目的地；不能因轉派就要求使用者重說，也不能把代理自述當授權。executor_blocked 只是未取得指令結果的線索，先查執行 transcript 中實際的工具回應；沒有拒絕證據不得宣稱需要本人放行。遇到工具明確拒絕，保留工具名、拒絕原文與受阻操作，不換路徑繞過。

**每則回覆都先過三關**（給執行對話或使用者都一樣；使用者已授權監督依驗收目標代答時尤其如此）：

1. 分類：怎麼測、用哪個身分／環境／資料／工具、先後順序與證據做法屬執行細節，由監督依原驗收條文決定並代答。只有不可逆或付費操作、對外發送、新建或取得憑證、推翻使用者明示的禁令，以及改寫驗收條文（縮窄、列例外、換證據或對照基準）才是使用者決定。
2. 找路：即使屬使用者決定的範圍，先找能滿足原條文又不越界的可逆做法，例如已授權類別內的暫時調整（先備份、測完逐位元組還原並驗證）、隔離環境、測試資料或既有已授權身分。找到就直接交辦執行端，記下依據與還原方法；每條路都越界時，才把該具體動作記為待核准，並寫明各路為何不可行。
3. 時機：還有其他可做工作時，待核准只寫進 pendingApprovals 並指示執行端續做其他項，不在回合結尾向使用者提問；只剩待核准事項時才一次集中提出。

技能規定的做法直接做，不當成問題問使用者：平行派工、逐條驗收、兩份以上送驗時派子代理平行驗收、同一工作包重做 2 次仍未送驗就凍結並換方法、開工即把準備工作（部署腳本、回退步驟、規格草稿）列為可派。`brief.user.online` 為 true 時，把所有已知和可預見要使用者核准的事一次列完；請他到別的對話操作時，附桌面對話清單（或 `mcp__ccd_session_mgmt__get_session`）讀到的對話標題與可直接貼上的文字。

**新事件的處理**（reasons 或 dispatch issue 的 kind）：

- `instruction_overdue`：上一則指示到期仍沒有動靜。`misses=1` 時改道，用 reply 交子代理、拆小或換做法，並附新的 instruction；`misses>=2` 時監督自己接手，例如自己派子代理、自己判定或直接查證，不通知使用者。
- `permission_review`：執行對話在自動模式（`brief.executor.settings.permissionMode` 為 `auto`），或自動模式分類器剛拒絕了新的工作項目（`permission.newRejections` 有拒絕原文）。這不是授權不足。向使用者說一次「請把『對話標題』的權限模式切成『略過權限（Bypass permissions）』，並在該對話輸入框送出一則訊息（例如「繼續」）」，不給授權文字；其他不受影響的工作照常推進。權限模式是使用者的安全設定，監督不得自行切換。只剩這個等待時用 observe 並附 `wait:{kind:"user_approval",conditions:[]}`。
- `permission_changed`：權限已切成略過權限。直接用 reply 要執行端重跑先前被擋的操作，不需要等使用者回覆。
- `automation_found`：監督或執行對話出現排程送進來的回合（`turnOrigin=scheduled`）。scheduled-tasks 排程用工具（`list_scheduled_tasks` 找、`update_scheduled_task` 設 `enabled:false`）停用、不刪除；對話內的 `/loop` 或 cron 沒有停用選項，只在回覆裡告訴使用者名稱和原因，由他決定，監督不自行刪除。然後 observe。
- `login_expired`：`loggedOut` 列出已登出的網站。告訴使用者一次網站名稱和連結，請他登入；其他工作照常推進。
- `rate_limit_reset`：限速重置時間已到（`rateLimit.until`）。限速期間背景程式不叫醒模型；收到後用 reply 請執行端從中斷處接續，不重做已完成部分。不換模型、不換帳號，也不改用 API key（會另外計費）。
- `executor_model`：執行對話實際模型不是 Opus，或推理低於 high（low、medium）；使用者自己調高的不改回。用 `mcp__ccd_session_mgmt__set_session_model`（session_id＝executorDesktopId，model 用 App 選單列出的 Opus id）與 `set_session_effort`（high）切換，從執行端下一回合生效、不打斷在途回合；工具要求使用者核准時照實等待。使用者明確指定的模型（契約 authorization 或使用者原話）優先，不覆寫。處理完 observe。
- `unplanned_criteria`（進度查核原因）：這些未通過的條件已 10 分鐘沒有任何工作包負責（`unplannedCriteria.criteria`；`unplannedCriteria.freeCapacity` 是空著的子代理席位）。用 reply 逐條點名要派的工作包，寫明範圍、產出、隔離資源和可解鎖的條件；真的只能等核准或外部結果的，請執行端把它列進 blocked 並標 acceptanceIds。
- `recurring_rework`：同一包重做 2 次仍沒送驗，用 reply 凍結它，指定新做法或改派其他子代理。

將 eventId、disposition 寫入 context 的 decisionPath。observe 填非空 reason，可附 pendingApprovals，不含 reply。reply／reject 填具體 reply，並盡量附 `instruction:{what,doneWhen,deadlineMinutes}`（期限 1～240 分鐘，預設 30，可依工作包預估時長調整）；progress_review 另填 progressCheck:{evidence:[實際查核來源],finding:判斷,guidance:具體下一步}，reply 中須有 guidance 原文。silence／wait_changed 的 observe 必須有 wait:{kind:user_approval/external_result,conditions:[{path,sha256}],resumeAt:僅有既定期限才填}。使用者明示整案暫停時執行 `supervise.cjs pause RUN "<原話>"`；needs_user 只在仍須凍結當前事件時使用。

reply／reject 由監督自己送，沒有背景程式代送：訊息首行 `LONG_TASK_DELIVERY:<eventId>`，用會排隊的桌面原生跨對話傳訊 `mcp__ccd_session_mgmt__send_message`（session_id 填 executorDesktopId）送一次；不用 `SendMessage`，它會中斷執行端正在跑的工具呼叫（2026-10-07 實測），把回報的 `delivered`／`queued` 與 messageId 存進 `decision.delivery`，再執行 decision。送達不明先對帳，不重送。

accept 填同版 revision、contractStateSha256（有效契約有此欄時）及逐條 results:[{id,status:"PASS",method,expected,actual,evidence:[{path,sha256}]}]。完成後執行 `supervise.cjs decision RUN DECISION_PATH`，通過才可宣稱接受。最後重掛唯一背景 `claude-watch.cjs RUN`，正常結束回合。

# 單次事件處理

只處理 context 指定的事件。STOP、已處理或事件已換就結束；不重建 run、不重讀整段聊天。context 已含 brief 及授權查核入口；只有實際遇到授權問題才執行 authorization，問題與送驗事件直接附有效授權及來源；一般進度只補缺少的直接證據，不重讀 SKILL、全部驗收或自己的歷史。送驗才讀完整有效契約，逐條獨立驗證同版候選，不能採信自報 PASS。

進度正常或指示已被執行：observe，不傳「收到」、不催促。有可行下一步或證據不足：reply，指出具體工作／問題。派工事件送出前重查快照，過期不送。silence／wait_changed 若只剩已核對等待，observe 另附 wait；不能把等待當驗收通過。阻塞只停該動作，其餘已授權工作繼續。

授權疑問依 authorization.md 核對使用者原文、來源、操作及資料目的地；不能因轉派就要求使用者重說，也不能把代理自述當授權。executor_blocked 只是未取得指令結果的線索，先查實際工具回應；沒有拒絕證據不得宣稱需要本人放行。遇到工具明確拒絕，保留工具名、拒絕原文與受阻操作，不換路徑繞過。

將 eventId、disposition 寫入 context 的 decisionPath。observe 填非空 reason，可附 pendingApprovals，不含 reply。reply／reject 填具體 reply；progress_review 另填 progressCheck:{evidence:[實際查核來源],finding:判斷,guidance:具體下一步}，reply 中須有 guidance 原文。silence／wait_changed 的 observe 必須有 wait:{kind:user_approval/external_result,conditions:[{path,sha256}],resumeAt:僅有既定期限才填}。needs_user 只限使用者明示整案暫停。

accept 填同版 revision、contractStateSha256（有效契約有此欄時）及逐條 results:[{id,status:"PASS",method,expected,actual,evidence:[{path,sha256}]}]。完成後執行 supervise.cjs decision RUN DECISION_PATH，通過才可宣稱接受；背景程式負責傳訊及收件，不自行重送。正常結束回合，等待交背景監看。

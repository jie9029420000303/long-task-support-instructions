# Claude Desktop Code 監督啟動與事件協定

監督先保存已定案對話、規格與附件的原文快照，建立 `contract`：`goal`、`authorization`、`criteria:[{id,requirement,source,verify}]`、`sources:[{path,sha256}]`。本次 `executorPrompt` 是可直接在**另一個 Claude Desktop Code 對話**送出的完整指示，首行帶 `LONG_TASK_BIND:<uuid>`；不能從背景 CLI 建立執行主線。若桌面原生工具可建立對話就用它，否則交付 prompt 檔及桌面操作入口，讓使用者在新桌面對話送出。監督必須用桌面對話清單／搜尋核對顯示中的 `local_...` ID，並在本機 transcript 看到同一標記的 `user` 訊息及 `entrypoint=claude-desktop`；`claude --resume` 或 CLI 清單不構成桌面可見證據。

`input.json` 需要 `projectRoot`、`allowedRoots`、監督工具環境的 `supervisorId`、監督桌面對話 `supervisorDesktopId`、桌面執行的 transcript `executorId`、桌面對話 `executorDesktopId`、`executorMarker`、`executorPrompt`、`contract`。Claude `auto` 模式可能用臨時工具子 session；`init` 解析可見原監督對話。執行對話與監督對話必須不同，來源及工作區須逐項核對。

```text
node <installed-skill>/scripts/supervise.cjs init RUN INPUT.json
node <installed-skill>/scripts/claude-watch.cjs RUN
node <installed-skill>/scripts/supervise.cjs status RUN
node <installed-skill>/scripts/supervise.cjs decision RUN DECISION.json
node <installed-skill>/scripts/supervise.cjs stop RUN
```

第二行必須作為**監督桌面對話的背景 Bash 工具**執行，不能由 CLI detached 程序代替：它讀同一執行 transcript 的新完整回合，輸出 `LONG_TASK_WAKE` 後結束；原桌面監督對話收到背景完成通知後，讀背景輸出與 `daemon-state.json`，確認同一事件 ID 再作判斷。隔離對話驗過成功喚醒；現役紀錄也發現通知到達後因 Desktop 記憶體管理暫停對話，未產生模型回合。`model="<synthetic>"`、零模型用量的 `No response requested.` 不算成功。這條路徑不能保證長時間閒置或記憶體壓力下都能喚醒；技能不能修補 App 內部排程，也不能以週期長 prompt 掩蓋。普通讀取不啟動模型；一次只掛一個 watcher。每次處理事件、送達確認及 `decision` 後再掛下一次。未掛好背景工具或 `status.active` 為假，不得稱持續監看。

## 執行對話的事件

執行者每個完成回合在**最終回覆末尾**放一行：

```text
LONG_TASK_EVENT {"kind":"progress","nextAction":"接下來要執行的具體工作"}
LONG_TASK_EVENT {"kind":"question"}
LONG_TASK_EVENT {"kind":"blocked"}
LONG_TASK_EVENT {"kind":"waiting","nextAction":"正在等待的背景工作與完成後動作","waitMinutes":30}
LONG_TASK_EVENT {"kind":"submission","revision":"sha256:<候選清單檔的 SHA-256>","manifest":"<候選清單檔絕對路徑>"}
```

若工作正在執行而回合尚未結束，背景監看保持安靜。若完成回合仍有可執行工作，`progress` 附下一步，監督用桌面原生跨對話傳訊送一則短續接。`waiting` 只用於純背景等待；同一回覆只要還有待決、授權遭拒或其他阻塞，改用 `question` 或 `blocked`，把背景工作寫在正文中。監督仍須讀完整回覆，不可只依標籤忽略阻塞。沒有事件或格式錯誤送監督處理，不能算完成。送驗前執行 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...`，用輸出的完整事件行；改版後另建清單並重交。

監督寫 `RUN/decision-<eventId>.json`。`eventId` 精確相同，`disposition` 為 `accept`、`reject`、`reply` 或 `needs_user`。執行者問到待核准動作、但仍有其他工作可做時，使用 `reply` 指明已決定的可逆方案、暫停的具體動作與繼續項目，**不可用 `needs_user` 凍結整條主線**；只有其他可做工作已完成、具體待核准操作也已準備好時才用 `needs_user`。`reject/reply` 有具體 `reply`；`accept` 有同一 `revision` 和每條 `PASS` 的 `method`、`expected`、`actual`、`evidence:[{path,sha256}]`。需向執行者續接、退件或代答時，訊息首行加入 `LONG_TASK_DELIVERY:<eventId>`，呼叫桌面原生送訊工具，保存它回報的 `delivered` 或 `queued` 及 `messageId` 到 `decision.delivery`；`decision` 還會檢查標記已進精確執行 transcript。結果只有「已排隊」時不可聲稱執行者已讀，重新掛監看等待該回合。送達不確定先對帳，不重送。`needs_user` 保留待決；取得使用者答覆後重新判定，不改原契約。

決策檔已處理後，同一檔重查會回傳 `processed:true`；事後改動會被拒絕。背景工具停止、App 關閉或綁定檔損壞時停止宣稱即時監看，從既有狀態及 transcript 對帳後續接。

## 派工檢查事件

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼在最終回覆的事件種類。收到事件後先查快照與真實來源；在桌面原生送訊**緊接之前**執行事件提供的 `preflightArgv`（argv 陣列，不將含空白路徑直接拼成 shell）：

```text
node "<skill>/scripts/supervise.cjs" dispatch-preflight "<RUN>" "<EVENT_ID>"
```

只在 `current:true` 時送具體指示並照原協定保存 delivery、執行 decision。`current:false` 表示事件已過期，程式清除該 pending 並保留尚未處理的問題；不送訊、不為舊事件寫決策，重新掛 watcher。preflight 與桌面傳訊是兩個步驟，中間仍有狀態改變的時間窗，執行者收到後也須核對，不宣稱原子送達保證。監督只在需要處理事件時醒來，不以定時模型回合保活。

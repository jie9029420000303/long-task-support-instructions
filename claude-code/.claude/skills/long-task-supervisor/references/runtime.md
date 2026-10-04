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

若工作正在執行而回合尚未結束，背景監看保持安靜。若完成回合仍有可執行工作，`progress` 附下一步，監督用桌面原生跨對話傳訊送一則短續接。純背景等待可用 `waiting`，或相容的 `progress` 加 `waitMinutes`（1～120），都由背景程式等待，不補發保活續接；同一回覆只要還有待決、授權遭拒或其他阻塞，改用 `question` 或 `blocked`，把背景工作寫在正文中。監督仍須讀完整回覆，不可只依標籤忽略阻塞。沒有事件或格式錯誤送監督處理，不能算完成。送驗前執行 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...`，用輸出的完整事件行；改版後另建清單並重交。

監督寫 `RUN/decision-<eventId>.json`。`eventId` 精確相同，`disposition` 為 `accept`、`reject`、`reply`、`observe` 或 `needs_user`。執行者問到待核准動作、但仍有其他工作可做時，使用 `reply` 指明已決定的可逆方案、暫停的具體動作與繼續項目，**不可用 `needs_user` 凍結整條主線**。純確認、已知阻塞且無需再發訊時使用 `observe`，即使當下只剩待核准事項，也須繼續接收新事件。`reject/reply` 有具體 `reply`；`accept` 有同一 `revision` 和每條 `PASS` 的 `method`、`expected`、`actual`、`evidence:[{path,sha256}]`。需向執行者續接、退件或代答時，訊息首行加入 `LONG_TASK_DELIVERY:<eventId>`，呼叫桌面原生送訊工具，保存它回報的 `delivered` 或 `queued` 及 `messageId` 到 `decision.delivery`；`decision` 還會檢查標記已進精確執行 transcript。結果只有「已排隊」時不可聲稱執行者已讀，重新掛監看等待該回合。送達不確定先對帳，不重送。`needs_user` 是保留當前 pending、暫停消費新事件的相容操作，只在確實需要整體暫停且已有使用者指示時使用；不是一般待核准事項的預設。

`needs_user` 決策另填 `wholeRunPauseSource`，記下使用者要求整案暫停的原文訊息／文件位置；沒有此欄，程式拒絕決策。個別待核准操作使用 `reply` 或 `observe`。

## 原生事件交接

綁定完成後，監督把精確 run 路徑及本節交給執行對話。執行者在需要代答、阻塞判斷或送驗時，先保存事件，再以桌面原生跨對話工具喚醒監督，補足背景通知可能無法啟動模型的情況。只有 `question`、`blocked`、`submission` 走這條路徑；純背景等待與一般進度維持原有監看，不傳保活訊息。

1. 為本次事件產生唯一 UUID，另存 `EVENT.json`：`id`、`kind`、完整回覆正文 `text`，送驗另含 `candidate.cjs` 產生的 `revision`、`manifest`。事件 ID 不因重試改變；正文不含最後的 `LONG_TASK_EVENT` 行。
2. 執行 `node <skill>/scripts/handoff.cjs prepare <ABS_RUN> <ABS_EVENT_JSON>`。程式先存原文，與 watcher 以同一鎖交接；沒有活 watcher 時安全保存 pending。只有取得持久 pending 收據後，才輸出 `ready:true` 及原生傳訊所需的精確目的地與短訊。這一步不呼叫模型或 CLI。
3. 只有本次回傳 `ready:true` 才呼叫桌面原生傳訊一次，原樣使用 `targetDesktopId`、`message`。傳訊資格在呼叫前已落檔；中斷後再次 prepare 不會給第二次資格。`ready:false`、逾時、錯誤或送達不明均先查事件、pending、收據及精確監督 transcript，不盲重送、不換新 ID 重試。
4. 原生工具回傳後另存 `{eventId,marker,status,messageId}`，其中 `status` 是 `delivered`、`queued` 或 `unknown`；unknown 可不含 messageId。執行 `node <skill>/scripts/handoff.cjs receipt <ABS_RUN> <ABS_RECEIPT_JSON>` 保存結果。已排隊不代表模型已讀。
5. 最終回覆使用已保存正文，加上 prepare 回傳的 `finalEventLine`。監督讀短訊中的 run、事件原文、收據與 pending，核對同 ID／雜湊後依原契約處理。背景通知、原生通知及 transcript 重播只處理同一事件一次；已有 decision 就不再回訊。代答／退件後按上節保存 delivery、執行 decision，再重掛唯一桌面背景 watcher；全數驗收才 accept。

`STOP` 或 accepted 禁止新交接；不得移除 STOP、自動重啟已停止任務。既有 run 由原監督在 pending 已處理、舊 watcher 已退出的安全停點切換並告知原執行者；禁止外部直接改 live run。原生交接需要執行對話正在運作且具備可用原生傳訊工具；兩端皆被暫停、App 關閉、原生送訊拒絕或只有背景派工檢查事件時，仍不能保證自動恢復，必須據實回報，不能新增第三個模型輪詢者或週期 prompt。

`observe` 決策必須有非空 `reason`，可另有 `pendingApprovals`（非空字串陣列，逐項記仍待核准的具體動作）；不得含 `reply`、`delivery`、`revision` 或 `results`。`decision` 保存完整決策及雜湊、清除該 pending，不傳訊、不接受候選；完成後由原監督桌面對話重新掛唯一背景 watcher。範例：

```json
{"eventId":"原事件識別值","disposition":"observe","reason":"執行者只確認收到；已知核准事項未變，不需再回覆。","pendingApprovals":["正式主機 AI 金鑰及付費使用仍待使用者授權"]}
```

使用者之後提供核准時，先核对原話與操作範圍，再以新的唯一 `LONG_TASK_DELIVERY` 標記、原生桌面傳訊及讀回交給執行者，更新決策帳；不要修改已處理的 observe 決策。`STOP` 仍有最高優先，不自行清除或重啟。

決策檔已處理後，同一檔重查會回傳 `processed:true`；事後改動會被拒絕。背景工具停止、App 關閉或綁定檔損壞時停止宣稱即時監看，從既有狀態及 transcript 對帳後續接。

## 派工檢查事件

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼在最終回覆的事件種類。收到事件後先查快照與真實來源；在桌面原生送訊**緊接之前**執行事件提供的 `preflightArgv`（argv 陣列，不將含空白路徑直接拼成 shell）：

```text
node "<skill>/scripts/supervise.cjs" dispatch-preflight "<RUN>" "<EVENT_ID>"
```

只在 `current:true` 時送具體指示並照原協定保存 delivery、執行 decision。`current:false` 表示事件已過期，程式清除該 pending 並保留尚未處理的問題；不送訊、不為舊事件寫決策，重新掛 watcher。preflight 與桌面傳訊是兩個步驟，中間仍有狀態改變的時間窗，執行者收到後也須核對，不宣稱原子送達保證。監督只在需要處理事件時醒來，不以定時模型回合保活。

## 主動進度查核

Claude watcher 在最後一筆執行者 transcript 活動後滿 15 分鐘發出 `progress_review`，之後若仍無活動，每次決策送達後再過 15 分鐘重新查核。這是監督事件，不是執行者要貼的 `LONG_TASK_EVENT`。監督先查最新 transcript、派工快照、在途代理、背景工作的真實狀態與尚未達成的驗收條目，分辨正常長工作、進度延誤與證據不足；不可只根據靜默時間斷言異常。以 `LONG_TASK_DELIVERY:<eventId>` 向原執行對話發一則有事實根據的短訊，具體詢問「已完成什麼、現在哪個工作包或背景工作在跑、卡點及下一步」。有延誤或未回報成果時，同一則給可立即執行的收回、補派或排阻建議；正常長工作也給目前查得的狀態與下一個回報點，不發空泛保活。前次追問後仍沉默時，先查送達、執行回合、代理 handle 與背景輸出，再提出新的具體排阻動作，不照貼相同訊息。此事件只可用 `reply`，不能用 `observe` 消掉可見追蹤。決策必填 `progressCheck`，其 `evidence` 列出實際查過的 transcript、快照或工作 handle 與定位，`finding` 記進度判斷與不確定性，`guidance` 寫給執行者的具體下一步且須原文出現在 `reply`；空泛問候或沒有查核依據的決策會被拒絕。向執行對話送訊緊接之前執行：

```text
node "<skill>/scripts/supervise.cjs" progress-preflight "<RUN>" "<EVENT_ID>"
```

只在 `current:true` 時送出，保存原生送達結果與精確 transcript 標記，再執行 `decision` 並重掛唯一 watcher；`current:false` 不送舊追問，重新掛 watcher。App 暫停監督、背景工具通知沒有產生真實模型回合時，事件仍停在 pending，須如實揭露，不能宣稱已送出追問。

`progress_review` 決策範例（路徑與事實須改用該 run 實際查得的資料）：

```json
{"eventId":"progress-review-事件識別值","disposition":"reply","progressCheck":{"evidence":["executor transcript: 最後執行活動及時間","dispatch.json: 工作包與在途代理狀態"],"finding":"尚無新成果回報；需先核對在途工作是否仍有輸出，不能單靠靜默認定卡死。","guidance":"請核對在途代理的最新輸出，收回已完成成果並回報卡點與下一步。"},"reply":"目前尚無新成果回報。請核對在途代理的最新輸出，收回已完成成果並回報卡點與下一步。","delivery":{"marker":"LONG_TASK_DELIVERY:progress-review-事件識別值","status":"delivered","messageId":"桌面訊息識別值"}}
```

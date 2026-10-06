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

監督寫 `RUN/decision-<eventId>.json`。`eventId` 精確相同，`disposition` 為 `accept`、`reject`、`reply`、`observe` 或 `needs_user`。執行者問到待核准動作、但仍有其他工作可做時，使用 `reply` 指明已決定的可逆方案、暫停的具體動作與繼續項目，**不可用 `needs_user` 凍結整條主線**。純確認、已知阻塞且無需再發訊時使用 `observe`，即使當下只剩待核准事項，也須繼續接收新事件。`reject/reply` 有具體 `reply`；`accept` 有同一 `revision` 和每條 `PASS` 的 `method`、`expected`、`actual`、`evidence:[{path,sha256}]`。需向執行者續接、退件或代答時，訊息首行加入 `LONG_TASK_DELIVERY:<eventId>`，呼叫桌面原生送訊工具，保存它回報的 `delivered` 或 `queued` 及 `messageId` 到 `decision.delivery`。`delivered` 時 `decision` 檢查標記已進精確執行 transcript；只有 `queued` 時，桌面主機會把訊息扣到執行端本回合結束才寫入，`decision` 先記為待對帳（`status` 的 `unconfirmedDeliveries`），重新掛監看後由 watcher 讀到同一標記時確認。已排隊不可聲稱執行者已讀；遲遲未確認者列在進度查核事件，先對帳，不重送。`needs_user` 是保留當前 pending、暫停消費新事件的相容操作，只在確實需要整體暫停且已有使用者指示時使用；不是一般待核准事項的預設。

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

啟用、快照格式與判斷見[派工狀態協定](dispatch.md)。`dispatch_review` 是背景程式產生的監督事件，不是執行者要貼在最終回覆的事件種類；執行端已完成的回覆先處理，沒有待結算的回覆時才做派工稽核。收到事件後先查快照與真實來源；在桌面原生送訊**緊接之前**執行事件提供的 `preflightArgv`（argv 陣列，不將含空白路徑直接拼成 shell）：

```text
node "<skill>/scripts/supervise.cjs" dispatch-preflight "<RUN>" "<EVENT_ID>"
```

只在 `current:true` 時送具體指示並照原協定保存 delivery、執行 decision。`current:false` 表示事件已過期，程式清除該 pending 並保留尚未處理的問題；不送訊、不為舊事件寫決策，重新掛 watcher。preflight 與桌面傳訊是兩個步驟，中間仍有狀態改變的時間窗，執行者收到後也須核對，不宣稱原子送達保證。監督只在需要處理事件時醒來，不以定時模型回合保活。

## 主動進度查核

執行者 transcript 與其背景子代理 transcript 都靜默 15 分鐘後輸出 progress_review，事件附最後子代理活動時間與尚未確認的送達。先核對實際工作，並在決策前執行 `supervise.cjs progress-preflight RUN EVENT_ID`；過期事件不送訊。可行工作或證據不足時用 reply，附 progressCheck.evidence、finding、guidance，實際原生訊息必須含 guidance。

只剩已核對的等待時用 observe，填 reason、progressCheck.evidence、finding 及 `wait:{kind:"user_approval",conditions:[]}`；外部結果用 external_result，必須列允許根目錄內的條件檔 conditions:[{path,sha256}] 或有原訂期限來源的 resumeAt。尚未出現的結果檔 sha256 填 null，不自行新增期限。決策後重掛唯一背景 watcher；它繼續讀執行事件、使用者在監督對話的新答覆及條件檔，條件變動立即解除等待。監督自身的工具輸出或結束回合不解除等待，也不催促同一條未變核准。

背景接收須保持運作，不因減少模型回合停止監看；避免為 idle watcher 外包會定時殺掉接收器的 timeout 命令。使用當前 App 真正支援的長期背景工具及事件完成通知，核對 status.active。若平台強制終止背景工具，據實記錄失效與原生交接途徑，不能保證 App 內部的喚醒，不能另建定時模型 heartbeat 或改由 CLI 代替桌面主線。

## 原契約、使用者修訂與舊 run 接入

先讀 [授權承接](authorization.md)，核對真實使用者原文。`supervise.cjs effective-contract RUN` 輸出原契約加已核准修訂的有效範圍、排除項、授權更新及 contractStateSha256。監督、執行、派工查核和最後接受都讀同一有效範圍。

在原監督的安全停點（無 pending、無 inflight、舊 watcher 與 dispatch writer 已退出，STOP/accepted/stopped 不改）用 `supervise.cjs amend RUN INPUT.json` 登記修訂。INPUT 含 id、原 contractSha256、authority:{role:"user",quote:"逐字原話",locator:"原對話訊息／文件位置",at:"來源時間",source:{path:"允許根目錄內的原文快照",sha256:"實算雜湊"}}、changes:[{id:"原條文ID",action:"exclude/replace/restore"}]。replace 另填完整 requirement、verify；授權更新用 action:"authorization"、固定 id、scope、instruction。代理提案不能冒填 role:user，來源檔須含原話，語意與操作範圍由監督實際查原對話核實。工具只檢查來源完整性，不能證明任意檔案作者真是使用者。

修訂另存不可改寫的 contract-amendments.jsonl，保留原 contract.json；遺失、變動、衝突皆先對帳，不清檔重置。接受決策必須帶當前 contractStateSha256，結果只對有效條文逐條 PASS；排除項明列 EXCLUDED 及核准來源，不能偽填 PASS。

舊 run 的結果帳用 `supervise.cjs attach-acceptance RUN ACCEPTANCE.json` 接入。原執行者準備目前實際候選與逐條狀態，涵蓋有效條文及 EXCLUDED 項；未測 PENDING，已跑但不足判定 INCONCLUSIVE，缺口 FAIL／BLOCKED，不能憑執行次數補成 PASS。工具保存結果歷史、保留既有派工快照與條文，最後才標記 acceptance 已接入。若已有歷史不得清空或覆蓋舊實測。

接入後原監督與執行者都讀回有效契約、摘要與新規則，再以原游標、pending、receipt 續接唯一 watcher；安裝檔案一致不代表現役已切換。不得由另一對話直接改 live run，也不自動清除 STOP。

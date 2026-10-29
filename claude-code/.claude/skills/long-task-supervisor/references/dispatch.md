# 派工狀態與監督檢查

這是執行對話的精簡工作快照，不取代驗收契約、工作包或平台狀態。執行對話仍是唯一派工者；監督根據實際證據指出漏派、未收回成果、資源競爭或重複返工，不能只下「再多派幾個」的指示。

## 啟用與寫入

新的 `supervise.cjs init` 預設啟用。監督在原始執行 prompt 指定 run 絕對路徑與本協定；綁定完成後只送一次短訊，通知執行者更新快照。執行者的 transcript 出現 run 路徑（收到綁定短訊）之後，或綁定後 15 分鐘，背景程式才把「缺快照」當成事件；綁定短訊還在排隊時不會先喚醒監督。綁定前先整理工作包並照常工作，不因尚無 binding 檔案停止；收到綁定通知後寫入第一份快照。

既有 run 由監督在安全停點執行 `node "<skill>/scripts/supervise.cjs" attach-dispatch "<RUN>"`，再將同一份協定及路徑交給執行者。不重建 run、不改原契約或原啟動 prompt 雜湊；已停止的 run 不因此恢復。使用舊版或專用 watcher 的現役任務須另行確認相容性，不能只建快照就宣稱已接線。

相容舊版 watcher 的安全停點是 pending 已處理、沒有尚未收齊的 final，且最新游標與事件已持久化。不必等它自然結束：持續 progress 可能一直延後期限。由原監督桌面背景工具停止該 watcher，確認舊 PID 已退出後備份狀態，再 attach、通知執行者一次並啟動唯一新版 watcher；保留游標、seen、收件、決策與契約，核對 status 及首份快照。更換程序不呼叫永久停止 run 的 stop、不清 STOP、不停執行工作；若 run 本已停止，維持停止。使用者指定保留的專用 watcher 不套用此切換。

執行者在初次拆包、派出／收回／整合工作、依賴或資源改變，以及等待前，更新 task-owned JSON 輸入，再用以下命令原子替換快照：

```text
node "<skill>/scripts/dispatch.cjs" write "<RUN>" "<完整快照輸入 JSON 絕對路徑>"
```

新 run 同時保存[逐條驗收與最新完成案例](acceptance.md)；每筆完成即寫入，歷史由工具持久化，不塞進當前快照。

`dispatch.json` 只保存當前工作、未處理回報、直接依賴及目前返工證據，不複製整段對話或全部歷史。不能只更新時間而保留過期代理狀態；正常更新不另外傳訊、不啟動監督模型。

## 格式

`schemaVersion` 為 `1`，`executorId` 必須等於 binding 的執行對話 ID；`planningRevision` 是執行者目前工作計畫的版本識別。`activity` 為 `planning`（拆包）、`dispatching`（正在派出）、`working`（工作進行中）、`integrating`（正在收回核對）、`waiting`（等待）。過渡狀態只用於當下的動作，不能用來藏住未派工作。

`capacity.verified` 是**已核實的總子代理席位上限**，不是剩餘席位，也不是希望派出的數量；`capacity.evidence` 附平台能力或實際查核來源。剩餘席位由總數扣除 `inFlight` 算出。無可核對資料時交監督查能力，不臆造上限。CPU、記憶體、服務與帳號是否適合增派另查實際證據，不把席位上限當作主機承載量。

`packages` 的六個陣列均必填，可為空；每筆有穩定且唯一的 `id`：

| 陣列 | 每筆其他欄位 | 用途 |
|---|---|---|
| `ready` | `independent`、`safe`、`dependencies`、`exclusiveResources`、`evidence` | 已拆好、可交付的待派工作；依賴列工作包 ID |
| `inFlight` | `handle`、`exclusiveResources`、`evidence`、`baseline`（見下） | 平台實際在跑的子代理及可查證識別 |
| `returned` | `integrated`、`resultEvidence` | 已回報成果及主線是否已核對收回 |
| `blocked` | `kind`、`exclusiveResources`、`evidence` | 具體阻塞；排他資源衝突用 `resource_conflict` |
| `completed` | `acceptanceIds`、`evidence` | 已核對工作與所支援的驗收條目；不是監督已接受 |
| `recurringRework` | `count`、`evidence` | 同一項已重做至少兩次，交監督判斷是否有效重驗 |

真實測試資源（例如正式主機的排查名額、測試身分）用 `capacity.resources:[{key,slots}]` 宣告總名額，各包用 `uses:[{key,units}]` 宣告占用。在途包的占用合計低於名額，同時有可立即開跑的包（標了 `independent`、`safe`、依賴已全部完成、排他資源未被占用、所需名額放得下的就緒包，或只因資源衝突受阻的包）也要用同一資源時，背景程式通知監督評估能否並行；同一資源的這組可派包沒變就不再通知。`capacity.verified` 仍只表示 AI 子代理席位。

在途包的 `handle`：單獨派出的子代理寫 `agent:<agentId>`；執行端用 `long-task-batch` 工作流程派出的寫 `workflow:<runId>:<工作包 id>`，監督從工作流程紀錄（`subagents/workflows/<runId>/journal.jsonl` 的代理標籤）找到它；資源帳本啟動的程序寫 `resource:<id>`。主線自己做的工作包（例如在Browser pane走真實操作）填 `main`：監督把執行對話自己紀錄裡最後一次實際工作（輪詢不算）與 evidence 的修改時間都算成這包的活動，不會因為新存檔點還沒列進 evidence 就判成程序停住；主線真的停下，由「執行端與子代理都停了 5 分鐘」那條叫醒。每次 `dispatch.cjs write` 另在 run 目錄附加一行 `dispatch-history.jsonl`（時間、activity、就緒／在途／受阻包與未通過條件），供事後量「有工作卻空等」的時間。

`inFlight` 每筆附 AI 時程基準 `baseline`：`minutes`（基準分鐘）、`startedAt`、`basis`（算法與來源）；代理工作另附 `model`、`estimatedOutputTokens`、`tokensPerSecond`、`toolMinutes`，用 `node "<skill>/scripts/pace.cjs" estimate "<RUN>" --model <模型> [--tokens <預估輸出 token>] [--tool-minutes <已量測工具分鐘>]` 產生。測試、主機程序等非代理工作以本場實測時長填 `minutes`，`basis` 寫明量測來源。不用人類開發經驗估時；沒有基準的在途包會叫醒監督一次，請執行端補上。同一包換新階段或範圍擴大（例如續派同一子代理做下一階段）時，當下用 `pace.cjs estimate` 估新增的工作並寫入新的 `baseline`：`startedAt` 改為重估時間，`basis` 寫明重估原因，不沿用前一階段的基準；監督把它當新基準，重新計算 1.5 倍與 3 倍的超時叫醒；但已叫醒過的那一級，只有新基準算出的叫醒時間（`startedAt` 加「級數 × 分鐘」）比該級先前每次叫醒時都晚才再叫醒，基準改小或只是重算數字不重叫。能獨立的新範圍優先拆成新工作包。

各 evidence 欄位至少一筆非空引用，指向可重查的檔案、行號或平台事件位置。`updatedAt` 可記更新時間。`exclusiveResources` 只列**不可並行共享的實際占用**，每筆 `{key,kind}`；kind 為 `worktree`、`browser`、`account`、`database`、`test_environment` 或 `other`。key 使用跨工作包一致的實際識別（例如 `database:localhost:55431/qa`）。一般共享文件的唯讀查閱不列成排他資源；同一工作目錄的修改／整體測試、同一瀏覽器工具與測試帳號等仍依原隔離規則。

## 監督處理

背景程式不呼叫模型地讀取快照；發現有餘裕卻漏派、等待時有成果未收回、排他資源衝突、明示返工或驗收結果帳顯示反覆未通過／PASS 撤回，才產生 `dispatch_review`。缺少／無效快照會產生一次可處理事件，不能當成派工健康。同一問題只通知一次，改時間或計畫版號不重複；解決後再發生是新事件，不能沿用舊決策與收件。

監督先重讀快照、原驗收未達項和工作包，再核對平台 handle 是否仍在跑、結果是否已回、依賴／工作區／瀏覽器／帳號／DB 是否真的衝突，以及 CPU／記憶體／程序輸出。快照是定位線索，不能直接當作代理數或驗收完成證據。也要從未達項查快照漏列的可行工作，避免只看執行者已拆出的包。

工作包自填的依賴不等於已證實的阻塞；核對實際呼叫、候選版與資源占用。若包內只有計時量測等個別項目受負載或前置影響，先將可獨立交付、資源已隔離且交接成本合理的其餘項拆出並行，只延後受影響項；不要因整包原先寫了依賴就全部等待。

`ready_capacity` 的 affected 清單表示待檢查機會，不代表可全數同批派出；若待派包彼此共用排他資源，detail 的 `exclusiveConflictGroups` 會列出群組，仍須過既有並行派工閘。

有可獨立交付的工作才回覆：具體工作範圍、產出、依賴、隔離資源及能解鎖的驗收項；由執行對話先收回已完成成果，當輪補派，不等整批。若已有實際依賴或資源競爭，就處理依賴、隔離或調整順序，記下不能並行的證據，不為填席位硬拆小包。返工先查版本、變更範圍及原驗收要求，保留有效證據，只重驗受影響項和必要回歸；不減少原驗收。

送出前依平台 runtime 重查問題是否仍存在；問題已消失不發催促。決策走原有事件、送達讀回與去重流程；監督不另派一支改成品的代理，不建立週期長 prompt 排程。

## 每條未通過條件都要有人做（2026-10-11 定案）

- ready、inFlight、blocked、returned 的工作包可附 `acceptanceIds:["條件ID"]`，標明它推進哪幾條驗收條件。快照的 `acceptance.items` 中，FAIL／PENDING／INCONCLUSIVE 的條件若沒有任何工作包標到它，且持續 10 分鐘（扣掉電腦睡眠），背景程式的監督時鐘發 `unplanned_criteria` 進度查核原因，附空著的子代理席位數；同一組條件只發一次，只剩等使用者核准或暫停中不發。只能等使用者核准或外部結果的條件，列進 blocked 並標上 acceptanceIds。
- 開工拆包時，部署腳本、回退步驟、規格草稿、發布說明等準備工作一開始就列為 ready，和測試並行，不留到最後。
- 同一包重做 2 次仍沒送驗就凍結（recurringRework 的 count 達 2 即送監督）：監督指定新做法或改派其他子代理，不讓它原樣再跑第三次。

## 由工作包檔產生快照（2026-10-15 定案）

派工狀態的唯一紀錄是每個工作包檔 `wp/<id>.md` 裡的一行 `[狀態] {JSON}`（`list` 為 ready、inFlight、returned、blocked、completed、recurringRework 或 archived，其餘欄位照上表）。狀態一變就用一個指令同時改該行並重產整份快照，不手寫快照 JSON：

```text
node "<skill>/scripts/dispatch.cjs" mark "<RUN>" "<狀態目錄絕對路徑>" <工作包 id> '<狀態 JSON>' [--activity <activity>] [--revision <計畫版號>] [--base "<JSON 絕對路徑>"]
node "<skill>/scripts/dispatch.cjs" from-wp "<RUN>" "<狀態目錄絕對路徑>" [同上選項]
```

`id` 取自 `[工作包] id=`；就緒包的 `dependencies` 取自 `依賴：`，排他資源取自 `[共用資源]` 的每個 `前綴:值`（帳號→account、瀏覽器→browser、DB／資料→database、主機→test_environment、worktree→worktree，其餘為 other），`acceptanceIds` 取自 `[驗收條目]`；狀態 JSON 寫了同名欄位時以 JSON 為準。evidence 第一筆自動是工作包檔路徑。容量、驗收逐條、`docBudget` 等其他欄位沿用上一份快照，第一份或要改時用 `--base` 帶入。沒填 `--activity` 時，有在途包算 working、只有未收回的回報算 integrating、其餘算 waiting，讓有就緒包卻沒派出時照樣被背景程式看見。整份快照先驗過才改工作包檔，驗不過兩邊都不動；缺 `[狀態]` 行的工作包檔會被一次列出。2026-10-14～15 GDB 主線只為記帳就用了 99 分鐘、506 個回合，還自己寫了一支快照產生器。

子代理交回時用 `collect`（收包）一步完成：改該包的 `[狀態]`、補證據、更新快照的驗收逐條表並重產整份快照（使用者 2026-10-29 定案；收一包原本要分開寫狀態行、證據、驗收表與快照，GDB V32 常因格式錯回頭重填）：

```text
node "<skill>/scripts/dispatch.cjs" collect "<RUN>" "<狀態目錄絕對路徑>" <工作包 id> "<結果 JSON 絕對路徑>" [同上選項]
```

結果檔 `{"status":{"list":"completed","handle":"agent:<id>","evidence":["/絕對路徑"]},"acceptance":[{"id":"A1","status":"PASS","evidence":["/絕對路徑"],"lastAttempt":{…}}]}`：`status` 是這包新的 `[狀態]`，`acceptance` 列這包推進的條文（`lastAttempt` 選填）。程式先驗過所有證據路徑都存在、條文 ID 都在驗收表、整份快照合格，任一項不合格就什麼都不寫；快照還沒有驗收表時先用 `--base` 寫一次。收完當輪就重跑並行閘、補派新解鎖的包。

## 文件時間預算

文件類成品等所有非文件驗收條文通過後才開寫，開發中只記事實紀錄（改了什麼、版號、部署讀回值；使用者 2026-10-29：「應該是以整個任務驗收監督任務的驗收標準為單位，然後完成驗收標準後才開始進行文件撰寫」）。開寫時執行端在快照寫 `docBudget:{startedAt,devMinutes,minutes,basis,estimate}`：`devMinutes` 是本任務開發、測試與部署的實測分鐘，`minutes` 是文件時間預算，不得超過 `devMinutes` 的 1.5 倍，超過須附 `approval` 寫明使用者在哪裡同意；`basis` 寫明開發時間怎麼量的；`estimate` 是開寫前的逐項估時 `[{"item":"說明 .md","minutes":40},…]`（說明 .md、簡報、Archify 流程圖與圖片檢查、影片各一項），給監督對照。文件工作包在 `[狀態]` 加 `"doc":true`（或 id 以 DOC 開頭）。背景程式只算真正在寫文件的時間：有文件包在途，且執行端或子代理 5 分鐘內有活動才累計，等待、停擺與做其他工作不算；改了 `startedAt` 算新預算、從零算，只改 `minutes`（追加時間）時已用時間保留。用掉一半與用完時各叫醒監督一次（進度查核原因 `doc_budget`）。用完即停：監督請執行端停下文件工作，當回合問使用者「追加時間／簡化做法（例如只出 .md、省略流程圖或影片）／暫停」，`shown` 同時推播（使用者 2026-10-29 保留這道關卡：「之前寫文件跟產圖……它檢查圖片的話非常多時間。如果真的太久的話，我有可能會考慮暫停，或是用簡化的方式做」）。使用者 2026-10-15：「我認為文件撰寫不應該比開發時間還長，或至多只能是1.5倍的時間」；GDB v1.2.0 開發 76 分鐘、文件 12 小時以上；V32 把等待也算進預算，誤報用了 728 分鐘。

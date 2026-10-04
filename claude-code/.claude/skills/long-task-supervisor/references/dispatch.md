# 派工狀態與監督檢查

這是執行對話的精簡工作快照，不取代驗收契約、工作包或平台狀態。執行對話仍是唯一派工者；監督根據實際證據指出漏派、未收回成果、資源競爭或重複返工，不能只下「再多派幾個」的指示。

## 啟用與寫入

新的 `supervise.cjs init` 預設啟用。監督在原始執行 prompt 指定 run 絕對路徑與本協定；綁定完成後只送一次短訊，通知執行者更新快照。綁定前先整理工作包並照常工作，不因尚無 binding 檔案停止；收到綁定通知後寫入第一份快照。

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
| `inFlight` | `handle`、`exclusiveResources`、`evidence` | 平台實際在跑的子代理及可查證識別 |
| `returned` | `integrated`、`resultEvidence` | 已回報成果及主線是否已核對收回 |
| `blocked` | `kind`、`exclusiveResources`、`evidence` | 具體阻塞；排他資源衝突用 `resource_conflict` |
| `completed` | `acceptanceIds`、`evidence` | 已核對工作與所支援的驗收條目；不是監督已接受 |
| `recurringRework` | `count`、`evidence` | 同一項已重做至少兩次，交監督判斷是否有效重驗 |

各 evidence 欄位至少一筆非空引用，指向可重查的檔案、行號或平台事件位置。`updatedAt` 可記更新時間。`exclusiveResources` 只列**不可並行共享的實際占用**，每筆 `{key,kind}`；kind 為 `worktree`、`browser`、`account`、`database`、`test_environment` 或 `other`。key 使用跨工作包一致的實際識別（例如 `database:localhost:55431/qa`）。一般共享文件的唯讀查閱不列成排他資源；同一工作目錄的修改／整體測試、同一瀏覽器工具與測試帳號等仍依原隔離規則。

## 監督處理

背景程式不呼叫模型地讀取快照；發現有餘裕卻漏派、等待時有成果未收回、排他資源衝突、明示返工或驗收結果帳顯示反覆未通過／PASS 撤回，才產生 `dispatch_review`。缺少／無效快照會產生一次可處理事件，不能當成派工健康。同一問題只通知一次，改時間或計畫版號不重複；解決後再發生是新事件，不能沿用舊決策與收件。

監督先重讀快照、原驗收未達項和工作包，再核對平台 handle 是否仍在跑、結果是否已回、依賴／工作區／瀏覽器／帳號／DB 是否真的衝突，以及 CPU／記憶體／程序輸出。快照是定位線索，不能直接當作代理數或驗收完成證據。也要從未達項查快照漏列的可行工作，避免只看執行者已拆出的包。

工作包自填的依賴不等於已證實的阻塞；核對實際呼叫、候選版與資源占用。若包內只有計時量測等個別項目受負載或前置影響，先將可獨立交付、資源已隔離且交接成本合理的其餘項拆出並行，只延後受影響項；不要因整包原先寫了依賴就全部等待。

`ready_capacity` 的 affected 清單表示待檢查機會，不代表可全數同批派出；若待派包彼此共用排他資源，detail 的 `exclusiveConflictGroups` 會列出群組，仍須過既有並行派工閘。

有可獨立交付的工作才回覆：具體工作範圍、產出、依賴、隔離資源及能解鎖的驗收項；由執行對話先收回已完成成果，當輪補派，不等整批。若已有實際依賴或資源競爭，就處理依賴、隔離或調整順序，記下不能並行的證據，不為填席位硬拆小包。返工先查版本、變更範圍及原驗收要求，保留有效證據，只重驗受影響項和必要回歸；不減少原驗收。

送出前依平台 runtime 重查問題是否仍存在；問題已消失不發催促。決策走原有事件、送達讀回與去重流程；監督不另派一支改成品的代理，不建立週期長 prompt 排程。

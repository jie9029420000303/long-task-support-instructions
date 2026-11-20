# 正式驗收的逐案啟動與回執

執行主線在工作包寫 `[測試類型] formal`、`[驗收條目] A1`、`[驗收案例] checkout,refund`。案例 ID 在同一任務內固定，重拆工作包、換候選版、換失敗原因都沿用原 ID。目標腳本若使用不同的案號，填 `[案例套件] orders` 和 `[案例對照] {"checkout":"1","refund":"2"}`。每個正式入口都要接到實際呼叫單一案例的位置。

## 派工前

唯一實機或須排時窗者，先在目標機載入 `scripts/Invoke-FormalCase.ps1`。呼叫 `Test-FormalPreflight -Files … -Scripts … -Directories … -ReceiptSample … -ReceiptFields …`，放入這批實際投送的檔案、腳本、目錄與原生回執欄位。把四項結果用 UTF-8 JSON 取回，在工作包填 `[稀缺實機] 目標機名稱` 和 `[實機前置] 報告絕對路徑`。點貨不啟動正式案例，所有缺件一次修齊，再標記 inFlight。

## 逐案啟動

選案、補登、研究均由執行主線在同一個 RUN 操作。下列各檔案參數都用絕對路徑。

1. 用 `node scripts/formal-case.cjs select RUN SELECTION.json` 讀取當前可跑案例。選案檔含 `workPackage` 與 `revision`。只將 `allowed` 的目標案號送入批次；`held` 列出需研究或等舊回執的案例。原專案的停止條件、安全隔離與時窗仍逐一檢查。
2. 每次正式實測先建立請求，含 `purpose:"formal"`、唯一嘗試 `id`、`workPackage`、`criterionId`、穩定 `caseId` 與實際候選 `revision`。執行 `node scripts/formal-case.cjs run RUN REQUEST.json PERMIT.json RECEIPT.json -- 原投送與取回指令 參數…`。各嘗試用不同的許可與回執路徑，實際投送的候選版須與請求一致。
3. 原投送程序從 `LT_FORMAL_PERMIT` 取得單次許可，送到目標。目標在原本的 STOP、時窗及隔離檢查後，透過 `Invoke-FormalCase -PermitPath … -Case … -ReceiptPath … -ClaimDirectory … -RunCase { 原單一案例指令 }` 執行。ClaimDirectory 固定在這個 run 的目標機上，所有批次共用，直到任務結案。投送程序把逐案回執取回到 `LT_FORMAL_RECEIPT`。
4. 指令結束即把實際逐案結果匯入 `acceptance-history.jsonl`。程序回傳非零也會匯入已取回的回執。中斷時保留原許可，先核對是否已開跑；取回原回執後，用 `node scripts/formal-case.cjs finish RUN PERMIT.json RECEIPT.json` 補登。同一回執可重送，嘗試只計一次。

## 連續兩次未過

執行主線立即派研究子代理，自行安排小實驗並選定解法。正式驗收與子代理本身的交付品質分開計數。實驗仍遵守本案授權、禁令與原驗收條文。監督在送驗時查核證據，或在研究交回後逾期未見後續工作包或進展時督促執行端。

以 `node scripts/formal-case.cjs research RUN RESEARCH.json` 登記以下內容。研究須對應最新失敗嘗試。查不到可用解法，保留該案受阻原因，繼續其他工作。

| 欄位 | 填寫內容 |
|---|---|
| caseId、afterId | 正式案例 ID 及最新失敗嘗試 ID |
| failure、excluded | 失敗證據與已排除的原因 |
| sources | 每筆含外部來源 url 與具時區的查閱時間 checkedAt |
| experiment、experimentPassed | 小實驗結果檔的絕對路徑及實際通過結果 |
| solution、workPackage | 執行主線選定的解法及已登記的後續工作包 ID |

程式核對紀錄、欄位與檔案。證據是否支持解法，由執行主線在整合時及監督在送驗時查核。

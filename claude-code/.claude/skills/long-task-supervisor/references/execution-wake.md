# 執行層完成通知與定期補漏

三層責任不變：監督看執行主線，執行主線看子代理。子代理成果、測試與CI的一般結果及可自行處理的失敗先回執行主線，主線核對、整合、修正及續派；需裁決、未授權操作、獨立驗收或無法自行恢復的阻塞再交監督。一般完成不是送驗，也不是PASS。

## 執行主線自己的原生完成通知

原生Agent完成仍直接回執行主線。測試／CI等外部結果，用 `execution-watch.cjs` 登記並從**執行主線自己的背景Bash**啟動監看；不能從監督對話啟動它，也不能修改 `CLAUDE_SESSION_ID` 冒充執行者。

1. 保存等待輸入JSON：`{"kind":"waiting","nextAction":"讀回原始結果，再整合與續派","waitMinutes":20,"waitFor":[{"ledger":"/允許根目錄/resources.json","id":"r1"}]}`。結果檔尚未產生可用 `{"path":"/允許根目錄/finished.json","sha256":null}`；已有結果則填目前SHA-256。選真正的完成旗標，不選持續更新的log或時間戳快照。資源也可從已登記工作包的 `resources:{ledger,id}`、`resource:r1` handle和資源證據辨認。
2. 執行 `node <supervisor-scripts>/execution-watch.cjs register RUN <輸入JSON絕對路徑>`。保存它的UUID與原始輸入，最終回覆直接使用它回傳的 `event`。`executionWatch` 只連到此run、此執行者的請求；不是監督handoff的 `id`。
3. `watcherAlive` 為false才在本執行對話用背景Bash啟動回傳的 `watchArgv`。一個run只掛一個執行層監看；不要從其他對話借通道或重複啟動。沒有其他可做工作時才結束回合。
4. 收到 `LONG_TASK_EXECUTION_RESUME:<UUID>`，先讀同run的 `execution-waits/state-<UUID>.json`，以提示內的參數陣列執行 `execution-watch.cjs receipt RUN UUID` 留收件證據，再讀原始結果與續做。重複提示先查收件及目前工作包；已接手不再做第二次。收件不是成功、收包或驗收通過。

單純因回合邊界需要續做時可登記 `kind:"progress"` 與具體 `nextAction`，不拿等待子代理當理由停止其他可做工作。沒登記的 `progress` 與所有 `waiting` 都會立刻交監督（使用者 2026-11-08）；`waiting` 事件附看得到的完成來源，登記的來源有結果仍由本機制直接回執行主線。問題、阻塞及送驗照原本的handoff流程，不透過本機制繞過監督判斷。

## 雙機制與原生邊界

- 背景程式以檔案通知及原有有界本機查核直接讀完成狀態。原等待分鐘數不是最早可續接時間；可觀察的工作仍在跑時不因倒數到期呼叫AI。
- 執行者的Bash若有自己匯出的 `CLAUDE_CODE_MESSAGING_SOCKET`／`CLAUDE_CODE_MESSAGING_TOKEN`，用官方own-child inbox JSONL通知自己；不接受別人的target或token，不掃其他socket，不把token寫檔或輸出。原生輸入框訊息可能排隊，socket寫入成功只記為transport written。
- 使用自己的inbox後，程序保持在本執行對話的背景工作內，避免再以Bash結束製造第二次正常完成通知；缺能力或連不上時，保存相同UUID並輸出locator後結束，由原生背景Bash完成通知回原caller。
- 監督原本的背景巡查、保持載入與故障查核照跑。健康的執行層監看不把普通等待到期交監督；執行層監看缺失，或有結果卻在原有五分鐘未接手檢查後仍無收件，才以 `deliveryRecovery` 交監督核對及恢復原生通知。這是通知故障升級，不是每次完成都經監督。
- 一般失敗先由執行主線診斷、修正；超出其授權、既有錯誤恢復能力或需要獨立驗收才交監督。STOP、暫停及契約更新安全點優先，不能藉自己的inbox越過。

來源限允許根目錄並核對realpath。App／電腦停止或平台不投遞時不保證自動恢復；程式寫入成功、背景程序存活及隔離測試都不能冒充真實模型已收件的證據。

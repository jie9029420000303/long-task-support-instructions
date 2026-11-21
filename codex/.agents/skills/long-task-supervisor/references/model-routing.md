# 依監督模型選擇執行與子代理

執行主線預設使用監督實際選定的完整模型 ID。子代理依執行主線當下的模型家族、派工工具顯示的型號與能力選模。GPT 主線派可用的最新 Terra，Claude 主線派相同帳號路徑的最新 Sonnet。各層級內以數字比較版本，只選目前顯示且可呼叫的型號。使用者明確鎖定的角色、推理、費用或帳號限制優先，工具缺少明確指定的能力時記錄該角色受阻。

| 角色 | 模型 | 基準推理 |
|---|---|---|
| 執行主線 | 監督選定的完整 ID | High |
| A 查核、B 技術、C 研究 | GPT 配 Terra，Claude 配 Sonnet | Medium |
| 介面操作 | GPT 配 Terra，Claude 配 Sonnet | Low |

Claude 的 `anthropic/`、`anthropic-apikey/` 代表不同帳號路徑。一般派工沿用主線的完整前綴，只有明確授權或已登記的限速才替換帳號。舊工作從目前進度接續。監督變更路線時在安全回合邊界更新，保存契約、失敗次數與在途成果。歷史錯誤 `unreadable_encrypted_agent_task` 表示父子交接資料無法在該組合讀取，應從實際父對話重新按同一家族選模。

## 解析及實際呼叫

1. 只盤點現在需要的角色。監督從 create_thread／send_message_to_thread 取得執行主線可用模型；執行者從自己的 spawn_agent 取得子代理可用模型。完整 ID 與支援推理由當下工具資訊提供，不自行拼接版本或把 Sonnet 別名當成可呼叫 ID。清單列出不代表供應商已啟用；已查到停用或實際派發拒絕者不列入可用清單，保留錯誤原文，不把接受參數當執行成功。
   spawn_agent 的模型說明可能只列部分模型：2026-10-11 實測，Claude 主線的清單未列 `anthropic-apikey/claude-sonnet-5-5`，明確指定後仍成功派出並由該模型服務。因此 spawn_agent 未列出、但同一 session 其他工具（如 send_message_to_thread）完整列出的同系列 Sonnet ID，可放進 catalogs.subagent 作候選；首次派出後讀子代理執行紀錄的實際模型與推理，相符才記已套用，被拒就記該角色不可用並保留錯誤。不得藉此借用另一系列或未列出的版本。
2. 在本任務工作區寫一份選模輸入，執行 `node <long-task-supervisor>/scripts/model-route.cjs INPUT.json`。只輸出選模結果，不發訊、不修改設定。輸入格式如下（實際值必須來自工具）：

```json
{
  "supervisorModel": "anthropic/claude-opus-5-5",
  "roles": ["executor"],
  "catalogs": {
    "executor": [{"id":"anthropic/claude-opus-5-5","efforts":["low","medium","high","xhigh"]}]
  }
}
```

派子代理時改用 `roles:["general"]` 或 `["ui"]`，附目前執行主線完整 ID `executorModel`。執行端呼叫 CLI 時會以目前對話的實際模型紀錄校正舊輸入，`catalogs.subagent` 填執行端可用清單。第 1、2 次失敗用 `errors:1`、`errors:2` 在同一層調高推理。第 2 次失敗先研究與小實驗，再安排正式重試。第 3 次失敗傳入 `errors:3`、`previousModel`、`previousEffort`，採同家高一級模型與下一個支援的推理強度，再研究、實驗並重試。GPT 層級為 Terra → Sol → Astra，Claude 為 Sonnet → Opus → Fable，允許高於主線。若某項已達平台上限，結果分別以 `modelAtCeiling` 與 `effortAtCeiling` 記錄該項沿用最高檔；文字回報只將實際提高的項目記為升級。第 4 次回傳 `takeover`，由執行主線接手。`overrides` 只接已核對的使用者指定，例如 `{"executor":{"model":"完整 ID","effort":"high"}}`；輸入檔本身不證明授權。某角色 unavailable 只表示該角色沒有可派選項，不擋其他已可做的工作，不跨供應商靜默替代。

3. 新建執行對話：把結果明確放入 `create_thread({model:結果.model, thinking:結果.effort, ...})`，不能省略後依賴 App 預設。交辦 prompt 附監督實際模型 ID、供應商路徑、來源與角色分工；執行主線再依自己的 spawn_agent 清單解析子代理，不能從監督端假定子代理也可用。
4. 綁定既有執行對話：已鎖定且符合路線就保留。新啟動需要套用選定模型時，在回合結束後下一則本來就要送的啟動／續接訊息明確傳 `send_message_to_thread({model,thinking,...})`；不為改模型打斷在途回合、額外催促或丟棄成果。使用者明確指定保留的模型不覆寫。背景 watcher 後續傳訊省略模型，沿用該對話目前設定。
5. 子代理使用 `spawn_agent({fork_turns:"none",model:完整ID,reasoning_effort:該包推理,...})`，prompt 只附完成此包所需來源。完整歷史 fork 不能覆寫模型／推理，不能拿它假裝指定了 Sonnet。工具只有繼承模式時，僅在已核對繼承的實際模型與推理符合該角色要求時使用；不以未經本機版本驗證的預設設定繞過工具限制。按下述失敗次數決定模型與推理。工具不支援指定值時如實記錄，只阻塞該角色派工，其他已授權工作繼續，不偽稱已套用。子代理自稱的模型來自系統提示，常與實際不符，不能當證據；實際模型以子代理執行紀錄（session 的 turn_context）或代理伺服器紀錄為準。
6. 把路線、供應商、各角色完整 ID、實際推理、工具清單來源與時間寫進既有 sidecar「模型／推理鎖定」。工具接受只代表已派出；從新回合實際模型資訊核對後才記已套用。原生 Goal 與第三方模型使用均不因此另獲建立新對話、傳訊或敏感操作的授權。

## 額度限速時自動換模型（使用者 2026-10-11 定案，預設開啟）

主線遇到限速，依序找 `anthropic/`、`anthropic-apikey/` 同層級的可用替代和目前可見的最新 Sol，略過當前模型及仍在限速的路徑。子代理重派須與當時的執行主線同一家。背景程式提出的候選仍由執行端用派工工具的清單核對。

Claude API 有時以 HTTP 400 回報帳戶用量上限。背景程式以同一對話、同一模型及該次失敗回合的供應商錯誤核對；若附 UTC 恢復時間，就依該時間記帳並繼續選下一順位。儀表板以該對話由備援模型實際產生的輸出確認有回應。

監督從所選的 Claude 訂閱開始，依序為同級 Claude API、目前可見的最新 GPT Sol 訂閱。執行路線進入 Sol 後，由背景程式讀該執行對話、該 Sol 回合的有效一週用量。剩餘剛好 50% 留在 Sol；低於 50% 或實際被拒則轉第四順位。百分比未知時可用的 Sol 繼續。監督保留前三順位。

第四順位應使用 OpenCodex 目錄中可用、max 推理且鎖定供應商的模型。程式實作預設 DeepSeek V4.1 Flash 1017／Ambient FP4，其次 Muse Ember／Google Vertex Global；多工具任務可用 binding 的 fourthExecutorModel 指定 Muse 優先。任何一款被拒會查另一款，沒有用量比例。子代理要在實際派工清單中找到與當前主線相容的型號。每個角色分別保留等待狀態，背景自動重查各順位，較高順位先恢復即續接。送達回執證明訊息到達，對話由目標模型產生輸出才確認接手。

- 平台限制（2026-10-11 實測）：所有 OAuth 帳號都被限速時，App 會照 opencodex 給的最早恢復時間，讓當下的回合原地等待；帶 `model` 的訊息會立即改掉該對話的模型設定，但不會中斷正在等待的回合，新模型從下一個回合起生效，排隊的訊息在回合恢復後照常收進去。App 工具沒有中斷別的對話回合的功能，所以已在等待的回合無法提早改用新模型。
- 子代理：執行端將 `RUN/model-fallback.json` 視為可選限速紀錄，新 run 未遇限速時允許缺檔。在 model-route 輸入加上 `"fallback":"RUN/model-fallback.json"`，會自動選替代模型並回傳 `restoreAfter`。原模型的系列在 limits 裡且 until 還沒到，就依當時主線家族選替代模型，恢復後重新依主線選模。
- 恢復時間：先用被拒回合錯誤訊息寫明的恢復時間；沒有時，opencodex 記錄得到 Anthropic 帳號實際的額度重置時間，就用最早重置的那個；都查不到才用被拒後 5 小時。同一路線最後一次被拒後安靜 10 分鐘且之後有成功請求，就提前結束限速。
- 全部可用路線受限時，由背景程式保留各角色、重查並在恢復時自動續接；其他工作依原授權繼續。

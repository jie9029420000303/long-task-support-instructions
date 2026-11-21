# 依監督模型選擇執行與子代理

執行主線預設使用監督實際選定的完整模型 ID。子代理依執行主線當下的模型家族、派工工具顯示的型號與能力選模。GPT 主線派可用的最新 Terra，Claude 主線派相同帳號路徑的最新 Sonnet。各層級內以數字比較版本，只選目前顯示且可呼叫的型號。使用者明確鎖定的角色、推理、費用或帳號限制優先，工具缺少明確指定的能力時記錄該角色受阻。

| 角色 | 模型 | 基準推理 |
|---|---|---|
| 執行主線 | 監督選定的完整 ID | High |
| A 查核、B 技術、C 研究 | GPT 配 Terra，Claude 配 Sonnet | Medium |
| 介面操作 | GPT 配 Terra，Claude 配 Sonnet | Low |

Claude 的 `anthropic/`（訂閱）、`anthropic-apikey/`（API） 代表不同帳號路徑。API 只留給監督備用：執行主線與子代理一律用訂閱路徑，不派 API。舊工作從目前進度接續。監督變更路線時在安全回合邊界更新，保存契約、失敗次數與在途成果。歷史錯誤 `unreadable_encrypted_agent_task` 表示父子交接資料無法在該組合讀取，應從實際父對話重新按同一家族選模。

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

## 額度限速時自動換模型（使用者 2026-10-11 定案，預設開啟；2026-11-21 改版）

目的：任務持續運作，監督盡量由 Opus 擔任。切換全由背景程式（native-watch）執行與換回，不靠監督或執行端自己判斷時機；兩邊從儀表板與 `RUN/model-fallback.json` 讀目前順位。

| 角色 | 順位（前一站被拒或額度不足才往下） | 不用 |
|---|---|---|
| 監督 | 訂閱 Opus → 同級 Claude API → 最新 Sol → DeepSeek V4.1 Flash 1017 max → Muse Ember max | — |
| 執行主線 | 訂閱 Sonnet → 最新 Sol（子代理配最新 Terra）→ DeepSeek max → Muse max | Claude API |
| 子代理 | 與執行主線同一家：Claude 主線配訂閱 Sonnet、GPT 主線配 Terra、開源主線配同一完整 ID 與 max | Claude API |

- 監督只在自己被拒時往下換；執行端或子代理被拒不會動到監督。每一站記錄自己的恢復時間，到時間背景程式把監督換回較高順位，最高回到 Opus。第 4、5 順位固定先 DeepSeek 再 Muse，binding 的 fourthExecutorModel 只影響執行端。
- Claude API 是月額度。API 以 HTTP 400 回報帳戶用量上限時，背景程式以同一對話、同一模型及該次失敗回合的供應商錯誤核對；附 UTC 恢復日就記成「本月已用完」，寫進 `~/.config/long-task-supervisor/anthropic-api-month.json`，這台電腦所有 run 的監督都跳過 API 到該日（暫存目錄下的測試 run 只記在自己的 run 目錄）。
- Claude 訂閱保留給監督：背景程式每 30 分鐘及任一帳號重置後 1 分鐘，用 `ocx account list anthropic --quota --json` 讀一次用量（只讀，不改 OpenCodex）。可用帳號的週剩餘加權平均（Max 20x 算 4 份、Max 5x 算 1 份；暫停帳號不算；週額度已用完或讀不到的帳號以剩 0% 計入）不低於 35% 時，執行主線可用 Sonnet。低於 35%，或所有還有週額度的帳號 5 小時額度都已用到 80%（離 5 小時重置不到 30 分鐘時不換），背景程式先通知執行端停派新的 Claude 子代理，在途的做完（最多 15 分鐘）後把執行主線改用 Sol、新子代理用 Terra；讀值回到保留值以上時再換回 Sonnet。讀不到用量時不假定還有額度。
- 被拒紀錄依角色分開記。執行端的 Claude 訂閱限速只在額度讀值顯示可再用，或被拒回合錯誤寫明的恢復時間到了才結束；監督在同一訂閱上的成功不算執行端恢復。其他路線在最後一次被拒後安靜 10 分鐘、且之後有成功請求，就提前結束限速。
- 恢復時間：先用被拒回合錯誤訊息寫明的時間；沒有時，用 opencodex 記錄的 Anthropic 帳號最早重置時間；都查不到才用被拒後 5 小時。
- 非額度失敗：同一路線連續 3 次失敗，且第一次到最後一次相隔 60 秒以上（取消的請求不算），暫停該順位 30 分鐘並往下換。換過去 15 分鐘仍沒有成功回應（或對話閒置一直沒開新回合）也比照處理。開源順位 429 冷卻 15 分鐘；OpenRouter 回 402（點數用完）時兩個開源順位一起停用，到錯誤寫明的時間，沒寫就 5 小時後再試。
- 開源暫代監督照常依原契約收件、查證與派工。要結案時照常寫裁決並提交，程式會把結案保留成 `held-acceptance-<事件>.json` 而不生效；Sol、Astra、Opus 或 Fable 回到監督且沒有在處理其他事件時，背景程式把最新一件保留的候選重送，監督在該高階回合逐條核對原件、重寫裁決後才結案。
- 手動選型指定當前使用的模型，包含直接從 Sol 開始，之後仍由背景程式備援。新 run 的 `modelPolicy` 預設為 `automatic`。只有使用者明確要求固定模型且禁止備援時才用 `locked`。舊 run 的 `modelFallback:false` 視同 locked，經使用者確認恢復自動後才遷移。續接同一任務時繼承既有政策。
- 開源順位：DeepSeek V4.1 Flash 1017 與 Muse Ember 均須在 OpenCodex 目錄可用、鎖定 max 推理且有合格供應商。OpenCodex 每日依加權成本篩選及排序各模型的供應商，對每次請求套用該模型的名單。技能每次選模讀取目前設定，單一合格端點也可使用，某款沒有合格端點時略過該款；兩款都沒有時儀表板會寫明。舊安裝的 Ambient FP4（DeepSeek）或 Google Vertex Global（Muse）單點設定仍適用。每個角色分別保留等待狀態，背景自動重查各順位，較高順位先恢復即續接。送達回執證明訊息到達，對話由目標模型產生輸出才確認接手。
- 平台限制（2026-10-11 實測）：所有 OAuth 帳號都被限速時，App 會照 opencodex 給的最早恢復時間，讓當下的回合原地等待；帶 `model` 的訊息會立即改掉該對話的模型設定，但不會中斷正在等待的回合，新模型從下一個回合起生效，排隊的訊息在回合恢復後照常收進去。App 工具沒有中斷別的對話回合的功能，所以已在等待的回合無法提早改用新模型。
- 子代理：執行端將 `RUN/model-fallback.json` 視為可選限速紀錄，新 run 未遇限速時允許缺檔。在 model-route 輸入加上 `"fallback":"RUN/model-fallback.json"`，會依 `chain.executor` 與 `limits` 自動選替代模型並回傳 `restoreAfter`；`supervisorLimits` 是監督自己的紀錄，子代理不看。`claudeQuota.executorMayUseClaude` 為 false 時，Claude 主線不派新的 Claude 子代理，等背景程式把主線換到 Sol。背景程式提出的候選仍由執行端用派工工具的清單核對。
- 全部可用路線受限時，由背景程式保留各角色、重查並在恢復時自動續接；其他工作依原授權繼續。

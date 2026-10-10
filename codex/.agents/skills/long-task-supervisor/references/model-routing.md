# 依監督模型選擇執行與子代理

以監督當下實際模型 ID 判定，不讀全域預設猜測：Claude 系列啟動本次監督，就選第三方 Claude 路線；其他監督沿用 goal-orchestrator 的既有 OpenAI 規則。使用者明確指定的個別角色模型、供應商與推理優先。已啟動 run 續接沿用鎖定；政策變更才在安全回合邊界更新，不重建契約或清除工作包錯誤次數。

**Claude 系列以監督對話當下實際模型的完整前綴確認**，不是以全域預設、目錄順序或另一系列的可用性決定：

| 監督對話使用的模型 | 本次執行主線與所有子代理沿用的系列 |
|---|---|
| `anthropic-apikey/claude-…` | `anthropic-apikey`：Opus 主線、Sonnet 子代理 |
| `anthropic/claude-…` | `anthropic`：Opus 主線、Sonnet 子代理 |

這裡的「啟用系列」指本次任務選用的系列，不修改供應商的全域啟停設定。兩系列同時可用也只選監督正在使用的系列；該系列缺少所需角色時，只記錄該角色阻塞，不改派另一系列。若只拿到不含系列的 Claude 別名，先查監督實際完整 ID，不猜 `anthropic` 或 `anthropic-apikey`。監督後續明確切換系列屬路線變更，依既有安全回合邊界更新執行主線與之後新派的子代理，保留在途成果及錯誤次數。

Claude 路線參照 Claude 側既有分工：

| 角色 | 模型 | 基準推理 → 品質錯 1 → 品質錯 2 |
|---|---|---|
| 執行主線 | 同一供應商路徑的 Claude Opus；監督已是 Opus 時優先同一完整 ID | High；子代理第三次品質錯誤由主線接手 |
| A 查核、B 技術、C 研究 | 同一路徑的 Claude Sonnet | Medium → High → Xhigh |
| 介面操作 | 同一路徑的 Claude Sonnet | Low → Medium → High |

不自動換 Haiku／Fable／GPT，也不在 `anthropic` 與 `anthropic-apikey` 之間互換：路徑不同可能使用不同帳號或計費。只有使用者明確指定才覆寫。Claude Code 的 Agent 定義名稱及 /model、/effort 命令不適用於 Codex；此處用 Codex 工具的 model、thinking 或 reasoning_effort 參數，且以該工具當下支援的層級為準。

原生 GPT 父代理派到第三方 Claude 時，可能出現 `unreadable_encrypted_agent_task`（任務以原生 ChatGPT 格式加密，Claude 讀不到）。這不是授權不足；不改回 GPT、不關全域保護，也不以空任務當成功。保留錯誤並核對是否真正由 Claude 主線派發及平台是否提供明文 agent-message 傳遞；技能無法解密原生任務。

## 解析及實際呼叫

1. 只盤點現在需要的角色。監督從 create_thread／send_message_to_thread 取得執行主線可用模型；執行者從自己的 spawn_agent 取得子代理可用模型。完整 ID 與支援推理由當下工具資訊提供，不自行拼接版本或把 Sonnet 別名當成可呼叫 ID。清單列出不代表供應商已啟用；已查到停用或實際派發拒絕者不列入可用清單，保留錯誤原文，不把接受參數當執行成功。
   spawn_agent 的模型說明可能只列部分模型：2026-10-11 實測，Claude 主線的清單未列 `anthropic-apikey/claude-sonnet-5-5`，明確指定後仍成功派出並由該模型服務。因此 spawn_agent 未列出、但同一 session 其他工具（如 send_message_to_thread）完整列出的同系列 Sonnet ID，可放進 catalogs.subagent 作候選；首次派出後讀子代理執行紀錄的實際模型與推理，相符才記已套用，被拒就記該角色不可用並保留錯誤。不得藉此借用另一系列或未列出的版本。
2. Claude 路線在 task-owned 工作區寫一份選模輸入，執行 `node <long-task-supervisor>/scripts/model-route.cjs INPUT.json`。只輸出選模結果，不發訊、不修改設定。輸入格式如下（實際值必須來自工具）：

```json
{
  "supervisorModel": "anthropic/claude-opus-5-5",
  "roles": ["executor"],
  "catalogs": {
    "executor": [{"id":"anthropic/claude-opus-5-5","efforts":["low","medium","high","xhigh"]}]
  }
}
```

派子代理時改用 roles:["general"] 或 ["ui"]，catalogs.subagent 填執行者自己的工具清單。`overrides` 只接已核對的使用者指定，例如 `{"executor":{"model":"完整 ID","effort":"high"}}`；輸入檔本身不證明授權。某角色 unavailable 只表示該角色沒有可派選項，不擋其他已可做的工作，不跨供應商靜默替代。

3. 新建執行對話：把結果明確放入 `create_thread({model:結果.model, thinking:結果.effort, ...})`，不能省略後依賴 App 預設。交辦 prompt 附監督實際模型 ID、Claude 路線、來源與角色分工；執行主線再依自己的 spawn_agent 清單解析 Sonnet，不能從監督端假定子代理也可用。
4. 綁定既有執行對話：已鎖定且符合路線就保留。新啟動需要套用 Claude 路線時，在回合結束後下一則本來就要送的啟動／續接訊息明確傳 `send_message_to_thread({model,thinking,...})`；不為改模型打斷在途回合、額外催促或丟棄成果。使用者明確指定保留的模型不覆寫。背景 watcher 後續傳訊省略模型，沿用該對話目前設定。
5. 子代理使用 `spawn_agent({fork_turns:"none",model:完整ID,reasoning_effort:該包推理,...})`，prompt 只附完成此包所需來源。完整歷史 fork 不能覆寫模型／推理，不能拿它假裝指定了 Sonnet。工具只有繼承模式時，僅在已核對繼承的實際模型與推理符合該角色要求時使用；不以未經本機版本驗證的預設設定繞過工具限制。品質升檔同模型進行；工具不支援指定值時如實記錄，只阻塞該角色派工，其他已授權工作繼續，不偽稱已套用。子代理自稱的模型來自系統提示，常與實際不符，不能當證據；實際模型以子代理執行紀錄（session 的 turn_context）或代理伺服器紀錄為準。
6. 把路線、供應商、各角色完整 ID、實際推理、工具清單來源與時間寫進既有 sidecar「模型／推理鎖定」。工具接受只代表已派出；從新回合實際模型資訊核對後才記已套用。原生 Goal 與第三方模型使用均不因此另獲建立新對話、傳訊或敏感操作的授權。

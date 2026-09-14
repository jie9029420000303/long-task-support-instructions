# 執行協定（Claude Code）

只在建立狀態檔、派工、前台操作、模型解析、續接或驗收證據需要細節時讀本檔；核心分工與錯誤規則以 `SKILL.md` 與 `references/spec.md` 為準，不在此重述。

## 狀態檔

位置：`<專案根>/.claude/long-task/<YYYY-MM-DD>-<slug>/state.md`，證據放同目錄 `evidence/`。範本：`templates/state.md`（用 `cp` 複製後填寫）。不想進 git 就把 `.claude/long-task/` 加進 `.gitignore`（由使用者決定）。

保存：原始目標、最新核准變更、驗收標準、目前階段與停止點；模型／effort 鎖定（角色、`subagent_type`、當時解析到的實際模型、時間）；每個工作包的 id、類型、負責 Agent 定義、依賴、候選版號／雜湊、狀態、錯誤次數、目前 effort 檔、成果與證據位置；PASS／FAIL 判定紀錄。

每次派工前、收到回報後、判定前都更新狀態檔；每次判定前先重讀（對話壓縮後尤其如此）。

候選版：git 專案用 `git rev-parse --short HEAD`（工作樹有未提交修改時加註 `+dirty` 與 `git diff --stat` 摘要）；非 git 專案用交付檔的 `shasum -a 256`。

## 模型解析（Claude Code）

- 主線：從本 session 的系統提示讀目前模型名，effort 用技能載入時顯示的 `${CLAUDE_EFFORT}`；技能不能切換主模型或 effort，只能揭露差距請使用者用 `/model`、`/effort`。
- 子代理：`sonnet` 別名，Anthropic API 解析為 Sonnet 5；Claude Platform on AWS 為 Sonnet 4.6；Bedrock／Google Cloud Agent Platform 為 Sonnet 4.5。鎖定時記角色、`subagent_type`、解析結果、時間。
- 升一檔＝改派同角色下一檔 Agent 定義（medium→high→xhigh；介面 low→medium→high），模型字串不變。不可為升檔換模型，也不可用相同 effort 冒充升檔。
- Agent 定義缺失（cloud session 沒帶 `.claude/agents/`、或使用者移除）、模型不可用、`sonnet` 解析到不支援 effort 的版本：記執行問題，揭露並等待，不靜默降級；模型重解析時保留工作包錯誤次數。

## 派工（Agent 工具）

- 派工：`Agent(subagent_type="<定義名>", prompt="<工作包>", description="<3–5 字>")`。彼此獨立的工作包在同一則回覆內並行派出；有依賴的等前包 PASS 才派。
- 補問或補充同一檔次的資訊：`SendMessage(to="<agent 名或 id>")` 續用同一子代理（保留它的上下文）。重派（升檔）一律新開 Agent，prompt 附上主線指正、更新後的來源／期望與可復用成果，不把整段對話貼進去。
- 子代理預設在背景跑；完成通知一到就讀回報。`/goal` 的評估會等背景子代理全部結束才跑；背景工作超過 30 分鐘 Claude Code 會插入 check-in，屆時讀輸出、卡住的就停掉並診斷，不放置。
- 每包只負責一類工作，prompt 至少包含：

```
[工作包] id、類型（A 查核／B 技術／介面操作）、依賴、目前錯誤次數與本次 effort 檔
[候選版] 版號／雜湊、來源路徑或 URL
[問題] 要做什麼、精確範圍
[判準] 客觀可核對的 PASS 條件
[可修改範圍] 檔案／目錄清單；[資料副作用]；[禁止事項]；[隔離／還原方式]
[回報格式] 結論（PASS／FAIL／BLOCKED）、實際覆蓋、發現與影響、證據位置（evidence/ 下的檔名）、未查項目及原因
```

只傳完成工作所需的最小上下文。主線完整閱讀回報，核對直接來源、實際影響路徑與候選版本，不把未查項目視為通過。

## 前台操作案例

每案寫明：URL／版本、帳號角色與起始狀態、測試資料、瀏覽器／尺寸、使用者工作、操作步驟、各節點預期、允許副作用與還原、禁止操作、必留證據。功能回歸可給明確步驟；自然旅程只給起始狀態、目標、成功條件與禁止事項，不提示控制項位置。

介面子代理須以真實點擊、輸入、選擇、拖拉或切換完成路徑；不得以狀態注入、內部 API、DOM 或 OCR 取代操作／視覺證據。畫面或狀態改變後重新讀取介面；空白或異常截圖不算證據，換工具截到可視畫面為止。回報 `PASS`、`FAIL` 或 `BLOCKED`，附實際步驟、結果、期望差異與未測範圍。

工具路徑（依使用者 CLAUDE.md「瀏覽器工具路由」）：免登入頁用 Claude Code 的 Browser pane（`mcp__Claude_Browser__*`）或 headless playwright；需登入態用 `chrome-relay` 技能接管使用者已登入的 Chrome。一律另開新分頁，只關自己開的分頁。

證據落檔：Browser pane 的截圖只存在子代理自己的對話裡，主線看不到；要給主線 Read 目視的證據，子代理用 Bash 跑 `scripts/screenshot.js <url> <out.png> --size WxH [--click <selector>:<n>]`（無頭瀏覽器，輸出含 scrollWidth）存進 evidence/，主線判定前自己 Read 一次。

使用新開且可隔離的測試分頁／資料。付款、刪除正式資料、對外發送、身分驗證、個資、憑證或正式環境不可逆操作，未獲明確授權就停在操作前回報 BLOCKED。產品 FAIL 修正後，重測受影響案例與既定必要回歸。

## 續接、壓縮與 cloud

- 續接：`claude --continue`、`--resume`、desktop 續接都會恢復尚未完成的 `/goal`（回合數與計時歸零，條件不變）。技能被觸發後第一件事永遠是讀狀態檔，只讀狀態、必要來源與未解差異。
- 對話壓縮：壓縮後的摘要不是狀態來源；任何判定前重讀狀態檔。
- Cloud／web session：只看得到 repo 內的 `.claude/skills/` 與 `.claude/agents/`，看不到 `~/.claude/`。要在 cloud 用本技能，必須把這兩個目錄提交進 repo。`/goal` 可在 `claude -p`、desktop、Remote Control 使用。
- 並行技術包若會互相踩到同一 repo，可在派工時改用 `isolation: "worktree"`（Agent 工具參數）；但同一檔案／元件仍依序交接，不得同時寫。

## 並行與完成

依依賴並行；共享檔案、瀏覽器、帳號、資料庫或測試資料無法隔離時排程。查核期間候選版被修改，受影響證據失效。

只在原始目標、核准變更與適用驗收全部有同版有效證據時完成，狀態檔記最終 PASS。必要決策、授權或外部依賴未解時，繼續其他已授權工作並如實停在等待／阻塞，不把階段候選或部分 PASS 當整體完成；若使用者設了 `/goal`，完成條件應由狀態檔的最終判定與證據在對話中被說出，評估模型才判得到。

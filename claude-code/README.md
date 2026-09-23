# 長任務輔助技能（Claude Code 版）

來源規格：<https://github.com/jie9029420000303/long-task-support-instructions>（`SPEC.md` 為共用行為契約；本資料夾是其 `claude-code/` adapter 的實作）。

## 結構

```
.claude/
├── skills/long-task-orchestrator/
│   ├── SKILL.md                    技能本體：觸發、A／B／C 分工、路徑枚舉閘、C 研究線、模型／effort 鎖定、驗收與三次錯誤規則
│   ├── references/spec.md          共用規格逐字複本（不得在此改共同語意）
│   ├── references/execution.md     Claude Code 執行協定：狀態檔、派工、前台案例、續接／壓縮／cloud
│   ├── references/behavioral-cases.md  共同行為案例 + Claude Code 驗證對照
│   ├── templates/state.md          狀態檔範本（cp 後填寫）
│   ├── templates/state.example.md  實跑一輪後的完整範例
│   ├── scripts/screenshot.js       無頭截圖落檔工具（子代理把證據存成 PNG 給主線 Read）
│   ├── scripts/scope-overlap.py    並行派工閘：比對工作區／可修改範圍／實際共用資源，有交集 exit 1、缺段 exit 2
│   └── scripts/sidecar-guard.py    狀態檔容量守門：≤150 通過、151–180 提醒、>180 exit 1（只報告不改寫）
└── agents/                         十二個子代理定義（4 角色 × 3 個 effort 檔）
    ├── lt-visual-checker-{medium,high,xhigh}.md   A 線視覺查核（唯讀＋瀏覽器）
    ├── lt-tech-worker-{medium,high,xhigh}.md      B 線技術實作（可編輯，git 寫入被 hook 擋）
    ├── lt-researcher-{medium,high,xhigh}.md       C 線分面研究（唯讀＋WebFetch／WebSearch／瀏覽器；只能把來源快照存進 evidence/）
    └── lt-ui-tester-{low,medium,high}.md          介面真實操作蒐證（唯讀＋瀏覽器）
```

## 安裝

- 全域（所有專案）：把 `.claude/skills/long-task-orchestrator/` 複製到 `~/.claude/skills/`，`.claude/agents/lt-*.md` 複製到 `~/.claude/agents/`。
- 單一專案／cloud session：把上述兩個目錄提交進該 repo 的 `.claude/`（cloud session 看不到 `~/.claude/`）。
- 新開 session 才會載入（技能與子代理在 session 啟動時掃描）。

## 使用

1. 在專案裡說「啟動長任務：<目標>」或 `/long-task-orchestrator <目標>`；主線建立 `.claude/long-task/<日期>-<slug>/state.md` 並鎖定模型與 effort。
2. 建議接著下 `/goal <可由對話證據判定的完成條件>`，session 會自動續跑到條件成立。
3. 續接：`/long-task-orchestrator 續接`（或「長任務狀態」）；`claude --resume` 會一併恢復未完成的 `/goal`。

## Codex → Claude Code 對應與已揭露差距

| 項目 | Codex 版 | Claude Code 版 | 差距 |
|---|---|---|---|
| 長任務機制 | Goal（可由技能建立、設 token 預算） | `/goal`（使用者指令；技能不能代下，也沒有 token 預算） | 技能只能建議使用者下 `/goal` |
| 狀態保存 | Goal 物件 | `.claude/long-task/<slug>/state.md` | 需靠檔案，對話壓縮後以檔案為準 |
| 主線模型 | 自動解析上一成熟世代旗艦 | 本 session 模型（建議 Opus 5／`best`，effort high） | 技能不能切換主模型，只揭露並請使用者 `/model`、`/effort` |
| 一般子代理 | 同世代平衡模型 @ Medium | `sonnet` @ medium | 別名依供應商解析，鎖定時記實際模型 |
| C 研究子代理 | 一般子代理 @ Medium，指令約束「不決策、不改正式文件」 | `lt-researcher-{medium,high,xhigh}`：`tools` 無 Edit／Write／Agent，Bash 只能把來源快照寫進 evidence/；互斥議題以 `[共用資源] 議題:<slug>` 交給 `scope-overlap.py` 擋同議題並行 | 正式文件的 Write／Edit 只有主線做得到；子代理靠 WebFetch 讀來源，JS 渲染頁才用 Browser pane（受序列化限制） |
| 介面子代理 | 具瀏覽器／視覺能力中總成本最低者 @ Low | `sonnet` @ low | 未選 Haiku 4.5（不支援 effort 層級，會讓升檔失效） |
| 升一檔 | 同模型改推理值 | 改派下一檔的 Agent 定義（effort 只能寫在定義檔） | 需 12 個定義檔；缺檔屬執行阻塞 |
| 子代理不得 Git | 指令約束 | `tools` 排除 Agent／Edit／Write（依角色）＋ PreToolUse hook 擋 git/gh 寫入 | hook 只擋 Bash 內的 git／gh，其他不可逆操作仍靠指令與 CLAUDE.md |
| 安裝位置 | `codex/.agents/skills/` | `.claude/skills/` 與 `.claude/agents/` | — |

## 驗證紀錄（2026-09-14／15 實跑）

在一個最小的 git 測試專案（單頁計數器）上，用本 session 實際跑完一輪，主線＝Opus 5 @ xhigh：

| 驗證項 | 做法 | 結果 |
|---|---|---|
| 技能觸發與變數替換 | `Skill(long-task-orchestrator, "啟動長任務：…")` | 從 `~/.claude/skills/` 載入；`${CLAUDE_EFFORT}`＝xhigh、`${CLAUDE_SESSION_ID}`、`$ARGUMENTS` 都正確替換 |
| 狀態檔 | 依 `templates/state.md` 建立並逐步更新 | 完整範例留存於 `templates/state.example.md` |
| B 技術包（medium） | `lt-tech-worker-medium` 實作 index.html | DONE；transcript 7/7 則 model=claude-sonnet-5、effort=medium |
| git 守門 hook（真實子代理） | `lt-tech-worker-medium` 嘗試 `git commit --allow-empty`、`git tag` | 兩條都被 PreToolUse hook exit 2 擋下；`git log` 正常；HEAD 不變、tag 數 0 |
| hook 規則單元測試 | 22 組指令 | 11 組寫入全擋、11 組唯讀全放行（含 `git tag -l`） |
| A 視覺查核（medium） | `lt-visual-checker-medium` 用 Browser pane 在 1280／375 截圖目視 | PASS；transcript 15/15 則 effort=medium；用了 preview_start／resize_window×3／screenshot×2 |
| 介面真實操作（low） | `lt-ui-tester-low` 真實點「＋1」三次 | PASS，0→1→2→3；transcript 13/13 則 effort=low，`left_click` 3 次 |
| 升檔定義 high | `lt-tech-worker-high` 做核准變更（歸零鈕） | DONE；transcript 24/24 則 effort=high |
| 升檔定義 xhigh | `lt-visual-checker-xhigh` 查核新版 | PASS；transcript 15/15 則 effort=xhigh |
| 落檔證據 | `scripts/screenshot.js`（無頭 chrome-headless-shell） | 7 張 PNG 存進 evidence/，主線 Read 目視核對 |
| 同版證據 | 候選版 e260982 與 6c21b0b 分開判定 | 未拼接 |
| 並行派工閘（2026-09-15 補） | `scripts/scope-overlap.py` 跑真實長任務的 8 個工作包 prompt | 抓出 6 個交集（含 3 個 `**` 目錄前綴涵蓋）exit 1；無交集的兩包 exit 0；缺段落 exit 2 |
| 共用資源閘（2026-09-16 補） | `[共用資源]` 的 `鍵:值` 標記比對 | 同瀏覽器工具（含全形冒號）exit 1、不同工具 exit 0、同 migration 編號對在途包 exit 1、缺段落 exit 2 |
| 套件安裝守門（2026-09-16 補） | hook 單元測試 28 組 | `pnpm add/install/i`、`yarn add`、`npm install <pkg>`／`-D`／`-g`、`npm uninstall`、`npm link` 全擋；`npm ci`、裸 `npm install`、`npm test/run`、`npx` 全放行 |

## 兩場實跑的回顧（2026-09-16，依 transcript 統計）

| | 蜜蜂爺爺市價調查 | 會計驗收 acceptance-100 |
|---|---|---|
| 觸發 | `/goal` 同一分鐘內主線呼叫技能 ✅ | 同 ✅ |
| 時長／壓縮 | 3 h 40 m／0 次 | 38 h／3 次（壓縮後技能未重載 → v0.2.0 的派工閘 0 次執行） |
| 派工 | 2（介面 low；82 列 155 次真實點擊 36 分鐘） | 123（tech medium 50、high 44、ui low 17、ui medium 9） |
| 品質錯誤處理 | — | 8 包各錯 1，附指正升 high 重派；無包到錯 3 ✅ |
| 暴露的缺口 | 主線自做 6/8 包無登記；goal 條件不可判定 | 8 包並行 6 處重疊；pnpm 改共用 node_modules 整站 500；migration 撞號；3 個介面代理共用瀏覽器 → 可歸因重跑 5 批＝125 分鐘、1.39M tokens；state.md 58 KB 只重讀 9 次；41 包直接從 high 起跳 |

這些缺口對應 v0.3.0 的修正：壓縮後強制重載、`[共用資源]` 欄與閘、介面代理序列化、套件安裝 hook、狀態檔快照化＋archive、主線自做登記、goal 條件建議、起始檔固定。

## 第三場回顧（2026-09-18 餐廳查詢，`/goal` 有設、技能未啟動；依 transcript 統計）

| | 主線 Haiku 4.5（14:44–15:04） | 主線 Sonnet 5（15:04–15:29） |
|---|---|---|
| 訊息／退回 | 612 則、`/goal` 退回 7 次 | 291 則、退回 0 次、使用者糾正 4 次 |
| 搜尋空間 | 只查新北（region 3417），臺北（544）從未查；把「50|Café」的樓層 50 讀成 5 折（實為 85 折） | 8 分鐘內查出兩個根因，找到 3 家真 5 折可訂 |
| 路徑檢視 | 在同一家餐廳的時段上採樣，7 次宣稱「完整／詳盡／統計學依據」 | 找到 1 家就點到手機號碼頁、其他沒看；4 家只憑 API `reservation_type: disabled` 寫「未開放」，沒點 `booking_form_url`；被要求「全部看」後自行擴到 10 月 |
| 收口 | — | Workflow 6 個子代理真實點擊補驗，477k tokens，結論不變 |

`/goal` 的 7 次退回全部只談「時段／日期沒窮舉」，0 次指出地區漏查或餐廳不對：檢查器跟著助手自己的框架評，沒回到原始目標。這些缺口對應 v0.4.0 的修正：路徑枚舉閘（候選全集先寫、同判準逐驗、「沒有」只認 UI 層證據、宣稱完整必附計數、範圍不擴大）與主線 Haiku 擋派工。

## C 研究線（v0.6.0，2026-09-19）

對應 SPEC 不變量 4／7 與 tests 16：研究／系統規劃任務走 C 線——子代理按互斥議題蒐集原始來源、反證、比較與待確認事項；主線鎖定研究問題、來源類型與截止時點，親自核對關鍵原始來源後判定系統取捨、架構並撰寫正式規劃文件；規劃文件需要視覺排版時另併用 A。Claude Code 的落地方式：

- 新增 `lt-researcher-{medium,high,xhigh}`：`tools` 無 Edit／Write／Agent，Bash 沿用同一套 git／套件 hook，只能把來源快照存進工作包指定的 `evidence/<id>/**`；正式文件的 Write／Edit 只有主線做得到。
- C 工作包在原有段落外必填 `[研究議題]`、`[決策問題]`、`[來源與截止時點]`、`[必找反證]`；互斥議題以 `[共用資源] 議題:<slug>` 交給既有的 `scope-overlap.py` 擋同議題並行，不另寫閘。
- 狀態檔新增「C 研究證據」節（研究問題、來源類型、截止時點；議題／主張、決策問題、原始來源、支持／反證、適用範圍、未證實事項），只填主線核對過的列；C 的候選版＝正式文件 `shasum -a 256`＋研究範圍／來源清單／截止時點。

| 驗證項 | 做法 | 結果 |
|---|---|---|
| 共用案例逐字一致 | script 比對 `tests/behavioral-cases.md` 16 條與 adapter `references/behavioral-cases.md` 左欄 | 16/16 逐字相同；adapter 另有 3 條 Claude Code 專屬（17–19） |
| SPEC 複本 | `diff SPEC.md references/spec.md` | 空 |
| 12 個 Agent 定義 frontmatter | PyYAML 解析 | 全部可解析；researcher×3 無 Edit／Write／Agent，model `sonnet`，effort medium／high／xhigh；hook 指令與 tech-worker 逐字相同 |
| CLI 認得新定義 | `claude agents`；headless session init 事件的 `agents` 欄 | 三個 `lt-researcher-*` 都列出；專案 `.claude/agents/` 的複本標「shadowed by project」 |
| 並行派工閘對 C 包 | 6 個 wp 檔 9 組比對 | 不同議題 exit 0；同 `議題:` exit 1；兩包同 `瀏覽器:pane` exit 1；缺 `[共用資源]` exit 2；在途包同議題 exit 1；同 `evidence/C-1/**` exit 1、不同 exit 0 |
| Codex 放寬的路徑 regex 回歸 | 無目錄前綴檔名 | `index.html`×2 exit 1；`src/a.ts` vs `src/**` exit 1；`a.ts` vs `b.ts` exit 0 |
| researcher hook 單元測試 | 20 組指令 | 10 組寫入（git commit/push/tag/checkout、gh pr/release、npm/pnpm/yarn 安裝）全 exit 2；10 組唯讀（git log/tag -l/status/diff、curl 存快照、npm test/ci、npx、shasum）全 exit 0 |
| 三份副本 | 本機封裝 repo ＝ `~/.claude` ＝ `claude-code/` | skills、agents、README diff 皆空 |
| 子代理定義載入時機 | 本 session 複製新定義到 `~/.claude/agents/` 後直接 `Agent(subagent_type="lt-researcher-medium")` | 回「Agent type not found」；同時 Skill 清單已顯示 SKILL.md 新 description → **agent 定義只在 session 啟動時掃描，技能會熱重載**；新增代理後要開新 session |
| 真實派工 `lt-researcher-medium`（新開 Claude Desktop Code session） | 兩份互相矛盾的本地來源（規格書 600 req/min／page_size 500 vs 維運手冊實測 300／200）、正式文件 `plan.md`、截止時點 2026-06-30；主線讀 subagent transcript `agent-ace5d65a1927f6a29.jsonl` 與檔案雜湊 | transcript 7/7 則 model=`claude-sonnet-5`、effort=`medium`；工具只有 Read×2、Bash×2（`ls`、`cp` 快照進 evidence/）；`plan.md` SHA-256 前後一致；兩份快照與來源逐字相同；回報含 4 條主張（各附檔名＋原句＋日期）、兩條必找反證都有交代、未證實事項 5 處、來源衝突並列不裁決、無「建議採用」字樣 |

未實測：`/goal` 的自動續跑（使用者指令，本輪未設）；`--resume` 續接後讀狀態檔；cloud session（需把 `.claude/` 提交進 repo）；C 線的升檔定義 `lt-researcher-high`／`-xhigh` 與 WebFetch 線上來源（本輪只用本地檔實測 medium）。


## 工作區隔離與狀態檔容量守門（2026-09-23，對應 Codex 09536d4）

對應 SPEC 不變量 12 與 tests 17／18：工作區（worktree／整體測試）也是共用資源；多個 B 技術包並行改程式時，主線預設為每包建立綁定同一 base 的隔離 worktree，成果在主線整合進單一候選版並跑完整回歸前只是草稿；否定宣告（不使用／不安裝）不算占用。Claude Code 的落地方式：

- 工作包必填 `[工作區]`（`path:` 絕對路徑、`worktree:` 唯一識別值、`base:` commit／SHA-256）；`scope-overlap.py` 相同 path 或 worktree 判交集、相同 base 可並行，舊工作包缺段 exit 2。只讀或只寫 evidence 的包以自己的 evidence 目錄當工作區，避免 A／C／介面包因共用 canonical 路徑被誤擋。
- worktree 由主線 `git worktree add` 預建（登記「主線自做」），不用 Agent 的 `isolation: "worktree"`：它的路徑派工前不存在、無法先過閘。子代理 hook 照擋 `git worktree` 等寫入；`lt-tech-worker-*` 只在 `[工作區] path` 內讀寫與測試。
- 路徑解析改成以空白與標點切出完整 token（根因：舊 regex 的目錄段不收「.」且沒有結尾邊界），保留 Claude 既有的無目錄檔名、行內註記與 `app/(group)/` 支援。
- 新增 `sidecar-guard.py`（Codex 版同門檻；工作包列與批次列改按節計數，因 Claude 狀態檔的 id 是 `B-1` 形式）。

| 驗證項 | 做法 | 結果 |
|---|---|---|
| 可執行回歸測試 | `python3 -m unittest discover -s tests` | 35/35 通過（Codex 既有 7＋Claude 新增 28：閘 17、容量守門 5、agent 定義與 hook 3、規格一致性 3） |
| 真實 wp 檔新舊解析對照 | `~/worktrees/*/.claude/long-task/*/wp/*.md` 610 檔中舊版讀得到兩段的 80 檔 | 54 檔結果不同，全是舊版截斷（`.test.tsx`→`.test`、`.github/workflows/ai-triage.yml`→`triage.yml`、`evidence/`→`task/…`）被還原成完整路徑；舊有新無的項目只有 1 個，即刻意忽略的否定值 `遠端:不建標籤` |
| hook | 12 個定義 × 14 組寫入／9 組唯讀 | 寫入（含 `git worktree add`、`git cherry-pick`）全 exit 2；唯讀（含在 `.worktrees` 路徑下跑測試）全 exit 0 |

未實測：真實派出兩個並行 `lt-tech-worker-*` 到兩個隔離 worktree 再由主線整合的完整一輪（本輪只驗閘、hook 與文件）。

已知限制：Browser pane 截圖只存在子代理的對話中，主線看不到；要讓主線目視，子代理需用 `scripts/screenshot.js` 落檔（agent 定義已寫明）。 套件安裝被 hook 一律擋下（含工作包授權的情況）——真需要安裝由主線自己做。Browser pane／playwright MCP／chrome-devtools MCP 各是 session 級共用瀏覽器，同一工具同時只能有一個介面代理。使用者自己的全域 PreToolUse hook 訊息（分支確認提示）會被子代理讀到並當作可疑注入回報，無害但會多一段文字。

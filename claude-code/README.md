# 長任務輔助技能（Claude Code 版）

來源規格：<https://github.com/jie9029420000303/long-task-support-instructions>（`SPEC.md` 為共用行為契約；本資料夾是其 `claude-code/` adapter 的實作）。

## 結構

```
.claude/
├── skills/long-task-orchestrator/
│   ├── SKILL.md                    技能本體：觸發、分工、模型／effort 鎖定、驗收與三次錯誤規則
│   ├── references/spec.md          共用規格逐字複本（不得在此改共同語意）
│   ├── references/execution.md     Claude Code 執行協定：狀態檔、派工、前台案例、續接／壓縮／cloud
│   ├── references/behavioral-cases.md  共同行為案例 + Claude Code 驗證對照
│   ├── templates/state.md          狀態檔範本（cp 後填寫）
│   ├── templates/state.example.md  實跑一輪後的完整範例
│   └── scripts/screenshot.js       無頭截圖落檔工具（子代理把證據存成 PNG 給主線 Read）
└── agents/                         九個子代理定義（3 角色 × 3 個 effort 檔）
    ├── lt-visual-checker-{medium,high,xhigh}.md   A 線視覺查核（唯讀＋瀏覽器）
    ├── lt-tech-worker-{medium,high,xhigh}.md      B 線技術實作（可編輯，git 寫入被 hook 擋）
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
| 介面子代理 | 具瀏覽器／視覺能力中總成本最低者 @ Low | `sonnet` @ low | 未選 Haiku 4.5（不支援 effort 層級，會讓升檔失效） |
| 升一檔 | 同模型改推理值 | 改派下一檔的 Agent 定義（effort 只能寫在定義檔） | 需 9 個定義檔；缺檔屬執行阻塞 |
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

未實測：`/goal` 的自動續跑（使用者指令，本輪未設）；`--resume` 續接後讀狀態檔；cloud session（需把 `.claude/` 提交進 repo）。

已知限制：Browser pane 截圖只存在子代理的對話中，主線看不到；要讓主線目視，子代理需用 `scripts/screenshot.js` 落檔（agent 定義已寫明）。使用者自己的全域 PreToolUse hook 訊息（分支確認提示）會被子代理讀到並當作可疑注入回報，無害但會多一段文字。

# Long Task Support Instructions

跨平台長任務協作規則：以主執行緒負責目標、驗收與最終判定；以子代理處理可隔離的查核、實作或前台操作。

## 結構

- `SPEC.md`：兩個平台共用的行為契約與流程圖。
- `workflow/`：流程圖原始規格與可直接開啟的 HTML。
- `codex/`：可由 Codex 在此子目錄下發現的版本。
- `claude-code/`：Claude Code 適配規格；由 Claude Code 依其實際工具、子代理與模型控制能力完成，不可覆蓋 `codex/`。
- `tests/`：兩版本都必須維持的行為案例。

平台版本只能修改自己的目錄。涉及共同語意時，先變更 `SPEC.md` 與測試案例，再同步調整兩個 adapter。

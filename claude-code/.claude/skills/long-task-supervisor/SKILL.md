---
name: long-task-supervisor
description: 使用者在 Claude Code 研究對話定案後，要求啟動長任務監督、自動建立或綁定另一個 Claude Code 執行 session、持續代答與獨立驗收到完成時使用。單次查進度或一般提醒不適用。
---

# 長任務監督（Claude Code）

**目前可見的研究對話就是監督 session。** 先讀 [啟動與事件協定](references/runtime.md)，承接本對話已定案的目標、驗收與授權；未定案的備選方案不混入。使用者不用另開監督對話，也不用提供 session ID。Claude `auto` 模式可能把 Bash 工具放在臨時子 session；`CLAUDE_SESSION_ID` 此時只是工具 session ID，必須由 `init` 核對並解析可見原對話，不能直接當監督綁定。精確定位不到研究對話、驗收原文或執行對話時才詢問。

1. 將已定案的原文、附件及專案規則整理成逐條驗收契約，保存來源快照及真實 SHA-256。準備可直接執行的 prompt，指定 `long-task-orchestrator` 沿用派工、隔離、自查、品質錯誤與恢復能力；新的商業取捨與不可逆操作仍按上層授權處理。
2. 若使用者已指定另一個 Claude Code 執行 session，就精確綁定；否則用本技能的背景程式在此監督回合結束後自動建立。不能在監督回合仍執行時從裡面啟動另一個 `claude` 程序。沒有使用者明確要求時，不替他設定 `/goal`。
3. 用 `scripts/supervise.cjs init` 鎖定契約、原監督 session、原始 prompt 和執行 session，再用 `scripts/supervise.cjs start` 啟動獨立背景程序。`start` 回傳 `armed=true` 後本回合要**正常結束**，不能在同一回合等待 `active=true`：背景程序必須先看到本回合結束才會建立執行 session。此時只說「已布署，正在啟動」；後續 `status` 確認精確 transcript 可讀、`active=true` 才說「已啟動」。失敗明說階段，不以 PID 或技能載入作成功證據。

執行 session 是唯一開發主線；監督不與它同時改成品。背景程式只等待本機 transcript 的新回合與決策檔變動；普通讀取不啟動模型。未完工作依執行者明列下一步短續接，重複停滯、提問、送驗及意外結束才以 `claude -p --resume` 喚醒**同一個監督 session**。不建立定時模型排程、不重貼整份 prompt。

監督收到事件後獨立查真實候選版，逐條記預期、實際及同版證據。退件要具體；執行者自稱完成只算送驗。全數通過且 `decision` 命令成功，才對使用者宣稱整體完成。需要授權的事項只停相關動作，其餘可做工作繼續。每次事件回合正常結束；背景程式繼續等待下一事件。電腦關機或背景程序已停止時不宣稱仍有即時監看，重啟先對帳收件及游標，不盲重送。

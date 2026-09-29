# Claude Code 監督啟動與事件協定

監督在原 Claude Code session 準備 task-owned `input.json`，其中 `projectRoot` 與 `allowedRoots` 是本次專案及執行工作區，`supervisorId` 取當前工具環境的 `CLAUDE_SESSION_ID`；`init` 會核對 transcript，若 `auto` 模式把工具放在臨時子 session，便從此子 session 的精確引用解析出使用者可見的原監督 session，回傳值列出兩個 ID。若無法唯一解析，不啟動監看。`executorId` 可省略讓監看建立新 session。`contract` 逐條保存 `goal`、`authorization`、`criteria:[{id,requirement,source,verify}]` 與 `sources:[{path,sha256}]`。來源需先保存定案原文快照並重算雜湊。`executorPrompt` 是可直接執行的完整 prompt，包含契約路徑、監督 session ID、已定案授權、可執行工作與本頁事件格式，不要求使用者自己複製。背景 CLI 預設使用 Claude 原生 `auto` 權限模式審核每項工具動作；可在 input 設 `permissionMode:"default"` 或 `"acceptEdits"` 沿用較嚴的模式，但無人值守時遇到需人工核准的動作會停下交監督處理，不能用 `bypassPermissions` 略過上層授權。

```text
node <installed-skill>/scripts/supervise.cjs init RUN INPUT.json
node <installed-skill>/scripts/supervise.cjs start RUN
node <installed-skill>/scripts/supervise.cjs status RUN
node <installed-skill>/scripts/supervise.cjs decision RUN DECISION.json
node <installed-skill>/scripts/supervise.cjs stop RUN
```

第二行會用獨立本機程序持有監看，命令本身短時間回傳 `armed=true`；**不要把 `run-watch.cjs` 放進 Claude Code 的背景 Bash 並等待它**，那會讓本回合不結束，而監看又要等本回合結束，造成死鎖。Run 建議 `<projectRoot>/.claude/long-task-supervisor/<executorId>`，不得把 QA 合成資料寫入真實業務專案。`start` 後正常結束本監督回合，背景程序才建立新執行 session；若指定既有 session，只綁定新事件，不回放舊歷史。啟動當回合只回報「已布署，正在啟動」；後續 `status` 的 `active` 與 `readVerified` 都是真的才回報「已啟動」。

執行技能在**最終回覆末尾**放一行事件：

```text
LONG_TASK_EVENT {"kind":"progress","nextAction":"接下來要執行的具體工作"}
LONG_TASK_EVENT {"kind":"question"}
LONG_TASK_EVENT {"kind":"blocked"}
LONG_TASK_EVENT {"kind":"submission","revision":"sha256:<候選清單檔的 SHA-256>","manifest":"<候選清單檔絕對路徑>"}
```

普通進度盡量在回合中通報；回合結束仍有工作才用 `progress`，由背景程式以短訊息續接，不定時重送全案 prompt。相同下一步連續三次轉為停滯事件交監督。無事件或格式錯誤會送異常事件，不會當作完成。

送驗前用 `node <installed-skill>/scripts/candidate.cjs <新版清單絕對路徑> <候選檔絕對路徑>...` 產生候選清單及**可直接貼在最終回覆末尾的完整事件行**，不要手寫或截短雜湊。清單至少列一個，含所有直接修改的交付檔。改版後須另建清單並重交。監督接受時會重算清單及每個候選檔，不能合併不同版本的證據。

監督把決策寫進 `RUN/decision-<eventId>.json`。`eventId` 必須精確相同；`disposition` 是 `accept`、`reject`、`reply` 或 `needs_user`。`reject/reply` 必須有具體 `reply`；`accept` 必須有同一 `revision` 及全部逐條 `results`，每列包含 `id,status:"PASS",method,expected,actual,evidence:[{path,sha256}]`。執行 `decision` 檢查成功才可放行。背景程式把退件或代答用 `claude -p --resume` 送到精確執行 session，並核對 transcript 中的唯一送達標記；不確定是否送達時先對帳，不盲重送。`needs_user` 保留待決，使用者回覆後由監督改寫判定；不改原契約。

決策檔寫入後，監看可能先於 `decision` 命令處理它；命令對保存的同一事件與決策雜湊仍回傳 `valid:true, processed:true`，事後改動的檔案則拒絕。此回讀不會重送訊息或重作決策。

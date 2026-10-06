#!/usr/bin/env python3
"""長任務 hooks 閘：把「主線要記得做」的規則改成事件發生當下的程式檢查。

由 Claude Code hooks 呼叫（stdin 是 hook 輸入 JSON），只做兩種反應：放行（可附一行備註），或
exit 2 把原因交回模型自行修正。絕不用 ask 跳確認框（長任務沒人按，會整批停擺）。

- G4 SessionStart(compact)：本對話載入過 long-task-orchestrator 時，壓縮後補一段「先重載技能、再讀狀態檔」。
  根因：壓縮後技能內容大多會附回，但狀態檔只有少數會（2026-09-28 稽核 14/15 對 2/15）；
  v0.2 那場 125 分鐘重跑、41 包從 high 起跳、並行閘 0 次執行都來自沒重載。
- G3 PreToolUse(AskUserQuestion)：進行中的長任務不得用提問框卡住主線。受監督的執行對話改走監督代答
  （question 事件／原生事件交接），完成驗收時由監督把代答整理給使用者確認；未受監督時採推薦選項並記
  「已採預設」，完成時一次列給使用者確認。狀態檔「逐項確認模式」記有使用者原話時放行。
- G1＋G2 PreToolUse(Agent)：派 lt-* 子代理時，工作包要有 [工作區]／[可修改範圍]／[共用資源]；
  新包從基準檔起跳、升一檔＝錯一次；錯 3 停止子代理鏈由主線接手。錯誤次數以狀態檔工作包表為準，
  查不到才用派工提示表頭；兩者都查不到就放行加備註，不猜。
"""
import json
import re
import sys
from pathlib import Path

TIERS = {"visual-checker": ["medium", "high", "xhigh"], "tech-worker": ["medium", "high", "xhigh"],
         "researcher": ["medium", "high", "xhigh"], "ui-tester": ["low", "medium", "high"]}
AGENT = re.compile(r"^lt-(visual-checker|tech-worker|researcher|ui-tester)-(low|medium|high|xhigh)$")
REQUIRED = ("[工作區]", "[可修改範圍]", "[共用資源]")
PACKAGE = re.compile(r"\[工作包\]\s*id\s*[=＝]\s*([^\s；;，,|]+)")
PROMPT_ERRORS = re.compile(r"錯誤次數\s*[=＝:：]\s*(\d+)")
ITEMIZED = re.compile(r"^-\s*逐項確認模式[:：]\s*(?!關閉|<)(\S.*)$", re.M)


def user_texts(data):
    """本對話 user 列的文字（不含工具結果）：只認真的技能載入與真的綁定訊息，不認工具輸出裡剛好印出的字串。"""
    try:
        lines = Path(data.get("transcript_path") or "").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    texts = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") != "user" or row.get("isSidechain"):
            continue
        content = (row.get("message") or {}).get("content")
        blocks = [content] if isinstance(content, str) else [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
        texts.extend(blocks)
    return texts


def long_task(texts):
    return any(t.startswith("Base directory for this skill:") and "long-task-orchestrator" in t.split("\n", 1)[0] for t in texts)


def states(cwd):
    root = Path(cwd or ".") / ".claude" / "long-task"
    return sorted(root.glob("*/state.md"), key=lambda p: p.stat().st_mtime, reverse=True) if root.is_dir() else []


def section(text, title):
    out, inside = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            inside = line[3:].strip().startswith(title)
        elif inside:
            out.append(line)
    return out


def finished(text):
    final = " ".join(line.strip() for line in section(text, "最終判定") if line.strip())
    return final.startswith("PASS")


def table_errors(text, package):
    for line in section(text, "工作包"):
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 8 and cells[0] == package and cells[7].isdigit():
            return int(cells[7])
    return None


def note(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))
    return 0


def block(text):
    print(text, file=sys.stderr)
    return 2


def compact(data):
    if not long_task(user_texts(data)):
        return 0
    found = states(data.get("cwd"))
    where = f"：{found[0]}" if found else "（在專案 .claude/long-task/ 下）"
    print("長任務壓縮後續接：先執行 Skill(long-task-orchestrator, \"續接\") 重新載入規則，再讀狀態檔"
          f"{where}，以狀態檔的驗收逐條表、工作包錯誤次數與待決清單為準；壓縮摘要不是規則或狀態的來源。")
    return 0


def ask(data):
    texts = user_texts(data)
    if not long_task(texts):
        return 0
    found = states(data.get("cwd"))
    text = found[0].read_text(encoding="utf-8") if found else ""
    if text and (finished(text) or ITEMIZED.search(text)):
        return 0
    if any("LONG_TASK_BIND:" in t for t in texts):
        return block("長任務受監督中，不向使用者提問：把問題寫成 LONG_TASK_EVENT question，依 long-task-supervisor "
                     "runtime「原生事件交接」交監督依契約代答，其餘工作續行。監督完成驗收時會把代答整理給使用者確認。")
    return block("長任務期間不用提問框卡住主線：可逆且有推薦選項的事項直接採推薦，在狀態檔待決清單記「已採預設」與改回方式；"
                 "不可逆、付費、刪除、憑證或對外動作只暫停該動作，其餘工作續行。完成時在最終回覆一次列出全部已採預設，交使用者確認。"
                 "使用者明說要逐項確認時，先在狀態檔記「- 逐項確認模式：<使用者原話＋時間>」再問。")


def dispatch(data):
    tool = data.get("tool_input") or {}
    match = AGENT.match(str(tool.get("subagent_type") or "").split(":")[-1])
    if not match:
        return 0
    role, tier = match.groups()
    prompt = str(tool.get("prompt") or "")
    missing = [field for field in REQUIRED if field not in prompt]
    if missing:
        return block(f"派 lt-* 前工作包缺 {'、'.join(missing)}：補齊後重派（並行閘靠這三段判斷隔離，不能猜）。")
    package = PACKAGE.search(prompt)
    errors = None
    if package:
        for state in states(data.get("cwd")):
            errors = table_errors(state.read_text(encoding="utf-8"), package.group(1))
            if errors is not None:
                break
    if errors is None and PROMPT_ERRORS.search(prompt):
        errors = int(PROMPT_ERRORS.search(prompt).group(1))
    if errors is None:
        return note("PreToolUse", "派工閘：查不到這個工作包的錯誤次數（狀態檔工作包表或派工表頭的「目前錯誤次數」），未檢查起跳檔。")
    if errors >= 3:
        return block(f"工作包{' ' + package.group(1) if package else ''}已錯 {errors} 次：停止子代理鏈，由主線接手未完成部分並復用正確成果。")
    ladder = TIERS[role]
    if tier not in ladder or ladder.index(tier) > errors:
        return block(f"lt-{role} 這包錯誤次數是 {errors}，應派 lt-{role}-{ladder[min(errors, 2)]}：新包從基準檔起跳，升一檔＝錯一次。")
    return 0


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    event, tool = data.get("hook_event_name"), data.get("tool_name")
    if event == "SessionStart" and data.get("source") == "compact":
        return compact(data)
    if event == "PreToolUse" and tool == "AskUserQuestion":
        return ask(data)
    if event == "PreToolUse" and tool in ("Agent", "Task"):
        return dispatch(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())

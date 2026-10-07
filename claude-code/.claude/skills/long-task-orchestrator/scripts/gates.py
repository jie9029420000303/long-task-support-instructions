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
  新包從基準檔起跳、升一檔＝錯一次；錯 3 停止子代理鏈由主線接手。工作包＝派工提示加上它引用的 wp 檔
  （技能規定 prompt 先存成 <狀態目錄>/wp/<id>.md，派工訊息常只引用該檔）。錯誤次數以狀態檔工作包表為準，
  查不到才用派工提示表頭；兩者都查不到就放行加備註，不猜。

狀態檔不假設在目前工作目錄：主線常在 git worktree 裡、或沿用舊版 .codex/long-task 工作（2026-10-06 Gateway
實測兩者皆是，閘因此一直找不到狀態檔）。依序取 wp 檔所在任務的 state.md、本對話工具呼叫最近碰過的
state.md，最後才是目前工作目錄的 .claude/long-task（技能預設位置）。
"""
import functools
import json
import re
import sys
from pathlib import Path

TIERS = {"visual-checker": ["medium", "high", "xhigh"], "tech-worker": ["medium", "high", "xhigh"],
         "researcher": ["medium", "high", "xhigh"], "ui-tester": ["low", "medium", "high"]}
AGENT = re.compile(r"^lt-(visual-checker|tech-worker|researcher|ui-tester)-(low|medium|high|xhigh)$")
REQUIRED = ("[工作區]", "[可修改範圍]", "[共用資源]")
PACKAGE = re.compile(r"\[工作包\]\s*id\s*[=＝]\s*([^\s；;，,|]+)")
PROMPT_ERRORS = re.compile(r"錯誤次數\s*[=＝:：]?\s*(\d+)")
STATE_TAIL = r"/long-task/[^/\s\"'`]+/state\.md"
WP_TAIL = r"/wp/[^/\s\"'`]+\.md"
ITEMIZED = re.compile(r"^-\s*逐項確認模式[:：]\s*(?!關閉|<)(\S.*)$", re.M)


def file_refs(text, tail):
    """text 提到、且真的存在的檔案：獨占一行的路徑、引號包住的路徑（兩者可含空白），或不含空白的路徑。"""
    found = [line.strip() for line in text.splitlines() if line.strip().startswith("/")]
    pattern = rf'"(/[^"\n]+?{tail})"|\'(/[^\'\n]+?{tail})\'|(/[^\s"\'`]*?{tail})'
    found += [next(group for group in match.groups() if group) for match in re.finditer(pattern, text)]
    return [Path(path) for path in found if re.search(tail + "$", path) and Path(path).is_file()]


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


@functools.lru_cache(maxsize=1)
def transcript(path):
    """本對話 user 列的文字（不含工具結果），與本對話自己的工具呼叫碰過的狀態檔（舊到新）。

    文字只認真的技能載入與真的綁定訊息，不認工具輸出裡剛好印出的字串；狀態檔只看本對話自己的工具呼叫，
    監督對話讀執行端狀態檔不影響（閘只在載入協作技能的對話作用）。"""
    try:
        lines = Path(path or "").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], []
    texts, touched = [], []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("isSidechain"):
            continue
        # A message that arrives mid-turn is stored as a queued_command attachment, not a user row.
        attachment = row.get("attachment") or {}
        if row.get("type") == "attachment" and attachment.get("type") == "queued_command":
            prompt = attachment.get("prompt")
            texts.extend([prompt] if isinstance(prompt, str) else [b.get("text", "") for b in prompt or [] if isinstance(b, dict) and b.get("type") == "text"])
            continue
        content = (row.get("message") or {}).get("content")
        if row.get("type") == "assistant":
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    touched.extend(ref for text in strings(block.get("input")) for ref in file_refs(text, STATE_TAIL))
            continue
        if row.get("type") != "user":
            continue
        blocks = [content] if isinstance(content, str) else [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
        texts.extend(blocks)
    return texts, touched


def user_texts(data):
    return transcript(data.get("transcript_path"))[0]


def long_task(texts):
    return any(t.startswith("Base directory for this skill:") and "long-task-orchestrator" in t.split("\n", 1)[0] for t in texts)


def states(data, wps=()):
    """這個長任務的狀態檔，最可信的在前（見模組說明）；逐個產生，前面找到就不必讀整份對話紀錄。"""
    seen = set()

    def fresh(paths):
        for path in paths:
            if path.is_file() and path.resolve() not in seen:
                seen.add(path.resolve())
                yield path

    yield from fresh(wp.parent.parent / "state.md" for wp in wps if wp.parent.name == "wp")
    yield from fresh(reversed(transcript(data.get("transcript_path"))[1]))
    root = Path(data.get("cwd") or ".") / ".claude" / "long-task"
    if root.is_dir():
        yield from fresh(sorted(root.glob("*/state.md"), key=lambda p: p.stat().st_mtime, reverse=True))


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
    """工作包表該包的錯誤次數；欄位依表頭含「錯誤」者定位（新範本「錯誤次數」、舊版「品質錯誤」）。"""
    column = None
    for line in section(text, "工作包"):
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells[0] == "id":
            column = next((i for i, cell in enumerate(cells) if "錯誤" in cell), None)
        elif column is not None and cells[0] == package and len(cells) > column and cells[column].isdigit():
            return int(cells[column])
    return None


def note(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))
    return 0


def block(text):
    print(text, file=sys.stderr)
    return 2


def open_rows(text, title, limit):
    """狀態檔某節表格裡還沒結的列（不含表頭、分隔線與 PASS／核准不做的列）。"""
    rows = [line.strip() for line in section(text, title) if line.strip().startswith("|")]
    rows = [row for row in rows[2:] if not re.search(r"\|\s*(PASS|核准不做)\b", row)]
    return [row[:200] for row in rows[:limit]], max(0, len(rows) - limit)


def compact(data):
    """壓縮後直接把狀態重點印進對話：2026-10-07 GDB 實測三次壓縮有一次過了約 20 分鐘才讀回狀態檔，
    只提醒「去讀」靠不住；技能內容 Claude Code 會附回，狀態檔不會。"""
    if not long_task(user_texts(data)):
        return 0
    found = next(states(data), None)
    if not found:
        print("長任務壓縮後續接：先讀狀態檔（在專案 .claude/long-task/ 下），以驗收逐條表、工作包錯誤次數與待決清單為準；"
              "壓縮摘要不是規則或狀態的來源。若對話裡沒有附回本技能內容，先執行 Skill(long-task-orchestrator, \"續接\")。")
        return 0
    text = found.read_text(encoding="utf-8", errors="replace")
    lines = [f"長任務壓縮後續接：以下是狀態檔 {found} 的重點，以狀態檔為準，壓縮摘要不是規則或狀態的來源。"]
    for title, label, limit in (("驗收標準", "還沒通過的驗收條", 15), ("工作包", "還沒結的工作包", 12)):
        rows, more = open_rows(text, title, limit)
        lines.append(f"【{label}】" + ("無" if not rows else ""))
        lines += rows + ([f"（另有 {more} 列，見狀態檔）"] if more else [])
    body = [line.strip() for line in section(text, "待決") if line.strip()]
    pending = open_rows(text, "待決", 10)[0] if body and body[0].startswith("|") else [line[:200] for line in body[:10]]
    lines.append("【待決清單】" + ("無" if not pending else ""))
    lines += pending
    lines.append("派工或判定前讀完整狀態檔；若對話裡沒有附回本技能內容，先執行 Skill(long-task-orchestrator, \"續接\")。")
    print("\n".join(lines))
    return 0


def ask(data):
    texts = user_texts(data)
    if not long_task(texts):
        return 0
    found = next(states(data), None)
    text = found.read_text(encoding="utf-8") if found else ""
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
    wps = file_refs(prompt, WP_TAIL)
    work = "\n".join([prompt] + [wp.read_text(encoding="utf-8", errors="replace") for wp in wps])
    missing = [field for field in REQUIRED if field not in work]
    if missing:
        return block(f"派 lt-* 前工作包缺 {'、'.join(missing)}（派工提示與它引用的 wp 檔都沒有）：補齊後重派（並行閘靠這三段判斷隔離，不能猜）。")
    match = PACKAGE.search(work)
    package = match.group(1) if match else (wps[0].stem if wps else None)
    errors = source = None
    if package:
        for state in states(data, wps):
            errors = table_errors(state.read_text(encoding="utf-8", errors="replace"), package)
            if errors is not None:
                source = state
                break
    header = PROMPT_ERRORS.search(work)
    header_errors = int(header.group(1)) if header else None
    if errors is None:
        errors = header_errors
    if errors is None:
        return note("PreToolUse", "派工閘：查不到這個工作包的錯誤次數（狀態檔工作包表或派工表頭的「目前錯誤次數」），未檢查起跳檔。")
    if errors >= 3:
        return block(f"工作包{' ' + package if package else ''}已錯 {errors} 次：停止子代理鏈，由主線接手未完成部分並復用正確成果。")
    ladder = TIERS[role]
    if tier not in ladder or ladder.index(tier) > errors:
        # 2026-10-07 GDB：主線只改了工作包檔表頭就派高一檔，被擋時看不出是哪邊記的次數；直接講清楚兩邊各記幾次。
        where = f"狀態檔工作包表（{source}）記錯誤 {errors} 次" if source else f"派工表頭記錯誤 {errors} 次"
        conflict = (f"；派工提示／工作包檔表頭寫 {header_errors} 次，兩邊不一致：先把狀態檔工作包表改成實際次數再派"
                    if source and header_errors is not None and header_errors != errors else "")
        return block(f"lt-{role} 這包{where}，應派 lt-{role}-{ladder[min(errors, 2)]}{conflict}：新包從基準檔起跳，升一檔＝錯一次。")
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

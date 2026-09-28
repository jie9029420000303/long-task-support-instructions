#!/usr/bin/env python3
"""狀態檔守門：容量（派工前讀得起的快照）＋驗收逐條（每次重看條文、擋住與逐條不符的完成宣稱）。

用法：python3 sidecar-guard.py <狀態目錄>/state.md [--soft-limit 150] [--hard-limit 180]
輸出：先報容量，再印「驗收標準」逐條（條文與狀態）和最新一筆核准變更——每次派工前與判定後都跑，
      主線因此每次都重看條文原文，不必靠壓縮摘要或記憶。
exit：0 通過；1 超過 hard limit（不得開新工作包）；2 參數或檔案錯誤；
      3 「最終判定」宣稱 PASS／完成／達成，但逐條仍有不是 PASS 或「核准不做」的條目，或寫了「附條件」
        ——主線把最終判定改成「未完成」並列剩餘條目，或補齊證據後重跑；「核准不做」須附使用者原話＋時間。
      1 與 3 同時成立時回 1，兩段訊息都會印。錯誤只回報給主線修正，不停下來等使用者。
<=150 行不提示；151–180 行提示下次派工前封存；>180 行 exit 1。
只報告、不自動改寫 state.md：封存時保留 active／BLOCKED 工作包、當前候選版、最新核准變更與未解差異，
其餘（已關閉工作包、舊並行批次、舊判定、已取代的主線自做）由主線搬到同目錄 archive.md，不刪除或重寫歷史。
舊格式（「驗收標準」是編號清單、沒有狀態欄）照樣印出條文，但無法比對完成宣稱，只提示改用逐條表。
"""
import argparse
import re
from pathlib import Path

ROW = re.compile(r"^\|(?!\s*:?-{3})")
CLOSED = re.compile(r"PASS|FAIL|主線接手|關閉")
DONE = {"PASS", "核准不做"}
CLAIM = re.compile(r"PASS|完成|達成|全部通過|全數通過")
NOT_CLAIM = re.compile(r"未完成|未達成|未達|未通過")


def _section(lines, title):
    """回傳 `## <title>` 節內的所有列（到下一個 `## ` 為止）。"""
    out, inside = [], False
    for line in lines:
        if line.startswith("## "):
            inside = line[3:].strip().startswith(title)
            continue
        if inside:
            out.append(line)
    return out


def _section_rows(lines, title):
    """回傳 `## <title>` 節內表格的資料列（去掉表頭與分隔列）。"""
    return [line for line in _section(lines, title) if ROW.match(line)][1:]


def _cells(line):
    return [c.strip().strip("*`").strip() for c in line.strip().strip("|").split("|")]


def acceptance(lines):
    """回傳 (印出用的條文列, 未達成條目, 是否舊格式)。"""
    table = [line for line in _section(lines, "驗收標準") if ROW.match(line)]
    if table and "狀態" in table[0]:
        head = _cells(table[0])
        col = lambda key: next((i for i, h in enumerate(head) if h.startswith(key)), None)  # 用開頭比對：狀態欄標題也含「核准不做」
        i_text, i_state, i_ok = col("條文"), col("狀態"), col("核准")
        get = lambda c, i: c[i] if i is not None and i < len(c) else ""
        shown, open_items = [], []
        for line in table[1:]:
            c = _cells(line)
            text = get(c, i_text)
            if not text or text.startswith("<"):
                continue
            state, ok = get(c, i_state), get(c, i_ok)
            label = state or "未填"
            if state == "核准不做" and not ok:
                label = "核准不做（缺使用者原話＋時間）"
            shown.append(f"  #{c[0]} [{label}] {text[:200]}")
            if state not in DONE or label != state:
                open_items.append(f"#{c[0]}［{label}］")
        return shown, open_items, False
    body = [line.strip() for line in _section(lines, "驗收標準") if line.strip()]
    return [f"  {line[:200]}" for line in body[:20]], [], True


def final_claim(lines):
    """回傳 (最終判定是否宣稱完成, 是否寫了附條件)。"""
    text = " ".join(line.strip() for line in _section(lines, "最終判定")
                    if line.strip() and not line.strip().startswith("<"))
    if not text or text.startswith("FAIL"):  # 「未完成」由 NOT_CLAIM 排除；FAIL 內文可能提到其餘已完成
        return False, "附條件" in text
    return bool(CLAIM.search(NOT_CLAIM.sub("", text))), "附條件" in text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state")
    parser.add_argument("--soft-limit", type=int, default=150)
    parser.add_argument("--hard-limit", type=int, default=180)
    args = parser.parse_args(argv)
    if args.soft_limit < 1 or args.hard_limit < args.soft_limit:
        parser.error("limits must satisfy 1 <= soft-limit <= hard-limit")

    path = Path(args.state)
    if not path.is_file():
        print(f"讀不到狀態檔：{path}")
        return 2
    lines = path.read_text(encoding="utf-8").splitlines()
    count = len(lines)
    batches = len(_section_rows(lines, "並行批次"))
    closed = sum(bool(CLOSED.search(r)) for r in _section_rows(lines, "工作包"))
    detail = f"狀態檔快照：{count} 行；並行批次 {batches} 列，可封存的已關閉工作包 {closed} 列。"

    code = 0
    if count <= args.soft_limit:
        print(f"{detail}在 {args.soft_limit} 行目標內。")
    elif count <= args.hard_limit:
        print(f"{detail}超過 {args.soft_limit} 行目標。")
        print("提醒：下次派工前把已關閉工作包、舊並行批次與舊判定移到 archive.md。")
    else:
        print(f"{detail}超過 {args.hard_limit} 行派工上限，不得開新工作包。")
        print("先保留 active／BLOCKED 工作包、當前候選版、最新核准變更與未解差異，再把其餘歷史移到 archive.md，重跑本檢查。")
        code = 1

    shown, open_items, legacy = acceptance(lines)
    if shown:
        print(f"驗收標準（每次派工前與判定後重看；{len(shown)} 條，未達成 {len(open_items)} 條）：")
        print("\n".join(shown))
    else:
        print("找不到「## 驗收標準」的條文：先把鎖定的驗收條文寫進狀態檔，才能派工與判定。")
    if legacy and shown:
        print("舊格式：驗收標準沒有狀態欄，無法核對完成宣稱；新任務請改用 templates/state.md 的逐條表。")
    approvals = [r for r in _section_rows(lines, "核准變更") if not _cells(r)[0].startswith("<")]
    if approvals:
        print(f"最新核准變更：{approvals[-1].strip()[:200]}")

    claimed, conditional = final_claim(lines)
    if conditional:
        print("最終判定寫了「附條件」：有條件沒達成就不是 PASS，改寫成「未完成」並把該條記成部分或待決。")
    if claimed and open_items:
        print("最終判定宣稱完成，但這些條目還不是 PASS 或核准不做：" + "、".join(open_items))
        print("改成「未完成」並列剩餘條目，或補證據後重跑；核准不做要先在核准變更記使用者原話與時間。")
    if (claimed and open_items) or conditional:
        code = code or 3
    return code


if __name__ == "__main__":
    raise SystemExit(main())

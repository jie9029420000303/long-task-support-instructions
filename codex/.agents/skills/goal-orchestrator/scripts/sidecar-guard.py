#!/usr/bin/env python3
"""檢查 Goal sidecar 是否仍是可快速重載的當前快照，並逐條重列驗收標準、核對完成宣稱與執行期資源收尾。

用法：python3 sidecar-guard.py <state.md> [--soft-limit 150] [--hard-limit 180]
輸出：先報容量，再印「驗收標準」逐條（條文與狀態）與最新一筆核准變更；每次派工前與判定後都執行，
主線因此每次重看條文原文。
exit：不超過 hard limit 且判定一致回 0；超過 hard limit 回 1；參數或檔案錯誤回 2；
「最終判定」宣稱 PASS／完成／達成，但逐條仍有不是 PASS 或「核准不做」的條目，或寫了「附條件」，回 3
（主線改判定或補證據後重跑；核准不做須附使用者原話與時間）。
執行期資源未收尾回 4：已判定工作包的資源還在跑、宣稱完成時 wp／final 資源還在跑、保留資源缺理由，或有未登記的
脫離程序／容器（核對邏輯在同目錄 resource-ledger.py）。優先序 1＞3＞4，所有訊息都印；不自動關閉任何資源。
本工具只報告、不自動改寫 state.md，避免錯誤封存未解工作；錯誤交主線修正，不等待使用者確認。
舊格式（驗收標準為編號清單、無狀態欄）照樣印出條文，但不核對完成宣稱。
"""

import argparse
import importlib.util
from pathlib import Path
import re


BATCH_ROW = re.compile(r"^\|\s*P\d+\s*\|")
CLOSED_WORK_ROW = re.compile(
    r"^\|\s*[A-Z]+\d+[A-Z0-9]*\s*\|.*\|\s*(?:PASS|FAIL|完成)\s*\|"
)
TABLE_ROW = re.compile(r"^\|(?!\s*:?-{3})")
DONE_STATES = {"PASS", "核准不做"}
CLAIM = re.compile(r"PASS|完成|達成|全部通過|全數通過")
NOT_CLAIM = re.compile(r"未完成|未達成|未達|未通過")


def section(lines, title):
    rows, inside = [], False
    for line in lines:
        if line.startswith("## "):
            inside = line[3:].strip().startswith(title)
            continue
        if inside:
            rows.append(line)
    return rows


def cells(line):
    return [c.strip().strip("*`").strip() for c in line.strip().strip("|").split("|")]


def acceptance(lines):
    """回傳 (要印出的條文列, 未達成條目, 是否舊格式)。"""
    table = [line for line in section(lines, "驗收標準") if TABLE_ROW.match(line)]
    if table and "狀態" in table[0]:
        head = cells(table[0])
        find = lambda key: next((i for i, h in enumerate(head) if h.startswith(key)), None)  # 開頭比對：狀態欄標題也含「核准不做」
        i_text, i_state, i_ok = find("條文"), find("狀態"), find("核准")
        pick = lambda row, i: row[i] if i is not None and i < len(row) else ""
        shown, unmet = [], []
        for line in table[1:]:
            row = cells(line)
            text = pick(row, i_text)
            if not text or text.startswith("<"):
                continue
            state, approval = pick(row, i_state), pick(row, i_ok)
            label = state or "未填"
            if state == "核准不做" and not approval:
                label = "核准不做（缺使用者原話與時間）"
            shown.append(f"  #{row[0]} [{label}] {text[:200]}")
            if state not in DONE_STATES or label != state:
                unmet.append(f"#{row[0]}［{label}］")
        return shown, unmet, False
    body = [line.strip() for line in section(lines, "驗收標準") if line.strip()]
    return [f"  {line[:200]}" for line in body[:20]], [], True


def final_claim(lines):
    text = " ".join(line.strip() for line in section(lines, "最終判定")
                    if line.strip() and not line.strip().startswith("<"))
    if not text or text.startswith("FAIL"):  # 「未完成」由 NOT_CLAIM 排除；FAIL 內文可能提到其餘已完成
        return False, "附條件" in text
    return bool(CLAIM.search(NOT_CLAIM.sub("", text))), "附條件" in text


def resource_ledger():
    spec = importlib.util.spec_from_file_location("resource_ledger", Path(__file__).with_name("resource-ledger.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def report_acceptance(lines, path=None, snapshot=None):
    shown, unmet, legacy = acceptance(lines)
    if shown:
        print(f"驗收標準（每次派工前與判定後重看；{len(shown)} 條，未達成 {len(unmet)} 條）：")
        print("\n".join(shown))
    else:
        print("找不到「## 驗收標準」的條文：先把鎖定的驗收條文寫進 sidecar，才能派工與判定。")
    if legacy and shown:
        print("舊格式：驗收標準沒有狀態欄，無法核對完成宣稱；新任務改用 templates/state.md 的逐條表。")
    approvals = [line for line in section(lines, "核准變更") if TABLE_ROW.match(line)][1:]
    approvals = [line for line in approvals if not cells(line)[0].startswith("<")]
    if approvals:
        print(f"最新核准變更：{approvals[-1].strip()[:200]}")
    claimed, conditional = final_claim(lines)
    if conditional:
        print("最終判定寫了「附條件」：有條件未達成就不是 PASS，改寫為「未完成」並把該條記為部分或待決。")
    if claimed and unmet:
        print("最終判定宣稱完成，但這些條目仍不是 PASS 或核准不做：" + "、".join(unmet))
        print("改為「未完成」並列出剩餘條目，或補證據後重跑；核准不做須先在核准變更記錄使用者原話與時間。")
    code = 3 if (claimed and unmet) or conditional else 0
    if path is not None:
        shown, problems = resource_ledger().audit(path, claimed=claimed, snapshot=snapshot)
        if shown:
            print("\n".join(shown))
        if problems:
            code = code or 4
    return code


def main(argv=None, snapshot=None):
    """snapshot 讓測試注入程序／容器實況；正式執行時由 resource-ledger.py 當場讀取。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state")
    parser.add_argument("--soft-limit", type=int, default=150)
    parser.add_argument("--hard-limit", type=int, default=180)
    args = parser.parse_args(argv)
    if args.soft_limit < 1 or args.hard_limit < args.soft_limit:
        parser.error("limits must satisfy 1 <= soft-limit <= hard-limit")

    path = Path(args.state)
    if not path.is_file():
        print(f"讀不到 sidecar：{path}")
        return 2
    lines = path.read_text(encoding="utf-8").splitlines()
    line_count = len(lines)
    batches = sum(bool(BATCH_ROW.match(line)) for line in lines)
    closed_rows = sum(bool(CLOSED_WORK_ROW.match(line)) for line in lines)

    if line_count <= args.soft_limit:
        print(
            f"sidecar 快照：{line_count} 行，在 {args.soft_limit} 行目標內；"
            f"並行批次 {batches}，可封存的已關閉工作列 {closed_rows}。"
        )
        return report_acceptance(lines, path, snapshot)

    detail = (
        f"sidecar 快照：{line_count} 行，超過 {args.soft_limit} 行目標；"
        f"並行批次 {batches}，可封存的已關閉工作列 {closed_rows}。"
    )
    if line_count <= args.hard_limit:
        print(detail)
        print("下次派工前應移出舊批次、已關閉工作包與舊判定到 archive.md。")
        return report_acceptance(lines, path, snapshot)

    print(detail)
    print(
        f"已超過 {args.hard_limit} 行派工上限；先保留 active/BLOCKED/當前候選版/"
        "最新核准變更，再把其餘歷史移至 archive.md。"
    )
    report_acceptance(lines, path, snapshot)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

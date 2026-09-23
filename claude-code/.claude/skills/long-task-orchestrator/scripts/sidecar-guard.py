#!/usr/bin/env python3
"""狀態檔容量守門：檢查長任務 state.md 是否仍是派工前讀得起的當前快照。

用法：python3 sidecar-guard.py <狀態目錄>/state.md [--soft-limit 150] [--hard-limit 180]
輸出：<=150 行 exit 0；151–180 行 exit 0 並提醒下次派工前封存；>180 行 exit 1（不得開新工作包）；
      參數或檔案錯誤 exit 2。
只報告、不自動改寫 state.md：封存時保留 active／BLOCKED 工作包、當前候選版、最新核准變更與未解差異，
其餘（已關閉工作包、舊並行批次、舊判定、已取代的主線自做）由主線搬到同目錄 archive.md，不刪除或重寫歷史。
"""
import argparse
import re
from pathlib import Path

ROW = re.compile(r"^\|(?!\s*-{3})")
CLOSED = re.compile(r"PASS|FAIL|主線接手|關閉")


def _section_rows(lines, title):
    """回傳 `## <title>` 節內表格的資料列（去掉表頭與分隔列）。"""
    rows, inside = [], False
    for line in lines:
        if line.startswith("## "):
            inside = line[3:].strip().startswith(title)
            continue
        if inside and ROW.match(line):
            rows.append(line)
    return rows[1:]  # 第一列是表頭


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

    if count <= args.soft_limit:
        print(f"{detail}在 {args.soft_limit} 行目標內。")
        return 0
    if count <= args.hard_limit:
        print(f"{detail}超過 {args.soft_limit} 行目標。")
        print("提醒：下次派工前把已關閉工作包、舊並行批次與舊判定移到 archive.md。")
        return 0
    print(f"{detail}超過 {args.hard_limit} 行派工上限，不得開新工作包。")
    print("先保留 active／BLOCKED 工作包、當前候選版、最新核准變更與未解差異，再把其餘歷史移到 archive.md，重跑本檢查。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

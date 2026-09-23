#!/usr/bin/env python3
"""檢查 Goal sidecar 是否仍是可快速重載的當前快照。

用法：python3 sidecar-guard.py <state.md> [--soft-limit 150] [--hard-limit 180]
輸出：不超過 hard limit 回 exit 0；超過 hard limit 回 exit 1；參數或檔案錯誤回 exit 2。
本工具只報告、不自動改寫 state.md，避免錯誤封存未解工作。
"""

import argparse
from pathlib import Path
import re


BATCH_ROW = re.compile(r"^\|\s*P\d+\s*\|")
CLOSED_WORK_ROW = re.compile(
    r"^\|\s*[A-Z]+\d+[A-Z0-9]*\s*\|.*\|\s*(?:PASS|FAIL|完成)\s*\|"
)


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
        return 0

    detail = (
        f"sidecar 快照：{line_count} 行，超過 {args.soft_limit} 行目標；"
        f"並行批次 {batches}，可封存的已關閉工作列 {closed_rows}。"
    )
    if line_count <= args.hard_limit:
        print(detail)
        print("下次派工前應移出舊批次、已關閉工作包與舊判定到 archive.md。")
        return 0

    print(detail)
    print(
        f"已超過 {args.hard_limit} 行派工上限；先保留 active/BLOCKED/當前候選版/"
        "最新核准變更，再把其餘歷史移至 archive.md。"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

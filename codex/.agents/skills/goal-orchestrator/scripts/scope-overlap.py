#!/usr/bin/env python3
"""並行派工閘：比對工作包的「可修改範圍」與「共用資源」。

用法：python3 scope-overlap.py <wp/*.md ...>
      加 --in-flight <檔...> 把在途工作包一併納入比對。
輸出：有交集 exit 1，無交集 exit 0，缺必要段落 exit 2。

[工作區]：必填 ``path:``、``worktree:`` 與 ``base:``；相同 path 或 worktree 視為交集，
base 可相同。
[可修改範圍]：每行寫一個完整路徑或資料標記；``dir/**`` 與 ``dir/*``
分別覆蓋所有後代與單層後代。路徑以整行解析，不會把 ``.worktrees``
誤切成 ``.worktree``。
[共用資源]：只寫實際會使用、讀取、鎖定或改動的 ``鍵:值``。「不使用」、
「不安裝」、「不修改」等禁止值不是資源占用，會被忽略；禁止事項應寫在
[禁止事項]。
"""

import collections
import os
import re
import sys


SECTION = re.compile(r"\[可修改範圍\](.*?)(?=\n\[|\n## |\Z)", re.S)
SHARED = re.compile(r"\[共用資源\](.*?)(?=\n\[|\n## |\Z)", re.S)
WORKSPACE = re.compile(r"\[工作區\](.*?)(?=\n\[|\n## |\Z)", re.S)
TAG = re.compile(r"(表|資料|帳號|table|data|account)[:：]([\w\-.]+)", re.I)
RESOURCE = re.compile(r"^([A-Za-z\u4e00-\u9fff_]+)[:：](.+)$")
BULLET = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)")
NEGATIVE_VALUES = {
    "",
    "-",
    "n/a",
    "na",
    "none",
    "null",
    "disabled",
    "無",
    "不使用",
    "不安裝",
    "不修改",
    "不啟動",
    "不接觸",
    "不共用",
    "禁止",
    "not-used",
    "not_use",
    "not-use",
}


def _clean_line(line):
    line = BULLET.sub("", line.strip())
    if line.startswith("`") and line.endswith("`") and len(line) >= 2:
        line = line[1:-1].strip()
    return line


def _is_path(value):
    if "/" not in value:
        return False
    if value.endswith(("/**", "/*")):
        return True
    base = value.rsplit("/", 1)[-1]
    return "." in base


def _scope_items(body):
    items = set()
    for raw in body.splitlines():
        line = _clean_line(raw)
        if not line or line.lower() in {"無", "none"}:
            continue
        for key, value in TAG.findall(line):
            items.add(f"{key.lower()}:{value}")
        if _is_path(line):
            items.add(line)
    return items


def _shared_items(body):
    items = set()
    for raw in body.splitlines():
        line = _clean_line(raw)
        if not line or line.lower() in {"無", "none"}:
            continue
        match = RESOURCE.match(line)
        if not match:
            continue
        key = match.group(1).strip().lower()
        for raw_value in match.group(2).split("|"):
            value = raw_value.strip().strip("`").lower()
            if value in NEGATIVE_VALUES or value.startswith("不"):
                continue
            items.add(f"共用:{key}:{value}")
    return items


def _workspace_items(body):
    values = {}
    for raw in body.splitlines():
        line = _clean_line(raw)
        match = RESOURCE.match(line)
        if match:
            values[match.group(1).strip().lower()] = match.group(2).strip().strip("`")
    missing = [key for key in ("path", "worktree", "base") if not values.get(key)]
    if missing:
        return None, "工作區:" + ",".join(missing)
    if not os.path.isabs(values["path"]):
        return None, "工作區:path 必須是絕對路徑"
    return {
        f"共用:工作區路徑:{values['path'].lower()}",
        f"共用:worktree:{values['worktree'].lower()}",
    }, None


def scope_of(path):
    """回傳 (項目集合, 缺哪一段)；缺段回 (None, 段名)。"""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    section = SECTION.search(text)
    if not section:
        return None, "可修改範圍"
    shared = SHARED.search(text)
    if not shared:
        return None, "共用資源"
    workspace = WORKSPACE.search(text)
    if not workspace:
        return None, "工作區"
    workspace_items, missing = _workspace_items(workspace.group(1))
    if workspace_items is None:
        return None, missing
    return (
        _scope_items(section.group(1))
        | _shared_items(shared.group(1))
        | workspace_items,
        None,
    )


def covers(left, right):
    """left 是否覆蓋 right（相等，或 left 是 dir/** / dir/* 前綴）。"""
    if left == right:
        return True
    for suffix in ("/**", "/*"):
        if left.endswith(suffix):
            prefix = left[: -len(suffix)] + "/"
            if right.startswith(prefix):
                return suffix == "/**" or "/" not in right[len(prefix) :]
    return False


def main(argv):
    files, in_flight = [], []
    current = files
    for argument in argv:
        if argument == "--in-flight":
            current = in_flight
            continue
        current.append(argument)
    if not files:
        print(__doc__)
        return 2

    scopes = {}
    for filename in files + in_flight:
        scope, missing = scope_of(filename)
        if scope is None:
            print(
                f"讀不到 [{missing}] 段：{filename}"
                f"（沒有共用資源也要寫「[共用資源] 無」）"
            )
            return 2
        scopes[filename] = scope

    names = list(scopes)
    hits = collections.defaultdict(set)
    for index, left_name in enumerate(names):
        for right_name in names[index + 1 :]:
            if left_name in in_flight and right_name in in_flight:
                continue
            for left in scopes[left_name]:
                for right in scopes[right_name]:
                    if covers(left, right) or covers(right, left):
                        key = left if covers(left, right) else right
                        hits[key].update(
                            {os.path.basename(left_name), os.path.basename(right_name)}
                        )

    if not hits:
        print(
            f"並行派工閘：{len(files)} 包（另 {len(in_flight)} 包在途）"
            "可修改範圍與實際共用資源無交集，可並行。"
        )
        return 0

    print(f"並行派工閘：發現 {len(hits)} 個交集，不得同批並行——")
    for key in sorted(hits):
        print(f"  - {key} → {', '.join(sorted(hits[key]))}")
    print(
        "處置：使用相互隔離的 worktree/帳號/服務，或把後派工作包改為依序；"
        "改完後重跑本檢查。"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

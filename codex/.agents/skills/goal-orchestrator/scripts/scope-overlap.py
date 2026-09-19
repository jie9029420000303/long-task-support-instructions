#!/usr/bin/env python3
"""並行派工閘：比對多個工作包 prompt 檔的「可修改範圍」與「共用資源」，找出交集。

用法：python3 scope-overlap.py <wp/*.md ...>
      加 --in-flight <檔...> 把在途工作包一併納入比對。
輸出：每個交集項與它出現的工作包；有交集 exit 1，無交集 exit 0，讀不到「可修改範圍」或「共用資源」段 exit 2。
[可修改範圍]：認路徑類項目（含 / 且以副檔名、`/**`、`/*` 結尾）；`dir/**`、`dir/*` 視為前綴，涵蓋其下所有路徑；
  資料表、測試資料、帳號等非路徑項目用 `表:<名>`、`資料:<名>`、`帳號:<名>` 寫法。
[共用資源]：所有 `鍵:值` 標記（全形冒號也可），同名即交集，例如 `瀏覽器:playwright`、`套件:安裝`、`migration:134`、`服務:3300`、`DB:ops_acceptance`、`帳號:ceo`；寫「無」代表沒有。
"""
import re, sys, collections, os

SECTION = re.compile(r"\[可修改範圍\](.*?)(?=\n\[|\n## |\Z)", re.S)
SHARED = re.compile(r"\[共用資源\](.*?)(?=\n\[|\n## |\Z)", re.S)
KV = re.compile(r"([A-Za-z\u4e00-\u9fff_]+)[:：]([\w\-.|/]+)")
PATH = re.compile(r"(?<![\w./])((?:(?:[\w()\[\]\-]+/)+)?(?:[\w()\[\]\-]+\.[A-Za-z0-9]{1,8}|(?:[\w()\[\]\-]+/)+(?:\*\*|\*)))")
TAG = re.compile(r"(?:表|資料|帳號|table|data|account)[:：]([\w\-.]+)")

def scope_of(path):
    """回傳 (項目集合, 缺哪一段)；缺段回 (None, 段名)。"""
    text = open(path, encoding="utf-8").read()
    m = SECTION.search(text)
    if not m:
        return None, "可修改範圍"
    body = m.group(1)
    items = set(PATH.findall(body))
    items |= {f"{k}:{v}" for k, v in re.findall(r"(表|資料|帳號|table|data|account)[:：]([\w\-.]+)", body)}
    s = SHARED.search(text)
    if not s:
        return None, "共用資源"
    shared = s.group(1)
    for k, v in KV.findall(shared):
        key = k.strip().lower()
        for val in v.split("|"):
            items.add(f"共用:{key}:{val.strip().lower()}")
    return items, None

def covers(a, b):
    """a 是否涵蓋 b（相等，或 a 是 dir/** / dir/* 前綴）。"""
    if a == b:
        return True
    for suf in ("/**", "/*"):
        if a.endswith(suf):
            prefix = a[: -len(suf)] + "/"
            if b.startswith(prefix):
                return suf == "/**" or "/" not in b[len(prefix):]
    return False

def main(argv):
    files, in_flight = [], []
    cur = files
    for a in argv:
        if a == "--in-flight":
            cur = in_flight; continue
        cur.append(a)
    if not files:
        print(__doc__); return 2
    scopes = {}
    for f in files + in_flight:
        s, missing = scope_of(f)
        if s is None:
            print(f"讀不到 [{missing}] 段：{f}（沒有共用資源也要寫「[共用資源] 無」）"); return 2
        scopes[f] = s
    names = list(scopes)
    hits = collections.defaultdict(set)
    for i, x in enumerate(names):
        for y in names[i + 1:]:
            if x in in_flight and y in in_flight:
                continue  # 兩個都在途，已派出，不再重比
            for a in scopes[x]:
                for b in scopes[y]:
                    if covers(a, b) or covers(b, a):
                        key = a if covers(a, b) else b
                        hits[key].update({os.path.basename(x), os.path.basename(y)})
    if not hits:
        print(f"並行派工閘：{len(files)} 包（另 {len(in_flight)} 包在途）可修改範圍與共用資源無交集，可並行。")
        return 0
    print(f"並行派工閘：發現 {len(hits)} 個交集，不得同批並行——")
    for k in sorted(hits):
        print(f"  - {k} → {', '.join(sorted(hits[k]))}")
    print("處置：後派的一包加依賴改依序，或把共用項切給唯一一包並在另一包 prompt 寫明不改；同一瀏覽器工具的介面包一次只跑一個；改完重跑本檢查。")
    return 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""並行派工閘：比對多個工作包 prompt 檔的「工作區」「可修改範圍」與「共用資源」，找出交集。

用法：python3 scope-overlap.py <wp/*.md ...>
      加 --in-flight <檔...> 把在途工作包一併納入比對。
輸出：每個交集項與它出現的工作包；有交集 exit 1，無交集 exit 0，缺必要段或 [工作區] 欄位不合格 exit 2。
[工作區]：每行一個 `鍵:值`，必填 `path:<絕對路徑>`、`worktree:<唯一識別值>`、`base:<commit 或 SHA-256>`；
  相同 path 或相同 worktree 即交集，base 相同可並行。只讀／只寫 evidence 的包以自己的 evidence 目錄當工作區。
[可修改範圍]：認路徑類項目（含 / 且以副檔名、`/**`、`/*` 結尾，或無目錄前綴的檔名）；路徑以空白與標點切成完整 token，
  `.worktrees` 這類含點的目錄不會被截斷；`dir/**`、`dir/*` 視為前綴，涵蓋其下所有路徑／單層路徑；
  資料表、測試資料、帳號等非路徑項目用 `表:<名>`、`資料:<名>`、`帳號:<名>` 寫法。
[共用資源]：只寫實際會讀取、鎖定或改動的 `鍵:值` 正值（全形冒號也可），同名即交集，例如 `瀏覽器:playwright`、
  `套件:安裝`、`migration:134`、`服務:3300`、`DB:ops_acceptance`、`帳號:ceo`、`議題:<slug>`；寫「無」代表沒有。
  「不使用／不安裝／不修改／不啟動」等否定值不算占用，會被忽略（禁止事項寫在 [禁止事項]）。
"""
import re, sys, collections, os

SECTION = re.compile(r"\[可修改範圍\](.*?)(?=\n\[|\n## |\Z)", re.S)
SHARED = re.compile(r"\[共用資源\](.*?)(?=\n\[|\n## |\Z)", re.S)
WORKSPACE = re.compile(r"\[工作區\](.*?)(?=\n\[|\n## |\Z)", re.S)
KV = re.compile(r"([A-Za-z一-鿿_]+)[:：]([\w\-.|/]+)")
TAG = re.compile(r"(表|資料|帳號|table|data|account)[:：]([\w\-.]+)")
LINE_KV = re.compile(r"^([A-Za-z一-鿿_]+)[:：](.+)$")
BULLET = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)")
# 路徑 token 的分隔：空白、反引號、引號與全形／半形標點（含半形逗號分號，不含 . / * - _ ( ) [ ]）
TOKEN_SPLIT = re.compile(r"[\s`'\"，、。；：（）「」『』《》〈〉,;]+")
FILE = re.compile(r"^[^/:]*[^/:.]\.[A-Za-z0-9]{1,8}$")
TRAILING_NOTE = re.compile(r"\([^/()]*\)?$")
BASE = re.compile(r"^[0-9a-fA-F]{7,64}$")
NEGATIVE = {"", "-", "無", "none", "n/a", "na", "null", "disabled", "禁止", "not-used", "not_use", "not-use"}


def _clean(line):
    return BULLET.sub("", line.strip())


def _is_path(token):
    """完整 token 是否為路徑：dir/** 或 dir/*、含 / 且末段有副檔名、或無目錄前綴的檔名。"""
    if ":" in token or token.startswith("<"):
        return False
    if "/" in token:
        if token.endswith(("/**", "/*")):
            return True
        return bool(FILE.match(token.rsplit("/", 1)[-1]))
    return bool(FILE.match(token))


def _scope_items(body):
    items = set()
    for raw in body.splitlines():
        line = _clean(raw)
        if not line or line.lower() in {"無", "none"}:
            continue
        items |= {f"{k}:{v}" for k, v in TAG.findall(line)}
        for tok in TOKEN_SPLIT.split(line):
            tok = tok.strip().rstrip(".")
            if tok.startswith("./"):
                tok = tok[2:]
            if not _is_path(tok):
                tok = TRAILING_NOTE.sub("", tok)  # src/a.py(新增) → src/a.py；app/(auth)/x.tsx 不受影響
            if _is_path(tok):
                items.add(tok)
    return items


def _shared_items(body):
    items = set()
    for k, v in KV.findall(body):
        key = k.strip().lower()
        for val in v.split("|"):
            val = val.strip().lower()
            if val in NEGATIVE or val.startswith("不"):
                continue  # 否定值是禁止事項，不是資源占用
            items.add(f"共用:{key}:{val}")
    return items


def _workspace_items(body):
    """回傳 (項目集合, 錯誤)；path 必須是絕對路徑，base 必須是 commit 或 SHA-256。"""
    values = {}
    for raw in body.splitlines():
        m = LINE_KV.match(_clean(raw))
        if m:
            values[m.group(1).strip().lower()] = m.group(2).strip().strip("`").strip()
    missing = [k for k in ("path", "worktree", "base") if not values.get(k)]
    if missing:
        return None, "[工作區] 缺 " + "／".join(missing)
    path = values["path"]
    if not os.path.isabs(path):
        return None, f"[工作區] path 必須是絕對路徑（目前：{path}）"
    if not BASE.match(values["base"]):
        return None, f"[工作區] base 必須是 commit 或 SHA-256（目前：{values['base']}）"
    path = os.path.normpath(path).lower()
    return {f"共用:工作區路徑:{path}", f"共用:worktree:{values['worktree'].lower()}"}, None


def scope_of(path):
    """回傳 (項目集合, 缺哪一段或欄位錯誤)；不合格回 (None, 說明)。"""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    m = SECTION.search(text)
    if not m:
        return None, "缺 [可修改範圍] 段"
    s = SHARED.search(text)
    if not s:
        return None, "缺 [共用資源] 段"
    w = WORKSPACE.search(text)
    if not w:
        return None, "缺 [工作區] 段"
    ws, err = _workspace_items(w.group(1))
    if ws is None:
        return None, err
    return _scope_items(m.group(1)) | _shared_items(s.group(1)) | ws, None


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
            print(f"工作包不合格：{f}——{missing}（沒有共用資源也要寫「[共用資源] 無」；舊工作包先補 [工作區] 再比對，不猜測隔離狀態）")
            return 2
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
        print(f"並行派工閘：{len(files)} 包（另 {len(in_flight)} 包在途）工作區、可修改範圍與實際共用資源無交集，可並行。")
        return 0
    print(f"並行派工閘：發現 {len(hits)} 個交集，不得同批並行——")
    for k in sorted(hits):
        print(f"  - {k} → {', '.join(sorted(hits[k]))}")
    print("處置：B 技術包改用綁定同一 base 的隔離 worktree 與獨立測試資源；仍無法隔離就把後派的一包加依賴改依序，或把共用項切給唯一一包並在另一包 prompt 寫明不改；同一瀏覽器工具的介面包一次只跑一個；改完重跑本檢查。")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

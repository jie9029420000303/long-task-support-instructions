#!/usr/bin/env python3
"""執行期資源帳本：長任務啟動、會活過當下回合的資源一律在此登記、收尾與核對。

為什麼：並行派工閘只管「誰在用」，沒人管「誰負責關」。2026-09-30 實測一台 16GB 機器記憶體需求 39.8GB、
swap 97%：已結束的長任務留下 50 個容器（佔 Docker 95% CPU），dev server 與預覽 server 活了 10 小時到 30 天，
6 個手寫等待迴圈沒有逾時、空轉 12–23 小時。

用法（帳本預設 <狀態目錄>/resources.json；--ledger 可改放別處，例如一般對話的預覽 server）：
  start    --state S --wp ID [--close wp|final|acceptance|external] [--reason 文字] [--ttl 72h] [--port N]
           [--cwd DIR] -- 指令…
           以獨立 process group 啟動並登記，日誌在帳本旁 resources/<id>.log；--ttl 到期自動關。
           close：wp＝所屬工作包判定後關（預設）；final＝宣稱完成前關；acceptance＝最終候選版預覽留給使用者驗收
           （須 --reason，未給 --ttl 時 72h）；external＝不屬本任務、只登記不關（須 --reason）。
  register --state S --wp ID (--pid N | --compose-project 名 | --container 名) [--close …] [--reason …]
           [--ttl 72h] 登記自己脫離的資源（docker compose up -d、已在跑的程序）；--ttl 只記到期時間、不自動關。
           --worktree 路徑：登記工作包專用的 git worktree，供判定後移除。
           --workdir 路徑 [--keep 樣式]…：登記非 git 的工作包資料夾，供判定 PASS 後 prune 清過程檔；--keep 是相對於
           資料夾的檔名樣式（例如 DONE、result*.json、scripts/*），符合的 prune 一律不刪。
  tmpdir   --state S --wp ID
           建立並登記這個工作包自己的暫存資料夾，只印出路徑：TMPDIR="$(… tmpdir --state S --wp ID)" 再跑測試。
           位置在 /tmp/lt-<任務代碼>/<工作包>（路徑短，unix socket 放得下；LONG_TASK_TMP_BASE 可換掉 /tmp）。
           工作包判定後 stop --wp ID 會把它整個刪掉並記入 deletions.md；還有程序在用就不刪、回 4。
  run-container --state S --wp ID --name 名 --ttl 4h [--close …] [--reason …] [--memory 1g] [--protect]
           -- <docker run 的其餘參數與映像>
           單一容器一律用這個：一步完成 docker run -d、貼上任務／工作包／關閉時點／帳本位置四個標籤、登記與到期時間。
           到期（從建立或最後一次 renew 起算）由背景計時自動「停止」這一個容器，不刪除；記憶體資料庫與正式資料副本
           （參數含 tmpfs，或加 --protect）不自動停，只由主線 stop。
           參數裡還不存在的具名資料卷（-v 名:/路徑、--mount source=名）先帶同一組標籤建立；已存在的不動。
  register --image-repo 映像庫 [--host 主機] [--keep 標籤或映像 ID]…：登記這個任務建的映像庫（本機或遠端）。
  register --container 名 --host 主機：登記遠端主機上用 ssh 起的容器（已停止的也可），stop 與移除都經同一台主機。
  prune-images --state S --id R [--keep 標籤或映像 ID]…
           新候選部署並讀回後刪舊映像：保留最新兩版（部署中與上一版）、容器在用、登記或這次指定保留的版本，以及任務
           開始前就有的；其餘每筆先記進 deletions.md、刪後讀回。
  renew    --state S --id R --ttl 4h
           還要用就續期，到期時間從現在起算；重開機後要繼續用的容器也用它重新掛上計時。
  stop     --state S (--id R | --wp ID | --all) [--include-acceptance] [--remove [--integrated-into REF]]
           關閉並核對已停止；只動帳本內、啟動時間核對相符的資源，external 不動。
           --remove：停止後移除（容器連同匿名資料卷；worktree 另須 --integrated-into 候選版的 commit 或分支，分支不刪）。
           只移除所屬工作包已判定 PASS、且識別值不在驗收結果帳、evidence/ 與決策帳裡的資源；每筆先記進 deletions.md、
           刪後讀回。FAIL 或還沒判定的只停不刪。
  prune    --state S --wp ID [--search 路徑]… (-- 過程檔… | --none --reason 文字)
           工作包判定 PASS 後，真的刪掉（不進垃圾桶）它登記的工作資料夾裡可重建的過程檔：輸入複本、演練工作區、
           被新版取代的整套輸出、建置產物。路徑可寫絕對路徑或相對於該資料夾。逐項核對：在登記的資料夾裡面（不含資料夾
           本身）、不符合 --keep、沒被驗收結果帳、evidence/ 與決策帳引用、沒有程序在用；每筆先記進 deletions.md、
           刪後讀回，不符的保留並說明。FAIL 或還沒判定的一律不刪。沒有可刪的用 --none --reason 記一筆。
  wait     --timeout 30m [--interval 20s] -- 查核指令…
           每隔 interval 跑一次查核指令，exit 0 就結束；逾時 exit 124。逾時必填。
  check    --state S [--final]
           印出帳本實況與未登記資源；需收尾時 exit 4。--final＝以「即將宣稱完成」的標準核對。
           sidecar-guard.py 每次派工前與判定後也跑同一段核對。
           任務期間建立、紀錄裡寫到卻沒登記的 worktree 也算需處理；--final 時已 PASS、乾淨、已整合（或已在遠端）
           且沒被證據引用的登記 worktree 要先 stop --remove，有未提交內容或未整合的列為保留、不擋。
           已判定工作包的任務暫存還在也算需處理；--final 時已 PASS 的登記工作資料夾要先 prune（或 --none）。
           任務期間建立、紀錄裡寫到卻沒登記的非 git 工作資料夾只列出、不算需處理。
  reap     --state S [--dry-run]
           關掉殘留的測試瀏覽器：四項全符合才關——父程序已結束、工作目錄在本任務範圍、--user-data-dir 在系統暫存目錄、
           啟動時間在任務建立之後。自成一組的連同輔助程序整組關，關前關後記進 reaped.jsonl。宣稱完成前必跑。
exit：0 通過；2 參數或檔案錯誤；4 有資源需要收尾或登記（reap：有沒關掉的）；124 wait 逾時。
check 與守門只報告，不自動關閉任何資源；只有主線明確執行 stop、reap 才會關。未登記資源＝在「任務建立」到「狀態檔最後寫入」之間啟動、已脫離 session（父程序是 1）、
同一使用者、非 launchd 常駐、工作目錄在任務範圍內的程序，以及 compose working_dir 在同範圍內或帶
`lt.task=<任務目錄名>` 標籤的容器；已登記在任何任務帳本（含 external）的資源不列。另外只列出、不算需處理的兩種：
本任務已停止卻還沒移除的容器，以及任務期間啟動、沒有任務標籤、不屬 compose、也不在任何帳本裡的執行中容器
（2026-11-14：4 個沒標籤的容器與 316 個已停止容器，守門原本看不到）。
每本帳本的位置記在本機的 <LONG_TASK_HOME 或 ~/.config/long-task-supervisor>/ledgers.json（不同步雲端），讓不同專案的
任務也認得彼此登記過的資源；索引只用來找帳本，內容仍以各帳本與系統實況為準。
任務範圍＝專案根＋任務紀錄（state.md、archive.md、wp/*.md）裡的 `path:` 工作區＋紀錄裡提到的同 repo worktree
——整合候選版的 worktree 不屬任何工作包、已結束的工作包會封存進 archive.md，只看工作包表會漏掉這兩種。
時間上限用任務紀錄最後寫入（狀態檔與 wp/*.md 取較晚者）：主線本來就是先更新紀錄再跑守門；2026-10-15 起狀態檔只在
送驗、判定、發版節點改寫，派出與收回只改工作包檔的 [狀態] 行，所以兩者都算。已結案或被 git 帶進其他 worktree 的舊紀錄
停在當時，之後才啟動的程序不歸給它（2026-09-30 對 202 份真實狀態檔實測：沒有這個上限時 6 份舊任務被誤報）。
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

CLOSE_KINDS = ("wp", "final", "acceptance", "external")
NEEDS_REASON = {"acceptance", "external"}
ACCEPTANCE_TTL = 72 * 3600
ROW = re.compile(r"^\|(?!\s*:?-{3})")
# 「主線接手」是 v1.14.0 以前狀態檔的判定字樣，舊紀錄照樣視為已判定未通過。
JUDGED = re.compile(r"PASS|FAIL|主線接手")
PASSED = re.compile(r"PASS")
NOT_PASSED = re.compile(r"FAIL|主線接手")
CREATED = re.compile(r"建立[：:]\s*(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})")
PATH_FIELD = re.compile(r"path:\s*(/[^\s|／，；;、`]+)")
PATH_TOKEN = re.compile(r"(?:^|[\s:：])(/[^\s|／，；;、`]+)")
DURATION = re.compile(r"^(\d+(?:\.\d+)?)([smhd]?)$")
UNITS = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}
C_ENV = dict(os.environ, LC_ALL="C", LANG="C")
# ps 的 lstart 要英文格式才解析得了，command 要 UTF-8 才不會把中文路徑轉成 M-fM^H… 跳脫碼。
UTF8 = "en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8"
PS_ENV = dict(os.environ, LC_ALL=UTF8, LANG=UTF8)
DOCKER_FORMAT = "\t".join([
    "{{.ID}}", "{{.Names}}", "{{.CreatedAt}}", '{{.Label "com.docker.compose.project"}}',
    '{{.Label "com.docker.compose.project.working_dir"}}', '{{.Label "lt.task"}}',
])
# 含已停止容器的完整清單，另帶狀態與 run-container 貼的身分標籤。
ALL_FORMAT = "\t".join([DOCKER_FORMAT, "{{.State}}", '{{.Label "lt.wp"}}', '{{.Label "lt.close"}}',
                        '{{.Label "lt.ledger"}}'])
LABELS = ("task", "wp", "close", "ledger")
# 測試自己開的瀏覽器主程序（Playwright、Stagehand 等的 Chrome for Testing／Chromium）。輔助程序（… Helper）不在內，
# 它們跟著主程序的 process group 一起收。使用者自己的瀏覽器不帶暫存 profile，不會被認成測試瀏覽器。
BROWSER_NAMES = {"Google Chrome for Testing", "Chromium", "Google Chrome", "Google Chrome Canary", "Microsoft Edge",
                 "chrome", "chromium", "chromium-browser", "chrome-headless-shell", "headless_shell"}
PROFILE = re.compile(r"--user-data-dir=(\S+)")
# 以資料夾存在與否判斷還在不在的資源：git 工作樹、非 git 的工作包資料夾、工作包自己的暫存資料夾。
FOLDER_KINDS = ("worktree", "workdir", "tmp")
# 不是 PASS 的容器停止後留給診斷的時數；之後先存不含環境變數的容器資訊、日誌留在主機上再移除（Jay 2026-11-28 2A）。
FAILED_KEEP_HOURS = 24
# 每個環境保留的映像：最新的兩個（部署中與上一版，退回用），另加容器在用與登記時指定保留的版本（Jay 2026-11-28 2A）。
IMAGE_KEEP_NEWEST = 2
DELETIONS_HEAD = ("# 刪除清冊\n\n| 時間 | 項目與識別 | 產生者 | 為何屬中間產物 | 引用搜尋結果 | 刪後讀回 |\n"
                  "|---|---|---|---|---|---|\n")


def duration(text):
    match = DURATION.match(str(text).strip().lower())
    if not match:
        raise argparse.ArgumentTypeError(f"時間要寫成 30s、20m、72h 這種格式：{text}")
    return float(match.group(1)) * UNITS[match.group(2)]


def human(seconds):
    seconds = int(seconds)
    for unit, size in (("天", 86400), ("小時", 3600), ("分", 60)):
        if seconds >= size and seconds % size == 0:
            return f"{seconds // size} {unit}"
    return f"{seconds} 秒"


def now():
    return dt.datetime.now().replace(microsecond=0)


def die(message):
    """參數或檔案錯誤：印給主線看，exit 2。"""
    print(message, file=sys.stderr)
    raise SystemExit(2)


# ---------- 帳本 ----------

def load(path):
    path = Path(path)
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"resources": []}


def local_home():
    """本機、不同步雲端的位置；與監督技能的通知設定、監看登記同一處。"""
    return Path(os.environ.get("LONG_TASK_HOME") or Path.home() / ".config" / "long-task-supervisor")


def temporary(path):
    tmp, real = os.path.realpath(tempfile.gettempdir()), os.path.realpath(path)
    return real == tmp or real.startswith(tmp.rstrip(os.sep) + os.sep)


def indexed_ledgers():
    try:
        known = json.loads((local_home() / "ledgers.json").read_text(encoding="utf-8")).get("ledgers", {})
    except (OSError, ValueError, AttributeError):
        return []
    return [Path(p) for p in known if os.path.isfile(p)]


def index_ledger(path):
    """把帳本位置記進全機索引。系統暫存目錄下的測試帳本不記（測試自己指定 LONG_TASK_HOME 時除外）；寫不進去不影響帳本。"""
    if temporary(path) and not os.environ.get("LONG_TASK_HOME"):
        return
    real, index = os.path.realpath(path), local_home() / "ledgers.json"
    try:
        index.parent.mkdir(parents=True, exist_ok=True)
        with open(str(index) + ".lock", "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            known = json.loads(index.read_text(encoding="utf-8")).get("ledgers", {}) if index.is_file() else {}
            if real in known:
                return
            known = {p: at for p, at in known.items() if os.path.isfile(p)}
            known[real] = now().isoformat()
            tmp = Path(str(index) + ".tmp")
            tmp.write_text(json.dumps({"ledgers": known}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, index)
    except (OSError, ValueError, AttributeError):
        pass


@contextlib.contextmanager
def locked(path):
    """鎖住帳本讀改寫；主線與子代理可能同時登記，所以一律經過檔案鎖與原子替換。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load(path)
        yield data
        tmp = Path(str(path) + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    index_ledger(path)


def ledger_of(args):
    if getattr(args, "ledger", None):
        return Path(args.ledger).expanduser()
    if getattr(args, "state", None):
        return Path(args.state).expanduser().parent / "resources.json"
    die("需要 --state <狀態目錄>/state.md 或 --ledger <帳本路徑>")


def next_id(data):
    used = {r.get("id") for r in data["resources"]}
    n = len(data["resources"]) + 1
    while f"r{n}" in used:
        n += 1
    return f"r{n}"


def mark_stopped(path, rid, note):
    with locked(path) as data:
        for res in data["resources"]:
            if res.get("id") == rid and not res.get("stopped_at"):
                res["stopped_at"] = now().isoformat()
                res["stop_note"] = note


def note_resource(path, rid, **fields):
    with locked(path) as data:
        for res in data["resources"]:
            if res.get("id") == rid:
                res.update(fields)


def expiry(ttl):
    return (now() + dt.timedelta(seconds=ttl)).isoformat() if ttl else None


def overdue(res):
    with contextlib.suppress(ValueError, TypeError):
        if res.get("expires_at") and dt.datetime.fromisoformat(res["expires_at"]) <= now():
            return f"；已過到期時間 {res['expires_at']}，還要用就 renew，不用就 stop"
    return ""


def arm_expiry(path, rid, seconds):
    """背景計時，到點呼叫 _expire 停止這一筆。工作目錄放 /：守門才不會把它當成任務範圍內未登記的程序。"""
    subprocess.Popen(
        ["/bin/sh", "-c", 'sleep "$1"; exec "$2" "$3" _expire --ledger "$4" --id "$5"', "lt-expire",
         str(int(seconds) + 1), sys.executable, str(Path(__file__).resolve()), str(path), rid],
        cwd="/", stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


# ---------- 系統實況 ----------

def ps_table():
    """{pid: {pid, ppid, pgid, uid, start, command}}；讀不到回空表。"""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,pgid=,uid=,lstart=,command="], capture_output=True, env=PS_ENV, timeout=30,
        ).stdout.decode("utf-8", "surrogateescape")
    except (OSError, subprocess.SubprocessError):
        return {}
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 9)
        if len(parts) < 9:
            continue
        try:
            pid, ppid, pgid, uid = map(int, parts[:4])
            start = dt.datetime.strptime(" ".join(parts[4:9]), "%a %b %d %H:%M:%S %Y")
        except ValueError:
            continue
        table[pid] = {"pid": pid, "ppid": ppid, "pgid": pgid, "uid": uid, "start": start,
                      "command": parts[9] if len(parts) > 9 else ""}
    return table


def cwds(pids):
    pids = sorted(set(pids))
    if not pids:
        return {}
    if Path("/proc/self/cwd").exists():
        found = {}
        for pid in pids:
            with contextlib.suppress(OSError):
                found[pid] = os.readlink(f"/proc/{pid}/cwd")
        return found
    try:
        out = subprocess.run(
            ["lsof", "-a", "-d", "cwd", "-p", ",".join(map(str, pids)), "-Fpn"],
            capture_output=True, env=C_ENV, timeout=60,
        ).stdout.decode("utf-8", "surrogateescape")
    except (OSError, subprocess.SubprocessError):
        return {}
    found, current = {}, None
    for line in out.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            current = int(line[1:])
        elif line.startswith("n") and current is not None:
            found[current] = line[1:]
    return found


def launchd_pids():
    """launchd 管理的常駐服務是使用者刻意開機常駐的，不屬任何任務。"""
    if sys.platform != "darwin":
        return set()
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    return {int(f[0]) for f in (line.split() for line in out.splitlines()[1:]) if f and f[0].isdigit()}


def docker_argv(host, *args):
    """本機直接跑 docker；指定主機時經 ssh 以 sudo -n docker 跑（2026-11-28：工區 E 在 Staging 起的容器沒有一個登記）。"""
    if not host:
        return ["docker", *args]
    remote = " ".join(shlex.quote(a) for a in ("sudo", "-n", "docker", *args))
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remote]


def _docker_ps(extra, fmt, host=None):
    try:
        result = subprocess.run(docker_argv(host, "ps", *extra, "--no-trunc", "--format", fmt),
                                capture_output=True, text=True, timeout=60 if host else 30)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    found = []
    for line in result.stdout.splitlines():
        f = line.split("\t")
        if len(f) < 6:
            continue
        try:
            created = dt.datetime.strptime(f[2][:25], "%Y-%m-%d %H:%M:%S %z").astimezone().replace(tzinfo=None)
        except ValueError:
            created = None
        item = {"id": f[0], "name": f[1], "created": created, "project": f[3], "working_dir": f[4], "task": f[5]}
        if len(f) >= 10:
            item.update(state=f[6], wp=f[7], close=f[8], ledger=f[9])
        found.append(item)
    return found


def docker_containers():
    """執行中的容器清單；docker 不可用時回 None（照實回報「沒掃」，不當成沒有）。"""
    return _docker_ps([], DOCKER_FORMAT)


def docker_all(host=None):
    """所有容器（含已停止），每筆另有 state 與 run-container 貼的 wp／close／ledger 標籤；docker 不可用時回 None。"""
    return _docker_ps(["-a"], ALL_FORMAT, host)


def host_containers(snap, host):
    """遠端主機執行中的容器，同一輪核對只問一次；本機用 snap 裡已讀的清單。"""
    if not host:
        return snap.get("containers")
    hosts = snap.setdefault("hosts", {})
    if host not in hosts:
        hosts[host] = _docker_ps([], DOCKER_FORMAT, host)
    return hosts[host]


def process_snapshot():
    """程序實況（不碰 docker）：脫離 session 的程序另補工作目錄。"""
    procs = ps_table()
    uid = os.getuid()
    detached = [p["pid"] for p in procs.values() if p["ppid"] == 1 and p["uid"] == uid]
    for pid, cwd in cwds(detached).items():
        procs[pid]["cwd"] = cwd
    return {"procs": procs, "uid": uid, "launchd": launchd_pids()}


def take_snapshot():
    snap = process_snapshot()
    everything = docker_all()
    running = None if everything is None else [c for c in everything if c.get("state") == "running"]
    snap.update(containers=running, all_containers=everything)
    return snap


def start_of(pid, procs=None):
    procs = procs if procs is not None else ps_table()
    info = procs.get(pid)
    return info["start"].isoformat() if info else None


def members(res, snap):
    """帳本資源目前還活著的程序；啟動時間對不上＝PID 已被別的程序重用，視為已結束。"""
    procs = snap["procs"]
    if res.get("pgid"):
        leader = procs.get(res["pgid"])
        if leader and leader["start"].isoformat() != res.get("start"):
            return []
        return [p["pid"] for p in procs.values() if p["pgid"] == res["pgid"]]
    pid = res.get("pid")
    info = procs.get(pid)
    if not info or info["start"].isoformat() != res.get("start"):
        return []
    tree, frontier = [pid], [pid]
    while frontier:
        parent = frontier.pop()
        for p in procs.values():
            if p["ppid"] == parent and p["pid"] not in tree:
                tree.append(p["pid"])
                frontier.append(p["pid"])
    return tree


def containers_of(res, snap):
    current = host_containers(snap, res.get("host"))
    if current is None:
        return None
    recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    return [c["id"] for c in current if c["id"] in recorded]


def container_candidates(res, snap):
    """用可讀名稱找現在的容器；只用於回報身分不符，不能當成停止目標。"""
    current = host_containers(snap, res.get("host"))
    if current is None:
        return None
    if res["kind"] == "compose":
        return [c for c in current if c["project"] == res["project"]]
    return [c for c in current if c["name"] == res["container"]]


def container_identity(c):
    created = c.get("created")
    return {"id": c["id"], "name": c["name"],
            "created": created.isoformat() if isinstance(created, dt.datetime) else created}


def inactive_note(res, snap):
    if res["kind"] == "worktree":
        return "工作樹已不存在（帳本尚未標記）"
    if res["kind"] in ("workdir", "tmp"):
        return "資料夾已不存在（帳本尚未標記）"
    if res["kind"] == "process":
        return "已不在執行（帳本尚未標記停止）"
    candidates = container_candidates(res, snap) or []
    recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    different = [c for c in candidates if c["id"] not in recorded]
    if different:
        names = "、".join(c["name"] for c in different[:4])
        return f"原登記身分已不在執行；目前同名／同專案容器身分不符（{names}），未動它們"
    return "已不在執行（帳本尚未標記停止）"


def alive(res, snap):
    """True／False；容器在 docker 不可用時回 None（無法確認）。"""
    if res["kind"] == "images":
        return True  # 映像登記不是常駐資源，由 prune-images 與 check 處理
    if res["kind"] in FOLDER_KINDS:
        return Path(res.get("path") or "").is_dir()
    if res["kind"] == "process":
        return bool(members(res, snap))
    found = containers_of(res, snap)
    return None if found is None else bool(found)


def describe(res):
    target = {
        "process": f"pid {res.get('pgid') or res.get('pid')}" + (f"、port {res['port']}" if res.get("port") else ""),
        "compose": f"compose 專案 {res.get('project')}",
        "container": f"容器 {res.get('container')}" + (f"（{res['host']}）" if res.get("host") else ""),
        "images": f"映像 {res.get('repo')}" + (f"（{res['host']}）" if res.get("host") else "（本機）"),
        "worktree": f"工作樹 {res.get('path')}",
        "workdir": f"工作資料夾 {res.get('path')}",
        "tmp": f"任務暫存 {res.get('path')}",
    }[res["kind"]]
    cmd = (res.get("command") or "")[:80]
    return f"{res['id']}［{res.get('wp')}／{res.get('close')}］{target}" + (f"：{cmd}" if cmd else "")


# ---------- 任務範圍 ----------

def _section(lines, title):
    out, inside = [], False
    for line in lines:
        if line.startswith("## "):
            inside = line[3:].strip().startswith(title)
            continue
        if inside:
            out.append(line)
    return out


def _cells(line):
    return [c.strip().strip("*`").strip() for c in line.strip().strip("|").split("|")]


def work_table(lines):
    table = [line for line in _section(lines, "工作包") if ROW.match(line)]
    if not table:
        return [], []
    return _cells(table[0]), [_cells(line) for line in table[1:] if not _cells(line)[0].startswith("<")]


def judged_packages(lines):
    head, rows = work_table(lines)
    i_state = next((i for i, h in enumerate(head) if h.startswith("狀態")), None)
    judged = set()
    for row in rows:
        state = row[i_state] if i_state is not None and i_state < len(row) else " ".join(row[1:])
        if JUDGED.search(state):
            judged.add(row[0])
    return judged


def workspace_paths(lines):
    head, rows = work_table(lines)
    i_ws = next((i for i, h in enumerate(head) if h.startswith("工作區")), None)
    paths = []
    for row in rows:
        cell = row[i_ws] if i_ws is not None and i_ws < len(row) else ""
        paths += PATH_FIELD.findall(cell) or PATH_TOKEN.findall(cell)
    return paths


def task_records(state):
    """任務自己的紀錄：狀態檔、封存檔與每個工作包 prompt（wp/*.md 的 [工作區] 由並行閘強制填寫）。"""
    texts = []
    for path in [state, state.parent / "archive.md", *sorted((state.parent / "wp").glob("*.md"))]:
        with contextlib.suppress(OSError, UnicodeDecodeError):
            texts.append(path.read_text(encoding="utf-8"))
    return "\n".join(texts)


def git_worktrees(root):
    try:
        out = subprocess.run(["git", "-C", str(root), "worktree", "list", "--porcelain"],
                             capture_output=True, timeout=30).stdout.decode("utf-8", "surrogateescape")
    except (OSError, subprocess.SubprocessError):
        return []
    return [line[len("worktree "):] for line in out.splitlines() if line.startswith("worktree ")]


def task_scope(state, lines):
    """回傳 (任務範圍路徑, 任務建立時間, 狀態檔最後寫入時間, 任務目錄名, 同 repo 的 worktree 清單)。"""
    task_dir = state.parent
    roots, worktrees = [], []
    if task_dir.parent.name == "long-task" and task_dir.parent.parent.name in (".claude", ".codex"):
        project = task_dir.parent.parent.parent
        roots.append(str(project))
        worktrees = git_worktrees(project)
    records = task_records(state)
    archive = state.parent / "archive.md"
    roots += workspace_paths(lines) + PATH_FIELD.findall(records)
    if archive.is_file():
        roots += workspace_paths(archive.read_text(encoding="utf-8").splitlines())
    roots += [w for w in worktrees if re.search(re.escape(w) + r"(?![\w.\-])", records)]
    created = CREATED.search("\n".join(lines[:12]))
    since = None
    if created:
        with contextlib.suppress(ValueError):
            since = dt.datetime.strptime(created.group(1), "%Y-%m-%d %H:%M")
    info = state.stat()
    if since is None:
        since = dt.datetime.fromtimestamp(getattr(info, "st_birthtime", info.st_mtime)).replace(microsecond=0)
    wp_dir = state.parent / "wp"
    latest = max([info.st_mtime] + ([p.stat().st_mtime for p in wp_dir.glob("*.md")] if wp_dir.is_dir() else []))
    until = dt.datetime.fromtimestamp(latest)
    return sorted({os.path.realpath(r) for r in roots}), since, until, task_dir.name, worktrees


def registered(state, worktrees=()):
    """所有任務帳本（本任務、同專案與同 repo 其他 worktree 的任務、全機索引記到的其他專案任務）裡還沒停止的資源；
    這些都有主人，不算未登記。"""
    keys = {"pids": set(), "pgids": set(), "projects": set(), "containers": set(), "ids": set(), "worktrees": set(),
            "workdirs": set()}
    ledgers = {state.parent / "resources.json"} | set(state.parent.parent.glob("*/resources.json"))
    for tree in worktrees:
        for pattern in (".claude/long-task/*/resources.json", ".codex/long-task/*/resources.json"):
            ledgers |= set(Path(tree).glob(pattern))
    if os.environ.get("LONG_TASK_HOME") or not temporary(state):  # 系統暫存目錄下的測試任務不讀這台機器真正的索引
        ledgers |= set(indexed_ledgers())
    for path in ledgers:
        with contextlib.suppress(OSError, ValueError):
            for res in load(path)["resources"]:
                if res.get("kind") == "workdir" and res.get("path"):  # 清過過程檔的也算登記過
                    keys["workdirs"].add(os.path.realpath(res["path"]))
                if res.get("stopped_at"):
                    continue
                if res.get("pgid"):
                    keys["pgids"].add(res["pgid"])
                if res.get("pid"):
                    keys["pids"].add(res["pid"])
                if res.get("project"):
                    keys["projects"].add(res["project"])
                if res.get("container"):
                    keys["containers"].add(res["container"])
                if res.get("kind") == "worktree" and res.get("path"):
                    keys["worktrees"].add(os.path.realpath(res["path"]))
                keys["ids"] |= {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    return keys


def inside(path, roots):
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots)


def temp_roots():
    return sorted({os.path.realpath(p) for p in (tempfile.gettempdir(), "/tmp", "/var/folders")})


def temp_browser(p):
    """暫存 profile 的測試瀏覽器主程序：回傳 profile 路徑；不是就回 None。"""
    command = p.get("command") or ""
    if os.path.basename(command.split(" --", 1)[0].rstrip()) not in BROWSER_NAMES:
        return None
    match = PROFILE.search(command)
    if not match:
        return None
    profile = match.group(1).strip("'\"")
    return profile if inside(profile, temp_roots()) else None


def detached_in_scope(roots, since, until, snap, keys):
    """任務期間啟動、已脫離對話（父程序是 1）、工作目錄在任務範圍內、不在任何帳本的程序。"""
    launchd = snap.get("launchd") or set()
    for p in snap["procs"].values():
        if p["ppid"] != 1 or p["uid"] != snap.get("uid", os.getuid()) or p["pid"] in launchd:
            continue
        if not since <= p["start"] <= until or p["pid"] in keys["pids"] or p["pgid"] in keys["pgids"]:
            continue
        if p.get("cwd") and roots and inside(p["cwd"], roots):
            yield p


def orphan_browsers(roots, since, until, snap, keys):
    """結案時可代關的殘留測試瀏覽器：四個條件全符合（使用者 2026-11-18 定案）——父程序已結束、工作目錄在本任務範圍、
    暫存 profile、啟動時間在任務期間。2026-11-17 一支測試逾時後，它自行開的 Chrome for Testing 活了 22 小時。"""
    return [dict(p, profile=temp_browser(p)) for p in detached_in_scope(roots, since, until, snap, keys) if temp_browser(p)]


def worktree_born(tree):
    with contextlib.suppress(OSError):
        info = os.stat(Path(tree) / ".git")
        return dt.datetime.fromtimestamp(getattr(info, "st_birthtime", info.st_mtime))
    return None


def new_worktrees(state, roots, since, until, worktrees, keys):
    """任務期間建立、紀錄裡寫到、卻沒登記的同 repo worktree（使用者 2026-11-18 定案：建立就登記、結案就移除；
    當天 ~/worktrees 287 個目錄、152GB，多數從沒登記，結案時沒人知道該收哪些）。"""
    main = os.path.realpath(worktrees[0]) if worktrees else None
    found = []
    for tree in worktrees[1:]:
        real = os.path.realpath(tree)
        mentioned = any(r == real or r.startswith(real + os.sep) for r in roots)
        if real == main or not mentioned or real in keys["worktrees"] or not Path(real).is_dir():
            continue
        born = worktree_born(real)
        if born and since <= born <= until:
            found.append(real)
    return found


def loose_workdirs(state, lines, since, until, worktrees, keys, project):
    """任務期間建立、紀錄的 path: 寫到、不是 git 工作樹、也沒登記的工作資料夾（使用者 2026-11-19 定案：工作包資料夾
    也要回收；當天工區 E 的實跑區 1,297 個已交件工作包、78.5GiB 沒有任何規則收）。只列出，不算需處理。"""
    trees = [os.path.realpath(w) for w in worktrees]
    skip = set(trees) | keys["workdirs"] | ({os.path.realpath(project)} if project else set())
    found = []
    for raw in sorted({os.path.realpath(p) for p in workspace_paths(lines) + PATH_FIELD.findall(task_records(state))}):
        if raw in skip or not os.path.isdir(raw) or os.path.exists(os.path.join(raw, ".git")) or inside(raw, trees):
            continue
        with contextlib.suppress(OSError):
            info = os.stat(raw)
            born = dt.datetime.fromtimestamp(getattr(info, "st_birthtime", info.st_mtime))
            if since <= born <= until:
                found.append(raw)
    return found


def leftover_worktree(res, state_dir, project):
    """宣稱完成時還在的登記 worktree：可以移除就回 None，要保留就回原因（未提交、未整合、不是 PASS、證據引用）。"""
    tree = res.get("path") or ""
    if package_passed(state_dir, res.get("wp")) is not True:
        return "所屬工作包不是 PASS，留作診斷"
    code, dirty = git(tree, "status", "--porcelain")
    if code != 0 or dirty.strip():
        return "有未提交或未追蹤的檔案"
    head = git(project, "rev-parse", "HEAD")[1].strip() if project else ""
    integrated = bool(head) and git(tree, "merge-base", "--is-ancestor", "HEAD", head)[0] == 0
    if not integrated and not git(tree, "branch", "-r", "--contains", "HEAD")[1].strip():
        return "提交還沒整合進專案，也不在任何遠端分支"
    used, search = referenced(state_dir, [tree])
    if used is not False:
        return search
    return None


def unregistered(roots, since, until, task, snap, keys):
    found = []
    for p in detached_in_scope(roots, since, until, snap, keys):
        tag = "（暫存 profile 的測試瀏覽器，reap 可收）" if temp_browser(p) else ""
        found.append(f"程序 pid {p['pid']}{tag}（{p['cwd']}）：{p['command'][:100]}")
    containers = snap.get("containers")
    if containers is None:
        return found, False
    projects = {}
    for c in containers:
        if (c["project"] and c["project"] in keys["projects"]) or c["name"] in keys["containers"]:
            continue
        if c["created"] and not since <= c["created"] <= until:
            continue
        if (c["working_dir"] and roots and inside(c["working_dir"], roots)) or (c["task"] and c["task"] == task):
            if c["project"]:
                projects.setdefault(c["project"], []).append(c["name"])
            else:
                found.append(f"容器 {c['name']}")
    for project, names in sorted(projects.items()):
        found.append(f"compose 專案 {project}（{len(names)} 個容器：{'、'.join(sorted(names)[:4])}{'…' if len(names) > 4 else ''}）")
    return found, True


def container_notes(since, until, task, snap, keys, own_ids):
    """只列出、不算需處理：無法確定歸屬的容器不能擋本任務派工，已停止的容器要等判定與引用核對後才可移除。"""
    everything = snap.get("all_containers")
    if everything is None:
        return []

    def names(found):
        return "、".join(sorted(found)[:4]) + ("…" if len(found) > 4 else "")

    notes = []
    stopped = [c["name"] for c in everything
               if c.get("state") != "running" and ((c["task"] and c["task"] == task) or c["id"] in own_ids)]
    if stopped:
        notes.append(f"  ・本任務已停止、尚未移除的容器 {len(stopped)} 個（{names(stopped)}）：所屬工作包判定 PASS 且已整合後 "
                     "stop --wp <id> --remove。")
    loose = [c["name"] for c in everything
             if c.get("state") == "running" and not c["task"] and not c["project"]
             and c["name"] not in keys["containers"] and c["id"] not in keys["ids"]
             and c["created"] and since <= c["created"] <= until]
    if loose:
        notes.append(f"  ・任務期間啟動、沒有任務標籤也不在任何帳本的執行中容器 {len(loose)} 個（{names(loose)}）：是本任務啟動的就 "
                     "register，不是就不必處理；之後單一容器一律用 run-container。")
    return notes


def audit(state, claimed=False, snapshot=None):
    """回傳 (要印的行, 需處理的問題)。狀態檔不在長任務目錄、沒有工作區也沒有帳本時不掃描、回空。"""
    state = Path(state)
    lines = state.read_text(encoding="utf-8").splitlines()
    data = load(state.parent / "resources.json")
    running = [r for r in data["resources"] if not r.get("stopped_at")]
    roots, since, until, task, worktrees = task_scope(state, lines)
    if not running and not roots:
        return [], []
    snap = snapshot or take_snapshot()
    judged = judged_packages(lines)
    task_dir = state.parent
    project = (str(task_dir.parent.parent.parent)
               if task_dir.parent.name == "long-task" and task_dir.parent.parent.name in (".claude", ".codex") else None)
    shown, problems = [], []
    for res in running:
        if res["kind"] == "images":
            plan = image_plan(res, since)
            if plan is None:
                shown.append(f"  {describe(res)}：讀不到這台主機的 docker，未核對")
            elif plan["remove"]:
                problems.append(f"{describe(res)}：有 {len(plan['remove'])} 個舊映像可刪（保留 {len(plan['keep'])} 個）；"
                                f"新候選部署並讀回後 prune-images --id {res['id']}")
            else:
                shown.append(f"  {describe(res)}：保留 {len(plan['keep'])} 個，沒有可刪的")
            continue
        state_now = alive(res, snap)
        if state_now is False:
            shown.append(f"  {describe(res)}：{inactive_note(res, snap)}")
            continue
        if res["kind"] == "worktree" and claimed and res.get("close") in ("wp", "final"):
            keep = leftover_worktree(res, task_dir, project)
            if keep:
                shown.append(f"  {describe(res)}：保留（{keep}）")
            else:
                problems.append(f"{describe(res)}：已 PASS、乾淨、已整合，宣稱完成前 stop --id {res['id']} --remove "
                                "--integrated-into <候選版 commit 或分支>（分支保留）")
        elif res["kind"] == "worktree":
            hint = "；工作包已判定，核對後可 stop --id … --remove --integrated-into <候選版>" if res.get("wp") in judged else ""
            shown.append(f"  {describe(res)}：仍在{hint}")
        elif res["kind"] == "tmp" and (res.get("wp") in judged or claimed):
            why = f"工作包 {res.get('wp')} 已判定" if res.get("wp") in judged else "最終判定宣稱完成"
            problems.append(f"{describe(res)}：{why}，任務暫存還在；stop --id {res['id']} 整個刪掉（還有程序在用的不會刪）")
        elif res["kind"] == "tmp":
            shown.append(f"  {describe(res)}：使用中，工作包判定後 stop --wp {res.get('wp')} 刪掉")
        elif res["kind"] == "workdir":
            passed = package_passed(task_dir, res.get("wp")) is True
            todo = (f"prune --wp {res.get('wp')} -- <可重建的過程檔…>；沒有可刪的用 prune --wp {res.get('wp')} "
                    "--none --reason <原因>")
            if passed and claimed:
                problems.append(f"{describe(res)}：已 PASS，過程檔還沒清，宣稱完成前 {todo}")
            else:
                shown.append(f"  {describe(res)}：仍在" + (f"；工作包已 PASS，{todo}" if passed else ""))
        elif res.get("close") in NEEDS_REASON and not res.get("reason"):
            problems.append(f"{describe(res)}：標為 {res.get('close')} 卻沒寫理由")
        elif res.get("close") == "wp" and res.get("wp") in judged:
            problems.append(f"{describe(res)}：工作包 {res.get('wp')} 已判定，資源還在跑")
        elif claimed and res.get("close") in ("wp", "final"):
            problems.append(f"{describe(res)}：最終判定宣稱完成，資源還在跑")
        else:
            note = "無法確認（docker 不可用）" if state_now is None else "執行中"
            reason = f"；理由：{res['reason']}" if res.get("reason") else ""
            shown.append(f"  {describe(res)}：{note}{reason}{overdue(res)}")
    # 已停止、還沒移除的容器（Jay 2026-11-28 2A）：判定 PASS 的現在移除，其餘停止滿 24 小時後移除。
    for res in data["resources"]:
        if res["kind"] != "container" or not res.get("stopped_at") or res.get("removed_at") or res.get("close") == "external":
            continue
        passed = package_passed(task_dir, res.get("wp"))
        if passed is True:
            problems.append(f"{describe(res)}：工作包已 PASS、容器已停止還沒移除；stop --id {res['id']} --remove")
        elif passed is False and stopped_hours(res) >= FAILED_KEEP_HOURS:
            problems.append(f"{describe(res)}：工作包不是 PASS，已停止 {FAILED_KEEP_HOURS} 小時以上；stop --id {res['id']} "
                            "--remove（先存容器資訊與日誌位置再移除）")
    keys = registered(state, worktrees)
    loose, scanned_containers = unregistered(roots, since, until, task, snap, keys)
    problems += [f"未登記 {item}" for item in loose]
    problems += [f"未登記 工作樹 {tree}：建好就 register --worktree；整合候選版等要留下的也登記（--wp 主線 --close final）"
                 for tree in new_worktrees(state, roots, since, until, worktrees, keys)]
    head = f"執行期資源：帳本 {len(running)} 筆未停止，需處理 {len(problems)} 筆"
    if roots and not scanned_containers:
        head += "；docker 不可用，容器沒有掃描"
    own_ids = {item["id"] for res in data["resources"] for item in res.get("container_identities", []) if item.get("id")}
    out = ([head + "。"] + shown + [f"  ✗ {p}" for p in problems]
           + container_notes(since, until, task, snap, keys, own_ids))
    folders = loose_workdirs(state, lines, since, until, worktrees, keys, project)
    if folders:
        names = "、".join(os.path.basename(f) for f in folders[:4]) + ("…" if len(folders) > 4 else "")
        out.append(f"  ・任務期間建立、沒登記的非 git 工作資料夾 {len(folders)} 個（{names}）：建立時 register --workdir <路徑> "
                   "--wp <id>，判定 PASS 後 prune 清掉可重建的過程檔。")
    if problems:
        out.append("先關閉（resource-ledger.py stop）、補登記（register），或改標 acceptance／external 並寫理由，"
                   "再重跑；守門只報告，不會自動關閉任何資源。")
    if any("reap 可收" in item for item in loose):
        out.append("暫存 profile 的測試瀏覽器：用 resource-ledger.py reap --state <狀態檔> 收掉（只關父程序已結束、"
                   "工作目錄在本任務範圍、任務期間啟動的那幾支）；宣稱完成前一定要跑一次。")
    return out, problems


# ---------- 子命令 ----------

def cmd_start(args):
    if args.close in NEEDS_REASON and not args.reason:
        die(f"--close {args.close} 必須附 --reason（寫明為什麼保留或是誰的資源）")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        die("缺少要啟動的指令：start … -- <指令>")
    ttl = args.ttl or (ACCEPTANCE_TTL if args.close == "acceptance" else 0)
    path = ledger_of(args)
    cwd = Path(args.cwd or os.getcwd()).resolve()
    with locked(path) as data:
        rid = next_id(data)
        log = path.parent / "resources" / f"{rid}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "ab") as handle:
            proc = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "_run", "--ledger", str(path), "--id", rid,
                 "--ttl", str(ttl), "--", *command],
                cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True,
            )
        start = None
        for _ in range(20):
            start = start_of(proc.pid)
            if start:
                break
            time.sleep(0.05)
        data["resources"].append({
            "id": rid, "wp": args.wp, "kind": "process", "pgid": proc.pid, "start": start,
            "command": " ".join(command), "cwd": str(cwd), "port": args.port, "close": args.close,
            "reason": args.reason, "ttl": ttl or None, "log": str(log), "created_at": now().isoformat(),
        })
    expiry = f"，{human(ttl)}後自動關" if ttl else ""
    print(f"已啟動並登記 {rid}：pgid {proc.pid}，關閉時點 {args.close}{expiry}；日誌 {log}")
    return 0


def cmd_run(args):
    """start 的內部監管程序：與指令同一個 process group；到期或指令結束時收掉整組並記帳。"""
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        child = subprocess.Popen(command)
    except OSError as error:
        mark_stopped(args.ledger, args.id, f"啟動失敗：{error}")
        return 127
    try:
        code = child.wait(timeout=args.ttl or None)
        note = f"指令自行結束（exit {code}）"
    except subprocess.TimeoutExpired:
        code, note = 0, f"到期自動關（{human(args.ttl)}）"
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with contextlib.suppress(ProcessLookupError):
        os.killpg(0, signal.SIGTERM)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        remaining = process_group_members(os.getpgrp(), {os.getpid()})
        if remaining == []:
            break
        if remaining is None:
            print("無法讀取 process group 實況，帳本未標記停止", file=sys.stderr)
            return code or 1
        time.sleep(0.2)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        remaining = process_group_members(os.getpgrp(), {os.getpid()})
        if remaining == []:
            mark_stopped(args.ledger, args.id, note)
            return code
        if remaining is None:
            print("無法讀取 process group 實況，帳本未標記停止", file=sys.stderr)
            return code or 1
        for pid in remaining:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
        time.sleep(0.1)
    remaining = process_group_members(os.getpgrp(), {os.getpid()})
    if remaining == []:
        mark_stopped(args.ledger, args.id, note)
        return code
    if remaining is None:
        print("無法讀取 process group 實況，帳本未標記停止", file=sys.stderr)
        return code or 1
    print(f"無法收整 process group，仍在執行：pid {','.join(map(str, remaining))}", file=sys.stderr)
    return code or 1


def process_group_members(pgid, exclude=()):
    """只讀 numeric pid/pgid；不讓 lstart locale 解析失敗把活著的後代漏掉。"""
    excluded = set(exclude)
    try:
        result = subprocess.run(["ps", "-axo", "pid=,pgid=,stat="], capture_output=True, text=True,
                                timeout=30, start_new_session=True)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    found = []
    for line in result.stdout.splitlines():
        try:
            pid_text, group_text, state = line.split(None, 2)
            pid, group = int(pid_text), int(group_text)
        except (ValueError, TypeError):
            continue
        if group == pgid and pid not in excluded and not state.startswith("Z"):
            found.append(pid)
    return sorted(found)


def cmd_register(args):
    if args.close in NEEDS_REASON and not args.reason:
        die(f"--close {args.close} 必須附 --reason（寫明為什麼保留或是誰的資源）")
    path = ledger_of(args)
    record = {"wp": args.wp, "close": args.close, "reason": args.reason, "created_at": now().isoformat()}
    if args.ttl:
        record.update(ttl=args.ttl, expires_at=expiry(args.ttl))
    if args.keep and not (args.workdir or args.image_repo):
        die("--keep 只用在 --workdir 與 --image-repo")
    if args.host and not (args.container or args.image_repo):
        die("--host 只用在 --container 與 --image-repo")
    if args.image_repo:
        # 這個任務建的映像（2026-11-28 Jay 3A：工區 E 每次部署都建一個新映像，Mac 留 11 個、Staging 留 16 個沒人刪）。
        record.update(kind="images", repo=args.image_repo, host=args.host, keep=list(args.keep or []))
    elif args.workdir:
        folder = os.path.realpath(os.path.expanduser(args.workdir))
        if not os.path.isdir(folder):
            die(f"找不到資料夾：{folder}")
        if os.path.exists(os.path.join(folder, ".git")):
            die(f"這是 git 工作樹，改用 --worktree：{folder}")
        record.update(kind="workdir", path=folder, keep=list(args.keep or []))
    elif args.worktree:
        tree = os.path.realpath(os.path.expanduser(args.worktree))
        if git(tree, "rev-parse", "--is-inside-work-tree")[1].strip() != "true":
            die(f"不是 git 工作樹：{tree}")
        record.update(kind="worktree", path=tree, branch=git(tree, "rev-parse", "--abbrev-ref", "HEAD")[1].strip(),
                      head=git(tree, "rev-parse", "HEAD")[1].strip())
    elif args.pid:
        procs = ps_table()
        if args.pid not in procs:
            die(f"找不到 pid {args.pid}")
        info = procs[args.pid]
        group = info["pgid"] == args.pid
        record.update(kind="process", pid=None if group else args.pid, pgid=args.pid if group else None,
                      start=info["start"].isoformat(), command=info["command"], cwd=cwds([args.pid]).get(args.pid))
    elif args.compose_project:
        containers = docker_containers()
        if containers is None:
            die("docker 不可用，無法讀取 compose 容器身分")
        found = [c for c in containers if c["project"] == args.compose_project]
        if not found:
            die(f"找不到執行中的 compose 專案 {args.compose_project}")
        record.update(kind="compose", project=args.compose_project,
                      container_identities=[container_identity(c) for c in found])
    elif args.host:
        # 遠端主機（例如 Staging）上用 ssh 起的容器：記下身分，之後 stop、移除與核對都經同一台主機。測試容器常常
        # 跑完就結束，已停止的也能登記。
        containers = docker_all(args.host)
        if containers is None:
            die(f"無法讀取 {args.host} 的 docker（ssh 與 sudo -n docker 都要可用）")
        found = [c for c in containers if c["name"] == args.container]
        if not found:
            die(f"{args.host} 上找不到容器 {args.container}")
        record.update(kind="container", container=args.container, host=args.host, managed=True,
                      container_identities=[container_identity(c) for c in found])
        if all(c.get("state") != "running" for c in found):
            # 24 小時從容器實際停止時算起，讀不到才用登記當下（工區 E 監督 2026-11-28）。
            stopped = finished_at(inspect_containers(args.host, [c["id"] for c in found]))
            record["stopped_at"] = (stopped or now()).isoformat()
    else:
        containers = docker_containers()
        if containers is None:
            die("docker 不可用，無法讀取容器身分")
        found = [c for c in containers if c["name"] == args.container]
        if not found:
            die(f"找不到執行中的容器 {args.container}")
        record.update(kind="container", container=args.container,
                      container_identities=[container_identity(c) for c in found])
    with locked(path) as data:
        record["id"] = next_id(data)
        data["resources"].append(record)
    print(f"已登記 {describe(record)}")
    return 0


def cmd_run_container(args):
    """單一容器的統一啟動：啟動、身分標籤、登記與到期一步完成，登記不再靠事後記得補。"""
    if args.close == "external":
        die("external 是別人的資源：用 register --container 登記，不由本任務啟動")
    if args.close in NEEDS_REASON and not args.reason:
        die(f"--close {args.close} 必須附 --reason（寫明為什麼保留）")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        die("缺少映像：run-container … -- <docker run 的其餘參數與映像>")
    ttl = args.ttl or (ACCEPTANCE_TTL if args.close == "acceptance" else 0)
    if not ttl:
        die("需要 --ttl：多久沒續期就自動停止，至少抓工作包時程基準的兩倍")
    path = ledger_of(args)
    protected = args.protect or any(a == "--tmpfs" or a.startswith("--tmpfs=") or "type=tmpfs" in a for a in command)
    labels = {"lt.task": path.parent.name, "lt.wp": args.wp, "lt.close": args.close, "lt.ledger": os.path.realpath(path)}
    volumes = label_new_volumes(command, labels)
    argv = ["docker", "run", "-d", "--name", args.name]
    for key, value in labels.items():
        argv += ["--label", f"{key}={value}"]
    if args.memory:
        argv += ["--memory", args.memory]
    try:
        result = subprocess.run(argv + command, capture_output=True, text=True, timeout=900)
    except (OSError, subprocess.SubprocessError) as error:
        die(f"docker run 無法執行：{error}")
    if result.returncode != 0 or not result.stdout.strip():
        die("docker run 失敗：" + (result.stderr.strip()[-400:] or f"exit {result.returncode}"))
    cid = result.stdout.strip().splitlines()[-1]
    found = [c for c in (docker_all() or []) if c["id"] == cid]
    identity = container_identity(found[0]) if found else {"id": cid, "name": args.name, "created": now().isoformat()}
    with locked(path) as data:
        rid = next_id(data)
        data["resources"].append({
            "id": rid, "wp": args.wp, "kind": "container", "container": identity["name"],
            "container_identities": [identity], "managed": True, "protected": protected, "memory": args.memory,
            "command": " ".join(command), "close": args.close, "reason": args.reason, "ttl": ttl,
            "expires_at": expiry(ttl), "created_at": now().isoformat(), **({"volumes": volumes} if volumes else {}),
        })
    if protected:
        tail = f"到期 {human(ttl)}只提醒、不自動停（記憶體資料或受保護），由主線 stop"
    else:
        arm_expiry(path, rid, ttl)
        tail = f"{human(ttl)}後沒續期就自動停止（不刪）"
    made = f"；具名資料卷 {'、'.join(volumes)} 已帶同一組任務標籤建立" if volumes else ""
    print(f"已啟動並登記 {rid}：容器 {identity['name']}（{cid[:12]}），關閉時點 {args.close}；{tail}{made}")
    return 0


def named_volumes(command):
    """docker run 參數裡的具名資料卷（-v 名:/路徑、--volume、--mount source=名）；主機路徑掛載不算。"""
    names = []
    for i, arg in enumerate(command):
        nxt = command[i + 1] if i + 1 < len(command) else ""
        spec = (nxt if arg in ("-v", "--volume") else arg.split("=", 1)[1] if arg.startswith("--volume=")
                else arg[2:] if arg.startswith("-v") and not arg.startswith("--") and len(arg) > 2 else None)
        mount = nxt if arg == "--mount" else arg.split("=", 1)[1] if arg.startswith("--mount=") else None
        name = None
        if spec and ":" in spec:
            name = spec.split(":", 1)[0]
        elif mount:
            fields = dict(item.split("=", 1) for item in mount.split(",") if "=" in item)
            if fields.get("type", "volume") == "volume":
                name = fields.get("source") or fields.get("src")
        if name and not name.startswith((".", "~")) and "/" not in name and name not in names:
            names.append(name)
    return names


def label_new_volumes(command, labels):
    """還不存在的具名資料卷先帶任務標籤建立，之後才查得到是哪個任務留下的（使用者 2026-11-18 定案；當天 1005 個資料卷
    只有 1 個帶任務標籤）。已存在的資料卷不動、不改標籤；匿名資料卷隨容器 rm -v 一起刪，不必標。"""
    made = []
    for name in named_volumes(command):
        try:
            if subprocess.run(["docker", "volume", "inspect", name], capture_output=True, timeout=60).returncode == 0:
                continue
            argv = ["docker", "volume", "create"] + [x for k, v in labels.items() for x in ("--label", f"{k}={v}")] + [name]
            if subprocess.run(argv, capture_output=True, timeout=60).returncode == 0:
                made.append(name)
        except (OSError, subprocess.SubprocessError):
            continue
    return made


def identity_problem(res, path, everything):
    """到期代關與移除只認四項身分（任務、工作包、關閉時點、帳本位置）都和帳本一致的容器；相符回 None。"""
    recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    if res.get("host"):
        # 遠端主機上事後登記的容器沒有 lt.* 標籤（工區 E 的 C105 在 Staging 登記 22 筆，全是 v1.22.2 以前建的，一筆都
        # 刪不掉）。它們的身分是登記時記下的容器 ID、名稱與建立時間，三項都要和現在一致。
        known = {item["id"]: item for item in res.get("container_identities", []) if item.get("id")}
        for c in everything:
            if c["id"] in known and container_identity(c) != known[c["id"]]:
                return f"容器 {c['name']} 的名稱或建立時間與登記時不同，未動"
        return None
    expected = {"task": Path(path).parent.name, "wp": res.get("wp"), "close": res.get("close"),
                "ledger": os.path.realpath(path)}
    for c in everything:
        if c["id"] in recorded:
            for key, value in expected.items():
                if (c.get(key) or "") != (value or ""):
                    return f"容器 {c['name']} 的 lt.{key} 標籤與帳本不符，未動"
    return None


def cmd_renew(args):
    path = ledger_of(args)
    with locked(path) as data:
        res = next((r for r in data["resources"] if r.get("id") == args.id and not r.get("stopped_at")), None)
        if res:
            res.update(ttl=args.ttl, expires_at=expiry(args.ttl))
    if not res:
        die(f"帳本裡沒有未停止的 {args.id}")
    if res.get("managed") and not res.get("protected"):
        arm_expiry(path, args.id, args.ttl)
    print(f"已續期 {describe(res)}：到期 {res['expires_at']}")
    return 0


def cmd_expire(args):
    """run-container 與 renew 掛的背景計時到點：只停自己這一筆，條件有任何不符就不動、把原因記在帳本。"""
    path = Path(args.ledger)
    res = next((r for r in load(path)["resources"] if r.get("id") == args.id), None)
    if (not res or res.get("stopped_at") or not res.get("managed") or res.get("protected")
            or res.get("close") == "external" or res.get("kind") != "container"):
        return 0
    try:
        if dt.datetime.fromisoformat(res["expires_at"]) > now():
            return 0  # 已續期：renew 另掛了新的計時
    except (KeyError, TypeError, ValueError):
        return 0
    everything = docker_all()
    if everything is None:
        note_resource(path, args.id, expire_note="到期時 docker 不可用，未處理")
        return 1
    problem = identity_problem(res, path, everything)
    if problem:
        note_resource(path, args.id, expire_note=problem)
        return 0
    ok, note = terminate(res, {"containers": [c for c in everything if c.get("state") == "running"]})
    if ok:
        mark_stopped(path, args.id, f"到期自動停止（{human(res.get('ttl') or 0)}未續期，未刪除）：{note}")
        return 0
    note_resource(path, args.id, expire_note=f"到期自動停止失敗：{note}")
    return 1


def git(cwd, *argv):
    try:
        result = subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return result.returncode, result.stdout


def package_passed(state_dir, wp):
    """True＝判定 PASS；False＝FAIL（含舊紀錄的主線接手）或還沒判定；None＝查不到這包。主線自己的資源（wp 寫「主線」）不經判定。"""
    if wp == "主線":
        return True
    found = None
    for name in ("archive.md", "state.md"):
        with contextlib.suppress(OSError, UnicodeDecodeError):
            head, rows = work_table((state_dir / name).read_text(encoding="utf-8").splitlines())
            i_state = next((i for i, h in enumerate(head) if h.startswith("狀態")), None)
            for row in rows:
                if row and row[0] == wp:
                    text = row[i_state] if i_state is not None and i_state < len(row) else " ".join(row[1:])
                    found = bool(PASSED.search(text)) and not NOT_PASSED.search(text)
    if found is None:
        with contextlib.suppress(OSError, UnicodeDecodeError, ValueError, AttributeError):
            line = re.search(r"^\[狀態\][ \t]*(\{.*\})", (state_dir / "wp" / f"{wp}.md").read_text(encoding="utf-8"), re.M)
            found = json.loads(line.group(1)).get("list") == "completed"
    return found


def referenced(state_dir, needles, extra=()):
    """識別值是否出現在驗收結果帳、evidence/ 與決策帳；回傳 (True／False／None 查不了, 說明)。"""
    targets = [state_dir / "evidence"] if (state_dir / "evidence").is_dir() else []
    targets += [p for p in sorted(state_dir.iterdir())
                if p.is_file() and re.search(r"驗收|決策|acceptance|decision", p.name, re.I)]
    targets += [Path(p).expanduser() for p in extra]
    if not targets:
        return False, "沒有驗收結果帳、evidence/ 或決策帳可搜尋"
    argv = ["grep", "-rlF"] + [x for needle in needles for x in ("-e", needle)] + ["--"] + [str(t) for t in targets]
    try:
        result = subprocess.run(argv, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None, "引用搜尋沒有完成"
    if result.returncode == 1:
        return False, f"搜尋 {len(targets)} 處無引用"
    if result.returncode != 0:
        return None, "引用搜尋沒有完成"
    files = result.stdout.decode("utf-8", "replace").splitlines()
    return True, f"仍被 {len(files)} 個檔案引用（{'、'.join(os.path.basename(f) for f in files[:3])}）"


def deletion_row(state_dir, item, producer, why, search):
    """先記再刪：刪前寫一列，回傳完成後補上讀回結果的函式。"""
    path = state_dir / "deletions.md"
    if not path.is_file():
        path.write_text(DELETIONS_HEAD, encoding="utf-8")
    clean = [str(x).replace("|", "／").replace("\n", " ") for x in (now().isoformat(), item, producer, why, search)]
    row = "| " + " | ".join(clean) + " | "
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(row + "待讀回 |\n")

    def readback(result):
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(row + "待讀回 |", row + result + " |"), encoding="utf-8")
    return readback


# 移除前留給診斷的資料不能帶憑證或讀值（工區 E 監督 2026-11-28：讀單容器可能帶 Claude 授權碼、app 容器帶測試庫連線
# 字串，Mac 上 28 個測試庫容器的 inspect 都有 POSTGRES_PASSWORD，日誌可能有原件讀值，狀態目錄又在雲端同步範圍內）。
# inspect 只取下面這些欄位，Config.Env 與 HostConfig 不取；日誌留在容器所在主機、不同步雲端的受限資料夾，狀態目錄只記
# 位置、行數與雜湊。
REMOTE_LOG_DIR = "/var/tmp/long-task-container-logs"
STATE_FIELDS = ("Status", "ExitCode", "OOMKilled", "Error", "StartedAt", "FinishedAt")
MOUNT_FIELDS = ("Type", "Name", "Source", "Destination", "RW")


def inspect_containers(host, ids):
    """docker inspect 的原始結果；讀不到時回 None。只在記憶體裡用，不寫進任何檔案。"""
    try:
        result = subprocess.run(docker_argv(host, "inspect", *ids), capture_output=True, text=True, timeout=120)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def safe_inspect(item):
    config, state = item.get("Config") or {}, item.get("State") or {}
    return {"Id": item.get("Id"), "Name": item.get("Name"), "Created": item.get("Created"), "Image": item.get("Image"),
            "ConfigImage": config.get("Image"), "Labels": config.get("Labels"), "RestartCount": item.get("RestartCount"),
            "State": {key: state.get(key) for key in STATE_FIELDS},
            "Mounts": [{key: mount.get(key) for key in MOUNT_FIELDS} for mount in item.get("Mounts") or []]}


def finished_at(items):
    """容器實際停止的時間（本機時間，取最晚的一個）；沒停過或讀不到時回 None。"""
    times = []
    for item in items or []:
        text = ((item.get("State") or {}).get("FinishedAt") or "")[:19]
        with contextlib.suppress(ValueError):
            when = dt.datetime.fromisoformat(text).replace(tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
            if when.year > 1:
                times.append(when)
    return max(times) if times else None


def keep_logs(host, container_id, name):
    """把最後 500 行日誌存在容器所在主機的受限資料夾（遠端 root 700、本機 LONG_TASK_HOME 下 700），回傳位置、行數與雜湊。"""
    file = f"{name.strip('/') or 'container'}-{container_id[:12]}-{now().strftime('%Y%m%dT%H%M%S')}.log"
    if host:
        target = f"{REMOTE_LOG_DIR}/{file}"
        script = (f"set -e; umask 077; mkdir -p {REMOTE_LOG_DIR}; docker logs --tail 500 {shlex.quote(container_id)} > "
                  f"{shlex.quote(target)} 2>&1; wc -l < {shlex.quote(target)}; sha256sum {shlex.quote(target)}")
        try:
            result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
                                     "sudo -n sh -c " + shlex.quote(script)], capture_output=True, text=True, timeout=180)
            lines, digest = result.stdout.split()[:2]
            return {"host": host, "path": target, "lines": int(lines), "sha256": digest}
        except (OSError, subprocess.SubprocessError, ValueError):
            return {"host": host, "path": target, "error": "存不了日誌"}
    folder = local_home() / "removed-container-logs"
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    target = folder / file
    try:
        data = subprocess.run(docker_argv(None, "logs", "--tail", "500", container_id), stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=120).stdout
    except (OSError, subprocess.SubprocessError):
        return {"host": "本機", "path": str(target), "error": "存不了日誌"}
    with open(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as handle:
        handle.write(data)
    return {"host": "本機", "path": str(target), "lines": data.count(b"\n"), "sha256": hashlib.sha256(data).hexdigest()}


def stopped_hours(res):
    try:
        return (now() - dt.datetime.fromisoformat(res["stopped_at"]).replace(tzinfo=None)).total_seconds() / 3600
    except (KeyError, TypeError, ValueError):
        return 0.0


def image_plan(res, since):
    """登記的映像庫在該主機上要保留與可刪的映像；讀不到 docker 時回 None。"""
    host, repo = res.get("host"), res["repo"]
    try:
        listed = subprocess.run(docker_argv(host, "image", "ls", "--no-trunc", "--format",
                                            "{{.ID}}\t{{.Tag}}\t{{.CreatedAt}}", repo),
                                capture_output=True, text=True, timeout=60)
        ids = subprocess.run(docker_argv(host, "ps", "-aq", "--no-trunc"), capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if listed.returncode != 0 or ids.returncode != 0:
        return None
    used = set()
    if ids.stdout.split():
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            used = set(subprocess.run(docker_argv(host, "inspect", "--format", "{{.Image}}", *ids.stdout.split()),
                                      capture_output=True, text=True, timeout=120).stdout.split())
    images = {}
    for line in listed.stdout.splitlines():
        f = line.split("\t")
        if len(f) < 3:
            continue
        try:
            created = dt.datetime.strptime(f[2][:25], "%Y-%m-%d %H:%M:%S %z").astimezone().replace(tzinfo=None)
        except ValueError:
            created = None
        item = images.setdefault(f[0], {"id": f[0], "tags": [], "created": created})
        item["tags"].append(f[1])
    ordered = sorted(images.values(), key=lambda x: x["created"] or dt.datetime.min, reverse=True)
    keep, remove = [], []
    for rank, item in enumerate(ordered):
        marks = item["tags"] + [item["id"], item["id"].removeprefix("sha256:")]
        why = ("最新兩版之一（部署中或上一版）" if rank < IMAGE_KEEP_NEWEST else
               "容器在用" if item["id"] in used else
               "登記時指定保留" if any(m.startswith(k) or m == k for m in marks for k in res.get("keep") or []) else
               "任務開始前就有，不是這個任務建的" if since and item["created"] and item["created"] < since else None)
        (keep if why else remove).append({**item, "why": why})
    return {"keep": keep, "remove": remove}


def remove(res, path, args):
    """移除已停止的容器或工作樹；回傳 ("removed"｜"kept"｜"failed", 說明)。條件不符就保留，不算失敗。"""
    state_dir = Path(path).parent
    passed = package_passed(state_dir, res.get("wp"))
    if res["kind"] == "container" and res.get("host") and passed is False:
        # 24 小時從容器實際停止時算起。v1.22.2 登記時記的是登記當下，這裡改讀 State.FinishedAt 並寫回帳本。
        stopped = finished_at(inspect_containers(res["host"], [item["id"] for item in res.get("container_identities", [])]))
        if stopped:
            res["stopped_at"] = stopped.isoformat()
            note_resource(path, res["id"], stopped_at=res["stopped_at"])
    # 不是 PASS 的容器留給診斷 24 小時，之後先存容器資訊與日誌位置再移除（Jay 2026-11-28 2A：工區 E 登記的 40 個容器
    # 沒有一個移除過，FAIL 的留作診斷之後就沒人收）。
    expired = res["kind"] == "container" and passed is False and stopped_hours(res) >= FAILED_KEEP_HOURS
    if not passed and not expired:
        return "kept", ("查不到所屬工作包的判定" if passed is None else
                        f"所屬工作包不是 PASS，停止滿 {FAILED_KEEP_HOURS} 小時才移除") + "，只停不刪"
    host = res.get("host")
    if res["kind"] == "container":
        if not res.get("managed"):
            return "kept", "不是 run-container 建立的，身分不齊，未移除"
        everything = docker_all(host)
        if everything is None:
            return "failed", "docker 不可用，無法移除"
        recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
        present = [c for c in everything if c["id"] in recorded]
        if not present:
            note_resource(path, res["id"], removed_at=now().isoformat())
            return "removed", "容器已不存在"
        problem = identity_problem(res, path, everything)
        if problem or any(c.get("state") == "running" for c in present):
            return "kept", problem or "容器仍在執行"
        needles, label = [c["name"] for c in present] + sorted(recorded), "容器 " + "、".join(c["name"] for c in present)
    else:
        tree = res["path"]
        if not Path(tree).is_dir():
            note_resource(path, res["id"], removed_at=now().isoformat(), stopped_at=now().isoformat())
            return "removed", "工作樹已不存在"
        if not args.integrated_into:
            return "kept", "工作樹要加 --integrated-into <候選版 commit 或分支> 才核對得了是否已整合"
        code, dirty = git(tree, "status", "--porcelain")
        if code != 0 or dirty.strip():
            return "kept", "工作樹有未提交的變更"
        if git(tree, "merge-base", "--is-ancestor", "HEAD", args.integrated_into)[0] != 0:
            return "kept", f"工作樹的 HEAD 不在 {args.integrated_into} 裡，尚未整合"
        needles, label = [tree], f"工作樹 {tree}（分支 {res.get('branch')} 保留）"
    if expired:
        items = inspect_containers(host, sorted(recorded)) or []
        logs = [keep_logs(host, item.get("Id") or "", item.get("Name") or "") for item in items]
        if not items or any("error" in item for item in logs):
            return "kept", "存不了移除前的容器資訊或日誌，未移除"
        evidence = state_dir / "evidence" / f"container-{res['id']}-移除前.json"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps({"inspect": [safe_inspect(item) for item in items], "logs": logs},
                                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        used, search = False, (f"容器資訊（不含環境變數）已存 {evidence.name}，日誌留在"
                               f"{host or '本機'} {Path(logs[0]['path']).parent}")
    else:
        used, search = referenced(state_dir, needles, args.search or ())
    if used is not False:
        return "kept", search + "，未移除"
    if res["kind"] == "worktree":
        evidence = state_dir / "evidence" / f"worktree-{res['id']}-移除前.txt"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text("\n".join([f"HEAD {git(tree, 'rev-parse', 'HEAD')[1].strip()}",
                                       f"已核對在 {args.integrated_into} 內", "git status --short:",
                                       git(tree, "status", "--short")[1], "git diff:", git(tree, "diff")[1]]),
                            encoding="utf-8")
    readback = deletion_row(state_dir, label, f"工作包 {res.get('wp')}（帳本 {res['id']}）",
                            f"工作包不是 PASS、停止滿 {FAILED_KEEP_HOURS} 小時的診斷容器" if expired else "工作包已判定 PASS 的測試中間產物", search)
    if res["kind"] == "container":
        try:
            code = subprocess.run(docker_argv(host, "rm", "-v", *sorted(recorded)), capture_output=True, timeout=120).returncode
        except (OSError, subprocess.SubprocessError):
            code = 1
        left = [c for c in (docker_all(host) or []) if c["id"] in recorded] if code == 0 else present
        gone = code == 0 and not left
    else:
        common = git(tree, "rev-parse", "--path-format=absolute", "--git-common-dir")[1].strip()
        code = subprocess.run(["git", "--git-dir", common, "worktree", "remove", tree],
                              capture_output=True, timeout=120).returncode if common else 1
        gone = code == 0 and not Path(tree).exists()
    readback("讀回已不存在" if gone else "移除失敗，仍存在")
    if not gone:
        return "failed", "移除指令失敗，仍存在"
    note_resource(path, res["id"], removed_at=now().isoformat(),
                  **({"stopped_at": now().isoformat()} if res["kind"] == "worktree" else {}))
    return "removed", f"已移除並讀回（{search}），已記入 deletions.md"


def terminate(res, snap):
    """關閉單一資源並核對；回傳 (是否已停止, 說明)。"""
    if res["kind"] == "process":
        pids = members(res, snap)
        if not pids:
            return True, "已不在執行"
        for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 3)):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                if res.get("pgid"):
                    os.killpg(res["pgid"], sig)
                else:
                    for pid in reversed(pids):
                        with contextlib.suppress(ProcessLookupError):
                            os.kill(pid, sig)
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline:
                if not members(res, {"procs": ps_table()}):
                    return True, "已關閉並核對停止"
                time.sleep(0.2)
        return False, "送出 SIGKILL 後仍在執行"
    ids = containers_of(res, snap)
    if ids is None:
        return False, "docker 不可用，無法關閉"
    candidates = container_candidates(res, snap) or []
    recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    different = [c for c in candidates if c["id"] not in recorded]
    mismatch = (f"；同名／同專案的 {len(different)} 個新容器身分不符，未動"
                if different else "")
    if not recorded:
        if candidates:
            return False, "帳本沒有不可變容器身分，為避免誤停同名新容器而未操作"
        return True, "已不在執行"
    if not ids:
        return True, "原登記身分已不在執行" + mismatch
    try:
        result = subprocess.run(docker_argv(res.get("host"), "stop", *ids), capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return False, "docker 停止指令失敗"
    if result.returncode != 0:
        return False, f"docker stop 失敗（exit {result.returncode}）"
    current = _docker_ps([], DOCKER_FORMAT, res.get("host"))
    if current is None:
        return False, "docker 不可用，無法核對停止結果"
    left = containers_of(res, {"containers": current})
    return (not left), ("已停止並核對" + mismatch if not left else f"原登記身分仍有 {len(left)} 個容器在跑")


def tmp_base():
    """任務暫存的上層。/tmp 夠短，unix socket（路徑上限約 104 字元）放得下；LONG_TASK_TMP_BASE 讓測試或別的磁碟換位置。"""
    return os.environ.get("LONG_TASK_TMP_BASE") or "/tmp"


def cmd_tmpdir(args):
    """工作包自己的暫存資料夾（使用者 2026-11-19 定案）：測試把瀏覽器設定檔、驅動暫存丟進系統暫存區，跑完不刪，只有
    重開機才清（2026-11-19 重開機後 12 小時 12,291 項、2.24GiB；前一天清理前 12GiB）。放在任務自己的資料夾，判定後整個刪。"""
    path = ledger_of(args)
    with locked(path) as data:
        for res in data["resources"]:
            if (res.get("kind") == "tmp" and res.get("wp") == args.wp and not res.get("stopped_at")
                    and os.path.isdir(res.get("path") or "")):
                print(res["path"])
                return 0
        task = hashlib.sha256(os.path.realpath(path).encode("utf-8")).hexdigest()[:8]
        slug = re.sub(r"[^A-Za-z0-9._-]+", "_", args.wp).strip("_.")[:24]
        if slug != args.wp:
            slug = (slug + "-" if slug else "") + hashlib.sha256(args.wp.encode("utf-8")).hexdigest()[:4]
        folder = Path(tmp_base()) / f"lt-{task}" / slug
        folder.mkdir(parents=True, exist_ok=True)
        for own in (folder.parent, folder):
            os.chmod(own, 0o700)
        data["resources"].append({"id": next_id(data), "kind": "tmp", "wp": args.wp, "close": "wp", "reason": "",
                                  "created_at": now().isoformat(), "path": str(folder)})
    print(folder)
    return 0


def users_of(folder):
    """還在用這個資料夾的程序 pid：指令列寫到它、工作目錄在裡面，或開著裡面的檔案。查不了回 None（當成有人在用）。
    本指令自己與呼叫它的上層 shell 不算：它們的指令列本來就寫著要刪的路徑。"""
    real, procs = os.path.realpath(folder), ps_table()
    mine, pid = set(), os.getpid()
    while pid in procs and pid not in mine:
        mine.add(pid)
        pid = procs[pid]["ppid"]
    found = {p["pid"] for p in procs.values() if real in p["command"] or str(folder) in p["command"]}
    if Path("/proc/self/cwd").exists():
        for name in os.listdir("/proc"):
            with contextlib.suppress(OSError):
                if name.isdigit() and inside(os.readlink(f"/proc/{name}/cwd"), [real]):
                    found.add(int(name))
    else:
        try:
            out = subprocess.run(["lsof", "-Fp", "+D", real], capture_output=True, env=C_ENV,
                                 timeout=120).stdout.decode("utf-8", "replace")
        except (OSError, subprocess.SubprocessError):
            return None
        found |= {int(line[1:]) for line in out.splitlines() if line.startswith("p") and line[1:].isdigit()}
    return sorted(found - mine - {os.getpid()})


def tree_size(path):
    """檔案大小合計（位元組）；共用儲存空間的複本照檔案大小算，實際釋出以 df 為準。"""
    if os.path.islink(path) or not os.path.isdir(path):
        with contextlib.suppress(OSError):
            return os.lstat(path).st_size
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(root, name)).st_size
    return total


def megabytes(size):
    return f"{size / 1048576:.1f} MB"


def delete_path(target):
    """真的刪掉（不進垃圾桶），回傳是否已不存在。符號連結只刪連結本身。"""
    with contextlib.suppress(OSError):
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target, ignore_errors=True)
        else:
            os.remove(target)
    return not os.path.lexists(target)


def remove_tmp(res, path):
    """刪掉工作包自己的暫存資料夾；回傳 (是否處理完, 說明)。只刪 tmpdir 建立的位置，還有程序在用就不刪。"""
    folder = res.get("path") or ""
    if not os.path.isdir(folder):
        mark_stopped(path, res["id"], "暫存資料夾已不存在")
        return True, "暫存資料夾已不存在"
    real, base = os.path.realpath(folder), os.path.realpath(tmp_base())
    parts = os.path.relpath(real, base).split(os.sep)
    if len(parts) != 2 or not parts[0].startswith("lt-") or parts[1] in ("", ".", ".."):
        return False, f"不在 {base}/lt-<任務代碼>/<工作包> 底下，不是 tmpdir 建立的位置，未刪"
    users = users_of(folder)
    if users is None:
        return False, "查不了有沒有程序在用，未刪"
    if users:
        return False, f"還有程序在用（pid {'、'.join(map(str, users[:6]))}），未刪；程序結束後再 stop"
    size = tree_size(real)
    readback = deletion_row(Path(path).parent, f"任務暫存 {folder}（{megabytes(size)}）",
                            f"工作包 {res.get('wp')}（帳本 {res['id']}）", "測試暫存，證據與測試結果不放這裡", "暫存不作證據，未搜尋")
    gone = delete_path(real)
    readback("讀回已不存在" if gone else "移除失敗，仍存在")
    if not gone:
        return False, "移除失敗，仍存在"
    with contextlib.suppress(OSError):
        os.rmdir(os.path.dirname(real))  # 任務的暫存上層空了就一起收
    mark_stopped(path, res["id"], "已刪除")
    note_resource(path, res["id"], removed_at=now().isoformat())
    return True, f"已刪除並讀回（{megabytes(size)}），已記入 deletions.md"


def kept_by(rel, target, patterns):
    """符合登記時 --keep 樣式的不刪：比對相對路徑、各層上層與檔名；資料夾連裡面每個檔案一起看。回傳符合的那一項。"""
    def hit(item):
        pieces = item.split(os.sep)
        names = [os.sep.join(pieces[:i]) for i in range(1, len(pieces) + 1)] + [pieces[-1]]
        return any(fnmatch.fnmatch(name, pattern) for name in names for pattern in patterns)
    if not patterns:
        return None
    if hit(rel):
        return rel
    if os.path.isdir(target) and not os.path.islink(target):
        for root, dirs, files in os.walk(target):
            for name in dirs + files:
                item = os.path.join(rel, os.path.relpath(os.path.join(root, name), target))
                if hit(item):
                    return item
    return None


def cmd_prune(args):
    """工作包資料夾的過程檔回收（使用者 2026-11-19 定案）：2026-11-19 工區 E 實跑區一天多 19GiB，1,297 個已交件工作包
    78.5GiB 都留著，39,727 個 PDF 只有約 67 種內容，同一包的整套測試輸出常存五六份；當時沒有任何規則要收。"""
    path = ledger_of(args)
    state_dir = Path(path).parent
    folders = [r for r in load(path)["resources"] if r.get("kind") == "workdir" and r.get("wp") == args.wp]
    if not folders:
        die(f"工作包 {args.wp} 沒有登記的工作資料夾：先 register --workdir <路徑> --wp {args.wp}")
    paths = args.paths[1:] if args.paths[:1] == ["--"] else args.paths
    if args.none and (paths or not args.reason):
        die("--none 不能同時列路徑，且必須附 --reason（寫明為什麼沒有可刪的過程檔）")
    if not args.none and not paths:
        die("列出要刪的過程檔：prune … -- <路徑…>；沒有可刪的用 --none --reason <原因>")
    passed = package_passed(state_dir, args.wp)
    if not passed:
        print(("查不到工作包的判定" if passed is None else "工作包不是 PASS") + "：過程檔留作診斷，沒有刪任何東西。")
        return 4
    stamp = now().isoformat()
    if args.none:
        for res in folders:
            note_resource(path, res["id"], pruned_at=stamp, prune_note=args.reason,
                          stopped_at=res.get("stopped_at") or stamp)
        print(f"✓ 工作包 {args.wp}：已記錄沒有可刪的過程檔（{args.reason}）")
        return 0
    roots = {os.path.realpath(r["path"]): r for r in folders}
    failed, freed, cleaned = 0, 0, {}
    for raw in paths:
        given = os.path.expanduser(raw)
        candidates = [given] if os.path.isabs(given) else [os.path.join(root, given) for root in roots]
        candidates = [os.path.join(os.path.realpath(os.path.dirname(c)), os.path.basename(os.path.normpath(c)))
                      for c in candidates]
        found = [(c, root) for c in candidates for root in roots
                 if os.path.lexists(c) and c != root and c.startswith(root.rstrip(os.sep) + os.sep)]
        if len(found) != 1:
            print(f"・ {raw}：" + ("不存在，或不在這個工作包登記的資料夾裡面" if not found else "在多個登記的資料夾裡都有，改寫絕對路徑")
                  + "，未刪")
            continue
        target, root = found[0]
        res, rel = roots[root], os.path.relpath(target, root)
        keep = kept_by(rel, target, res.get("keep") or [])
        if keep:
            print(f"・ {raw}：{keep} 符合登記的保留樣式，未刪")
            continue
        used, search = referenced(state_dir, [target, os.path.join(os.path.basename(root), rel)], args.search or ())
        if used is not False:
            print(f"・ {raw}：{search}，未刪")
            continue
        users = users_of(target) if os.path.isdir(target) and not os.path.islink(target) else []
        if users is None or users:
            print(f"・ {raw}：" + ("查不了有沒有程序在用" if users is None else f"還有程序在用（pid {users[0]}）") + "，未刪")
            continue
        size = tree_size(target)
        readback = deletion_row(state_dir, f"過程檔 {target}（{megabytes(size)}）", f"工作包 {args.wp}（帳本 {res['id']}）",
                                "工作包已判定 PASS、可重建的過程檔", search)
        gone = delete_path(target)
        readback("讀回已不存在" if gone else "移除失敗，仍存在")
        if not gone:
            failed += 1
            print(f"✗ {raw}：移除失敗，仍存在")
            continue
        freed += size
        cleaned[res["id"]] = cleaned.get(res["id"], 0) + size
        print(f"✓ {raw}：已刪除並讀回（{megabytes(size)}；{search}）")
    for res in folders:
        if res["id"] in cleaned:
            note_resource(path, res["id"], pruned_at=stamp, pruned_bytes=(res.get("pruned_bytes") or 0) + cleaned[res["id"]],
                          stopped_at=res.get("stopped_at") or stamp)
    print(f"工作包 {args.wp}：刪除 {megabytes(freed)}（檔案大小合計，實際釋出以 df 為準），明細在 deletions.md。")
    return 4 if failed else 0


def cmd_stop(args):
    path = ledger_of(args)
    data = load(path)
    targets = []

    def removable(res):
        return args.remove and res["kind"] in ("container", "worktree") and not res.get("removed_at")

    for res in data["resources"]:
        if res["kind"] == "images":
            continue  # 映像用 prune-images 刪
        if res.get("close") == "external" or (res.get("stopped_at") and not removable(res)):
            continue
        if res["kind"] == "workdir" or (res["kind"] == "worktree" and not args.remove):
            continue  # 工作資料夾裝著交件成果，不整個移除；過程檔用 prune
        if args.id and res["id"] != args.id:
            continue
        if args.wp and res.get("wp") != args.wp:
            continue
        if res.get("close") == "acceptance" and not (args.include_acceptance or args.id):
            continue
        targets.append(res)
    if not targets:
        print("沒有符合條件、仍在帳本上的資源。")
        return 0
    snap = {"procs": ps_table(), "containers": docker_containers()}
    failed = 0
    for res in targets:
        if res["kind"] == "tmp":
            ok, note = remove_tmp(res, path)
        elif res["kind"] == "worktree" or res.get("stopped_at"):
            ok, note = True, "工作樹" if res["kind"] == "worktree" else "先前已停止"
        else:
            ok, note = terminate(res, snap)
            if ok:
                mark_stopped(path, res["id"], note)
        if ok and removable(res):
            result, why = remove(res, path, args)
            ok, note = result != "failed", f"{note}；{'✓' if result == 'removed' else '・'} {why}"
        print(f"{'✓' if ok else '✗'} {describe(res)}：{note}")
        if not ok:
            failed += 1
    return 4 if failed else 0


def cmd_prune_images(args):
    """刪掉登記映像庫的舊映像：每筆先記進 deletions.md，刪後讀回。"""
    path = ledger_of(args)
    res = next((r for r in load(path)["resources"] if r["id"] == args.id), None)
    if not res or res["kind"] != "images":
        die(f"帳本裡沒有映像登記 {args.id}；先 register --image-repo <映像庫> [--host 主機]")
    state = Path(args.state).expanduser()
    since = task_scope(state, state.read_text(encoding="utf-8").splitlines())[1] if state.is_file() else None
    plan = image_plan({**res, "keep": (res.get("keep") or []) + (args.keep or [])}, since)
    if plan is None:
        die(f"讀不到{res.get('host') or '本機'}的 docker，未刪除")
    for item in plan["keep"]:
        print(f"・保留 {res['repo']}:{'、'.join(item['tags'])}：{item['why']}")
    failed = 0
    for item in plan["remove"]:
        label = f"映像 {res['repo']}:{'、'.join(item['tags'])}（{item['id'][:19]}，{res.get('host') or '本機'}）"
        readback = deletion_row(path.parent, label, f"帳本 {res['id']}", "舊候選映像，可從 commit 重建",
                                "已保留最新兩版、容器在用與登記指定的版本")
        code = 1
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            code = subprocess.run(docker_argv(res.get("host"), "rmi", item["id"]), capture_output=True, timeout=180).returncode
        gone = code == 0 and subprocess.run(docker_argv(res.get("host"), "image", "inspect", item["id"]),
                                            capture_output=True, timeout=60).returncode != 0
        readback("讀回已不存在" if gone else "刪除失敗，仍存在")
        print(f"{'✓' if gone else '✗'} {label}")
        failed += not gone
    return 4 if failed else 0


def cmd_wait(args):
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        die("缺少查核指令：wait --timeout 30m -- <查核指令>")
    shell = len(command) == 1
    begin = time.monotonic()
    deadline = begin + args.timeout
    tries, output = 0, ""
    while True:
        tries += 1
        remaining = max(1.0, deadline - time.monotonic())
        try:
            result = subprocess.run(command[0] if shell else command, shell=shell, capture_output=True, text=True,
                                    timeout=min(remaining, 300))
            code, output = result.returncode, (result.stdout + result.stderr).strip()
        except subprocess.TimeoutExpired:
            code, output = 1, "（查核指令本身逾時）"
        if code == 0:
            print(f"READY：條件成立（第 {tries} 次查核，等了 {human(time.monotonic() - begin)}）")
            if output:
                print("\n".join(output.splitlines()[-20:]))
            return 0
        if time.monotonic() >= deadline:
            print(f"TIMEOUT：等了 {human(args.timeout)} 條件仍未成立（查核 {tries} 次）。最後一次查核輸出：")
            print("\n".join(output.splitlines()[-20:]) or "（無輸出）")
            return 124
        time.sleep(min(args.interval, max(0.0, deadline - time.monotonic())))


def browser_members(p, procs):
    """殘留瀏覽器目前還活著的程序。主程序 PID 已被別的程序重用（啟動時間不符）就視為已結束、不動。"""
    leader = procs.get(p["pid"])
    if leader and leader["start"] != p["start"]:
        return []
    if p["pgid"] == p["pid"]:
        return [q["pid"] for q in procs.values() if q["pgid"] == p["pid"]]
    if not leader:
        return []
    tree, frontier = [p["pid"]], [p["pid"]]
    while frontier:
        children = [q["pid"] for q in procs.values() if q["ppid"] in frontier and q["pid"] not in tree]
        tree += children
        frontier = children
    return tree


def kill_browser(p):
    """先 SIGTERM 等 10 秒，再 SIGKILL 等 3 秒；自成一組的連同整組輔助程序，不是的只收它和它的子程序。"""
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 3)):
        pids = browser_members(p, ps_table())
        if not pids:
            return True
        if p["pgid"] == p["pid"]:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(p["pid"], sig)
        else:
            for pid in reversed(pids):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, sig)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if not browser_members(p, ps_table()):
                return True
            time.sleep(0.2)
    return not browser_members(p, ps_table())


def reap(state, dry_run=False, snapshot=None):
    """回傳 (要印的行, exit code)。只關 orphan_browsers 的四條件全符合者，每支關前關後記進 reaped.jsonl。"""
    lines = state.read_text(encoding="utf-8").splitlines()
    roots, since, _until, _task, worktrees = task_scope(state, lines)
    targets = orphan_browsers(roots, since, now(), snapshot or process_snapshot(), registered(state, worktrees))
    if not targets:
        return ["沒有殘留的測試瀏覽器（父程序已結束、工作目錄在本任務範圍、暫存 profile、任務期間啟動，四項全符合的）。"], 0
    out, failed = [], 0
    for p in targets:
        label = f"pid {p['pid']}（{p['start'].isoformat()} 啟動，profile {p['profile']}，工作目錄 {p['cwd']}）"
        if dry_run:
            out.append(f"・會關閉 {label}")
            continue
        gone = kill_browser(p)
        failed += not gone
        with open(state.parent / "reaped.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"at": now().isoformat(), "pid": p["pid"], "start": p["start"].isoformat(),
                                     "profile": p["profile"], "cwd": p["cwd"], "command": p["command"][:300],
                                     "closed": gone}, ensure_ascii=False) + "\n")
        out.append(f"{'✓ 已關閉並讀回' if gone else '✗ 送出 SIGKILL 後仍在'} {label}")
    return out, 4 if failed else 0


def cmd_reap(args):
    state = Path(args.state).expanduser()
    if not state.is_file():
        die(f"讀不到狀態檔：{state}")
    out, code = reap(state, dry_run=args.dry_run)
    print("\n".join(out))
    return code


def cmd_check(args):
    if args.state:
        state = Path(args.state).expanduser()
        if not state.is_file():
            die(f"讀不到狀態檔：{state}")
        shown, problems = audit(state, claimed=args.final)
        print("\n".join(shown) if shown else "執行期資源：沒有帳本，也不在長任務目錄或工作區範圍內，未掃描。")
        return 4 if problems else 0
    data = load(ledger_of(args))
    snap = {"procs": ps_table(), "containers": docker_containers()}
    running = [r for r in data["resources"] if not r.get("stopped_at")]
    print(f"帳本 {ledger_of(args)}：{len(running)} 筆未停止。")
    for res in running:
        state_now = alive(res, snap)
        print(f"  {describe(res)}：{'執行中' if state_now else '已不在執行' if state_now is False else '無法確認'}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def target(p, wp=True):
        p.add_argument("--state", help="<狀態目錄>/state.md；帳本放在同目錄 resources.json")
        p.add_argument("--ledger", help="改用其他帳本路徑（一般對話的預覽 server 等）")
        if wp:
            p.add_argument("--wp", required=True, help="所屬工作包 id；主線自己的寫「主線」")
            p.add_argument("--close", choices=CLOSE_KINDS, default="wp")
            p.add_argument("--reason", default="")

    p = sub.add_parser("start")
    target(p)
    p.add_argument("--ttl", type=duration, default=0.0)
    p.add_argument("--port", type=int)
    p.add_argument("--cwd")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("_run")
    p.add_argument("--ledger", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--ttl", type=float, default=0.0)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("register")
    target(p)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--pid", type=int)
    group.add_argument("--compose-project")
    group.add_argument("--container")
    group.add_argument("--worktree", help="工作包專用的 git worktree 路徑")
    group.add_argument("--workdir", help="非 git 的工作包資料夾；判定 PASS 後用 prune 清過程檔")
    group.add_argument("--image-repo", help="這個任務建的映像庫（例如 bpm-app）；新候選部署並讀回後用 prune-images 刪舊映像")
    p.add_argument("--host", help="--container、--image-repo 用：遠端主機的 ssh 名稱（例如 ops-staging）")
    p.add_argument("--keep", action="append", help="--workdir：prune 不可刪的檔名樣式；--image-repo：要保留的標籤或映像 ID；可重複")
    p.add_argument("--ttl", type=duration, default=0.0, help="只記到期時間、不自動關")
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("run-container")
    target(p)
    p.add_argument("--name", required=True, help="容器名稱；取本任務唯一的名字")
    p.add_argument("--ttl", type=duration, default=0.0)
    p.add_argument("--memory", help="docker --memory 上限，例如 1g；測試用資料庫建議都設")
    p.add_argument("--protect", action="store_true", help="到期不自動停，只由主線 stop（正式資料副本等）")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_run_container)

    p = sub.add_parser("prune-images")
    target(p, wp=False)
    p.add_argument("--id", required=True)
    p.add_argument("--keep", action="append", help="這次另外要保留的標籤或映像 ID；可重複")
    p.set_defaults(func=cmd_prune_images)

    p = sub.add_parser("renew")
    target(p, wp=False)
    p.add_argument("--id", required=True)
    p.add_argument("--ttl", type=duration, required=True)
    p.set_defaults(func=cmd_renew)

    p = sub.add_parser("_expire")
    p.add_argument("--ledger", required=True)
    p.add_argument("--id", required=True)
    p.set_defaults(func=cmd_expire)

    p = sub.add_parser("stop")
    target(p, wp=False)
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--id")
    which.add_argument("--wp")
    which.add_argument("--all", action="store_true")
    p.add_argument("--include-acceptance", action="store_true")
    p.add_argument("--remove", action="store_true", help="停止後移除（先核對判定與引用、記入 deletions.md）")
    p.add_argument("--integrated-into", help="移除工作樹時，已整合進去的候選版 commit 或分支")
    p.add_argument("--search", action="append", help="引用搜尋另外要看的檔案或目錄（例如監督 run 目錄）；可重複")
    p.set_defaults(func=cmd_stop)

    p = sub.add_parser("tmpdir")
    target(p, wp=False)
    p.add_argument("--wp", required=True, help="所屬工作包 id；主線自己的寫「主線」")
    p.set_defaults(func=cmd_tmpdir)

    p = sub.add_parser("prune")
    target(p, wp=False)
    p.add_argument("--wp", required=True)
    p.add_argument("--none", action="store_true", help="沒有可刪的過程檔，只記一筆（須 --reason）")
    p.add_argument("--reason", default="")
    p.add_argument("--search", action="append", help="引用搜尋另外要看的檔案或目錄（例如監督 run 目錄）；可重複")
    p.add_argument("paths", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_prune)

    p = sub.add_parser("wait")
    p.add_argument("--timeout", type=duration, required=True)
    p.add_argument("--interval", type=duration, default=20.0)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_wait)

    p = sub.add_parser("check")
    target(p, wp=False)
    p.add_argument("--final", action="store_true", help="以「即將宣稱完成」的標準核對")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("reap")
    p.add_argument("--state", required=True, help="<狀態目錄>/state.md")
    p.add_argument("--dry-run", action="store_true", help="只列出會關哪幾支，不關")
    p.set_defaults(func=cmd_reap)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if getattr(args, "interval", 1) <= 0:
        die("--interval 必須大於 0")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

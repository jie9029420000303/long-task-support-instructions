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
           登記自己脫離的資源（docker compose up -d、docker run、已在跑的程序）。
  stop     --state S (--id R | --wp ID | --all) [--include-acceptance]
           關閉並核對已停止；只動帳本內、啟動時間核對相符的資源，external 不動。
  wait     --timeout 30m [--interval 20s] -- 查核指令…
           每隔 interval 跑一次查核指令，exit 0 就結束；逾時 exit 124。逾時必填。
  check    --state S [--final]
           印出帳本實況與未登記資源；需收尾時 exit 4。--final＝以「即將宣稱完成」的標準核對。
           sidecar-guard.py 每次派工前與判定後也跑同一段核對。
exit：0 通過；2 參數或檔案錯誤；4 有資源需要收尾或登記；124 wait 逾時。
check 與守門只報告，不自動關閉任何資源。未登記資源＝在「任務建立」到「狀態檔最後寫入」之間啟動、已脫離 session（父程序是 1）、
同一使用者、非 launchd 常駐、工作目錄在任務範圍內的程序，以及 compose working_dir 在同範圍內或帶
`lt.task=<任務目錄名>` 標籤的容器；已登記在任何任務帳本（含 external）的資源不列。
任務範圍＝專案根＋任務紀錄（state.md、archive.md、wp/*.md）裡的 `path:` 工作區＋紀錄裡提到的同 repo worktree
——整合候選版的 worktree 不屬任何工作包、已結束的工作包會封存進 archive.md，只看工作包表會漏掉這兩種。
時間上限用狀態檔最後寫入：主線本來就是先更新狀態檔再跑守門；已結案或被 git 帶進其他 worktree 的舊狀態檔
停在當時，之後才啟動的程序不歸給它（2026-09-30 對 202 份真實狀態檔實測：沒有這個上限時 6 份舊任務被誤報）。
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

CLOSE_KINDS = ("wp", "final", "acceptance", "external")
NEEDS_REASON = {"acceptance", "external"}
ACCEPTANCE_TTL = 72 * 3600
ROW = re.compile(r"^\|(?!\s*:?-{3})")
JUDGED = re.compile(r"PASS|FAIL|主線接手")
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


def docker_containers():
    """執行中的容器清單；docker 不可用時回 None（照實回報「沒掃」，不當成沒有）。"""
    try:
        result = subprocess.run(["docker", "ps", "--no-trunc", "--format", DOCKER_FORMAT],
                                capture_output=True, text=True, timeout=30)
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
        found.append({"id": f[0], "name": f[1], "created": created, "project": f[3], "working_dir": f[4], "task": f[5]})
    return found


def take_snapshot():
    procs = ps_table()
    uid = os.getuid()
    detached = [p["pid"] for p in procs.values() if p["ppid"] == 1 and p["uid"] == uid]
    for pid, cwd in cwds(detached).items():
        procs[pid]["cwd"] = cwd
    return {"procs": procs, "uid": uid, "launchd": launchd_pids(), "containers": docker_containers()}


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
    if snap.get("containers") is None:
        return None
    recorded = {item["id"] for item in res.get("container_identities", []) if item.get("id")}
    return [c["id"] for c in snap["containers"] if c["id"] in recorded]


def container_candidates(res, snap):
    """用可讀名稱找現在的容器；只用於回報身分不符，不能當成停止目標。"""
    if snap.get("containers") is None:
        return None
    if res["kind"] == "compose":
        return [c for c in snap["containers"] if c["project"] == res["project"]]
    return [c for c in snap["containers"] if c["name"] == res["container"]]


def container_identity(c):
    created = c.get("created")
    return {"id": c["id"], "name": c["name"],
            "created": created.isoformat() if isinstance(created, dt.datetime) else created}


def inactive_note(res, snap):
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
    if res["kind"] == "process":
        return bool(members(res, snap))
    found = containers_of(res, snap)
    return None if found is None else bool(found)


def describe(res):
    target = {
        "process": f"pid {res.get('pgid') or res.get('pid')}" + (f"、port {res['port']}" if res.get("port") else ""),
        "compose": f"compose 專案 {res.get('project')}",
        "container": f"容器 {res.get('container')}",
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
    until = dt.datetime.fromtimestamp(info.st_mtime)
    return sorted({os.path.realpath(r) for r in roots}), since, until, task_dir.name, worktrees


def registered(state, worktrees=()):
    """所有任務帳本（本任務、同專案與同 repo 其他 worktree 的任務）裡還沒停止的資源；這些都有主人，不算未登記。"""
    keys = {"pids": set(), "pgids": set(), "projects": set(), "containers": set()}
    ledgers = {state.parent / "resources.json"} | set(state.parent.parent.glob("*/resources.json"))
    for tree in worktrees:
        for pattern in (".claude/long-task/*/resources.json", ".codex/long-task/*/resources.json"):
            ledgers |= set(Path(tree).glob(pattern))
    for path in ledgers:
        with contextlib.suppress(OSError, ValueError):
            for res in load(path)["resources"]:
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
    return keys


def inside(path, roots):
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in roots)


def unregistered(roots, since, until, task, snap, keys):
    found = []
    launchd = snap.get("launchd") or set()
    for p in snap["procs"].values():
        if p["ppid"] != 1 or p["uid"] != snap.get("uid", os.getuid()) or p["pid"] in launchd:
            continue
        if not since <= p["start"] <= until or p["pid"] in keys["pids"] or p["pgid"] in keys["pgids"]:
            continue
        if p.get("cwd") and roots and inside(p["cwd"], roots):
            found.append(f"程序 pid {p['pid']}（{p['cwd']}）：{p['command'][:100]}")
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
    shown, problems = [], []
    for res in running:
        state_now = alive(res, snap)
        if state_now is False:
            shown.append(f"  {describe(res)}：{inactive_note(res, snap)}")
            continue
        if res.get("close") in NEEDS_REASON and not res.get("reason"):
            problems.append(f"{describe(res)}：標為 {res.get('close')} 卻沒寫理由")
        elif res.get("close") == "wp" and res.get("wp") in judged:
            problems.append(f"{describe(res)}：工作包 {res.get('wp')} 已判定，資源還在跑")
        elif claimed and res.get("close") in ("wp", "final"):
            problems.append(f"{describe(res)}：最終判定宣稱完成，資源還在跑")
        else:
            note = "無法確認（docker 不可用）" if state_now is None else "執行中"
            reason = f"；理由：{res['reason']}" if res.get("reason") else ""
            shown.append(f"  {describe(res)}：{note}{reason}")
    loose, scanned_containers = unregistered(roots, since, until, task, snap, registered(state, worktrees))
    problems += [f"未登記 {item}" for item in loose]
    head = f"執行期資源：帳本 {len(running)} 筆未停止，需處理 {len(problems)} 筆"
    if roots and not scanned_containers:
        head += "；docker 不可用，容器沒有掃描"
    out = [head + "。"] + shown + [f"  ✗ {p}" for p in problems]
    if problems:
        out.append("先關閉（resource-ledger.py stop）、補登記（register），或改標 acceptance／external 並寫理由，"
                   "再重跑；守門只報告，不會自動關閉任何資源。")
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
    if args.pid:
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
        result = subprocess.run(["docker", "stop", *ids], capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return False, "docker 停止指令失敗"
    if result.returncode != 0:
        return False, f"docker stop 失敗（exit {result.returncode}）"
    current = docker_containers()
    if current is None:
        return False, "docker 不可用，無法核對停止結果"
    left = containers_of(res, {"containers": current})
    return (not left), ("已停止並核對" + mismatch if not left else f"原登記身分仍有 {len(left)} 個容器在跑")


def cmd_stop(args):
    path = ledger_of(args)
    data = load(path)
    targets = []
    for res in data["resources"]:
        if res.get("stopped_at") or res.get("close") == "external":
            continue
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
        ok, note = terminate(res, snap)
        print(f"{'✓' if ok else '✗'} {describe(res)}：{note}")
        if ok:
            mark_stopped(path, res["id"], note)
        else:
            failed += 1
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
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("stop")
    target(p, wp=False)
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--id")
    which.add_argument("--wp")
    which.add_argument("--all", action="store_true")
    p.add_argument("--include-acceptance", action="store_true")
    p.set_defaults(func=cmd_stop)

    p = sub.add_parser("wait")
    p.add_argument("--timeout", type=duration, required=True)
    p.add_argument("--interval", type=duration, default=20.0)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_wait)

    p = sub.add_parser("check")
    target(p, wp=False)
    p.add_argument("--final", action="store_true", help="以「即將宣稱完成」的標準核對")
    p.set_defaults(func=cmd_check)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if getattr(args, "interval", 1) <= 0:
        die("--interval 必須大於 0")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

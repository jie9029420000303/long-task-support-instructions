"""v1.8.0 資源回收（Jay 2026-11-18 對六項資源觀察的選擇：Q2-A、Q4-A、Q5-A 的技能部分）。

當天實測：一支 AWR 測試逾時後，它自行開的 Chrome for Testing（暫存 profile、父程序已結束）活了 22 小時，守門只報不關；
~/worktrees 287 個目錄、152GB，多數建立時沒登記，結案時沒人知道該收哪些；1005 個 Docker 資料卷只有 1 個帶任務標籤。
這裡每個測試守一件事：reap 只關四項條件全符合的瀏覽器、絕不碰別的程序；任務期間建立、紀錄寫到的 worktree 不登記就擋；
宣稱完成時只要求移除「PASS、乾淨、已整合、沒被證據引用」的 worktree，有未保存內容的一律保留；具名資料卷建立時就帶任務標籤。
"""
import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
ROOT = REPOSITORY / "goal-orchestrator" / "scripts"
if not ROOT.is_dir():
    ROOT = REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "scripts"
LEDGER = str(ROOT / "resource-ledger.py")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resource_ledger = load("v180_resource_ledger", ROOT / "resource-ledger.py")
FAKE_DOCKER = load("v180_v160", Path(__file__).resolve().parent / "test_v160_resource_governance.py").FAKE_DOCKER.replace(
    '    with open(db + ".tmp"',
    '    elif argv[0] == "volume":\n'
    '        volumes = data.setdefault("volumes", {})\n'
    '        if argv[1] == "inspect":\n'
    '            code = 0 if argv[2] in volumes else 1\n'
    '        elif argv[1] == "create":\n'
    '            volumes[argv[-1]] = dict(argv[i + 1].split("=", 1) for i, a in enumerate(argv) if a == "--label")\n'
    '    with open(db + ".tmp"') + '\nsys.exit(globals().get("code", 0))\n'
CHROME = ("/Users/jay/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/"
          "MacOS/Google Chrome for Testing --headless --no-sandbox --remote-debugging-port=0 --user-data-dir={profile} "
          "--remote-allow-origins=* --no-first-run about:blank")


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


class Task(unittest.TestCase):
    """暫存專案 <root>/.codex/long-task/t/state.md；LONG_TASK_HOME 指到暫存目錄，不讀這台機器真正的帳本索引。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self.home = str(Path(self.root) / "home")
        self.saved = os.environ.get("LONG_TASK_HOME")
        os.environ["LONG_TASK_HOME"] = self.home
        self.state = self.write_state([("B-1", "在途")])

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("LONG_TASK_HOME", None)
        else:
            os.environ["LONG_TASK_HOME"] = self.saved
        self.tmp.cleanup()

    def write_state(self, packages, minutes_ago=2):
        directory = Path(self.root) / ".codex" / "long-task" / "t"
        directory.mkdir(parents=True, exist_ok=True)
        created = (dt.datetime.now() - dt.timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M")
        rows = "".join(f"| {i} | B | {state} | path:{self.root}/wt-{i} |\n" for i, state in packages)
        path = directory / "state.md"
        path.write_text(f"# 長任務狀態：t\n\n- 建立：{created}\n\n## 工作包\n"
                        "| id | 類型 | 狀態（待派／在途／PASS／FAIL） | 工作區（path／worktree／base） |\n|---|---|---|---|\n"
                        f"{rows}\n## 最終判定\n未完成\n", encoding="utf-8")
        return path

    def cli(self, *args):
        return subprocess.run([sys.executable, LEDGER, *args], capture_output=True, text=True, cwd=self.root, timeout=180)


def proc(pid, command, cwd, ppid=1, start=None, pgid=None):
    return {"pid": pid, "ppid": ppid, "pgid": pgid or pid, "uid": os.getuid(), "command": command, "cwd": cwd,
            "start": start or dt.datetime.now().replace(microsecond=0)}


class OrphanBrowserTests(Task):
    def snapshot(self, procs):
        return {"procs": {p["pid"]: p for p in procs}, "uid": os.getuid(), "launchd": set(), "containers": [],
                "all_containers": []}

    def test_only_a_browser_meeting_all_four_conditions_is_counted(self):
        # 少任何一項都可能是別人的瀏覽器：使用者自己開的、別的任務的測試還在用的、任務開始前就在的、已登記保留的。
        wt, tmp = f"{self.root}/wt-B-1", tempfile.gettempdir()
        (self.state.parent / "resources.json").write_text(json.dumps({"resources": [
            {"id": "r1", "wp": "B-1", "kind": "process", "pgid": 9007, "close": "acceptance", "reason": "預覽"}]}), "utf-8")
        live = self.snapshot([
            proc(9001, CHROME.format(profile=f"{tmp}/stg0-ext-xHqCKX"), wt),
            proc(9002, CHROME.format(profile=os.path.expanduser("~/Library/Application Support/AWR/profiles/shop")), wt),
            proc(9003, CHROME.format(profile=f"{tmp}/p3"), wt, ppid=4321),
            proc(9004, CHROME.format(profile=f"{tmp}/p4"), "/Users/someone-else/project"),
            proc(9005, CHROME.format(profile=f"{tmp}/p5"), wt, start=dt.datetime.now() - dt.timedelta(days=2)),
            proc(9006, CHROME.format(profile=f"{tmp}/p6").replace("MacOS/Google Chrome for Testing --",
                                                                 "MacOS/Google Chrome for Testing Helper (Renderer) --"), wt),
            proc(9007, CHROME.format(profile=f"{tmp}/p7"), wt),
            proc(9008, f"/usr/bin/python3 -m http.server 8000", wt),
        ])
        keys = resource_ledger.registered(self.state)
        roots, since, _until, _task, _trees = resource_ledger.task_scope(self.state, self.state.read_text("utf-8").splitlines())
        found = resource_ledger.orphan_browsers(roots, since, resource_ledger.now(), live, keys)
        self.assertEqual([9001], [p["pid"] for p in found])
        shown, problems = resource_ledger.audit(self.state, snapshot=live)
        self.assertTrue(any("pid 9001（暫存 profile 的測試瀏覽器，reap 可收）" in p for p in problems), problems)
        self.assertTrue(any("pid 9008（" in p for p in problems), "其他脫離的程序照舊只報、不歸 reap")
        self.assertTrue(any("reap --state" in line for line in shown))

    def test_reap_closes_the_whole_browser_group_and_nothing_else(self):
        wt = Path(self.root) / "wt-B-1"
        wt.mkdir()
        # 兩層 fork：讓「瀏覽器」與旁觀程序都真的成為父程序已結束（父程序是 1）的獨立 process group。
        # 子程序的 stdout／stderr 都要導走，否則它會一直握著外層 capture 的管線，subprocess.run 要等到它結束才返回。
        spawn = ("import subprocess,sys;"
                 "p=subprocess.Popen(sys.argv[1:],start_new_session=True,stdout=subprocess.DEVNULL,"
                 "stderr=subprocess.DEVNULL);print(p.pid)")
        browser = int(subprocess.run([sys.executable, "-c", spawn, "/bin/sh", "-c", "sleep 300 & sleep 300; wait"],
                                     cwd=wt, capture_output=True, text=True, check=True).stdout)
        bystander = int(subprocess.run([sys.executable, "-c", spawn, "sleep", "301"], cwd=wt, capture_output=True,
                                       text=True, check=True).stdout)
        self.addCleanup(lambda: [os.killpg(g, 9) for g in (browser, bystander) if resource_ledger.ps_table().get(g)])
        time.sleep(0.5)
        table = resource_ledger.ps_table()
        group = [p for p in table.values() if p["pgid"] == browser]
        self.assertGreaterEqual(len(group), 2, "瀏覽器主程序加一個輔助程序")
        fake = dict(table[browser], command=CHROME.format(profile=f"{tempfile.gettempdir()}/stg0-ext-test"), cwd=str(wt))
        other = dict(table[bystander], cwd=str(wt))
        live = {"procs": {browser: fake, bystander: other}, "uid": os.getuid(), "launchd": set()}
        lines, code = resource_ledger.reap(self.state, dry_run=True, snapshot=live)
        self.assertEqual(0, code)
        self.assertIn(f"會關閉 pid {browser}", lines[0])
        self.assertIn(browser, resource_ledger.ps_table(), "dry-run 不關")
        lines, code = resource_ledger.reap(self.state, snapshot=live)
        self.assertEqual(0, code, lines)
        self.assertIn("已關閉並讀回", lines[0])
        after = resource_ledger.ps_table()
        self.assertEqual([], [p["pid"] for p in after.values() if p["pgid"] == browser], "整組（含輔助程序）都關")
        self.assertIn(bystander, after, "不是測試瀏覽器的程序不動")
        record = json.loads((self.state.parent / "reaped.jsonl").read_text("utf-8").splitlines()[0])
        self.assertEqual([browser, True], [record["pid"], record["closed"]])

    def test_a_reused_pid_is_never_signalled(self):
        # 主程序已結束、PID 被別的程序拿去用：啟動時間對不上就當作已關，不送任何訊號。
        me = resource_ledger.ps_table()[os.getpid()]
        stale = dict(me, start=me["start"] - dt.timedelta(hours=5))
        self.assertEqual([], resource_ledger.browser_members(stale, resource_ledger.ps_table()))
        self.assertTrue(resource_ledger.kill_browser(stale))


class WorktreeTests(Task):
    def setUp(self):
        super().setUp()
        git(self.root, "init", "-q", "-b", "main")
        (Path(self.root) / ".gitignore").write_text(".codex/\nhome/\n", encoding="utf-8")
        git(self.root, "add", ".")
        git(self.root, "commit", "-q", "-m", "base")
        self.tree = Path(self.root) / "wt-B-1"
        git(self.root, "worktree", "add", "-q", "-b", "wp/B-1", str(self.tree))
        git(self.root, "worktree", "add", "-q", "--detach", f"{self.root}/wt-not-mine")
        time.sleep(1.1)
        self.state = self.write_state([("B-1", "在途")])  # 主線先建 worktree 再寫紀錄

    def audit(self, claimed=False):
        live = {"procs": {}, "uid": os.getuid(), "launchd": set(), "containers": [], "all_containers": []}
        return resource_ledger.audit(self.state, claimed=claimed, snapshot=live)

    def test_a_worktree_made_during_the_task_must_be_registered(self):
        _, problems = self.audit()
        self.assertEqual([f"未登記 工作樹 {self.tree}"], [p.split("：")[0] for p in problems],
                         "紀錄沒寫到的 wt-not-mine 可能是別的任務的，不歸本任務")
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--worktree", str(self.tree)).returncode)
        self.assertEqual([], self.audit()[1])

    def test_closing_removes_only_a_passed_clean_integrated_worktree(self):
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--worktree", str(self.tree)).returncode)
        (self.tree / "b.txt").write_text("b\n", encoding="utf-8")
        git(self.tree, "add", ".")
        git(self.tree, "commit", "-q", "-m", "work")
        self.state = self.write_state([("B-1", "PASS")])
        shown, problems = self.audit(claimed=True)
        self.assertEqual([], problems)
        self.assertTrue(any("保留（提交還沒整合進專案" in line for line in shown), shown)
        git(self.root, "merge", "-q", "--ff-only", "wp/B-1")
        (self.tree / "draft.txt").write_text("還沒提交\n", encoding="utf-8")
        shown, problems = self.audit(claimed=True)
        self.assertEqual([], problems, "有未保存內容的一律保留，不擋結案")
        self.assertTrue(any("保留（有未提交或未追蹤的檔案）" in line for line in shown), shown)
        (self.tree / "draft.txt").unlink()
        _, problems = self.audit(claimed=True)
        self.assertEqual(1, len(problems))
        self.assertIn("宣稱完成前 stop --id r1 --remove", problems[0])
        result = self.cli("stop", "--state", str(self.state), "--id", "r1", "--remove", "--integrated-into", "main")
        self.assertIn("已移除並讀回", result.stdout, result.stdout + result.stderr)
        self.assertFalse(self.tree.exists())
        self.assertIn("wp/B-1", git(self.root, "branch", "--list", "wp/B-1"), "分支保留")
        self.assertEqual([], self.audit(claimed=True)[1])


class VolumeLabelTests(Task):
    def test_named_volumes_are_created_with_the_task_labels_and_existing_ones_are_left_alone(self):
        bin_dir = Path(self.root) / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
        (bin_dir / "docker").chmod(0o755)
        db = Path(self.root) / "docker.json"
        db.write_text(json.dumps({"items": [], "calls": [], "volumes": {"awr-profiles": {}}}), encoding="utf-8")
        env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_DOCKER_DB=str(db))
        result = subprocess.run([sys.executable, LEDGER, "run-container", "--state", str(self.state), "--wp", "B-1",
                                 "--name", "pg", "--ttl", "2h", "--protect", "--",
                                 "-v", "pgdata:/var/lib/postgresql/data", "-v", f"{self.root}/seed:/seed",
                                 "--mount", "type=volume,source=cache,target=/cache", "-v", "awr-profiles:/profiles",
                                 "postgres:16"], capture_output=True, text=True, env=env, cwd=self.root, timeout=120)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        volumes = json.loads(db.read_text("utf-8"))["volumes"]
        self.assertEqual({"awr-profiles", "pgdata", "cache"}, set(volumes), "主機路徑掛載不是資料卷")
        for name in ("pgdata", "cache"):
            self.assertEqual(("t", "B-1"), (volumes[name]["lt.task"], volumes[name]["lt.wp"]))
        self.assertEqual({}, volumes["awr-profiles"], "已存在的資料卷（可能存有登入狀態）不動、不改標籤")
        entry = resource_ledger.load(self.state.parent / "resources.json")["resources"][-1]
        self.assertEqual(["pgdata", "cache"], entry["volumes"])


if __name__ == "__main__":
    unittest.main()


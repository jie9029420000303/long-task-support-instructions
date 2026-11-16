"""v1.6.0 資源治理（Jay 2026-11-16：「技能都先修完，重開……直接開始量測是否有達到預期設計效果」）。

2026-11-14 一台 16GB 機器在三個長任務並行時當機：42 個 swap 檔、6 個 1.3–2.0GB 的 node 同時在跑、316 個已停止容器
沒人移除、4 個沒標籤的容器守門看不到、工區 A 的 9 個資料庫全標整場才關。這裡每個測試守一件事：
自動關閉只碰「自己啟動、身分齊全、真的到期」的那一個容器，而且只停不刪；移除只在判定 PASS、沒有被證據引用時發生並先記清冊；
守門多看到的東西只列出、不擋派工；重型工作同時只跑設定的數量，排隊不吃掉測試自己的時限；沒有設定檔的機器行為不變。

容器測試用一支假的 docker 指令（放在 PATH 最前面、狀態存在暫存檔），所以走的是真正的命令列與背景計時，不碰這台機器的 Docker。
"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
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
TEST_RUN = str(ROOT / "test-run.py")


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resource_ledger = load("v160_resource_ledger", "resource-ledger.py")
sidecar_guard = load("v160_sidecar_guard", "sidecar-guard.py")

FAKE_DOCKER = r'''#!/usr/bin/env python3
import fcntl, hashlib, json, os, sys, time
db, argv = os.environ["FAKE_DOCKER_DB"], sys.argv[1:]
with open(db + ".lock", "a+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        data = json.load(open(db, encoding="utf-8"))
    except (OSError, ValueError):
        data = {"items": [], "calls": []}
    data["calls"].append(argv)
    items = data["items"]
    if argv[0] == "run":
        name = argv[argv.index("--name") + 1]
        labels = dict(argv[i + 1].split("=", 1) for i, a in enumerate(argv) if a == "--label")
        cid = hashlib.sha256((name + str(len(data["calls"]))).encode()).hexdigest()
        items.append({"id": cid, "name": name, "created": time.strftime("%Y-%m-%d %H:%M:%S %z") + " CST",
                      "labels": labels, "state": "running"})
        print(cid)
    elif argv[0] == "ps":
        wide = "{{.State}}" in argv[argv.index("--format") + 1]
        for c in items:
            if "-a" not in argv and c["state"] != "running":
                continue
            label = c["labels"].get
            row = [c["id"], c["name"], c["created"], label("com.docker.compose.project", ""),
                   label("com.docker.compose.project.working_dir", ""), label("lt.task", "")]
            if wide:
                row += [c["state"], label("lt.wp", ""), label("lt.close", ""), label("lt.ledger", "")]
            print("\t".join(row))
    elif argv[0] == "stop":
        for c in items:
            if c["id"] in argv[1:]:
                c["state"] = "exited"
    elif argv[0] == "rm":
        data["items"] = [c for c in items if c["id"] not in argv[1:]]
    with open(db + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(db + ".tmp", db)
'''


class Project(unittest.TestCase):
    """一個暫存專案：<root>/.claude/long-task/t/state.md、假 docker、專屬的本機設定目錄。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        bin_dir = Path(self.root) / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(FAKE_DOCKER, encoding="utf-8")
        (bin_dir / "docker").chmod(0o755)
        self.db = str(Path(self.root) / "docker.json")
        self.home = str(Path(self.root) / "home")
        self.env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_DOCKER_DB=self.db,
                        LONG_TASK_HOME=self.home)
        self.state = self.task(self.root, [("B-1", "在途")])

    def tearDown(self):
        # run-container 與 renew 掛的背景計時（sh + sleep，各自一個 session）不留到測試之後。
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
        for line in out.splitlines():
            pid, _, command = line.strip().partition(" ")
            if "lt-expire" in command and self.root in command and pid.isdigit():
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(int(pid), signal.SIGKILL)
        self.tmp.cleanup()

    @staticmethod
    def task(root, packages, task="t"):
        directory = Path(root) / ".claude" / "long-task" / task
        directory.mkdir(parents=True, exist_ok=True)
        created = (dt.datetime.now() - dt.timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M")
        rows = "".join(f"| {i} | B | {state} | path:{root}/wt-{i} |\n" for i, state in packages)
        (directory / "state.md").write_text(
            f"# 長任務狀態：{task}\n\n- 建立：{created}\n\n## 工作包\n"
            "| id | 類型 | 狀態（待派／在途／PASS／FAIL） | 工作區（path／worktree／base） |\n|---|---|---|---|\n"
            f"{rows}\n## 最終判定\n未完成\n", encoding="utf-8")
        return directory / "state.md"

    def cli(self, *args, env=None, timeout=120):
        return subprocess.run([sys.executable, LEDGER, *args], capture_output=True, text=True, cwd=self.root,
                              env=env or self.env, timeout=timeout)

    def docker(self):
        try:
            return json.loads(Path(self.db).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"items": [], "calls": []}

    def container(self, name):
        return next((c for c in self.docker()["items"] if c["name"] == name), None)

    def calls(self, verb):
        return [call for call in self.docker()["calls"] if call[0] == verb]

    def ledger(self, state=None):
        return resource_ledger.load((state or self.state).parent / "resources.json")["resources"]

    def entry(self, rid):
        return next(r for r in self.ledger() if r["id"] == rid)

    def edit_ledger(self, rid, **fields):
        path = self.state.parent / "resources.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        for res in data["resources"]:
            if res["id"] == rid:
                res.update(fields)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def run_container(self, name, *extra, wp="B-1", ttl="1h", image=("postgres:16",)):
        result = self.cli("run-container", "--state", str(self.state), "--wp", wp, "--name", name, "--ttl", ttl,
                          *extra, "--", *image)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return self.ledger()[-1]["id"]

    def wait_until(self, predicate, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.1)
        return predicate()

    @staticmethod
    def past():
        return (dt.datetime.now() - dt.timedelta(minutes=1)).replace(microsecond=0).isoformat()


class ContainerStartAndExpiryTests(Project):
    def test_one_command_starts_labels_registers_and_sets_the_expiry(self):
        # 「登記靠自律」是 11/14 的洞（工區 B、E 完全沒有帳本檔）：啟動、四個身分標籤、帳本與到期時間必須是同一步，
        # 少了到期時間就不啟動——否則又是一批整場不關的資料庫。
        missing = self.cli("run-container", "--state", str(self.state), "--wp", "B-1", "--name", "db", "--", "postgres:16")
        self.assertEqual(2, missing.returncode)
        other = self.cli("run-container", "--state", str(self.state), "--wp", "B-1", "--name", "db", "--ttl", "1h",
                         "--close", "external", "--reason", "別人的", "--", "postgres:16")
        self.assertEqual(2, other.returncode)
        self.assertEqual([], self.calls("run"), "參數不齊時不得真的啟動容器")
        rid = self.run_container("db", "--memory", "1g", image=("-e", "POSTGRES_PASSWORD=x", "postgres:16"))
        run = self.calls("run")[0]
        self.assertEqual(["-e", "POSTGRES_PASSWORD=x", "postgres:16"], run[-3:], "使用者給的參數原樣放在最後")
        self.assertIn("-d", run)
        self.assertEqual("1g", run[run.index("--memory") + 1])
        ledger_path = os.path.realpath(self.state.parent / "resources.json")
        self.assertEqual({"lt.task": "t", "lt.wp": "B-1", "lt.close": "wp", "lt.ledger": ledger_path},
                         self.container("db")["labels"])
        saved = self.entry(rid)
        self.assertEqual([self.container("db")["id"]], [item["id"] for item in saved["container_identities"]])
        self.assertTrue(saved["managed"])
        self.assertFalse(saved["protected"])
        expires = dt.datetime.fromisoformat(saved["expires_at"])
        self.assertAlmostEqual(3600, (expires - dt.datetime.now()).total_seconds(), delta=30)

    def test_an_expired_container_is_stopped_by_itself_and_never_deleted(self):
        # 主線被限速打斷或當機時沒人會來關；到期由背景計時自己停。只停這一個、不刪：資料與現場留給主線判定。
        rid = self.run_container("db", ttl="1s")
        neighbour = self.run_container("neighbour", ttl="1h")
        self.assertTrue(self.wait_until(lambda: self.container("db")["state"] == "exited", 8), "到期後容器仍在執行")
        self.assertTrue(self.wait_until(lambda: bool(self.entry(rid).get("stopped_at")), 3))
        self.assertIn("到期自動停止", self.entry(rid)["stop_note"])
        self.assertEqual([["stop", self.container("db")["id"]]], self.calls("stop"), "只能停到期的那一個")
        self.assertEqual("running", self.container("neighbour")["state"])
        self.assertIsNone(self.entry(neighbour).get("stopped_at"))
        self.assertEqual([], self.calls("rm"), "到期只停不刪")

    def test_expiry_never_touches_what_it_cannot_prove_is_its_own(self):
        # 品質標準是誤關 0 件：記憶體資料庫與正式資料副本（停了資料就沒了）、已續期的、標籤和帳本對不上的、
        # 不是 run-container 建立的，到期程式一律不動，並把原因留在帳本。
        memory = self.run_container("memory-db", image=("--tmpfs", "/var/lib/postgresql/data", "postgres:16"))
        copy = self.run_container("prod-copy", "--protect")
        self.assertTrue(self.entry(memory)["protected"] and self.entry(copy)["protected"])
        relabelled = self.run_container("relabelled")
        data = self.docker()
        for item in data["items"]:
            if item["name"] == "relabelled":
                item["labels"]["lt.ledger"] = "/another/task/resources.json"
        Path(self.db).write_text(json.dumps(data), encoding="utf-8")
        data["items"].append({"id": "manual-id", "name": "manual", "created": data["items"][0]["created"],
                              "labels": {}, "state": "running"})
        Path(self.db).write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--container", "manual",
                                     "--ttl", "1h").returncode)
        manual = self.ledger()[-1]["id"]
        self.assertFalse(self.entry(manual).get("managed"))
        for rid in (memory, copy, relabelled, manual):
            self.edit_ledger(rid, expires_at=self.past())
            self.assertEqual(0, self.cli("_expire", "--ledger", str(self.state.parent / "resources.json"),
                                         "--id", rid).returncode)
        self.assertEqual([], self.calls("stop"))
        self.assertTrue(all(c["state"] == "running" for c in self.docker()["items"]))
        self.assertIn("lt.ledger", self.entry(relabelled)["expire_note"])
        self.assertTrue(all(not r.get("stopped_at") for r in self.ledger()))

    def test_renewing_keeps_a_container_that_is_still_in_use(self):
        # 到期時間從最後一次續期起算：還在用的資料庫不能因為第一個計時到點就被停掉。
        rid = self.run_container("db", ttl="1s")
        result = self.cli("renew", "--state", str(self.state), "--id", rid, "--ttl", "1h")
        self.assertEqual(0, result.returncode, result.stderr)
        time.sleep(3)
        self.assertEqual("running", self.container("db")["state"])
        self.assertEqual([], self.calls("stop"))
        self.assertGreater(dt.datetime.fromisoformat(self.entry(rid)["expires_at"]),
                           dt.datetime.now() + dt.timedelta(minutes=50))
        self.assertEqual(2, self.cli("renew", "--state", str(self.state), "--id", "r9", "--ttl", "1h").returncode)

    def test_a_registered_expiry_is_a_reminder_not_a_shutdown(self):
        # register 登記的是別處啟動的資源，身分不齊；到期時間只讓守門提醒，不自動關，也不因此擋派工。
        Path(self.db).write_text(json.dumps({"calls": [], "items": [{
            "id": "manual-id", "name": "manual", "created": time.strftime("%Y-%m-%d %H:%M:%S %z") + " CST",
            "labels": {}, "state": "running"}]}), encoding="utf-8")
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--container", "manual",
                                     "--ttl", "1s").returncode)
        time.sleep(1.5)
        result = self.cli("check", "--state", str(self.state))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("已過到期時間", result.stdout)
        self.assertEqual("running", self.container("manual")["state"])
        self.assertEqual([], self.calls("stop"))


class RemovalTests(Project):
    def test_a_container_is_removed_only_after_pass_and_with_no_reference_left(self):
        # 316 個已停止容器沒人移除，但移除不能換來誤刪：FAIL 或還沒判定的現場要留著排查，
        # 名字還出現在證據裡的要留著對照；通過的才移除，而且先記刪除清冊、刪後讀回。
        rid = self.run_container("db")
        cid = self.container("db")["id"]
        deletions = self.state.parent / "deletions.md"
        result = self.cli("stop", "--state", str(self.state), "--wp", "B-1", "--remove")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("不是 PASS", result.stdout)
        self.assertEqual("exited", self.container("db")["state"], "還沒判定：只停不刪")
        for verdict in ("FAIL", "主線接手", "PASS"):
            self.task(self.root, [("B-1", verdict)])
            evidence = self.state.parent / "evidence"
            evidence.mkdir(exist_ok=True)
            (evidence / "B-1-測試紀錄.txt").write_text("連線 db:5432 通過\n", encoding="utf-8")
            result = self.cli("stop", "--state", str(self.state), "--wp", "B-1", "--remove")
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIsNotNone(self.container("db"), verdict)
        self.assertIn("仍被 1 個檔案引用", result.stdout)
        self.assertEqual([], self.calls("rm"))
        self.assertFalse(deletions.exists(), "沒有刪除就不該有清冊列")
        (self.state.parent / "evidence" / "B-1-測試紀錄.txt").unlink()
        result = self.cli("stop", "--state", str(self.state), "--wp", "B-1", "--remove")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIsNone(self.container("db"))
        self.assertEqual([["rm", "-v", cid]], self.calls("rm"))
        row = [line for line in deletions.read_text(encoding="utf-8").splitlines() if "容器 db" in line]
        self.assertEqual(1, len(row))
        self.assertIn("工作包 B-1", row[0])
        self.assertIn("讀回已不存在", row[0])
        self.assertNotIn("待讀回", row[0])
        self.assertTrue(self.entry(rid).get("removed_at"))

    def test_a_container_started_some_other_way_is_stopped_but_never_removed(self):
        # 上線前就存在、或不是 run-container 建立的容器身分不齊，無法證明是本任務的中間產物：照舊只停。
        Path(self.db).write_text(json.dumps({"calls": [], "items": [{
            "id": "manual-id", "name": "manual", "created": time.strftime("%Y-%m-%d %H:%M:%S %z") + " CST",
            "labels": {}, "state": "running"}]}), encoding="utf-8")
        self.task(self.root, [("B-1", "PASS")])
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--container", "manual").returncode)
        result = self.cli("stop", "--state", str(self.state), "--wp", "B-1", "--remove")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual("exited", self.container("manual")["state"])
        self.assertEqual([], self.calls("rm"))

    def git(self, cwd, *argv):
        result = subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *argv],
                                capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def test_a_worktree_is_removed_only_when_clean_integrated_and_passed(self):
        # 工作樹每個約 126MB，但裡面可能有還沒提交或還沒整合的成果：這些情況一律保留。分支永遠不刪。
        repo, tree = Path(self.root) / "repo", Path(self.root) / "wt-B-1"
        repo.mkdir()
        self.git(repo, "init", "-q", "-b", "main")
        (repo / "a.txt").write_text("a\n", encoding="utf-8")
        self.git(repo, "add", "."), self.git(repo, "commit", "-q", "-m", "base")
        self.git(repo, "worktree", "add", "-q", "-b", "wp/B-1", str(tree))
        (tree / "b.txt").write_text("b\n", encoding="utf-8")
        self.git(tree, "add", "."), self.git(tree, "commit", "-q", "-m", "work")
        self.assertEqual(0, self.cli("register", "--state", str(self.state), "--wp", "B-1", "--worktree", str(tree)).returncode)
        rid = self.ledger()[-1]["id"]
        self.assertEqual("wp/B-1", self.entry(rid)["branch"])

        def attempt(*extra):
            result = self.cli("stop", "--state", str(self.state), "--id", rid, "--remove", *extra)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            return result.stdout

        self.assertIn("不是 PASS", attempt("--integrated-into", "main"))
        self.task(self.root, [("B-1", "PASS")])
        self.assertIn("--integrated-into", attempt())
        self.assertIn("尚未整合", attempt("--integrated-into", "main"))
        self.git(repo, "merge", "-q", "--ff-only", "wp/B-1")
        (tree / "draft.txt").write_text("還沒提交\n", encoding="utf-8")
        self.assertIn("未提交", attempt("--integrated-into", "main"))
        (tree / "draft.txt").unlink()
        evidence = self.state.parent / "evidence"
        evidence.mkdir()
        (evidence / "截圖位置.txt").write_text(f"{tree}/test-results/shot.png\n", encoding="utf-8")
        self.assertIn("仍被 1 個檔案引用", attempt("--integrated-into", "main"))
        self.assertTrue(tree.is_dir(), "以上任何一種情況都不得移除")
        (evidence / "截圖位置.txt").unlink()
        self.assertIn("已移除並讀回", attempt("--integrated-into", "main"))
        self.assertFalse(tree.exists())
        self.assertIn("wp/B-1", self.git(repo, "branch", "--list", "wp/B-1"), "分支是版本控制歷史，不刪")
        saved = (evidence / f"worktree-{rid}-移除前.txt").read_text(encoding="utf-8")
        self.assertIn(self.git(repo, "rev-parse", "wp/B-1"), saved)
        row = [line for line in (self.state.parent / "deletions.md").read_text(encoding="utf-8").splitlines() if str(tree) in line]
        self.assertEqual(1, len(row))
        self.assertIn("讀回已不存在", row[0])


def proc_snapshot(containers):
    running = [c for c in containers if c["state"] == "running"]
    return {"procs": {}, "uid": os.getuid(), "launchd": set(), "containers": running, "all_containers": containers}


def listed(name, state="running", task="", project="", created=None):
    return {"id": f"id-{name}", "name": name, "created": created or dt.datetime.now().replace(microsecond=0),
            "project": project, "working_dir": "", "task": task, "state": state, "wp": "", "close": "", "ledger": ""}


class GuardVisibilityTests(Project):
    def test_stopped_and_unlabelled_containers_are_listed_without_blocking_dispatch(self):
        # 守門原本看不到 316 個已停止容器與 4 個沒標籤的容器。看得到之後也只能列出：無法確定是誰的容器
        # 若算成「需處理」，別的任務留下的東西就會擋住本任務派工。
        time.sleep(1.1)
        os.utime(self.state, None)
        snap = proc_snapshot([listed("old-db", state="exited", task="t"), listed("stray"),
                              listed("before-task", created=dt.datetime.now() - dt.timedelta(days=3)),
                              listed("compose-api", project="shop")])
        shown, problems = resource_ledger.audit(self.state, snapshot=snap)
        self.assertEqual([], problems)
        text = "\n".join(shown)
        self.assertIn("本任務已停止、尚未移除的容器 1 個（old-db）", text)
        self.assertIn("沒有任務標籤也不在任何帳本的執行中容器 1 個（stray）", text)
        self.assertNotIn("before-task", text, "任務開始前就在跑的容器不歸這個任務")
        self.assertNotIn("compose-api", text)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, sidecar_guard.main([str(self.state)], snapshot=snap))

    def test_another_projects_ledger_is_found_through_the_local_index(self):
        # 跨專案的任務原本互相看不到帳本：別的專案登記過的容器會被本任務當成沒人管。索引只放本機、只用來找帳本。
        other_root = tempfile.TemporaryDirectory()
        self.addCleanup(other_root.cleanup)
        other = self.task(os.path.realpath(other_root.name), [("B-1", "在途")])
        self.run_container("db")
        time.sleep(1.1)
        os.utime(other, None)
        unindexed = dict(self.env, LONG_TASK_HOME=str(Path(self.root) / "empty-home"))
        result = self.cli("check", "--state", str(other), env=unindexed)
        self.assertEqual(4, result.returncode, result.stdout + result.stderr)
        self.assertIn("未登記 容器 db", result.stdout, "兩個專案的任務目錄同名時，標籤分不出是誰的")
        result = self.cli("check", "--state", str(other))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        index = json.loads((Path(self.home) / "ledgers.json").read_text(encoding="utf-8"))["ledgers"]
        self.assertEqual([os.path.realpath(self.state.parent / "resources.json")], list(index))


class HeavySlotTests(unittest.TestCase):
    """test-run.py 的重型工作名額：同時跑的數量有上限，排隊在同一道指令裡、不吃測試時限；沒設定的機器不排隊。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self.home = Path(self.root) / "home"
        self.home.mkdir()
        self.env = dict(os.environ, LONG_TASK_HOME=str(self.home), LONG_TASK_SLOT_POLL_SECONDS="0.2")
        self.running = []

    def tearDown(self):
        for process in self.running:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            process.wait()
        self.tmp.cleanup()

    def config(self, **values):
        (self.home / "capacity.json").write_text(json.dumps(values), encoding="utf-8")

    def argv(self, name, *options, command=("true",)):
        return [sys.executable, TEST_RUN, "--log", str(Path(self.root) / f"{name}.log"), *options, "--", *command]

    def run_now(self, name, *options, command=("true",)):
        result = subprocess.run(self.argv(name, *options, command=command), capture_output=True, text=True,
                                env=self.env, timeout=60)
        summary = json.loads((Path(self.root) / f"{name}.log.summary.json").read_text(encoding="utf-8"))
        return result, summary

    def hold(self, name, *options, seconds=3):
        process = subprocess.Popen(self.argv(name, *options, command=("sleep", str(seconds))), env=self.env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.running.append(process)
        slots = self.home / "heavy-slots"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (slots / f"{process.pid}.json").is_file():
            time.sleep(0.05)
        self.assertTrue((slots / f"{process.pid}.json").is_file(), "佔位的那一輪沒有領到名額")
        return process

    def test_a_machine_without_the_file_never_queues(self):
        result, summary = self.run_now("plain")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual((0.0, False), (summary["queuedSeconds"], summary["queueExpired"]))
        self.assertFalse((self.home / "heavy-slots").exists())

    def test_a_full_machine_queues_inside_the_command_and_the_wait_is_not_test_time(self):
        # 6 個 1.3–2.0GB 的 node 同時跑是 11/14 當機的直接原因。排隊若算進逾時，排到的那一輪會被當成測試逾時而誤紅。
        self.config(heavySlots=1)
        self.hold("holder", seconds=3)
        began = time.monotonic()
        result, summary = self.run_now("queued", "--timeout", "0.03", command=("sleep", "1"))
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertGreaterEqual(summary["queuedSeconds"], 1.5, "名額被佔時必須等到它釋出")
        self.assertFalse(summary["timedOut"], "逾時 1.8 秒只算測試本身的 1 秒，不算排隊")
        self.assertGreaterEqual(time.monotonic() - began, 2.5)
        self.assertIn("排隊", result.stdout)
        self.assertEqual([], [n for n in os.listdir(self.home / "heavy-slots") if n.endswith(".json")], "跑完要歸還名額")
        sample = (self.home / "samples").glob("heavy-*.jsonl")
        rows = [json.loads(line) for path in sample for line in path.read_text(encoding="utf-8").splitlines()]
        mine = [row for row in rows if row["log"].endswith("queued.log")]
        self.assertEqual(1, len(mine))
        self.assertEqual(summary["queuedSeconds"], mine[0]["queuedSeconds"])
        self.assertGreater(mine[0]["peakChildMb"], 0)

    def test_long_runs_always_leave_a_slot_for_a_short_one(self):
        # 長工作佔滿名額時，一道幾秒的定向測試會排在 40 分鐘的整套測試後面。
        self.config(heavySlots=2, heavyLongMax=1)
        self.hold("suite", "--slot", "long", seconds=3)
        _, short = self.run_now("unit")
        self.assertLess(short["queuedSeconds"], 1)
        _, second_long = self.run_now("build", "--slot", "long")
        self.assertGreaterEqual(second_long["queuedSeconds"], 1.5)

    def test_a_slot_whose_holder_is_gone_or_overdue_is_taken_back(self):
        # 持有名額的程序被終止時不會歸還；不收回的話，之後每一輪都排到上限。
        self.config(heavySlots=1)
        slots = self.home / "heavy-slots"
        slots.mkdir()
        dead = subprocess.Popen(["true"])
        dead.wait()
        (slots / f"{dead.pid}.json").write_text(json.dumps({"pid": dead.pid, "kind": "long", "until": time.time() + 3600}))
        (slots / "overdue.json").write_text(json.dumps({"pid": os.getpid(), "kind": "long", "until": time.time() - 1}))
        _, summary = self.run_now("after-crash")
        self.assertLess(summary["queuedSeconds"], 1)
        self.assertEqual([], [n for n in os.listdir(slots) if n.endswith(".json")])

    def test_a_stuck_queue_starts_the_run_anyway_and_says_so(self):
        # 名額是保護，不是停工理由：排到上限仍沒有名額就照跑並註明，工作不能因為排隊機制卡住而做不完。
        self.config(heavySlots=1, heavyWaitMinutes=0.02)
        slots = self.home / "heavy-slots"
        slots.mkdir()
        (slots / "busy.json").write_text(json.dumps({"pid": os.getpid(), "kind": "short", "until": time.time() + 3600}))
        result, summary = self.run_now("impatient")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertTrue(summary["queueExpired"])
        self.assertIn("已直接開跑", result.stdout)
        self.assertTrue((slots / "busy.json").is_file(), "別人的名額不得被搶走")

    def test_slot_none_skips_the_queue(self):
        self.config(heavySlots=1)
        slots = self.home / "heavy-slots"
        slots.mkdir()
        (slots / "busy.json").write_text(json.dumps({"pid": os.getpid(), "kind": "short", "until": time.time() + 3600}))
        _, summary = self.run_now("light", "--slot", "none")
        self.assertEqual((0.0, False), (summary["queuedSeconds"], summary["queueExpired"]))


if __name__ == "__main__":
    unittest.main()


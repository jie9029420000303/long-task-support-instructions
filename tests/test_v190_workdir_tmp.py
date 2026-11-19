"""v1.9.0 工作包資料夾與測試暫存的回收（Jay 2026-11-19 選 Q20-A、Q22-A）。

當天清查：工區 E 的實跑區一天多 19GiB，1,297 個已交件工作包、78.5GiB 都留著，39,727 個 PDF 只有約 67 種內容；系統暫存區在
重開機後 12 小時又累積 12,291 項、2.24GiB。技能原本只收容器、git 工作樹、程序與子代理，工作包資料夾和測試暫存沒有任何規則。
這裡每個測試守一件事：過程檔只在工作包 PASS 後才刪，交件成果、被證據引用的檔案與資料夾以外的東西絕不會被刪；
任務暫存判定後整個刪，但還有程序在用、或不是 tmpdir 建立的位置就不刪；宣稱完成前沒清的會被守門擋下。
"""
import datetime as dt
import hashlib
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
spec = importlib.util.spec_from_file_location("v190_resource_ledger", LEDGER)
resource_ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resource_ledger)
EMPTY = {"procs": {}, "uid": os.getuid(), "launchd": set(), "containers": [], "all_containers": []}


class Task(unittest.TestCase):
    """暫存專案 <root>/.codex/long-task/t/state.md；帳本索引與任務暫存都指到暫存目錄，不碰這台機器真正的 /tmp 與索引。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self.base = os.path.join(self.root, "tmp-base")
        os.mkdir(self.base)
        self.saved = {key: os.environ.get(key) for key in ("LONG_TASK_HOME", "LONG_TASK_TMP_BASE")}
        os.environ["LONG_TASK_HOME"] = os.path.join(self.root, "home")
        os.environ["LONG_TASK_TMP_BASE"] = self.base
        self.state = self.write_state([("B-1", "在途"), ("B-2", "在途")])
        self.ledger = self.state.parent / "resources.json"

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def write_state(self, packages):
        directory = Path(self.root) / ".codex" / "long-task" / "t"
        directory.mkdir(parents=True, exist_ok=True)
        created = (dt.datetime.now() - dt.timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M")
        rows = "".join(f"| {i} | B | {state} | path:{self.root}/run/{i} |\n" for i, state in packages)
        path = directory / "state.md"
        path.write_text(f"# 長任務狀態：t\n\n- 建立：{created}\n\n## 工作包\n"
                        "| id | 類型 | 狀態（待派／在途／PASS／FAIL） | 工作區（path／worktree／base） |\n|---|---|---|---|\n"
                        f"{rows}\n## 最終判定\n未完成\n", encoding="utf-8")
        return path

    def cli(self, *args):
        return subprocess.run([sys.executable, LEDGER, *args], capture_output=True, text=True, cwd=self.root, timeout=180)

    def resources(self):
        return json.loads(self.ledger.read_text(encoding="utf-8"))["resources"]

    def deletions(self):
        path = self.state.parent / "deletions.md"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def package(self, wp="B-1"):
        """一個非 git 的工作包資料夾：交件標記、結果、腳本，加上可重建的過程檔。"""
        folder = Path(self.root) / "run" / wp
        for name, text in {"DONE": "ok", "result.json": "{}", "report.md": "回報", "scripts/run.sh": "#!/bin/sh\n",
                           "inputs/sample-1.pdf": "pdf" * 1000, "inputs/sample-2.pdf": "pdf" * 1000,
                           "rehearsal/work/step.log": "x" * 5000, "out-v1/full.json": "old", "out-v2/full.json": "new",
                           "out-v2/result-summary.json": "{}", "dist/app.js": "built", "cited/screenshot.png": "png"}.items():
            (folder / name).parent.mkdir(parents=True, exist_ok=True)
            (folder / name).write_text(text, encoding="utf-8")
        return folder


class TaskTmpTests(Task):
    def tmpdir(self, wp="B-1"):
        result = self.cli("tmpdir", "--state", str(self.state), "--wp", wp)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def test_tmpdir_is_one_short_private_folder_per_package_under_the_task(self):
        first = self.tmpdir()
        self.assertEqual(first, self.tmpdir(), "同一包再要一次是同一個資料夾，不會越要越多")
        other = self.tmpdir("B-2")
        self.assertNotEqual(first, other)
        self.assertEqual(os.path.dirname(first), os.path.dirname(other), "同一任務的暫存在同一個上層底下")
        self.assertRegex(os.path.relpath(first, self.base), r"^lt-[0-9a-f]{8}/B-1$")
        self.assertEqual(0o700, os.stat(first).st_mode & 0o777)
        # 預設放 /tmp：加上 30 字元的 socket 檔名仍遠低於 unix socket 路徑上限 104 字元。
        self.assertLess(len(os.path.join("/tmp", os.path.relpath(first, self.base), "x" * 30)), 104)
        odd = self.tmpdir("主線")
        self.assertRegex(os.path.basename(odd), r"^[0-9a-f]{4}$", "中文工作包名換成短代碼，路徑仍只有英數")
        self.assertEqual(["tmp", "tmp", "tmp"], [r["kind"] for r in self.resources()])

    def test_stop_deletes_the_whole_folder_of_that_package_only_and_records_it(self):
        mine, other = self.tmpdir(), self.tmpdir("B-2")
        Path(mine, "playwright_chromiumdev_profile-x").mkdir()
        Path(mine, "playwright_chromiumdev_profile-x", "Cookies").write_text("c" * 4096)
        stranger = Path(self.base, "someone-elses-temp")
        stranger.mkdir()
        result = self.cli("stop", "--state", str(self.state), "--wp", "B-1")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertFalse(os.path.exists(mine), "判定後整個刪掉")
        self.assertTrue(os.path.isdir(other), "別的工作包的暫存不動")
        self.assertTrue(stranger.is_dir(), "不是本任務建立的暫存不動")
        self.assertIn(mine, self.deletions())
        self.assertIn("讀回已不存在", self.deletions())
        record = next(r for r in self.resources() if r["wp"] == "B-1")
        self.assertTrue(record["stopped_at"] and record["removed_at"])

    def test_a_folder_a_process_still_uses_is_left_alone(self):
        mine = self.tmpdir()
        holder = subprocess.Popen(["/bin/sleep", "60"], cwd=mine)
        try:
            time.sleep(0.3)
            result = self.cli("stop", "--state", str(self.state), "--wp", "B-1")
            self.assertEqual(4, result.returncode, result.stdout)
            self.assertIn("還有程序在用", result.stdout)
            self.assertTrue(os.path.isdir(mine))
            self.assertEqual("", self.deletions(), "沒刪就不記")
        finally:
            holder.kill()
            holder.wait()
        self.assertEqual(0, self.cli("stop", "--state", str(self.state), "--wp", "B-1").returncode)
        self.assertFalse(os.path.exists(mine))

    def test_a_record_pointing_outside_the_task_temp_is_never_deleted(self):
        # 帳本被手改或寫錯時，stop 不能把別的資料夾當暫存整個刪掉。
        self.tmpdir()
        victim = Path(self.root) / "run" / "B-1"
        victim.mkdir(parents=True)
        (victim / "result.json").write_text("{}")
        data = json.loads(self.ledger.read_text(encoding="utf-8"))
        for wrong in (str(victim), self.base, os.path.join(self.base, "not-lt", "B-1")):
            os.makedirs(wrong, exist_ok=True)
            data["resources"][0]["path"] = wrong
            self.ledger.write_text(json.dumps(data), encoding="utf-8")
            result = self.cli("stop", "--state", str(self.state), "--wp", "B-1")
            self.assertEqual(4, result.returncode, wrong)
            self.assertTrue(os.path.isdir(wrong), wrong)
        self.assertTrue((victim / "result.json").is_file())

    def test_the_guard_reports_temp_left_after_a_package_is_judged(self):
        mine = self.tmpdir()
        shown, problems = resource_ledger.audit(self.state, snapshot=EMPTY)
        self.assertEqual([], problems, "工作包還在做，暫存在用是正常的")
        self.assertTrue(any("使用中" in line for line in shown))
        for verdict in ("PASS", "FAIL", "主線接手"):
            self.write_state([("B-1", verdict), ("B-2", "在途")])
            _, problems = resource_ledger.audit(self.state, snapshot=EMPTY)
            self.assertEqual(1, len(problems), verdict)
            self.assertIn("任務暫存還在", problems[0])
        self.write_state([("B-1", "在途"), ("B-2", "在途")])
        _, problems = resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)
        self.assertEqual(1, len(problems), "宣稱完成時暫存一律要清掉")
        self.assertEqual(0, self.cli("stop", "--state", str(self.state), "--wp", "B-1").returncode)
        self.assertEqual([], resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)[1])
        self.assertFalse(os.path.exists(mine))


class WorkdirPruneTests(Task):
    def register(self, folder, wp="B-1"):
        result = self.cli("register", "--state", str(self.state), "--wp", wp, "--workdir", str(folder),
                          "--keep", "DONE", "--keep", "result*.json", "--keep", "report.md", "--keep", "scripts/*")
        self.assertEqual(0, result.returncode, result.stderr)

    def prune(self, *paths, wp="B-1"):
        return self.cli("prune", "--state", str(self.state), "--wp", wp, "--", *paths)

    def tree(self, folder):
        return sorted(str(p.relative_to(folder)) for p in Path(folder).rglob("*") if p.is_file())

    def test_nothing_is_deleted_until_the_package_passes(self):
        folder = self.package()
        self.register(folder)
        before = self.tree(folder)
        for verdict in ("在途", "FAIL", "主線接手"):
            self.write_state([("B-1", verdict), ("B-2", "在途")])
            result = self.prune("inputs", "rehearsal", "out-v1", "dist")
            self.assertEqual(4, result.returncode, verdict)
            self.assertEqual(before, self.tree(folder), verdict + "：被退件或主線接手的過程檔留作診斷")
        self.assertEqual("", self.deletions())

    def test_after_pass_process_files_are_really_deleted_and_deliverables_stay(self):
        folder = self.package()
        self.register(folder)
        evidence = self.state.parent / "evidence"
        evidence.mkdir()
        (evidence / "B-1.md").write_text(f"截圖見 {folder}/cited/screenshot.png\n", encoding="utf-8")
        outside = Path(self.root) / "run" / "B-2"
        outside.mkdir(parents=True)
        (outside / "keep.txt").write_text("another package")
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])
        result = self.prune("inputs", "rehearsal", "out-v1", "dist/app.js",          # 可重建的過程檔
                            "DONE", "scripts", "out-v2", "cited",                     # 交件標記、腳本、含結果的輸出、證據引用
                            ".", "../B-2", str(outside / "keep.txt"), str(folder), "no-such-file")  # 範圍以外
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(["DONE", "cited/screenshot.png", "out-v2/full.json", "out-v2/result-summary.json", "report.md",
                          "result.json", "scripts/run.sh"], self.tree(folder))
        self.assertTrue((outside / "keep.txt").is_file(), "登記資料夾以外的東西不會被刪")
        self.assertFalse((Path.home() / ".Trash" / "inputs").exists() and
                         (Path.home() / ".Trash" / "inputs" / "sample-1.pdf").read_text() == "pdf" * 1000, "不是丟垃圾桶")
        log = self.deletions()
        for item in ("inputs", "rehearsal", "out-v1", "dist/app.js"):
            self.assertIn(f"過程檔 {folder}/{item}（", log)
        self.assertEqual(4, log.count("讀回已不存在"))
        self.assertNotIn("待讀回", log)
        for kept, why in (("DONE", "保留樣式"), ("scripts", "保留樣式"), ("out-v2", "保留樣式"), ("cited", "引用")):
            line = next(line for line in result.stdout.splitlines() if line.startswith(f"・ {kept}："))
            self.assertIn(why, line)
        record = self.resources()[0]
        self.assertTrue(record["pruned_at"])
        self.assertEqual(3000 * 2 + 5000 + 3 + 5, record["pruned_bytes"])

    def test_a_symlink_inside_the_folder_cannot_reach_outside_it(self):
        folder = self.package()
        self.register(folder)
        shared = Path(self.root) / "shared-inputs"
        shared.mkdir()
        (shared / "sample.pdf").write_text("the only copy")
        os.symlink(shared, folder / "linked-inputs")
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])
        self.assertEqual(0, self.prune("linked-inputs", "linked-inputs/sample.pdf").returncode)
        self.assertFalse(os.path.lexists(folder / "linked-inputs"), "連結本身刪掉")
        self.assertEqual("the only copy", (shared / "sample.pdf").read_text(), "連結指到的共用輸入一個檔都不少")

    def test_closing_is_held_until_a_passed_folder_is_pruned_or_declared_clean(self):
        folder = self.package()
        self.register(folder)
        self.assertEqual([], resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)[1], "沒 PASS 的留作診斷，不擋")
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])
        shown, problems = resource_ledger.audit(self.state, snapshot=EMPTY)
        self.assertEqual([], problems, "任務進行中只提示")
        self.assertTrue(any("prune --wp B-1" in line for line in shown))
        _, problems = resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)
        self.assertEqual(1, len(problems))
        self.assertIn("過程檔還沒清", problems[0])
        self.assertEqual(2, self.cli("prune", "--state", str(self.state), "--wp", "B-1", "--none").returncode, "要寫原因")
        result = self.cli("prune", "--state", str(self.state), "--wp", "B-1", "--none", "--reason", "只有交件成果")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual([], resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)[1])
        self.assertEqual(12, len(self.tree(folder)), "--none 不刪任何檔案")

    def test_an_unregistered_folder_is_listed_but_does_not_block_a_running_task(self):
        # 現役任務已有上千個沒登記的工作包資料夾；新版裝上去只提示，不能讓它們的守門突然全部回 4。
        self.package("B-1")
        self.package("B-2")
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])  # 主線先更新紀錄再跑守門；紀錄之後才出現的不歸這次
        shown, problems = resource_ledger.audit(self.state, claimed=True, snapshot=EMPTY)
        self.assertEqual([], problems)
        self.assertTrue(any("沒登記的非 git 工作資料夾 2 個" in line for line in shown), shown)
        self.register(Path(self.root) / "run" / "B-1")
        self.assertTrue(any("沒登記的非 git 工作資料夾 1 個" in line
                            for line in resource_ledger.audit(self.state, snapshot=EMPTY)[0]))

    def test_prune_needs_a_registered_folder_and_a_git_worktree_is_not_one(self):
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])
        self.assertEqual(2, self.prune("inputs").returncode, "沒登記就不知道哪裡是這包的範圍")
        tree = Path(self.root) / "tree"
        (tree / ".git").mkdir(parents=True)
        result = self.cli("register", "--state", str(self.state), "--wp", "B-1", "--workdir", str(tree))
        self.assertEqual(2, result.returncode)
        self.assertIn("--worktree", result.stderr)

    def test_stop_never_removes_a_work_folder(self):
        folder = self.package()
        self.register(folder)
        self.write_state([("B-1", "PASS"), ("B-2", "在途")])
        before = self.tree(folder)
        for extra in ([], ["--remove"]):
            self.cli("stop", "--state", str(self.state), "--wp", "B-1", *extra)
            self.cli("stop", "--state", str(self.state), "--all", *extra)
        self.assertEqual(before, self.tree(folder), "交件成果在裡面；只有 prune 點名的過程檔會刪")


class ShippedTests(unittest.TestCase):
    def test_both_platforms_ship_the_same_ledger(self):
        other = REPOSITORY / "claude-code" / ".claude" / "skills" / "long-task-orchestrator" / "scripts" / "resource-ledger.py"
        if not other.is_file():
            self.skipTest("只在 repo 內比對兩個平台")
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.assertEqual(digest(LEDGER), digest(other))


if __name__ == "__main__":
    unittest.main()


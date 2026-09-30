import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
ROOT = REPOSITORY / "goal-orchestrator" / "scripts"
if not ROOT.is_dir():
    ROOT = REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "scripts"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope_overlap = load("scope_overlap", "scope-overlap.py")
sidecar_guard = load("sidecar_guard", "sidecar-guard.py")
resource_ledger = load("resource_ledger", "resource-ledger.py")


class ScopeOverlapTests(unittest.TestCase):
    def write_prompt(
        self,
        directory,
        name,
        scope,
        shared,
        workspace_path=None,
        worktree=None,
        base="0123456789abcdef0123456789abcdef01234567",
    ):
        path = Path(directory) / name
        workspace_path = workspace_path or f"/tmp/{Path(name).stem}"
        worktree = worktree or Path(name).stem
        path.write_text(
            "[工作區]\n"
            f"path:{workspace_path}\n"
            f"worktree:{worktree}\n"
            f"base:{base}\n\n"
            "[可修改範圍]\n"
            + scope
            + "\n\n[共用資源]\n"
            + shared
            + "\n",
            encoding="utf-8",
        )
        return path

    def test_disjoint_worktrees_paths_and_negative_values_do_not_collide(self):
        with tempfile.TemporaryDirectory() as directory:
            left = self.write_prompt(
                directory,
                "left.md",
                "repo.worktrees/wp-a/src/a.py",
                "套件:不安裝\n瀏覽器:不使用",
                workspace_path="/tmp/repo.worktrees/wp-a",
                worktree="wp-a",
            )
            right = self.write_prompt(
                directory,
                "right.md",
                "repo.worktrees/wp-b/src/b.py",
                "套件:不安裝\n瀏覽器:不使用",
                workspace_path="/tmp/repo.worktrees/wp-b",
                worktree="wp-b",
            )
            left_scope, missing = scope_overlap.scope_of(left)
            self.assertIsNone(missing)
            self.assertIn("repo.worktrees/wp-a/src/a.py", left_scope)
            self.assertNotIn("repo.worktree", left_scope)
            self.assertEqual(0, scope_overlap.main([str(left), str(right)]))

    def test_same_positive_resource_collides(self):
        with tempfile.TemporaryDirectory() as directory:
            left = self.write_prompt(
                directory, "left.md", "src/a.py", "資料庫:canonical"
            )
            right = self.write_prompt(
                directory, "right.md", "src/b.py", "資料庫:canonical"
            )
            self.assertEqual(1, scope_overlap.main([str(left), str(right)]))

    def test_recursive_scope_covers_child_file(self):
        with tempfile.TemporaryDirectory() as directory:
            left = self.write_prompt(directory, "left.md", "src/**", "無")
            right = self.write_prompt(directory, "right.md", "src/pkg/a.py", "無")
            self.assertEqual(1, scope_overlap.main([str(left), str(right)]))

    def test_same_worktree_collides_even_when_scopes_are_disjoint(self):
        with tempfile.TemporaryDirectory() as directory:
            left = self.write_prompt(
                directory,
                "left.md",
                "src/a.py",
                "無",
                workspace_path="/tmp/shared",
                worktree="shared",
            )
            right = self.write_prompt(
                directory,
                "right.md",
                "src/b.py",
                "無",
                workspace_path="/tmp/other",
                worktree="shared",
            )
            self.assertEqual(1, scope_overlap.main([str(left), str(right)]))

    def test_missing_workspace_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.md"
            path.write_text(
                "[可修改範圍]\nsrc/a.py\n\n[共用資源]\n無\n",
                encoding="utf-8",
            )
            self.assertEqual(2, scope_overlap.main([str(path)]))

    def test_relative_workspace_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_prompt(
                directory,
                "relative.md",
                "src/a.py",
                "無",
                workspace_path="repo.worktrees/wp-a",
            )
            self.assertEqual(2, scope_overlap.main([str(path)]))


class SidecarGuardTests(unittest.TestCase):
    def write_state(self, directory, lines):
        path = Path(directory) / "state.md"
        path.write_text("\n".join("line" for _ in range(lines)) + "\n", encoding="utf-8")
        return path

    def test_soft_and_hard_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(0, sidecar_guard.main([str(self.write_state(directory, 150))]))
            self.assertEqual(0, sidecar_guard.main([str(self.write_state(directory, 180))]))
            self.assertEqual(1, sidecar_guard.main([str(self.write_state(directory, 181))]))


class CodexDispatchContractTests(unittest.TestCase):
    # ROOT already resolves both the canonical repository layout and the standalone
    # installed/copy layout used by Codex workspaces.
    SKILL = ROOT.parent

    def test_new_goal_updates_main_model_without_replacing_accepted_workers(self):
        # Terra research and coding packages passed prior acceptance; without a matched
        # speed/cost comparison, a new main model must not force worker migration.
        skill = (self.SKILL / "SKILL.md").read_text(encoding="utf-8")
        template = (self.SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        self.assertIn("主線：GPT-6 Sol；High", skill)
        self.assertIn("B 技術實作、C 研究子代理：GPT-5.6 Terra；Medium", skill)
        self.assertIn("介面子代理：具備所需瀏覽器", skill)
        self.assertIn("Goal 續跑／恢復沿用已鎖定模型", skill)
        for row in (
            "| 主線 | GPT-6 Sol | High |",
            "| B 技術實作 | GPT-5.6 Terra | Medium |",
            "| C 研究 | GPT-5.6 Terra | Medium |",
            "| 介面操作 | | Low |",
        ):
            self.assertIn(row, template)

    def test_pending_decision_does_not_pause_other_authorized_work(self):
        # A single unresolved decision must not idle agents or stop integration work that is
        # already authorized; the state file needs a durable place to carry that decision.
        skill = (self.SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("待決事項（不阻塞主線）", skill)
        self.assertIn("其餘已授權工作照常", skill)
        template = (self.SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        self.assertIn("## 待決清單", template)
        self.assertEqual(0, sidecar_guard.main([str(self.SKILL / "templates" / "state.md")]))

    def test_release_approval_is_scoped_and_persists_across_resume(self):
        # A tested candidate with approval for the same actions and targets must not
        # ask again; an added action or changed target still needs authorization.
        skill = (self.SKILL / "SKILL.md").read_text(encoding="utf-8")
        template = (self.SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        for marker in ("發布授權核對", "使用者原話與時間", "候選提交", "直接執行、不重問", "範圍或目標改變", "不在續接回合重提"):
            self.assertIn(marker, skill)
        for marker in ("## 發布授權", "來源→目標分支／環境", "允許的候選變更範圍與放行條件", "實際候選提交與核對結果"):
            self.assertIn(marker, template)

    def test_dispatcher_fills_slots_and_refills_without_waiting_for_batch(self):
        # Merely permitting parallelism is insufficient: the dispatcher must keep available
        # slots occupied and refill them as dependencies unlock, or long tasks stay serialized.
        skill = (self.SKILL / "SKILL.md").read_text(encoding="utf-8")
        execution = (self.SKILL / "references" / "execution.md").read_text(encoding="utf-8")
        for marker in ("可派即派", "不留空席", "當輪立即補派"):
            self.assertIn(marker, skill)
        self.assertIn("完成通知一到", execution)
        self.assertIn("不等原批全部完成", execution)


def acceptance_sidecar(rows, verdict):
    """rows＝[(條文, 狀態, 核准依據)]；產生含驗收逐條表與最終判定的 sidecar。"""
    text = ("## 驗收標準（逐條）\n| # | 條文（原文） | 狀態（PASS／未達／部分／待決／核准不做） | 證據 | 核准依據 |\n"
            "|---|---|---|---|---|\n")
    text += "".join(f"| {i} | {t} | {st} | evidence | {ok} |\n" for i, (t, st, ok) in enumerate(rows, 1))
    return text + f"\n## 最終判定\n{verdict}\n"


class CodexAcceptanceGateTests(unittest.TestCase):
    # 已查證的長任務事故：主線看得到條文、甚至自記「未達」仍宣稱完成或寫「PASS（附條件）」。
    # 守門工具要把這種宣稱擋回主線（exit 3，不等使用者），同時絕不能誤擋誠實的「未完成」進度回報。
    SKILL = ROOT.parent

    def run_guard(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.md"
            path.write_text(text, encoding="utf-8")
            return sidecar_guard.main([str(path)])

    def test_completion_claim_must_match_every_criterion(self):
        self.assertEqual(0, self.run_guard(acceptance_sidecar([("A", "PASS", ""), ("B", "PASS", "")], "PASS")))
        self.assertEqual(3, self.run_guard(acceptance_sidecar([("A", "PASS", ""), ("B", "部分", "")], "PASS")))
        self.assertEqual(3, self.run_guard(acceptance_sidecar([("A", "PASS", "")], "PASS（附條件）")))
        self.assertEqual(3, self.run_guard(acceptance_sidecar([("A", "核准不做", "")], "完成")))
        self.assertEqual(0, self.run_guard(acceptance_sidecar([("A", "核准不做", "使用者 09-27「不修」")], "完成")))

    def test_honest_progress_report_is_never_blocked(self):
        self.assertEqual(0, self.run_guard(acceptance_sidecar([("A", "PASS", ""), ("B", "未達", "")], "未完成（剩 #2）")))
        self.assertEqual(0, self.run_guard(acceptance_sidecar([("A", "PASS", ""), ("B", "未達", "")], "FAIL（#2 未達；其餘已完成）")))

    def test_template_keeps_gateable_table_and_skill_states_the_rules(self):
        template = (self.SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        self.assertIn("| # | 條文", template)
        self.assertIn("前置", template)
        self.assertEqual(0, sidecar_guard.main([str(self.SKILL / "templates" / "state.md")]))
        skill = (self.SKILL / "SKILL.md").read_text(encoding="utf-8")
        for marker in ("**放行紀律**", "附條件 PASS", "**提問紀律**", "前置", "監看"):
            self.assertIn(marker, skill)


class CodexResourceGateTests(unittest.TestCase):
    # 2026-09-30：Codex 長任務留下 50 個容器（佔 Docker 95% CPU）。sidecar 旁的資源帳本讓守門在
    # 工作包判定後或宣稱完成時發現還在跑的服務，回 4 交主線收尾；誠實進行中的服務不得誤擋。
    STARTED = dt.datetime(2026, 9, 30, 12, 5)

    def sidecar(self, root, state, verdict, resources):
        directory = Path(root) / ".codex" / "long-task" / "g1"
        directory.mkdir(parents=True)
        (directory / "state.md").write_text(
            "# Codex 長任務 sidecar：g1\n\n- 建立：2026-09-30 12:00\n\n## 工作包\n"
            "| id | 類型 | 負責者 | 依賴 | 候選版 | 工作區／base commit | 狀態（待派／在途／PASS／FAIL／BLOCKED） |\n"
            "|---|---|---|---|---|---|---|\n"
            f"| B21 | B | 技術 | — | abc | path:{root}/wt-b21 | {state} |\n\n## 最終判定\n{verdict}\n", encoding="utf-8")
        (directory / "resources.json").write_text(json.dumps({"resources": resources}), encoding="utf-8")
        return directory / "state.md"

    def live(self, *pids):
        procs = {pid: {"pid": pid, "ppid": 1, "pgid": pid, "uid": os.getuid(), "start": self.STARTED,
                       "command": "npm run dev", "cwd": "/"} for pid in pids}
        return {"procs": procs, "uid": os.getuid(), "launchd": set(), "containers": []}

    def resource(self, close="wp"):
        return [{"id": "r1", "wp": "B21" if close == "wp" else "主線", "kind": "process", "pgid": 301,
                 "start": self.STARTED.isoformat(), "command": "npm run dev", "close": close, "reason": ""}]

    def test_judged_package_or_completion_with_running_service_returns_4(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            path = self.sidecar(root, "PASS", "未完成", self.resource())
            self.assertEqual(4, sidecar_guard.main([str(path)], snapshot=self.live(301)))
            self.assertEqual(0, sidecar_guard.main([str(path)], snapshot=self.live()))
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            path = self.sidecar(root, "在途", "PASS", self.resource("final"))
            self.assertEqual(4, sidecar_guard.main([str(path)], snapshot=self.live(301)))

    def test_in_flight_service_is_not_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            path = self.sidecar(root, "在途", "未完成", self.resource())
            self.assertEqual(0, sidecar_guard.main([str(path)], snapshot=self.live(301)))
            self.assertTrue(resource_ledger.audit(path, snapshot=self.live(301))[0])


if __name__ == "__main__":
    unittest.main()

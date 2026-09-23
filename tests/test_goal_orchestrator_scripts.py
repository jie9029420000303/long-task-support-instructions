import importlib.util
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


if __name__ == "__main__":
    unittest.main()

"""Claude Code adapter 回歸測試：並行派工閘、狀態檔容量守門、子代理定義與 hook、共用規格一致性。

每個測試都對應一個「為什麼重要」：假衝突會讓可並行的工作被迫排隊，漏判衝突會讓並行包互相踩壞
工作區；缺 [工作區] 時猜測隔離狀態會讓舊工作包悄悄共用 worktree；狀態檔膨脹會讓主線壓縮後讀不起狀態。
"""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


REPOSITORY = Path(__file__).resolve().parents[1]
ADAPTER = REPOSITORY / "claude-code" / ".claude"
SKILL = ADAPTER / "skills" / "long-task-orchestrator"
SCRIPTS = SKILL / "scripts"
AGENTS = ADAPTER / "agents"
BASE = "0123456789abcdef0123456789abcdef01234567"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope_overlap = load("claude_scope_overlap", "scope-overlap.py")
sidecar_guard = load("claude_sidecar_guard", "sidecar-guard.py")


def write_wp(directory, name, scope, shared, workspace=None, path=None, worktree=None, base=BASE):
    """寫一個工作包 prompt 檔；workspace=False 代表舊工作包沒有 [工作區] 段。"""
    stem = Path(name).stem
    if workspace is None:
        workspace = (
            f"- path:{path or f'/tmp/repo.worktrees/{stem}'}\n"
            f"- worktree:{worktree or stem}\n"
            f"- base:{base}\n"
        )
    text = "[工作包] " + stem + "\n"
    if workspace is not False:
        text += "[工作區]\n" + workspace + "\n"
    text += "[可修改範圍]\n" + scope + "\n\n[共用資源]\n" + shared + "\n\n[禁止事項]\n不改 lockfile\n"
    target = Path(directory) / name
    target.write_text(text, encoding="utf-8")
    return str(target)


class ScopeOverlapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def gate(self, *files, in_flight=()):
        argv = list(files) + (["--in-flight", *in_flight] if in_flight else [])
        return scope_overlap.main(argv)

    # 1. .worktrees 不截斷
    def test_dotted_worktrees_directory_is_not_truncated(self):
        left = write_wp(self.dir, "wp-a.md", "repo.worktrees/wp-a/src/a.py", "無")
        right = write_wp(self.dir, "wp-b.md", "repo.worktrees/wp-b/src/b.py", "無")
        items, missing = scope_overlap.scope_of(left)
        self.assertIsNone(missing)
        self.assertIn("repo.worktrees/wp-a/src/a.py", items)
        self.assertFalse(any(i.endswith("repo.worktree") for i in items), items)
        self.assertEqual(0, self.gate(left, right))

    # 2. 否定資源不衝突
    def test_negative_resource_values_do_not_collide(self):
        shared = "套件:不安裝\n瀏覽器:不使用\n服務:不啟動\nDB:不修改\n帳號:無"
        left = write_wp(self.dir, "wp-a.md", "src/a.py", shared)
        right = write_wp(self.dir, "wp-b.md", "src/b.py", shared)
        items, _ = scope_overlap.scope_of(left)
        self.assertFalse([i for i in items if i.startswith("共用:套件") or i.startswith("共用:瀏覽器")], items)
        self.assertEqual(0, self.gate(left, right))

    # 3. 相同正值衝突
    def test_same_positive_resource_collides(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "DB:canonical")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "DB：canonical")
        self.assertEqual(1, self.gate(left, right))

    def test_positive_value_still_collides_when_mixed_with_negative(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "瀏覽器:pane|playwright\n套件:不安裝")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "瀏覽器:pane")
        self.assertEqual(1, self.gate(left, right))

    def test_research_topics_collide_only_when_equal(self):
        a = write_wp(self.dir, "c-1.md", "evidence/C-1/**", "議題:cdc")
        b = write_wp(self.dir, "c-2.md", "evidence/C-2/**", "議題:batch")
        c = write_wp(self.dir, "c-3.md", "evidence/C-3/**", "議題:cdc")
        self.assertEqual(0, self.gate(a, b))
        self.assertEqual(1, self.gate(a, c))

    # 4. recursive scope
    def test_recursive_scope_covers_nested_file_but_single_level_does_not(self):
        deep = write_wp(self.dir, "wp-a.md", "src/**", "無")
        single = write_wp(self.dir, "wp-c.md", "src/*", "無")
        nested = write_wp(self.dir, "wp-b.md", "src/pkg/a.py", "無")
        self.assertEqual(1, self.gate(deep, nested))
        self.assertEqual(0, self.gate(single, nested))

    def test_bare_filenames_and_annotated_lines_are_still_parsed(self):
        # Claude 既有支援：無目錄前綴檔名、行內註記；改成整 token 解析後不得退化
        left = write_wp(self.dir, "wp-a.md", "- `index.html`（新增按鈕）\n- src/a.ts(只改 foo)", "無")
        right = write_wp(self.dir, "wp-b.md", "index.html", "無")
        items, _ = scope_overlap.scope_of(left)
        self.assertIn("index.html", items)
        self.assertIn("src/a.ts", items)
        self.assertEqual(1, self.gate(left, right))

    def test_route_group_parentheses_are_kept(self):
        left = write_wp(self.dir, "wp-a.md", "app/(auth)/page.tsx", "無")
        items, _ = scope_overlap.scope_of(left)
        self.assertIn("app/(auth)/page.tsx", items)

    # 5. 隔離 worktree（同 base）exit 0
    def test_isolated_worktrees_on_same_base_can_run_in_parallel(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "無", path="/tmp/長任務 repo.worktrees/wp-a", worktree="wp-a")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "無", path="/tmp/長任務 repo.worktrees/wp-b", worktree="wp-b")
        self.assertEqual(0, self.gate(left, right))

    # 6. 同 worktree exit 1（識別值相同，或路徑相同）
    def test_same_worktree_id_collides_even_with_disjoint_scopes(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "無", path="/tmp/a", worktree="shared")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "無", path="/tmp/b", worktree="shared")
        self.assertEqual(1, self.gate(left, right))

    def test_same_workspace_path_collides_even_with_different_ids(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "無", path="/tmp/canonical", worktree="a")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "無", path="/tmp/canonical/", worktree="b")
        self.assertEqual(1, self.gate(left, right))

    def test_new_package_is_checked_against_in_flight_worktree(self):
        flying = write_wp(self.dir, "wp-a.md", "src/a.py", "無", worktree="wp-shared")
        other_flying = write_wp(self.dir, "wp-c.md", "src/c.py", "無", worktree="wp-shared")
        new = write_wp(self.dir, "wp-b.md", "src/b.py", "無", worktree="wp-shared")
        self.assertEqual(1, self.gate(new, in_flight=[flying]))
        # 兩個都已在途的包不再互比，只比新包
        fresh = write_wp(self.dir, "wp-d.md", "src/d.py", "無")
        self.assertEqual(0, self.gate(fresh, in_flight=[flying, other_flying]))

    # 7. 缺 [工作區] exit 2
    def test_legacy_package_without_workspace_is_rejected(self):
        legacy = write_wp(self.dir, "legacy.md", "src/a.py", "無", workspace=False)
        ok = write_wp(self.dir, "wp-b.md", "src/b.py", "無")
        self.assertEqual(2, self.gate(ok, legacy))
        self.assertEqual(2, self.gate(ok, in_flight=[legacy]))

    def test_workspace_missing_a_field_is_rejected(self):
        for dropped in ("path", "worktree", "base"):
            fields = {"path": "/tmp/x", "worktree": "x", "base": BASE}
            fields.pop(dropped)
            body = "".join(f"{k}:{v}\n" for k, v in fields.items())
            wp = write_wp(self.dir, f"miss-{dropped}.md", "src/a.py", "無", workspace=body)
            self.assertEqual(2, self.gate(wp), dropped)

    # 8. 相對 path exit 2
    def test_relative_workspace_path_is_rejected(self):
        wp = write_wp(self.dir, "rel.md", "src/a.py", "無", path="repo.worktrees/wp-a")
        self.assertEqual(2, self.gate(wp))

    def test_placeholder_base_is_rejected(self):
        wp = write_wp(self.dir, "ph.md", "src/a.py", "無", base="<commit>")
        self.assertEqual(2, self.gate(wp))

    def test_cli_exit_codes_match_main(self):
        left = write_wp(self.dir, "wp-a.md", "src/a.py", "無", worktree="same")
        right = write_wp(self.dir, "wp-b.md", "src/b.py", "無", worktree="same")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "scope-overlap.py"), left, right],
            capture_output=True, text=True,
        )
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn("共用:worktree:same", result.stdout)


class SidecarGuardTests(unittest.TestCase):
    def run_guard(self, lines):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.md"
            path.write_text("\n".join(f"line {i}" for i in range(lines)) + "\n", encoding="utf-8")
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "sidecar-guard.py"), str(path)],
                capture_output=True, text=True,
            )
            after = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(before, after, "sidecar-guard 只能報告，不得改寫狀態檔")
            return result.returncode, result.stdout

    def test_150_lines_pass_quietly(self):
        code, out = self.run_guard(150)
        self.assertEqual(0, code)
        self.assertNotIn("提醒", out)

    def test_151_and_180_lines_pass_with_archive_reminder(self):
        for lines in (151, 180):
            code, out = self.run_guard(lines)
            self.assertEqual(0, code, lines)
            self.assertIn("下次派工前", out)

    def test_181_lines_block_new_dispatch(self):
        code, out = self.run_guard(181)
        self.assertEqual(1, code)
        self.assertIn("不得開新工作包", out)
        self.assertIn("active／BLOCKED", out)

    def test_missing_state_file_is_an_argument_error(self):
        self.assertEqual(2, sidecar_guard.main(["/nonexistent/state.md"]))

    def test_template_passes_and_counts_only_closed_work_rows(self):
        template = (SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        rows = (
            "| B-1 | B 技術 | lt-tech-worker-medium | — | abc1234 | /tmp/r.worktrees/B-1／B-1／abc1234 | PASS | 0 | medium | x |\n"
            "| B-2 | B 技術 | lt-tech-worker-medium | — | abc1234 | /tmp/r.worktrees/B-2／B-2／abc1234 | 派工中 | 0 | medium | x |\n"
        )
        filled = template.replace("|---|---|---|---|---|---|---|---|---|---|\n", "|---|---|---|---|---|---|---|---|---|---|\n" + rows, 1)
        self.assertNotEqual(template, filled, "範本的工作包表頭應有 10 欄（含工作區）")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.md"
            path.write_text(filled, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "sidecar-guard.py"), str(path)],
                capture_output=True, text=True,
            )
        self.assertEqual(0, result.returncode)
        self.assertIn("可封存的已關閉工作包 1 列", result.stdout)


def frontmatter(path):
    text = path.read_text(encoding="utf-8")
    _, head, body = text.split("---", 2)
    return yaml.safe_load(head), body


class AgentDefinitionTests(unittest.TestCase):
    ROLES = {
        "lt-visual-checker": ("medium", "high", "xhigh"),
        "lt-tech-worker": ("medium", "high", "xhigh"),
        "lt-researcher": ("medium", "high", "xhigh"),
        "lt-ui-tester": ("low", "medium", "high"),
    }
    BLOCKED = [
        "git commit -m x", "git push origin main", "git merge main", "git rebase main",
        "git cherry-pick abc", "git worktree add ../x", "git reset --hard", "git tag v1",
        "gh pr merge 3", "gh pr create", "gh release create v1",
        "pnpm add lodash", "npm install lodash", "yarn add x",
    ]
    ALLOWED = [
        "git status --short", "git diff --stat", "git rev-parse --short HEAD", "git log --oneline -3",
        "git tag -l", "cd /tmp/repo.worktrees/wp-a && python3 -m unittest", "npm test", "npm ci",
        "python3 scripts/sidecar-guard.py state.md",
    ]

    def definitions(self):
        for role, tiers in self.ROLES.items():
            for tier in tiers:
                path = AGENTS / f"{role}-{tier}.md"
                self.assertTrue(path.is_file(), path)
                yield role, tier, path

    def test_twelve_definitions_lock_model_effort_and_tools(self):
        seen = 0
        for role, tier, path in self.definitions():
            meta, _ = frontmatter(path)
            tools = [t.strip() for t in meta["tools"].split(",")]
            self.assertEqual("sonnet", meta["model"], path.name)
            self.assertEqual(tier, meta["effort"], path.name)
            self.assertNotIn("Agent", tools, path.name)
            if role != "lt-tech-worker":
                self.assertNotIn("Edit", tools, path.name)
                self.assertNotIn("Write", tools, path.name)
            seen += 1
        self.assertEqual(12, seen)

    def test_git_and_package_hook_blocks_writes_and_allows_reads(self):
        for _, _, path in self.definitions():
            meta, _ = frontmatter(path)
            command = meta["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            for cmd, expected in [(c, 2) for c in self.BLOCKED] + [(c, 0) for c in self.ALLOWED]:
                payload = '{"tool_name":"Bash","tool_input":{"command":"%s"}}' % cmd
                result = subprocess.run(["bash", "-c", command], input=payload, capture_output=True, text=True)
                self.assertEqual(expected, result.returncode, f"{path.name}: {cmd}")

    def test_tech_workers_stay_inside_declared_workspace(self):
        for tier in self.ROLES["lt-tech-worker"]:
            _, body = frontmatter(AGENTS / f"lt-tech-worker-{tier}.md")
            self.assertIn("[工作區] path", body)


class SharedSpecTests(unittest.TestCase):
    def test_spec_copies_match_root_spec(self):
        spec = (REPOSITORY / "SPEC.md").read_text(encoding="utf-8")
        for copy in (
            SKILL / "references" / "spec.md",
            REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "references" / "spec.md",
        ):
            self.assertEqual(spec, copy.read_text(encoding="utf-8"), copy)

    def test_common_behavioral_cases_are_verbatim_in_claude_adapter(self):
        common = {}
        for line in (REPOSITORY / "tests" / "behavioral-cases.md").read_text(encoding="utf-8").splitlines():
            number, _, text = line.partition(". ")
            if number.isdigit():
                common[int(number)] = text
        adapter = {}
        for line in (SKILL / "references" / "behavioral-cases.md").read_text(encoding="utf-8").splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split(" | ")]
            if len(cells) == 3 and cells[0].isdigit():
                adapter[int(cells[0])] = cells[1]
        self.assertGreaterEqual(len(common), 18)
        for number, text in common.items():
            self.assertEqual(text, adapter.get(number), f"case {number}")

    def test_decisions_go_to_state_list_not_blocking_questions(self):
        # 阻塞式提問會讓整條主線與 /goal 續跑一起停住（2026-09-25 實測停 10.5 小時），
        # 所以技能必須明文禁止，狀態檔也必須有承接待決事項的地方。
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("不呼叫 `AskUserQuestion`", skill)
        template = (SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        self.assertIn("## 待決清單", template)
        self.assertEqual(0, sidecar_guard.main([str(SKILL / "templates" / "state.md")]))

    def test_skill_references_existing_scripts(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        for script in ("scope-overlap.py", "sidecar-guard.py"):
            self.assertIn(f"scripts/{script}", skill)
            self.assertTrue((SCRIPTS / script).is_file(), script)


if __name__ == "__main__":
    unittest.main()

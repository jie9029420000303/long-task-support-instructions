"""Claude Code adapter 回歸測試：並行派工閘、積極派工、狀態檔容量守門、子代理定義與 hook、共用規格一致性。

每個測試都對應一個「為什麼重要」：假衝突會讓可並行的工作被迫排隊，漏判衝突會讓並行包互相踩壞
工作區；缺 [工作區] 時猜測隔離狀態會讓舊工作包悄悄共用 worktree；狀態檔膨脹會讓主線壓縮後讀不起狀態；
席位空著或整批收齊才補派，長任務就退化成序列執行。

可在兩種佈局執行：正式 repo（adapter 在 claude-code/.claude，旁邊有共用 SPEC.md、tests/behavioral-cases.md、
codex/），或獨立技能副本（本機封裝 repo：tests/ 旁邊直接是 .claude/，與 ~/.claude 同形）。跨 adapter
一致性只有正式 repo 才有比對對象，獨立副本會明確標為 skipped。
"""
import hashlib
import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import yaml


REPOSITORY = Path(__file__).resolve().parents[1]
ADAPTER = REPOSITORY / "claude-code" / ".claude"
if not ADAPTER.is_dir():
    ADAPTER = REPOSITORY / ".claude"
CANONICAL = (REPOSITORY / "SPEC.md").is_file() and (REPOSITORY / "codex").is_dir()
canonical_only = unittest.skipUnless(
    CANONICAL, "獨立技能副本沒有共用 SPEC.md／tests/behavioral-cases.md／codex/，跨 adapter 一致性只在正式 repo 驗"
)
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
            "| B-2 | B 技術 | lt-tech-worker-medium | — | abc1234 | /tmp/r.worktrees/B-2／B-2／abc1234 | 在途 | 0 | medium | x |\n"
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


def section(text, heading):
    """取出 `## <heading>` 開頭的那一節（到下一個 `## ` 為止），讓斷言只在該節內成立。"""
    match = re.search(rf"^## {re.escape(heading)}.*?(?=^## |\Z)", text, re.S | re.M)
    return match.group(0) if match else ""


def table_header(text, heading):
    return next((line for line in section(text, heading).splitlines() if line.startswith("|")), "")


class EagerDispatchTests(unittest.TestCase):
    """積極派工：可並行的工作要立刻占滿席位，任一包完成就補派；不然長任務會退化成一包一包跑。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.template = (SKILL / "templates" / "state.md").read_text(encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def gate(self, *files, in_flight=()):
        argv = list(files) + (["--in-flight", *in_flight] if in_flight else [])
        return scope_overlap.main(argv)

    def test_refill_checks_new_package_only_against_still_running_packages(self):
        # 一完成就補派的前提：新解鎖的包只跟「仍在途」的包比對。已完成的包若還留在在途清單，
        # 接續它同一檔案的後續包會被自己的前包擋下，只能等整批收齊——正是積極派工要消滅的空等。
        done = write_wp(self.dir, "B-1.md", "src/auth.py", "無")
        running = write_wp(self.dir, "B-2.md", "src/report.py", "無")
        unlocked = write_wp(self.dir, "B-3.md", "src/auth.py\ntests/test_auth.py", "無")
        self.assertEqual(0, self.gate(unlocked, in_flight=[running]))
        self.assertEqual(1, self.gate(unlocked, in_flight=[done, running]))

    def test_conflict_names_only_colliding_packages_so_the_rest_still_ship(self):
        # 一個交集不該讓整批改成序列：閘要指名是哪幾包撞到，主線才能先把其餘互斥包派出去填席位，
        # 只讓撞到的那包加依賴或隔離後再派。
        a = write_wp(self.dir, "B-1.md", "src/a.py", "DB:canonical")
        b = write_wp(self.dir, "B-2.md", "src/b.py", "無")
        c = write_wp(self.dir, "B-3.md", "src/c.py", "DB:canonical")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "scope-overlap.py"), a, b, c], capture_output=True, text=True,
        )
        self.assertEqual(1, result.returncode, result.stdout)
        hits = "\n".join(line for line in result.stdout.splitlines() if line.strip().startswith("- "))
        self.assertIn("B-1.md", hits)
        self.assertIn("B-3.md", hits)
        self.assertNotIn("B-2.md", hits)
        self.assertEqual(0, self.gate(a, b))
        self.assertEqual(1, self.gate(c, in_flight=[a, b]))

    def test_skill_fills_every_free_slot_in_background(self):
        # 只「允許」並行不夠：主線若每輪只派一包、或用前景 Agent 等整批結果回來，席位就一直空著。
        # 等待只能是結束回合等完成通知；輪詢只會空轉，也不會比通知更早補派。
        eager = section(self.skill, "積極派工")
        self.assertTrue(eager, "SKILL.md 缺「積極派工」節")
        for marker in (
            "可派即派", "不留空席", "run_in_background: true", "同一則回覆內",
            "不等同批其他包收齊", "結束回合等完成通知", "不為填席位切出",
        ):
            self.assertIn(marker, eager)

    def test_platform_slot_limit_is_used_and_overflow_is_not_retried(self):
        # 席位數要用平台真實上限，否則不是少派就是撞牆。Claude Code 超過上限時 Agent 呼叫直接失敗、不排隊；
        # 重試會空轉，記成品質錯誤會錯誤升檔、甚至冒充錯 3 讓主線接手實作。
        eager = section(self.skill, "積極派工")
        for marker in (
            "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "Concurrent subagent limit reached", "不重試",
            "不計品質錯誤", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
        ):
            self.assertIn(marker, eager)

    def test_state_template_shows_slots_ready_set_and_underfill_reason(self):
        # 壓縮後主線只信狀態檔：看不出上限、當輪席位、派了幾包與為何少派，就分不出「刻意依序」與「漏派」；
        # 工作包狀態沒有「待派／在途」，下一輪也算不出就緒包與可用席位。
        head = self.template.split("\n## ", 1)[0]
        self.assertIn("並行上限", head)
        self.assertIn("背景派工", head)
        batch = table_header(self.template, "並行批次")
        self.assertIn("可用席位／就緒／派出", batch)
        self.assertIn("少派理由", batch)
        work = table_header(self.template, "工作包")
        for status in ("待派", "在途", "PASS", "FAIL", "BLOCKED"):
            self.assertIn(status, work)

    def test_template_leaves_room_for_guard_before_every_refill(self):
        # 積極派工在每次補派前都跑 sidecar-guard；範本本身若已逼近 150 行，實跑很快撞 180 行硬上限而停派。
        # 也確認新增欄位後 guard 仍數得到並行批次列（封存提示靠它）。
        start = self.template.index("## 並行批次")
        separator = self.template.index("|---", start)
        insert_at = self.template.index("\n", separator) + 1
        row = "| 1 | B-1、B-2 | 20／2／2 | exit 0，無 | — | 並行派出 | 2026-09-27 10:00 |\n"
        filled = self.template[:insert_at] + row + self.template[insert_at:]
        path = Path(self.dir) / "state.md"
        path.write_text(filled, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "sidecar-guard.py"), str(path)], capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode)
        self.assertIn("並行批次 1 列", result.stdout)
        self.assertNotIn("提醒", result.stdout)


def acceptance_state(rows, verdict, approvals=(), padding=0):
    """寫一份含驗收逐條表的狀態檔內容；rows＝[(條文, 狀態, 核准依據)]。padding 用來撐大行數。"""
    text = "# 長任務狀態：t\n\n## 核准變更\n| 日期 | 變更 | 核准者 |\n|---|---|---|\n"
    text += "".join(f"| {a} |\n" for a in approvals)
    text += ("\n## 驗收標準（逐條）\n| # | 條文（原文） | 狀態（PASS／未達／部分／待決／核准不做） | 證據 | 核准依據 |\n"
             "|---|---|---|---|---|\n")
    text += "".join(f"| {i} | {t} | {st} | evidence/x.png＋abc1234 | {ok} |\n" for i, (t, st, ok) in enumerate(rows, 1))
    text += "\n" + "填充\n" * padding + f"\n## 最終判定\n{verdict}\n"
    return text


def run_script(script, text, directory):
    path = Path(directory) / "state.md"
    path.write_text(text, encoding="utf-8")
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    result = subprocess.run([sys.executable, str(script), str(path)], capture_output=True, text=True)
    assert before == hashlib.sha256(path.read_bytes()).hexdigest(), "sidecar-guard 只能報告，不得改寫狀態檔"
    return result.returncode, result.stdout


# 2026-09-28 稽核：主線看得到條文、甚至自記「未達」仍宣稱完成（online-e2e 25 項未過報完成、capture-defects
# 部分 PASS→全數通過、online-check「PASS（附條件）」）。這些情境是守門工具必須擋下的；誠實的進度回報則絕不能誤擋，
# 否則主線會被迫停住（等於另一種卡死）。
GATE_CASES = [
    ("全部 PASS 才宣稱完成", [("A", "PASS", ""), ("B", "PASS", "")], "PASS（候選版 abc1234）", 0),
    ("有部分仍宣稱完成", [("A", "PASS", ""), ("B", "部分", "")], "PASS（候選版 abc1234）", 3),
    ("有待決仍說全部通過", [("A", "PASS", ""), ("B", "待決", "")], "九條全部通過", 3),
    ("條目寫附條件", [("A", "PASS（附條件）", "")], "PASS", 3),
    ("最終判定寫附條件", [("A", "PASS", "")], "PASS（附條件）", 3),
    ("核准不做缺使用者原話", [("A", "PASS", ""), ("B", "核准不做", "")], "完成", 3),
    ("核准不做有原話與時間", [("A", "PASS", ""), ("B", "核准不做", "Jay 09-27 01:11「這條不修」")], "完成", 0),
    ("誠實回報未完成", [("A", "PASS", ""), ("B", "未達", "")], "未完成（1／2，剩 #2）", 0),
    ("誠實判 FAIL", [("A", "PASS", ""), ("B", "未達", "")], "FAIL（#2 未達；其餘已完成）", 0),
    ("範本佔位", [("A", "未達", "")], "<未完成／PASS／FAIL>", 0),
]


class AcceptanceGateTests(unittest.TestCase):
    """放行紀律：判定只能照驗收逐條，宣稱完成而逐條不符時 exit 3，交主線修正、不等人。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.guard = SCRIPTS / "sidecar-guard.py"

    def tearDown(self):
        self.tmp.cleanup()

    def test_completion_gate_cases(self):
        for name, rows, verdict, expected in GATE_CASES:
            code, out = run_script(self.guard, acceptance_state(rows, verdict), self.dir)
            self.assertEqual(expected, code, f"{name}\n{out}")

    def test_mismatch_names_the_open_criteria(self):
        # 只說「不一致」不夠：主線要知道是哪幾條，才能改判定或補證據。
        code, out = run_script(self.guard, acceptance_state(
            [("A", "PASS", ""), ("B", "部分", ""), ("C", "待決", "")], "PASS"), self.dir)
        self.assertEqual(3, code)
        self.assertIn("#2", out)
        self.assertIn("#3", out)
        self.assertNotIn("#1［", out)

    def test_every_run_reprints_criteria_and_latest_approval(self):
        # 壓縮後狀態檔 15 次只附回 2 次；每次派工前／判定後跑的守門工具把條文原文與最新核准重印，主線就不必靠記憶。
        rows = [("線上 80 品批次跑完 80/80", "PASS", ""), ("首重通路規格未驗 0", "未達", "")]
        code, out = run_script(self.guard, acceptance_state(
            rows, "未完成", approvals=["2026-09-27 | 重新界定目標 | Jay"]), self.dir)
        self.assertEqual(0, code)
        for text, _, _ in rows:
            self.assertIn(text, out)
        self.assertIn("重新界定目標", out)

    def test_legacy_numbered_criteria_are_printed_but_not_gated(self):
        # 進行中的舊任務沒有狀態欄；守門只能印出條文提醒改格式，不能因為讀不懂而擋住它們。
        text = "## 驗收標準\n1. 舊格式條文甲\n2. 舊格式條文乙\n\n## 最終判定\nPASS\n"
        code, out = run_script(self.guard, text, self.dir)
        self.assertEqual(0, code)
        self.assertIn("舊格式條文甲", out)
        self.assertIn("舊格式", out)

    def test_capacity_block_wins_but_both_problems_are_reported(self):
        # 超過 180 行本來就不得派工（exit 1）；同時存在的完成宣稱不一致也要印出來，否則封存後才發現又得多跑一輪。
        code, out = run_script(self.guard, acceptance_state([("A", "部分", "")], "PASS", padding=200), self.dir)
        self.assertEqual(1, code)
        self.assertIn("不得開新工作包", out)
        self.assertIn("#1［部分］", out)

    def test_template_has_gateable_criteria_table_and_prerequisite_category(self):
        template = (SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        header = table_header(template, "驗收標準")
        for column in ("條文", "狀態", "證據", "核准"):
            self.assertIn(column, header)
        self.assertIn("前置", table_header(template, "待決清單"))


class DisciplineContractTests(unittest.TestCase):
    """技能文字必須寫明放行紀律、前置盤點、外部等待喚醒與提問紀律——這四項是 2026-09-28 稽核的根因修正。"""

    skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

    def test_release_discipline_forbids_conditional_pass_and_unapproved_criteria_edits(self):
        # 已查證：主線自寫「未達」仍判 PASS（附條件）、自改 AC2 條文；/goal 評估只看主線說法擋不住。
        body = self.skill[self.skill.index("**放行紀律**"):]
        for marker in ("附條件 PASS", "核准變更", "使用者原話與時間", "exit 3", "不停下來等人"):
            self.assertIn(marker, body)

    def test_launch_lists_prerequisites_once_and_keeps_working(self):
        # 16 個任務有約 100 小時花在執行到一半才回頭要權限、帳號、決定。
        start = section(self.skill, "啟動與續接")
        for marker in ("前置盤點", "一次列給使用者", "不等回答"):
            self.assertIn(marker, start)

    def test_external_waits_arm_a_wakeup_before_ending_the_turn(self):
        # CI／主機排程不會通知主線；沒掛監看就結束回合，實測 11 小時沒動靜直到使用者回來。
        eager = section(self.skill, "積極派工")
        for marker in ("run_in_background", "Monitor", "不得只說"):
            self.assertIn(marker, eager)

    def test_question_discipline_limits_what_may_be_asked(self):
        # 2026-09-27：17 題中 13 題是 /goal 已授權且有推薦的修正選擇，1 題使用者前一天已定調。
        pending = section(self.skill, "待決事項")
        for marker in ("**提問紀律**", "要不要修（推薦修）", "集中成一次", "先查待決清單", "單獨看懂"):
            self.assertIn(marker, pending)

    def test_release_approval_is_scoped_and_persists_across_resume(self):
        # The old UAT waited again at release even after its work was prepared.
        # Preserve approval scope so the agent acts when covered and stops only
        # the particular operation when the target or scope changes.
        template = (SKILL / "templates" / "state.md").read_text(encoding="utf-8")
        for marker in ("發布授權核對", "使用者原話與時間", "候選提交", "直接執行、不重問", "範圍或目標改變", "不在續接回合重提"):
            self.assertIn(marker, self.skill)
        for marker in ("## 發布授權", "來源→目標分支／環境", "允許的候選變更範圍與放行條件", "實際候選提交與核對結果"):
            self.assertIn(marker, template)


class SharedSpecTests(unittest.TestCase):
    @canonical_only
    def test_spec_copies_match_root_spec(self):
        spec = (REPOSITORY / "SPEC.md").read_text(encoding="utf-8")
        for copy in (
            SKILL / "references" / "spec.md",
            REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "references" / "spec.md",
        ):
            self.assertEqual(spec, copy.read_text(encoding="utf-8"), copy)

    @canonical_only
    def test_common_behavioral_cases_are_verbatim_in_claude_adapter(self):
        common = {}
        for line in (REPOSITORY / "tests" / "behavioral-cases.md").read_text(encoding="utf-8").splitlines():
            number, _, text = line.partition(". ")
            if number.isdigit():
                common[int(number)] = text
        adapter, numbers = {}, []
        for line in (SKILL / "references" / "behavioral-cases.md").read_text(encoding="utf-8").splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split(" | ")]
            if len(cells) == 3 and cells[0].isdigit():
                adapter[int(cells[0])] = cells[1]
                numbers.append(int(cells[0]))
        # Claude 專屬案例若沿用共同案例的編號，會把共同案例蓋掉，新增的共同案例就沒人驗。
        self.assertEqual(len(numbers), len(set(numbers)), f"案例編號重複：{numbers}")
        self.assertGreaterEqual(len(common), 25)
        for number, text in common.items():
            self.assertEqual(text, adapter.get(number), f"case {number}")

    @canonical_only
    def test_both_adapters_carry_the_shared_eager_dispatch_rule(self):
        # 積極派工是共同語意：只有一個平台做到，另一個平台的長任務仍會一包一包跑；
        # 少派必記理由也要兩邊都有，否則該平台的空席位無從稽核。
        spec = (REPOSITORY / "SPEC.md").read_text(encoding="utf-8")
        self.assertIn("17. 積極派工（可派即派、不留空席）", spec)
        codex = REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator"
        for skill_dir in (SKILL, codex):
            text = "".join(
                (skill_dir / name).read_text(encoding="utf-8") for name in ("SKILL.md", "references/execution.md")
            )
            for marker in ("可派即派", "不留空席", "只派一包", "少於可用席位"):
                self.assertIn(marker, text, f"{skill_dir.name}: {marker}")

    @canonical_only
    def test_both_guards_enforce_the_same_completion_gate(self):
        # 放行紀律是共同語意：兩個平台的守門工具對同一份狀態檔必須給出同一個結論，否則同一個任務換平台就換標準。
        codex_guard = REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "scripts" / "sidecar-guard.py"
        with tempfile.TemporaryDirectory() as directory:
            for name, rows, verdict, expected in GATE_CASES:
                text = acceptance_state(rows, verdict)
                claude_code, _ = run_script(SCRIPTS / "sidecar-guard.py", text, directory)
                codex_code, _ = run_script(codex_guard, text, directory)
                self.assertEqual((expected, expected), (claude_code, codex_code), name)

    @canonical_only
    def test_spec_and_both_adapters_carry_release_prerequisite_wait_and_question_rules(self):
        spec = (REPOSITORY / "SPEC.md").read_text(encoding="utf-8")
        for marker in ("18. 驗收逐條與放行紀律", "19. 驗收條文只能依使用者明確授權變更", "20. 開工前置盤點", "21. 外部等待須有喚醒",
                       "使用者要求逐項確認待決事項時"):
            self.assertIn(marker, spec)
        codex = REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator"
        for skill_dir in (SKILL, codex):
            text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            for marker in ("**放行紀律**", "**提問紀律**", "附條件 PASS", "前置", "監看", "exit 3"):
                self.assertIn(marker, text, f"{skill_dir.name}: {marker}")

    def test_decisions_go_to_state_list_not_blocking_questions(self):
        # 阻塞式提問會讓整條主線與 /goal 續跑一起停住（2026-09-25 實測停 10.5 小時），
        # 所以技能必須明文禁止，狀態檔也必須有承接待決事項的地方。
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("不呼叫 `AskUserQuestion`", skill)
        # 「不阻塞」不等於主線可自行拍板：只有已確認範圍內的可逆事項能先採預設；上層規則要求事前確認的
        # 重大變更只 BLOCKED 該動作；模糊回答只能採可逆解讀，否則不問就等於越權。
        pending = section(skill, "待決事項")
        for marker in ("已確認範圍內", "上層規則", "可逆解讀", "其餘已授權工作照常"):
            self.assertIn(marker, pending)
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

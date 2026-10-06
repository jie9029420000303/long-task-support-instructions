"""長任務 hooks 閘回歸測試。

每個測試對應一個「為什麼重要」：壓縮後沒重載技能，主線會照摘要亂派工（v0.2 重跑 125 分鐘、41 包從
high 起跳）；長任務裡用提問框等人，主線會整條停住（2026-09-25 UAT 卡 74＋176＋380 分鐘）；工作包缺隔離欄位
會讓並行閘無從判斷；從高檔起跳或錯 3 還重派，會燒掉升檔與主線接手的品質紀律。閘誤擋一般對話同樣有害，
所以每道閘都同時測「該擋」與「不該擋」。
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPOSITORY = Path(__file__).resolve().parents[1]
ADAPTER = REPOSITORY / "claude-code" / ".claude"
if not ADAPTER.is_dir():
    ADAPTER = REPOSITORY / ".claude"
GATES = ADAPTER / "skills" / "long-task-orchestrator" / "scripts" / "gates.py"
SKILL_ROW = "Base directory for this skill: /Users/x/Application Support/skills/long-task-orchestrator\n\n# 長任務協作"
WP = "[工作包] id=WP-1；類型=B 技術；目前錯誤次數={errors}；本次 effort 檔=x\n[工作區]\npath:/w\n[可修改範圍]\nsrc/**\n[共用資源]\n無\n"


def state(final="未完成", itemized="關閉", rows=()):
    table = "\n".join(f"| {wp} | B 技術 | lt-tech-worker-medium | | | /w | 在途 | {errors} | medium | |" for wp, errors in rows)
    return (f"# 長任務狀態：qa\n\n- 逐項確認模式：{itemized}\n\n## 工作包\n"
            "| id | 類型 | 負責定義 | 依賴 | 候選版 | 工作區 | 狀態 | 錯誤次數 | 目前檔 | 成果 |\n|---|---|---|---|---|---|---|---|---|---|\n"
            f"{table}\n\n## 最終判定\n{final}\n")


class Gate:
    def __init__(self, rows=(), state_text=None):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.transcript = root / "t.jsonl"
        self.transcript.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
        if state_text is not None:
            (root / ".claude" / "long-task" / "qa").mkdir(parents=True)
            (root / ".claude" / "long-task" / "qa" / "state.md").write_text(state_text, encoding="utf-8")

    def run(self, **event):
        payload = {"cwd": self.dir.name, "transcript_path": str(self.transcript), **event}
        return subprocess.run([sys.executable, str(GATES)], input=json.dumps(payload, ensure_ascii=False),
                              capture_output=True, text=True)

    def close(self):
        self.dir.cleanup()


def user(text):
    return {"type": "user", "message": {"content": [{"type": "text", "text": text}]}}


def tool_result(text):
    return {"type": "user", "message": {"content": [{"type": "tool_result", "content": text}]}}


class CompactReloadTests(unittest.TestCase):
    def test_long_task_session_gets_reload_reminder_after_compaction(self):
        gate = Gate([user(SKILL_ROW)], state(rows=[("WP-1", 0)]))
        try:
            result = gate.run(hook_event_name="SessionStart", source="compact")
            self.assertEqual(0, result.returncode)
            self.assertIn('Skill(long-task-orchestrator, "續接")', result.stdout)
            self.assertIn("state.md", result.stdout)
        finally:
            gate.close()

    def test_skill_text_only_printed_by_a_tool_is_not_a_long_task_session(self):
        # 監督對話會在工具輸出印出執行端 transcript；把它當長任務就會誤擋監督自己。
        gate = Gate([tool_result(SKILL_ROW)])
        try:
            self.assertEqual("", gate.run(hook_event_name="SessionStart", source="compact").stdout)
        finally:
            gate.close()

    def test_ordinary_startup_adds_nothing(self):
        gate = Gate([user(SKILL_ROW)])
        try:
            self.assertEqual("", gate.run(hook_event_name="SessionStart", source="startup").stdout)
        finally:
            gate.close()


class QuestionGateTests(unittest.TestCase):
    def ask(self, rows, state_text):
        gate = Gate(rows, state_text)
        try:
            return gate.run(hook_event_name="PreToolUse", tool_name="AskUserQuestion", tool_input={})
        finally:
            gate.close()

    def test_unsupervised_long_task_adopts_recommendation_instead_of_waiting(self):
        result = self.ask([user(SKILL_ROW)], state())
        self.assertEqual(2, result.returncode)
        self.assertIn("已採預設", result.stderr)

    def test_supervised_executor_routes_the_question_to_the_supervisor(self):
        result = self.ask([user("LONG_TASK_BIND:abc 啟動"), user(SKILL_ROW)], state())
        self.assertEqual(2, result.returncode)
        self.assertIn("監督", result.stderr)
        self.assertIn("question", result.stderr)

    def test_binding_that_arrived_mid_turn_still_routes_to_the_supervisor(self):
        # 2026-10-06 Gateway 實測：回合中途送到的訊息存成 queued_command 附件；只認 user 列會把受監督的執行端
        # 當成未受監督，提示它自己採預設，而不是交監督代答。
        bind = {"type": "attachment", "attachment": {"type": "queued_command",
                                                       "prompt": "<cross-session-message>LONG_TASK_BIND:abc 啟動</cross-session-message>"}}
        result = self.ask([user(SKILL_ROW), bind], state())
        self.assertEqual(2, result.returncode)
        self.assertIn("監督", result.stderr)
        self.assertIn("question", result.stderr)

    def test_user_requested_itemized_confirmation_is_allowed(self):
        self.assertEqual(0, self.ask([user(SKILL_ROW)], state(itemized="使用者：「逐項跟我確認」2026-10-06 10:00")).returncode)

    def test_finished_task_and_ordinary_sessions_can_still_ask(self):
        self.assertEqual(0, self.ask([user(SKILL_ROW)], state(final="PASS（候選版 abc）")).returncode)
        self.assertEqual(0, self.ask([user("一般對話")], state()).returncode)


class DispatchGateTests(unittest.TestCase):
    def dispatch(self, agent, prompt, rows=(("WP-1", 0),)):
        gate = Gate([user(SKILL_ROW)], state(rows=rows) if rows is not None else None)
        try:
            return gate.run(hook_event_name="PreToolUse", tool_name="Agent",
                            tool_input={"subagent_type": agent, "prompt": prompt, "description": "wp"})
        finally:
            gate.close()

    def test_missing_isolation_fields_are_rejected(self):
        result = self.dispatch("lt-tech-worker-medium", WP.format(errors=0).replace("[共用資源]\n無\n", ""))
        self.assertEqual(2, result.returncode)
        self.assertIn("[共用資源]", result.stderr)

    def test_new_package_starts_at_baseline(self):
        self.assertEqual(0, self.dispatch("lt-tech-worker-medium", WP.format(errors=0)).returncode)
        self.assertEqual(2, self.dispatch("lt-tech-worker-high", WP.format(errors=0)).returncode)
        self.assertEqual(2, self.dispatch("long-task:lt-tech-worker-high", WP.format(errors=0)).returncode)
        self.assertEqual(0, self.dispatch("lt-ui-tester-low", WP.format(errors=0)).returncode)
        self.assertEqual(2, self.dispatch("lt-ui-tester-medium", WP.format(errors=0)).returncode)

    def test_one_step_per_quality_error_and_main_thread_takes_over_at_three(self):
        self.assertEqual(0, self.dispatch("lt-tech-worker-high", WP.format(errors=1), rows=(("WP-1", 1),)).returncode)
        self.assertEqual(2, self.dispatch("lt-tech-worker-xhigh", WP.format(errors=1), rows=(("WP-1", 1),)).returncode)
        result = self.dispatch("lt-tech-worker-xhigh", WP.format(errors=3), rows=(("WP-1", 3),))
        self.assertEqual(2, result.returncode)
        self.assertIn("主線接手", result.stderr)

    def test_state_table_is_authoritative_over_the_prompt_header(self):
        # 主線在派工表頭少寫錯誤次數時，以狀態檔為準，避免藉表頭把錯 2 的包當新包重派。
        self.assertEqual(0, self.dispatch("lt-tech-worker-xhigh", WP.format(errors=0), rows=(("WP-1", 2),)).returncode)

    def test_unknown_error_count_passes_with_a_note_instead_of_guessing(self):
        result = self.dispatch("lt-tech-worker-high", WP.format(errors=0).replace("目前錯誤次數=0；", ""), rows=None)
        self.assertEqual(0, result.returncode)
        self.assertIn("查不到", result.stdout)

    def test_other_agents_are_untouched(self):
        self.assertEqual(0, self.dispatch("general-purpose", "no work package here").returncode)


if __name__ == "__main__":
    unittest.main()

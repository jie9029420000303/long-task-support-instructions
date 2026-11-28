"""v1.22.0（Jay 2026-11-28 2A）：映像與測試容器的回收。工區 E 在 Mac 留下 11 個、Staging 16 個舊映像，登記的 40 個
容器沒有一個移除過。這裡固定三件事：遠端主機的 docker 指令照原樣經 ssh 送過去；映像只刪最新兩版、容器在用、指定保留與
任務開始前就有以外的；不是 PASS 的容器停止滿 24 小時才算可移除。"""
import datetime as dt
import importlib.util
import shlex
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(rel):
    spec = importlib.util.spec_from_file_location("ledger_" + rel.replace("/", "_"), ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LEDGERS = [load("codex/.agents/skills/goal-orchestrator/scripts/resource-ledger.py"),
           load("claude-code/.claude/skills/long-task-orchestrator/scripts/resource-ledger.py")]


class FakeRun:
    """回應 image ls、ps -aq、inspect 三個指令。"""

    def __init__(self, images, used):
        self.images, self.used, self.calls = images, used, []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        words = shlex.split(argv[-1]) if argv[0] == "ssh" else argv
        words = words[words.index("docker") + 1:]
        if words[:2] == ["image", "ls"]:
            out = "".join(f"{i}\t{tag}\t{created} +0800 CST\n" for i, tag, created in self.images)
        elif words[:2] == ["ps", "-aq"]:
            out = "c1\nc2\n"
        elif words[0] == "inspect":
            out = "".join(f"{u}\n" for u in self.used)
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, out, "")


class ImageAndContainerCleanup(unittest.TestCase):
    def test_both_skills_ship_the_same_ledger(self):
        self.assertEqual((ROOT / "codex/.agents/skills/goal-orchestrator/scripts/resource-ledger.py").read_bytes(),
                         (ROOT / "claude-code/.claude/skills/long-task-orchestrator/scripts/resource-ledger.py").read_bytes())

    def test_remote_docker_goes_through_ssh_with_its_arguments_intact(self):
        for rl in LEDGERS:
            self.assertEqual(rl.docker_argv(None, "ps", "-a"), ["docker", "ps", "-a"])
            argv = rl.docker_argv("ops-staging", "ps", "--format", "{{.Names}}\t{{.Image}}")
            self.assertEqual(argv[:2], ["ssh", "-o"])
            self.assertEqual(shlex.split(argv[-1]), ["sudo", "-n", "docker", "ps", "--format", "{{.Names}}\t{{.Image}}"])

    def test_old_images_go_and_the_deployed_previous_used_kept_and_older_stay(self):
        images = [("sha256:a", "054db7810", "2026-11-28 07:27:13"), ("sha256:b", "36c0dd0ac", "2026-11-28 04:33:17"),
                  ("sha256:c", "940395983", "2026-11-27 21:22:06"), ("sha256:d", "471406bbd", "2026-11-27 14:22:21"),
                  ("sha256:e", "c073fca9", "2026-11-25 10:15:45"), ("sha256:f", "9ace39805", "2026-11-27 08:09:53"),
                  ("sha256:g", "old", "2026-11-01 08:00:00")]
        for rl in LEDGERS:
            fake = FakeRun(images, ["sha256:d"])
            original, rl.subprocess.run = rl.subprocess.run, fake
            try:
                plan = rl.image_plan({"repo": "bpm-app", "host": "ops-staging", "keep": ["c073fca9"]}, dt.datetime(2026, 11, 14))
            finally:
                rl.subprocess.run = original
            kept = {item["tags"][0]: item["why"] for item in plan["keep"]}
            self.assertEqual(set(kept), {"054db7810", "36c0dd0ac", "471406bbd", "c073fca9", "old"})
            self.assertEqual(kept["471406bbd"], "容器在用")
            self.assertEqual(sorted(item["tags"][0] for item in plan["remove"]), ["940395983", "9ace39805"])
            self.assertTrue(all(call[0] == "ssh" for call in fake.calls))

    def test_a_container_that_did_not_pass_waits_a_day_after_it_stopped(self):
        for rl in LEDGERS:
            hours = lambda h: (rl.now() - dt.timedelta(hours=h)).isoformat()
            self.assertLess(rl.stopped_hours({"stopped_at": hours(23)}), rl.FAILED_KEEP_HOURS)
            self.assertGreaterEqual(rl.stopped_hours({"stopped_at": hours(25)}), rl.FAILED_KEEP_HOURS)
            self.assertEqual(rl.stopped_hours({}), 0.0)


if __name__ == "__main__":
    unittest.main()

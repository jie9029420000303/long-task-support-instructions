"""v1.22.3（工區 E 監督 2026-11-28 轉來三個缺口）：C105 在 Staging 照 v1.22.2 登記 22 個舊容器，一筆都沒刪掉。
①v1.22.2 以前建的容器沒有 lt.* 標籤，身分核對永遠不符；②移除前把完整 docker inspect（含 POSTGRES_PASSWORD 等環境變數）
和日誌寫進雲端同步範圍內的狀態目錄；③停止時間記成登記當下，早就停的容器也要再等 24 小時。這裡固定：狀態目錄裡的存證
不含環境變數與日誌內容，日誌留在容器所在主機的受限資料夾，存不了就不移除，遠端舊容器以登記時的 ID、名稱與建立時間核對，
24 小時從 State.FinishedAt 起算。"""
import datetime as dt
import importlib.util
import json
import os
import shlex
import stat
import subprocess
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRET = "POSTGRES_PASSWORD=s3cret-from-env"
READ_VALUE = "invoice total 123456"


def load(rel):
    spec = importlib.util.spec_from_file_location("ledger1223_" + rel.replace("/", "_"), ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LEDGERS = [load("codex/.agents/skills/goal-orchestrator/scripts/resource-ledger.py"),
           load("claude-code/.claude/skills/long-task-orchestrator/scripts/resource-ledger.py")]


def inspected(finished="2026-11-25T03:00:00.123456789Z"):
    return {"Id": "c" * 64, "Name": "/r2e-app-resident-prev2", "Created": "2026-11-24T01:00:00Z", "Image": "sha256:abc",
            "RestartCount": 0, "Config": {"Image": "bpm-app:3c524bb10", "Env": [SECRET], "Labels": {"app": "bpm"}},
            "HostConfig": {"Binds": ["/srv/secret.env:/run/secret.env"]},
            "State": {"Status": "exited", "ExitCode": 1, "StartedAt": "2026-11-24T01:00:01Z", "FinishedAt": finished},
            "Mounts": [{"Type": "volume", "Name": "v1", "Source": "/var/lib/docker/volumes/v1", "Destination": "/data", "RW": True}]}


class FakeRun:
    """遠端 docker inspect、ps -a、rm 與存日誌的 sudo sh -c；logs_ok=False 時存日誌失敗。"""

    def __init__(self, logs_ok=True):
        self.logs_ok, self.calls, self.removed = logs_ok, [], False

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        words = shlex.split(argv[-1]) if argv[0] == "ssh" else argv
        out = ""
        if words[:3] == ["sudo", "-n", "sh"]:
            out = "500\n" + "f" * 64 + "  /var/tmp/long-task-container-logs/x.log\n" if self.logs_ok else ""
        elif "inspect" in words:
            out = json.dumps([inspected()])
        elif "rm" in words:
            self.removed = True
        return subprocess.CompletedProcess(argv, 0, out, "")


class SafeContainerEvidence(unittest.TestCase):
    def test_the_kept_container_facts_leave_out_env_and_host_config(self):
        for rl in LEDGERS:
            safe = json.dumps(rl.safe_inspect(inspected()), ensure_ascii=False)
            self.assertNotIn(SECRET, safe)
            self.assertNotIn("secret.env", safe)
            self.assertIn("2026-11-25T03:00:00", safe)
            self.assertIn("/data", safe)

    def test_the_stop_time_is_when_the_container_finished(self):
        for rl in LEDGERS:
            expected = dt.datetime(2026, 11, 25, 3, 0, 0, tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
            self.assertEqual(rl.finished_at([inspected()]), expected)
            self.assertIsNone(rl.finished_at([inspected("0001-01-01T00:00:00Z")]), "a container that never ran has no stop time")
            self.assertIsNone(rl.finished_at(None))

    def test_local_logs_stay_in_a_private_folder_outside_the_state_directory(self):
        for rl in LEDGERS:
            with tempfile.TemporaryDirectory() as home:
                fake = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, (READ_VALUE + "\n").encode() * 3, None)
                original, rl.subprocess.run = rl.subprocess.run, fake
                os.environ["LONG_TASK_HOME"] = home
                try:
                    kept = rl.keep_logs(None, "d" * 64, "/wp-e1734-pg")
                finally:
                    rl.subprocess.run = original
                    del os.environ["LONG_TASK_HOME"]
                target = Path(kept["path"])
                self.assertEqual(target.parent, Path(home) / "removed-container-logs")
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
                self.assertEqual(kept["lines"], 3)
                self.assertIn(READ_VALUE, target.read_text())

    def test_remote_logs_are_written_on_the_host_and_a_failure_keeps_the_container(self):
        for rl in LEDGERS:
            fake = FakeRun()
            original, rl.subprocess.run = rl.subprocess.run, fake
            try:
                kept = rl.keep_logs("ops-staging", "c" * 64, "/prev2")
                rl.subprocess.run = FakeRun(logs_ok=False)
                failed = rl.keep_logs("ops-staging", "c" * 64, "/prev2")
            finally:
                rl.subprocess.run = original
            self.assertEqual((kept["lines"], kept["sha256"]), (500, "f" * 64))
            self.assertTrue(kept["path"].startswith(rl.REMOTE_LOG_DIR + "/"))
            script = shlex.split(fake.calls[0][-1])
            self.assertEqual(script[:3], ["sudo", "-n", "sh"])
            self.assertTrue(script[4].startswith("set -e; umask 077;"))
            self.assertIn("error", failed)

    def test_an_old_staging_container_is_removed_with_safe_evidence_from_when_it_stopped(self):
        for rl in LEDGERS:
            with tempfile.TemporaryDirectory() as root:
                state_dir = Path(root) / "task"
                state_dir.mkdir()
                listed = {"id": "c" * 64, "name": "r2e-app-resident-prev2", "created": dt.datetime(2026, 11, 24, 9, 0),
                          "project": "", "working_dir": "", "task": "", "state": "exited", "wp": "", "close": "", "ledger": ""}
                res = {"id": "r1", "kind": "container", "container": listed["name"], "host": "ops-staging", "managed": True,
                       "wp": "C105", "close": "wp", "stopped_at": rl.now().isoformat(),
                       "container_identities": [rl.container_identity(listed)]}
                path = state_dir / "resources.json"
                path.write_text(json.dumps({"resources": [res]}), encoding="utf-8")
                fake, patched = FakeRun(), {}
                for name, value in {"package_passed": lambda *a: False,
                                    "docker_all": lambda host=None: [] if fake.removed else [listed]}.items():
                    patched[name] = getattr(rl, name)
                    setattr(rl, name, value)
                original, rl.subprocess.run = rl.subprocess.run, fake
                try:
                    result, why = rl.remove(dict(res), path, types.SimpleNamespace(search=None, integrated_into=None))
                finally:
                    rl.subprocess.run = original
                    for name, value in patched.items():
                        setattr(rl, name, value)
                self.assertEqual(result, "removed", why)
                self.assertTrue(fake.removed)
                written = "".join(p.read_text(encoding="utf-8") for p in state_dir.rglob("*") if p.is_file())
                self.assertNotIn(SECRET, written, "no environment variable reaches the synced state directory")
                self.assertNotIn(READ_VALUE, written)
                evidence = json.loads((state_dir / "evidence" / "container-r1-移除前.json").read_text(encoding="utf-8"))
                self.assertEqual(evidence["logs"][0]["host"], "ops-staging")
                stopped = json.loads(path.read_text(encoding="utf-8"))["resources"][0]["stopped_at"]
                self.assertEqual(stopped, rl.finished_at([inspected()]).isoformat(), "the ledger keeps the real stop time")

    def test_the_ledger_keeps_env_names_but_not_their_values(self):
        # v1.22.4: run-container and start wrote "-e POSTGRES_PASSWORD=..." into resources.json as given.
        for rl in LEDGERS:
            shown = rl.recorded_command(["--rm", "-e", SECRET, "--env", "TOKEN=abc", "--env=URL=postgres://u:p@h/db",
                                         "-e", "POSTGRES_DB", "--label", "a=b", "postgres:16"])
            self.assertEqual(shown, "--rm -e POSTGRES_PASSWORD=*** --env TOKEN=*** --env=URL=*** -e POSTGRES_DB "
                                    "--label a=b postgres:16")

    def test_an_old_container_replaced_under_the_same_name_is_not_touched(self):
        for rl in LEDGERS:
            listed = {"id": "c" * 64, "name": "prev2", "created": dt.datetime(2026, 11, 24, 9, 0)}
            res = {"host": "ops-staging", "container_identities": [rl.container_identity(listed)]}
            self.assertIsNone(rl.identity_problem(res, "/x/resources.json", [listed]), "no lt.* labels are needed")
            moved = dict(listed, created=dt.datetime(2026, 11, 26, 9, 0))
            self.assertIsNotNone(rl.identity_problem(res, "/x/resources.json", [moved]))


if __name__ == "__main__":
    unittest.main()


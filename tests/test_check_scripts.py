"""v1.2.0 (Jay 2026-11-09): checking took more of a long task's time than building, partly from one-off scripts for
the same checks, whole test outputs pasted into the conversation and long tests polled every few seconds.
test-run.py keeps the full output in a log and puts only the result on screen, inside one bounded wait;
evidence-check.py replaces the one-off hash, index, readback and acceptance-map scripts. These tests pin what saves
that time and the guards that keep the shorter output honest: the exit code, the failures and a PASS without evidence
must still show."""
import filecmp
import http.server
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest

REPOSITORY = pathlib.Path(__file__).resolve().parents[1]
COPIES = [REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "scripts",
          REPOSITORY / "claude-code" / ".claude" / "skills" / "long-task-orchestrator" / "scripts"]


def run(folder, name, *args, timeout=60):
    return subprocess.run([sys.executable, str(folder / name), *args], capture_output=True, text=True, timeout=timeout)


class CheckScriptsTest(unittest.TestCase):
    def test_both_orchestrators_ship_the_same_runnable_scripts(self):
        for name in ("test-run.py", "evidence-check.py"):
            self.assertTrue(filecmp.cmp(COPIES[0] / name, COPIES[1] / name, shallow=False), name)
            for folder in COPIES:
                self.assertTrue(os.access(folder / name, os.X_OK), folder / name)

    def test_the_full_output_stays_in_the_log_and_only_the_result_reaches_the_screen(self):
        for folder in COPIES:
            with tempfile.TemporaryDirectory() as root:
                script = pathlib.Path(root, "t.py")
                script.write_text('import sys\nfor i in range(500): print("noise line", i)\nprint("not ok 3 - checkout keeps the cart")\n'
                                  'print("# tests 10")\nprint("# pass 9")\nprint("# fail 1")\nsys.exit(1)\n', encoding="utf-8")
                log = pathlib.Path(root, "evidence", "unit.log")
                done = run(folder, "test-run.py", "--log", str(log), "--", sys.executable, str(script))
                self.assertEqual(done.returncode, 1, "the test command's own exit code comes back")
                self.assertIn("not ok 3 - checkout keeps the cart", done.stdout)
                self.assertIn("total 10、passed 9、failed 1", done.stdout)
                self.assertNotIn("noise line", done.stdout, "the screen stays short")
                self.assertLess(len(done.stdout.splitlines()), 10)
                self.assertIn("noise line 499", log.read_text(encoding="utf-8"), "nothing is lost from the log")
                summary = json.loads(pathlib.Path(str(log) + ".summary.json").read_text(encoding="utf-8"))
                self.assertEqual(summary["exit"], 1)
                self.assertEqual(summary["totals"]["failed"], 1)
                self.assertEqual(summary["failures"], ["not ok 3 - checkout keeps the cart"])
                self.assertEqual(len(summary["sha256"]), 64)

    def test_a_hung_test_is_stopped_at_its_timeout(self):
        for folder in COPIES:
            with tempfile.TemporaryDirectory() as root:
                started = time.time()
                done = run(folder, "test-run.py", "--log", str(pathlib.Path(root, "slow.log")), "--timeout", "0.02", "--",
                           sys.executable, "-c", "import time; time.sleep(60)")
                self.assertEqual(done.returncode, 124)
                self.assertLess(time.time() - started, 20, "one bounded wait, not an open-ended one")
                self.assertIn("逾時", done.stdout)

    def test_totals_are_read_from_the_common_test_runners(self):
        spec = importlib.util.spec_from_file_location("test_run_module", COPIES[0] / "test-run.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.totals_of(["Ran 134 tests in 3.2s", "", "OK (skipped=2)"]), {"total": 134, "status": "OK", "skipped": 2})
        self.assertEqual(module.totals_of(["===== 2 failed, 10 passed, 1 skipped in 1.23s ====="]), {"failed": 2, "passed": 10, "skipped": 1})
        self.assertEqual(module.totals_of(["Tests:       1 failed, 12 passed, 13 total"]), {"failed": 1, "passed": 12, "total": 13})
        self.assertEqual(module.totals_of(["  10 passing (2s)", "  2 failing"]), {"passed": 10, "failed": 2})
        self.assertEqual(module.failures_of(["FAIL: test_cart (tests.CartTest)", "FAIL: test_cart (tests.CartTest)", "ok"], 40),
                         ["FAIL: test_cart (tests.CartTest)"], "a failure repeated in a traceback is listed once")

    def test_acceptance_map_catches_a_pass_without_evidence_and_evidence_changed_after_indexing(self):
        for folder in COPIES:
            with tempfile.TemporaryDirectory() as root:
                evidence = pathlib.Path(root, "evidence")
                evidence.mkdir()
                shot = evidence / "a.png"
                shot.write_bytes(b"png")
                index = pathlib.Path(root, "index.json")
                self.assertEqual(run(folder, "evidence-check.py", "index", str(evidence), "--out", str(index)).returncode, 0)
                self.assertEqual(json.loads(index.read_text(encoding="utf-8"))["count"], 1)
                snapshot = pathlib.Path(root, "dispatch.json")
                snapshot.write_text(json.dumps({"acceptance": {"items": [{"id": "A1", "status": "PASS", "evidence": [str(shot)]},
                                                                         {"id": "A2", "status": "PENDING", "evidence": []}]}}), encoding="utf-8")
                passed = run(folder, "evidence-check.py", "criteria", str(snapshot), "--index", str(index))
                self.assertEqual(passed.returncode, 0, passed.stdout)
                snapshot.write_text(json.dumps({"acceptance": {"items": [{"id": "A1", "status": "PASS", "evidence": []}]}}), encoding="utf-8")
                empty = run(folder, "evidence-check.py", "criteria", str(snapshot))
                self.assertEqual(empty.returncode, 1)
                self.assertIn("PASS 但沒有證據", empty.stdout)
                snapshot.write_text(json.dumps({"acceptance": {"items": [{"id": "A1", "status": "PASS", "evidence": [str(shot)]}]}}), encoding="utf-8")
                shot.write_bytes(b"changed after the index")
                changed = run(folder, "evidence-check.py", "criteria", str(snapshot), "--index", str(index))
                self.assertEqual(changed.returncode, 1)
                self.assertIn("索引後變動", changed.stdout)

    def test_a_readback_checks_status_and_expected_text_without_printing_the_body(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"secret-token-123 release 1.2.0 is live" if self.path == "/health" else b"missing"
                self.send_response(200 if self.path == "/health" else 404)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = "http://127.0.0.1:" + str(server.server_address[1])
            for folder in COPIES:
                ok = run(folder, "evidence-check.py", "readback", base + "/health", "--expect", "release 1.2.0", "--header", "Authorization: Bearer x")
                self.assertEqual(ok.returncode, 0, ok.stdout)
                self.assertIn("讀回 PASS｜HTTP 200", ok.stdout)
                self.assertNotIn("secret-token-123", ok.stdout, "the body is never printed")
                self.assertNotIn("Bearer", ok.stdout, "headers are never printed")
                missing = run(folder, "evidence-check.py", "readback", base + "/health", "--expect", "release 1.3.0")
                self.assertEqual(missing.returncode, 1)
                self.assertIn("缺預期文字", missing.stdout)
                gone = run(folder, "evidence-check.py", "readback", base + "/old")
                self.assertEqual(gone.returncode, 1)
                self.assertIn("HTTP 404", gone.stdout)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Run a test command, keep its full output in a log, print only the result, totals and failures.

Usage: test-run.py --log LOG [--timeout MINUTES] [--max-lines N] -- COMMAND [ARG...]

Jay 2026-11-09 asked where long tasks spend their time; checking took more of it than building, partly because
agents pasted whole test outputs into their context and polled long runs every few seconds. Here the full output
goes to LOG and LOG.summary.json keeps the one-line evidence (command, exit, duration, totals, failures, log hash);
the screen gets only that summary. The run is one wait bounded by --timeout: on expiry the whole process group is
stopped and the exit code is 124. Otherwise the exit code is the command's own.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time

TAP = re.compile(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$")
UNITTEST_RAN = re.compile(r"^Ran (\d+) tests? in ")
UNITTEST_END = re.compile(r"^(OK|FAILED)(?: \((.*)\))?\s*$")
PYTEST_END = re.compile(r"^=+ (.+) in [\d.]+s.*=+\s*$")
JEST_END = re.compile(r"^Tests:\s+(.*)$")
VITEST_END = re.compile(r"^\s*Tests\s+(.*\d.*)$")
COUNT_LINE = re.compile(r"^\s+(\d+) (passing|failing|pending|passed|failed|flaky|skipped)\b")
FAILURE = re.compile(r"^\s*(not ok \d+\b.*|(?:FAIL|ERROR): .*|FAILED .*|--- FAIL: .*|[✗✕×✘] .*|● .*|\d+\) .*)$")
NAMES = {"tests": "total", "pass": "passed", "fail": "failed", "failures": "failed", "error": "errors",
         "passing": "passed", "failing": "failed", "pending": "skipped", "expected failures": "xfailed"}


def totals_of(lines):
    found = {}
    for line in lines:
        match = TAP.match(line)
        if match:
            found[NAMES.get(match.group(1), match.group(1))] = int(match.group(2))
            continue
        match = UNITTEST_RAN.match(line)
        if match:
            found["total"] = int(match.group(1))
            continue
        match = UNITTEST_END.match(line)
        if match:
            found["status"] = match.group(1)
            for key, value in re.findall(r"([a-z ]+)=(\d+)", match.group(2) or ""):
                found[NAMES.get(key.strip(), key.strip())] = int(value)
            continue
        match = PYTEST_END.match(line) or JEST_END.match(line) or VITEST_END.match(line)
        if match:
            for value, key in re.findall(r"(\d+) (passed|failed|skipped|errors?|xfailed|xpassed|deselected|todo|total)\b", match.group(1)):
                found[NAMES.get(key, key)] = int(value)
            total = re.search(r"\((\d+)\)\s*$", match.group(1))
            if total:
                found["total"] = int(total.group(1))
            continue
        match = COUNT_LINE.match(line)
        if match:
            found[NAMES.get(match.group(2), match.group(2))] = int(match.group(1))
    return found


def failures_of(lines, limit):
    seen, picked = set(), []
    for line in lines:
        match = FAILURE.match(line)
        if not match:
            continue
        text = match.group(1).strip()[:200]
        if text in seen:
            continue
        seen.add(text)
        picked.append(text)
        if len(picked) >= limit:
            break
    return picked


def stop(process):
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            process.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run tests with the full output in a log and a short summary on screen.")
    parser.add_argument("--log", required=True, help="full output file (its folder is created)")
    parser.add_argument("--timeout", type=float, default=60.0, help="minutes before the run is stopped (exit 124)")
    parser.add_argument("--max-lines", type=int, default=40, help="failure lines shown on screen")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("give the test command after --")
    log = os.path.abspath(args.log)
    os.makedirs(os.path.dirname(log), exist_ok=True)
    started = time.time()
    timed_out = False
    with open(log, "wb") as output:
        try:
            process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as error:
            print("結果：無法啟動（" + str(error) + "）", file=sys.stderr)
            return 127
        try:
            process.wait(timeout=args.timeout * 60)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop(process)
        except KeyboardInterrupt:
            stop(process)
            raise
    seconds = round(time.time() - started, 1)
    code = 124 if timed_out else (process.returncode if process.returncode >= 0 else 128 - process.returncode)
    data = open(log, "rb").read()
    lines = data.decode("utf-8", errors="replace").splitlines()
    totals, failures = totals_of(lines), failures_of(lines, args.max_lines)
    digest = hashlib.sha256(data).hexdigest()
    summary = {"command": command, "cwd": os.getcwd(), "exit": code, "timedOut": timed_out, "seconds": seconds,
               "log": log, "sha256": digest, "lines": len(lines), "totals": totals, "failures": failures,
               "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with open(log + ".summary.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    state = ("逾時（超過 " + format(args.timeout, "g") + " 分鐘，已終止）") if timed_out else ("通過" if code == 0 else "失敗")
    print("結果：" + state + "（exit " + str(code) + "）｜耗時 " + str(seconds) + " 秒｜完整紀錄 " + log + "（" + str(len(lines)) + " 行，sha256 " + digest[:16] + "…）")
    if totals:
        print("總數：" + "、".join(key + " " + str(value) for key, value in totals.items()))
    if failures and code != 0:
        print("失敗（最多 " + str(args.max_lines) + " 行，完整內容見紀錄）：")
        for line in failures:
            print("- " + line)
    elif code != 0 and not timed_out:
        print("沒有可辨識的失敗行；最後幾行：")
        for line in lines[-5:]:
            print("  " + line[:200])
    return code


if __name__ == "__main__":
    sys.exit(main())

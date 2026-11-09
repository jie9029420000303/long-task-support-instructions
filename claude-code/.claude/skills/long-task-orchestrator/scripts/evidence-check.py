#!/usr/bin/env python3
"""Fixed evidence checks: file hashes, an evidence index, a readback and the acceptance-to-evidence map.

Jay 2026-11-09 asked where long tasks spend their time; checking took more of it than building, and agents kept
writing one-off scripts for these same four checks. Commands:

  hash PATH...                     sha256 and size of each file (folders are walked)
  index DIR --out INDEX.json       every file under DIR with size, sha256 and mtime; prints the index hash
  readback TARGET [--expect TEXT]... [--sha256 HEX] [--header "Name: value"]... [--timeout S] [--out FILE]
                                   TARGET is an http(s) URL or a file; checks the status, expected texts and hash
  criteria SNAPSHOT.json [--index INDEX.json]
                                   each acceptance item with its status and evidence; a PASS without evidence,
                                   missing evidence or evidence changed since the index is a problem

Exit 0 when every check passes, 1 when one fails, 2 on a usage error. Bodies and headers are never printed.
"""
import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk(root):
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name != ".git")
        for name in sorted(files):
            yield os.path.join(folder, name)


def command_hash(args):
    missing = 0
    for target in args.paths:
        paths = list(walk(target)) if os.path.isdir(target) else [target]
        for path in paths:
            if not os.path.isfile(path):
                print("找不到  " + path)
                missing += 1
                continue
            print(sha256_of(path) + "  " + str(os.path.getsize(path)) + "  " + os.path.abspath(path))
    return 1 if missing else 0


def command_index(args):
    root, out = os.path.abspath(args.dir), os.path.abspath(args.out)
    if not os.path.isdir(root):
        print("不是資料夾：" + root)
        return 2
    files = []
    for path in walk(root):
        if os.path.abspath(path) == out:
            continue
        stat = os.stat(path)
        files.append({"path": os.path.relpath(path, root), "size": stat.st_size, "sha256": sha256_of(path),
                      "mtime": datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc).isoformat()})
    body = {"root": root, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "count": len(files), "files": files}
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(body, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("已索引 " + str(len(files)) + " 個檔案（共 " + str(sum(item["size"] for item in files)) + " bytes）→ " + out + "（sha256 " + sha256_of(out)[:16] + "…）")
    return 0


def command_readback(args):
    status = None
    if args.target.startswith(("http://", "https://")):
        headers = {}
        for header in args.header or []:
            name, _, value = header.partition(":")
            headers[name.strip()] = value.strip()
        request = urllib.request.Request(args.target, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                status, body = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read()
        except (urllib.error.URLError, OSError) as error:
            print("讀回 FAIL｜連不到：" + str(getattr(error, "reason", error))[:200])
            return 1
    else:
        if not os.path.isfile(args.target):
            print("讀回 FAIL｜找不到檔案：" + args.target)
            return 1
        body = open(args.target, "rb").read()
    if args.out:
        with open(args.out, "wb") as handle:
            handle.write(body)
    text = body.decode("utf-8", errors="replace")
    expected = args.expect or []
    missing = [item for item in expected if item not in text]
    digest = hashlib.sha256(body).hexdigest()
    problems = []
    if status is not None and not 200 <= status < 300:
        problems.append("HTTP " + str(status))
    if missing:
        problems.append("缺預期文字：" + "；".join(item[:60] for item in missing))
    if args.sha256 and args.sha256.lower() != digest:
        problems.append("雜湊不符")
    print("讀回 " + ("FAIL" if problems else "PASS") + ("｜HTTP " + str(status) if status is not None else "｜檔案") + "｜" + str(len(body)) +
          " bytes｜sha256 " + digest[:16] + "…｜預期文字 " + str(len(expected) - len(missing)) + "/" + str(len(expected)) +
          ("｜" + "｜".join(problems) if problems else ""))
    return 1 if problems else 0


def evidence_paths(item):
    paths = []
    for entry in item.get("evidence") or []:
        value = entry.get("path") if isinstance(entry, dict) else entry
        if isinstance(value, str) and value.strip():
            paths.append(value.strip())
    return paths


def command_criteria(args):
    try:
        data = json.load(open(args.snapshot, encoding="utf-8"))
    except (OSError, ValueError) as error:
        print("讀不到驗收來源：" + str(error))
        return 2
    items = (data.get("acceptance") or {}).get("items") if isinstance(data.get("acceptance"), dict) else None
    items = items if items is not None else data.get("items")
    if not isinstance(items, list):
        print("找不到 acceptance.items 或 items")
        return 2
    indexed = {}
    if args.index:
        index = json.load(open(args.index, encoding="utf-8"))
        indexed = {os.path.join(index["root"], item["path"]): item["sha256"] for item in index.get("files", [])}
    problems, passed = 0, 0
    for item in items:
        key, status, paths = str(item.get("id")), str(item.get("status")), evidence_paths(item)
        notes = []
        if status == "PASS":
            passed += 1
            if not paths:
                notes.append("PASS 但沒有證據")
        for path in paths:
            if not os.path.isabs(path):
                continue
            if not os.path.exists(path):
                notes.append("證據不在：" + path)
            elif path in indexed and os.path.isfile(path) and sha256_of(path) != indexed[path]:
                notes.append("索引後變動：" + path)
        problems += 1 if notes else 0
        print(key + "｜" + status + "｜證據 " + str(len(paths)) + (("｜" + "；".join(notes)) if notes else ""))
    print("驗收 " + str(len(items)) + " 條：PASS " + str(passed) + "、其他 " + str(len(items) - passed) + "；有問題 " + str(problems) + " 條")
    return 1 if problems else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fixed evidence checks.")
    commands = parser.add_subparsers(dest="command", required=True)
    hashed = commands.add_parser("hash")
    hashed.add_argument("paths", nargs="+")
    indexed = commands.add_parser("index")
    indexed.add_argument("dir")
    indexed.add_argument("--out", required=True)
    readback = commands.add_parser("readback")
    readback.add_argument("target")
    readback.add_argument("--expect", action="append")
    readback.add_argument("--sha256")
    readback.add_argument("--header", action="append")
    readback.add_argument("--timeout", type=float, default=30)
    readback.add_argument("--out")
    criteria = commands.add_parser("criteria")
    criteria.add_argument("snapshot")
    criteria.add_argument("--index")
    args = parser.parse_args(argv)
    return {"hash": command_hash, "index": command_index, "readback": command_readback, "criteria": command_criteria}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

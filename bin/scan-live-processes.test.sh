#!/usr/bin/env bash
# Protected contract: diagnostics report all occupants; --foreign-only excludes
# only proven same-session descendants of this caller's in-target ancestor.
# A tool cwd outside the target must not turn its own parent into a blocker.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
python3 - "$here/scan-live-processes.sh" <<'PY'
import json
import os
import pathlib
import subprocess
import sys
import tempfile

scanner = pathlib.Path(sys.argv[1]).resolve()
actor_code = r'''
import json, os, pathlib, subprocess, sys
scanner, target, outside, foreign_json, detached_flag = sys.argv[1:]
foreign = set(json.loads(foreign_json))
owned = []
try:
    same = subprocess.Popen(["sleep", "60"])
    owned.append(same)
    if detached_flag == "yes":
        detached = subprocess.Popen(["sleep", "60"], start_new_session=True)
        owned.append(detached)
        foreign.add(detached.pid)
    def scan(*args):
        result = subprocess.run(["bash", scanner, target, *args], cwd=outside,
                                capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        return {int(line.split()[0]) for line in result.stdout.splitlines()}
    diagnostic = scan()
    filtered = scan("--foreign-only")
    assert {os.getpid(), same.pid} <= diagnostic, diagnostic
    assert foreign <= diagnostic, (foreign, diagnostic)
    assert filtered == foreign, (foreign, filtered)
    print(json.dumps({"default_own_present": True, "foreign_pids_preserved": len(foreign)}))
finally:
    for child in owned:
        child.terminate()
        child.wait(timeout=5)
'''

with tempfile.TemporaryDirectory(prefix="repo-scanner-proof-") as temporary:
    root = pathlib.Path(temporary)
    target = root / "target"
    target.mkdir()
    actor = root / "actor.py"
    actor.write_text(actor_code)
    cases = (
        ("own-parent-and-child", False, False, False),
        ("unrelated-same-session-nonancestor", True, False, False),
        ("unrelated-different-session", False, True, False),
        ("detached-own-descendant", False, False, True),
    )
    for label, same_session, different_session, detached in cases:
        occupants = []
        try:
            if same_session:
                occupants.append(subprocess.Popen(["sleep", "60"], cwd=target))
            if different_session:
                occupants.append(subprocess.Popen(["sleep", "60"], cwd=target,
                                                  start_new_session=True))
            result = subprocess.run(
                [sys.executable, str(actor), str(scanner), str(target), str(root),
                 json.dumps([p.pid for p in occupants]), "yes" if detached else "no"],
                cwd=target, capture_output=True, text=True, timeout=40,
            )
            assert result.returncode == 0, (label, result.stderr)
            summary = json.loads(result.stdout)
            assert summary["default_own_present"]
            print(label + ": ok")
        finally:
            for occupant in occupants:
                occupant.terminate()
                occupant.wait(timeout=5)

    # Isolate only /proc and a precise post-snapshot mutation point in copies;
    # production has no override capable of hiding native occupants.
    source = scanner.read_text()
    assert source.count("readonly PROC_ROOT=/proc") == 1
    assert source.count("\nfound=0\n") == 1
    def stat_record(pid, parent, session, generation):
        return " ".join([str(pid), "(fixture)", "S", str(parent), "123", str(session)]
                        + ["0"] * 15 + [str(generation)])
    def overwrite_record(record):
        return ("printf '%s\\n' " + chr(34) + stat_record(*record) + chr(34)
                + " > " + chr(34) + "$PROC_ROOT/" + str(record[0]) + "/stat" + chr(34))
    for fault in ("stable", "unknown", "candidate-generation", "ancestor-generation",
                  "candidate-parent", "candidate-session", "missing-metadata", "self-generation"):
        proc = root / ("proc-" + fault)
        proc.mkdir()
        candidate = proc / "999999999"
        candidate.mkdir()
        (candidate / "cwd").symlink_to(target, target_is_directory=True)
        marker = "synthetic-sensitive-argv-marker"
        (candidate / "cmdline").write_bytes(marker.encode() + b"\0")
        (candidate / "comm").write_text("fixture-candidate\n")
        changed = None
        mutation = ""
        if fault == "candidate-generation":
            changed = (999999999, "$$", 123, 201)
        elif fault == "ancestor-generation":
            ancestor = proc / "888888888"
            ancestor.mkdir()
            (ancestor / "cwd").symlink_to(target, target_is_directory=True)
            (ancestor / "cmdline").write_bytes(b"synthetic-ancestor\0")
            (ancestor / "comm").write_text("fixture-ancestor\n")
            (ancestor / "stat").write_text(stat_record(888888888, 1, 123, 333) + "\n")
            changed = (888888888, 1, 123, 334)
        elif fault == "candidate-parent":
            changed = (999999999, 1, 123, 200)
        elif fault == "candidate-session":
            changed = (999999999, "$$", 124, 200)
        elif fault == "self-generation":
            changed = ("$$", 1, 123, 112)
        elif fault == "missing-metadata":
            mutation = 'rm -- "$PROC_ROOT/999999999/stat"'
        if changed:
            mutation = overwrite_record(changed)
        subject = root / ("scanner-" + fault + ".sh")
        copy = source.replace("readonly PROC_ROOT=/proc", "readonly PROC_ROOT=" + str(proc))
        if mutation:
            copy = copy.replace("\nfound=0\n", "\n" + mutation + "\nfound=0\n")
        subject.write_text(copy)
        pid_file = root / ("pid-" + fault)
        wrapper = r'''
mkdir "$1/$$"
printf '%s\n' "OWN_STAT" > "$1/$$/stat"
ln -s "$2" "$1/$$/cwd"
printf 'synthetic-own\0' > "$1/$$/cmdline"
printf 'fixture-own\n' > "$1/$$/comm"
printf '%s\n' "CHILD_STAT" > "$1/999999999/stat"
printf '%s\n' "$$" > "$4"
exec bash "$3" "$2" --foreign-only
'''
        parent = 888888888 if fault == "ancestor-generation" else 1
        candidate_parent = 888888888 if fault == "ancestor-generation" else "$$"
        wrapper = wrapper.replace("OWN_STAT", stat_record("$$", parent, 123, 111))
        wrapper = wrapper.replace("CHILD_STAT", "malformed" if fault == "unknown"
                                  else stat_record(999999999, candidate_parent, 123, 200))
        result = subprocess.run(["bash", "-c", wrapper, "fixture", str(proc), str(target),
                                 str(subject), str(pid_file)], cwd=root,
                                capture_output=True, text=True, timeout=5)
        own_pid = pid_file.read_text().strip()
        if changed:
            changed_pid = str(changed[0]).replace("$$", own_pid)
            expected_record = stat_record(*changed).replace("$$", own_pid) + "\n"
            assert (proc / changed_pid / "stat").read_text() == expected_record
        assert marker not in result.stdout
        if fault == "self-generation":
            assert result.returncode == 75 and "caller identity is unverified" in result.stderr
            print("changed-caller-identity-refused: ok")
            continue
        assert result.returncode == 0, (fault, result.stderr)
        expected = set() if fault == "stable" else {999999999}
        if fault == "ancestor-generation":
            expected.update({int(own_pid), 888888888})
        actual = {int(line.split()[0]) for line in result.stdout.splitlines()}
        assert actual == expected, (fault, actual, expected)
        if expected:
            assert "fixture-candidate" in result.stdout
        print(fault + "-metadata-classified: ok")
        if fault == "unknown":
            diagnostic = subprocess.run(["bash", str(subject), str(target)], cwd=root,
                                        capture_output=True, text=True, timeout=5)
            assert diagnostic.returncode == 0 and marker in diagnostic.stdout
            print("filtered-comm-only-default-argv-preserved: ok")
    for fault in ("empty", "missing-self"):
        proc = root / ("proc-" + fault)
        proc.mkdir()
        if fault == "missing-self":
            occupant = proc / "999999999"
            occupant.mkdir()
            (occupant / "cwd").symlink_to(target, target_is_directory=True)
            (occupant / "stat").write_text(stat_record(999999999, 1, 123, 1) + "\n")
        subject = root / ("scanner-" + fault + ".sh")
        subject.write_text(source.replace("readonly PROC_ROOT=/proc", "readonly PROC_ROOT=" + str(proc)))
        result = subprocess.run(["bash", str(subject), str(target), "--foreign-only"],
                                cwd=root, capture_output=True, text=True, timeout=5)
        assert result.returncode == 75 and result.stdout == "", (fault, result)
        assert result.stderr == "foreign process classification unavailable: caller identity is unverified\n"
        print(fault + "-process-view-refused: ok")
print("repo-scan-live-processes: ok")
PY

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
    for fault in ("unknown", "candidate-generation", "ancestor-generation",
                  "candidate-parent", "candidate-session", "missing-metadata"):
        proc = root / ("proc-" + fault)
        proc.mkdir()
        candidate = proc / "999999999"
        candidate.mkdir()
        (candidate / "cwd").symlink_to(target, target_is_directory=True)
        marker = "synthetic-sensitive-argv-marker"
        (candidate / "cmdline").write_bytes(marker.encode() + b"\0")
        (candidate / "comm").write_text("fixture-candidate\n")
        mutation = ""
        if fault == "candidate-generation":
            mutation = "printf '%s\\n' \"" + stat_record(999999999, "$$", 123, 201) + "\" > \"$PROC_ROOT/999999999/stat\""
        elif fault == "ancestor-generation":
            mutation = "printf '%s\\n' \"" + stat_record("$$", 1, 123, 112) + "\" > \"$PROC_ROOT/$$/stat\""
        elif fault == "candidate-parent":
            mutation = "printf '%s\\n' \"" + stat_record(999999999, 1, 123, 200) + "\" > \"$PROC_ROOT/999999999/stat\""
        elif fault == "candidate-session":
            mutation = "printf '%s\\n' \"" + stat_record(999999999, "$$", 124, 200) + "\" > \"$PROC_ROOT/999999999/stat\""
        elif fault == "missing-metadata":
            mutation = 'rm -- "$PROC_ROOT/999999999/stat"'
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
        wrapper = wrapper.replace("OWN_STAT", stat_record("$$", 1, 123, 111))
        wrapper = wrapper.replace("CHILD_STAT", "malformed" if fault == "unknown"
                                  else stat_record(999999999, "$$", 123, 200))
        result = subprocess.run(["bash", "-c", wrapper, "fixture", str(proc), str(target),
                                 str(subject), str(pid_file)], cwd=root,
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 0, (fault, result.stderr)
        assert marker not in result.stdout and "fixture-candidate" in result.stdout
        expected = {999999999}
        if fault == "ancestor-generation":
            expected.add(int(pid_file.read_text()))
        actual = {int(line.split()[0]) for line in result.stdout.splitlines()}
        assert actual == expected, (fault, actual, expected)
        print(fault + "-metadata-stays-foreign: ok")
        if fault == "unknown":
            diagnostic = subprocess.run(["bash", str(subject), str(target)], cwd=root,
                                        capture_output=True, text=True, timeout=5)
            assert diagnostic.returncode == 0 and marker in diagnostic.stdout
            print("filtered-comm-only-default-argv-preserved: ok")
print("repo-scan-live-processes: ok")
PY

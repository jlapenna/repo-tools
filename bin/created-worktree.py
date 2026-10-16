#!/usr/bin/env python3
"""Private, verified snapshots for explicitly authorized creation-age retirement.

The consumer's resource hook owns its lock; safe-remove-worktree invokes verify
inside that lock. This module never removes a checkout or bypasses occupancy.
"""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


ENV = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
HERE = Path(__file__).resolve().parent
OPERATIONS = ("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE",
              "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply",
              "rebase-merge", "sequencer", "BISECT_LOG", "index.lock", "HEAD.lock", "SQUASH_MSG")
CACHES = {"node_modules", ".nx", ".next", ".venv", "__pycache__", ".turbo"}
PREPARED_ARCHIVE = None


class Refusal(Exception):
    pass


def git(path, *args, env=None, data=None):
    result = subprocess.run(["git", "-C", str(path), *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env or ENV, check=False)
    if result.returncode:
        raise Refusal("git-state-unverifiable")
    return result.stdout


def text(path, *args):
    return git(path, *args).decode().strip()


@contextmanager
def regular_file(path, dir_fd=None):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise Refusal("snapshot-input-is-not-regular-file")
        yield stream
        after = os.fstat(stream.fileno())
        current = os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
        fields = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if fields(before) != fields(after) or fields(after) != fields(current):
            raise Refusal("snapshot-input-changed-while-reading")


@contextmanager
def entry(root, relative):
    # Anchor every descendant lookup to open directories. A renamed directory
    # or replacement symlink cannot redirect a read outside the checkout.
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = Path(relative).parts
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        name = parts[-1] if parts else "."
        yield descriptor, name, os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    finally:
        os.close(descriptor)


def digest(path, dir_fd=None):
    value = hashlib.sha256()
    with regular_file(path, dir_fd) as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def copy_regular(source_path, destination):
    # In particular the source index may be replaced by an editor between
    # admission and capture. Never follow a replacement link or FIFO.
    with regular_file(source_path) as incoming:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)


def creation(path, hours):
    link = path / ".git"
    info = link.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise Refusal("creation-evidence-not-regular-gitfile")
    result = subprocess.run(["stat", "-c", "%W", "--", str(link)],
                            capture_output=True, text=True, check=False)
    try:
        birth = int(result.stdout.strip())
    except ValueError:
        birth = 0
    now = time.time()
    if result.returncode or birth <= 0 or birth > now:
        raise Refusal("creation-age-unknown")
    if now - birth < hours * 3600:
        raise Refusal("creation-age-younger-than-window")
    return {"birth": birth, "device": info.st_dev, "inode": info.st_ino,
            "gitfile_sha256": digest(link)}


def source(path, hours, occupancy=True):
    if hours <= 0:
        raise Refusal("positive-creation-window-required")
    identity = creation(path, hours)
    common = text(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    admin = Path(text(path, "rev-parse", "--absolute-git-dir"))
    records = text(path, "worktree", "list", "--porcelain")
    paths = [line[9:] for line in records.splitlines() if line.startswith("worktree ")]
    if not paths or str(path) == paths[0] or str(path) not in paths:
        raise Refusal("not-a-registered-linked-checkout")
    if any(p.startswith(str(path) + "/") for p in paths):
        raise Refusal("nested-worktree")
    # An independent nested primary is not in this common directory's records.
    # Its ownership remains separate even when it is ignored locally.
    def unreadable(_error):
        raise Refusal("nested-repository-evidence-unavailable")
    for folder, directories, filenames in os.walk(path, followlinks=False, onerror=unreadable):
        if Path(folder) != path and (".git" in directories or ".git" in filenames):
            raise Refusal("nested-independent-git-checkout")
    if (admin / "locked").exists():
        raise Refusal("locked")
    if any((admin / name).exists() for name in OPERATIONS):
        raise Refusal("operation-state-needs-independent-recovery")
    sparse = Path(text(path, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"))
    if os.path.lexists(admin / "info/sparse-checkout") or os.path.lexists(sparse):
        raise Refusal("sparse-checkout-needs-independent-recovery")
    if os.path.lexists(admin / "config.worktree"):
        raise Refusal("worktree-config-needs-independent-recovery")
    if text(path, "rev-parse", "--shared-index-path"):
        raise Refusal("split-index-needs-independent-recovery")
    entries = git(path, "ls-files", "--sparse", "--stage", "-z").split(b"\0")
    objects = []
    for entry in entries:
        if not entry:
            continue
        mode, oid, stage = entry.split(b"\t", 1)[0].split()
        if stage != b"0" or mode == b"040000":
            raise Refusal("unmerged-or-sparse-index")
        if mode != b"160000":
            objects.append(oid.decode())
    submodules = git(path, "submodule", "status", "--recursive").splitlines()
    if any(line and line[:1] != b"-" for line in submodules):
        raise Refusal("initialized-submodule")
    if occupancy:
        if not Path("/proc/self/stat").is_file():
            raise Refusal("linux-process-evidence-required")
        occupants = subprocess.run([str(HERE / "scan-live-processes.sh"), str(path), "--foreign-only"],
                                   capture_output=True, env=ENV)
        if occupants.returncode:
            raise Refusal("live-process-evidence-unavailable")
        if occupants.stdout.strip():
            raise Refusal("foreign-live-process-cwd")
    index = admin / "index"
    if not index.is_file() or index.is_symlink():
        raise Refusal("index-unavailable")
    return {"identity": identity, "common": common, "primary": paths[0],
            "head": text(path, "rev-parse", "HEAD"),
            "branch": subprocess.run(["git", "-C", str(path), "symbolic-ref", "-q", "--short", "HEAD"],
                                      capture_output=True, text=True, env=ENV).stdout.strip(),
            "index_path": str(index), "index_sha256": digest(index),
            "objects": sorted(set(objects))}


def exclusions(path):
    result = []
    for raw in git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z").split(b"\0"):
        if not raw:
            continue
        name = os.fsdecode(raw).rstrip("/")
        candidate = path / name
        if candidate.name not in CACHES or not candidate.is_dir() or candidate.is_symlink():
            continue
        ignored = subprocess.run(["git", "-C", str(path), "check-ignore", "-q", "--", name], env=ENV)
        if ignored.returncode == 0 and not git(path, "ls-files", "--", name):
            result.append(name)
    return sorted(result)


def inventory(path, excluded):
    entries = {}

    def walk(relative):
        with entry(path, relative) as (parent, leaf, info):
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                entries[relative] = ["link", mode, os.readlink(leaf, dir_fd=parent)]
            elif stat.S_ISDIR(info.st_mode):
                entries[relative] = ["directory", mode]
                descriptor = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    children = sorted(os.listdir(descriptor))
                finally:
                    os.close(descriptor)
                for child in children:
                    name = str(Path(relative) / child)
                    if name == ".git" or any(name == x or name.startswith(x + "/") for x in excluded):
                        continue
                    walk(name)
            elif stat.S_ISREG(info.st_mode):
                entries[relative] = ["file", mode, info.st_size, digest(leaf, parent)]
            else:
                raise Refusal("special-file-needs-independent-recovery")

    walk("")
    return entries


def write_archive(path, destination, files):
    inodes = {}
    with tarfile.open(destination, "w:gz", dereference=False) as packed:
        for relative in files:
            with entry(path, relative) as (parent, leaf, info):
                member = tarfile.TarInfo(relative or ".")
                member.mode = stat.S_IMODE(info.st_mode)
                member.uid, member.gid, member.mtime = info.st_uid, info.st_gid, info.st_mtime
                if stat.S_ISREG(info.st_mode):
                    key = (info.st_dev, info.st_ino)
                    if info.st_nlink > 1 and key in inodes:
                        member.type, member.linkname = tarfile.LNKTYPE, inodes[key]
                        packed.addfile(member)
                    else:
                        member.size = info.st_size
                        with regular_file(leaf, parent) as stream:
                            packed.addfile(member, stream)
                        inodes[key] = relative
                elif stat.S_ISDIR(info.st_mode):
                    member.type = tarfile.DIRTYPE
                    packed.addfile(member)
                elif stat.S_ISLNK(info.st_mode):
                    member.type, member.linkname = tarfile.SYMTYPE, os.readlink(leaf, dir_fd=parent)
                    packed.addfile(member)
                else:
                    raise Refusal("special-file-appeared-during-snapshot")


def archive_inventory(packed):
    entries = {}
    links = []
    with tarfile.open(packed, "r:gz") as archive:
        for member in archive:
            name = member.name.removeprefix("./").rstrip("/")
            if name == ".":
                name = ""
            if name.startswith("/") or ".." in Path(name).parts or name == ".git" or name.startswith(".git/"):
                raise Refusal("unsafe-archive-member")
            if name in entries:
                raise Refusal("duplicate-archive-member")
            if member.isdir():
                entries[name] = ["directory", member.mode]
            elif member.issym():
                entries[name] = ["link", member.mode, member.linkname]
            elif member.isreg():
                stream = archive.extractfile(member)
                value = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    value.update(block)
                entries[name] = ["file", member.mode, member.size, value.hexdigest()]
            elif member.islnk():
                links.append((name, member.linkname.removeprefix("./"), member.mode))
                entries[name] = None
            else:
                raise Refusal("unsupported-archive-member")
    for name, target, mode in links:
        if target not in entries or not entries[target] or entries[target][0] != "file":
            raise Refusal("unsafe-archive-hardlink")
        entries[name] = ["file", mode, *entries[target][2:]]
    for name in entries:
        for parent in Path(name).parents:
            if str(parent) != "." and entries.get(str(parent), [None])[0] == "link":
                raise Refusal("archive-member-under-symlink")
    return entries


def private_archive(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise Refusal("archive-not-private-owned-directory")
    for child in path.iterdir():
        value = child.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o077:
            raise Refusal("archive-file-not-private")


def load_archive(path):
    private_archive(path)
    manifest = json.loads((path / "manifest.json").read_text())
    if manifest.get("version") != 2 or manifest.get("state") not in ("prepared", "parked"):
        raise Refusal("unsupported-archive-manifest")
    expected_files = {"files.tar.gz", "inventory.json", "index", "staged.pack", "staged.idx"}
    if set(manifest["checksums"]) != expected_files:
        raise Refusal("incomplete-archive-checksums")
    for name, expected in manifest["checksums"].items():
        if digest(path / name) != expected:
            raise Refusal("archive-checksum-mismatch")
    primary = manifest["source"]["primary"]
    if text(primary, "rev-parse", manifest["ref"]) != manifest["source"]["head"]:
        raise Refusal("protected-head-ref-changed")
    if text(primary, "rev-parse", manifest["index_ref"]) != manifest["index_tree"]:
        raise Refusal("protected-index-ref-changed")
    return manifest


def verify(archive, path, occupancy=True):
    manifest = load_archive(archive)
    if str(path) != manifest["path"]:
        raise Refusal("snapshot-target-mismatch")
    actual = source(path, manifest["created_hours"], occupancy)
    if actual != manifest["source"]:
        raise Refusal("git-or-index-snapshot-changed")
    expected = json.loads((archive / "inventory.json").read_text())
    if inventory(path, manifest["excluded_caches"]) != expected:
        raise Refusal("retained-files-or-path-set-changed")
    return manifest


def prepare(path, expected, hours):
    global PREPARED_ARCHIVE
    before = source(path, hours)
    if before["head"] != expected:
        raise Refusal("head-changed")
    root = Path(before["common"]) / "parked-worktrees"
    if root.is_symlink():
        raise Refusal("archive-root-is-symlink")
    root.mkdir(mode=0o700, exist_ok=True)
    if root.stat().st_uid != os.getuid():
        raise Refusal("archive-root-not-owned")
    root.chmod(0o700)
    archive = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%dT%H%M%SZ-", time.gmtime()), dir=root))
    PREPARED_ARCHIVE = archive
    archive.chmod(0o700)
    copy_regular(before["index_path"], archive / "index")
    if digest(archive / "index") != before["index_sha256"]:
        raise Refusal("index-changed-during-copy")
    copied = archive / "index.for-tree"
    copy_regular(archive / "index", copied)
    tree = git(path, "write-tree", env=dict(ENV, GIT_INDEX_FILE=str(copied))).decode().strip()
    copied.unlink()
    ref = "refs/parked-worktrees/" + archive.name
    index_ref = ref + "-index"
    git(path, "update-ref", ref, expected, "")
    git(path, "update-ref", index_ref, tree, "")
    with open(archive / "staged.pack", "wb") as stream:
        subprocess.run(["git", "-C", str(path), "pack-objects", "--revs", "--stdout"],
                       # HEAD history has its own protected ref. Store every
                       # staged object absent from that history independently,
                       # without duplicating unchanged committed payloads.
                       input=("\n".join([tree, *before["objects"], "^" + expected]) + "\n").encode(),
                       stdout=stream, stderr=subprocess.PIPE, env=ENV, check=True)
    git(path, "index-pack", "--strict", str(archive / "staged.pack"))
    excluded = exclusions(path)
    files = inventory(path, excluded)
    (archive / "inventory.json").write_text(json.dumps(files, sort_keys=True))
    write_archive(path, archive / "files.tar.gz", files)
    if archive_inventory(archive / "files.tar.gz") != files:
        raise Refusal("archive-does-not-match-working-snapshot")
    checksums = {name: digest(archive / name) for name in
                 ("files.tar.gz", "inventory.json", "index", "staged.pack", "staged.idx")}
    manifest = {"version": 2, "state": "prepared", "path": str(path), "source": before,
                "created_hours": hours, "excluded_caches": excluded, "ref": ref,
                "index_ref": index_ref, "index_tree": tree, "checksums": checksums}
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (archive / "restore.sh").write_text("repo-restore-worktree " + shlex.quote(str(archive)) + "\n")
    for child in archive.iterdir():
        child.chmod(0o600)
    verify(archive, path)
    return archive, manifest


def retire(path, expected, hook, hours):
    archive, manifest = prepare(path, expected, hours)
    guard = archive / "remove-snapshot.sh"
    guard.write_text("#!/usr/bin/env bash\nset -euo pipefail\nexec " +
                     shlex.quote(str(HERE / "safe-remove-worktree.sh")) +
                     ' "$@" --verified-snapshot ' + shlex.quote(str(archive)) + "\n")
    guard.chmod(0o700)
    command = [hook, str(path), str(guard)] if hook else [str(guard), str(path)]
    result = subprocess.run(command, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Discard a refused preparation only if every original file and the
        # independent index are still exact. Partial/changed states keep recovery.
        if result.returncode == 75 and path.is_dir() and (path / ".git").is_file():
            try:
                verify(archive, path, occupancy=False)
                git(path, "update-ref", "-d", manifest["ref"], expected)
                git(path, "update-ref", "-d", manifest["index_ref"], manifest["index_tree"])
                shutil.rmtree(archive)
            except (Refusal, OSError):
                print("Recovery archive retained: " + str(archive), file=sys.stderr)
        else:
            print("Recovery archive retained: " + str(archive), file=sys.stderr)
        sys.stderr.buffer.write(result.stderr)
        return 75 if path.exists() else 1
    if path.exists():
        raise Refusal("remover-left-checkout-present")
    manifest["state"] = "parked"
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(archive)
    return 0


def restore(archive, target):
    manifest = load_archive(archive)
    info = manifest["source"]
    path = Path(target or manifest["path"]).absolute()
    if path.exists() or path.is_symlink():
        raise Refusal("restore-path-already-exists")
    if text(info["primary"], "rev-parse", "--path-format=absolute", "--git-common-dir") != info["common"]:
        raise Refusal("owning-repository-changed")
    expected = json.loads((archive / "inventory.json").read_text())
    if archive_inventory(archive / "files.tar.gz") != expected:
        raise Refusal("archive-inventory-mismatch")
    # Import the independent staged object pack before installing its index.
    with open(archive / "staged.pack", "rb") as stream:
        subprocess.run(["git", "-C", info["primary"], "index-pack", "--stdin", "--strict"],
                       stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, check=True)
    branch = info["branch"]
    branch_head = subprocess.run(["git", "-C", info["primary"], "rev-parse", "--verify", "refs/heads/" + branch],
                                 capture_output=True, text=True, env=ENV).stdout.strip() if branch else ""
    records = text(info["primary"], "worktree", "list", "--porcelain")
    if branch and branch_head == info["head"] and "branch refs/heads/" + branch not in records.splitlines():
        git(info["primary"], "worktree", "add", "--no-checkout", "--", str(path), branch)
    else:
        git(info["primary"], "worktree", "add", "--no-checkout", "--detach", "--", str(path), manifest["ref"])
    # New checkout is empty except its Git link. Extraction cannot resurrect
    # tracked deletions, unlike overlaying an automatically checked-out HEAD.
    subprocess.run(["tar", "-xzf", str(archive / "files.tar.gz"), "--no-same-owner", "--same-permissions", "-C", str(path)], check=True)
    index = Path(text(path, "rev-parse", "--path-format=absolute", "--git-path", "index"))
    copy_regular(archive / "index", index)
    if digest(index) != info["index_sha256"] or inventory(path, manifest["excluded_caches"]) != expected:
        raise Refusal("restored-snapshot-verification-failed-recovery-retained")
    print("RESTORED\t" + str(path) + "\t" + info["head"])
    print("Reinstall omitted dependencies/caches with the repository setup command.", file=sys.stderr)
    return 0


def main():
    os.umask(0o077)
    command, *args = sys.argv[1:]
    if command == "eligible":
        source(Path(args[0]).absolute(), int(args[1]))
        print("parkable:created-age")
        return 0
    if command == "retire":
        return retire(Path(args[0]).absolute(), args[1], args[2], int(args[3]))
    if command == "verify":
        verify(Path(args[0]).absolute(), Path(args[1]).absolute())
        return 0
    if command == "restore":
        return restore(Path(args[0]).absolute(), args[1] if len(args) > 1 else "")
    raise Refusal("unknown-snapshot-operation")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        if PREPARED_ARCHIVE is not None:
            print("Recovery archive retained: " + str(PREPARED_ARCHIVE), file=sys.stderr)
        print("retirement-refused: " + str(error), file=sys.stderr)
        sys.exit(75)

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


def identity_config(path):
    """Only inert author identity settings have a portable recovery contract."""
    with regular_file(path) as stream:
        info = os.fstat(stream.fileno())
        if (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & ~0o664
                or not info.st_mode & 0o400
                or (info.st_mode & 0o020 and info.st_gid != os.getgid())):
            raise Refusal("worktree-config-needs-independent-recovery")
        data = stream.read(65537)
    if len(data) > 65536:
        raise Refusal("worktree-config-needs-independent-recovery")
    parsed = subprocess.run(["git", "config", "--no-includes", "--file", "-", "--null", "--list"],
                            input=data, capture_output=True, env=ENV)
    if parsed.returncode:
        raise Refusal("worktree-config-needs-independent-recovery")
    for record in parsed.stdout.split(b"\0"):
        if record and record.split(b"\n", 1)[0].lower() not in (b"user.name", b"user.email"):
            raise Refusal("worktree-config-needs-independent-recovery")
    return {"sha256": hashlib.sha256(data).hexdigest(), "mode": stat.S_IMODE(info.st_mode),
            "group_write_gid": info.st_gid if info.st_mode & 0o020 else None}


MERGE_FILES = {"MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "ORIG_HEAD", "MERGE_RR"}
MERGE_REQUIRED = {"MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"}


def merge_control(path):
    with regular_file(path) as stream:
        info = os.fstat(stream.fileno())
        mode = stat.S_IMODE(info.st_mode)
        if (info.st_uid != os.getuid() or mode & ~0o664 or not mode & 0o400
                or (mode & 0o020 and info.st_gid != os.getgid())):
            raise Refusal("merge-control-needs-independent-recovery")
        data = stream.read(65537)
    if len(data) > 65536:
        raise Refusal("merge-control-too-large")
    return data, {"sha256": hashlib.sha256(data).hexdigest(), "mode": mode,
                  "group_write_gid": info.st_gid if mode & 0o020 else None}


def resolved_merge(path, admin):
    """Preserve ordinary resolved merge metadata, including a missing advisory tree."""
    if any(os.path.lexists(admin / (name + ".lock")) for name in MERGE_FILES):
        raise Refusal("merge-control-lock-needs-independent-recovery")
    if not os.path.lexists(admin / "MERGE_HEAD"):
        return None
    files, data = {}, {}
    for name in sorted(MERGE_FILES):
        if os.path.lexists(admin / name):
            data[name], files[name] = merge_control(admin / name)
        if os.path.lexists(admin / "logs" / name):
            raise Refusal("merge-operation-log-needs-independent-recovery")
    if not MERGE_REQUIRED <= set(files) or data.get("MERGE_RR", b"") or data["MERGE_MODE"] not in (b"", b"no-ff"):
        raise Refusal("unsupported-merge-control-state")
    reader_env = dict(ENV, GIT_NO_LAZY_FETCH="1")
    head = git(path, "rev-parse", "HEAD", env=reader_env).decode().strip()
    def oid(name):
        value = data[name].decode("ascii")
        if len(value) not in (len(head), len(head) + 1) or value.rstrip("\n") != value.strip():
            raise Refusal("unsupported-merge-control-object-id")
        value = value.removesuffix("\n")
        if len(value) != len(head) or any(c not in "0123456789abcdef" for c in value):
            raise Refusal("unsupported-merge-control-object-id")
        return value
    parent, original = oid("MERGE_HEAD"), oid("ORIG_HEAD")
    if original != head or git(path, "cat-file", "-t", parent, env=reader_env).decode().strip() != "commit":
        raise Refusal("unsupported-merge-parent-state")
    roots = [parent]
    auto = {"status": "absent"}
    if "AUTO_MERGE" in data:
        auto_oid = oid("AUTO_MERGE")
        kind = git(path, "cat-file", "--batch-check", data=(auto_oid + "\n").encode(), env=reader_env).decode().strip().split()
        if kind == [auto_oid, "missing"]:
            auto = {"oid": auto_oid, "status": "preexisting-missing"}
        elif len(kind) == 3 and kind[0] == auto_oid and kind[1] == "tree":
            auto = {"oid": auto_oid, "status": "available-tree"}
            roots.append(auto_oid)
        else:
            raise Refusal("unsupported-auto-merge-object-type")
    for root in roots:
        closure = git(path, "rev-list", "--objects", "--missing=print", root,
                      env=reader_env)
        if any(line.startswith(b"?") for line in closure.splitlines()):
            raise Refusal("available-merge-object-closure-incomplete")
    return {"kind": "resolved-ordinary-merge", "files": files, "parent": parent,
            "original_head": original, "auto_merge": auto, "object_roots": roots}


def archive_merge_files(archive, state):
    if not state or state.get("kind") != "resolved-ordinary-merge":
        raise Refusal("unsupported-merge-archive")
    names = set(state["files"])
    if not MERGE_REQUIRED <= names or not names <= MERGE_FILES:
        raise Refusal("unsupported-merge-archive-file-set")
    for name, recorded in state["files"].items():
        _raw, actual = merge_control(archive / ("merge-" + name))
        if actual != {"sha256": recorded["sha256"], "mode": 0o600, "group_write_gid": None}:
            raise Refusal("merge-archive-control-mismatch")
        mode, group = recorded["mode"], recorded["group_write_gid"]
        if mode & ~0o664 or not mode & 0o400 or bool(mode & 0o020) != (group is not None):
            raise Refusal("unsafe-merge-archive-mode")
    return {"merge-" + name for name in names}


def restore_merge_files(archive, path, state):
    admin = Path(text(path, "rev-parse", "--absolute-git-dir"))
    for name, recorded in state["files"].items():
        destination = Path(text(path, "rev-parse", "--path-format=absolute", "--git-path", name))
        if destination.parent != admin:
            raise Refusal("merge-control-destination-is-not-private-gitdir")
        copy_regular(archive / ("merge-" + name), destination)
        if recorded["group_write_gid"] is not None and destination.stat().st_gid != recorded["group_write_gid"]:
            raise Refusal("restore-merge-control-group-changed")
        destination.chmod(recorded["mode"])
    actual = resolved_merge(path, admin)
    # A formerly missing advisory object may be independently repaired in the
    # shared object DB. Never delete that newly available object to force absence.
    if state["auto_merge"]["status"] == "preexisting-missing" and actual["auto_merge"]["status"] == "available-tree" and actual["auto_merge"]["oid"] == state["auto_merge"]["oid"]:
        actual["auto_merge"] = state["auto_merge"]
        actual["object_roots"] = state["object_roots"]
    if actual != state:
        raise Refusal("restored-merge-controls-differ-recovery-retained")


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
    if any(os.path.lexists(admin / name) for name in (*OPERATIONS, "MERGE_AUTOSTASH")
           if name not in (MERGE_FILES if os.path.lexists(admin / "MERGE_HEAD") else set())):
        raise Refusal("operation-state-needs-independent-recovery")
    sparse = Path(text(path, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"))
    if os.path.lexists(admin / "info/sparse-checkout") or os.path.lexists(sparse):
        raise Refusal("sparse-checkout-needs-independent-recovery")
    config = None
    if os.path.lexists(admin / "config.worktree"):
        if text(path, "config", "--bool", "--get", "extensions.worktreeConfig") != "true":
            raise Refusal("worktree-config-needs-independent-recovery")
        config = identity_config(admin / "config.worktree")
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
    merge_state = resolved_merge(path, admin)
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
    result = {"identity": identity, "common": common, "primary": paths[0],
            "head": text(path, "rev-parse", "HEAD"),
            "branch": subprocess.run(["git", "-C", str(path), "symbolic-ref", "-q", "--short", "HEAD"],
                                      capture_output=True, text=True, env=ENV).stdout.strip(),
            "index_path": str(index), "index_sha256": digest(index),
            "objects": sorted(set(objects))}
    if config is not None:
        result["worktree_config"] = {"path": str(admin / "config.worktree"), **config}
    if merge_state is not None:
        result["merge_state"] = merge_state
    return result


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
    if manifest.get("version") not in (2, 3, 4) or manifest.get("state") not in ("prepared", "parked"):
        raise Refusal("unsupported-archive-manifest")
    expected_files = {"files.tar.gz", "inventory.json", "index", "staged.pack", "staged.idx"}
    if manifest["version"] == 3 or (manifest["version"] == 4 and manifest["source"].get("worktree_config")):
        expected_files.add("config.worktree")
        config = manifest["source"].get("worktree_config")
        if not config or identity_config(path / "config.worktree") != {"sha256": config["sha256"], "mode": 0o600, "group_write_gid": None}:
            raise Refusal("archive-worktree-config-mismatch")
    elif manifest["source"].get("worktree_config"):
        raise Refusal("unsupported-archive-manifest")
    if manifest["version"] == 4:
        state = manifest["source"].get("merge_state")
        expected_files |= archive_merge_files(path, state)
        expected_refs = {manifest["ref"] + "-operation-" + str(i): oid for i, oid in enumerate(state["object_roots"])}
        if manifest.get("operation_refs") != expected_refs:
            raise Refusal("merge-object-protection-ref-set-mismatch")
    elif manifest["source"].get("merge_state"):
        raise Refusal("unsupported-archive-manifest")
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
    for ref, oid in manifest.get("operation_refs", {}).items():
        if text(primary, "rev-parse", ref) != oid:
            raise Refusal("protected-merge-object-ref-changed")
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
    config = before.get("worktree_config")
    if config:
        copy_regular(config["path"], archive / "config.worktree")
        if digest(archive / "config.worktree") != config["sha256"]:
            raise Refusal("worktree-config-changed-during-copy")
    merge_state = before.get("merge_state")
    if merge_state:
        admin = Path(text(path, "rev-parse", "--absolute-git-dir"))
        for name, recorded in merge_state["files"].items():
            copy_regular(admin / name, archive / ("merge-" + name))
            if digest(archive / ("merge-" + name)) != recorded["sha256"]:
                raise Refusal("merge-control-changed-during-copy")
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
    operation_roots = merge_state["object_roots"] if merge_state else []
    operation_refs = {ref + "-operation-" + str(i): oid for i, oid in enumerate(operation_roots)}
    for operation_ref, oid in operation_refs.items():
        git(path, "update-ref", operation_ref, oid, "")
    with open(archive / "staged.pack", "wb") as stream:
        subprocess.run(["git", "-C", str(path), "pack-objects", "--revs", "--stdout"],
                       # HEAD history has its own protected ref. Store every
                       # staged object absent from that history independently,
                       # without duplicating unchanged committed payloads.
                       input=("\n".join([tree, *before["objects"], *operation_roots, "^" + expected]) + "\n").encode(),
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
    if config:
        checksums["config.worktree"] = digest(archive / "config.worktree")
    if merge_state:
        checksums.update({"merge-" + name: digest(archive / ("merge-" + name)) for name in merge_state["files"]})
    manifest = {"version": 4 if merge_state else 3 if config else 2, "state": "prepared", "path": str(path), "source": before,
                "created_hours": hours, "excluded_caches": excluded, "ref": ref,
                "index_ref": index_ref, "index_tree": tree, "checksums": checksums,
                **({"operation_refs": operation_refs} if merge_state else {})}
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
                for operation_ref, oid in manifest.get("operation_refs", {}).items():
                    git(path, "update-ref", "-d", operation_ref, oid)
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
    if (info.get("worktree_config") and info["worktree_config"]["group_write_gid"] is not None
            and info["worktree_config"]["group_write_gid"] != os.getgid()):
        raise Refusal("restore-worktree-config-primary-group-changed")
    if info.get("worktree_config") and text(info["primary"], "config", "--bool", "--get", "extensions.worktreeConfig") != "true":
        raise Refusal("owning-worktree-config-semantics-changed")
    merge_state = info.get("merge_state")
    if merge_state and any(value["group_write_gid"] is not None and value["group_write_gid"] != os.getgid()
                           for value in merge_state["files"].values()):
        raise Refusal("restore-merge-primary-group-changed")
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
    config = info.get("worktree_config")
    if config:
        admin = Path(text(path, "rev-parse", "--absolute-git-dir"))
        if str(admin) == info["common"]:
            raise Refusal("restore-worktree-admin-is-common-directory")
        target_config = admin / "config.worktree"
        copy_regular(archive / "config.worktree", target_config)
        if config["group_write_gid"] is not None and target_config.stat().st_gid != config["group_write_gid"]:
            raise Refusal("restore-worktree-config-group-changed")
        target_config.chmod(config["mode"])
        if identity_config(target_config) != {"sha256": config["sha256"], "mode": config["mode"], "group_write_gid": config["group_write_gid"]}:
            raise Refusal("restored-worktree-config-verification-failed")
    # New checkout is empty except its Git link. Extraction cannot resurrect
    # tracked deletions, unlike overlaying an automatically checked-out HEAD.
    subprocess.run(["tar", "-xzf", str(archive / "files.tar.gz"), "--no-same-owner", "--same-permissions", "-C", str(path)], check=True)
    index = Path(text(path, "rev-parse", "--path-format=absolute", "--git-path", "index"))
    copy_regular(archive / "index", index)
    if digest(index) != info["index_sha256"] or inventory(path, manifest["excluded_caches"]) != expected:
        raise Refusal("restored-snapshot-verification-failed-recovery-retained")
    if merge_state:
        restore_merge_files(archive, path, merge_state)
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

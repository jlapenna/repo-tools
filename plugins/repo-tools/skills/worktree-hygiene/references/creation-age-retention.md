# Standing creation-age retention

Read from [worktree-hygiene](../SKILL.md) when an owner has granted a
creation-age retention window for linked checkouts.

An owner's explicit retention grant authorizes retirement of linked checkouts
older than that creation-age window within the approved repositories without
asking again. For a three-day grant, the window is 72 hours. An unmerged tip,
open PR or recent edit does not renew an old checkout's age. This procedure
does not grant access or select a global default window.

Use reliable Git-link filesystem birth time, never the HEAD commit date.
Unknown or future creation time is KEEP. For an authorized three-day grant:

```bash
repo-prune-merged-worktrees --repo <primary> --retire-created-hours 72 <checkout>
repo-prune-merged-worktrees --repo <primary> --retire-created-hours 72 --delete <checkout>
```

A checkout whose exact head is verified landed is removed outright, leftover
uncommitted files included; landed work is never archived. Only unlanded work,
or work whose landing GitHub cannot confirm, is archived.

Pass the documented consumer resource adapter in audit and apply. This mode
keeps branches and exact committed history, an independent index and staged
objects, dirty working files and their absences, and private ignored/untracked
inputs in verified recovery archives. Restore with the reported
`repo-restore-worktree` command; it creates an empty checkout before restoring
files and staging state, so deleted tracked files remain absent. Archives may
contain credentials and must remain private. Disposal is separate authorization.
Identity-only
`config.worktree` files are separately checksummed and restored byte-for-byte
into the new checkout's private Git administration directory; other keys,
includes, redirected files, unsafe modes and changed extension semantics stay.
Group writes require the current primary group.

Version-4 archives additionally preserve ordinary merges whose index is fully
resolved, including exact private operation files and available parent/advisory
objects. A preexisting missing advisory `AUTO_MERGE` object is explicitly
recorded and its reference bytes preserved; the tool never reconstructs it.
Object inspection disables lazy fetching. Merge-control lock files still keep
the checkout. A standalone empty, owned regular `MERGE_RR` is preserved
byte-for-byte with its mode when no active merge metadata is present. An
optional regular `ORIG_HEAD` is also preserved with its exact bytes and mode,
and its available commit closure is protected. Nonempty
rerere records, merge-control locks and other active operations stay; never
clear a marker to make a checkout eligible.

Keep live/locked/nested checkouts and unsupported split/sparse/unmerged indexes,
worktree-only configuration beyond regular, owned `user.name` / `user.email`
settings, sparse-checkout patterns and other in-progress Git operations with
their exact reason and path. Never kill another session or use `--force-anyway` to bypass snapshot/occupancy refusals.
The verified snapshot and retained path set are compared again under the
consumer lock; changed snapshots and partial removal failures retain recovery
evidence. The grant does not authorize deleting remote branches or treating
unfinished implementation issues as completed.

`--park-inactive --idle-hours N` remains an inactivity policy. It must not be
used as a substitute for the creation-age policy or weakened to bypass a
dirty/recent refusal.

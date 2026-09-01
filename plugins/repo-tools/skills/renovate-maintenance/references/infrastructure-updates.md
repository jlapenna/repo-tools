# Infrastructure-sensitive Renovate updates

Read this reference only when a Renovate update affects providers, runtime or
base images, deployment tooling, hardware integration, or another dependency
whose real compatibility depends on trusted production state.

## Keep production contracts out of CI/CD

CI/CD validates repository-controlled code and deterministic configuration.
It must not claim to validate facts that exist only on a live system.

- Never add trusted Terraform plans, production credentials, secret-bearing
  state access, physical device discovery, NVMe paths, host topology, or live
  hardware behavior to a CI/CD pipeline.
- Do not invent a mocked "contract test" that asserts a production device,
  mount, credential, or infrastructure result exists. Such a test encodes an
  assumption while providing false confidence, and it can be flaky or
  dangerous when inherited environment leaks into the fixture.
- Unit tests may cover repository-owned parsing and command construction, but
  must describe only that deterministic behavior. Keep the operational check
  explicit and out of band.

An unavailable host is not evidence that a dependency PR is wrong. Complete
repository verification, record the deferred operational check when one is
actually required, and do not contact, wake, reboot, or deploy to the host
without separate authorization.

## Provider and Terraform upgrades

When a provider upgrade needs state-aware review, use the repository's
sanctioned trusted review environment outside CI/CD:

1. Run a baseline plan and the exact feature-head plan with the same state,
   credentials, variables, backend, and Terraform version.
2. Compare resource counts and the material plan diff. Preserve enough
   non-secret evidence to distinguish a no-op from a hidden replacement or
   destructive change.
3. Treat a plan as review evidence only. Do not apply unless the user separately
   requested deployment and the repository's deployment policy authorizes it.
4. Remove plan files, temporary credentials, and review worktrees after the
   comparison.

The review helper itself must not mutate the caller's Git repository. If it
needs Git metadata, target the intended checkout explicitly and clear inherited
Git discovery variables such as `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`,
and index/object-directory overrides. Tests for a Git-independent path should
put a refusing `git` shim first in `PATH`; do not initialize, commit, push, or
create linked worktrees inside a shared pre-commit or hook environment merely
to test the review wrapper.

## Runtime, image, and hardware-facing updates

- Verify the repository-owned surfaces: rendered configuration, dependency
  resolution, builds, unit/integration tests, and artifacts.
- Treat a successful image build as build evidence, not proof that a specific
  physical accelerator, disk, or host will behave correctly.
- Keep rollout and live smoke testing separate from merge completion unless the
  user or repository policy explicitly includes deployment in the task.

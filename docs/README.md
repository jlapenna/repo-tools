# Documentation Index

Use the smallest source that owns the question.

| Need | Document |
| --- | --- |
| Understand component and consumer boundaries | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Browse commands and skills | [`interfaces.md`](interfaces.md) (generated) |
| Learn package capabilities and installation | [`../README.md`](../README.md) |
| Safely create or remove a worktree | [`../plugins/repo-tools/skills/worktree-hygiene/SKILL.md`](../plugins/repo-tools/skills/worktree-hygiene/SKILL.md) |
| Monitor CI and auto-merge | [`../plugins/repo-tools/skills/github-ci-monitor/SKILL.md`](../plugins/repo-tools/skills/github-ci-monitor/SKILL.md) |
| Carry a PR through merge | [`../plugins/repo-tools/skills/land-pr/SKILL.md`](../plugins/repo-tools/skills/land-pr/SKILL.md) |
| Choose proportionate tests and checks | [`../plugins/repo-tools/skills/testing-policy/SKILL.md`](../plugins/repo-tools/skills/testing-policy/SKILL.md) |
| Maintain agent context, documentation, and skills | [`../plugins/repo-tools/skills/harness-maintenance/SKILL.md`](../plugins/repo-tools/skills/harness-maintenance/SKILL.md) |
| Continue authorized work while the user is unavailable | [`../plugins/repo-tools/skills/autonomous-work/SKILL.md`](../plugins/repo-tools/skills/autonomous-work/SKILL.md) |
| Maintain Renovate updates | [`../plugins/repo-tools/skills/renovate-maintenance/SKILL.md`](../plugins/repo-tools/skills/renovate-maintenance/SKILL.md) |
| Reduce code complexity and stale maintenance paths | [`../plugins/repo-tools/skills/complexity-sweep/SKILL.md`](../plugins/repo-tools/skills/complexity-sweep/SKILL.md) |

Command implementation and regression tests live in `bin/`; shared ESLint
behavior lives in `eslint/`; provider manifests and skills live in `plugins/`.
Link new durable guides here. Regenerate the interface inventory through
`repo-docs` rather than editing it manually.

Obsolete compatibility and completed-migration cleanup follows the
[compatibility-cleanup skill](../plugins/repo-tools/skills/compatibility-cleanup/SKILL.md).

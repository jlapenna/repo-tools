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
| Maintain Renovate updates | [`../plugins/repo-tools/skills/renovate-maintenance/SKILL.md`](../plugins/repo-tools/skills/renovate-maintenance/SKILL.md) |

Command implementation and regression tests live in `bin/`; shared ESLint
behavior lives in `eslint/`; provider manifests and skills live in `plugins/`.
Link new durable guides here. Regenerate the interface inventory through
`repo-docs` rather than editing it manually.

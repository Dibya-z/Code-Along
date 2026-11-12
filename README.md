# Code Along

Code Along is an independently implemented collaborative Python learning and development platform. The approved design combines shared multi-file editing with local Python practice, assignments, immutable submissions and instructor feedback, using original UI/UX and branding.

## Current state

Architecture approved on 13 November 2026. The first implementation unit records the design and development plan. There is no application, dependency installation, database migration, runnable service or test framework yet.

- [Approved architecture](docs/architecture/approved-architecture.html): feature comparison, technology decisions, domain/schema relationships, protocols, security boundaries, target folder structure and milestone gates. Open the HTML file in a browser. Some historical investigation links refer to machine-local files and are not portable.
- [Implementation tracker](IMPLEMENTATION_PROGRESS.md): task order, dependencies, acceptance criteria, status, review state and commit records.
- `AGENTS.md`: existing local engineering guidance; currently outside the proposed initial commit.

## Approved architecture

| Responsibility | Technology / boundary |
| --- | --- |
| Product UI | React, TypeScript, Vite, React Router, TanStack Query |
| Editor and shared text | CodeMirror 6, Yjs; narrow Node 24 LTS/Hocuspocus service |
| Product policy and APIs | Python 3.13, Django 5.2 LTS, DRF, Channels |
| Durable storage | PostgreSQL 18, including binary CRDT checkpoints |
| Transient coordination / trusted jobs | Redis, Celery; never execute learner code in application workers |
| Browser practice | Pinned Pyodide in a supervised Worker on a separate runner site |
| Design system | Original semantic tokens and accessible primitives, guided by Taste Skill, web-design and Awesome DESIGN.md |
| Later authoritative grading | Separate Linux execution hosts, sandbox controller and external trusted scoring |

Exact compatible patches, dependency locks and image digests will be verified in M0. A peer-sync event is not a durable save acknowledgment. Local practice results are not trusted grades. Submissions preserve the exact accepted source/runtime manifest. Workspace teaching roles do not grant blanket access to private live projects.

## Release scope

M0 validates the critical integrations. M1–M5 deliver the first release: accounts/workspaces/project permissions, multi-file IDE, isolated local execution, collaboration/cursors, durable saves and chat, named revisions/sharing, assignments/hints/visible checks, immutable submissions and instructor feedback.

M6 adds optional trusted server grading behind a security gate. M7 adds prioritized voice, durable drawing and further collaborative learning capabilities. Full task details are in the tracker.

## Setup and execution

There are no install, development, migration, build or application-test commands yet. Do not treat planned folders or stack choices as runnable functionality. Verified commands, prerequisites, safe environment examples and service URLs will be added with the unit that introduces each tool or service.

No credentials belong in documentation or source control. PyTogether remains a read-only technical reference; its code, assets and branding are not imported into the application.

## Development workflow

For each independently reviewable unit:

1. Plan its scope, dependencies, files and verification criteria.
2. Implement that unit and update its documentation/tracker.
3. Run relevant checks and review the complete diff, including intended staged files and secret/generated-file exclusions.
4. Show the proposed conventional commit message and changed files; wait for explicit approval.
5. Commit only the approved unit, record its hash in the tracker, then proceed to the next task.

Do not push, merge or deploy without separate explicit approval. Stop for approval before changing an accepted architectural decision.

The tracker distinguishes verified work from committed work. A commit cannot contain its own final hash: after an approved commit, record its hash in the next tracker update, to be included in the next approved unit. Never create an unapproved bookkeeping commit or amend a reviewed commit solely to insert that hash.

# Focused product interface refresh

Status: **In Progress**, 15 November 2026. The owner selected a focused
developer-product direction and authorized implementation and verified
commits/pushes. This changes the presentation of the existing independently
implemented platform; it does not replace its architecture or core workflows.

## Design decisions

- An original paired-code mark, forest navigation, warm neutral surfaces and
  restrained lime accent provide a consistent identity. Native system fonts
  avoid additional downloads and preserve readable code.
- The signed-out entry explains the actual product and links to real account
  forms. Its Python example is explicitly illustrative. No invented users,
  customer logos, testimonials or executed output are presented as real.
- A compact account-aware shell separates navigation from the active task.
  Workspace cards and project rows expose actual names, roles, entrypoints and
  environments rather than decorative metrics.
- Editor tabs, source, explorer and console form one workbench. Secondary help
  lives in native disclosures; save, blocked-state, recovery and execution
  controls retain their existing meanings and lifetimes. Learning instructions,
  hints and feedback use the same spacing and surface system.
- The appearance control saves only `light` or `dark` under
  `code-along.appearance`. Unavailable storage is handled without preventing use.
  External document-theme changes update the control; no account or source data
  is added to this preference.

The [design direction](../../DESIGN.md) records the design system and reference
discipline. Official Linear, Replit and Brilliant pages informed hierarchy,
collaboration framing and learning clarity. The local Awesome DESIGN.md library,
Taste and web-design skills informed the process. Reference code, branding,
screenshots and fonts are not shipped. No UI dependency was added.

## Implementation boundaries

`apps/web/src/ui` contains the original identity, icons, entry and appearance
control. `apps/web/src/app/router.tsx` composes the shell. Feature presentation
stays beside its existing auth, workspace, project, editor, execution, learning
and feedback modules. Shared semantic tokens and controls remain in
`packages/design-system`.

Pathname-based route lifetimes, hash-based project sections, stable editor and
Worker resources, account/session handling, permissions, source authority and
receipt-based Saved semantics are preserved. No backend, API contract, migration,
dependency, execution protocol or security policy changes are included.

## Verification record

Sixteen actual screenshots of the previous interface were retained locally.
The first capture reached an incorrectly scoped optional console step after
those screenshots; that private capture failure is not an application failure.

The integrated lint, formatting and TypeScript checks pass. All **711 JavaScript
tests across 64 files**, the production web build and the shared design-system
Storybook build pass. Token checks include the new navigation, accent and
illustrative-source contrast pairs. These checks do not certify every rendered
component for accessibility.

The first redesigned browser capture exposed a real sticky inner-toolbar
overlap with source. Returning that toolbar to normal flow fixes the overlap;
the outer Run/Stop bar remains persistent. A retained-navigation regression now
checks actual frontmost visibility of the first source line, in addition to the
existing source-position, undo, Worker, draft and exact-byte assertions.

Corrected real account/project and published-learning captures pass **2/2**,
producing **27 screenshots**. Geometry checks include 1440, 1024, 768, 390 and
320px widths, with no page overflow in those captures. Desktop and phone
screenshots have been visually inspected. The first source line is visible at
390/320px in both ordinary projects and pinned learning work. Dark mode, account
validation, a project dialog and console options are included.

Independent review of those captures identifies two further tab-presentation
issues: the selected underline paints beneath an opaque child, and a wrapping
learning header can collapse its tab strip to zero width. Bounded CSS fixes put
the indicator on the controls and give the tabs their own line in the existing
wrap modes. Their formatting check passes; these final CSS changes still await
fresh rendering. The final production web rebuild passes in 2.007s on the
corrected source; the unchanged shared Storybook inputs retain their passing
build.

The first two-engine retained-navigation run reaches an outdated exact-background
expectation: Refresh project is now a transparent control. The check is moved to
the actual solid editor surface in navigation, plot and Add file checks, retaining the
exact dark token expectation and all behavioral assertions. That failed run remains diagnostic evidence; the
complete corrected journey and final Linux gate are pending.

The navigation check also opens Editor options and verifies that the actual
selected file tab remains visible and keyboard-focusable before returning to
the source. Existing timeouts and source/Worker assertions remain intact.

After browser cleanup, host free space remains around 4GiB due to observed
macOS swap allocation, with no owned test services left running. Heavy local
work stays paused below its 4.2GiB preflight; the 3.5GiB hard floor is preserved.
Headroom temporarily recovers to about 5GiB, allowing the final web build, then
falls below preflight again before a new browser fixture starts. The final
fresh-source browser acceptance will run in Linux CI instead of starting
another large local stack. Earlier
local passes are scoped to their captured source rather than claimed as a pass
for these later changes. No user data or installed tools are removed.

No source/test assertion filtering, increased quota, extended deadline or retry
is introduced. Earlier core-MVP acceptance remains documented in
[MVP readiness](../operations/mvp-readiness.md). Full screen-reader and retail
device certification, classroom load and the earlier intermittent WebKit
native-fetch observation remain broader M5 work.

## Local preview

From the repository root, run `npm run dev`, then open
`https://127.0.0.1:8443`. The entry and account pages are available signed out;
sign in to view workspaces and projects. Use the header appearance control for
dark mode. The existing [development guide](../operations/development-stack.md)
describes prerequisites, private verification mail, optional certificate trust
and normal shutdown. The separate test-capture address is not the development
application.

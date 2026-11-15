# Code Along design direction

Code Along is a shared Python workbench for learning together. The interface should help a learner understand the code, their collaborators and the next useful step. Precision, readable source and a calm workspace matter more than visual spectacle.

## Identity and composition

Use the original paired-code mark and lowercase Code Along wordmark from `apps/web/src/ui/brand.tsx`, with the matching self-hosted favicon. No reference-project branding, simulated customer logos, invented testimonials or unlicensed fonts/assets. Warm neutral content surfaces sit beside a deep-forest navigation frame; restrained lime accents identify the product, while deep green marks deliberate actions. A corresponding dark workbench theme uses the same semantic system. Confirmed state always has a meaningful text label. No violet/lavender, decorative gradients or novelty terminal effects.

The product shell has a compact navigation rail, route context and real account identity, contextual file/lesson pane, central editor and resizable output/discussion area. Workspace cards show real groups; project catalogues expose actual entrypoint, runtime and access information. Account forms have their own focused entry layout rather than an empty workspace rail. Give code the most space. Keep instructions close to the relevant task; learning panels disclose detail progressively. Use aligned edges, restrained separators and typography to group information. Avoid turning every region into a floating card. Dashboard lists should expose project name, membership context and next action without decorative metrics.

The signed-out entry explains the real product with working account links and an explicitly illustrative, noninteractive Python example; it must not simulate live collaborators, executed output or saved state. Authentication keeps the actual stateful form primary, with concise supporting product copy. This remains a product workbench rather than a separate marketing campaign. Whole-screen promotional sections, hero effects and scroll scenes do not belong inside the IDE. When a separate public landing page is commissioned, apply the Taste page workflow and browser finish gate to that page; show the actual Code Along interface and truthful product copy. The current runner/browser pages are technical test fixtures, not visual prototypes or production screens.

## Tokens and typography

The implementation source is `packages/design-system/src/tokens.css`, exported as `@code-along/design-system/tokens.css`. Use semantic variables rather than component-specific hex values. Default to the light theme; `[data-theme='dark']` switches the palette. Respect explicit user choice. The appearance control stores only a light/dark preference under `code-along.appearance`; unavailable browser storage must not block using it. It observes the document theme so the control stays consistent when another presentation surface changes that attribute. This preference contains no account, credential or source data. Do not import application clients into the design system.

| Family  | Decision                                                           | Reason                                                           |
| ------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Surface | canvas, surface, raised, border and subtle separator               | Hierarchy without heavy shadows or stacked cards                 |
| Text    | ink and muted; success/warning/error/info labels                   | Readable prose and meaningful state; no color-only communication |
| Action  | primary/on-primary/hover/focus                                     | One clear primary action with visible keyboard feedback          |
| Type    | Native system sans; ui-monospace/SFMono/Menlo fallback for source  | No external font fetch, license assumption or font layout shift  |
| Size    | 1rem body/editor default; .875rem metadata; 1.25/1.5/2rem headings | Reading comes first; metadata is not primary instructional text  |
| Rhythm  | 4px base; 8/12/16/24/32/48px equivalent spacing                    | Consistent relationships instead of arbitrary gaps               |
| Shape   | 4/8/12px radii; 44px minimum action target                         | Precise workbench with forgiving controls                        |
| Motion  | 120/180ms feedback; zero under reduced motion                      | Acknowledge actions without distracting from code                |

Body and lesson text use line-height 1.5–1.6 and about 65ch maximum measure. Code uses 1.5 line-height, user-adjustable size and horizontal scrolling inside its own pane. Use tabular numbers for counters/durations. Do not reduce primary reading text below 1rem to fit a panel. Syntax and participant palettes need a separate color-vision/contrast review when the editor ships; do not reuse action colors as identity alone.

## Interaction and honest state

Every component needs idle, hover, focus-visible, active, disabled, busy and error behavior where relevant. Hover must not be required to discover essential actions. Use a persistent 2px focus ring with 2px offset. Buttons use verbs and objects: Create project, Run code, Stop run, Save checkpoint, Invite member. Keep destructive action descriptions explicit and place recovery/export beside blocked collaboration states.

Saved means the server's correlated durable receipt covers the current observed document. Peer sync, a successful local run and an old receipt cannot produce that label. Pending/Saving persists while edits continue. Storage failure shows unsaved status and recovery actions; do not substitute a toast for persistent state. Accessible polite announcements should report state transitions, not every keystroke/cursor move.

Run output names the frozen source version and runtime. Show earlier-source output when the live file changes. Input waiting is explicit; Stop remains reachable. Practice success is local untrusted feedback, never an assessment score. Render output as text or reviewed spans, never learner HTML/SVG. Keep stdout/stderr visually distinct with labels as well as color.

Selection/cursor identities need text labels and optional patterns in addition to hue. Remote cursor movement must not steal focus or continually rerender the whole page. Instructor-follow mode must be opt-in and escapable. Learner hints disclose one step at a time; feedback should explain what to try without pretending a network or execution error is a learning failure.

## Accessibility and responsive acceptance

- Semantic landmarks, heading order, visible labels, error associations and accessible names are required. No positive tabindex. Skip navigation reaches the workbench.
- Complete keyboard paths must cover navigation, file selection, editor entry/escape, Run/Stop, console/input, chat and dialogs. Document editor shortcuts and avoid trapping Tab without a clear escape.
- Text pairs must meet WCAG AA 4.5:1; large text and meaningful control/focus boundaries at least 3:1. Token tests cover named foreground/background pairs; they do not certify rendered components.
- At 1440/1280px support simultaneous file/editor/output panes. Around 1024px collapse optional teaching/discussion panes. At 768px use explicit tabs/drawers with retained state. At 390/320px reading/review and essential actions must reflow; the code pane may scroll horizontally. Do not silently hide functionality or claim full mobile editing before testing it.
- Test 200% text zoom, 400% page zoom/reflow, long project names, empty/error/loading states, high-contrast settings, reduced motion and keyboard-only use. Controls need 44px targets or genuinely separated equivalent hit areas.
- Dialogs restore focus; resize handles have keyboard controls and names; console updates do not force scrolling when a learner is reading earlier output.

Primitives, Storybook and the core workbench are implemented. The product presentation applies task-first project navigation, compact context and progressive disclosure across the M4 learning screens. Secondary keyboard guidance remains discoverable under Editor options; shared-editing help is a native disclosure, while blocked/capability/local-copy warnings remain persistent. Keep editor/execution/discussion resources stable when switching views; hidden controls leave keyboard navigation, while Run/Stop, durable save/blocked state and recovery remain reachable. Workspace projects and existing local drafts lead their screens; occasional administration and creation details are disclosed explicitly. Rendered browser/keyboard checks accompany every meaningful UI unit; full screen-reader/retail/mobile certification remains a later gate.

## Reference discipline

Taste supplies plain copy, deliberate composition, equal edges and restrained interaction; web-design supplies semantic structure, hierarchy, defensive layout and accessibility priorities. The local Awesome DESIGN.md library informed documentation structure, small spacing scales and surface hierarchy. Linear's and ClickHouse's palette, typography, screenshots, page structure and brand motifs are not adopted. No reference files/assets are vendored. Code Along's tokens and behavioral language are independently authored.

## Focused product reference study — 15 November 2026

The owner chose a focused developer-product direction. The redesign applies consistent navigation, stronger type hierarchy, coordinated white/forest surfaces, original interface icons and more useful project identities. It preserves the approved frontend stack, existing queries, pathname/hash lifetimes, editor/Worker resources, source authority and durable receipt meanings. It adds no third-party UI dependency, external font request or fabricated product activity.

The study uses [Linear’s interface hierarchy refresh](https://linear.app/now/behind-the-latest-design-refresh), [Replit’s collaborative programming product](https://replit.com/collaboration), and [Brilliant’s Python learning flow](https://brilliant.org/topics/python/). These are qualitative references, not an objective ranking. The local Awesome DESIGN.md analyses of Linear, Cursor and Resend guide the reference discipline. External research images remain ignored local references and are never shipped as Code Along assets.

Taste’s truthful copy, deliberate composition, aligned edges and component consistency apply to these product surfaces. Web-design supplies the structure, responsive, contrast and interaction checks. Marketing-site full-screen sections, shader scenes and timed promotional motion do not belong in the authenticated workbench. Actual screenshots, keyboard checks and retained-state regressions remain required; source review alone is not visual acceptance.

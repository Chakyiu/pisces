# Pisces stacks — add and edit

Feature contract for TELE-116. The console palette, type, and components already live in `frontend/app/globals.css`, `frontend/app/layout.tsx`, and `frontend/components/bits.tsx`. This file binds the new flows to that system. It does not introduce a second palette.

Strings, routes, and states are in `implementation-handoff.md`. The screenshot cut is in `design-contract.md`.

## 1. Visual Theme & Atmosphere

Pisces is a dense operations console: dark navy surfaces, a single amber action, and short sentences that name the endpoint. Stack create and edit stay inside that console. They should feel like the volumes page and the container detail page, not like a second product skinned to resemble Portainer.

The Portainer screenshots are an information-architecture reference. The atmosphere to keep is “a form that deploys a file, then a detail page that separates running containers from the file.” The atmosphere to leave behind is Portainer’s blue selection chrome, filled red pills, and extra administrative cards.

One page, one job. Add stack deploys a new Compose project. Stack details either operates the containers or edits the stored file. Those jobs do not share a screen.

## 2. Color

Use the existing tokens only.

| Token | Value | Role on these screens |
|---|---|---|
| `--bg` | `#0b1120` | Page background, editor well |
| `--surface` | `#111827` | Widgets, fields, dialogs |
| `--surface-hover` | `#1a2535` | Ghost button and row hover |
| `--surface-active` | `#1e3a5f` | Selected Stack / Editor tab |
| `--border` | `#1e3a5f` | Widget, field, and button borders |
| `--border-subtle` | `#162035` | Table row rules |
| `--fg` | `#e8f0fe` | Primary text, focus ring |
| `--muted` | `#8ba3c7` | Labels, hints, discovered/managed badges |
| `--accent` | `#ffb800` | The single filled primary button |
| `--accent-ink` | `#0b1120` | Text on that button |
| `--success` | `#26de81` | Running badge only |
| `--warn` | `#ff9f43` | Partial badge only |
| `--danger` | `#ff4757` | Errors, destructive button text and border |

Accent budget, from `craft/color.md`: one filled `--accent` control per screen. That control is **Add stack** on the list, **Deploy the stack** on the create page, or **Update the stack** on the Editor tab. Links are `--fg` with an underline, the same treatment as `.name-link`. Focus rings stay `2px solid var(--fg)`, as `:focus-visible` already does. Do not paint the selected tab, the origin badge, or the editor gutter amber.

Neutrals carry the page. Semantic colors appear only on badges, field errors, and destructive buttons. No gradients, glows, or new hues.

Error text uses `--danger` plus a 16px monoline icon (`currentColor`, `aria-hidden`) and the message words. Color is not the only signal (`craft/accessibility-baseline.md`).

## 3. Typography

The product scale is the console scale already shipped, not the display scale in `craft/typography.md`. Page titles stay at the existing `.title-row h1`: 18px, weight 600, line-height 1.2, letter-spacing 0. Raising them to 32px would break every other page.

| Role | Spec | Source |
|---|---|---|
| Page title | Inter 18 / 600 / 1.2 | `.title-row h1` |
| Section title | Inter 14 / 600 | `.widget-title`, widget `h2` |
| Body and fields | Inter 14 / 400 / 1.5 | `body` |
| Button label | Inter 14 / 500 / letter-spacing `0.02em` | `.btn` |
| Eyebrow label | Inter 12 / 600 / uppercase / letter-spacing `0.08em` | `.label`, `th`, `.fact span` |
| Hint and error | Inter 12 / 400, error in `--danger` | `.note`, `.field-error` |
| Names, counts, editor | JetBrains Mono 14 / 400 | `.mono` |
| Line numbers | JetBrains Mono 12 / 400 / `--muted` / `font-variant-numeric: tabular-nums` | new, inside the editor only |

Three weights, matching `layout.tsx` (Inter 400, 500, 600) and `craft/typography.md`: read 400, emphasize 500, announce 600. No 700.

Uppercase eyebrows already use `0.08em`, inside the `0.06em`–`0.1em` caps range. Body and the editor stay at letter-spacing 0 so YAML columns line up. Helper sentences wrap at `65ch`. The editor itself is a code surface and runs the full widget width.

Stack names and Compose text are `translate="no"`. The UI around them is English. Compose project names that fall outside the Docker charset are rejected by the name rule in the handoff, so this slice has no CJK display type.

## 4. Spacing & Grid

Stay on the console rhythm. Do not add a new page grid.

- Page padding: `.content` is `16px 24px 24px`, with `16px` between regions.
- Widget padding: `16px`. Header rows use the existing `.widget-head` padding `12px 16px`.
- Form field stack: `16px` gap, matching `.login-card form`. Label-to-control gap: `8px`.
- Button gap: `8px`. Button height: `36px`. Radius: `4px` everywhere, matching `.btn` and `.widget`.
- Name field and its hint: `max-width: 65ch`. Editor, tables, and the build-method fact use the full widget width.
- Table rows stay `44px`. The editor well is `min-height: 320px`, and `240px` when the viewport is under `561px` (the shell’s overlay breakpoint).
- Below `1100px`, fact rows may collapse to one column the way `.setting` already does. Tables scroll inside `.table-wrap`.

## 5. Layout & Composition

Three surfaces.

**Stacks list** (`/e/[id]/stacks`). The existing table gains an origin column and turns the project name into a link. **Add stack** sits in `PageFrame`’s `actions` slot, before Refresh. The empty state uses the same action. The create control is a link, because it navigates.

**Add stack** (`/e/[id]/stacks/new`). One column of widgets inside the existing shell. Order is fixed: name, deploy note, build method, web editor, then Cancel and Deploy the stack at the trailing edge. There is no method-card row.

**Stack details** (`/e/[id]/stacks/[project]`). Title row, then a Stack / Editor tab pair, then one panel.

- Stack panel: Actions, a facts block, the containers table.
- Editor panel: the web editor and Update the stack. Actions do not repeat on this tab.

The tab is reflected in the query string (`?tab=stack` or `?tab=editor`) so the view can be opened directly. Switching tabs uses `replace`, so Back returns to the list.

The create form is a page because `.dialog` is `min(440px, 100%)` and cannot hold a Compose file. Volume and network creation stay in dialogs; this flow does not.

## 6. Components

Reuse the classes that already exist. New CSS is limited to the tab pair and the editor gutter.

| Piece | Implementation |
|---|---|
| Primary action | `btn primary` with the plus icon for Add stack, text only for Deploy and Update |
| Ghost action | `btn` |
| Destructive action | `btn danger` (outline, not a filled red pill) |
| Text field | `label.label` wrapping `input.field` |
| Badge | existing `Badge` for Running / Stopped / Partial |
| Origin | `badge muted` with the words Managed or Discovered |
| Dialog | existing `Dialog`. Cancel carries `data-focus="first"` |
| Empty, loading, error | `Empty`, `Loading`, `ErrorState` |
| Tabs | `role="tablist"` / `tab` / `tabpanel`. Selected tab: `--surface-active` fill and a `1px solid var(--border)`. Unselected: transparent fill. Minimum height `36px`. Arrow keys move selection; only the selected tab is in the tab order |
| Editor | `textarea` in `--mono` on `--bg`, beside an `aria-hidden` line-number gutter. No syntax highlighting in this slice |
| Icon | existing `Icon` at 16px, stroke `1.5`, `currentColor` |

The build method is a fact row, label **Build method**, value **Web editor**. It is not a set of cards.

Field errors sit under the control, inside the label or pointed at with `aria-describedby`, with `role="alert"`. The patterns and the exact sentences are in the handoff.

## 7. Motion & Interaction

No new motion. Hover backgrounds keep the existing `100ms ease-in` on `.btn`, and the existing `prefers-reduced-motion: reduce` block already disables it.

Deploying, updating, and deleting are announced by the button label (**Deploying…**, **Updating…**, **Deleting…**) and a status line. Do not add a new spinner. The status node is in the DOM before its text changes, with `role="status"`.

Validation runs on blur, and again on submit. The error clears as soon as the value becomes valid. The first invalid field takes focus on submit (`craft/state-coverage.md`).

Tab in the editor does not insert spaces. Changing Tab into an indent key would trap keyboard focus, which fails WCAG 2.1.2. The user pastes or types spaces. Escape closes dialogs through the existing handler and does nothing special in the editor.

A deploy that runs past 15 seconds shows: **Taking longer than expected. Image pulls can take a minute.** That line stays while the request is open. This slice does not convert a live deploy into an error at 60 seconds. Image pulls outlive that threshold, and `craft/state-coverage.md`’s 60-second stop assumes a request that should have finished.

## 8. Voice & Brand

Voice matches the console that is already shipping: second person only when the user must act, the endpoint named in the sentence, no slogans.

- Buttons say the outcome: **Add stack**, **Deploy the stack**, **Update the stack**, **Delete stack**.
- Loading labels end with `…`.
- Empty-state quotes use curly quotes, as the stacks filter already does.
- Contractions use the apostrophe already in the console (`Couldn’t`).
- Do not write “Get started”, “Oops”, or “Something went wrong”.

**Docker Compose** is a link to `https://docs.docker.com/compose/`. **official documentation** links to `https://docs.docker.com/compose/compose-file/`. Both open a new tab with `rel="noopener noreferrer"`.

## 9. Anti-patterns

- A second accent, a purple or indigo fill, or a blue selected card copied from the screenshot. `--accent` is `#ffb800`. The banned default indigos in `craft/anti-ai-slop.md` stay banned.
- A gradient behind the editor or the page header.
- Emoji as the error icon or as a build-method icon. Use the monoline `Icon` set.
- A rounded card with a colored left border. The nav rail’s 2px amber mark is existing chrome and is not repeated on these widgets.
- Four build-method cards with three of them dead. Upload, Repository, and Custom template are absent until a later slice.
- Placeholder text as the only name for the editor.
- A CodeMirror-style theme, a custom find dialog, or syntax colors.
- Invented uptime, speed, or capacity claims.
- Filler body copy. Every sentence in the handoff is the sentence to ship.
- Portainer’s wordmark, its filled red buttons, the ownership block, and the sample project shown in the screenshots.
- Using the 10-second `api()` abort for deploy, update, or delete, then telling the user nothing changed. That helper’s copy is false while a Compose operation may still be running. See the handoff.

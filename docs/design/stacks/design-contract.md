# Design contract — Add stack and stack editing

TELE-116. Target artifact: the stacks console in Pisces (web, desktop density, authenticated operators). Audience: the reporter approving the slice, then the implementation that follows TELE-117.

Visual rules: `DESIGN.md`. Build sheet: `implementation-handoff.md`. Review frame: `example.html`.

## Goal

Ship a first slice that can create a Compose stack from a pasted file and edit a stack Pisces itself stored. Match the jobs in the two Portainer screenshots. Leave out the surrounding Portainer administration that Pisces has no model for yet.

## Evidence

| Evidence | Where | Confidence |
|---|---|---|
| Add-stack screenshot: name, required error, compose note, four method cards, web editor, copy, docs link, Cmd+F, content-required error | TELE-116 attachment `att1.png` | provided |
| Stack-details screenshot: Stack/Editor tabs, stop, delete, create template, duplication/migration, containers table, access control | TELE-116 attachment `att2.png` | provided |
| Console tokens, type, buttons, dialogs, empty/error/loading | `frontend/app/globals.css`, `frontend/components/bits.tsx`, `frontend/app/layout.tsx` | observed |
| Stacks list is label-derived, with Start / Stop / Restart and no create path | `frontend/app/(console)/e/[id]/stacks/page.tsx` | observed |
| `StackOut` is project, counts, state, containers. State is Running, Stopped, or Partial | `backend/src/docker.rs` `group_stacks` | observed |
| Page header already has an `actions` slot | `PageFrame` in `frontend/components/shell.tsx` | observed |
| Create dialogs are 440px wide; container detail is the long-page pattern | `.dialog`, container detail page | observed |
| `api()` aborts at 10 seconds and reports that nothing changed | `frontend/lib/api.ts` | observed |
| Project names are lowercase letters, digits, dashes, underscores, and must start with a letter or digit | Docker docs, “Specify a project name” | observed |
| 63-character cap, 1 MB file cap, reserved name `new` | this contract | inferred |
| Removed services are removed on update, named volumes stay | this contract, pending TELE-117 | inferred |
| Web editor is the only build method in the first slice | this contract | decision |

TELE-109 designed the list with no create affordance, because create did not exist. This contract adds that affordance. It does not reopen the list’s columns, bulk actions, or badge tones.

## Keep / change / do not copy

| Reference | Keep | Change | Do not copy |
|---|---|---|---|
| Add stack (`att1.png`) | Name field, placeholder `e.g. mystack`, error “Stack name is required”, a compose deploy note, a web editor with docs link, copy, a line-numbered file area, error “Stack file content is required”, a deploy action | Note says “Docker Compose” as one link. Search hint covers Ctrl+F and ⌘F. Build method is a fact, not four cards. The form is a Pisces page using `--accent` amber, 4px radius, and existing field styles | Portainer blue selected card, method icons, the cropped page chrome, any Portainer mark |
| Stack details (`att2.png`) | Stack and Editor as two views. Stop and delete at stack scope. A containers table for this project only. Editor is where the file changes | Actions use the existing ghost and danger buttons and the verbs already on the container page, disambiguated (“Stop stack”). Editor can update the file only when Pisces stored it. Save redeploys and asks first | Filled red pills, “Create template from stack”, the duplication/migration card, access control, Kill / Pause / Resume, the sample project and images in the shot |

## Decision

**Web editor only.** The first slice deploys one Compose file pasted into the page. Upload, Repository, and Custom template are not drawn. A disabled card reads as a control that is broken.

**Add stack is a page** at `/e/[id]/stacks/new`, opened from the stacks header and from the empty state. The name is the Compose project name. Deploy creates the stack and opens its detail page.

**Edit means the stored file.** Stack details has two tabs. Stack operates containers. Editor changes the Compose file and redeploys it. The project name is read-only after create. Discovered stacks (label only, no stored file) use the same tabs; the Editor tab explains that there is nothing to edit.

**Out of this slice:** duplication and migration, templates, access control, renaming, adopting a discovered stack by pasting a file over it, env files, build directories, and a second Compose file.

Identity, so the two kinds of row can be told apart without color:

- **Managed** — Pisces has a stored file for this project on this endpoint. The row remains when it has zero containers.
- **Discovered** — the engine has containers with this `com.docker.compose.project` label and Pisces has no file. The row exists only while those containers exist.

A project that has both a file and labelled containers is Managed.

## Screenshot walk

### Add stack (`att1.png`)

| Element in the shot | Slice |
|---|---|
| Name label with required marker | Reproduced. Label **Name**, required |
| Placeholder `e.g. mystack` | Reproduced |
| **Stack name is required** | Reproduced, on blur and on submit |
| “This stack will be deployed using docker compose.” | Reproduced with the product name **Docker Compose** as a single link |
| Build method: Web editor, Upload, Repository, Custom template | **Dropped.** One fact: Build method = Web editor. The other three methods are deferred, not shown as disabled cards |
| Web editor heading | Reproduced |
| Docs sentence and **official documentation** | Reproduced. Link target is the Compose file reference |
| “Cmd+F for search” | **Simplified** to “Ctrl+F or ⌘F to search” |
| Copy | Reproduced. Becomes **Copied** for 2 seconds |
| “Define or paste the content of your docker compose file here” | Reproduced as a persistent caption: “Define or paste the content of your Docker Compose file here.” |
| Line-numbered area | Reproduced as a textarea plus a gutter. No syntax highlighting |
| **Stack file content is required** | Reproduced |
| Deploy control (below the crop) | In scope. Label **Deploy the stack** |

### Stack details (`att2.png`)

| Element in the shot | Slice |
|---|---|
| Stack / Editor tabs | Reproduced. Query `tab=stack` or `tab=editor` |
| Project name as the page identity | Reproduced in the breadcrumb and the facts |
| Stop this stack | **Simplified** to **Stop stack**. Start stack and Restart stack sit with it, because the list already has those three |
| Delete this stack | Reproduced as **Delete stack** for a managed stack. A discovered stack says **Remove containers**, and the dialog does not claim a file was deleted |
| Create template from stack | **Dropped** |
| Stack duplication / migration card, optional name, environment select, “Target environment must be selected”, Migrate, Duplicate | **Dropped** |
| Containers table | **Simplified** to the columns the Containers page already uses: select, name, state, logs, image, created, ports. Bulk Start, Stop, Restart, Remove. Pager matches the console (50 rows) |
| Kill, Pause, Resume | **Dropped.** They are not on the Containers page |
| Search inside the table, IP address, ownership, items-per-page picker | **Dropped** |
| Access control, Change ownership | **Dropped** |
| Running badges | Reproduced with the existing `Badge` |

## Naming rules

The name field is the project name Compose will use. Docker’s rule, quoted from the project-name docs: lowercase letters, decimal digits, dashes, and underscores, beginning with a lowercase letter or a decimal digit.

Pisces adds three constraints so the route and the name column stay usable:

- At most 63 characters (inferred).
- `new` is reserved, because the create route is `/stacks/new` (inferred).
- The name must be unique on that endpoint across managed records and discovered projects. The server decides. The list is paged, so the client cannot know.

A `name:` key inside the file does not rename the stack. Deploy passes the field explicitly, which outranks the key in Compose’s precedence.

Uppercase is rejected, not silently lowercased, so the deployed name is the name the operator typed.

## What the editor can change

| | Managed, file present | Managed, file missing | Discovered |
|---|---|---|---|
| Stack tab | Start, stop, restart, delete, facts, containers | Same, plus a fact that the file is missing | Start, stop, restart, remove containers, facts, containers |
| Editor tab | Textarea loaded with the stored file. **Update the stack** enabled once the text is dirty | Empty state. No textarea | Empty state. No textarea |
| Name | Read-only | Read-only | Read-only |

Update opens a confirm dialog, then redeploys. Default copy, used unless TELE-117 chooses a mechanism that leaves orphan services in place:

> Pisces will redeploy this Compose file on {endpoint}. Services that this file no longer defines are removed. Named volumes stay.

Alternate, only in that case:

> Pisces will redeploy this Compose file on {endpoint}. Services that this file no longer defines stay on the engine until you remove them. Named volumes stay.

Failure leaves the textarea as the operator edited it.

## States the screens must render

List, create, and detail each need loading, empty, error, populated, and an edge case (`craft/state-coverage.md`). The handoff lists the copy. The edges that matter here:

- A managed stack with zero containers stays on the list as Stopped, `0/0`.
- A discovered stack whose containers disappear becomes the detail missing state.
- A name at 63 characters, and a file the editor can scroll, must not break the header or the gutter.
- A deploy still running after 15 seconds keeps the form locked and shows the long-running line.
- The client must not reuse the 10-second `api()` failure for that deploy. The shipped sentence says nothing changed, and that is the wrong claim while Compose may still be applying the file.

## Risks and unknowns

These wait on TELE-117. The UI copy above is what implementation should ship if the spike does not override it.

1. **How deploy actually runs** (Compose CLI in the image, a bollard subset, or Swarm) changes which YAML is accepted and whether `build:` can work. The form already says it sends the file only, with no build directory and no env file. Errors show the server message. Do not write a second client-side Compose parser.
2. **Where the file is stored** is the spike’s choice. The UI needs `origin`, `hasFile`, and the file text on the detail read. It does not choose the on-disk shape.
3. **Orphan services on update.** Use the default confirm sentence unless the chosen mechanism does not remove them.
4. **Cancellation.** If the request cannot be aborted, the form does not offer Cancel during deploy. Leaving the page must not promise that the engine stopped.
5. **Partial apply.** If the API can say containers were created anyway, the failure banner includes **Open {name}**. If it cannot, the banner is the server message alone.
6. **The 1 MB ceiling and the 63-character ceiling** are UI assumptions. The sentences can take a different number. The words stay.
7. **The current `api()` helper** aborts at 10 seconds. Deploy, update, and stack delete need a call that does not do that, and they must not surface “Nothing on this page was changed.”

## Quality gate

- [x] One visual stance: the existing Pisces console, amber used once per screen.
- [x] Both screenshots split into reproduced, simplified, and dropped.
- [x] Inferences labelled. Docker’s charset and the 10-second client are observed.
- [x] Exact strings and states live in `implementation-handoff.md`.
- [x] Anti-patterns name the Portainer chrome and the dead method cards.
- [x] A later implementation can build the first page without asking what the buttons say.

## What to run next

After this contract is accepted, and after TELE-117 picks the deploy mechanism, implementation follows `implementation-handoff.md`. Open `example.html` in a browser to review the frame. It is a fixture, not the app.

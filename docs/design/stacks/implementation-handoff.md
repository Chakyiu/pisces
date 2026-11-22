# Implementation handoff — Add stack and stack editing

Read `DESIGN.md` and `design-contract.md` first. Tokens stay in `frontend/app/globals.css`. Do not start this work until TELE-116 is accepted. Route names below are the UI contract; TELE-117 may rename the API, not the sentences.

The first build proves four things:

- **Add stack** on the stacks header opens a page with Name, the Compose note, Build method **Web editor**, and **Deploy the stack**.
- Submitting an empty name and an empty file shows the two required errors and focuses Name.
- A discovered stack’s Editor tab explains that no file is stored.
- **Update the stack** asks before redeploying, and a failure leaves the edited file on screen.

Upload, Repository, Custom template, migration, templates, and access control are absent.

## Files to touch

Suggested, not a license to widen the slice:

- `frontend/app/(console)/e/[id]/stacks/page.tsx` — header action, origin column, name link, empty copy.
- `frontend/app/(console)/e/[id]/stacks/new/page.tsx` — create page.
- `frontend/app/(console)/e/[id]/stacks/[project]/page.tsx` — detail page.
- A small editor and tab style next to the existing widget classes. No new font, no new color.
- Backend routes are TELE-117’s mechanism plus whatever list fields this handoff requires. Do not invent a second deploy path in the page.

`Empty` today only renders a button. The empty-state action navigates, so it should be a link. Extend `Empty` with an optional `href` rather than a click handler that pushes.

## Routes

| URL | Page |
|---|---|
| `/e/{endpointId}/stacks` | List |
| `/e/{endpointId}/stacks/new` | Add stack |
| `/e/{endpointId}/stacks/{project}?tab=stack` | Detail, Stack tab. Default when `tab` is missing or unknown |
| `/e/{endpointId}/stacks/{project}?tab=editor` | Detail, Editor tab |

`{project}` is URL-encoded. Both new pages sit behind the existing Docker gate. Kubernetes still has no stacks section.

Crumbs:

- List: `Stacks`
- Add: `Stacks` (link) / `Add stack`
- Detail: `Stacks` (link) / `{project}` with `mono` and `translate="no"`

Titles: list **Stacks**, add **Add stack**, detail **Stack details**. One `h1`.

## List

Header `actions`, before Refresh:

```html
<a class="btn primary" href="/e/{id}/stacks/new"><!-- plus icon -->Add stack</a>
```

Name cell becomes a link to `?tab=stack`, class `name-link`, `translate="no"`. Container chips stay links to the container page.

New column **Origin** after Name. Badge, muted, text **Managed** or **Discovered**. Not color alone.

A managed project with no containers is a row: state Stopped, count `0/0`, no container chips. Discovered projects still appear only when the engine has labelled containers.

Empty, no query:

- Title: `No stacks on {endpoint}.`
- Body: `Deploy a Compose file from here, or start a project on the engine. Either one shows up in this list.`
- Action: link **Add stack**, primary.

Filter miss stays: title `No stacks match “{query}”.`, body `The filter is hiding every stack.`, action **Clear search**.

Loading and engine-down error stay on `Loading` and `ErrorState`.

## Add stack

One form. Autofocus Name. `autocomplete="off"` on the name and the file. `spellCheck={false}` on both. The submit button stays enabled until the request starts.

### Fields

| Order | Control | Name | Copy |
|---|---|---|---|
| 1 | text input | `stack-name` | Label **Name**. Placeholder `e.g. mystack`. Hint: `Lowercase letters, digits, hyphens, and underscores. Must start with a letter or digit. Up to 63 characters.` |
| 2 | note | — | `This stack will be deployed using Docker Compose.` Link the words **Docker Compose** to `https://docs.docker.com/compose/` |
| 3 | fact | — | Label **Build method**. Value **Web editor** |
| 4 | editor | `compose-file` | See below |
| 5 | actions | — | **Cancel**, then **Deploy the stack** |

Hint and name field: `max-width: 65ch`.

Extra hint under the editor caption, still persistent:

`This form sends the Compose file only. It does not upload a build directory or an env file. Images must be ones the engine can pull.`

The `name:` key inside the file does not change the project. The hint above is enough; do not parse YAML on the client to warn about it.

### Name validation

On blur, and on submit. Clear the error as soon as the value is valid. Do not validate on the first keystroke.

| Condition | Error |
|---|---|
| Empty or whitespace | `Stack name is required` |
| Fails `^[a-z0-9][a-z0-9_-]*$` | `Use lowercase letters, digits, hyphens, and underscores, and start with a letter or digit.` |
| Longer than 63 | `Use at most 63 characters.` |
| Exactly `new` | `“new” is reserved. Pick another name.` |
| Server says the name exists (409) | `A stack named {name} is already on {endpoint}.` |

Pattern source: Docker’s project-name rule. The 63-character cap and the reserved word are Pisces constraints from the contract.

### Web editor

- `h2` **Web editor**, `id` used as `aria-labelledby` on the textarea.
- Caption: `Define or paste the content of your Docker Compose file here.`
- Docs line: `You can get more information about the Compose file format in the official documentation.` The words **official documentation** link to `https://docs.docker.com/compose/compose-file/`.
- Hint, not a control: `Ctrl+F or ⌘F to search`.
- **Copy** is `type="button"`. Disabled with title `Nothing to copy` when the file is empty. Success writes **Copied** for 2 seconds into a `role="status"` node that already exists. Failure: `Couldn’t copy. Select the file and copy it yourself.`
- Textarea on `--bg`, JetBrains Mono 14 / 400 / line-height 1.5, letter-spacing 0. Gutter is `aria-hidden`, tabular nums, 12px, `--muted`.
- Min height 320px, 240px under 561px. The well scrolls; the page chrome does not jump.
- Tab moves focus out. Do not trap it to insert spaces.
- Empty or whitespace on blur or submit: `Stack file content is required`.
- Over 1 MB (1_048_576 bytes of the textarea value): `This file is larger than 1 MB. Pisces accepts Compose files up to 1 MB.` The number can change if TELE-117 sets another ceiling. Do not client-parse services.

### Deploy

**Deploy the stack** is `type="submit"` and `btn primary`. **Cancel** is `type="button"`.

Untouched Cancel returns to the list. Dirty Cancel opens:

- Title: `Leave this page?`
- Body: `The stack has not been deployed.`
- **Stay** (focused first), **Leave**

`beforeunload` while the form is dirty or a deploy is in flight. The browser supplies that sentence.

On submit, focus the first invalid field. When the request starts, disable the fields and both buttons, and set the submit label to **Deploying…**. Status region, already in the DOM:

- At 15 seconds, if the request is still open: `Taking longer than expected. Image pulls can take a minute.`
- Leave it there. Do not flip a live deploy into an error at 60 seconds.

Do not call the current `api()` helper for this request. It aborts at 10 seconds and throws `The engine did not answer within 10 seconds. Nothing on this page was changed.` That sentence is false if the engine is still applying the file. Use a long-running call. If TELE-117 cannot abort it, there is no Cancel during **Deploying…**. The leave dialog then says: `Leave this page? The deploy keeps running on {endpoint}.`

Success: go to `/e/{id}/stacks/{name}?tab=stack`. Status on that page: `Deployed {name}.` (`role="status"`, no focus steal beyond the normal page load).

Failure: stay on the form, keep the name and the file, unlock the fields.

- Banner `role="alert"`: `Deploy failed. {server message}`
- If the server message is empty: `Deploy failed. The engine did not answer.`
- If the connection drops: `The console lost the deploy request. Check the stack list before trying again. The engine may still be applying it.`
- If the API reports a partial apply: `Deploy failed. Some containers for {name} are already on {endpoint}.` plus a link **Open {name}**. If the API cannot say this, do not invent the link.
- **Deploy the stack** remains the retry. It is not automatic. After the third failed attempt, add the existing retry line: `Last attempted: {time} · {n} retries`. Do not replace the button with a support link. Pisces has no support destination.

## Stack details

Tabs first, then one panel. `role="tablist"` with `aria-label="Stack views"`. Buttons: **Stack**, **Editor**. Left/Right and Home/End move between them. `aria-selected` follows the query.

### Stack tab

Actions widget, the same joined button group as the list, scoped to this project’s containers:

| Button | Enabled when | Pending label |
|---|---|---|
| **Start stack** | some container is not running and not restarting | `Starting…` |
| **Stop stack** | some container is running or restarting | `Stopping…` |
| **Restart stack** | there is at least one container | `Restarting…` |
| **Delete stack** or **Remove containers** | always, unless a request is open | `Deleting…` / `Removing…` |

Managed uses **Delete stack**. Discovered uses **Remove containers**. `aria-label` repeats the project name (`Delete stack {name}`).

Failure banner, same shape as the list: `{Action} failed. {message}`.

Facts:

| Label | Value |
|---|---|
| Name | project, mono |
| Origin | Managed or Discovered |
| State | `Badge` |
| Containers | `{running}/{total}` mono |
| Endpoint | endpoint name |
| Compose file | **Stored**, or **Not stored** when `hasFile` is false |

Containers widget reuses the Containers page columns and bulk actions: select, name (link), state, logs (link to the existing logs route), image, created, ports. Bulk **Start**, **Stop**, **Restart**, **Remove**, including the existing remove dialog. No Kill, Pause, Resume, search box, IP column, or ownership column.

Empty table:

- Managed: title `No containers in {name}.` Body `The Compose file is stored. Deploy has not left containers on {endpoint}.`
- Race on a discovered stack: title `No containers in {name}.` Body `They may have been removed. Refresh the page.`

Pager at 50, matching the console.

Delete dialogs. Cancel is focused first. Destructive button is `btn danger`.

Managed, with containers:

- Title: `Delete stack {name}?`
- Body: `This removes the containers created by {name} on {endpoint} and deletes the Compose file Pisces stored. Named volumes stay.`
- Confirm: **Delete stack**, pending **Deleting…**

Managed, zero containers:

- Title: `Delete stack {name}?`
- Body: `This deletes the Compose file Pisces stored for {name}. There are no containers to remove. Named volumes already on {endpoint} stay.`

Discovered:

- Title: `Remove containers in {name}?`
- Body: `Pisces did not create this stack. This stops and removes its containers on {endpoint}. Named volumes stay. The Compose file, if it lives somewhere else, is not touched.`
- Confirm: **Remove containers**, pending **Removing…**

Success returns to the list.

### Editor tab

**Managed, `hasFile`:** the same editor, loaded with the stored file. No name field. One line above it: `The stack name stays {name}.` Update is `btn primary`, disabled until the text is dirty, label **Update the stack**.

Confirm before the request:

- Title: `Update {name}?`
- Body (default): `Pisces will redeploy this Compose file on {endpoint}. Services that this file no longer defines are removed. Named volumes stay.`
- Body (only if TELE-117’s mechanism leaves orphan services): `Pisces will redeploy this Compose file on {endpoint}. Services that this file no longer defines stay on the engine until you remove them. Named volumes stay.`
- **Cancel** focused first, **Update the stack** to confirm.

Pending label **Updating…**. Fields lock. The 15-second line and the long-running client rule match Deploy. Success stays on the Editor tab, marks the file clean, and announces `Updated {name}.` Failure banner: `Update failed. {server message}` The textarea keeps the edit.

Dirty **Cancel** is not on this tab. Leaving via the Stack tab, the crumb, or the sidebar uses the same leave dialog as create: `The edits have not been applied.` / **Stay** / **Leave**.

**Managed, file missing:**

- Title: `Compose file missing`
- Body: `Pisces has a record for {name} on {endpoint}, but the Compose file is not there. There is nothing to edit.`

**Discovered:**

- Title: `No Compose file stored`
- Body: `Pisces found {name} from container labels on {endpoint}. It does not have the file that created those containers, so there is nothing to edit.`

No paste-to-adopt action on either empty state.

### Detail fetch

| State | UI |
|---|---|
| Loading, nothing shown yet | `Loading` with noun `stack` |
| Engine error | `ErrorState` title `Docker endpoint {endpoint} is not responding.` Retry reloads |
| Not found | Title `{name} was not found.` Body `This endpoint has no stack with that name.` Action **Back to stacks** |
| Populated | The tab panels |

A container remove that makes a discovered stack vanish lands on the not-found state. A managed stack remains.

## Read model the UI needs

TELE-117 chooses storage. The pages need:

```ts
type StackOrigin = "managed" | "discovered";

type StackRow = {
  project: string;
  origin: StackOrigin;
  hasFile: boolean;
  state: "Running" | "Stopped" | "Partial";
  running: number;
  total: number;
  containers: StackContainer[]; // list may keep today's shape
};

type StackDetail = StackRow & {
  compose: string | null; // null when hasFile is false
};
```

List rows need enough container identity to keep today’s chips. The detail containers table needs the Containers page fields (image, created, ports) for this project only. How that query is paged is the API’s choice. The UI paginates at 50.

Suggested results, not a route freeze:

- Create returns the project name, then the UI navigates.
- Detail returns `compose` when `hasFile` is true.
- Update and delete return success or an error message the banners can show.
- Conflict on create returns the duplicate sentence’s cause, or the UI uses the sentence in the table above.

## Accessibility

- Every input has a visible name. The editor’s name is the **Web editor** heading, not the placeholder.
- Errors: `aria-invalid`, `aria-describedby` pointing at the hint and the error, `role="alert"` on the error. Icon is `aria-hidden`.
- Focus ring remains the global `:focus-visible` outline. Do not remove it.
- Primary and destructive actions are `button` or a real link. Tabs are buttons. Add stack is a link.
- Dialogs use the existing focus trap and Escape behavior.
- Status text is polite. Alerts and dialogs are assertive. Do not move focus to a status message.
- Contrast floor is the existing tokens. Do not invent a lighter red for errors.
- Hit targets stay at least 36px on buttons, tabs, and the checkbox label.

## Do not build

- Upload, Git repository, or custom template pickers, including disabled ones.
- Rename, duplicate, migrate, “create template”, ownership, or environment picker.
- Adopting a discovered stack by pasting a file.
- Syntax highlighting, a private find dialog, or Tab-to-indent.
- A new palette, a new font, or a filled red button.
- Any call to the 10-second `api()` for deploy, update, or stack delete.

## Acceptance check

Walk `example.html` against `att1.png` and `att2.png`, then walk a built page against this file’s tables. A miss is a wrong string, a method card that does nothing, an editor on a discovered stack, or a deploy error that claims nothing changed.

# ClickUp Timesheet

Replaces the ClickUp timesheet task picker with a browsable Space → Folder → List → Task
tree, and a drag-and-drop day/week timeline.

The same folder runs **either as a website or as a Chrome extension** — no build step, no
dependencies, no server. `localStorage` works in both, so there's one codebase.

## Run it as a website (recommended)

`api.clickup.com` sends permissive CORS headers, so the browser calls it directly and
nothing passes through a server of yours.

1. Upload the folder to any static HTTPS host — GitHub Pages, Cloudflare Pages, Netlify.
   `index.html` is the entry point. `manifest.json` and `sw.js` are ignored by the site;
   leave them if you also want the extension.
2. Everyone opens the URL and pastes their own personal API token from
   [ClickUp → Settings → Apps](https://app.clickup.com/settings/apps).

Each person's token stays in their own browser's `localStorage` and is sent only to
`api.clickup.com`. Note that whoever controls the host can change the JavaScript, so your
team is trusting the host — normal for an internal tool, worth saying out loud.

## Run it as a Chrome extension

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this folder.
2. Click the icon → paste your token.

Only needed if you'd rather not host anything. Distribution notes: the Chrome Web Store
charges a one-time $5 developer fee and is unavailable in some countries; the free routes
are a shared zip plus Load unpacked, or `ExtensionInstallForcelist` for managed machines.

## Use
- **Left panel**: the whole Space → Folder → List structure loads up front; tasks load when
  you expand a List. “My tasks” and “Shared with me” are preloaded.
- **Search** matches Spaces, Folders, Lists *and* loaded tasks. Space-separated terms all
  have to match somewhere on a node's path, so `snapchat adidas` narrows to that folder.
  Matching nodes auto-expand; clearing the box collapses them again.
  Paste a task URL and press Enter to pull one task in directly.
- **Closed tasks** sit in a `✓ Closed (n)` sub-branch per list, struck through, and are
  searchable. Tasks in a *done*-type status stay inline with the open ones.
- **Timeline**: drag a task onto an hour to create a 1h block, or double-click a task
  to append it after the last block. Drag a block to move it, drag its bottom edge to
  resize. 15-minute snapping. Overlapping blocks sit side by side.
- **Week view** via the header toggle — 7 Monday-anchored columns with per-day totals.
  Drag a block sideways to move it to another day.
- Double-click a block to add a note (the time entry description). `×` deletes.
- Green outline = unsaved. **Save** writes creates/updates/deletes to ClickUp.
- The red line is the current time; it redraws on render, not on a ticker.

Selftest for the time/layout/filter/storage logic: open `index.html#test`, check the
console — the tab title flips to `selftest OK`.

## Known gaps
- Lists over 100 tasks are truncated (`/list/{id}/task` pages at 100; only page 0 is read).
- Custom task IDs (`ABC-123`) aren't handled by the paste box.
- Running timers (negative duration) are hidden and excluded from day totals.
- `PUT` on a time entry sends only `tid`/`description`/`start`/`end`/`duration`; whether
  ClickUp treats that as a patch or a replace is unverified, so editing an existing entry
  *may* clear its billable flag and tags. Test on a throwaway entry before relying on it.

## API endpoints used
`/user`, `/team`, `/team/{id}/space`, `/team/{id}/shared`, `/space/{id}/folder|list`,
`/list/{id}/task`, `/team/{id}/task` (assigned to me), `/task/{id}`,
`/team/{id}/time_entries` (GET/POST/PUT/DELETE). 429s back off using `X-RateLimit-Reset`
and retry twice.

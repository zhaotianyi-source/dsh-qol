# dsh-qol

> DSH experience quality-of-life bundle: archive management, session export, workspace export.
> Built on the official DeepSeek Harness Web client. Plugin ID `dsh-qol`.

[中文](README.md)

## Features

### Archived Session Management

DSH archiving is one-way: an archived session disappears from every list,
but the official client offers no way to find, restore, or delete it, and
the logs stay on disk forever. dsh-qol completes the loop:

- **Archive entry**: a sidebar footer "Archived" button
  (`sidebar.footer.action` slot) opens a panel listing all archived
  sessions, most recently updated first.
- **Restore**: one click; the session returns to its original workspace
  position (archiving never touches the accounting slot).
- **Delete**: two-step confirmation (Delete → Confirm). Permanently removes
  the session log file, its workspace accounting slot, and its archive-set
  membership; running sessions are rejected (`session-live`). The session
  disappears from every list immediately, with no leftover entries.

### Session Export (JSONL)

The session row `···` menu gains "Export session" (between Fork and
Archive): it downloads the session's raw log as plaintext JSONL (the
zstd-decoded stored artifact, byte-identical to disk) via the browser
save dialog, as `dsh-session-<id>.jsonl`.

### Workspace Export (ZIP)

The workspace row `···` menu gains "Export workspace chats": it bundles
every session's plaintext JSONL under that workspace into one ZIP (one
`<sessionId>/session.jsonl` entry each, matching the official
`session.export` layout), downloaded via the browser save dialog as
`dsh-workspace-<workspaceId>.zip`.

## Architecture

```
src/
├── index.ts                    # Package entry (re-exports host half)
├── host.ts                     # Host half: /dsh-qol RPC (restore/delete/export)
├── workspaceExport.ts          # Host half: workspace ZIP (webServer route)
├── cordis.patch.yml            # Bundle patch: host plugin row
└── client/
    ├── index.ts                # Browser entry: locale, listeners, sidebar
    ├── ArchivedPanel.tsx       # Archive panel (restore / delete)
    ├── ArchivedPanel.module.css
    ├── exportSession.tsx       # Export listeners (session JSONL / workspace ZIP)
    ├── locales.ts              # zh / en copy (qol namespace)
    ├── rpc.ts                  # Envelope-protocol RPC calls
    └── css-modules.d.ts
```

### Host half

`host.ts` serves the capabilities missing from official rc.6 over a
dedicated `/dsh-qol` RPC channel: `workspace.unarchiveSession`,
`workspace.deleteSession`, and `session.exportJsonl`. Deletion runs a
complete pipeline — reject running sessions, flush, broadcast the removal
frame (`host/session-removed`) *before* rewriting the archive set and
accounting, then delete the log file — so the browser never flashes a
stale row.

`workspaceExport.ts` registers `GET /dsh-qol/workspace.export?workspaceId=…`
and streams a ZIP built with fflate: sessions are read one at a time
(`readRaw`, zstd-decoded), so memory use stays bounded.

### Browser half

`client/` registers the archive panel on the `sidebar.footer.action` slot.
The export menu items are injected by the official-bundle patches, which
dispatch custom events (`dsh-qol:export-session` /
`dsh-qol:export-workspace`); the browser half listens and performs the
download via RPC or navigation, with failures surfaced as toasts.

## Runtime Patches

dsh-qol does not modify official API packages. It applies two minimal,
purely additive patches to the official UI bundle (no slot extension
points exist there):

| Location | Patch |
| --- | --- |
| `dsh-client-ui-workspace` | Insert "Export session" into the session row menu (between Fork and Archive) and "Export workspace chats" into the workspace row menu; clicking dispatches the corresponding custom event |
| `dsh-host-apiproxy` | Add a `workspace/session-deleted` listener to the host stream → broadcasts `host/session-removed` (summary removal frame) |

Each patch lands in both places, kept identical:

- **Packaged runtime**: `<desktop app>/resources/app/node_modules/@deepseek-ai/*`
  (host-side changes require an app restart; `dsh-client-ui-workspace`'s
  browser bundle is served directly from `lib/client.js` by
  `dsh-client-modules`, so a DSH restart is enough — no web artifact
  rebuild).
- **Source checkout**: `deepseek-harness/packages/*` (`Rows.tsx`,
  `locales.ts`, `api-proxy.ts`) mirrors the same edits.

## Install & Build

Requires Node `^22.19 || >=24`.

```bash
pnpm install
pnpm build          # tsc (host lib/index.js) + tsdown (browser lib/client.js)
```

Add to the Web profile (official flow):

```bash
dsh plugin --profile web add <absolute path to this package>
dsh web             # restart Web (DSH_HOME decides the data directory)
```

## Development

```bash
pnpm install
pnpm build          # produces lib/client.js
pnpm test           # vitest
```

- The browser half follows the official client-bundle contract
  (`window.__ModuleLoader__.load` closure factory, platform modules
  external; see `tsdown.config.ts`).
- New RPCs are called directly via `src/client/rpc.ts` with the public
  envelope protocol (the browser runtime needs no matching client method —
  host frame delivery keeps state in sync).
- Keep the export menu-item patches in sync with the harness checkout
  (see above).
- Feedback toasts follow the official pattern: a `shell.overlay` slot
  component renders the framework `Toast` primitive via internal
  `useState` (precedent: ui-model-selection's ModelSelect) — no hand-rolled
  `createRoot` or manual DOM mounting.

## Testing

```bash
pnpm test           # vitest (node environment + jsdom pragma for specs)
```

- `test/ops.test.ts`: host-half pure logic (restore / delete / export)
  driven by fake services — running-session rejection, unknown session,
  frame ordering (removal frame before archive/accounting writes), backend
  delete fallback.
- `test/workspace-export.test.ts`: ZIP packing (fflate unzip asserts entry
  layout), missing-log skip, unknown workspace, path-segment sanitization.
- `test/archived-panel.test.tsx`: component specs (jsdom +
  @testing-library/react), props-fed, asserting visible behavior: button,
  empty state, listing, restore, two-step delete, error banner.
- `test/rpc.test.ts`: envelope shape, business errors, HTTP 404 mapping,
  transport failure.
- `test/locales.test.ts`: zh / en dictionary key parity.

Component specs use react 18 (matching the official rc.6 packages' peer);
these devDeps do not affect the runtime — react is a platform module in the
browser, provided by the loader table.

## Known Limitations

- Deletion is physical (log file + directory), with no recycle bin; the
  panel requires two-step confirmation to prevent accidents.
- Only **running** sessions are refused deletion; idle sessions can be
  deleted. Sending messages to a deleted session afterwards yields a
  "session not found" error — the file will not be resurrected.
- With a non-JSONL `sessionPersistence` backend, deletion reports
  "backend does not support session deletion"; restore and export still
  work.
- Exports go through the browser save dialog: JavaScript cannot observe
  download completion, so there is no success notice; only failures
  surface as toasts.

## Model Experience

This plugin is pure UI / host orchestration; it injects nothing into the
model context.

### Request context and condition

Not applicable: no system-prompt contribution, no request-context rewrite.

#### What the model sees

Unchanged.

#### Token effect

Zero direct token effect.

#### KV Cache effect

Not applicable: no prefix is generated or rewritten.

## Known Limitations and Deferred Work

See "Known Limitations" above. The export menu items depend on minimal
patches to the official `dsh-client-ui-workspace` (no slot extension points
exist); if the official client later adds row-menu slots, migrate to them to
drop the patches.

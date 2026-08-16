# dsh-qol

> DSH experience quality-of-life bundle: archived session management.
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

## Architecture

```
src/
├── index.ts                    # Package entry (re-exports host half)
├── host.ts                     # Host half: /dsh-qol RPC (restore/delete)
├── ops.ts                      # Host core logic (pure functions, testable)
├── cordis.patch.yml            # Bundle patch: host plugin row
└── client/
    ├── index.ts                # Browser entry: locale + sidebar registration
    ├── ArchivedPanel.tsx       # Archive panel (restore / delete)
    ├── ArchivedPanel.module.css
    ├── locales.ts              # zh / en copy (qol namespace)
    ├── rpc.ts                  # Envelope-protocol RPC calls
    └── css-modules.d.ts
```

### Host half

`host.ts` serves the capabilities missing from official rc.6 over a
dedicated `/dsh-qol` RPC channel: `workspace.unarchiveSession` and
`workspace.deleteSession`. The core logic lives in `ops.ts` as pure
functions over service objects (unit-testable). Deletion runs a complete
pipeline — reject running sessions, flush, broadcast the removal frame
(`host/session-removed`) *before* rewriting the archive set and
accounting, then delete the log file — so the browser never flashes a
stale row.

### Browser half

`client/` registers the archive panel on the `sidebar.footer.action` slot.
Data flows through the framework global hooks (`useSessions` /
`useWorkspaces`); operations call the host RPCs directly; UI state stays
in sync through the host frame delivery.

## Runtime Patches

dsh-qol does not modify official API packages. It applies one minimal,
purely additive patch to the official host bundle:

| Location | Patch |
| --- | --- |
| `dsh-host-apiproxy` | Add a `workspace/session-deleted` listener to the host stream → broadcasts `host/session-removed` (summary removal frame) |

The patch lands in both places, kept identical:

- **Packaged runtime**: `<desktop app>/resources/app/node_modules/@deepseek-ai/*`
  (host-side changes require an app restart).
- **Source checkout**: `deepseek-harness/packages/*` (`api-proxy.ts`)
  mirrors the same edit.

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

## Testing

```bash
pnpm test           # vitest (node environment + jsdom pragma for specs)
```

- `test/ops.test.ts`: host-half pure logic (restore / delete) driven by
  fake services — running-session rejection, unknown session, frame
  ordering (removal frame before archive/accounting writes), backend
  delete fallback.
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
  "backend does not support session deletion"; restore still works.

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

See "Known Limitations" above.

# Architecture

## Overview

Firefox WebExtension (MV3) that pairs two tabs showing the same canonical URL and synchronizes scroll position so both tabs behave as a two-column reading continuum when placed side by side in Firefox Split View.

## Extension Components

```
src/
  manifest.json          Firefox MV3 manifest
  background/
    background.js        Service worker entry — validates and rehydrates pair state from storage on startup
    pairState.js         Authoritative in-memory pair store and mutation functions
  content/
    contentScript.js     Injected at document_idle — handles scroll metrics requests
                         and applies remote scroll commands
  shared/
    canonicalUrl.js      Deterministic URL canonicalization (shared by all contexts)
    messages.js          Message type constants and JSDoc typedefs for the message protocol
  popup/
    popup.html           Extension action popup shell
    popup.js             Popup script — pair management UI (added in CP2+)
```

## Pair Lifecycle

**Startup rehydration**: On service worker startup, `init()` calls `rehydrateValidPairs()` which queries both tabs for every stored pair. A pair is discarded if either tab no longer exists, if the two tabs are in different windows, or if either tab's URL no longer matches the stored canonical URL. Only valid pairs are hydrated into the in-memory store, and storage is flushed if any pairs were dropped. Valid tabs receive a `SET_PAIR_CONTEXT` message immediately; tabs still loading will receive it when their `tabs.onUpdated` `status:complete` fires.

**Reload repair**: When a paired tab fires `tabs.onUpdated` with `status:complete`, `handleTabUpdated` re-sends `SET_PAIR_CONTEXT` to that tab so its content script can resume emitting `SCROLL_EVENT`. If the tab navigated to a different canonical URL, the pair is invalidated instead.

**Pair invalidation**: All paths that invalidate a pair (`handleTabRemoved`, `handleTabUpdated` on URL mismatch, `handleTabReplaced` on URL mismatch or tab-get failure, explicit unpair) share one helper `invalidatePair()` that removes the pair, clears the ownership-switch log, persists the change, and notifies both tabs.

**Global sync settings**: The background service worker also persists extension-global sync settings in `browser.storage.local.syncSettings`. These currently include `adaptiveArticleOverlap` and `pageKeyOverrideEnabled`. Changes made in the popup are broadcast to every paired tab by re-sending `SET_PAIR_CONTEXT`.

## Pair State Model

Authoritative pair state lives in `src/background/pairState.js` as an in-memory `Map`. Storage is used only as a persistence layer — never as the source of truth for reads or as part of a read-modify-write cycle. All mutations go through the in-memory store first; `flushPairsToStorage()` is called asynchronously after.

Each `PairState` entry has:
- `pairId` — deterministic string derived from the two tab IDs (`pair-<lo>-<hi>`)
- `tabA`, `tabB` — the two tab IDs
- `canonicalUrl` — normalized URL both tabs must match
- `sourceTabId` — which tab is currently the scroll source
- `enabled`, `paused`, `pauseReason` — sync control state
- `syncToken` — monotonic counter incremented on every outbound `APPLY_SCROLL`; used for echo suppression
- `createdAt`, `lastSyncAt` — timestamps

## URL Canonicalization

Implemented in `src/shared/canonicalUrl.js`. Rules (v1):
- Only `http` and `https` URLs are supported.
- Scheme and host are lowercased.
- Fragment is always stripped.
- Query string is preserved.
- Empty path is normalized to `/`; other paths are kept as-is.

One shared implementation imported by both background and content-script contexts.

## Message Protocol

Three message types between content scripts and background (defined in `src/shared/messages.js`):

| Type | Direction | Purpose |
|---|---|---|
| `GET_SCROLL_METRICS` | background → content | Read current scroll metrics |
| `APPLY_SCROLL` | background → content | Apply a remote scroll position |
| `SCROLL_EVENT` | content → background | Report a trusted local scroll event |

All messages carry `pairId` for routing and `syncToken` for echo suppression.

`SET_PAIR_CONTEXT` also carries the current global settings snapshot plus `syncActive`, allowing the content script to keep feature flags in sync without querying storage directly.

## Keyboard Override

When `pageKeyOverrideEnabled` is true and a pair is actively syncing, the content script intercepts unmodified `PageUp` and `PageDown` key presses at capture phase and converts each into a double-page movement. Editable controls are excluded so form inputs retain native keyboard behavior.

## Unsupported Case Handling

Pages where sync cannot function are detected and surfaced to the user rather than failing silently.

**Non-http(s) pages** (PDFs, about:, file:, view-source:): `canonicalizeUrl` returns `unsupported-protocol`. `handleGetPairStatus` returns `status: 'invalid-page'` and `syncAvailable: false`. The popup shows a clear error message rather than pair controls.

**Content script blocked at runtime** (e.g., privileged extension pages, pages with strict CSP): `handleGetPairStatus` probes the tab's content script via `GET_SCROLL_METRICS`. If the probe fails, the response includes `syncAvailable: false` and the popup displays "Sync unavailable: content script not accessible on this page."

**Dynamically resizing infinite-scroll pages**: The continuum formula still applies with clamping. When `scrollHeight` differs between paired tabs, `syncCoordinator` logs a `console.warn`. This is documented as a known limitation.

**Cross-origin embedded scroll containers**: Out of scope for v1. Top-level `window.scrollY` only.

## Debug Logging

Verbose debug output (ownership switches, etc.) is gated behind `src/shared/debug.js`. It is only active when `localStorage.getItem('split-scroll-debug') === '1'` in popup/content-script contexts. In the background service worker, debug output is suppressed by default. Set `DEBUG = true` in that file to enable during development.

## Known Limitations (v1)

- Only top-level `window.scrollY` scroll tracking. Nested custom scroll containers are not supported.
- Cross-window pairing is not supported. Pairs are window-local.
- Zoom level differences between paired tabs are not compensated.
- Non-http(s) pages (PDFs, about:, file:, view-source:) cannot be paired.
- Pages that block content script injection are detected via probe and reported as sync-unavailable in the popup.
- Different `scrollHeight` values between paired tabs (e.g., one tab still loading dynamic content) are handled by clamping. The formula uses source metrics directly; a ratio-based correction is out of scope for v1.

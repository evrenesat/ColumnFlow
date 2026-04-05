# Split Scroll Continuum

Firefox WebExtension that pairs two tabs showing the same page and synchronizes scroll position so both tabs behave as a two-column reading continuum when placed side by side in Firefox Split View.

When you scroll down in the source tab, the sibling tab jumps to approximately the next readable segment — so the two tabs together cover consecutive vertical slices of one long document rather than showing the same content twice.

## Requirements

- Firefox 131 or later (desktop)
- The extension requires `tabs`, `storage`, and `scripting` permissions

## Install

Load as a temporary extension for development:

1. Open `about:debugging` in Firefox
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select `src/manifest.json`

## How it works

**Pairing**: Click the extension icon in the toolbar and press **Pair with sibling** (or **Alt+Shift+P**). The extension looks for another tab in the same window with the same canonical URL. If none exists, it opens a duplicate tab and pairs with it. A tab can belong to at most one pair at a time.

**Scroll sync**: When you scroll the source tab, the extension computes a continuum offset (`sourceScrollY + viewportHeight - 32px overlap`) and applies it to the sibling tab. If you start scrolling in the sibling tab instead, ownership switches automatically. Two ownership switches within 500ms are treated as oscillation and sync is auto-paused.

**Split View**: If the current tab is in Firefox Split View, the extension prefers the split mate as the pairing candidate over other duplicate tabs.

**Pausing**: Use **Pause sync** in the popup or **Alt+Shift+S** to pause without breaking the pair. The popup shows `[user]` or `[oscillation]` as the pause reason. Resume is available in the same popup.

## Known limitations

- Only top-level `window.scrollY` scrolling. Custom scroll containers inside the page are not tracked.
- Cross-window pairing is not supported. Pairs are window-local.
- Zoom level differences between paired tabs are not compensated.
- Non-http(s) pages (about:, file:, view-source:, PDFs) cannot be paired. The popup shows an error for these.
- Pages that block extension content scripts (privileged pages, strict CSP) will show "Sync unavailable" in the popup after pairing.
- When paired tabs have different `scrollHeight` values (e.g., one tab still loading dynamic content), the formula applies with clamping. A console warning is logged. Exact continuation cannot be guaranteed until both tabs settle.
- Private browsing and normal windows are handled via `"incognito": "spanning"`. Cross-window pairing between private and normal windows is not supported.

## Development

```sh
npm test          # run unit tests
npm run lint      # run addons-linter
```

To run web-ext lint directly:

```sh
npx web-ext lint --source-dir src/
```

### Debug output

Set `localStorage.setItem('split-scroll-debug', '1')` in the extension popup devtools console to enable verbose logging in popup and content-script contexts.

## Page classes and expected behavior

| Page class | Expected behavior |
|---|---|
| Static article (Wikipedia, long blog post) | Continuum sync works reliably. Scrolling source moves sibling to the next segment. |
| Documentation page (MDN, docs site) | Works the same as static article. |
| App page with moderate content | Works if the page uses standard document scroll. Custom scroll containers are not synced. |
| Infinite-scroll page | Formula applies with clamping. Sync may lag as new content loads and changes `scrollHeight`. A debug warning is logged when heights differ. |
| PDF (via Firefox PDF viewer) | Cannot be paired. Popup shows "This page cannot be paired." |
| `about:`, `file:`, `view-source:` | Cannot be paired. Popup shows "This page cannot be paired." |
| Page with blocked content script | Can be paired by URL, but popup shows "Sync unavailable: content script not accessible on this page." |

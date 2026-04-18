/**
 * Popup script for the extension action UI.
 *
 * Displays the pairing status of the active tab and provides
 * pair / unpair / pause / resume actions via the background service worker.
 */

import { MessageType } from '../shared/messages.js';

const statusEl = document.getElementById('status');
const actionBtn = document.getElementById('action-btn');
const pauseBtn = document.getElementById('pause-btn');
const splitBadge = document.getElementById('split-badge');
const syncWarning = document.getElementById('sync-warning');
const settingsWrap = document.getElementById('settings-wrap');
const pageKeyCheckbox = document.getElementById('page-key-checkbox');
const adaptiveCheckbox = document.getElementById('adaptive-checkbox');
const adaptiveDebug = document.getElementById('adaptive-debug');

/** @returns {Promise<browser.tabs.Tab>} */
async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Renders the popup state based on the status response from background.
 * @param {import('../shared/messages.js').PairStatusResponse} statusResp
 * @param {browser.tabs.Tab} tab
 */
function render(statusResp, tab) {
  actionBtn.style.display = 'none';
  actionBtn.className = '';
  actionBtn.disabled = false;
  pauseBtn.style.display = 'none';
  pauseBtn.disabled = false;
  syncWarning.style.display = 'none';
  syncWarning.textContent = '';
  settingsWrap.style.display = 'block';
  pageKeyCheckbox.disabled = false;
  pageKeyCheckbox.checked = statusResp.pageKeyOverrideEnabled !== false;
  pageKeyCheckbox.onchange = () => setPageKeyOverride(pageKeyCheckbox.checked);
  adaptiveCheckbox.disabled = false;
  adaptiveCheckbox.checked = statusResp.adaptiveArticleOverlap === true;
  adaptiveCheckbox.onchange = () => setAdaptiveArticleOverlap(adaptiveCheckbox.checked);
  adaptiveDebug.style.display = 'none';
  adaptiveDebug.textContent = '';

  const inSplitView = Boolean(tab.splitViewId);
  splitBadge.style.display = inSplitView ? 'block' : 'none';

  switch (statusResp.status) {
    case 'invalid-page':
      statusEl.textContent = 'This page cannot be paired (non-http/https URL).';
      statusEl.className = 'error';
      break;

    case 'unpaired':
      statusEl.textContent = 'No active pair for this tab.';
      statusEl.className = '';
      actionBtn.textContent = inSplitView ? 'Pair with split sibling' : 'Pair with sibling';
      actionBtn.style.display = 'block';
      actionBtn.onclick = () => pairCurrentTab(tab.id);
      break;

    case 'paired-source':
      statusEl.textContent = statusResp.paused
        ? `Paired (source) — sync paused${statusResp.pauseReason ? ` [${statusResp.pauseReason}]` : ''}.\nSibling: tab #${statusResp.siblingTabId}`
        : `Paired (source). Sibling: tab #${statusResp.siblingTabId}`;
      statusEl.className = '';
      actionBtn.textContent = 'Unpair';
      actionBtn.style.display = 'block';
      actionBtn.className = 'destructive';
      actionBtn.onclick = () => unpairTab(tab.id);
      pauseBtn.textContent = statusResp.paused ? 'Resume sync' : 'Pause sync';
      pauseBtn.style.display = 'block';
      pauseBtn.onclick = statusResp.paused ? () => resumeSync(tab.id) : () => pauseSync(tab.id);
      break;

    case 'paired-sibling':
      statusEl.textContent = statusResp.paused
        ? `Paired (sibling) — sync paused${statusResp.pauseReason ? ` [${statusResp.pauseReason}]` : ''}.\nSource: tab #${statusResp.siblingTabId}`
        : `Paired (sibling). Source: tab #${statusResp.siblingTabId}`;
      statusEl.className = '';
      actionBtn.textContent = 'Unpair';
      actionBtn.style.display = 'block';
      actionBtn.className = 'destructive';
      actionBtn.onclick = () => unpairTab(tab.id);
      pauseBtn.textContent = statusResp.paused ? 'Resume sync' : 'Pause sync';
      pauseBtn.style.display = 'block';
      pauseBtn.onclick = statusResp.paused ? () => resumeSync(tab.id) : () => pauseSync(tab.id);
      break;

    default:
      statusEl.textContent = 'Unknown state.';
      statusEl.className = 'error';
  }

  if (statusResp.syncAvailable === false && statusResp.status !== 'invalid-page' && statusResp.status !== 'unpaired') {
    syncWarning.textContent = 'Sync unavailable: content script not accessible on this page.';
    syncWarning.style.display = 'block';
  }

  if (statusResp.adaptiveArticleOverlap && statusResp.adaptiveDebug) {
    const debug = statusResp.adaptiveDebug;
    adaptiveDebug.textContent =
      `Mode: ${debug.articleDetected ? 'adaptive candidate' : 'fallback'}\n` +
      `Article detected: ${debug.articleDetected ? 'yes' : 'no'}\n` +
      `Line height: ${debug.articleLineHeight ?? 'n/a'}\n` +
      `Sample count: ${debug.articleSampleCount}\n` +
      `Top occlusion: ${debug.topOcclusionPx}px\n` +
      `Bottom occlusion: ${debug.bottomOcclusionPx}px\n` +
      `Effective viewport: ${debug.effectiveViewportHeight ?? 'n/a'}px\n` +
      `Estimated overlap: ${debug.estimatedOverlapPx ?? 'fallback'}px`;
    adaptiveDebug.style.display = 'block';
  }
}

/** @param {string} msg */
function renderError(msg) {
  statusEl.textContent = msg;
  statusEl.className = 'error';
  actionBtn.style.display = 'none';
  pauseBtn.style.display = 'none';
  syncWarning.style.display = 'none';
  settingsWrap.style.display = 'none';
  adaptiveDebug.style.display = 'none';
}

async function refresh() {
  statusEl.textContent = 'Loading…';
  statusEl.className = '';
  actionBtn.style.display = 'none';
  pauseBtn.style.display = 'none';

  let tab;
  try {
    tab = await getActiveTab();
  } catch {
    renderError('Could not read active tab.');
    return;
  }

  let statusResp;
  try {
    statusResp = await browser.runtime.sendMessage({
      type: MessageType.GET_PAIR_STATUS,
      tabId: tab.id,
      tabUrl: tab.url,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  render(statusResp, tab);
}

/** @param {number} tabId */
async function pairCurrentTab(tabId) {
  actionBtn.disabled = true;
  actionBtn.textContent = 'Pairing…';

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.PAIR_CURRENT_TAB,
      tabId,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Pairing failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

/** @param {number} tabId */
async function unpairTab(tabId) {
  actionBtn.disabled = true;
  actionBtn.textContent = 'Unpairing…';

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.UNPAIR_TAB,
      tabId,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Unpair failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

/** @param {number} tabId */
async function pauseSync(tabId) {
  pauseBtn.disabled = true;
  pauseBtn.textContent = 'Pausing…';

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.PAUSE_SYNC,
      tabId,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Pause failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

/** @param {number} tabId */
async function resumeSync(tabId) {
  pauseBtn.disabled = true;
  pauseBtn.textContent = 'Resuming…';

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.RESUME_SYNC,
      tabId,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Resume failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

/** @param {boolean} enabled */
async function setAdaptiveArticleOverlap(enabled) {
  adaptiveCheckbox.disabled = true;

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.SET_ADAPTIVE_ARTICLE_OVERLAP,
      enabled,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Adaptive overlap failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

/** @param {boolean} enabled */
async function setPageKeyOverride(enabled) {
  pageKeyCheckbox.disabled = true;

  let resp;
  try {
    resp = await browser.runtime.sendMessage({
      type: MessageType.SET_PAGE_KEY_OVERRIDE,
      enabled,
    });
  } catch {
    renderError('Could not reach background service.');
    return;
  }

  if (!resp.ok) {
    renderError(`Page key override failed: ${resp.reason}`);
    return;
  }

  await refresh();
}

refresh().catch((err) => renderError(`Error: ${err.message}`));

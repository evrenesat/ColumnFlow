/**
 * Pairing workflow: candidate discovery, pair creation, and tab lifecycle cleanup.
 *
 * Exported handlers are wired into the background service worker's event listeners
 * and message router in background.js.
 */

import { canonicalizeUrl, urlsMatch } from '../shared/canonicalUrl.js';
import {
  createPair,
  addPair,
  hydratePairs,
  removePair,
  getPairByTabId,
  replaceTabId,
} from './pairState.js';
import { flushPairsToStorage } from './storage.js';
import { notifyTabPairContext, clearOscillationLog } from './syncCoordinator.js';
import { MessageType } from '../shared/messages.js';

/**
 * Removes a pair from all state stores, clears its oscillation log, persists
 * the new state, and notifies both tabs. Notification errors are swallowed
 * because a tab may already be gone.
 * @param {import('./pairState.js').PairState} pair
 */
function invalidatePair(pair) {
  const { pairId, tabA, tabB } = pair;
  removePair(pairId);
  clearOscillationLog(pairId);
  flushPairsToStorage().catch(console.error);
  notifyTabPairContext(tabA, null).catch(() => {});
  notifyTabPairContext(tabB, null).catch(() => {});
}

/**
 * Validates stored pairs against live browser tabs, hydrates only valid ones,
 * persists any cleanup, and sends pair context to each valid tab.
 *
 * A pair is invalid when: a tab no longer exists, the two tabs are in different
 * windows, or either tab's URL no longer matches the stored canonical URL.
 *
 * Tabs that are still loading at startup will be re-registered when their
 * tabs.onUpdated status:complete fires.
 *
 * @param {import('./pairState.js').PairState[]} storedPairs
 * @returns {Promise<void>}
 */
export async function rehydrateValidPairs(storedPairs) {
  const validPairs = [];
  for (const pair of storedPairs) {
    try {
      const [tabA, tabB] = await Promise.all([
        browser.tabs.get(pair.tabA),
        browser.tabs.get(pair.tabB),
      ]);
      if (tabA.windowId !== tabB.windowId) continue;
      if (!urlsMatch(tabA.url ?? '', pair.canonicalUrl)) continue;
      if (!urlsMatch(tabB.url ?? '', pair.canonicalUrl)) continue;
      validPairs.push(pair);
    } catch {
      // One or both tabs no longer exist — discard this pair.
    }
  }

  hydratePairs(validPairs);

  if (validPairs.length < storedPairs.length) {
    flushPairsToStorage().catch(console.error);
  }

  for (const pair of validPairs) {
    notifyTabPairContext(pair.tabA, pair.pairId).catch(() => {});
    notifyTabPairContext(pair.tabB, pair.pairId).catch(() => {});
  }
}

/**
 * A tab object from the Firefox tabs API with the fields used by this module.
 * @typedef {Object} TabLike
 * @property {number} id
 * @property {number} windowId
 * @property {string | undefined} url
 * @property {number} index
 * @property {string | undefined} [splitViewId]
 */

/**
 * Returns candidate tabs ranked by the deterministic precedence rules:
 *   1. same splitViewId (when present and truthy)
 *   2. same window (already enforced by callers; kept as filter here too)
 *   3. same canonical URL (filter criterion)
 *   4. oldest by tab index (lower index = older position)
 *   5. lowest tab id as final tiebreaker
 *
 * Tabs that are already in a pair are excluded.
 *
 * @param {TabLike} currentTab
 * @param {TabLike[]} allTabs
 * @returns {TabLike[]}
 */
export function rankCandidates(currentTab, allTabs) {
  const currentCanon = canonicalizeUrl(currentTab.url ?? '');
  if (!currentCanon.ok) return [];

  const candidates = allTabs.filter((t) => {
    if (t.id === currentTab.id) return false;
    if (t.windowId !== currentTab.windowId) return false;
    const canon = canonicalizeUrl(t.url ?? '');
    if (!canon.ok) return false;
    if (canon.url !== currentCanon.url) return false;
    // Exclude tabs already in a pair (accessed via shared in-memory store).
    if (getPairByTabId(t.id) !== undefined) return false;
    return true;
  });

  candidates.sort((a, b) => {
    // Prefer tab sharing the same split view as currentTab.
    const currentSplit = currentTab.splitViewId || null;
    const aInSplit = currentSplit && a.splitViewId === currentSplit ? 0 : 1;
    const bInSplit = currentSplit && b.splitViewId === currentSplit ? 0 : 1;
    if (aInSplit !== bInSplit) return aInSplit - bInSplit;
    // Older tab (lower index) preferred.
    if (a.index !== b.index) return a.index - b.index;
    // Lowest tab id as final tiebreaker.
    return a.id - b.id;
  });

  return candidates;
}

/**
 * Opens a duplicate tab for the given URL in the same window and waits for it
 * to finish loading.
 * @param {string} url
 * @param {number} windowId
 * @returns {Promise<TabLike>}
 */
async function openDuplicateTab(url, windowId) {
  const created = await browser.tabs.create({ url, windowId });
  return new Promise((resolve) => {
    function onUpdated(tabId, changeInfo, updatedTab) {
      if (tabId === created.id && changeInfo.status === 'complete') {
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve(updatedTab);
      }
    }
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Pairs the given tab with a matching sibling. If no sibling exists in the
 * same window, opens a duplicate tab and pairs with it.
 *
 * Returns { ok: true, pairId } on success, { ok: false, reason } on failure.
 * @param {number} tabId
 * @returns {Promise<{ ok: true, pairId: string } | { ok: false, reason: string }>}
 */
export async function handlePairCurrentTab(tabId) {
  const currentPair = getPairByTabId(tabId);
  if (currentPair) {
    return { ok: false, reason: 'tab-already-paired' };
  }

  let currentTab;
  try {
    currentTab = await browser.tabs.get(tabId);
  } catch {
    return { ok: false, reason: 'tab-not-found' };
  }

  const urlCheck = canonicalizeUrl(currentTab.url ?? '');
  if (!urlCheck.ok) {
    return { ok: false, reason: urlCheck.reason };
  }

  const allTabs = await browser.tabs.query({ windowId: currentTab.windowId });
  const candidates = rankCandidates(currentTab, allTabs);

  let siblingTab;
  if (candidates.length > 0) {
    siblingTab = candidates[0];
  } else {
    // No matching sibling — open a duplicate and pair with it.
    siblingTab = await openDuplicateTab(currentTab.url, currentTab.windowId);
  }

  const result = createPair(tabId, siblingTab.id, currentTab.url);
  if (!result.ok) {
    return result;
  }

  addPair(result.pair);
  flushPairsToStorage().catch(console.error);

  // Notify both content scripts of their new pair context.
  await Promise.allSettled([
    notifyTabPairContext(tabId, result.pair.pairId),
    notifyTabPairContext(siblingTab.id, result.pair.pairId),
  ]);

  return { ok: true, pairId: result.pair.pairId };
}

/**
 * Removes the pair containing the given tab.
 * @param {number} tabId
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function handleUnpairTab(tabId) {
  const pair = getPairByTabId(tabId);
  if (!pair) {
    return { ok: false, reason: 'tab-not-paired' };
  }
  invalidatePair(pair);
  return { ok: true };
}

/**
 * Returns the pairing status of the given tab for display in the popup.
 *
 * For paired tabs, also probes whether the content script is reachable.
 * If the probe fails (e.g. content script blocked, PDF, privileged page),
 * syncAvailable is false and the popup should warn the user.
 *
 * @param {number} tabId
 * @param {string | undefined} tabUrl - Current URL of the tab (for invalid-page detection).
 * @returns {Promise<import('../shared/messages.js').PairStatusResponse>}
 */
export async function handleGetPairStatus(tabId, tabUrl) {
  const urlCheck = canonicalizeUrl(tabUrl ?? '');
  if (!urlCheck.ok) {
    return { status: 'invalid-page', pairId: null, siblingTabId: null, paused: false, pauseReason: null, syncAvailable: false };
  }

  const pair = getPairByTabId(tabId);
  if (!pair) {
    return { status: 'unpaired', pairId: null, siblingTabId: null, paused: false, pauseReason: null, syncAvailable: true };
  }

  const siblingTabId = pair.tabA === tabId ? pair.tabB : pair.tabA;
  const status = pair.sourceTabId === tabId ? 'paired-source' : 'paired-sibling';

  // Probe this tab's content script to detect blocked injection or restricted pages.
  let syncAvailable = true;
  try {
    await browser.tabs.sendMessage(tabId, {
      type: MessageType.GET_SCROLL_METRICS,
      pairId: pair.pairId,
      syncToken: pair.syncToken,
    });
  } catch {
    syncAvailable = false;
  }

  return {
    status,
    pairId: pair.pairId,
    siblingTabId,
    paused: pair.paused,
    pauseReason: pair.pauseReason,
    syncAvailable,
  };
}

/**
 * Pauses scroll sync for the pair containing the given tab.
 * Sets pauseReason to 'user' so the user can resume later.
 * @param {number} tabId
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function handlePauseSync(tabId) {
  const pair = getPairByTabId(tabId);
  if (!pair) return { ok: false, reason: 'tab-not-paired' };
  if (pair.paused) return { ok: false, reason: 'already-paused' };
  pair.paused = true;
  pair.pauseReason = 'user';
  flushPairsToStorage().catch(console.error);
  return { ok: true };
}

/**
 * Resumes scroll sync for the pair containing the given tab.
 * Clears the pauseReason regardless of what caused the pause.
 * @param {number} tabId
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function handleResumeSync(tabId) {
  const pair = getPairByTabId(tabId);
  if (!pair) return { ok: false, reason: 'tab-not-paired' };
  if (!pair.paused) return { ok: false, reason: 'not-paused' };
  pair.paused = false;
  pair.pauseReason = null;
  flushPairsToStorage().catch(console.error);
  return { ok: true };
}

/**
 * Handles tabs.onRemoved: remove any pair containing the closed tab.
 * @param {number} tabId
 */
export function handleTabRemoved(tabId) {
  const pair = getPairByTabId(tabId);
  if (!pair) return;
  invalidatePair(pair);
}

/**
 * Handles tabs.onUpdated: clean up pairs when URL changes invalidate matching,
 * or re-register pair context when a paired tab finishes reloading to the same URL.
 * @param {number} tabId
 * @param {{ url?: string, status?: string }} changeInfo
 * @returns {Promise<void>}
 */
export async function handleTabUpdated(tabId, changeInfo) {
  const pair = getPairByTabId(tabId);
  if (!pair) return;

  if (changeInfo.url !== undefined && !urlsMatch(changeInfo.url, pair.canonicalUrl)) {
    invalidatePair(pair);
    return;
  }

  if (changeInfo.status === 'complete') {
    notifyTabPairContext(tabId, pair.pairId).catch(() => {});
  }
}

/**
 * Handles tabs.onReplaced: Firefox replaces tab IDs during prerender/discard.
 * If the removed tab was in a pair, update its ID if the replacement still
 * matches the pair's canonical URL, otherwise remove the pair.
 * @param {number} addedTabId
 * @param {number} removedTabId
 */
export async function handleTabReplaced(addedTabId, removedTabId) {
  const pair = getPairByTabId(removedTabId);
  if (!pair) return;

  let addedTab;
  try {
    addedTab = await browser.tabs.get(addedTabId);
  } catch {
    invalidatePair(pair);
    return;
  }

  if (!urlsMatch(addedTab.url ?? '', pair.canonicalUrl)) {
    invalidatePair(pair);
    return;
  }

  replaceTabId(removedTabId, addedTabId);
  flushPairsToStorage().catch(console.error);
  // Re-register the replacement tab with its pair context.
  notifyTabPairContext(addedTabId, pair.pairId).catch(() => {});
}

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
  getAllPairs,
  getPairByTabId,
  replaceTabId,
} from './pairState.js';
import { flushPairsToStorage } from './storage.js';
import { notifyTabPairContext, clearOscillationLog } from './syncCoordinator.js';
import { MessageType } from '../shared/messages.js';
import { getSyncSettings } from './settings.js';
import { ext, getSplitViewId, isSplitViewTab } from '../shared/ext.js';

const { tabs } = ext;

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
      const [tabA, tabB] = await Promise.all([tabs.get(pair.tabA), tabs.get(pair.tabB)]);
      if (tabA.windowId !== tabB.windowId) continue;
      if (!urlsMatch(tabA.url ?? '', pair.canonicalUrl)) continue;
      if (!urlsMatch(tabB.url ?? '', pair.canonicalUrl)) continue;
      if (pair.paused && pair.pauseReason === 'oscillation') {
        pair.paused = false;
        pair.pauseReason = null;
      }
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
 * A tab object from the tabs API with the fields used by this module.
 * @typedef {Object} TabLike
 * @property {number} id
 * @property {number} windowId
 * @property {string | undefined} url
 * @property {number} index
 * @property {number | null | undefined} [splitViewId]
 */

/**
 * Returns candidate tabs ranked by the deterministic precedence rules:
 *   1. same splitViewId (when present)
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
    const currentSplit = getSplitViewId(currentTab);
    const hasSplit = currentSplit !== null;
    const aInSplit = hasSplit && getSplitViewId(a) === currentSplit ? 0 : 1;
    const bInSplit = hasSplit && getSplitViewId(b) === currentSplit ? 0 : 1;
    if (aInSplit !== bInSplit) return aInSplit - bInSplit;
    // Older tab (lower index) preferred.
    if (a.index !== b.index) return a.index - b.index;
    // Lowest tab id as final tiebreaker.
    return a.id - b.id;
  });

  return candidates;
}

/**
 * Opens a duplicate tab for the current tab and waits for it
 * to finish loading.
 * Falls back to creating a same-URL tab when the duplicate API is unavailable.
 * @param {TabLike} currentTab
 * @returns {Promise<TabLike>}
 */
async function openDuplicateTab(currentTab) {
  let created = await tabs.duplicate(currentTab.id);
  if (!created) {
    created = await tabs.create({ url: currentTab.url, windowId: currentTab.windowId });
  }

  if (!created) {
    throw new Error('Could not open duplicate tab.');
  }

  if (created.status === 'complete') {
    return created;
  }

  return new Promise((resolve) => {
    function onUpdated(tabId, changeInfo, updatedTab) {
      if (tabId === created.id && changeInfo.status === 'complete') {
        tabs.onUpdated.removeListener(onUpdated);
        resolve(updatedTab);
      }
    }
    tabs.onUpdated.addListener(onUpdated);
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
    currentTab = await tabs.get(tabId);
  } catch {
    return { ok: false, reason: 'tab-not-found' };
  }

  const urlCheck = canonicalizeUrl(currentTab.url ?? '');
  if (!urlCheck.ok) {
    return { ok: false, reason: urlCheck.reason };
  }

  const allTabs = await tabs.query({ windowId: currentTab.windowId });
  const candidates = rankCandidates(currentTab, allTabs);

  let siblingTab;
  if (candidates.length > 0) {
    siblingTab = candidates[0];
  } else {
    // No matching sibling — open a duplicate and pair with it.
    siblingTab = await openDuplicateTab(currentTab);
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
 * Auto-pairs the two tabs in a split view when they resolve to the same canonical URL.
 * This is idempotent: if either tab is already paired, no action is taken.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} true when a new pair was created
 */
async function maybeAutoPairSplitViewTab(tabId) {
  let currentTab;
  try {
    currentTab = await tabs.get(tabId);
  } catch {
    return false;
  }

  if (!isSplitViewTab(currentTab)) {
    return false;
  }

  if (getPairByTabId(currentTab.id)) {
    return false;
  }

  const splitTabs = await tabs.query({
    windowId: currentTab.windowId,
    splitViewId: getSplitViewId(currentTab),
  });

  if (splitTabs.length !== 2) {
    return false;
  }

  const [tabA, tabB] = splitTabs;
  if (getPairByTabId(tabA.id) || getPairByTabId(tabB.id)) {
    return false;
  }

  const urlA = canonicalizeUrl(tabA.url ?? '');
  const urlB = canonicalizeUrl(tabB.url ?? '');
  if (!urlA.ok || !urlB.ok || urlA.url !== urlB.url) {
    return false;
  }

  if (tabA.status !== 'complete' || tabB.status !== 'complete') {
    return false;
  }

  const result = createPair(tabA.id, tabB.id, tabA.url);
  if (!result.ok) {
    return false;
  }

  addPair(result.pair);
  flushPairsToStorage().catch(console.error);

  await Promise.allSettled([
    notifyTabPairContext(tabA.id, result.pair.pairId),
    notifyTabPairContext(tabB.id, result.pair.pairId),
  ]);

  return true;
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
  const { adaptiveArticleOverlap, pageKeyOverrideEnabled } = getSyncSettings();
  const urlCheck = canonicalizeUrl(tabUrl ?? '');
  if (!urlCheck.ok) {
    return {
      status: 'invalid-page',
      pairId: null,
      siblingTabId: null,
      paused: false,
      pauseReason: null,
      syncAvailable: false,
      adaptiveArticleOverlap,
      pageKeyOverrideEnabled,
    };
  }

  const pair = getPairByTabId(tabId);
  if (!pair) {
    return {
      status: 'unpaired',
      pairId: null,
      siblingTabId: null,
      paused: false,
      pauseReason: null,
      syncAvailable: true,
      adaptiveArticleOverlap,
      pageKeyOverrideEnabled,
    };
  }

  const siblingTabId = pair.tabA === tabId ? pair.tabB : pair.tabA;
  const status = pair.sourceTabId === tabId ? 'paired-source' : 'paired-sibling';

  // Probe this tab's content script to detect blocked injection or restricted pages.
  let syncAvailable = true;
  let probeMetrics = null;
  try {
    probeMetrics = await tabs.sendMessage(tabId, {
      type: MessageType.GET_SCROLL_METRICS,
      pairId: pair.pairId,
      syncToken: pair.syncToken,
      includeReadingMetrics: adaptiveArticleOverlap,
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
    adaptiveArticleOverlap,
    pageKeyOverrideEnabled,
    adaptiveDebug:
      adaptiveArticleOverlap && probeMetrics
        ? {
            articleDetected: probeMetrics.articleDetected === true,
            articleLineHeight: probeMetrics.articleLineHeight ?? null,
            articleSampleCount: probeMetrics.articleSampleCount ?? 0,
            topOcclusionPx: probeMetrics.topOcclusionPx ?? 0,
            bottomOcclusionPx: probeMetrics.bottomOcclusionPx ?? 0,
            effectiveViewportHeight: probeMetrics.effectiveViewportHeight ?? null,
            estimatedOverlapPx: probeMetrics.estimatedOverlapPx ?? null,
          }
        : null,
  };
}

/**
 * Re-sends pair context to all currently paired tabs so content scripts can pick
 * up updated sync settings without breaking the pair.
 * @returns {Promise<void>}
 */
export async function refreshAllPairContexts() {
  const pairContextNotifications = [];
  for (const pair of getAllPairs()) {
    pairContextNotifications.push(notifyTabPairContext(pair.tabA, pair.pairId));
    pairContextNotifications.push(notifyTabPairContext(pair.tabB, pair.pairId));
  }
  await Promise.allSettled(pairContextNotifications);
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
 * Resumes a pair only when it is paused for a legacy oscillation reason.
 * User-initiated pauses are preserved.
 * @param {number} tabId
 * @returns {boolean} true when a paused pair was resumed
 */
export function handleResumeOscillationPause(tabId) {
  const pair = getPairByTabId(tabId);
  if (!pair || !pair.paused || pair.pauseReason !== 'oscillation') {
    return false;
  }
  pair.paused = false;
  pair.pauseReason = null;
  flushPairsToStorage().catch(console.error);
  return true;
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
 * @param {{ url?: string, status?: string, splitViewId?: number | null }} changeInfo
 * @returns {Promise<void>}
 */
export async function handleTabUpdated(tabId, changeInfo) {
  const pair = getPairByTabId(tabId);
  if (!pair) {
    const splitViewChanged = changeInfo.splitViewId !== undefined;
    const urlChanged = changeInfo.url !== undefined;
    const loadCompleted = changeInfo.status === 'complete';

    if (splitViewChanged || urlChanged || loadCompleted) {
      await maybeAutoPairSplitViewTab(tabId);
    }
    return;
  }

  if (changeInfo.url !== undefined && !urlsMatch(changeInfo.url, pair.canonicalUrl)) {
    invalidatePair(pair);
    return;
  }

  if (changeInfo.status === 'complete') {
    notifyTabPairContext(tabId, pair.pairId).catch(() => {});
  }
}

/**
 * Handles tabs.onReplaced: some browsers replace tab IDs during prerender/discard.
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
    addedTab = await tabs.get(addedTabId);
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

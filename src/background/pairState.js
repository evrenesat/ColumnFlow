/**
 * Authoritative in-memory pair state store.
 *
 * All pair state mutations go through this module. Storage is written
 * asynchronously after mutations; reads always use this in-memory map
 * to avoid storage read-modify-write races.
 */

import { canonicalizeUrl } from '../shared/canonicalUrl.js';

/**
 * @typedef {'user' | 'oscillation' | null} PauseReason
 *
 * @typedef {Object} PairState
 * @property {string} pairId - Unique pair identifier derived from tab IDs.
 * @property {number} tabA - First tab ID.
 * @property {number} tabB - Second tab ID.
 * @property {string} canonicalUrl - Canonical URL both tabs must match.
 * @property {number} sourceTabId - Tab currently acting as the scroll source (tabA or tabB).
 * @property {boolean} enabled - Whether scroll sync is active.
 * @property {boolean} paused - Whether sync is paused.
 * @property {PauseReason} pauseReason - Reason for the current pause, or null.
 * @property {number} syncToken - Monotonic counter incremented on each outbound APPLY_SCROLL.
 * @property {number} createdAt - Unix timestamp (ms) of pair creation.
 * @property {number} lastSyncAt - Unix timestamp (ms) of last successful sync.
 */

/** In-memory authoritative pair store. Keys are pairId strings. */
const pairsByPairId = new Map();

/** Maps individual tab IDs to their pair ID for O(1) lookup. */
const pairIdByTabId = new Map();

/**
 * Creates a deterministic pair ID from two tab IDs.
 * Always stable regardless of argument order.
 * @param {number} tabA
 * @param {number} tabB
 * @returns {string}
 */
export function makePairId(tabA, tabB) {
  const [lo, hi] = tabA < tabB ? [tabA, tabB] : [tabB, tabA];
  return `pair-${lo}-${hi}`;
}

/**
 * Constructs a new PairState object without adding it to the store.
 * Returns an error result if the URL is unsupported or either tab is already paired.
 * @param {number} tabA
 * @param {number} tabB
 * @param {string} rawUrl
 * @returns {{ ok: true, pair: PairState } | { ok: false, reason: string }}
 */
export function createPair(tabA, tabB, rawUrl) {
  if (pairIdByTabId.has(tabA) || pairIdByTabId.has(tabB)) {
    return { ok: false, reason: 'tab-already-paired' };
  }
  const urlResult = canonicalizeUrl(rawUrl);
  if (!urlResult.ok) {
    return { ok: false, reason: urlResult.reason };
  }
  /** @type {PairState} */
  const pair = {
    pairId: makePairId(tabA, tabB),
    tabA,
    tabB,
    canonicalUrl: urlResult.url,
    sourceTabId: tabA,
    enabled: true,
    paused: false,
    pauseReason: null,
    syncToken: 0,
    createdAt: Date.now(),
    lastSyncAt: 0,
  };
  return { ok: true, pair };
}

/**
 * Registers a pair in the store. Overwrites any existing entry with the same pairId.
 * @param {PairState} pair
 */
export function addPair(pair) {
  pairsByPairId.set(pair.pairId, pair);
  pairIdByTabId.set(pair.tabA, pair.pairId);
  pairIdByTabId.set(pair.tabB, pair.pairId);
}

/**
 * Removes a pair from the store by pair ID.
 * @param {string} pairId
 * @returns {boolean} true if the pair existed and was removed
 */
export function removePair(pairId) {
  const pair = pairsByPairId.get(pairId);
  if (!pair) return false;
  pairIdByTabId.delete(pair.tabA);
  pairIdByTabId.delete(pair.tabB);
  pairsByPairId.delete(pairId);
  return true;
}

/**
 * Returns the pair for a given tab ID, or undefined if the tab is not paired.
 * @param {number} tabId
 * @returns {PairState | undefined}
 */
export function getPairByTabId(tabId) {
  const pairId = pairIdByTabId.get(tabId);
  return pairId !== undefined ? pairsByPairId.get(pairId) : undefined;
}

/**
 * Returns the pair for a given pair ID, or undefined.
 * @param {string} pairId
 * @returns {PairState | undefined}
 */
export function getPairById(pairId) {
  return pairsByPairId.get(pairId);
}

/**
 * Returns all current pairs as a snapshot array.
 * @returns {PairState[]}
 */
export function getAllPairs() {
  return Array.from(pairsByPairId.values());
}

/**
 * Replaces all in-memory pair state with data loaded from storage.
 * @param {PairState[]} pairs
 */
export function hydratePairs(pairs) {
  pairsByPairId.clear();
  pairIdByTabId.clear();
  for (const pair of pairs) {
    addPair(pair);
  }
}

/**
 * Increments the syncToken for a pair and returns the new value.
 * Returns undefined if the pair does not exist.
 * @param {string} pairId
 * @returns {number | undefined}
 */
export function nextSyncToken(pairId) {
  const pair = pairsByPairId.get(pairId);
  if (!pair) return undefined;
  pair.syncToken += 1;
  return pair.syncToken;
}

/**
 * Updates the tab ID in a pair when Firefox replaces a tab (prerender/discard).
 * Also updates sourceTabId if the replaced tab was the source.
 * Returns false if the old tab ID is not part of any pair.
 * @param {number} oldTabId
 * @param {number} newTabId
 * @returns {boolean}
 */
export function replaceTabId(oldTabId, newTabId) {
  const pairId = pairIdByTabId.get(oldTabId);
  if (!pairId) return false;
  const pair = pairsByPairId.get(pairId);
  if (!pair) return false;
  pairIdByTabId.delete(oldTabId);
  pairIdByTabId.set(newTabId, pairId);
  if (pair.tabA === oldTabId) pair.tabA = newTabId;
  else if (pair.tabB === oldTabId) pair.tabB = newTabId;
  if (pair.sourceTabId === oldTabId) pair.sourceTabId = newTabId;
  return true;
}

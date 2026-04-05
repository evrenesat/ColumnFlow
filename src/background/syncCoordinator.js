/**
 * Scroll sync coordinator.
 *
 * Handles SCROLL_EVENT messages from content scripts, computes the continuum
 * target position for the sibling tab, manages source ownership, and detects
 * oscillation. Also provides the helper to notify content scripts of their
 * pair context via SET_PAIR_CONTEXT.
 */

import { MessageType } from '../shared/messages.js';
import { getPairByTabId, nextSyncToken } from './pairState.js';
import { flushPairsToStorage } from './storage.js';
import { debugLog } from '../shared/debug.js';

/** Pixel overlap kept visible in both tabs for reading continuity. */
const OVERLAP_PX = 32;

/**
 * Two ownership switches within this window (ms) trigger an oscillation pause.
 * Must be a named constant; do not use a magic number.
 */
const OSCILLATION_DETECT_MS = 500;

/**
 * Per-pair ownership-switch timestamp history.
 * Keys are pairId strings; values are arrays of switch timestamps (ms).
 * Only timestamps within the last OSCILLATION_DETECT_MS are retained.
 * @type {Map<string, number[]>}
 */
const ownershipSwitchLog = new Map();

/**
 * Computes the target scrollY for the sibling tab using the continuum formula.
 *
 * Formula: targetScrollY = source.scrollY + source.innerHeight - OVERLAP_PX
 * Clamped to [0, siblingMaxScroll].
 *
 * If source.scrollHeight !== sibling.scrollHeight the formula still applies;
 * the caller is responsible for logging a warning before calling this.
 *
 * @param {{ scrollY: number, innerHeight: number }} source
 * @param {{ scrollHeight: number, clientHeight: number }} sibling
 * @returns {number}
 */
export function computeTargetScroll(source, sibling) {
  const rawTarget = source.scrollY + source.innerHeight - OVERLAP_PX;
  const siblingMaxScroll = Math.max(0, sibling.scrollHeight - sibling.clientHeight);
  return Math.max(0, Math.min(rawTarget, siblingMaxScroll));
}

/**
 * Records an ownership switch for the given pair and returns true when two
 * switches have occurred within OSCILLATION_DETECT_MS (oscillation detected).
 *
 * Accepts an optional `now` parameter for deterministic unit testing.
 *
 * @param {string} pairId
 * @param {number} [now]
 * @returns {boolean}
 */
export function recordSwitchAndCheckOscillation(pairId, now = Date.now()) {
  const history = ownershipSwitchLog.get(pairId) ?? [];
  const recent = history.filter((t) => now - t <= OSCILLATION_DETECT_MS);
  recent.push(now);
  ownershipSwitchLog.set(pairId, recent);
  return recent.length >= 2;
}

/**
 * Removes oscillation tracking data for a pair. Call when a pair is removed.
 * @param {string} pairId
 */
export function clearOscillationLog(pairId) {
  ownershipSwitchLog.delete(pairId);
}

/**
 * Handles a SCROLL_EVENT received from a content script.
 *
 * - If the event is from the current source tab, syncs the sibling immediately.
 * - If from the non-source tab, attempts an ownership switch before syncing.
 * - Detects oscillation and pauses the pair if two switches occur too rapidly.
 *
 * @param {number} tabId - Tab ID of the scrolling content script (from sender).
 * @param {{ scrollY: number, innerHeight: number, scrollHeight: number, clientHeight: number }} scrollMetrics
 */
export async function handleScrollEvent(tabId, scrollMetrics) {
  const pair = getPairByTabId(tabId);
  if (!pair || !pair.enabled || pair.paused) return;

  if (pair.sourceTabId !== tabId) {
    const oscillating = recordSwitchAndCheckOscillation(pair.pairId);
    if (oscillating) {
      pair.paused = true;
      pair.pauseReason = 'oscillation';
      flushPairsToStorage().catch(console.error);
      console.warn(`[split-scroll] Pair ${pair.pairId}: oscillation detected, sync paused.`);
      return;
    }
    pair.sourceTabId = tabId;
    debugLog(`Pair ${pair.pairId}: ownership switched to tab ${tabId}.`);
    flushPairsToStorage().catch(console.error);
  }

  const siblingTabId = pair.tabA === tabId ? pair.tabB : pair.tabA;

  let siblingMetrics;
  try {
    siblingMetrics = await browser.tabs.sendMessage(siblingTabId, {
      type: MessageType.GET_SCROLL_METRICS,
      pairId: pair.pairId,
      syncToken: pair.syncToken,
    });
  } catch {
    return;
  }

  if (!siblingMetrics) return;

  if (scrollMetrics.scrollHeight !== siblingMetrics.scrollHeight) {
    console.warn(
      `[split-scroll] Pair ${pair.pairId}: source scrollHeight ${scrollMetrics.scrollHeight}` +
        ` != sibling scrollHeight ${siblingMetrics.scrollHeight}. Applying formula with clamping.`
    );
  }

  const targetScrollY = computeTargetScroll(scrollMetrics, siblingMetrics);
  const token = nextSyncToken(pair.pairId);
  pair.lastSyncAt = Date.now();

  try {
    await browser.tabs.sendMessage(siblingTabId, {
      type: MessageType.APPLY_SCROLL,
      pairId: pair.pairId,
      targetScrollY,
      syncToken: token,
    });
  } catch {
    // Sibling content script not reachable — not fatal.
  }
}

/**
 * Sends SET_PAIR_CONTEXT to a tab's content script to register or clear a pair.
 * Failures are silently ignored; the content script may not be ready yet.
 * @param {number} tabId
 * @param {string | null} pairId
 * @returns {Promise<void>}
 */
export async function notifyTabPairContext(tabId, pairId) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: MessageType.SET_PAIR_CONTEXT,
      pairId,
    });
  } catch {
    // Content script not ready — acceptable.
  }
}

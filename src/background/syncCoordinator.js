/**
 * Scroll sync coordinator.
 *
 * Handles SCROLL_EVENT messages from content scripts, computes the continuum
 * target position for the sibling tab, manages source ownership, and detects
 * rapid ownership switching for diagnostics. Also provides the helper to
 * notify content scripts of their pair context via SET_PAIR_CONTEXT.
 */

import { MessageType } from '../shared/messages.js';
import { getPairByTabId, nextSyncToken } from './pairState.js';
import { flushPairsToStorage } from './storage.js';
import { getSyncSettings } from './settings.js';
import { debugLog } from '../shared/debug.js';

/** Pixel overlap kept visible in both tabs for reading continuity. */
const OVERLAP_PX = 32;
const MAX_ADAPTIVE_OVERLAP_PX = 48;

/** Recent ownership switches retained for oscillation diagnostics. */
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
  const sourceViewportHeight = source.effectiveViewportHeight ?? source.innerHeight;
  const overlapPx = source.overlapPx ?? OVERLAP_PX;
  const rawTarget = source.scrollY + sourceViewportHeight - overlapPx;
  const siblingMaxScroll = Math.max(0, sibling.scrollHeight - sibling.clientHeight);
  return Math.max(0, Math.min(rawTarget, siblingMaxScroll));
}

function isReasonableLineHeight(value) {
  return Number.isFinite(value) && value >= 12 && value <= 48;
}

function isReasonableViewportHeight(value, innerHeight) {
  return Number.isFinite(value) && value >= innerHeight * 0.5 && value <= innerHeight;
}

/**
 * Derives a safer article overlap from measured typography. Returns null when the
 * page does not look like a reliably measurable reading view.
 *
 * @param {import('../shared/messages.js').ScrollMetricsResponse | import('../shared/messages.js').ScrollEventMessage} source
 * @param {import('../shared/messages.js').ScrollMetricsResponse} sibling
 * @returns {{ overlapPx: number, effectiveViewportHeight: number } | null}
 */
export function deriveAdaptiveScrollSettings(source, sibling) {
  if (!source.articleDetected || !sibling.articleDetected) {
    return null;
  }

  if (!isReasonableLineHeight(source.articleLineHeight) || !isReasonableLineHeight(sibling.articleLineHeight)) {
    return null;
  }

  const effectiveViewportHeight = isReasonableViewportHeight(
    source.effectiveViewportHeight,
    source.innerHeight
  )
    ? Math.round(source.effectiveViewportHeight)
    : source.innerHeight;

  const overlapPx = Math.max(
    OVERLAP_PX,
    Math.min(
      MAX_ADAPTIVE_OVERLAP_PX,
      Math.round(Math.max(source.articleLineHeight, sibling.articleLineHeight) * 1.35)
    )
  );

  return { overlapPx, effectiveViewportHeight };
}

/**
 * Records an ownership switch for the given pair and returns true when two
 * switches have occurred within OSCILLATION_DETECT_MS.
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
 * - Tracks rapid ownership switching for diagnostics without auto-pausing sync.
 *
 * @param {number} tabId - Tab ID of the scrolling content script (from sender).
 * @param {{ scrollY: number, innerHeight: number, scrollHeight: number, clientHeight: number }} scrollMetrics
 */
export async function handleScrollEvent(tabId, scrollMetrics) {
  const pair = getPairByTabId(tabId);
  if (!pair || !pair.enabled || pair.paused) return;
  const { adaptiveArticleOverlap } = getSyncSettings();

  if (pair.sourceTabId !== tabId) {
    const oscillating = recordSwitchAndCheckOscillation(pair.pairId);
    if (oscillating) {
      console.warn(
        `[split-scroll] Pair ${pair.pairId}: rapid ownership switching detected; continuing sync.`
      );
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
      includeReadingMetrics: adaptiveArticleOverlap,
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

  const adaptiveSettings = adaptiveArticleOverlap
    ? deriveAdaptiveScrollSettings(scrollMetrics, siblingMetrics)
    : null;

  const targetScrollY = computeTargetScroll(
    adaptiveSettings
      ? {
          ...scrollMetrics,
          overlapPx: adaptiveSettings.overlapPx,
          effectiveViewportHeight: adaptiveSettings.effectiveViewportHeight,
        }
      : scrollMetrics,
    siblingMetrics
  );
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
    const { adaptiveArticleOverlap, pageKeyOverrideEnabled } = getSyncSettings();
    const pair = pairId ? getPairByTabId(tabId) : undefined;
    await browser.tabs.sendMessage(tabId, {
      type: MessageType.SET_PAIR_CONTEXT,
      pairId,
      adaptiveArticleOverlap,
      pageKeyOverrideEnabled,
      syncActive: pairId !== null && pair?.enabled === true && pair?.paused !== true,
    });
  } catch {
    // Content script not ready — acceptable.
  }
}

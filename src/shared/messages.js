/**
 * Message type constants and JSDoc typedefs for the content-script ↔ background protocol.
 *
 * All messages include pairId for routing and syncToken for echo suppression.
 */

/** Message types used between content scripts and the background service worker. */
export const MessageType = Object.freeze({
  /** Background → content script: request current scroll metrics. */
  GET_SCROLL_METRICS: 'GET_SCROLL_METRICS',

  /** Background → content script: apply a remote scroll position. */
  APPLY_SCROLL: 'APPLY_SCROLL',

  /** Content script → background: trusted user scroll event occurred. */
  SCROLL_EVENT: 'SCROLL_EVENT',

  /** Background → content script: register or unregister a pair context. */
  SET_PAIR_CONTEXT: 'SET_PAIR_CONTEXT',

  /** Popup → background: pair the active tab with a matching sibling (or open duplicate). */
  PAIR_CURRENT_TAB: 'PAIR_CURRENT_TAB',

  /** Popup → background: remove the pair for the active tab. */
  UNPAIR_TAB: 'UNPAIR_TAB',

  /** Popup → background: get the current pairing status for the active tab. */
  GET_PAIR_STATUS: 'GET_PAIR_STATUS',

  /** Popup → background: enable or disable adaptive article overlap. */
  SET_ADAPTIVE_ARTICLE_OVERLAP: 'SET_ADAPTIVE_ARTICLE_OVERLAP',

  /** Popup → background: enable or disable PageUp/PageDown override. */
  SET_PAGE_KEY_OVERRIDE: 'SET_PAGE_KEY_OVERRIDE',

  /** Popup → background: pause scroll sync for the current tab pair. */
  PAUSE_SYNC: 'PAUSE_SYNC',

  /** Popup → background: resume scroll sync for the current tab pair. */
  RESUME_SYNC: 'RESUME_SYNC',
});

/**
 * Sent from background to content script to read current scroll metrics.
 * @typedef {Object} GetScrollMetricsMessage
 * @property {'GET_SCROLL_METRICS'} type
 * @property {string} pairId
 * @property {number} syncToken
 * @property {boolean} [includeReadingMetrics]
 */

/**
 * Response to GET_SCROLL_METRICS.
 * @typedef {Object} ScrollMetricsResponse
 * @property {number} scrollY
 * @property {number} innerHeight
 * @property {number} scrollHeight
 * @property {number} clientHeight
 * @property {boolean} documentReady
 * @property {boolean} [articleDetected]
 * @property {number | null} [articleLineHeight]
 * @property {number} [articleSampleCount]
 * @property {number} [topOcclusionPx]
 * @property {number} [bottomOcclusionPx]
 * @property {number} [effectiveViewportHeight]
 * @property {number | null} [estimatedOverlapPx]
 */

/**
 * Sent from background to content script to apply a remote scroll position.
 * @typedef {Object} ApplyScrollMessage
 * @property {'APPLY_SCROLL'} type
 * @property {string} pairId
 * @property {number} targetScrollY
 * @property {number} syncToken
 */

/**
 * Acknowledgement returned by content script after applying a remote scroll.
 * @typedef {Object} ApplyScrollAck
 * @property {boolean} applied
 * @property {number} syncToken
 */

/**
 * Sent from content script to background when a trusted local scroll occurs.
 * @typedef {Object} ScrollEventMessage
 * @property {'SCROLL_EVENT'} type
 * @property {string} pairId
 * @property {number} scrollY
 * @property {number} innerHeight
 * @property {number} scrollHeight
 * @property {number} clientHeight
 * @property {number} timestamp
 * @property {number} syncToken - Last syncToken received from background (for echo detection).
 * @property {boolean} [articleDetected]
 * @property {number | null} [articleLineHeight]
 * @property {number} [articleSampleCount]
 * @property {number} [topOcclusionPx]
 * @property {number} [bottomOcclusionPx]
 * @property {number} [effectiveViewportHeight]
 * @property {number | null} [estimatedOverlapPx]
 */

/**
 * Sent from popup to background to pair the current tab.
 * @typedef {Object} PairCurrentTabMessage
 * @property {'PAIR_CURRENT_TAB'} type
 * @property {number} tabId - The active tab to pair.
 */

/**
 * Response to PAIR_CURRENT_TAB.
 * @typedef {{ ok: true, pairId: string } | { ok: false, reason: string }} PairCurrentTabResponse
 */

/**
 * Sent from popup to background to remove the pair for the current tab.
 * @typedef {Object} UnpairTabMessage
 * @property {'UNPAIR_TAB'} type
 * @property {number} tabId - Tab whose pair should be removed.
 */

/**
 * Response to UNPAIR_TAB.
 * @typedef {{ ok: true } | { ok: false, reason: string }} UnpairTabResponse
 */

/**
 * Sent from background to content script to register or unregister a pair.
 * Content script uses pairId=null to clear its pair context (unpaired).
 * @typedef {Object} SetPairContextMessage
 * @property {'SET_PAIR_CONTEXT'} type
 * @property {string | null} pairId - Pair ID to register, or null to unregister.
 * @property {boolean} adaptiveArticleOverlap
 * @property {boolean} pageKeyOverrideEnabled
 * @property {boolean} syncActive
 */

/**
 * Sent from popup to background to query current pairing status.
 * @typedef {Object} GetPairStatusMessage
 * @property {'GET_PAIR_STATUS'} type
 * @property {number} tabId - Tab to query.
 */

/**
 * Sent from popup to background to enable or disable adaptive article overlap.
 * @typedef {Object} SetAdaptiveArticleOverlapMessage
 * @property {'SET_ADAPTIVE_ARTICLE_OVERLAP'} type
 * @property {boolean} enabled
 */

/**
 * Response to SET_ADAPTIVE_ARTICLE_OVERLAP.
 * @typedef {{ ok: true, adaptiveArticleOverlap: boolean, pageKeyOverrideEnabled: boolean } | { ok: false, reason: string }} SetAdaptiveArticleOverlapResponse
 */

/**
 * Sent from popup to background to enable or disable PageUp/PageDown override.
 * @typedef {Object} SetPageKeyOverrideMessage
 * @property {'SET_PAGE_KEY_OVERRIDE'} type
 * @property {boolean} enabled
 */

/**
 * Response to SET_PAGE_KEY_OVERRIDE.
 * @typedef {{ ok: true, adaptiveArticleOverlap: boolean, pageKeyOverrideEnabled: boolean } | { ok: false, reason: string }} SetPageKeyOverrideResponse
 */

/**
 * Sent from popup to background to pause scroll sync for the current tab pair.
 * @typedef {Object} PauseSyncMessage
 * @property {'PAUSE_SYNC'} type
 * @property {number} tabId - Tab whose pair should be paused.
 */

/**
 * Response to PAUSE_SYNC.
 * @typedef {{ ok: true } | { ok: false, reason: string }} PauseSyncResponse
 */

/**
 * Sent from popup to background to resume scroll sync for the current tab pair.
 * @typedef {Object} ResumeSyncMessage
 * @property {'RESUME_SYNC'} type
 * @property {number} tabId - Tab whose pair should be resumed.
 */

/**
 * Response to RESUME_SYNC.
 * @typedef {{ ok: true } | { ok: false, reason: string }} ResumeSyncResponse
 */

/**
 * @typedef {'unpaired' | 'paired-source' | 'paired-sibling' | 'invalid-page'} PairStatusKind
 *
 * @typedef {Object} PairStatusResponse
 * @property {PairStatusKind} status
 * @property {string | null} pairId
 * @property {number | null} siblingTabId
 * @property {boolean} paused
 * @property {'user' | 'oscillation' | null} pauseReason
 * @property {boolean} syncAvailable - False when the content script is not reachable
 *   (e.g. blocked by page CSP, PDF, privileged page, or script not yet ready).
 *   Callers should surface a warning to the user rather than failing silently.
 * @property {boolean} adaptiveArticleOverlap
 * @property {boolean} pageKeyOverrideEnabled
 * @property {{ articleDetected: boolean, articleLineHeight: number | null, articleSampleCount: number, topOcclusionPx: number, bottomOcclusionPx: number, effectiveViewportHeight: number | null, estimatedOverlapPx: number | null } | null} [adaptiveDebug]
 */

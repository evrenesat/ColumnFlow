/**
 * In-memory background settings for sync behavior.
 */

export const DEFAULT_SYNC_SETTINGS = Object.freeze({
  adaptiveArticleOverlap: false,
  pageKeyOverrideEnabled: true,
});

let syncSettings = { ...DEFAULT_SYNC_SETTINGS };

/**
 * Replaces current settings with stored values merged onto defaults.
 * @param {{ adaptiveArticleOverlap?: boolean, pageKeyOverrideEnabled?: boolean } | undefined} stored
 */
export function hydrateSyncSettings(stored) {
  syncSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(stored ?? {}),
    adaptiveArticleOverlap: stored?.adaptiveArticleOverlap === true,
    pageKeyOverrideEnabled: stored?.pageKeyOverrideEnabled !== false,
  };
}

/**
 * Returns a snapshot of the current sync settings.
 * @returns {{ adaptiveArticleOverlap: boolean, pageKeyOverrideEnabled: boolean }}
 */
export function getSyncSettings() {
  return { ...syncSettings };
}

/**
 * Updates the adaptive article overlap flag in memory.
 * @param {boolean} enabled
 */
export function setAdaptiveArticleOverlapEnabled(enabled) {
  syncSettings.adaptiveArticleOverlap = enabled === true;
}

/**
 * Updates the PageUp/PageDown override flag in memory.
 * @param {boolean} enabled
 */
export function setPageKeyOverrideEnabled(enabled) {
  syncSettings.pageKeyOverrideEnabled = enabled !== false;
}

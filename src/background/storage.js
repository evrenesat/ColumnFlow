/**
 * Storage persistence helpers for pair state.
 *
 * Separated from pairState.js to keep the in-memory model free of browser
 * globals, and from background.js to avoid circular imports with pairingWorkflow.js.
 */

import { getAllPairs } from './pairState.js';
import { ext } from '../shared/ext.js';

const { storage } = ext;

/**
 * Flushes current in-memory pair state to extension storage.
 * Must be called after every authoritative mutation so state survives restarts.
 * @returns {Promise<void>}
 */
export async function flushPairsToStorage() {
  await storage.local.set({ pairs: getAllPairs() });
}

/**
 * Reads sync settings from extension storage.
 * @returns {Promise<{ adaptiveArticleOverlap?: boolean, pageKeyOverrideEnabled?: boolean }>}
 */
export async function readSyncSettingsFromStorage() {
  const stored = await storage.local.get('syncSettings');
  return stored.syncSettings ?? {};
}

/**
 * Flushes sync settings to extension storage.
 * @param {{ adaptiveArticleOverlap: boolean, pageKeyOverrideEnabled: boolean }} settings
 * @returns {Promise<void>}
 */
export async function flushSyncSettingsToStorage(settings) {
  await storage.local.set({ syncSettings: settings });
}

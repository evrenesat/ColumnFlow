/**
 * Debug logging utility for split-scroll-continuum.
 *
 * Enabled when localStorage item 'split-scroll-debug' is set to '1'.
 * Works in popup and content-script contexts. In the background service
 * worker localStorage is unavailable, so debug output is suppressed there
 * by default — set DEBUG = true below to enable during development.
 */

let DEBUG = false;
try {
  DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('split-scroll-debug') === '1';
} catch {
  // localStorage unavailable or restricted in this context.
}

/**
 * Logs a message only when debug mode is active.
 * @param {...any} args
 */
export function debugLog(...args) {
  if (DEBUG) console.log('[split-scroll]', ...args);
}

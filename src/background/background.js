/**
 * Background service worker entry point.
 *
 * Owns authoritative pair state. Routes popup messages and handles
 * tab lifecycle events to keep pair state valid.
 */

import {
  flushPairsToStorage,
  readSyncSettingsFromStorage,
  flushSyncSettingsToStorage,
} from './storage.js';
import {
  handlePairCurrentTab,
  handleUnpairTab,
  handleGetPairStatus,
  handlePauseSync,
  handleResumeSync,
  handleResumeOscillationPause,
  handleTabRemoved,
  handleTabUpdated,
  handleTabReplaced,
  refreshAllPairContexts,
  rehydrateValidPairs,
} from './pairingWorkflow.js';
import { handleScrollEvent } from './syncCoordinator.js';
import { getPairByTabId } from './pairState.js';
import { MessageType } from '../shared/messages.js';
import {
  getSyncSettings,
  hydrateSyncSettings,
  setAdaptiveArticleOverlapEnabled,
  setPageKeyOverrideEnabled,
} from './settings.js';

export { flushPairsToStorage };

const PAIR_PAGE_MENU_ID = 'pair-current-page';
let contextMenuSetup = null;

function ensureContextMenu() {
  if (contextMenuSetup) {
    return contextMenuSetup;
  }

  contextMenuSetup = browser.menus
    .removeAll()
    .catch(console.error)
    .finally(() => {
      browser.menus.create({
        id: PAIR_PAGE_MENU_ID,
        title: 'Duplicate and pair for split reading',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
    });

  return contextMenuSetup;
}

/**
 * Validates persisted pairs against live browser tabs and hydrates the store.
 * Called once on service worker startup. Invalid pairs (missing tabs, cross-window,
 * URL mismatch) are dropped and the cleanup is persisted.
 */
async function init() {
  ensureContextMenu();
  hydrateSyncSettings(await readSyncSettingsFromStorage());
  const stored = await browser.storage.local.get('pairs');
  if (stored.pairs && Array.isArray(stored.pairs)) {
    await rehydrateValidPairs(stored.pairs);
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === MessageType.GET_PAIR_STATUS) {
    return Promise.resolve(handleGetPairStatus(message.tabId, message.tabUrl));
  }

  if (message.type === MessageType.UNPAIR_TAB) {
    return Promise.resolve(handleUnpairTab(message.tabId));
  }

  if (message.type === MessageType.PAIR_CURRENT_TAB) {
    return handlePairCurrentTab(message.tabId);
  }

  if (message.type === MessageType.PAUSE_SYNC) {
    const response = handlePauseSync(message.tabId);
    if (response.ok) {
      refreshAllPairContexts().catch(console.error);
    }
    return Promise.resolve(response);
  }

  if (message.type === MessageType.RESUME_SYNC) {
    const response = handleResumeSync(message.tabId);
    if (response.ok) {
      refreshAllPairContexts().catch(console.error);
    }
    return Promise.resolve(response);
  }

  if (message.type === MessageType.SET_ADAPTIVE_ARTICLE_OVERLAP) {
    setAdaptiveArticleOverlapEnabled(message.enabled);
    flushSyncSettingsToStorage(getSyncSettings()).catch(console.error);
    refreshAllPairContexts().catch(console.error);
    return Promise.resolve({ ok: true, ...getSyncSettings() });
  }

  if (message.type === MessageType.SET_PAGE_KEY_OVERRIDE) {
    setPageKeyOverrideEnabled(message.enabled);
    flushSyncSettingsToStorage(getSyncSettings()).catch(console.error);
    refreshAllPairContexts().catch(console.error);
    return Promise.resolve({ ok: true, ...getSyncSettings() });
  }

  if (message.type === MessageType.SCROLL_EVENT && sender.tab?.id !== undefined) {
    handleScrollEvent(sender.tab.id, {
      scrollY: message.scrollY,
      innerHeight: message.innerHeight,
      scrollHeight: message.scrollHeight,
      clientHeight: message.clientHeight,
      timestamp: message.timestamp,
      articleDetected: message.articleDetected,
      articleLineHeight: message.articleLineHeight,
      topOcclusionPx: message.topOcclusionPx,
      bottomOcclusionPx: message.bottomOcclusionPx,
      effectiveViewportHeight: message.effectiveViewportHeight,
    }).catch(console.error);
    return false;
  }
});

browser.tabs.onRemoved.addListener(handleTabRemoved);

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  handleTabUpdated(tabId, changeInfo).catch(console.error);
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  handleResumeOscillationPause(tabId);
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }

  try {
    const activeTabs = await browser.tabs.query({ windowId, active: true });
    for (const tab of activeTabs) {
      if (tab.id !== undefined) {
        handleResumeOscillationPause(tab.id);
      }
    }
  } catch (error) {
    console.error(error);
  }
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  handleTabReplaced(addedTabId, removedTabId).catch(console.error);
});

browser.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === PAIR_PAGE_MENU_ID && tab?.id) {
    handlePairCurrentTab(tab.id).catch(console.error);
  }
});

browser.commands.onCommand.addListener(async (command) => {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  if (command === 'pair-tab') {
    handlePairCurrentTab(activeTab.id).catch(console.error);
  } else if (command === 'pause-sync') {
    const pair = getPairByTabId(activeTab.id);
    if (pair) {
      if (pair.paused) {
        handleResumeSync(activeTab.id);
      } else {
        handlePauseSync(activeTab.id);
      }
    }
  }
});

init().catch(console.error);

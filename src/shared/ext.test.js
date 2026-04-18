import { describe, it, expect, afterEach, vi } from 'vitest';
import { ext, getSplitViewId, isSplitViewTab } from './ext.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ext compatibility layer', () => {
  it('uses the Firefox-style browser namespace when available', async () => {
    const browser = {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
      },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ syncSettings: { adaptiveArticleOverlap: true } }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      menus: {
        removeAll: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        onClicked: { addListener: vi.fn() },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: vi.fn() },
      },
      commands: { onCommand: { addListener: vi.fn() } },
    };

    vi.stubGlobal('browser', browser);

    await expect(ext.tabs.query({ active: true })).resolves.toEqual([{ id: 1 }]);
    await expect(ext.runtime.sendMessage({ type: 'PING' })).resolves.toEqual({ ok: true });
    await expect(ext.storage.local.get('syncSettings')).resolves.toEqual({
      syncSettings: { adaptiveArticleOverlap: true },
    });
    await expect(ext.menus.removeAll()).resolves.toBeUndefined();
    const listener = vi.fn();
    ext.runtime.onMessage.addListener(listener);
    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledWith(listener);
    expect(ext.windows.WINDOW_ID_NONE).toBe(-1);
    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true });
    expect(browser.menus.create).not.toHaveBeenCalled();
  });

  it('wraps the Chrome callback namespace behind promises, aliases contextMenus, and bridges runtime.onMessage', async () => {
    const chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn((message, callback) => callback({ ok: true, message })),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
          hasListener: vi.fn(),
          hasListeners: vi.fn(),
        },
        onInstalled: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn((queryInfo, callback) => callback([{ id: 2, queryInfo }])),
        get: vi.fn((tabId, callback) => callback({ id: tabId })),
        sendMessage: vi.fn((tabId, message, callback) => callback({ tabId, message })),
        duplicate: vi.fn((tabId, callback) => callback({ id: tabId + 1 })),
        create: vi.fn((createProperties, callback) => callback({ id: 99, ...createProperties })),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        onReplaced: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn((keys, callback) => callback({ syncSettings: { pageKeyOverrideEnabled: false } })),
          set: vi.fn((items, callback) => callback(items)),
        },
      },
      contextMenus: {
        removeAll: vi.fn((callback) => callback()),
        create: vi.fn((createProperties, callback) => callback(1)),
        onClicked: { addListener: vi.fn() },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: vi.fn() },
      },
      commands: { onCommand: { addListener: vi.fn() } },
    };

    vi.stubGlobal('chrome', chrome);

    await expect(ext.tabs.query({ active: true })).resolves.toEqual([{ id: 2, queryInfo: { active: true } }]);
    await expect(ext.tabs.get(7)).resolves.toEqual({ id: 7 });
    await expect(ext.tabs.sendMessage(7, { type: 'PING' })).resolves.toEqual({
      tabId: 7,
      message: { type: 'PING' },
    });
    await expect(ext.runtime.sendMessage({ type: 'PING' })).resolves.toEqual({
      ok: true,
      message: { type: 'PING' },
    });
    await expect(ext.storage.local.get('syncSettings')).resolves.toEqual({
      syncSettings: { pageKeyOverrideEnabled: false },
    });
    await expect(ext.menus.removeAll()).resolves.toBeUndefined();
    await expect(ext.menus.create({ id: 'menu-item' })).resolves.toBe(1);

    const listener = vi.fn().mockResolvedValue({ ok: true });
    ext.runtime.onMessage.addListener(listener);
    const wrappedListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = vi.fn();
    expect(wrappedListener({ type: 'PING' }, { tab: { id: 1 } }, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    ext.runtime.onMessage.removeListener(listener);
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(wrappedListener);

    expect(ext.windows.WINDOW_ID_NONE).toBe(-1);
  });
});

describe('split-view helpers', () => {
  it('normalizes missing splitViewId to the no-split sentinel', () => {
    expect(getSplitViewId({})).toBeNull();
    expect(isSplitViewTab({})).toBe(false);
  });

  it('treats present splitViewId values as split tabs', () => {
    expect(getSplitViewId({ splitViewId: 4 })).toBe(4);
    expect(isSplitViewTab({ splitViewId: 4 })).toBe(true);
  });
});

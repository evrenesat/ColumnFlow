import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPair, addPair, hydratePairs } from './pairState.js';
import { MessageType } from '../shared/messages.js';

beforeEach(() => {
  hydratePairs([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('background message routing', () => {
  it('bridges Chrome runtime.onMessage responses through the real background handler', async () => {
    let registeredListener;

    const chrome = {
      runtime: {
        lastError: undefined,
        onMessage: {
          addListener: vi.fn((listener) => {
            registeredListener = listener;
          }),
          removeListener: vi.fn(),
          hasListener: vi.fn(),
          hasListeners: vi.fn(),
        },
        onInstalled: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn((tabId, callback) =>
          callback({
            id: tabId,
            windowId: 10,
            url: 'https://example.com/article',
            index: 0,
          })
        ),
        query: vi.fn((queryInfo, callback) =>
          callback([
            {
              id: 1,
              windowId: 10,
              url: 'https://example.com/article',
              index: 0,
            },
          ])
        ),
        sendMessage: vi.fn((tabId, message, callback) =>
          callback({
            scrollY: 0,
            innerHeight: 900,
            scrollHeight: 5000,
            clientHeight: 900,
            documentReady: true,
          })
        ),
        duplicate: vi.fn((tabId, callback) => callback?.({ id: tabId + 1 })),
        create: vi.fn((createProperties, callback) => callback?.({ id: 99, ...createProperties })),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        onReplaced: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn((keys, callback) => {
            if (keys === 'syncSettings') {
              callback({ syncSettings: {} });
              return;
            }
            if (keys === 'pairs') {
              callback({ pairs: [] });
              return;
            }
            callback({});
          }),
          set: vi.fn((items, callback) => callback?.(items)),
        },
      },
      contextMenus: {
        removeAll: vi.fn((callback) => callback?.()),
        create: vi.fn((createProperties, callback) => callback?.(1)),
        onClicked: { addListener: vi.fn() },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: vi.fn() },
      },
      commands: { onCommand: { addListener: vi.fn() } },
    };

    vi.stubGlobal('chrome', chrome);

    await import('./background.js');

    await vi.waitFor(() => {
      expect(chrome.contextMenus.create).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.get.mock.calls[0][0]).toBe('syncSettings');
      expect(chrome.storage.local.get.mock.calls[1][0]).toBe('pairs');
    });

    const pair = createPair(1, 2, 'https://example.com/article');
    expect(pair.ok).toBe(true);
    addPair(pair.pair);

    expect(registeredListener).toBeTypeOf('function');

    const sendResponse = vi.fn();
    const returned = registeredListener(
      {
        type: MessageType.GET_PAIR_STATUS,
        tabId: 1,
        tabUrl: 'https://example.com/article',
      },
      { tab: { id: 1 } },
      sendResponse
    );

    expect(returned).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'paired-source',
          pairId: pair.pair.pairId,
          siblingTabId: 2,
          syncAvailable: true,
        })
      );
    });
    expect(chrome.tabs.sendMessage.mock.calls[0][0]).toBe(1);
    expect(chrome.tabs.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        type: MessageType.GET_SCROLL_METRICS,
        pairId: pair.pair.pairId,
        syncToken: pair.pair.syncToken,
        includeReadingMetrics: false,
      })
    );
  });
});

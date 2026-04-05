import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleGetPairStatus, rehydrateValidPairs } from './pairingWorkflow.js';
import { hydratePairs, createPair, addPair, getPairByTabId } from './pairState.js';

beforeEach(() => {
  hydratePairs([]);
});

// ---------------------------------------------------------------------------
// handleGetPairStatus: unsupported-page detection (invalid-page path)
// ---------------------------------------------------------------------------

describe('handleGetPairStatus: unsupported pages', () => {
  it('returns invalid-page with syncAvailable false for about:blank', async () => {
    const result = await handleGetPairStatus(1, 'about:blank');
    expect(result.status).toBe('invalid-page');
    expect(result.syncAvailable).toBe(false);
    expect(result.pairId).toBeNull();
  });

  it('returns invalid-page with syncAvailable false for file: URL', async () => {
    const result = await handleGetPairStatus(1, 'file:///local/file.html');
    expect(result.status).toBe('invalid-page');
    expect(result.syncAvailable).toBe(false);
  });

  it('returns invalid-page with syncAvailable false for view-source: URL', async () => {
    const result = await handleGetPairStatus(1, 'view-source:https://example.com/');
    expect(result.status).toBe('invalid-page');
    expect(result.syncAvailable).toBe(false);
  });

  it('returns invalid-page with syncAvailable false for empty URL', async () => {
    const result = await handleGetPairStatus(1, '');
    expect(result.status).toBe('invalid-page');
    expect(result.syncAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetPairStatus: unpaired tab
// ---------------------------------------------------------------------------

describe('handleGetPairStatus: unpaired tab', () => {
  it('returns unpaired with syncAvailable true for valid http URL', async () => {
    const result = await handleGetPairStatus(99, 'https://example.com/');
    expect(result.status).toBe('unpaired');
    expect(result.syncAvailable).toBe(true);
    expect(result.pairId).toBeNull();
    expect(result.siblingTabId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleGetPairStatus: paired tab — content script unavailable
//
// In the test environment browser.tabs.sendMessage is not defined, so the
// probe throws and syncAvailable is expected to be false. This models the
// real-world case where the content script cannot be reached.
// ---------------------------------------------------------------------------

describe('handleGetPairStatus: paired tab with unreachable content script', () => {
  it('returns paired-source with syncAvailable false when probe throws', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const result = await handleGetPairStatus(1, 'https://example.com/article');
    expect(result.status).toBe('paired-source');
    expect(result.pairId).toBe(r.pair.pairId);
    expect(result.siblingTabId).toBe(2);
    expect(result.syncAvailable).toBe(false);
  });

  it('returns paired-sibling with syncAvailable false when probe throws', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const result = await handleGetPairStatus(2, 'https://example.com/article');
    expect(result.status).toBe('paired-sibling');
    expect(result.siblingTabId).toBe(1);
    expect(result.syncAvailable).toBe(false);
  });

  it('includes pause state in paired response', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);
    r.pair.paused = true;
    r.pair.pauseReason = 'oscillation';

    const result = await handleGetPairStatus(1, 'https://example.com/article');
    expect(result.paused).toBe(true);
    expect(result.pauseReason).toBe('oscillation');
  });
});

// ---------------------------------------------------------------------------
// rehydrateValidPairs: startup reconciliation
// ---------------------------------------------------------------------------

describe('rehydrateValidPairs: startup reconciliation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps valid pair and drops pair where one tab is missing', async () => {
    const validPair = createPair(1, 2, 'https://example.com/article').pair;
    const stalePair = createPair(3, 4, 'https://example.com/other').pair;

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockImplementation((tabId) => {
          if (tabId === 1) return Promise.resolve({ id: 1, windowId: 10, url: 'https://example.com/article' });
          if (tabId === 2) return Promise.resolve({ id: 2, windowId: 10, url: 'https://example.com/article' });
          return Promise.reject(new Error('Tab not found'));
        }),
        sendMessage: vi.fn().mockResolvedValue({}),
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    await rehydrateValidPairs([validPair, stalePair]);

    expect(getPairByTabId(1)).toBeDefined();
    expect(getPairByTabId(2)).toBeDefined();
    expect(getPairByTabId(3)).toBeUndefined();
    expect(getPairByTabId(4)).toBeUndefined();
  });

  it('drops pair where one tab navigated to a different URL', async () => {
    const pair = createPair(1, 2, 'https://example.com/article').pair;

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockImplementation((tabId) => {
          if (tabId === 1) return Promise.resolve({ id: 1, windowId: 10, url: 'https://example.com/article' });
          if (tabId === 2) return Promise.resolve({ id: 2, windowId: 10, url: 'https://example.com/different-page' });
          return Promise.reject(new Error('Tab not found'));
        }),
        sendMessage: vi.fn().mockResolvedValue({}),
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    await rehydrateValidPairs([pair]);

    expect(getPairByTabId(1)).toBeUndefined();
    expect(getPairByTabId(2)).toBeUndefined();
  });

  it('drops pair where tabs are in different windows', async () => {
    const pair = createPair(1, 2, 'https://example.com/article').pair;

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockImplementation((tabId) => {
          if (tabId === 1) return Promise.resolve({ id: 1, windowId: 10, url: 'https://example.com/article' });
          if (tabId === 2) return Promise.resolve({ id: 2, windowId: 20, url: 'https://example.com/article' });
          return Promise.reject(new Error('Tab not found'));
        }),
        sendMessage: vi.fn().mockResolvedValue({}),
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    await rehydrateValidPairs([pair]);

    expect(getPairByTabId(1)).toBeUndefined();
    expect(getPairByTabId(2)).toBeUndefined();
  });

  it('re-registers pair context for each valid tab', async () => {
    const pair = createPair(1, 2, 'https://example.com/article').pair;
    const sendMessage = vi.fn().mockResolvedValue({});

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockImplementation((tabId) => {
          if (tabId === 1) return Promise.resolve({ id: 1, windowId: 10, url: 'https://example.com/article' });
          if (tabId === 2) return Promise.resolve({ id: 2, windowId: 10, url: 'https://example.com/article' });
          return Promise.reject(new Error('Tab not found'));
        }),
        sendMessage,
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    await rehydrateValidPairs([pair]);

    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'SET_PAIR_CONTEXT', pairId: pair.pairId })
    );
    expect(sendMessage).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ type: 'SET_PAIR_CONTEXT', pairId: pair.pairId })
    );
  });

  it('persists storage cleanup when invalid pairs are dropped', async () => {
    const stalePair = createPair(1, 2, 'https://example.com/article').pair;
    const set = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockRejectedValue(new Error('Tab not found')),
        sendMessage: vi.fn().mockResolvedValue({}),
      },
      storage: { local: { set } },
    });

    await rehydrateValidPairs([stalePair]);

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ pairs: [] }));
  });
});

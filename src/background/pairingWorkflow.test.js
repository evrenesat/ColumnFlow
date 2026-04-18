import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  rankCandidates,
  handlePairCurrentTab,
  handleTabUpdated,
  handleTabReplaced,
} from './pairingWorkflow.js';
import {
  hydratePairs,
  createPair,
  addPair,
  removePair,
  getPairByTabId,
  replaceTabId,
  makePairId,
} from './pairState.js';

/** Reset in-memory pair store before each test. */
beforeEach(() => {
  hydratePairs([]);
});

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

describe('rankCandidates', () => {
  const URL_A = 'https://example.com/article';
  const URL_B = 'https://example.com/other';

  /** @type {import('./pairingWorkflow.js').TabLike} */
  const currentTab = { id: 1, windowId: 10, url: URL_A, index: 3 };

  it('returns empty array when there are no other tabs', () => {
    expect(rankCandidates(currentTab, [currentTab])).toEqual([]);
  });

  it('excludes current tab from results', () => {
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 0 };
    const ranked = rankCandidates(currentTab, [currentTab, tab2]);
    expect(ranked.map((t) => t.id)).toEqual([2]);
  });

  it('excludes tabs with different canonical URL', () => {
    const tabDiff = { id: 2, windowId: 10, url: URL_B, index: 0 };
    expect(rankCandidates(currentTab, [currentTab, tabDiff])).toEqual([]);
  });

  it('excludes tabs in a different window', () => {
    const tabOtherWindow = { id: 2, windowId: 99, url: URL_A, index: 0 };
    expect(rankCandidates(currentTab, [currentTab, tabOtherWindow])).toEqual([]);
  });

  it('excludes tabs with an unsupported URL', () => {
    const tabAbout = { id: 2, windowId: 10, url: 'about:blank', index: 0 };
    expect(rankCandidates(currentTab, [currentTab, tabAbout])).toEqual([]);
  });

  it('excludes tabs that are already paired', () => {
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 0 };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1 };
    // Pair tab2 with tab3 so both are in a pair.
    const result = createPair(tab2.id, tab3.id, URL_A);
    expect(result.ok).toBe(true);
    addPair(result.pair);

    // Neither tab2 nor tab3 should be returned as candidates for currentTab.
    const ranked = rankCandidates(currentTab, [currentTab, tab2, tab3]);
    expect(ranked).toEqual([]);
  });

  it('sorts by tab index (older/lower index first) when no splitViewId', () => {
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 5 };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1 };
    const ranked = rankCandidates(currentTab, [currentTab, tab2, tab3]);
    expect(ranked.map((t) => t.id)).toEqual([3, 2]);
  });

  it('uses tab id as tiebreaker when indices are equal', () => {
    const tab2 = { id: 5, windowId: 10, url: URL_A, index: 0 };
    const tab3 = { id: 2, windowId: 10, url: URL_A, index: 0 };
    const ranked = rankCandidates(currentTab, [currentTab, tab2, tab3]);
    expect(ranked.map((t) => t.id)).toEqual([2, 5]);
  });

  it('prefers tab in the same splitViewId over any non-split tab', () => {
    const currentWithSplit = { ...currentTab, splitViewId: 'sv-abc' };
    const tabInSplit = { id: 2, windowId: 10, url: URL_A, index: 99, splitViewId: 'sv-abc' };
    const tabNoSplit = { id: 3, windowId: 10, url: URL_A, index: 0, splitViewId: undefined };
    const ranked = rankCandidates(currentWithSplit, [currentWithSplit, tabInSplit, tabNoSplit]);
    expect(ranked[0].id).toBe(2);
  });

  it('falls back to index order when no tab shares splitViewId', () => {
    const currentWithSplit = { ...currentTab, splitViewId: 'sv-abc' };
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 5, splitViewId: 'sv-other' };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1, splitViewId: undefined };
    const ranked = rankCandidates(currentWithSplit, [currentWithSplit, tab2, tab3]);
    expect(ranked[0].id).toBe(3);
  });

  it('treats fragment-only difference as same URL', () => {
    const tabWithFragment = { id: 2, windowId: 10, url: `${URL_A}#section-2`, index: 0 };
    const ranked = rankCandidates(currentTab, [currentTab, tabWithFragment]);
    expect(ranked.map((t) => t.id)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// replaceTabId
// ---------------------------------------------------------------------------

describe('replaceTabId', () => {
  it('returns false when old tab is not in any pair', () => {
    expect(replaceTabId(999, 1000)).toBe(false);
  });

  it('updates tabA when the replaced tab is tabA', () => {
    const result = createPair(10, 20, 'https://example.com/');
    expect(result.ok).toBe(true);
    addPair(result.pair);

    const updated = replaceTabId(10, 30);
    expect(updated).toBe(true);

    const pair = getPairByTabId(30);
    expect(pair).toBeDefined();
    expect(pair?.tabA).toBe(30);
    expect(pair?.tabB).toBe(20);
  });

  it('updates tabB when the replaced tab is tabB', () => {
    const result = createPair(10, 20, 'https://example.com/');
    expect(result.ok).toBe(true);
    addPair(result.pair);

    const updated = replaceTabId(20, 40);
    expect(updated).toBe(true);

    const pair = getPairByTabId(40);
    expect(pair).toBeDefined();
    expect(pair?.tabA).toBe(10);
    expect(pair?.tabB).toBe(40);
  });

  it('updates sourceTabId when the source tab is replaced', () => {
    const result = createPair(10, 20, 'https://example.com/');
    expect(result.ok).toBe(true);
    addPair(result.pair);
    // tabA is set as source by default in createPair.
    expect(result.pair.sourceTabId).toBe(10);

    replaceTabId(10, 30);

    const pair = getPairByTabId(30);
    expect(pair?.sourceTabId).toBe(30);
  });

  it('old tab id is no longer in the store after replacement', () => {
    const result = createPair(10, 20, 'https://example.com/');
    expect(result.ok).toBe(true);
    addPair(result.pair);

    replaceTabId(10, 30);

    expect(getPairByTabId(10)).toBeUndefined();
    expect(getPairByTabId(30)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pairState lifecycle: createPair / addPair / removePair
// ---------------------------------------------------------------------------

describe('pairState: one pair per tab invariant', () => {
  it('createPair rejects if a tab is already paired', () => {
    const r1 = createPair(1, 2, 'https://example.com/');
    expect(r1.ok).toBe(true);
    addPair(r1.pair);

    // Attempt to pair tab 1 again with a different partner.
    const r2 = createPair(1, 3, 'https://example.com/');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('tab-already-paired');
  });

  it('tabs become available again after the pair is removed', () => {
    const r1 = createPair(1, 2, 'https://example.com/');
    expect(r1.ok).toBe(true);
    addPair(r1.pair);

    removePair(r1.pair.pairId);

    const r2 = createPair(1, 2, 'https://example.com/');
    expect(r2.ok).toBe(true);
  });
});

describe('pairState: deterministic pairId', () => {
  it('produces the same pairId regardless of argument order', () => {
    expect(makePairId(3, 7)).toBe(makePairId(7, 3));
  });

  it('always uses lo-hi ordering in the string', () => {
    expect(makePairId(3, 7)).toBe('pair-3-7');
    expect(makePairId(7, 3)).toBe('pair-3-7');
  });
});

// ---------------------------------------------------------------------------
// handlePairCurrentTab
// ---------------------------------------------------------------------------

describe('handlePairCurrentTab', () => {
  const URL = 'https://example.com/article';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('duplicates the current tab when no sibling candidate exists', async () => {
    const duplicate = vi.fn().mockResolvedValue({ id: 2, windowId: 10, url: URL, status: 'complete' });
    const sendMessage = vi.fn().mockResolvedValue({});

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, windowId: 10, url: URL, index: 0 }),
        query: vi.fn().mockResolvedValue([{ id: 1, windowId: 10, url: URL, index: 0 }]),
        duplicate,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        sendMessage,
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    const result = await handlePairCurrentTab(1);

    expect(result.ok).toBe(true);
    expect(duplicate).toHaveBeenCalledWith(1);
    expect(getPairByTabId(1)?.tabB).toBe(2);
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'SET_PAIR_CONTEXT', pairId: result.pairId })
    );
  });

  it('prefers an existing split mate over duplicating the tab', async () => {
    const duplicate = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({});

    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 1,
          windowId: 10,
          url: URL,
          index: 2,
          splitViewId: 'sv-1',
        }),
        query: vi.fn().mockResolvedValue([
          { id: 1, windowId: 10, url: URL, index: 2, splitViewId: 'sv-1' },
          { id: 2, windowId: 10, url: URL, index: 99, splitViewId: 'sv-1' },
          { id: 3, windowId: 10, url: URL, index: 0 },
        ]),
        duplicate,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        sendMessage,
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    const result = await handlePairCurrentTab(1);

    expect(result.ok).toBe(true);
    expect(duplicate).not.toHaveBeenCalled();
    expect(getPairByTabId(1)?.tabB).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// handleTabUpdated: reload re-registration
// ---------------------------------------------------------------------------

describe('handleTabUpdated: reload re-registration', () => {
  const URL = 'https://example.com/article';

  beforeEach(() => {
    vi.stubGlobal('browser', {
      tabs: { sendMessage: vi.fn().mockResolvedValue({}) },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resends pair context when paired tab finishes loading', async () => {
    const r = createPair(1, 2, URL);
    expect(r.ok).toBe(true);
    addPair(r.pair);

    await handleTabUpdated(1, { status: 'complete' });

    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'SET_PAIR_CONTEXT', pairId: r.pair.pairId })
    );
  });

  it('does not send anything when tab is not paired', async () => {
    await handleTabUpdated(99, { status: 'complete' });
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('invalidates pair when tab navigates to a different URL', async () => {
    const r = createPair(1, 2, URL);
    expect(r.ok).toBe(true);
    addPair(r.pair);

    await handleTabUpdated(1, { url: 'https://example.com/other-page' });

    expect(getPairByTabId(1)).toBeUndefined();
    expect(getPairByTabId(2)).toBeUndefined();
  });

  it('does not invalidate pair when tab navigates to the same canonical URL', async () => {
    const r = createPair(1, 2, URL);
    expect(r.ok).toBe(true);
    addPair(r.pair);

    await handleTabUpdated(1, { url: URL });

    expect(getPairByTabId(1)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleTabReplaced: failure cleanup
// ---------------------------------------------------------------------------

describe('handleTabReplaced: replacement-tab-not-found cleanup', () => {
  const URL = 'https://example.com/article';

  beforeEach(() => {
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockRejectedValue(new Error('Tab not found')),
        sendMessage: vi.fn().mockResolvedValue({}),
      },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes pair and notifies surviving tab when replacement tab cannot be retrieved', async () => {
    const r = createPair(10, 20, URL);
    expect(r.ok).toBe(true);
    addPair(r.pair);

    await handleTabReplaced(99, 10);

    expect(getPairByTabId(10)).toBeUndefined();
    expect(getPairByTabId(20)).toBeUndefined();
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ type: 'SET_PAIR_CONTEXT', pairId: null })
    );
  });
});

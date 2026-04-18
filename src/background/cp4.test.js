import { describe, it, expect, beforeEach } from 'vitest';
import {
  handlePauseSync,
  handleResumeSync,
  handleResumeOscillationPause,
  rankCandidates,
} from './pairingWorkflow.js';
import {
  hydratePairs,
  createPair,
  addPair,
  getPairByTabId,
} from './pairState.js';

beforeEach(() => {
  hydratePairs([]);
});

// ---------------------------------------------------------------------------
// handlePauseSync
// ---------------------------------------------------------------------------

describe('handlePauseSync', () => {
  it('returns error when tab is not paired', () => {
    const result = handlePauseSync(999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tab-not-paired');
  });

  it('pauses a paired tab and sets pauseReason to user', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const result = handlePauseSync(1);
    expect(result.ok).toBe(true);

    const pair = getPairByTabId(1);
    expect(pair?.paused).toBe(true);
    expect(pair?.pauseReason).toBe('user');
  });

  it('returns error when pair is already paused', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    handlePauseSync(1);
    const second = handlePauseSync(1);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already-paused');
  });

  it('can pause from sibling tab side', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const result = handlePauseSync(2);
    expect(result.ok).toBe(true);

    const pair = getPairByTabId(2);
    expect(pair?.paused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleResumeSync
// ---------------------------------------------------------------------------

describe('handleResumeSync', () => {
  it('returns error when tab is not paired', () => {
    const result = handleResumeSync(999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tab-not-paired');
  });

  it('returns error when pair is not paused', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const result = handleResumeSync(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-paused');
  });

  it('resumes a user-paused pair and clears pauseReason', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    handlePauseSync(1);
    const result = handleResumeSync(1);
    expect(result.ok).toBe(true);

    const pair = getPairByTabId(1);
    expect(pair?.paused).toBe(false);
    expect(pair?.pauseReason).toBeNull();
  });

  it('resumes an oscillation-paused pair and clears pauseReason', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);
    // Simulate oscillation pause by mutating pair state directly.
    const pair = getPairByTabId(1);
    pair.paused = true;
    pair.pauseReason = 'oscillation';

    const result = handleResumeSync(1);
    expect(result.ok).toBe(true);
    expect(pair.paused).toBe(false);
    expect(pair.pauseReason).toBeNull();
  });

  it('pause then resume then pause works correctly', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    handlePauseSync(1);
    handleResumeSync(1);
    const second = handlePauseSync(1);
    expect(second.ok).toBe(true);

    const pair = getPairByTabId(1);
    expect(pair?.paused).toBe(true);
    expect(pair?.pauseReason).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// handleResumeOscillationPause
// ---------------------------------------------------------------------------

describe('handleResumeOscillationPause', () => {
  it('resumes an oscillation-paused pair', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const pair = getPairByTabId(1);
    pair.paused = true;
    pair.pauseReason = 'oscillation';

    expect(handleResumeOscillationPause(1)).toBe(true);
    expect(pair.paused).toBe(false);
    expect(pair.pauseReason).toBeNull();
  });

  it('does not resume a user-paused pair', () => {
    const r = createPair(1, 2, 'https://example.com/');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    handlePauseSync(1);

    expect(handleResumeOscillationPause(1)).toBe(false);

    const pair = getPairByTabId(1);
    expect(pair?.paused).toBe(true);
    expect(pair?.pauseReason).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// split-view candidate precedence
// ---------------------------------------------------------------------------

describe('rankCandidates: split-view precedence', () => {
  const URL_A = 'https://example.com/article';

  it('prefers split sibling even when it has a higher index', () => {
    const current = { id: 1, windowId: 10, url: URL_A, index: 3, splitViewId: 17 };
    const splitSibling = { id: 2, windowId: 10, url: URL_A, index: 99, splitViewId: 17 };
    const olderTab = { id: 3, windowId: 10, url: URL_A, index: 0, splitViewId: undefined };
    const ranked = rankCandidates(current, [current, splitSibling, olderTab]);
    expect(ranked[0].id).toBe(2);
  });

  it('falls back to index order when current tab has no splitViewId', () => {
    const current = { id: 1, windowId: 10, url: URL_A, index: 3 };
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 5, splitViewId: 17 };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1, splitViewId: undefined };
    const ranked = rankCandidates(current, [current, tab2, tab3]);
    expect(ranked[0].id).toBe(3);
  });

  it('falls back to index order when no candidate shares splitViewId', () => {
    const current = { id: 1, windowId: 10, url: URL_A, index: 3, splitViewId: 17 };
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 5, splitViewId: 23 };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1, splitViewId: undefined };
    const ranked = rankCandidates(current, [current, tab2, tab3]);
    expect(ranked[0].id).toBe(3);
  });

  it('only one candidate in split view — it wins regardless of index', () => {
    const current = { id: 1, windowId: 10, url: URL_A, index: 2, splitViewId: 17 };
    const splitTab = { id: 5, windowId: 10, url: URL_A, index: 100, splitViewId: 17 };
    const ranked = rankCandidates(current, [current, splitTab]);
    expect(ranked[0].id).toBe(5);
  });

  it('non-split-view current tab: excludes no candidates based on splitViewId alone', () => {
    const current = { id: 1, windowId: 10, url: URL_A, index: 5 };
    const tab2 = { id: 2, windowId: 10, url: URL_A, index: 3, splitViewId: 17 };
    const tab3 = { id: 3, windowId: 10, url: URL_A, index: 1, splitViewId: 23 };
    const ranked = rankCandidates(current, [current, tab2, tab3]);
    // Both candidates are reachable; sorted by index
    expect(ranked.map((t) => t.id)).toEqual([3, 2]);
  });
});

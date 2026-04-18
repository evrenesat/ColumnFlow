import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTargetScroll,
  deriveAdaptiveScrollSettings,
  recordSwitchAndCheckOscillation,
  clearOscillationLog,
  handleScrollEvent,
  notifyTabPairContext,
} from './syncCoordinator.js';
import { hydratePairs, createPair, addPair, getPairByTabId } from './pairState.js';
import { hydrateSyncSettings } from './settings.js';

beforeEach(() => {
  hydratePairs([]);
  hydrateSyncSettings({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// computeTargetScroll
// ---------------------------------------------------------------------------

describe('computeTargetScroll', () => {
  it('produces source.scrollY + innerHeight - 32 when within sibling bounds', () => {
    // rawTarget = 100 + 600 - 32 = 668; siblingMax = 2000 - 600 = 1400
    expect(computeTargetScroll({ scrollY: 100, innerHeight: 600 }, { scrollHeight: 2000, clientHeight: 600 })).toBe(668);
  });

  it('clamps to 0 when OVERLAP_PX exceeds scroll position plus innerHeight', () => {
    // rawTarget = 0 + 20 - 32 = -12 → clamp to 0
    expect(computeTargetScroll({ scrollY: 0, innerHeight: 20 }, { scrollHeight: 2000, clientHeight: 600 })).toBe(0);
  });

  it('clamps to siblingMaxScroll when target exceeds it', () => {
    // rawTarget = 9900 + 600 - 32 = 10468; siblingMax = 1000 - 600 = 400
    expect(computeTargetScroll({ scrollY: 9900, innerHeight: 600 }, { scrollHeight: 1000, clientHeight: 600 })).toBe(400);
  });

  it('returns 0 when sibling scrollHeight <= clientHeight (no scrollable area)', () => {
    // siblingMax = max(0, 400 - 600) = 0
    expect(computeTargetScroll({ scrollY: 500, innerHeight: 600 }, { scrollHeight: 400, clientHeight: 600 })).toBe(0);
  });

  it('returns exact siblingMaxScroll when source is at bottom', () => {
    // source scrollY at max; rawTarget will exceed siblingMax → clamped
    expect(computeTargetScroll({ scrollY: 2000, innerHeight: 600 }, { scrollHeight: 800, clientHeight: 600 })).toBe(200);
  });

  it('source at scrollY=0 with innerHeight=600 and OVERLAP_PX=32 yields 568', () => {
    expect(computeTargetScroll({ scrollY: 0, innerHeight: 600 }, { scrollHeight: 2000, clientHeight: 600 })).toBe(568);
  });

  it('handles equal scrollHeight between source and sibling without error', () => {
    // Normal case — same page height in both tabs
    const result = computeTargetScroll(
      { scrollY: 300, innerHeight: 600 },
      { scrollHeight: 3000, clientHeight: 600 }
    );
    // rawTarget = 300 + 600 - 32 = 868; siblingMax = 2400
    expect(result).toBe(868);
  });

  it('uses provided overlap and effective viewport height when present', () => {
    expect(
      computeTargetScroll(
        { scrollY: 100, innerHeight: 800, overlapPx: 48, effectiveViewportHeight: 700 },
        { scrollHeight: 3000, clientHeight: 800 }
      )
    ).toBe(752);
  });
});

describe('deriveAdaptiveScrollSettings', () => {
  it('returns null when article metrics are unavailable', () => {
    expect(
      deriveAdaptiveScrollSettings(
        { articleDetected: false, articleLineHeight: null, innerHeight: 800 },
        { articleDetected: true, articleLineHeight: 24, innerHeight: 800 }
      )
    ).toBeNull();
  });

  it('derives a clamped overlap from measured line height', () => {
    expect(
      deriveAdaptiveScrollSettings(
        {
          articleDetected: true,
          articleLineHeight: 20,
          innerHeight: 900,
          effectiveViewportHeight: 860,
        },
        {
          articleDetected: true,
          articleLineHeight: 24,
          innerHeight: 900,
          effectiveViewportHeight: 860,
        }
      )
    ).toEqual({
      overlapPx: 32,
      effectiveViewportHeight: 860,
    });
  });

  it('never returns an overlap smaller than the default', () => {
    expect(
      deriveAdaptiveScrollSettings(
        {
          articleDetected: true,
          articleLineHeight: 14,
          innerHeight: 900,
          effectiveViewportHeight: 880,
        },
        {
          articleDetected: true,
          articleLineHeight: 14,
          innerHeight: 900,
          effectiveViewportHeight: 880,
        }
      )
    ).toEqual({
      overlapPx: 32,
      effectiveViewportHeight: 880,
    });
  });

  it('caps unusually large adaptive overlap', () => {
    expect(
      deriveAdaptiveScrollSettings(
        {
          articleDetected: true,
          articleLineHeight: 40,
          innerHeight: 900,
          effectiveViewportHeight: 850,
        },
        {
          articleDetected: true,
          articleLineHeight: 44,
          innerHeight: 900,
          effectiveViewportHeight: 850,
        }
      )
    ).toEqual({
      overlapPx: 48,
      effectiveViewportHeight: 850,
    });
  });
});

// ---------------------------------------------------------------------------
// recordSwitchAndCheckOscillation
// ---------------------------------------------------------------------------

describe('recordSwitchAndCheckOscillation', () => {
  it('returns false on first switch', () => {
    expect(recordSwitchAndCheckOscillation('osc-1', 1000)).toBe(false);
  });

  it('returns false when two switches are separated by more than 500ms', () => {
    recordSwitchAndCheckOscillation('osc-2', 1000);
    expect(recordSwitchAndCheckOscillation('osc-2', 1601)).toBe(false);
  });

  it('returns true when two switches occur within 500ms', () => {
    recordSwitchAndCheckOscillation('osc-3', 1000);
    expect(recordSwitchAndCheckOscillation('osc-3', 1300)).toBe(true);
  });

  it('returns true when two switches occur exactly at the boundary (500ms apart)', () => {
    recordSwitchAndCheckOscillation('osc-4', 1000);
    // 1000 + 500 = 1500; filter: now - t <= 500 → 1500 - 1000 = 500 ≤ 500 → included
    expect(recordSwitchAndCheckOscillation('osc-4', 1500)).toBe(true);
  });

  it('clears the log and resets oscillation detection for the pair', () => {
    recordSwitchAndCheckOscillation('osc-5', 1000);
    recordSwitchAndCheckOscillation('osc-5', 1200); // oscillating
    clearOscillationLog('osc-5');
    // After clear, first switch is fresh — should return false
    expect(recordSwitchAndCheckOscillation('osc-5', 2000)).toBe(false);
  });

  it('old switches outside the window do not count toward oscillation', () => {
    // First switch is stale (1000ms ago relative to second check).
    recordSwitchAndCheckOscillation('osc-6', 1000);
    // Second switch: 1000 + 600 = 1600 — stale by now
    recordSwitchAndCheckOscillation('osc-6', 1600);
    // Third switch at 2200: window is 500ms, so 1600 is 600ms ago → outside window
    expect(recordSwitchAndCheckOscillation('osc-6', 2200)).toBe(false);
  });

  it('independent pairs do not affect each other', () => {
    recordSwitchAndCheckOscillation('osc-a', 1000);
    recordSwitchAndCheckOscillation('osc-a', 1200);
    // osc-b has no prior switches — should not oscillate
    expect(recordSwitchAndCheckOscillation('osc-b', 1300)).toBe(false);
  });
});

describe('handleScrollEvent', () => {
  it('keeps sync active during rapid ownership switching', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);

    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        scrollY: 650,
        innerHeight: 600,
        scrollHeight: 5000,
        clientHeight: 600,
      })
      .mockResolvedValueOnce({ applied: true, syncToken: 1 })
      .mockResolvedValueOnce({
        scrollY: 900,
        innerHeight: 600,
        scrollHeight: 5000,
        clientHeight: 600,
      })
      .mockResolvedValueOnce({ applied: true, syncToken: 2 });

    vi.stubGlobal('browser', {
      tabs: { sendMessage },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });

    await handleScrollEvent(2, {
      scrollY: 100,
      innerHeight: 600,
      scrollHeight: 5000,
      clientHeight: 600,
    });

    await handleScrollEvent(1, {
      scrollY: 300,
      innerHeight: 600,
      scrollHeight: 5000,
      clientHeight: 600,
    });

    const pair = getPairByTabId(1);
    expect(pair?.paused).toBe(false);
    expect(pair?.pauseReason).toBeNull();
    expect(pair?.sourceTabId).toBe(1);
  });
});

describe('notifyTabPairContext', () => {
  it('includes global settings and active sync state for a live pair', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);
    hydrateSyncSettings({ adaptiveArticleOverlap: true, pageKeyOverrideEnabled: false });

    const sendMessage = vi.fn().mockResolvedValue({});
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
    });

    await notifyTabPairContext(1, r.pair.pairId);

    expect(sendMessage).toHaveBeenCalledWith(1, {
      type: 'SET_PAIR_CONTEXT',
      pairId: r.pair.pairId,
      adaptiveArticleOverlap: true,
      pageKeyOverrideEnabled: false,
      syncActive: true,
    });
  });

  it('marks sync inactive when the pair is paused', async () => {
    const r = createPair(1, 2, 'https://example.com/article');
    expect(r.ok).toBe(true);
    addPair(r.pair);
    r.pair.paused = true;

    const sendMessage = vi.fn().mockResolvedValue({});
    vi.stubGlobal('browser', {
      tabs: { sendMessage },
    });

    await notifyTabPairContext(1, r.pair.pairId);

    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        pairId: r.pair.pairId,
        syncActive: false,
      })
    );
  });
});

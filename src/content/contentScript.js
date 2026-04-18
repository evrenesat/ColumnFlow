/**
 * Content script injected at document_idle into all http/https pages.
 *
 * Handles:
 * - SET_PAIR_CONTEXT: registers or clears the pair ID for this tab.
 * - GET_SCROLL_METRICS: returns current scroll and viewport metrics on demand.
 * - APPLY_SCROLL: applies a remote scroll position and records suppression state.
 *
 * Captures trusted local scroll events and forwards them to the background using
 * requestAnimationFrame coalescing and a trailing idle timeout. Remote-echo scrolls
 * (those triggered by APPLY_SCROLL within SUPPRESSION_WINDOW_MS) are suppressed.
 */

/**
 * Content scripts are injected as classic scripts here, so they cannot rely on
 * extension-module loading at startup.
 */
const MessageType = Object.freeze({
  GET_SCROLL_METRICS: 'GET_SCROLL_METRICS',
  APPLY_SCROLL: 'APPLY_SCROLL',
  SCROLL_EVENT: 'SCROLL_EVENT',
  SET_PAIR_CONTEXT: 'SET_PAIR_CONTEXT',
});

/**
 * Duration (ms) during which scroll events after an APPLY_SCROLL are classified
 * as remote echoes and suppressed.
 */
const SUPPRESSION_WINDOW_MS = 150;

/**
 * Duration (ms) of scroll inactivity after which a final trailing SCROLL_EVENT
 * is sent to ensure the background has the settled position.
 */
const SCROLL_IDLE_MS = 200;
const FALLBACK_PAGE_SCROLL_RATIO = 0.875;

/** pairId received from background via SET_PAIR_CONTEXT, or null when unpaired. */
let currentPairId = null;

/** syncToken from the last APPLY_SCROLL received. -1 when no remote scroll has occurred. */
let lastAppliedToken = -1;

/** Timestamp (ms) of the last APPLY_SCROLL application. */
let lastAppliedAt = 0;

/** Whether a requestAnimationFrame send is already queued. */
let rafPending = false;

/** Idle timer handle for the trailing send. */
let idleTimer = null;

/** Most-recently captured scroll metrics waiting to be sent. */
let pendingMetrics = null;

/** Whether adaptive article overlap is enabled for the current pair. */
let adaptiveArticleOverlapEnabled = false;

/** Whether PageUp/PageDown should act as a double page move while sync is active. */
let pageKeyOverrideEnabled = true;

/** Whether the current pair is actively syncing. */
let syncActive = false;

const ARTICLE_CONTAINER_SELECTORS = [
  '#content',
  '.content-section',
  '.layout__content',
  '.main-content',
  '.main-page-content',
  'main article',
  '[role="main"] article',
  'article',
  'main',
  '[role="main"]',
];
const READING_BLOCK_SELECTORS = 'p, li, dd, blockquote, td';
const EXCLUDED_READING_ANCESTOR_SELECTOR = [
  'nav',
  'aside',
  'header',
  'footer',
  '[role="navigation"]',
  '[aria-label*="breadcrumb" i]',
  '[aria-label*="table of contents" i]',
  '.toc',
  '.table-of-contents',
  '.breadcrumbs',
  '.sidebar',
  '.feedback',
  'pre',
  'code',
].join(', ');
const EDGE_SAMPLE_POINTS = [0.2, 0.5, 0.8];

let readingStructureCache = {
  stamp: null,
  metrics: null,
};

function captureMetrics() {
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    timestamp: Date.now(),
  };
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getResolvedLineHeight(element) {
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight)) {
    return lineHeight;
  }

  const fontSize = Number.parseFloat(style.fontSize);
  if (Number.isFinite(fontSize)) {
    return fontSize * 1.5;
  }

  return null;
}

function getReadableTextLength(element) {
  return (element.innerText ?? '').replace(/\s+/g, ' ').trim().length;
}

function isCandidateContainerElement(element) {
  return (
    element instanceof HTMLElement &&
    ['MAIN', 'ARTICLE', 'SECTION', 'DIV'].includes(element.tagName)
  );
}

function collectReadingBlocks(container, limit = 24) {
  const blocks = [];
  const candidates = container.querySelectorAll(READING_BLOCK_SELECTORS);

  for (const element of candidates) {
    if (blocks.length >= limit) break;
    if (!isVisibleElement(element)) continue;
    if (element.closest(EXCLUDED_READING_ANCESTOR_SELECTOR)) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 14) continue;

    const textLength = getReadableTextLength(element);
    const minimumLength = element.tagName === 'LI' ? 10 : 24;
    if (textLength < minimumLength) continue;

    const lineHeight = getResolvedLineHeight(element);
    if (!Number.isFinite(lineHeight)) continue;

    blocks.push({
      element,
      lineHeight,
      weight: Math.max(1, Math.min(textLength, 240)),
    });
  }

  return blocks;
}

function getWeightedMedian(samples) {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a.lineHeight - b.lineHeight);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  let runningWeight = 0;

  for (const sample of sorted) {
    runningWeight += sample.weight;
    if (runningWeight >= totalWeight / 2) {
      return sample.lineHeight;
    }
  }

  return sorted.at(-1)?.lineHeight ?? null;
}

function detectArticleContainer() {
  const seen = new Set();
  const candidates = [];

  for (const selector of ARTICLE_CONTAINER_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (seen.has(element) || !isVisibleElement(element)) continue;
      seen.add(element);

      const rect = element.getBoundingClientRect();
      const textLength = getReadableTextLength(element);
      if (rect.height < 180 || textLength < 180) {
        continue;
      }

      const readingBlocks = collectReadingBlocks(element, 20);
      if (readingBlocks.length < 2) {
        continue;
      }

      candidates.push({
        element,
        score:
          textLength +
          rect.height +
          readingBlocks.length * 500 +
          readingBlocks.reduce((sum, block) => sum + block.weight, 0),
      });
    }
  }

  if (candidates.length === 0) {
    const fallbackBlocks = collectReadingBlocks(document, 48);
    const ancestorScores = new Map();

    for (const block of fallbackBlocks) {
      let current = block.element.parentElement;
      let depth = 0;

      while (current && current !== document.body && depth < 6) {
        if (isCandidateContainerElement(current) && !current.closest(EXCLUDED_READING_ANCESTOR_SELECTOR)) {
          const existing = ancestorScores.get(current) ?? { score: 0, blockCount: 0 };
          ancestorScores.set(current, {
            score: existing.score + block.weight,
            blockCount: existing.blockCount + 1,
          });
        }
        current = current.parentElement;
        depth += 1;
      }
    }

    for (const [element, aggregate] of ancestorScores.entries()) {
      if (!isVisibleElement(element) || aggregate.blockCount < 3) continue;
      candidates.push({
        element,
        score: aggregate.score + aggregate.blockCount * 600 + getReadableTextLength(element),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.element ?? null;
}

function getReadingStructureMetrics() {
  const stamp = `${document.documentElement.scrollHeight}:${window.innerWidth}:${window.innerHeight}`;
  if (readingStructureCache.stamp === stamp && readingStructureCache.metrics) {
    return readingStructureCache.metrics;
  }

  const articleContainer = detectArticleContainer();
  if (!articleContainer) {
    readingStructureCache = {
      stamp,
      metrics: {
        articleDetected: false,
        articleLineHeight: null,
        articleSampleCount: 0,
      },
    };
    return readingStructureCache.metrics;
  }

  const readingBlocks = collectReadingBlocks(articleContainer);
  const articleLineHeight = getWeightedMedian(readingBlocks);

  readingStructureCache = {
    stamp,
    metrics: {
      articleDetected: articleLineHeight !== null,
      articleLineHeight,
      articleSampleCount: readingBlocks.length,
    },
  };

  return readingStructureCache.metrics;
}

function getEdgeOcclusionForPoint(x, y, edge) {
  let occlusionPx = 0;
  const seen = new Set();
  const elements = document.elementsFromPoint(x, y);

  for (const leaf of elements) {
    let current = leaf;
    while (current && current !== document.documentElement) {
      if (seen.has(current)) {
        current = current.parentElement;
        continue;
      }
      seen.add(current);

      const style = getComputedStyle(current);
      if (
        (style.position === 'fixed' || style.position === 'sticky') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      ) {
        const rect = current.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.25 && rect.height >= 24) {
          if (edge === 'top' && rect.top <= 0 && rect.bottom > 0) {
            occlusionPx = Math.max(occlusionPx, Math.min(rect.bottom, window.innerHeight));
          }

          if (edge === 'bottom' && rect.top < window.innerHeight && rect.bottom >= window.innerHeight) {
            occlusionPx = Math.max(
              occlusionPx,
              Math.min(window.innerHeight - Math.max(rect.top, 0), window.innerHeight)
            );
          }
        }
      }

      current = current.parentElement;
    }
  }

  return occlusionPx;
}

function measureStickyOcclusion() {
  let topOcclusionPx = 0;
  let bottomOcclusionPx = 0;

  for (const fraction of EDGE_SAMPLE_POINTS) {
    const x = Math.round(window.innerWidth * fraction);
    topOcclusionPx = Math.max(topOcclusionPx, getEdgeOcclusionForPoint(x, 1, 'top'));
    bottomOcclusionPx = Math.max(
      bottomOcclusionPx,
      getEdgeOcclusionForPoint(x, Math.max(0, window.innerHeight - 2), 'bottom')
    );
  }

  return { topOcclusionPx, bottomOcclusionPx };
}

function getReadingMetrics() {
  const structureMetrics = getReadingStructureMetrics();
  if (!structureMetrics.articleDetected) {
    return {
      ...structureMetrics,
      topOcclusionPx: 0,
      bottomOcclusionPx: 0,
      effectiveViewportHeight: window.innerHeight,
      estimatedOverlapPx: null,
    };
  }

  const { topOcclusionPx, bottomOcclusionPx } = measureStickyOcclusion();
  const effectiveViewportHeight = Math.max(
    Math.round(window.innerHeight * 0.5),
    window.innerHeight - topOcclusionPx - bottomOcclusionPx
  );
  const estimatedOverlapPx = Math.max(32, Math.min(48, Math.round(structureMetrics.articleLineHeight * 1.35)));

  return {
    ...structureMetrics,
    topOcclusionPx,
    bottomOcclusionPx,
    effectiveViewportHeight,
    estimatedOverlapPx,
  };
}

function sendScrollEvent(metrics) {
  if (!currentPairId) return;
  const readingMetrics = adaptiveArticleOverlapEnabled ? getReadingMetrics() : {};
  browser.runtime.sendMessage({
    type: MessageType.SCROLL_EVENT,
    pairId: currentPairId,
    scrollY: metrics.scrollY,
    innerHeight: metrics.innerHeight,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    timestamp: metrics.timestamp,
    syncToken: lastAppliedToken,
    ...readingMetrics,
  }).catch(() => {});
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable]') !== null;
}

function scrollByPages(pageCount) {
  if (typeof window.scrollByPages === 'function') {
    window.scrollByPages(pageCount);
    return;
  }

  window.scrollBy({
    top: Math.round(window.innerHeight * FALLBACK_PAGE_SCROLL_RATIO * pageCount),
    behavior: 'instant',
  });
}

function onKeyDown(event) {
  if (!currentPairId || !syncActive || !pageKeyOverrideEnabled) return;
  if (event.defaultPrevented || event.repeat) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isEditableTarget(event.target)) return;

  if (event.key === 'PageDown') {
    event.preventDefault();
    scrollByPages(2);
    return;
  }

  if (event.key === 'PageUp') {
    event.preventDefault();
    scrollByPages(-2);
  }
}

function onScroll() {
  if (!currentPairId) return;

  // Suppress remote-echo scrolls within the suppression window.
  if (Date.now() - lastAppliedAt < SUPPRESSION_WINDOW_MS) return;

  pendingMetrics = captureMetrics();

  // RAF coalescing: one send per animation frame.
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (pendingMetrics) {
        sendScrollEvent(pendingMetrics);
      }
    });
  }

  // Reset idle timer for the trailing settled-position send.
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    sendScrollEvent(captureMetrics());
    pendingMetrics = null;
  }, SCROLL_IDLE_MS);
}

function handleMessage(message, _sender, sendResponse) {
  if (message.type === MessageType.SET_PAIR_CONTEXT) {
    currentPairId = message.pairId;
    adaptiveArticleOverlapEnabled = message.pairId !== null && message.adaptiveArticleOverlap === true;
    pageKeyOverrideEnabled = message.pageKeyOverrideEnabled !== false;
    syncActive = message.pairId !== null && message.syncActive === true;
    if (message.pairId === null) {
      lastAppliedToken = -1;
      lastAppliedAt = 0;
      syncActive = false;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MessageType.GET_SCROLL_METRICS) {
    const readingMetrics = message.includeReadingMetrics ? getReadingMetrics() : {};
    sendResponse({
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      documentReady:
        document.readyState === 'complete' || document.readyState === 'interactive',
      ...readingMetrics,
    });
    return false;
  }

  if (message.type === MessageType.APPLY_SCROLL) {
    lastAppliedToken = message.syncToken;
    lastAppliedAt = Date.now();
    window.scrollTo({ top: message.targetScrollY, behavior: 'instant' });
    sendResponse({ applied: true, syncToken: message.syncToken });
    return false;
  }
  return false;
}

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('keydown', onKeyDown, true);
browser.runtime.onMessage.addListener(handleMessage);

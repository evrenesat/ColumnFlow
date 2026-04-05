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

import { MessageType } from '../shared/messages.js';

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

function captureMetrics() {
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    timestamp: Date.now(),
  };
}

function sendScrollEvent(metrics) {
  if (!currentPairId) return;
  browser.runtime.sendMessage({
    type: MessageType.SCROLL_EVENT,
    pairId: currentPairId,
    scrollY: metrics.scrollY,
    innerHeight: metrics.innerHeight,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    timestamp: metrics.timestamp,
    syncToken: lastAppliedToken,
  }).catch(() => {});
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

window.addEventListener('scroll', onScroll, { passive: true });

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MessageType.SET_PAIR_CONTEXT) {
    currentPairId = message.pairId;
    if (message.pairId === null) {
      lastAppliedToken = -1;
      lastAppliedAt = 0;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MessageType.GET_SCROLL_METRICS) {
    sendResponse({
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      documentReady:
        document.readyState === 'complete' || document.readyState === 'interactive',
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
});

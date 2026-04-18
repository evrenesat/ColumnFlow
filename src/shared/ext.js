/**
 * Local compatibility layer for the browser extension APIs used by this repo.
 *
 * Firefox exposes promise-based `browser.*` APIs. Chrome exposes callback-based
 * `chrome.*` APIs. This module normalizes the subset we use so runtime modules
 * can stay browser-agnostic.
 */

const NOOP_EVENT = Object.freeze({
  addListener() {},
  removeListener() {},
  hasListener() {
    return false;
  },
  hasListeners() {
    return false;
  },
});

export const NO_SPLIT_VIEW_ID = null;
const chromeMessageListenerMap = new WeakMap();
const chromeMessageWrappedListeners = new WeakSet();

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function getBrowserNamespace() {
  const namespace = globalThis.browser;
  return namespace && typeof namespace === 'object' ? namespace : null;
}

function getChromeNamespace() {
  const namespace = globalThis.chrome;
  return namespace && typeof namespace === 'object' ? namespace : null;
}

function makePromiseMethod(browserSelector, chromeSelector, methodName, defaultValue, options = {}) {
  const { missingMode = 'resolve' } = options;
  return (...args) => {
    const browserNamespace = getBrowserNamespace();
    if (browserNamespace) {
      const namespace = browserSelector(browserNamespace);
      if (namespace && typeof namespace[methodName] === 'function') {
        try {
          const result = namespace[methodName](...args);
          return isPromiseLike(result) ? result : Promise.resolve(result ?? defaultValue);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return missingMode === 'reject'
        ? Promise.reject(new Error(`Extension API method unavailable: ${methodName}`))
        : Promise.resolve(defaultValue);
    }

    const chromeNamespace = getChromeNamespace();
    if (chromeNamespace) {
      const namespace = chromeSelector(chromeNamespace);
      if (namespace && typeof namespace[methodName] === 'function') {
        return new Promise((resolve, reject) => {
          namespace[methodName](...args, (result) => {
            const lastError = chromeNamespace.runtime?.lastError;
            if (lastError) {
              reject(new Error(lastError.message ?? String(lastError)));
              return;
            }
            resolve(result ?? defaultValue);
          });
        });
      }
    }

    return missingMode === 'reject'
      ? Promise.reject(new Error(`Extension API method unavailable: ${methodName}`))
      : Promise.resolve(defaultValue);
  };
}

function resolveEvent(browserSelector, chromeSelector) {
  const browserNamespace = getBrowserNamespace();
  if (browserNamespace) {
    return browserSelector(browserNamespace) ?? NOOP_EVENT;
  }

  const chromeNamespace = getChromeNamespace();
  if (chromeNamespace) {
    return chromeSelector(chromeNamespace) ?? NOOP_EVENT;
  }

  return NOOP_EVENT;
}

function makeEventAccessor(browserSelector, chromeSelector) {
  return {
    addListener(listener, ...args) {
      return resolveEvent(browserSelector, chromeSelector).addListener(listener, ...args);
    },
    removeListener(listener, ...args) {
      return resolveEvent(browserSelector, chromeSelector).removeListener(listener, ...args);
    },
    hasListener(listener) {
      return resolveEvent(browserSelector, chromeSelector).hasListener(listener);
    },
    hasListeners() {
      return resolveEvent(browserSelector, chromeSelector).hasListeners();
    },
  };
}

function wrapChromeRuntimeMessageListener(listener) {
  if (typeof listener !== 'function') {
    return listener;
  }

  if (chromeMessageWrappedListeners.has(listener)) {
    return listener;
  }

  const wrapped = (message, sender, sendResponse) => {
    try {
      const result = listener(message, sender, sendResponse);
      if (isPromiseLike(result)) {
        Promise.resolve(result).then(
          (resolvedValue) => {
            sendResponse(resolvedValue);
          },
          (error) => {
            console.error(error);
            sendResponse(undefined);
          }
        );
        return true;
      }

      if (result === undefined || result === false || result === true) {
        return result;
      }

      sendResponse(result);
      return false;
    } catch (error) {
      console.error(error);
      return false;
    }
  };

  chromeMessageListenerMap.set(listener, wrapped);
  chromeMessageWrappedListeners.add(wrapped);
  return wrapped;
}

function makeRuntimeMessageAccessor(browserSelector, chromeSelector) {
  return {
    addListener(listener, ...args) {
      const event = resolveEvent(browserSelector, chromeSelector);
      const wrappedListener =
        getBrowserNamespace() ? listener : wrapChromeRuntimeMessageListener(listener);
      return event.addListener(wrappedListener, ...args);
    },
    removeListener(listener, ...args) {
      const event = resolveEvent(browserSelector, chromeSelector);
      const wrappedListener =
        getBrowserNamespace() ? listener : chromeMessageListenerMap.get(listener) ?? listener;
      return event.removeListener(wrappedListener, ...args);
    },
    hasListener(listener) {
      const event = resolveEvent(browserSelector, chromeSelector);
      const wrappedListener =
        getBrowserNamespace() ? listener : chromeMessageListenerMap.get(listener) ?? listener;
      return event.hasListener(wrappedListener);
    },
    hasListeners() {
      return resolveEvent(browserSelector, chromeSelector).hasListeners();
    },
  };
}

function createTabsApi() {
  return {
    get: makePromiseMethod(
      (browserNamespace) => browserNamespace.tabs,
      (chromeNamespace) => chromeNamespace.tabs,
      'get',
      undefined
    ),
    query: makePromiseMethod(
      (browserNamespace) => browserNamespace.tabs,
      (chromeNamespace) => chromeNamespace.tabs,
      'query',
      []
    ),
    duplicate: makePromiseMethod(
      (browserNamespace) => browserNamespace.tabs,
      (chromeNamespace) => chromeNamespace.tabs,
      'duplicate',
      undefined
    ),
    create: makePromiseMethod(
      (browserNamespace) => browserNamespace.tabs,
      (chromeNamespace) => chromeNamespace.tabs,
      'create',
      undefined
    ),
    sendMessage: makePromiseMethod(
      (browserNamespace) => browserNamespace.tabs,
      (chromeNamespace) => chromeNamespace.tabs,
      'sendMessage',
      undefined,
      { missingMode: 'reject' }
    ),
    onRemoved: makeEventAccessor(
      (browserNamespace) => browserNamespace.tabs?.onRemoved,
      (chromeNamespace) => chromeNamespace.tabs?.onRemoved
    ),
    onUpdated: makeEventAccessor(
      (browserNamespace) => browserNamespace.tabs?.onUpdated,
      (chromeNamespace) => chromeNamespace.tabs?.onUpdated
    ),
    onActivated: makeEventAccessor(
      (browserNamespace) => browserNamespace.tabs?.onActivated,
      (chromeNamespace) => chromeNamespace.tabs?.onActivated
    ),
    onReplaced: makeEventAccessor(
      (browserNamespace) => browserNamespace.tabs?.onReplaced,
      (chromeNamespace) => chromeNamespace.tabs?.onReplaced
    ),
  };
}

function createRuntimeApi() {
  return {
    sendMessage: makePromiseMethod(
      (browserNamespace) => browserNamespace.runtime,
      (chromeNamespace) => chromeNamespace.runtime,
      'sendMessage',
      undefined,
      { missingMode: 'reject' }
    ),
    onMessage: makeRuntimeMessageAccessor(
      (browserNamespace) => browserNamespace.runtime?.onMessage,
      (chromeNamespace) => chromeNamespace.runtime?.onMessage
    ),
    onInstalled: makeEventAccessor(
      (browserNamespace) => browserNamespace.runtime?.onInstalled,
      (chromeNamespace) => chromeNamespace.runtime?.onInstalled
    ),
  };
}

function createStorageApi() {
  return {
    local: {
      get: makePromiseMethod(
        (browserNamespace) => browserNamespace.storage?.local,
        (chromeNamespace) => chromeNamespace.storage?.local,
        'get',
        {}
      ),
      set: makePromiseMethod(
        (browserNamespace) => browserNamespace.storage?.local,
        (chromeNamespace) => chromeNamespace.storage?.local,
        'set',
        undefined
      ),
    },
  };
}

function createWindowsApi() {
  return {
    get WINDOW_ID_NONE() {
      return getBrowserNamespace()?.windows?.WINDOW_ID_NONE ?? getChromeNamespace()?.windows?.WINDOW_ID_NONE ?? -1;
    },
    onFocusChanged: makeEventAccessor(
      (browserNamespace) => browserNamespace.windows?.onFocusChanged,
      (chromeNamespace) => chromeNamespace.windows?.onFocusChanged
    ),
  };
}

function createCommandsApi() {
  return {
    onCommand: makeEventAccessor(
      (browserNamespace) => browserNamespace.commands?.onCommand,
      (chromeNamespace) => chromeNamespace.commands?.onCommand
    ),
  };
}

function createMenusApi() {
  return {
    removeAll: makePromiseMethod(
      (browserNamespace) => browserNamespace.menus,
      (chromeNamespace) => chromeNamespace.contextMenus,
      'removeAll',
      undefined
    ),
    create: makePromiseMethod(
      (browserNamespace) => browserNamespace.menus,
      (chromeNamespace) => chromeNamespace.contextMenus,
      'create',
      undefined
    ),
    onClicked: makeEventAccessor(
      (browserNamespace) => browserNamespace.menus?.onClicked,
      (chromeNamespace) => chromeNamespace.contextMenus?.onClicked
    ),
  };
}

/**
 * Returns the shared split-view id, or null when the tab is not in split view.
 * @param {{ splitViewId?: number | null | undefined } | undefined} tab
 * @returns {number | null}
 */
export function getSplitViewId(tab) {
  return tab?.splitViewId ?? NO_SPLIT_VIEW_ID;
}

/**
 * Returns true when a tab is currently in split view.
 * @param {{ splitViewId?: number | null | undefined } | undefined} tab
 * @returns {boolean}
 */
export function isSplitViewTab(tab) {
  return getSplitViewId(tab) !== NO_SPLIT_VIEW_ID;
}

/**
 * Normalized extension API surface used by runtime modules.
 */
export const ext = Object.freeze({
  get tabs() {
    return createTabsApi();
  },
  get runtime() {
    return createRuntimeApi();
  },
  get storage() {
    return createStorageApi();
  },
  get windows() {
    return createWindowsApi();
  },
  get commands() {
    return createCommandsApi();
  },
  get menus() {
    return createMenusApi();
  },
});

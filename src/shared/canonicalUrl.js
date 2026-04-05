/**
 * Deterministic URL canonicalization for pair matching.
 *
 * Rules:
 * - Only http and https URLs are accepted (v1 scope).
 * - Scheme and host are lowercased (URL already does this, but explicit here).
 * - Fragment is always stripped.
 * - Query string is preserved.
 * - Empty path is normalized to '/'; all other paths are kept as-is.
 */

/**
 * @typedef {{ ok: true, url: string } | { ok: false, reason: string }} CanonicalResult
 */

/**
 * Returns a canonical form of the given URL, or a failure reason.
 * @param {string} rawUrl
 * @returns {CanonicalResult}
 */
export function canonicalizeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-protocol' };
  }

  // URL constructor already lowercases scheme and host.
  const scheme = parsed.protocol;
  const host = parsed.host;
  const path = parsed.pathname === '' ? '/' : parsed.pathname;
  const search = parsed.search;
  // Hash/fragment is intentionally excluded.

  return { ok: true, url: `${scheme}//${host}${path}${search}` };
}

/**
 * Returns the canonical URL string, or throws if the URL is not supported.
 * @param {string} rawUrl
 * @returns {string}
 */
export function requireCanonicalUrl(rawUrl) {
  const result = canonicalizeUrl(rawUrl);
  if (!result.ok) {
    throw new Error(`Cannot canonicalize URL: ${result.reason} (${rawUrl})`);
  }
  return result.url;
}

/**
 * Returns true if two raw URLs resolve to the same canonical URL.
 * Returns false if either URL is unsupported or invalid.
 * @param {string} urlA
 * @param {string} urlB
 * @returns {boolean}
 */
export function urlsMatch(urlA, urlB) {
  const a = canonicalizeUrl(urlA);
  const b = canonicalizeUrl(urlB);
  return a.ok && b.ok && a.url === b.url;
}

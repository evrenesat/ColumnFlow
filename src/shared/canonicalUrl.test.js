import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, requireCanonicalUrl, urlsMatch } from './canonicalUrl.js';

describe('canonicalizeUrl', () => {
  it('accepts a plain http URL', () => {
    const result = canonicalizeUrl('http://example.com/page');
    expect(result).toEqual({ ok: true, url: 'http://example.com/page' });
  });

  it('accepts a plain https URL', () => {
    const result = canonicalizeUrl('https://example.com/page');
    expect(result).toEqual({ ok: true, url: 'https://example.com/page' });
  });

  it('strips the fragment', () => {
    const result = canonicalizeUrl('https://example.com/page#section-2');
    expect(result).toEqual({ ok: true, url: 'https://example.com/page' });
  });

  it('preserves the query string', () => {
    const result = canonicalizeUrl('https://example.com/search?q=foo&page=2');
    expect(result).toEqual({ ok: true, url: 'https://example.com/search?q=foo&page=2' });
  });

  it('strips fragment while preserving query string', () => {
    const result = canonicalizeUrl('https://example.com/page?ref=top#heading');
    expect(result).toEqual({ ok: true, url: 'https://example.com/page?ref=top' });
  });

  it('lowercases the scheme', () => {
    // URL constructor normalizes scheme; verify our output follows suit.
    const result = canonicalizeUrl('HTTPS://example.com/page');
    expect(result.ok && result.url.startsWith('https://')).toBe(true);
  });

  it('lowercases the host', () => {
    const result = canonicalizeUrl('https://EXAMPLE.COM/page');
    expect(result.ok && result.url).toContain('example.com');
  });

  it('normalizes empty path to /', () => {
    // URL('https://example.com') has pathname '/', so this is already normalized.
    const result = canonicalizeUrl('https://example.com');
    expect(result).toEqual({ ok: true, url: 'https://example.com/' });
  });

  it('keeps non-root paths unchanged', () => {
    const result = canonicalizeUrl('https://example.com/a/b/c');
    expect(result).toEqual({ ok: true, url: 'https://example.com/a/b/c' });
  });

  it('rejects ftp URLs', () => {
    const result = canonicalizeUrl('ftp://example.com/file');
    expect(result).toEqual({ ok: false, reason: 'unsupported-protocol' });
  });

  it('rejects about: URLs', () => {
    const result = canonicalizeUrl('about:blank');
    expect(result).toEqual({ ok: false, reason: 'unsupported-protocol' });
  });

  it('rejects file: URLs', () => {
    const result = canonicalizeUrl('file:///home/user/doc.html');
    expect(result).toEqual({ ok: false, reason: 'unsupported-protocol' });
  });

  it('rejects plainly invalid strings', () => {
    const result = canonicalizeUrl('not a url at all');
    expect(result).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('rejects empty string', () => {
    const result = canonicalizeUrl('');
    expect(result).toEqual({ ok: false, reason: 'invalid-url' });
  });
});

describe('requireCanonicalUrl', () => {
  it('returns the canonical URL string for a valid URL', () => {
    expect(requireCanonicalUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('throws for an unsupported protocol', () => {
    expect(() => requireCanonicalUrl('ftp://example.com')).toThrow();
  });

  it('throws for an invalid URL', () => {
    expect(() => requireCanonicalUrl('garbage')).toThrow();
  });
});

describe('urlsMatch', () => {
  it('returns true for identical URLs', () => {
    expect(urlsMatch('https://example.com/page', 'https://example.com/page')).toBe(true);
  });

  it('returns true when URLs differ only by fragment', () => {
    expect(urlsMatch('https://example.com/page#a', 'https://example.com/page#b')).toBe(true);
  });

  it('returns true when one URL has a fragment and the other does not', () => {
    expect(urlsMatch('https://example.com/page#top', 'https://example.com/page')).toBe(true);
  });

  it('returns false for URLs with different paths', () => {
    expect(urlsMatch('https://example.com/a', 'https://example.com/b')).toBe(false);
  });

  it('returns false for URLs with different query strings', () => {
    expect(urlsMatch('https://example.com/p?x=1', 'https://example.com/p?x=2')).toBe(false);
  });

  it('returns false when one URL is invalid', () => {
    expect(urlsMatch('https://example.com/page', 'not-a-url')).toBe(false);
  });

  it('returns false for different hosts', () => {
    expect(urlsMatch('https://a.com/page', 'https://b.com/page')).toBe(false);
  });

  it('returns false when one URL uses an unsupported protocol', () => {
    expect(urlsMatch('https://example.com/page', 'ftp://example.com/page')).toBe(false);
  });
});

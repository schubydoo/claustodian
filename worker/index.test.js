// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { prefersMarkdown } from './index.js';

describe('prefersMarkdown', () => {
  it('matches an exact text/markdown request', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  it('matches when markdown is one range among several', () => {
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.9, text/markdown')).toBe(true);
  });

  it('tolerates whitespace, casing and parameters', () => {
    expect(prefersMarkdown('  TEXT/Markdown ; charset=utf-8 ')).toBe(true);
  });

  // The load-bearing case. A browser sends */* on plenty of requests; if that
  // matched, every human visitor would be served a text file instead of the site.
  it('does NOT match a browser Accept header', () => {
    expect(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      )
    ).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
  });

  it('does not match neighbouring text types', () => {
    expect(prefersMarkdown('text/plain')).toBe(false);
    expect(prefersMarkdown('text/markdown-ish')).toBe(false);
    expect(prefersMarkdown('application/markdown')).toBe(false);
  });

  it('honours q=0 as a refusal', () => {
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0.0')).toBe(false);
  });

  it('treats any nonzero q as acceptance', () => {
    expect(prefersMarkdown('text/markdown;q=0.1')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=1')).toBe(true);
  });

  it('handles a missing or empty header', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
  });
});

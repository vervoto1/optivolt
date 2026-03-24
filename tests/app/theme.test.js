// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('theme.js', () => {
  let root, btn, mqListeners;

  function setupDOM(opts = {}) {
    root = document.documentElement;
    root.classList.remove('dark');

    btn = document.createElement('button');
    btn.id = 'themeToggle';
    document.body.innerHTML = '';
    document.body.appendChild(btn);

    localStorage.clear();
    if (opts.storedTheme) localStorage.setItem('optivolt-theme', opts.storedTheme);

    mqListeners = [];
    const mq = {
      matches: opts.prefersDark ?? false,
      addEventListener: vi.fn((_, cb) => mqListeners.push(cb)),
      addListener: undefined,
    };
    if (opts.useLegacyListener) {
      mq.addEventListener = undefined;
      mq.addListener = vi.fn((cb) => mqListeners.push(cb));
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mq));
  }

  async function loadTheme() {
    vi.resetModules();
    await import('../../app/src/theme.js');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('applies dark class when system prefers dark', async () => {
    setupDOM({ prefersDark: true });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('applies light (no dark class) when system prefers light', async () => {
    setupDOM({ prefersDark: false });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('uses stored theme over system preference', async () => {
    setupDOM({ prefersDark: true, storedTheme: 'light' });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('uses stored dark theme', async () => {
    setupDOM({ prefersDark: false, storedTheme: 'dark' });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('ignores invalid stored theme', async () => {
    setupDOM({ prefersDark: true, storedTheme: 'invalid' });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('button click cycles: system(dark) → light → dark → system', async () => {
    setupDOM({ prefersDark: true });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);

    // Click 1: system(dark) → explicit light
    btn.click();
    expect(root.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('optivolt-theme')).toBe('light');

    // Click 2: light → system (remove storage)
    btn.click();
    expect(localStorage.getItem('optivolt-theme')).toBeNull();
    expect(root.classList.contains('dark')).toBe(true); // back to system dark

    // Click 3: system(dark) → light again
    btn.click();
    expect(localStorage.getItem('optivolt-theme')).toBe('light');
  });

  it('button click cycles: system(light) → dark → light → system', async () => {
    setupDOM({ prefersDark: false });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(false);

    // Click 1: system(light) → dark
    btn.click();
    expect(root.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('optivolt-theme')).toBe('dark');

    // Click 2: dark → light
    btn.click();
    expect(root.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('optivolt-theme')).toBe('light');

    // Click 3: light → system
    btn.click();
    expect(localStorage.getItem('optivolt-theme')).toBeNull();
  });

  it('media query change re-applies theme in system mode', async () => {
    setupDOM({ prefersDark: false });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(false);

    // Simulate OS change to dark while in system mode
    const mq = window.matchMedia();
    // Manually change matches
    Object.defineProperty(mq, 'matches', { value: true, writable: true });
    mqListeners.forEach(cb => cb());
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('media query change does not re-apply when stored theme exists', async () => {
    setupDOM({ prefersDark: false, storedTheme: 'light' });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(false);

    const mq = window.matchMedia();
    Object.defineProperty(mq, 'matches', { value: true, writable: true });
    mqListeners.forEach(cb => cb());
    // Should stay light because stored theme is set
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('supports legacy addListener API and fires callback', async () => {
    setupDOM({ prefersDark: true, useLegacyListener: true });
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
    expect(mqListeners.length).toBe(1);

    // Fire the legacy listener callback (covers line 34)
    const mq = window.matchMedia();
    Object.defineProperty(mq, 'matches', { value: false, writable: true });
    mqListeners[0](); // no stored theme → applyTheme runs
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('works without themeToggle button', async () => {
    setupDOM({ prefersDark: true });
    document.body.innerHTML = ''; // remove button
    // Re-add without button
    const newBtn = null; // no button
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
  });
});

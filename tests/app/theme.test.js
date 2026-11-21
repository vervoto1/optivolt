// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

  // Stand-in for Home Assistant's frontend around the ingress iframe:
  // `darkMode` true/false, or 'cross-origin' for a parent we may not read.
  function embedInHomeAssistant(darkMode) {
    const ha = { hass: { themes: { darkMode } } };
    const parentWin = darkMode === 'cross-origin'
      ? { get document() { throw new DOMException('Blocked a frame', 'SecurityError'); } }
      : { document: { querySelector: (sel) => (sel === 'home-assistant' ? ha : null) } };
    Object.defineProperty(window, 'parent', { value: parentWin, configurable: true });
    return ha;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    // theme.js starts a Home Assistant poll on import; fake timers keep each
    // test's interval from outliving it.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
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

  it('treats an unrecognized stored value as system mode', async () => {
    setupDOM({ prefersDark: false, storedTheme: 'sepia' });
    await loadTheme();
    // getStoredTheme() returns null for unknown values; the click then cycles from system → dark.
    btn.click();
    expect(localStorage.getItem('optivolt-theme')).toBe('dark');
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
    await loadTheme();
    expect(root.classList.contains('dark')).toBe(true);
  });
  describe('following Home Assistant', () => {
    it('uses Home Assistant\'s dark mode over the system preference', async () => {
      setupDOM({ prefersDark: false, storedTheme: 'ha' });
      embedInHomeAssistant(true);
      await loadTheme();
      expect(root.classList.contains('dark')).toBe(true);
    });

    it('picks up a Home Assistant theme change on the next poll, announcing it once', async () => {
      setupDOM({ prefersDark: false, storedTheme: 'ha' });
      const ha = embedInHomeAssistant(true);
      const changes = [];
      const onChange = (e) => changes.push(e.detail.theme);
      window.addEventListener('optivolt:themechange', onChange);
      try {
        await loadTheme();
        expect(changes).toEqual(['dark']);

        vi.advanceTimersByTime(2000); // unchanged: no restyle, no chart redraw
        expect(changes).toEqual(['dark']);

        ha.hass.themes.darkMode = false;
        vi.advanceTimersByTime(1999);
        expect(root.classList.contains('dark')).toBe(true);
        vi.advanceTimersByTime(1);
        expect(root.classList.contains('dark')).toBe(false);
        expect(changes).toEqual(['dark', 'light']);
      } finally {
        window.removeEventListener('optivolt:themechange', onChange);
      }
    });

    it('does not poll Home Assistant in the other modes', async () => {
      setupDOM({ prefersDark: false, storedTheme: 'light' });
      const ha = embedInHomeAssistant(true);
      await loadTheme();
      ha.hass.themes.darkMode = true;
      vi.advanceTimersByTime(10_000);
      expect(root.classList.contains('dark')).toBe(false);
    });

    it('falls back to the system preference outside Home Assistant, and follows OS changes', async () => {
      setupDOM({ prefersDark: true, storedTheme: 'ha' }); // window.parent === window
      await loadTheme();
      expect(root.classList.contains('dark')).toBe(true);

      const mq = window.matchMedia();
      Object.defineProperty(mq, 'matches', { value: false, writable: true });
      mqListeners.forEach(cb => cb());
      expect(root.classList.contains('dark')).toBe(false);
    });

    it('falls back to the system preference while Home Assistant has not loaded its state', async () => {
      setupDOM({ prefersDark: true, storedTheme: 'light' });
      const ha = embedInHomeAssistant(true);
      delete ha.hass; // <home-assistant> present, hass not set yet
      await loadTheme();
      btn.click(); // light → system: "ha" is not offered without a readable darkMode
      expect(localStorage.getItem('optivolt-theme')).toBeNull();
      expect(root.classList.contains('dark')).toBe(true);
    });

    it('falls back to the system preference when the parent page is cross-origin', async () => {
      setupDOM({ prefersDark: true, storedTheme: 'ha' });
      embedInHomeAssistant('cross-origin');
      await loadTheme();
      expect(root.classList.contains('dark')).toBe(true);
    });

    it('offers the Home Assistant mode after light only inside Home Assistant, then returns to system', async () => {
      setupDOM({ prefersDark: false });
      embedInHomeAssistant(true);
      await loadTheme();

      btn.click(); // system(light) → dark
      btn.click(); // dark → light
      expect(localStorage.getItem('optivolt-theme')).toBe('light');
      btn.click(); // light → follows Home Assistant
      expect(localStorage.getItem('optivolt-theme')).toBe('ha');
      expect(root.classList.contains('dark')).toBe(true);
      btn.click(); // Home Assistant → system
      expect(localStorage.getItem('optivolt-theme')).toBeNull();
      expect(root.classList.contains('dark')).toBe(false);
    });

    it('skips the Home Assistant mode behind a cross-origin parent', async () => {
      setupDOM({ prefersDark: false, storedTheme: 'light' });
      embedInHomeAssistant('cross-origin');
      await loadTheme();
      btn.click();
      expect(localStorage.getItem('optivolt-theme')).toBeNull();
    });
  });

  it('names the current mode in the button tooltip and label', async () => {
    setupDOM({ prefersDark: false });
    embedInHomeAssistant(false);
    await loadTheme();
    const titles = [btn.title];
    for (let i = 0; i < 4; i++) {
      btn.click();
      titles.push(btn.title);
    }
    expect(titles).toEqual([
      'Theme: follows the system (click to change)',
      'Theme: dark (click to change)',
      'Theme: light (click to change)',
      'Theme: follows Home Assistant (click to change)',
      'Theme: follows the system (click to change)',
    ]);
    expect(btn.getAttribute('aria-label')).toBe(titles[4]);
  });
});

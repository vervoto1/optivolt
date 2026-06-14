// Settings tab is split into "Power settings" and "EV charging" sub-panels.
// Both live inside #panel-settings, so the main tab switcher already reveals
// their cards; here we just toggle which sub-panel is visible.

const ACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';
const INACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';

export function setupSettingsSubtabs(doc = document) {
  const subtabs = [
    { tab: doc.getElementById('subtab-power'), panel: doc.getElementById('settings-power') },
    { tab: doc.getElementById('subtab-ev'),    panel: doc.getElementById('settings-ev') },
  ].filter(s => s.tab && s.panel);
  if (subtabs.length < 2) return;

  function activate(newIndex) {
    subtabs.forEach(({ tab, panel }, i) => {
      const active = i === newIndex;
      tab.setAttribute('aria-selected', String(active));
      tab.className = active ? ACTIVE_CLS : INACTIVE_CLS;
      panel.classList.toggle('hidden', !active);
    });
  }

  subtabs.forEach(({ tab }, i) => tab.addEventListener('click', () => activate(i)));
  activate(0);
}

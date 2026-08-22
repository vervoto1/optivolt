// Settings tab is split into "Power settings", "EV charging" and "Battery"
// sub-panels. All live inside #panel-settings, so the main tab switcher already
// reveals their cards; here we just toggle which sub-panel is visible.

import { TAB_PILL_ACTIVE_CLS as ACTIVE_CLS, TAB_PILL_INACTIVE_CLS as INACTIVE_CLS } from './tab-classes.js';

export function setupSettingsSubtabs(doc = document) {
  const subtabs = [
    { tab: doc.getElementById('subtab-power'),   panel: doc.getElementById('settings-power') },
    { tab: doc.getElementById('subtab-ev'),      panel: doc.getElementById('settings-ev') },
    { tab: doc.getElementById('subtab-battery'), panel: doc.getElementById('settings-battery') },
  ].filter(s => s.tab && s.panel);
  if (subtabs.length === 0) return;

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

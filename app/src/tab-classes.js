// Single source of truth for the pill-tab button styling shared by the main
// tab switcher (main.js) and the settings sub-tabs (settings-subtabs.js).
// app/index.html repeats these strings on the tab buttons so the first paint
// (before any JS runs) already matches; boot immediately reapplies them from
// here (activateTab(0) / activate(0)), so the markup copies are
// non-authoritative and self-heal if they drift.
export const TAB_PILL_ACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium bg-white text-ink shadow-xs dark:bg-slate-700 dark:text-slate-100 transition-all focus:outline-hidden focus:ring-2 focus:ring-sky-400/50';
export const TAB_PILL_INACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all focus:outline-hidden focus:ring-2 focus:ring-sky-400/50';

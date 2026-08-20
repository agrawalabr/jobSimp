// Dashboard shell + router.
//
// Structure: this file owns ONLY the chrome around the content — the tab bar,
// the account menu, and the URL. Each tab is a self-contained pair:
//
//   tabs/<name>.html   markup, no scripts
//   tabs/<name>.js     export mount(root, params) [, unmount()]
//
// Both are loaded lazily on first activation and cached, so opening the
// dashboard costs one small fetch instead of parsing every panel up front.

import { MAIN_TABS, ACCOUNT_TABS, DEFAULT_TAB } from '../../static/enums.js';
import { $, $$, send, esc } from './lib/dom.js';

const ALL_TABS = new Set([...MAIN_TABS, ...ACCOUNT_TABS]);
const htmlCache = new Map();
const moduleCache = new Map();
/** Bump with extension version so tab ES modules are not stuck on a stale import after Reload. */
const TAB_CACHE_BUST = `${chrome.runtime.getManifest().version}-list-activity-sort-v1`;

let currentTab = null;
let currentModule = null;
let mountToken = 0;

async function loadHtml(tab) {
  const key = `${tab}@${TAB_CACHE_BUST}`;
  if (!htmlCache.has(key)) {
    const url = chrome.runtime.getURL(`src/component/dashboard/tabs/${tab}.html`);
    const res = await fetch(`${url}?v=${encodeURIComponent(TAB_CACHE_BUST)}`, { cache: 'reload' });
    if (!res.ok) throw new Error(`could not load ${tab}.html (${res.status})`);
    htmlCache.set(key, await res.text());
  }
  return htmlCache.get(key);
}

async function loadModule(tab) {
  const key = `${tab}@${TAB_CACHE_BUST}`;
  if (!moduleCache.has(key)) {
    moduleCache.set(key, await import(`./tabs/${tab}.js?v=${encodeURIComponent(TAB_CACHE_BUST)}`));
  }
  return moduleCache.get(key);
}

function syncChrome(tab) {
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  $$('#userDd button').forEach((el) => el.classList.toggle('active', el.dataset.account === tab));

  const url = new URL(location.href);
  if (tab === DEFAULT_TAB) url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  // Deep-linking is a nicety; never let a history policy error break navigation.
  try {
    history.replaceState(null, '', url.pathname + url.search);
  } catch (e) {
    console.warn('could not update the URL', e);
  }
}

/**
 * Mount a tab. Safe to call repeatedly and concurrently — a stale in-flight
 * load can never overwrite a newer one (mountToken).
 * @param {string} tab
 * @param {object} [params] forwarded to the tab's mount(), e.g. { jobId }
 */
export async function activateTab(tab, params = {}) {
  const next = ALL_TABS.has(tab) ? tab : DEFAULT_TAB;
  const view = $('view');

  // Re-activating the visible tab is a no-op unless params carry a request.
  if (next === currentTab && !Object.keys(params).length) return;

  syncChrome(next);
  const token = ++mountToken;
  let step = 'start';

  try {
    step = 'html';
    const html = await loadHtml(next);
    step = 'module';
    const mod = await loadModule(next);
    if (token !== mountToken) return;

    try { currentModule?.unmount?.(); } catch (e) { console.warn(`${currentTab} unmount failed`, e); }

    step = 'paint';
    view.innerHTML = html;
    currentTab = next;
    currentModule = mod;
    step = 'mount';
    await mod.mount(view, params);
  } catch (e) {
    if (token !== mountToken) return;
    const msg = String(e?.message || e || '');
    const stale = /Failed to fetch|Extension context invalidated/i.test(msg);
    console.error(`Failed to open "${next}"`, e);
    view.innerHTML = stale
      ? `<div class="view-error">JobSimp was reloaded. Close this tab and open the dashboard again from the extension.</div>`
      : `<div class="view-error">Could not open ${next} (${step}): ${esc(msg)}</div>`;
  }
}

// Let any tab hand off to another (tracker's ✉ button → outreach, prefilled).
window.addEventListener('jobsimp:navigate', (e) => {
  activateTab(e.detail?.tab, e.detail?.params || {});
});

function closeUserMenu() {
  $('userDd').classList.remove('open');
  $('userBtn').classList.remove('open');
  $('userBtn').setAttribute('aria-expanded', 'false');
}

function initNav() {
  $$('.tab').forEach((t) => {
    t.onclick = () => { closeUserMenu(); activateTab(t.dataset.tab); };
  });

  $('userBtn').onclick = (e) => {
    e.stopPropagation();
    const open = !$('userDd').classList.contains('open');
    $('userDd').classList.toggle('open', open);
    $('userBtn').classList.toggle('open', open);
    $('userBtn').setAttribute('aria-expanded', String(open));
  };

  $('userDd').onclick = (e) => {
    const b = e.target.closest('button[data-account]');
    if (!b) return;
    closeUserMenu();
    activateTab(b.dataset.account);
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) closeUserMenu();
  });
}

async function loadUserButton() {
  const auth = await send('auth.get');
  const user = auth?.data;
  $('userLabel').textContent = user?.name || user?.email || 'Account';
  const img = $('userAvatar');
  if (user?.picture) {
    img.src = user.picture;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
}

initNav();
loadUserButton();
const bootParams = new URLSearchParams(location.search);
const bootMount = {};
if (bootParams.get('jobId')) bootMount.jobId = bootParams.get('jobId');
if (bootParams.get('resumeId')) bootMount.resumeId = bootParams.get('resumeId');
activateTab(bootParams.get('tab') || DEFAULT_TAB, bootMount);

// Profile tab: Google identity (read-only) + contact and work-auth fields.
import { $, send, data, flash } from '../lib/dom.js';

const CONTACT = ['phone', 'address'];
const LINKS = ['linkedin', 'github', 'portfolio'];
const METRICS = [
  'workAuth', 'needsSponsorship', 'salaryExpectation',
  'relocation', 'ethnicity', 'veteranStatus', 'disabilityStatus',
];

const val = (key) => $(`pf_${key}`).value.trim();
const setVal = (key, v) => { $(`pf_${key}`).value = v || ''; };

async function load() {
  const [user, profile, metrics] = await Promise.all([
    data('auth.get', undefined, {}),
    data('profile.get', undefined, {}),
    data('metrics.get', undefined, {}),
  ]);

  $('pf_name').textContent = user?.name || 'Signed in';
  $('pf_email').textContent = user?.email || '—';
  const pic = $('pf_picture');
  if (user?.picture) { pic.src = user.picture; pic.hidden = false; } else { pic.hidden = true; }

  CONTACT.forEach((k) => setVal(k, profile?.[k]));
  LINKS.forEach((k) => setVal(k, profile?.links?.[k]));
  METRICS.forEach((k) => setVal(k, metrics?.[k]));
}

async function save() {
  const btn = $('profileSave');
  btn.disabled = true;
  const [p, m] = await Promise.all([
    send('profile.update', {
      ...Object.fromEntries(CONTACT.map((k) => [k, val(k)])),
      links: Object.fromEntries(LINKS.map((k) => [k, val(k)])),
    }),
    send('metrics.update', Object.fromEntries(METRICS.map((k) => [k, val(k)]))),
  ]);
  btn.disabled = false;

  const err = [p, m].find((r) => !r?.ok)?.error;
  flash('profileSaveMsg', err ? `Save failed: ${err}` : 'Saved');
}

export async function mount() {
  $('profileSave').onclick = save;
  await load();
}

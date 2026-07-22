const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);

export async function loadProfilePanel() {
  const [authRes, profileRes, metricsRes] = await Promise.all([
    send('auth.get'),
    send('profile.get'),
    send('metrics.get'),
  ]);
  const user = authRes?.data || {};
  const profile = profileRes?.data || {};
  const metrics = metricsRes?.data || {};

  $('pf_name').textContent = user.name || 'Signed in';
  $('pf_email').textContent = user.email || '—';
  const pic = $('pf_picture');
  if (user.picture) {
    pic.src = user.picture;
    pic.hidden = false;
  } else {
    pic.hidden = true;
  }

  $('pf_phone').value = profile.phone || '';
  $('pf_address').value = profile.address || '';
  $('pf_linkedin').value = profile.links?.linkedin || '';
  $('pf_github').value = profile.links?.github || '';
  $('pf_portfolio').value = profile.links?.portfolio || '';

  $('pf_workAuth').value = metrics.workAuth || '';
  $('pf_needsSponsorship').value = metrics.needsSponsorship || '';
  $('pf_salaryExpectation').value = metrics.salaryExpectation || '';
  $('pf_relocation').value = metrics.relocation || '';
  $('pf_ethnicity').value = metrics.ethnicity || '';
  $('pf_veteranStatus').value = metrics.veteranStatus || '';
  $('pf_disabilityStatus').value = metrics.disabilityStatus || '';
}

export function initProfilePanel() {
  $('profileSave').onclick = async () => {
    await Promise.all([
      send('profile.update', {
        phone: $('pf_phone').value.trim(),
        address: $('pf_address').value.trim(),
        links: {
          linkedin: $('pf_linkedin').value.trim(),
          github: $('pf_github').value.trim(),
          portfolio: $('pf_portfolio').value.trim(),
        },
      }),
      send('metrics.update', {
        workAuth: $('pf_workAuth').value.trim(),
        needsSponsorship: $('pf_needsSponsorship').value.trim(),
        salaryExpectation: $('pf_salaryExpectation').value.trim(),
        relocation: $('pf_relocation').value.trim(),
        ethnicity: $('pf_ethnicity').value.trim(),
        veteranStatus: $('pf_veteranStatus').value.trim(),
        disabilityStatus: $('pf_disabilityStatus').value.trim(),
      }),
    ]);
    $('profileSaveMsg').textContent = 'Saved';
    setTimeout(() => { $('profileSaveMsg').textContent = ''; }, 2500);
  };
}

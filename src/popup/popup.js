const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const msg = (t) => { document.getElementById('msg').textContent = t; };

async function refresh() {
  const [jobsRes, discRes] = await Promise.all([send('job.list'), send('discovered.list')]);
  const jobs = jobsRes?.data || [];
  const active = ['OA', 'Phone Screen', 'Interview', 'Final Round'];
  const newJobs = (discRes?.data || []).filter((d) => d.state === 'new' || d.state === 'notified');
  const today = new Date().toISOString().slice(0, 10);
  const due = jobs.filter((j) => j.followup && j.followup <= today && !['Offer', 'Rejected', 'Withdrawn'].includes(j.status));

  document.getElementById('stats').innerHTML = [
    ['Tracked', jobs.length], ['Active', jobs.filter((j) => active.includes(j.status)).length], ['New leads', newJobs.length],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  document.getElementById('due').textContent = due.length ? `⚠ ${due.length} follow-up${due.length > 1 ? 's' : ''} due` : '';
}

document.getElementById('openDash').onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
document.getElementById('openOptions').onclick = () => chrome.runtime.openOptionsPage();

document.getElementById('autofill').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.onMessage.addListener(function once(m) {
    if (m?.type === '__autofill_result') {
      chrome.runtime.onMessage.removeListener(once);
      const { filled, unmatched } = m.payload;
      msg(`Filled ${filled} field(s).${unmatched.length ? `\nNo answer for: ${unmatched.slice(0, 5).join(' · ')}${unmatched.length > 5 ? '…' : ''}\nAdd answers in Settings → Q&A.` : ''}`);
    }
  });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/autofill.js'] });
  } catch (e) { msg(`Cannot autofill here: ${e.message}`); }
};

document.getElementById('trackPage').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        role: document.querySelector('h1')?.textContent?.trim().slice(0, 140) || document.title.slice(0, 140),
        url: location.href.split('?')[0],
        source: location.hostname.replace('www.', ''),
        jdText: document.body.innerText.slice(0, 12000),
      }),
    });
    const res = await send('job.save', { ...result, company: '', status: 'To Apply' });
    msg(res?.ok ? `Tracked: ${result.role}\nEdit company/details in Dashboard.` : `Failed: ${res?.error}`);
    refresh();
  } catch (e) { msg(`Cannot read this page: ${e.message}`); }
};

document.getElementById('pollNow').onclick = async () => {
  msg('Checking sources…');
  const res = await send('poll.now');
  msg(res?.ok ? `Found ${res.data} new relevant job(s).` : `Poll failed: ${res?.error}`);
  refresh();
};

refresh();

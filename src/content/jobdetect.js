// Detects a job description on supported pages and offers one-click tracking.
(() => {
  if (window.__jobsimpDetect) return; window.__jobsimpDetect = true;

  const SITES = [
    { host: /linkedin\.com/, title: '.job-details-jobs-unified-top-card__job-title, h1', company: '.job-details-jobs-unified-top-card__company-name, [data-test-app-aware-link]', jd: '.jobs-description__content, #job-details' },
    { host: /greenhouse\.io/, title: '.app-title, h1', company: '.company-name, [class*=company]', jd: '#content, .job__description, main' },
    { host: /lever\.co/, title: '.posting-headline h2, h2', company: '.main-header-logo img[alt], .posting-headline', jd: '.section-wrapper [data-qa=job-description], .content' },
    { host: /myworkdayjobs\.com/, title: '[data-automation-id="jobPostingHeader"], h1', company: null, jd: '[data-automation-id="jobPostingDescription"]' },
    { host: /indeed\.com/, title: '.jobsearch-JobInfoHeader-title, h1', company: '[data-company-name], .jobsearch-CompanyInfoContainer a', jd: '#jobDescriptionText' },
    { host: /ashbyhq\.com/, title: 'h1', company: null, jd: '[class*=description], main' },
  ];

  const site = SITES.find((s) => s.host.test(location.hostname));
  if (!site) return;

  const q = (sel) => (sel ? document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() : '');

  function extract() {
    let company = q(site.company) || '';
    if (!company && /myworkdayjobs\.com/.test(location.hostname)) {
      company = location.hostname.split('.')[0]; // {tenant}.wd5.myworkdayjobs.com
    }
    if (!company && /lever\.co|greenhouse\.io/.test(location.hostname)) {
      company = location.pathname.split('/').filter(Boolean)[0] || '';
    }
    return {
      role: q(site.title)?.slice(0, 140) || document.title.slice(0, 140),
      company: company.slice(0, 80),
      jdText: q(site.jd)?.slice(0, 12000) || '',
      url: location.href.split('?')[0],
      source: location.hostname.replace('www.', ''),
    };
  }

  function mountButton() {
    if (document.getElementById('jobsimp-track-btn')) return;
    const job = extract();
    if (!job.role || !job.jdText) return;

    const btn = document.createElement('button');
    btn.id = 'jobsimp-track-btn';
    btn.textContent = '➕ Track in JobSimp';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: 2147483647,
      background: '#4f8ef7', color: '#fff', border: 'none', borderRadius: '24px',
      padding: '12px 18px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,.35)', fontFamily: 'system-ui, sans-serif',
    });
    btn.onclick = () => {
      const fresh = extract();
      chrome.runtime.sendMessage({ type: 'job.save', payload: { ...fresh, status: 'To Apply' } }, (res) => {
        btn.textContent = res?.ok ? '✓ Tracked' : '⚠ Failed';
        btn.style.background = res?.ok ? '#34c07a' : '#e5604c';
        setTimeout(() => { btn.textContent = '➕ Track in JobSimp'; btn.style.background = '#4f8ef7'; }, 2500);
      });
    };
    document.body.appendChild(btn);
  }

  // SPA-safe: re-check on navigation/content changes, throttled.
  let t = null;
  const schedule = () => { clearTimeout(t); t = setTimeout(mountButton, 1200); };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();

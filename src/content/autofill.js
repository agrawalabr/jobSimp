// Autofill content script — injected on demand via chrome.scripting from the popup.
// Matches visible form fields against profile basics + Q&A bank. Never submits.
(async () => {
  const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
  const [profileRes, answersRes] = await Promise.all([send('profile.get'), send('answers.list')]);
  const basics = profileRes?.data?.basics || {};
  const answers = answersRes?.data || [];

  // canonical field patterns → basics keys
  const BASIC_PATTERNS = [
    [/first\s*name|given\s*name/i, 'firstName'],
    [/last\s*name|family\s*name|surname/i, 'lastName'],
    [/full\s*name|^name$|legal\s*name/i, (b) => [b.firstName, b.lastName].filter(Boolean).join(' ')],
    [/e-?mail/i, 'email'],
    [/phone|mobile/i, 'phone'],
    [/linkedin/i, 'linkedin'],
    [/github/i, 'github'],
    [/portfolio|website|personal\s*site/i, 'portfolio'],
    [/address|street/i, 'address'],
    [/city/i, 'city'],
    [/state|province/i, 'state'],
    [/zip|postal/i, 'zip'],
    [/university|school|college|institution/i, 'university'],
    [/degree/i, 'degree'],
    [/major|field\s*of\s*study/i, 'major'],
    [/graduat/i, 'gradDate'],
    [/gpa/i, 'gpa'],
    [/authorized\s*to\s*work|work\s*authorization|legally\s*authorized/i, 'workAuth'],
    [/sponsor|visa\s*(status|sponsorship)|require.*sponsorship|H-?1B/i, 'needsSponsorship'],
  ];

  function labelFor(el) {
    let txt = '';
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) txt = l.textContent;
    }
    if (!txt) txt = el.closest('label')?.textContent || '';
    if (!txt) txt = el.getAttribute('aria-label') || el.placeholder || el.name || '';
    if (!txt) { // Workday: label often a sibling of wrapper
      const wrap = el.closest('div');
      txt = wrap?.querySelector('label, [data-automation-id*="label"], legend')?.textContent || '';
    }
    return txt.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function resolveValue(label) {
    for (const [re, keyOrFn] of BASIC_PATTERNS) {
      if (re.test(label)) {
        const v = typeof keyOrFn === 'function' ? keyOrFn(basics) : basics[keyOrFn];
        if (v) return { value: v, from: 'profile' };
      }
    }
    const lc = label.toLowerCase();
    let best = null;
    for (const a of answers) {
      const pats = a.patterns?.length ? a.patterns : [a.question?.toLowerCase() || ''];
      const hits = pats.filter((p) => p && lc.includes(p.toLowerCase())).length;
      if (hits && (!best || hits > best.hits)) best = { value: a.answer, from: 'qa', hits, id: a.id };
    }
    return best;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSelect(sel, value) {
    const target = String(value).toLowerCase();
    for (const opt of sel.options) {
      const t = opt.textContent.toLowerCase();
      if (t === target || t.includes(target) || target.includes(t)) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=file]):not([type=password]), textarea, select')]
    .filter((el) => el.offsetParent !== null && !el.disabled && !el.readOnly);

  let filled = 0;
  const unmatched = [];
  for (const el of fields) {
    if (el.value && el.tagName !== 'SELECT') continue; // don't overwrite user input
    const label = labelFor(el);
    if (!label) continue;
    const match = resolveValue(label);
    if (!match) { unmatched.push(label); continue; }
    if (el.tagName === 'SELECT') { if (fillSelect(el, match.value)) filled++; }
    else if (el.type === 'checkbox' || el.type === 'radio') {
      const truthy = /^(yes|true|y)$/i.test(String(match.value));
      if ((el.type === 'checkbox' && truthy) || (el.type === 'radio' && labelFor(el).toLowerCase().includes(String(match.value).toLowerCase()))) {
        el.click(); filled++;
      }
    } else { setNativeValue(el, match.value); filled++; }
  }

  chrome.runtime.sendMessage({ type: '__autofill_result', payload: { filled, unmatched: [...new Set(unmatched)].slice(0, 25) } });
})();

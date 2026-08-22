// Content-script entry (Controller bootstrap). Classic-safe: dynamic-imports ESM services/views.
(async () => {
  if (window.top !== window) return;
  if (!chrome.runtime?.id) return;

  const { installScraper } = await import(chrome.runtime.getURL('src/service/scraper.js'));
  const { startWidget } = await import(chrome.runtime.getURL('src/component/widget/widget.js'));

  installScraper();
  await startWidget();

  // Chat assist + badge run on any LinkedIn URL (not only /jobs/*).
  if (/(^|\.)linkedin\.com$/i.test(location.hostname.replace(/^www\./, ''))) {
    try {
      const { startLinkedInMsgAssist } = await import(
        chrome.runtime.getURL('src/service/linkedin-msg-assist.js')
      );
      startLinkedInMsgAssist();
    } catch { /* ignore */ }
  }
})();

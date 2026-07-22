// On-demand autofill entry (injected via chrome.scripting.executeScript).
(async () => {
  const { runAutofill } = await import(chrome.runtime.getURL('src/service/autofill.js'));
  await runAutofill();
})();

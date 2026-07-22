import { settings } from '../dao/index.js';

/** Settings shape for dashboard + service worker (`ai` is alias for stored provider/model/keys). */
export async function getSettings() {
  const d = await settings.getView();
  return {
    ai: d.llm,
    gmail: d.gmail,
    emailTemplate: d.emailTemplate,
  };
}

export async function saveSettings(blob) {
  await settings.putView({
    llm: blob.ai,
    gmail: blob.gmail,
    emailTemplate: blob.emailTemplate,
  });
}

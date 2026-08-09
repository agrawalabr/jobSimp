/**
 * emoji.mjs — emoji-mart picker mount + insert into the active compose Quill.
 * Search: emoji, em-emoji-picker, tb-emoji-picker
 * Static CSS → emoji.css · shell markup stays in outreach.html
 */
import emojiData from '@emoji-mart/data';
import { Picker as EmojiPicker } from 'emoji-mart';
import { getQuill } from './editor.mjs';
import { injectStyleOnce } from './shared.mjs';
import emojiCss from './emoji.css';

const STYLE_ID = 'js-compose-emoji-css';

let emojiPicker = null;

export function ensureEmojiStyles() {
  injectStyleOnce(STYLE_ID, emojiCss);
}

export function insertEmoji(native) {
  const quill = getQuill();
  if (!quill || !native) return;
  const range = quill.getSelection(true);
  const index = range ? range.index : Math.max(0, quill.getLength() - 1);
  quill.insertText(index, native, 'user');
  quill.setSelection(index + native.length, 0, 'user');
}

export function mountEmojiPicker(host, { onSelect } = {}) {
  if (!host) return null;
  ensureEmojiStyles();
  host.innerHTML = '';
  emojiPicker = new EmojiPicker({
    data: emojiData,
    theme: 'dark',
    previewPosition: 'none',
    skinTonePosition: 'search',
    onEmojiSelect: (emoji) => onSelect?.(emoji?.native || ''),
  });
  host.appendChild(emojiPicker);
  return emojiPicker;
}

/**
 * Public barrel for the compose vendor bundle.
 * Edit modules / sibling *.css below — never edit ../compose-libs.js (generated).
 *
 * CSS ownership (edit the .css; dynamic bits stay in the .mjs):
 *   font.css / font.mjs      fonts (ql-font)
 *   size.css / size.mjs      text styles (ql-compose-block)
 *   align.css / align.mjs    align cycle
 *   utils.css / utils.mjs    B/I/U/strike/lists/indent/clean/color + toolbar chrome
 *   emoji.css / emoji.mjs    emoji picker
 *   editor.css / editor.mjs  Quill host shell + lifecycle
 *   shared.mjs               helpers only
 *   compose-ui.js            data (fonts + blocks + colors)
 *
 * Rebuild: npm run build:vendor → ../compose-libs.js
 */
export {
  initComposeEditor,
  initSigEditor,
  getQuill,
  getSigQuill,
  getBodyText,
  getBodyHtml,
  setBodyText,
  setBodyHtml,
  bodyIsEmpty,
  getSigBodyText,
  getSigBodyHtml,
  setSigBody,
  htmlToPlain,
  looksLikeHtml,
  syncSignatureInBody,
  syncQuillMinHeight,
  wireAlignCycle,
  assembleComposeToolbar,
  setActiveComposeQuill,
  getComposeQuillFor,
  destroyComposeEditor,
} from './editor.mjs';

export {
  insertEmoji,
  mountEmojiPicker,
} from './emoji.mjs';

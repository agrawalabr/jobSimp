/**
 * Compose Quill UI config — single data source.
 * Re-exported from enums.js for a shared import surface.
 *
 * Behavior + CSS (edit .css for static rules; .mjs for dynamic from this file):
 *   font.css / font.mjs    fonts
 *   size.css / size.mjs    text styles
 *   align.css / align.mjs  align
 *   utils.css / utils.mjs  B/I/U/lists/color + toolbar chrome
 *   emoji.css / emoji.mjs  emoji
 *   editor.css / editor.mjs Quill host
 */

export const COMPOSE_FONTS = Object.freeze([
  { value: '', label: 'Sans Serif', family: 'Arial, Helvetica, sans-serif' },
  { value: 'serif', label: 'Serif', family: "Georgia, 'Times New Roman', serif" },
  { value: 'fixed-width', label: 'Fixed Width', family: "Consolas, 'Courier New', monospace" },
  { value: 'wide', label: 'Wide', family: "'Arial Black', Gadget, sans-serif" },
  { value: 'narrow', label: 'Narrow', family: "'Arial Narrow', Arial, sans-serif" },
  { value: 'comic-sans', label: 'Comic Sans MS', family: "'Comic Sans MS', 'Comic Sans', cursive" },
  { value: 'garamond', label: 'Garamond', family: "Garamond, Baskerville, 'Times New Roman', serif" },
  { value: 'georgia', label: 'Georgia', family: 'Georgia, serif' },
  { value: 'tahoma', label: 'Tahoma', family: 'Tahoma, Verdana, sans-serif' },
  { value: 'trebuchet', label: 'Trebuchet MS', family: "'Trebuchet MS', Helvetica, sans-serif" },
  { value: 'verdana', label: 'Verdana', family: 'Verdana, Geneva, sans-serif' },
]);

/**
 * Text-style picker (`select.ql-compose-block`).
 * `value: 'body'` is the default (plain paragraph). `apply` is the Quill format map (cleared first).
 * `mark` = closed picker button · `label` = dropdown row text.
 */
export const COMPOSE_BLOCKS = Object.freeze([
  {
    value: 'title', label: 'Title', mark: 'T', tag: 'h1', em: '1.75em', menuPx: 18, weight: 700, apply: { header: 1 }
  },
  {
    value: 'heading', label: 'Heading', mark: 'H', tag: 'h2', em: '1.4em', menuPx: 15, weight: 700, apply: { header: 2 }
  },
  {
    value: 'subheading', label: 'Subheading', mark: 'S', tag: 'h3', em: '1.15em', menuPx: 13, weight: 600, apply: { header: 3 }
  },
  {
    value: 'body', label: 'Body', mark: '¶', menuPx: 16, weight: 400, apply: null, default: true
  },
  {
    value: 'mono', label: 'Monostyled', mark: '</>', menuPx: 12, weight: 500, mono: true, apply: { 'code-block': true }
  },
  {
    value: 'quote', label: 'Quote', mark: '❝', menuPx: 16, weight: 400, italic: true, apply: { blockquote: true }
  },
]);

/** Text colors for ql-color picker / .ql-color-* editor classes (utils.mjs). */
export const COMPOSE_COLORS = Object.freeze([
  { value: 'white', color: '#fff' },
  { value: 'red', color: '#e60000' },
  { value: 'orange', color: '#f90' },
  { value: 'yellow', color: '#ff0' },
  { value: 'green', color: '#008a00' },
  { value: 'blue', color: '#06c' },
  { value: 'purple', color: '#93f' },
]);

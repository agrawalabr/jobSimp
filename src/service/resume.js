import { RESUME_PARSE_PROMPT } from '../static/prompts.js';
import { requestLLM } from './llm.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Decompress a zlib-wrapped deflate chunk to a string. Returns null on failure. */
async function inflatePdfStream(bytes) {
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const writeDone = writer.write(bytes).then(() => writer.close()).catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    await writeDone;
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder('latin1').decode(out);
  } catch { return null; }
}

/** Collect /URI values from a string (handles both parenthesized and hex forms). */
function scrapeUris(str) {
  const urls = [];
  for (const m of str.matchAll(/\/URI\s*\(([^)]*(?:\\\)[^)]*)*)\)/g)) {
    urls.push(m[1].replace(/\\(.)/g, '$1'));
  }
  for (const m of str.matchAll(/\/URI\s*<([0-9a-fA-F]+)>/g)) {
    const hex = m[1];
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    urls.push(s);
  }
  return urls;
}

/**
 * Extract hyperlinks embedded in a PDF.
 * 1) Scan raw bytes for /URI (catches uncompressed annotations)
 * 2) Decompress FlateDecode streams and scan those (catches compressed annotations)
 * 3) Fallback: grab bare https:// URLs from anywhere in the binary
 */
async function extractPdfAnnotations(b64) {
  try {
    const raw = atob(b64);
    const urls = new Set();

    // Pass 1: uncompressed /URI entries
    for (const u of scrapeUris(raw)) if (/^https?:\/\//i.test(u)) urls.add(u);

    // Pass 2: decompress FlateDecode streams, scan each
    const streamRx = /stream\r?\n([\s\S]*?)endstream/g;
    for (const sm of raw.matchAll(streamRx)) {
      const bytes = Uint8Array.from(sm[1], (c) => c.charCodeAt(0));
      const text = await inflatePdfStream(bytes);
      if (!text) continue;
      for (const u of scrapeUris(text)) if (/^https?:\/\//i.test(u)) urls.add(u);
    }

    // Pass 3: bare URL fallback (catches URLs in metadata, strings, etc.)
    for (const m of raw.matchAll(/https?:\/\/[^\s)<>\]"'\\]{5,}/g)) {
      urls.add(m[0].replace(/[.,;:!?)]+$/, ''));
    }

    return [...urls];
  } catch { return []; }
}

/** Extract text + hyperlinks from a .docx file. */
async function extractDocx(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .docx file');

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdCount = view.getUint16(eocd + 10, true);
  const targets = new Set(['word/document.xml', 'word/_rels/document.xml.rels']);
  const found = {};
  let pos = cdOffset;
  for (let i = 0; i < cdCount && pos < bytes.length - 46; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const fnLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fnLen));
    if (targets.has(name)) found[name] = { method, compSize, localOffset };
    pos += 46 + fnLen + extraLen + commentLen;
  }

  async function inflate(info) {
    const lh = info.localOffset;
    const fnLen = view.getUint16(lh + 26, true);
    const exLen = view.getUint16(lh + 28, true);
    const data = bytes.slice(lh + 30 + fnLen + exLen, lh + 30 + fnLen + exLen + info.compSize);
    if (info.method === 0) return new TextDecoder().decode(data);
    if (info.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(data); writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
      const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return new TextDecoder().decode(out);
    }
    return '';
  }

  // Regex parse — DOMParser is unavailable in MV3 service workers.
  let text = '';
  if (found['word/document.xml']) {
    const xml = await inflate(found['word/document.xml']);
    const lines = [];
    for (const pm of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
      let line = '';
      for (const tm of pm[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
        line += decodeXmlEntities(tm[1]);
      }
      if (line) lines.push(line);
    }
    text = lines.join('\n');
  }

  const links = [];
  if (found['word/_rels/document.xml.rels']) {
    const xml = await inflate(found['word/_rels/document.xml.rels']);
    for (const rm of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const m = rm[0].match(/\bTarget="([^"]+)"/);
      if (m && /^https?:\/\//i.test(m[1])) links.push(decodeXmlEntities(m[1]));
    }
  }

  return { text, links: [...new Set(links)] };
}

/** Decode common XML entities (DOCX text nodes). */
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Pull tech names from a "TechStack: a, b, c" line inside project description. */
function parseTechStackFromDescription(description) {
  const raw = Array.isArray(description) ? description.join('\n') : String(description || '');
  const m = raw.match(/^\s*-?\s*TechStack:\s*(.+)$/im);
  if (!m) return [];
  return m[1].split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
}

/** Extract JSON block from LLM text, normalize into a clean resume object. */
function cleanResponse(raw) {
  if (!raw) throw new Error('Empty response from AI');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI response contained no JSON');
  const j = JSON.parse(m[0]);

  const arr = (v, fn) => (Array.isArray(v) ? v.map(fn) : []);
  const s = (v) => v || '';

  return {
    name: s(j.name), email: s(j.email), phone: s(j.phone), address: s(j.address),
    links: {
      linkedin: s(j.links?.linkedin), github: s(j.links?.github),
      portfolio: s(j.links?.portfolio), other: j.links?.other || {},
    },
    summary: s(j.summary),
    skills: Array.isArray(j.skills) ? j.skills.filter(Boolean) : [],
    experiences: arr(j.experiences, (e) => ({
      company: s(e.company), role: s(e.role), location: s(e.location),
      start: s(e.start), end: s(e.end), description: s(e.description),
    })),
    projects: arr(j.projects, (p) => {
      const description = s(p.description);
      const fromField = Array.isArray(p.technologies) ? p.technologies.filter(Boolean)
        : Array.isArray(p.tech) ? p.tech.filter(Boolean) : [];
      const technologies = fromField.length ? fromField.map(String) : parseTechStackFromDescription(description);
      return { name: s(p.name), description, url: s(p.url), technologies };
    }),
    education: arr(j.education, (e) => ({
      school: s(e.school), location: s(e.location), degree: s(e.degree),
      program: s(e.program), start: s(e.start), end: s(e.end),
      gpa: s(e.gpa), outof: s(e.outof),
    })),
    certificates: arr(j.certificates, (c) => ({
      name: s(c.name), issuer: s(c.issuer), issueDate: s(c.issueDate),
      expirationDate: s(c.expirationDate), url: s(c.url),
    })),
  };
}

/**
 * Parse a resume via LLM.
 * @param {object} doc  - { text?, dataB64?, mime?, file? }
 * @param {string} model
 * @param {string} key
 * @param {string} provider
 */
export async function parseResume(doc, model, key, provider) {
  const TEMPERATURE = 0.1;
  const MAX_TOKENS = 8192;
  const TEXT_LIMIT = 30000;

  let text = doc.text || '';
  let fileB64 = doc.dataB64 || '';
  let mime = doc.mime || 'text/plain';
  let annotations = [];

  // Path A: fresh File object from upload/drop
  if (doc.file) {
    const f = doc.file;
    mime = f.type || 'application/octet-stream';

    if (mime === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
      fileB64 = btoa(bin);
      mime = 'application/pdf';
      annotations = await extractPdfAnnotations(fileB64);
    } else if (mime === DOCX_MIME || /\.docx$/i.test(f.name)) {
      const result = await extractDocx(await f.arrayBuffer());
      text = result.text;
      annotations = result.links;
      mime = DOCX_MIME;
    } else {
      text = await f.text();
    }

  // Path B: saved resume (already has dataB64 or text from DB)
  } else if (fileB64) {
    if (mime === 'application/pdf') {
      annotations = await extractPdfAnnotations(fileB64);
    } else if (mime === DOCX_MIME) {
      const buf = Uint8Array.from(atob(fileB64), (c) => c.charCodeAt(0));
      const result = await extractDocx(buf.buffer);
      if (!text) text = result.text;
      annotations = result.links;
    }
  }

  if (!text && !fileB64) throw new Error('No resume content. Upload a PDF, .docx, or .txt.');
  if (provider === 'openai' && fileB64 && !text) {
    throw new Error('OpenAI needs text input — paste resume text, or use Gemini/Claude for PDF.');
  }

  // Build prompt
  const annotBlock = annotations.length? `\n\n--- DOCUMENT ANNOTATIONS (embedded hyperlinks) ---\n${annotations.join('\n')}` : '';
  const isPdf = fileB64 && mime === 'application/pdf';
  const parts = isPdf? [{ inlineData: { mimeType: 'application/pdf', data: fileB64 } }, { text: RESUME_PARSE_PROMPT + annotBlock }] : null;
  const prompt = isPdf? null : `${RESUME_PARSE_PROMPT}\n\n--- RESUME TEXT ---\n${text.slice(0, TEXT_LIMIT)}${annotBlock}`;
  
  // Call LLM
  const raw = await requestLLM({
    provider, model, key, prompt, parts,
    config: { temperature: TEMPERATURE, maxTokens: MAX_TOKENS },
  });

  return cleanResponse(raw);
}

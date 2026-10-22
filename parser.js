// Shared by the site (loaded with a script tag) and by scripts/build-data.js (loaded with require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModsiteParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAW = 'https://raw.githubusercontent.com';

  /* URLs */

  // Accepts github.com/owner/repo, .../tree/<ref>/<folder> (mods in a shared repo), and owner.github.io/repo
  function parseRef(input) {
    try {
      const u = new URL(String(input).trim());
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      let owner, repo, ref = '', path = '';
      if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
        if (parts.length < 2) return null;
        owner = parts[0];
        repo = parts[1].replace(/\.git$/, '');
        if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
          ref = parts[3];
          path = parts.slice(4).join('/');
        }
      } else if (u.hostname.endsWith('.github.io')) {
        owner = u.hostname.slice(0, -'.github.io'.length);
        repo = parts[0] || u.hostname;
      } else {
        return null;
      }
      path = path.replace(/\/+$/, '');
      const key = owner + '/' + repo + (path ? '/' + path : '');
      return { owner, repo, ref, path, key, id: key.toLowerCase() };
    } catch { return null; }
  }

  // Where a file lives, plus the bases used to resolve relative images and links inside it
  function makeLoc(owner, repo, ref, path) {
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    return {
      raw: `${RAW}/${owner}/${repo}/${ref}/${enc(path)}`,
      dirRaw: `${RAW}/${owner}/${repo}/${ref}/${enc(dir)}`,
      dirBlob: `https://github.com/${owner}/${repo}/blob/${ref}/${enc(dir)}`,
      rootRaw: `${RAW}/${owner}/${repo}/${ref}/`,
      rootBlob: `https://github.com/${owner}/${repo}/blob/${ref}/`,
    };
  }

  // spec is either a path from the repo root or a URL (GitHub blob/raw URLs are converted to raw)
  function locate(spec, base) {
    spec = String(spec).trim().replace(/^["'`<]+|["'`>]+$/g, '');
    if (!spec) return null;
    if (/^https?:\/\//i.test(spec)) {
      try {
        const u = new URL(spec);
        const p = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (u.hostname === 'raw.githubusercontent.com' && p.length >= 4) {
          return makeLoc(p[0], p[1], p[2], p.slice(3).join('/'));
        }
        if ((u.hostname === 'github.com' || u.hostname === 'www.github.com')
            && ['blob', 'raw', 'tree'].includes(p[2]) && p.length >= 5) {
          return makeLoc(p[0], p[1], p[3], p.slice(4).join('/'));
        }
        const dir = spec.replace(/[^/]*$/, '');
        return { raw: spec, dirRaw: dir, dirBlob: dir, rootRaw: u.origin + '/', rootBlob: u.origin + '/' };
      } catch { return null; }
    }
    return makeLoc(base.owner, base.repo, base.ref, spec.replace(/^\.?\//, ''));
  }

  /* Manifest (SMAPI allows comments and trailing commas) */

  function parseLooseJson(text) {
    text = text.replace(/^\uFEFF/, '');
    // Index of the next character that is not whitespace or a comment
    const skip = (from) => {
      let j = from;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; }
        else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else return j;
      }
    };
    let out = '', i = 0, inStr = false;
    while (i < text.length) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { i = skip(i); continue; }
      if (c === ',') {                                   // drop trailing commas
        const next = text[skip(i + 1)];
        if (next === '}' || next === ']') { i++; continue; }
      }
      out += c;
      i++;
    }
    return JSON.parse(out);
  }

  // Case-insensitive property lookup (SMAPI manifests are case-insensitive)
  function ci(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
    return k === undefined ? undefined : obj[k];
  }

  /* Stardew modsite info blocks */

  // Splits markdown into fenced code and everything else, so example blocks inside code fences are not parsed
  function splitFences(md) {
    const chunks = [];
    let buf = [], fenced = false, mark = '';
    const push = () => { if (buf.length) chunks.push({ fenced, text: buf.join('\n') }); buf = []; };
    for (const line of md.split(/\r?\n/)) {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (!fenced && m) { push(); fenced = true; mark = m[1]; buf.push(line); continue; }
      if (fenced && m && m[1][0] === mark[0] && m[1].length >= mark.length && /^\s{0,3}[`~]+\s*$/.test(line)) {
        buf.push(line); push(); fenced = false; continue;
      }
      buf.push(line);
    }
    push();
    return chunks;
  }

  const DETAILS_RE = /<details\b[^>]*>\s*<summary\b([^>]*)>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;

  function isModsiteSummary(attrs, summaryHtml) {
    return /stardew-modsite-summary/.test(attrs) || /stardew\s*modsite/i.test(summaryHtml.replace(/<[^>]+>/g, ''));
  }

  // Returns the markdown with modsite blocks removed (they are hidden on the site) and the block bodies
  function extractBlocks(md) {
    const blocks = [];
    const text = splitFences(md || '').map((chunk) => {
      if (chunk.fenced) return chunk.text;
      return chunk.text.replace(DETAILS_RE, (whole, attrs, summary, body) => {
        if (isModsiteSummary(attrs, summary)) { blocks.push(body); return ''; }
        return whole;
      });
    }).join('\n');
    return { text, blocks };
  }

  const KEYS = new Set([
    'manifest', 'moddescription', 'tags', 'dependancies', 'dependencies', 'optionalmods',
    'name', 'author', 'version', 'description', 'uniqueid', 'contentpackfor',
  ]);
  const LIST_KEYS = new Set(['tags', 'dependancies', 'dependencies', 'optionalmods']);
  const clean = (s) => String(s).trim().replace(/^["'`]+|["'`]+$/g, '').trim();

  function parseInfo(bodies) {
    const info = { manifest: '', modDescription: '', overrides: {}, tags: [], deps: [], optional: [] };
    for (const body of bodies) {
      let section = '', category = '';
      for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;

        const kv = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(line);
        const key = kv && kv[1].toLowerCase().replace(/\s+/g, '');
        if (key && KEYS.has(key)) {
          section = key;
          category = '';
          const val = clean(kv[2]);
          if (key === 'manifest') { if (val) info.manifest = val; }
          else if (key === 'moddescription') { if (val) info.modDescription = val; }
          else if (!LIST_KEYS.has(key) && val) info.overrides[key] = val;
          continue;
        }

        if (section === 'tags') {
          const t = /^[-*+]\s+(?:\[([ xX])\]\s*)?(.+)$/.exec(line);
          if (!t) continue;
          if (t[1] === undefined) category = clean(t[2]);               // a category heading
          else if (t[1] !== ' ') info.tags.push({ category, label: clean(t[2]) }); // a ticked tag
        } else if (section === 'dependancies' || section === 'dependencies') {
          const d = /^(?:[-*+]\s*)?(?:"([^"]+)"|'([^']+)'|(\S+?))\s*:\s*(required|optional)\s*,?$/i.exec(line)
            || /^(?:[-*+]\s*)?(?:"([^"]+)"|'([^']+)'|(\S+?))\s*,?$/.exec(line);
          if (!d) continue;
          const ref = d[1] || d[2] || d[3];
          const status = (d[4] || 'required').toLowerCase();
          info.deps.push({ ref, required: status !== 'optional' });
        } else if (section === 'optionalmods') {
          const o = /^(?:[-*+]\s*)?(?:"([^"]+)"|'([^']+)'|(\S+?))\s*,?$/.exec(line);
          if (o) info.optional.push(o[1] || o[2] || o[3]);
        }
      }
    }
    return info;
  }

  const norm = (s) => String(s).toLowerCase().replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const short = (s) => String(s).replace(/\s*\(.*\)\s*$/, '').trim();

  return { parseRef, makeLoc, locate, parseLooseJson, ci, extractBlocks, parseInfo, norm, short };
});

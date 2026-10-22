(() => {
  // Use a different list with ?src=other.json
  const LIST_URL = new URLSearchParams(location.search).get('src') || 'mods.json';
  const CACHE_MS = 60 * 60 * 1000; // GitHub API allows 60 requests/hour without a token
  const CACHE_PREFIX = 'mods2:';

  const $ = (sel) => document.querySelector(sel);
  const grid = $('#grid');
  const statusEl = $('#status');
  const detail = $('#detail');
  const lightbox = $('#lightbox');
  const searchEl = $('#search');
  const taglistDialog = $('#taglist');

  const mods = new Map();            // id (lowercase key) -> mod
  const best = new Map();            // dependency identity -> best known {label, href}
  const filters = { tags: new Set(), packs: new Set(), requires: new Set() };
  let taxonomy = { categories: [], standalone: [] };
  let prebuilt = {};                 // data/mods.json written by the Action: id -> fetched mod data
  let ready = false;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    node.append(...children.filter(Boolean));
    return node;
  }

  const { parseRef, makeLoc, locate, parseLooseJson, ci, extractBlocks, parseInfo, norm, short } = ModsiteParser;

  /* Tags */


  // Turns a ticked line into a known tag id ("Crops/Additions", "Cheats") or null if unrecognised
  function canonTag(category, label) {
    const l = norm(label);
    const standalone = (taxonomy.standalone || []).find((x) => norm(x) === l);
    if (standalone) return standalone;
    const cat = (taxonomy.categories || []).find((c) => norm(c.name) === norm(category));
    if (!cat) return null;
    const known = cat.tags.find((x) => norm(x) === l);
    if (known) return `${cat.name}/${short(known)}`;
    if (cat.open && !/[<>]/.test(label)) return `${cat.name}/${label.trim()}`;
    return null;
  }

  function tagLabel(id) {
    const i = id.indexOf('/');
    return i < 0 ? id : `${id.slice(0, i)}: ${id.slice(i + 1)}`;
  }

  // The copy and paste template shown on the site, generated from tags.json
  function tagTemplate() {
    const lines = [
      '<details>',
      '  <summary class="stardew-modsite-summary">Stardew Modsite Info</summary>',
      '',
      '  Tags:',
    ];
    for (const cat of taxonomy.categories || []) {
      lines.push(`  - ${cat.name}`);
      cat.tags.forEach((t) => lines.push(`    - [ ] ${t}`));
      if (cat.open) lines.push('    - [ ] <Unofficial language name>');
    }
    (taxonomy.standalone || []).forEach((s) => lines.push(`  - [ ] ${s}`));
    lines.push('', '</details>');
    return lines.join('\n');
  }


  /* Cache */

  function cacheGet(key) {
    try {
      const v = JSON.parse(localStorage.getItem(CACHE_PREFIX + key));
      if (v && Date.now() - v.t < CACHE_MS) return v.d;
    } catch {}
    return null;
  }
  function cacheSet(key, data) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); } catch {}
  }

  /* Fetching */

  async function fetchText(url) {
    try {
      const r = await fetch(url);
      return r.ok ? await r.text() : '';
    } catch { return ''; }
  }

  async function fetchReadme(base, folder) {
    const prefix = folder ? folder + '/' : '';
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']) {
      const text = await fetchText(makeLoc(base.owner, base.repo, base.ref, prefix + name).raw);
      if (text) return text;
    }
    return '';
  }

  // Fallback when the Action has not produced data for this mod: fetches it with the REST API and caches it.
  // buildMod() derives the display data from the result, same as for prebuilt data.
  async function fetchMod(target) {
    if (prebuilt[target.id]) return prebuilt[target.id];   // no API calls needed
    const cached = cacheGet(target.id);
    if (cached) return cached;

    const api = `https://api.github.com/repos/${target.owner}/${target.repo}`;
    // Mods inside a shared repo have no releases of their own, so those are skipped
    const [repoRes, relRes] = await Promise.all([
      fetch(api),
      target.path ? Promise.resolve(null) : fetch(`${api}/releases?per_page=5`),
    ]);
    if (!repoRes.ok) {
      throw new Error(repoRes.status === 403 || repoRes.status === 429
        ? 'GitHub rate limit reached. Try again later.'
        : 'Repository not found.');
    }
    const info = await repoRes.json();
    const rels = relRes && relRes.ok ? await relRes.json() : [];
    const base = { owner: target.owner, repo: target.repo, ref: target.ref || info.default_branch };

    const bundle = {
      id: target.id, key: target.key, owner: target.owner, repo: target.repo,
      ref: base.ref, path: target.path,
      url: info.html_url, stars: info.stargazers_count, description: info.description || '',
      readme: await fetchReadme(base, target.path),
      descText: '', manifestText: '',
      releases: rels.filter((r) => !r.draft).map((r) => ({
        name: r.name || r.tag_name,
        tag: r.tag_name,
        url: r.html_url,
        date: r.published_at,
        body: r.body || '',
        prerelease: r.prerelease,
        assets: (r.assets || []).map((a) => ({
          name: a.name, url: a.browser_download_url, type: a.content_type, size: a.size,
        })),
      })),
    };

    // README can point at a separate description file
    let bodies = extractBlocks(bundle.readme).blocks;
    const descLoc = locate(parseInfo(bodies).modDescription, base);
    if (descLoc) {
      bundle.descText = await fetchText(descLoc.raw);
      if (bundle.descText) bodies = bodies.concat(extractBlocks(bundle.descText).blocks);
    }
    // The manifest can be named in either document
    const manifestLoc = locate(parseInfo(bodies).manifest, base);
    if (manifestLoc) bundle.manifestText = await fetchText(manifestLoc.raw);

    cacheSet(target.id, bundle);
    return bundle;
  }

  /* Building a mod from fetched data */

  const BADGE = /shields\.io|badgen|badge|travis-ci|codecov|coveralls|img\.buymeacoffee/i;

  function resolveImage(src, loc) {
    if (!src || src.startsWith('data:')) return src;
    let href;
    try {
      href = src.startsWith('/') && !src.startsWith('//') ? loc.rootRaw + src.slice(1) : new URL(src, loc.dirRaw).href;
    } catch { return src; }
    return href.replace(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\//,
      'https://raw.githubusercontent.com/$1/'
    );
  }

  function resolveLink(href, loc) {
    try {
      return href.startsWith('/') && !href.startsWith('//') ? loc.rootBlob + href.slice(1) : new URL(href, loc.dirBlob).href;
    } catch { return href; }
  }

  // Returns { fragment, images } for markdown located at loc
  function renderMarkdown(md, loc) {
    const html = DOMPurify.sanitize(marked.parse(md || '', { gfm: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    const images = [];

    root.querySelectorAll('source').forEach((s) => s.remove());
    root.querySelectorAll('img').forEach((img) => {
      const src = resolveImage(img.getAttribute('src') || '', loc);
      img.setAttribute('src', src);
      img.removeAttribute('srcset');
      img.setAttribute('loading', 'lazy');
      if (src && !BADGE.test(src) && !images.includes(src)) images.push(src);
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { a.removeAttribute('href'); return; }
      a.setAttribute('href', resolveLink(href, loc));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    return { fragment: root, images };
  }

  function buildMod(b) {
    const base = { owner: b.owner, repo: b.repo, ref: b.ref };
    const readmeLoc = makeLoc(b.owner, b.repo, b.ref, (b.path ? b.path + '/' : '') + 'README.md');

    // Description: the README, or the file it redirects to
    const rm = extractBlocks(b.readme);
    let md = rm.text, loc = readmeLoc, bodies = rm.blocks;
    if (b.descText) {
      const descLoc = locate(parseInfo(rm.blocks).modDescription, base);
      if (descLoc) {
        const dm = extractBlocks(b.descText);
        md = dm.text; loc = descLoc; bodies = rm.blocks.concat(dm.blocks);
      }
    }
    const info = parseInfo(bodies);

    let manifest = null;
    if (b.manifestText) { try { manifest = parseLooseJson(b.manifestText); } catch {} }
    const ov = info.overrides;
    const mf = (k) => { const v = ci(manifest, k); return typeof v === 'string' ? v : ''; };

    const latest = b.releases[0];
    const packRaw = ci(manifest, 'ContentPackFor');
    const mod = {
      id: b.id,
      key: b.key,
      owner: b.owner,
      repo: b.repo,
      path: b.path,
      url: b.path ? `${b.url}/tree/${b.ref}/${b.path}` : b.url,
      repoUrl: b.url,
      stars: b.stars,
      releases: b.releases,
      rootLoc: makeLoc(b.owner, b.repo, b.ref, 'README.md'),
      descMd: md,
      descLoc: loc,
      name: ov.name || mf('Name') || (b.path ? b.path.split('/').pop() : b.repo),
      author: ov.author || mf('Author') || b.owner,
      version: ov.version || mf('Version') || (latest ? latest.tag : ''),
      summary: ov.description || mf('Description') || (b.path ? '' : b.description),   // a shared repo's description is not this mod's
      uniqueId: ov.uniqueid || mf('UniqueID'),
      packFor: ov.contentpackfor || (typeof packRaw === 'string' ? packRaw : (ci(packRaw, 'UniqueID') || '')),
      manifestDeps: (Array.isArray(ci(manifest, 'Dependencies')) ? ci(manifest, 'Dependencies') : [])
        .filter((d) => ci(d, 'UniqueID'))
        .map((d) => ({ ref: ci(d, 'UniqueID'), required: ci(d, 'IsRequired') !== false })),
      blockDeps: info.deps,
      pairs: info.optional,
      tagIds: new Set(info.tags.map((t) => canonTag(t.category, t.label)).filter(Boolean)),
    };

    const { images } = renderMarkdown(md, loc);
    const releaseImages = latest
      ? latest.assets.filter((a) => (a.type || '').startsWith('image/')).map((a) => a.url)
      : [];
    mod.images = [...images, ...releaseImages.filter((u) => !images.includes(u))];
    mod.thumb = mod.images[0] || `https://opengraph.githubassets.com/1/${b.owner}/${b.repo}`;
    mod.search = [mod.name, mod.author, mod.summary, ...[...mod.tagIds].map(tagLabel)].join(' ').toLowerCase();
    return mod;
  }

  /* Dependencies */

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const lastSegment = (url) => {
    try {
      // %2F inside a segment decodes to a slash, so split again after decoding
      const p = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/').split('/');
      return (p[p.length - 1] || '').replace(/\.git$/, '');
    } catch { return String(url); }
  };

  // ref is a GitHub URL or a mod's UniqueID. Resolves to a mod on this site when possible.
  function depInfo(ref) {
    ref = String(ref).trim();
    const isUrl = /^https?:\/\//i.test(ref);
    let target = null;
    if (isUrl) {
      const p = parseRef(ref);
      if (p) target = mods.get(p.id) || null;
    } else {
      const uid = ref.toLowerCase();
      for (const m of mods.values()) if (m.uniqueId && m.uniqueId.toLowerCase() === uid) { target = m; break; }
      if (!target) {
        // No manifest ID to match: accept a single mod whose folder or repo name matches the ID's last part
        const want = slug(ref.split('.').pop());
        const hits = [...mods.values()].filter((m) => slug(m.path ? m.path.split('/').pop() : m.repo) === want);
        if (hits.length === 1) target = hits[0];
      }
    }
    if (target) return { id: 'mod:' + target.id, label: target.name, href: '#' + target.id, internal: true };
    if (isUrl) return { id: 'ext:' + slug(lastSegment(ref)), label: lastSegment(ref), href: ref };
    return { id: 'ext:' + slug(ref.split('.').pop()), label: ref, href: null };
  }

  // Manifest and block dependencies merged, the block entry wins so its link is kept
  function modDeps(mod) {
    const map = new Map();
    for (const d of [...mod.manifestDeps, ...mod.blockDeps]) {
      const i = depInfo(d.ref);
      map.set(i.id, { ...(best.get(i.id) || i), required: d.required });
    }
    return [...map.values()];
  }

  function computeRelations() {
    best.clear();
    const note = (i) => { if (!best.has(i.id) || (!best.get(i.id).href && i.href)) best.set(i.id, i); };
    for (const mod of mods.values()) {
      if (mod.packFor) note(depInfo(mod.packFor));
      [...mod.manifestDeps, ...mod.blockDeps, ...mod.pairs.map((ref) => ({ ref }))].forEach((d) => note(depInfo(d.ref)));
    }
    for (const mod of mods.values()) {
      mod.packInfo = mod.packFor ? (best.get(depInfo(mod.packFor).id) || depInfo(mod.packFor)) : null;
      mod.packId = mod.packInfo ? mod.packInfo.id : '';
      mod.reqIds = new Set(modDeps(mod).filter((d) => d.required).map((d) => d.id));
    }
  }

  /* Cards */

  const versionLabel = (v) => (/^\d/.test(v) ? 'v' + v : v);

  function loadingCard(label) {
    return el('div', { class: 'card loading' },
      el('div', { class: 'thumb' }),
      el('div', { class: 'body' }, el('h2', { text: label }), el('p', { text: '…' })));
  }

  function fillCard(card, mod) {
    const img = el('img', { src: mod.thumb, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    const next = el('a', { class: 'card', href: '#' + mod.id },
      el('div', { class: 'thumb' }, img),
      el('div', { class: 'body' },
        el('h2', { text: mod.name }),
        el('div', { class: 'author', text: `by ${mod.author}` }),
        el('p', { text: mod.summary }),
        el('div', { class: 'meta' },
          mod.version ? el('span', { class: 'pill', text: versionLabel(mod.version) }) : null,
          mod.path ? null : el('span', { text: `${mod.stars} stars` }))));
    mod.card = next;
    card.replaceWith(next);
  }

  function errorCard(card, label, message) {
    card.replaceWith(el('div', { class: 'card error' },
      el('div', { class: 'body' }, el('h2', { text: label }), el('p', { text: message }))));
  }

  /* Search and filters */

  function applyFilters() {
    const q = searchEl.value.trim().toLowerCase();
    const count = filters.tags.size + filters.packs.size + filters.requires.size;
    let visible = 0;
    for (const mod of mods.values()) {
      if (!mod.card) continue;
      const ok = (!q || mod.search.includes(q))
        && [...filters.tags].every((t) => mod.tagIds.has(t))
        && (!filters.packs.size || filters.packs.has(mod.packId))
        && [...filters.requires].every((r) => mod.reqIds && mod.reqIds.has(r));
      mod.card.hidden = !ok;
      if (ok) visible++;
    }
    const active = Boolean(q) || count > 0;
    grid.querySelectorAll('.card.error, .card.loading').forEach((c) => { c.hidden = active; });
    $('#filter-count').textContent = count ? `(${count})` : '';
    if (ready) statusEl.textContent = active && !visible ? 'No mods match.' : '';
  }

  function checkbox(set, id, label, count) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => {
      if (input.checked) set.add(id); else set.delete(id);
      applyFilters();
    });
    return el('label', { class: 'check' }, input, el('span', { text: label }), el('span', { class: 'count', text: String(count) }));
  }

  function fieldset(title, set, items) {
    return el('fieldset', {}, title ? el('legend', { text: title }) : null,
      ...items.map((i) => checkbox(set, i.id, i.label, i.count)));
  }

  function filterSection(title, cols) {
    return el('div', { class: 'filter-section' }, el('h3', { text: title }), el('div', { class: 'filter-cols' }, ...cols));
  }

  function buildFilters() {
    const body = $('#filter-body');
    body.replaceChildren();

    const tagCounts = new Map(), packs = new Map(), reqs = new Map();
    const bump = (m, id) => m.set(id, (m.get(id) || 0) + 1);
    for (const mod of mods.values()) {
      mod.tagIds.forEach((t) => bump(tagCounts, t));
      if (mod.packId) bump(packs, mod.packId);
      mod.reqIds.forEach((r) => bump(reqs, r));
    }

    const sections = [];
    const tagCols = [];
    for (const cat of taxonomy.categories || []) {
      const names = cat.tags.map(short);
      for (const id of tagCounts.keys()) {               // languages that are not in the list
        if (id.startsWith(cat.name + '/') && !names.includes(id.slice(cat.name.length + 1))) names.push(id.slice(cat.name.length + 1));
      }
      const items = names.map((n) => ({ id: `${cat.name}/${n}`, label: n }))
        .filter((i) => tagCounts.has(i.id)).map((i) => ({ ...i, count: tagCounts.get(i.id) }));
      if (items.length) tagCols.push(fieldset(cat.name, filters.tags, items));
    }
    const general = (taxonomy.standalone || []).filter((s) => tagCounts.has(s)).map((s) => ({ id: s, label: s, count: tagCounts.get(s) }));
    if (general.length) tagCols.push(fieldset('General', filters.tags, general));
    if (tagCols.length) sections.push(filterSection('Tags', tagCols));

    const list = (map) => [...map].map(([id, count]) => ({ id, label: (best.get(id) || {}).label || id, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (packs.size) sections.push(filterSection('Content pack for', [fieldset(null, filters.packs, list(packs))]));
    if (reqs.size) sections.push(filterSection('Requires', [fieldset(null, filters.requires, list(reqs))]));

    body.append(...sections);
    $('#filters').hidden = !sections.length;
  }

  searchEl.addEventListener('input', applyFilters);
  $('#filter-clear').addEventListener('click', () => {
    Object.values(filters).forEach((s) => s.clear());
    $('#filter-body').querySelectorAll('input').forEach((i) => { i.checked = false; });
    applyFilters();
  });

  /* Tag list dialog */

  function setupTagList() {
    const code = $('#taglist-code');
    code.textContent = tagTemplate();
    $('#taglist-open').addEventListener('click', () => taglistDialog.showModal());
    $('#taglist-close').addEventListener('click', () => taglistDialog.close());
    taglistDialog.addEventListener('click', (e) => { if (e.target === taglistDialog) taglistDialog.close(); });
    const copy = $('#taglist-copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }

  /* Detail page */

  function fmtDate(d) { return d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''; }
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function linkTo(info) {
    if (!info.href) return document.createTextNode(info.label);
    const a = el('a', { href: info.href, text: info.label });
    if (!info.internal) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    return a;
  }

  function releaseBlock(rel, mod) {
    const block = el('div', { class: 'release' },
      el('div', { class: 'name', text: rel.name + (rel.prerelease ? ' (pre-release)' : '') }),
      el('div', { class: 'date', text: fmtDate(rel.date) }));
    if (rel.assets.length) {
      const list = el('ul');
      rel.assets.forEach((a) => list.append(el('li', {},
        el('a', { href: a.url, text: a.name }), ' ', el('span', { text: fmtSize(a.size) }))));
      block.append(list);
    }
    if (rel.body.trim()) {
      const notes = el('div', { class: 'notes markdown' });
      notes.append(renderMarkdown(rel.body, mod.rootLoc).fragment);
      block.append(el('details', {}, el('summary', { text: 'Release notes' }), notes));
    }
    return block;
  }

  function sideSection(title, ...content) {
    return el('section', { class: 'side-section' }, el('h2', { text: title }), ...content);
  }

  function sidebar(mod) {
    const side = el('aside', { class: 'sidebar' });

    const kv = el('dl', { class: 'kv' });
    const row = (k, v) => kv.append(el('dt', { text: k }), el('dd', {}, v));
    row('Author', mod.author);
    if (mod.version) row('Version', mod.version);
    if (mod.packInfo) row('Content pack for', linkTo(mod.packInfo));
    side.append(sideSection('Details', kv));

    if (mod.tagIds.size) {
      side.append(sideSection('Tags', el('div', { class: 'chips' },
        ...[...mod.tagIds].map((t) => el('span', { class: 'chip', text: tagLabel(t) })))));
    }

    const deps = modDeps(mod);
    if (deps.length) {
      side.append(sideSection('Dependencies', el('ul', { class: 'deps' },
        ...deps.map((d) => el('li', {}, linkTo(d), el('span', { class: 'status', text: d.required ? 'Required' : 'Optional' }))))));
    }
    if (mod.pairs.length) {
      side.append(sideSection('Pairs well with', el('ul', { class: 'deps' },
        ...mod.pairs.map((ref) => { const i = depInfo(ref); return el('li', {}, linkTo(best.get(i.id) || i)); }))));
    }

    const rels = sideSection('Releases');
    if (mod.releases.length) mod.releases.forEach((r) => rels.append(releaseBlock(r, mod)));
    else rels.append(el('p', { class: 'muted', text: mod.path ? 'Releases are listed on the repository page.' : 'No releases yet.' }));
    rels.append(el('a', { href: mod.repoUrl + '/releases', target: '_blank', rel: 'noopener noreferrer', text: 'All releases on GitHub' }));
    side.append(rels);
    return side;
  }

  function openDetail(mod) {
    detail.replaceChildren();

    const back = el('button', { class: 'btn', type: 'button', text: 'Back' });
    back.addEventListener('click', () => { location.hash = ''; });
    detail.append(el('div', { class: 'detail-bar' },
      back,
      el('div', { class: 'title', text: mod.name }),
      el('a', { class: 'btn', href: mod.url, target: '_blank', rel: 'noopener', text: 'View on GitHub' })));

    const inner = el('div', { class: 'detail-inner' });

    if (mod.images.length) {
      const gallery = el('div', { class: 'gallery' });
      mod.images.forEach((src) => {
        const img = el('img', { src, alt: '', loading: 'lazy' });
        img.addEventListener('error', () => img.remove());
        img.addEventListener('click', () => openLightbox(src));
        gallery.append(img);
      });
      inner.append(gallery);
    }

    const readme = el('article', { class: 'markdown' });
    if (mod.descMd.trim()) readme.append(renderMarkdown(mod.descMd, mod.descLoc).fragment);
    else readme.append(el('p', { text: 'This mod has no description.' }));

    inner.append(el('div', { class: 'layout' }, readme, sidebar(mod)));
    detail.append(el('div', { class: 'detail-scroll' }, inner));

    detail.hidden = false;
    document.body.classList.add('locked');
    detail.querySelector('.detail-scroll').scrollTop = 0;
    document.title = `${mod.name} - Mods`;
  }

  function closeDetail() {
    detail.hidden = true;
    document.body.classList.remove('locked');
    document.title = 'Mods';
  }

  function openLightbox(src) {
    lightbox.querySelector('img').src = src;
    lightbox.hidden = false;
  }
  lightbox.addEventListener('click', () => { lightbox.hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || taglistDialog.open) return;
    if (!lightbox.hidden) lightbox.hidden = true;
    else if (!detail.hidden) location.hash = '';
  });

  /*  Routing */

  function route() {
    const id = decodeURIComponent(location.hash.slice(1)).toLowerCase();
    const mod = mods.get(id);
    if (mod) openDetail(mod);
    else closeDetail();
  }
  window.addEventListener('hashchange', route);

  /* Start */

  async function init() {
    let list;
    try {
      const [listRes, tagRes, dataRes] = await Promise.all([
        fetch(LIST_URL),
        fetch('tags.json').catch(() => null),
        fetch('data/mods.json').catch(() => null),
      ]);
      if (!listRes.ok) throw new Error();
      list = await listRes.json();
      if (!Array.isArray(list)) throw new Error();
      if (tagRes && tagRes.ok) taxonomy = await tagRes.json();
      if (dataRes && dataRes.ok) { try { prebuilt = (await dataRes.json()).mods || {}; } catch {} }
    } catch {
      statusEl.textContent = `Could not load ${LIST_URL}. It should be a JSON array of GitHub URLs.`;
      return;
    }
    setupTagList();
    if (!list.length) { statusEl.textContent = 'The list is empty. Add GitHub URLs to mods.json.'; return; }

    const seen = new Set();
    const jobs = list.map(async (url) => {
      const target = parseRef(url);
      if (target && seen.has(target.id)) return;
      if (target) seen.add(target.id);

      const card = loadingCard(String(url).replace(/^https?:\/\//, ''));
      grid.append(card);
      if (!target) return errorCard(card, String(url), 'Not a recognised GitHub URL.');
      try {
        const mod = buildMod(await fetchMod(target));
        mods.set(mod.id, mod);
        fillCard(card, mod);
        applyFilters();
      } catch (err) {
        errorCard(card, target.key, err.message || 'Could not load this mod.');
      }
    });
    await Promise.all(jobs);

    computeRelations();
    buildFilters();
    ready = true;
    applyFilters();
    route();
  }

  init();
})();

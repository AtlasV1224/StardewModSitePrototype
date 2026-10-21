(() => {
  // Use a different list with ?src=other.json
  const LIST_URL = new URLSearchParams(location.search).get('src') || 'mods.json';
  const CACHE_MS = 60 * 60 * 1000; // GitHub API allows 60 requests/hour without token iirv

  const $ = (sel) => document.querySelector(sel);
  const grid = $('#grid');
  const statusEl = $('#status');
  const detail = $('#detail');
  const lightbox = $('#lightbox');
  const mods = new Map();

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

  /* URL parsing */

  function parseUrl(input) {
    try {
      const u = new URL(String(input).trim());
      const parts = u.pathname.split('/').filter(Boolean);
      if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
        if (parts.length >= 2) return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
      } else if (u.hostname.endsWith('.github.io')) {
        const owner = u.hostname.slice(0, -'.github.io'.length);
        return { owner, repo: parts[0] || u.hostname };
      }
    } catch {}
    return null;
  }

  /* Cache */

  function cacheGet(key) {
    try {
      const v = JSON.parse(localStorage.getItem('mods:' + key));
      if (v && Date.now() - v.t < CACHE_MS) return v.d;
    } catch {}
    return null;
  }
  function cacheSet(key, data) {
    try { localStorage.setItem('mods:' + key, JSON.stringify({ t: Date.now(), d: data })); } catch {}
  }

  /* Fetching */

  async function fetchReadme(key, branch) {
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${key}/${branch}/${name}`);
        if (r.ok) return await r.text();
      } catch {}
    }
    return '';
  }

  async function fetchMod({ owner, repo }) {
    const key = `${owner}/${repo}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const api = `https://api.github.com/repos/${key}`;
    const [repoRes, relRes] = await Promise.all([fetch(api), fetch(`${api}/releases?per_page=5`)]);
    if (!repoRes.ok) {
      throw new Error(repoRes.status === 403 || repoRes.status === 429
        ? 'GitHub rate limit reached. Try again later.'
        : 'Repository not found.');
    }
    const info = await repoRes.json();
    const rels = relRes.ok ? await relRes.json() : [];
    const branch = info.default_branch;

    const data = {
      key, owner, repo, branch,
      name: info.name,
      description: info.description || '',
      url: info.html_url,
      stars: info.stargazers_count,
      readme: await fetchReadme(key, branch),
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
    cacheSet(key, data);
    return data;
  }

  /* Markdown */

  const BADGE = /shields\.io|badgen|badge|travis-ci|codecov|coveralls|img\.buymeacoffee/i;

  function resolveImage(src, rawBase) {
    if (!src || src.startsWith('data:')) return src;
    let href;
    try { href = new URL(src.replace(/^\/(?!\/)/, ''), rawBase).href; } catch { return src; }
    return href.replace(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\//,
      'https://raw.githubusercontent.com/$1/'
    );
  }

  // Returns { fragment, images } for a markdown string belonging to a mod
  function renderMarkdown(md, mod) {
    const html = DOMPurify.sanitize(marked.parse(md || '', { gfm: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    const rawBase = `https://raw.githubusercontent.com/${mod.key}/${mod.branch}/`;
    const blobBase = `https://github.com/${mod.key}/blob/${mod.branch}/`;
    const images = [];

    root.querySelectorAll('source').forEach((s) => s.remove());
    root.querySelectorAll('img').forEach((img) => {
      const src = resolveImage(img.getAttribute('src') || '', rawBase);
      img.setAttribute('src', src);
      img.removeAttribute('srcset');
      img.setAttribute('loading', 'lazy');
      if (src && !BADGE.test(src) && !images.includes(src)) images.push(src);
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { a.removeAttribute('href'); return; }
      try { a.setAttribute('href', new URL(href, blobBase).href); } catch {}
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    return { fragment: root, images };
  }

  function enrich(mod) {
    const { fragment, images } = renderMarkdown(mod.readme, mod);
    mod.readmeFragment = fragment;
    const latest = mod.releases[0];
    const releaseImages = latest
      ? latest.assets.filter((a) => (a.type || '').startsWith('image/')).map((a) => a.url)
      : [];
    mod.images = [...images, ...releaseImages.filter((u) => !images.includes(u))];
    mod.thumb = mod.images[0] || `https://opengraph.githubassets.com/1/${mod.key}`;
  }

  /* Cards */

  function loadingCard(label) {
    return el('div', { class: 'card loading' },
      el('div', { class: 'thumb' }),
      el('div', { class: 'body' }, el('h2', { text: label }), el('p', { text: '…' })));
  }

  function fillCard(card, mod) {
    const latest = mod.releases[0];
    const img = el('img', { src: mod.thumb, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { img.remove(); });
    const next = el('a', { class: 'card', href: '#' + mod.key },
      el('div', { class: 'thumb' }, img),
      el('div', { class: 'body' },
        el('h2', { text: mod.name }),
        el('p', { text: mod.description }),
        el('div', { class: 'meta' },
          el('span', { text: latest ? latest.tag : 'No releases' }),
          el('span', { text: `${mod.stars} stars` }))));
    next.dataset.search = `${mod.name} ${mod.description}`.toLowerCase();
    card.replaceWith(next);
  }

  function errorCard(card, label, message) {
    const next = el('div', { class: 'card error' },
      el('div', { class: 'body' }, el('h2', { text: label }), el('p', { text: message })));
    card.replaceWith(next);
  }

  /* Detail page */

  function fmtDate(d) { return d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''; }
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
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
      notes.append(renderMarkdown(rel.body, mod).fragment);
      block.append(el('details', {}, el('summary', { text: 'Release notes' }), notes));
    }
    return block;
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
    if (mod.readme) readme.append(renderMarkdown(mod.readme, mod).fragment);
    else readme.append(el('p', { text: 'This repository has no README.' }));

    const side = el('aside', { class: 'sidebar' }, el('h2', { text: 'Releases' }));
    if (mod.releases.length) mod.releases.forEach((r) => side.append(releaseBlock(r, mod)));
    else side.append(el('p', { text: 'No releases yet.' }));

    inner.append(el('div', { class: 'layout' }, readme, side));
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
    if (e.key !== 'Escape') return;
    if (!lightbox.hidden) lightbox.hidden = true;
    else if (!detail.hidden) location.hash = '';
  });

  /* Routing */

  function route() {
    const key = decodeURIComponent(location.hash.slice(1));
    const mod = mods.get(key);
    if (mod) openDetail(mod);
    else closeDetail();
  }
  window.addEventListener('hashchange', route);

  /* Search */

  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    grid.querySelectorAll('a.card').forEach((c) => { c.hidden = q && !c.dataset.search.includes(q); });
  });

  /* Start */

  async function init() {
    let list;
    try {
      const res = await fetch(LIST_URL);
      if (!res.ok) throw new Error();
      list = await res.json();
      if (!Array.isArray(list)) throw new Error();
    } catch {
      statusEl.textContent = `Could not load ${LIST_URL}. It should be a JSON array of GitHub URLs.`;
      return;
    }
    if (!list.length) { statusEl.textContent = 'The list is empty. Add GitHub URLs to mods.json.'; return; }

    const jobs = list.map(async (url) => {
      const card = loadingCard(String(url).replace(/^https?:\/\//, ''));
      grid.append(card);
      const parsed = parseUrl(url);
      if (!parsed) return errorCard(card, String(url), 'Not a recognised GitHub URL.');
      try {
        const mod = await fetchMod(parsed);
        enrich(mod);
        mods.set(mod.key, mod);
        fillCard(card, mod);
      } catch (err) {
        errorCard(card, `${parsed.owner}/${parsed.repo}`, err.message || 'Could not load this mod.');
      }
    });
    await Promise.all(jobs);
    route();
  }

  init();
})();

#!/usr/bin/env node
// Fetches the data for every mod in mods.json and writes it to the data folder:
//   data/index.json        one small entry per mod, enough for the cards, search and filters
//   data/mods/<file>.json  everything for one mod (README, releases, ...), loaded when it is opened
// Repo info and releases come from the GraphQL API (many repos per request), README, description
// and manifest files come from raw.githubusercontent.com, which is not API rate limited.
// Needs a token in GITHUB_TOKEN. Run by .github/workflows/update-data.yml.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseRef, makeLoc, locate, extractBlocks, parseInfo, deriveMod } = require('../parser.js');

const ROOT = path.join(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'mods.json');
const TAGS_FILE = path.join(ROOT, 'tags.json');
const DATA_DIR = path.join(ROOT, 'data');
const MODS_DIR = path.join(DATA_DIR, 'mods');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const API = process.env.GRAPHQL_URL || 'https://api.github.com/graphql';
const TOKEN = process.env.GITHUB_TOKEN;
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const RAW = 'https://raw.githubusercontent.com';
const BATCH_SIZE = 25;       // repositories per GraphQL request
const RELEASES = 5;          // releases kept per mod
const FILE_CONCURRENCY = 4;  // simultaneous raw file downloads (kept low: raw.githubusercontent.com rate limits bursts)
const BACKOFF_MS = Number(process.env.BACKOFF_MS || 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* GraphQL */

const REPO_FIELDS = `
  description
  url
  stargazerCount
  pushedAt
  defaultBranchRef { name }
  releases(first: ${RELEASES}, orderBy: { field: CREATED_AT, direction: DESC }) {
    nodes {
      name tagName url publishedAt description isPrerelease isDraft
      releaseAssets(first: 20) { nodes { name downloadUrl contentType size } }
    }
  }`;

// One tree listing per mod folder: the exact file names, so README.MD or ReadMe.md are found too
const treeAlias = (t, j) =>
  `t${j}: object(expression: ${JSON.stringify((t.ref || 'HEAD') + ':' + t.path)}) { ... on Tree { entries { name type } } }`;

function buildQuery(repos) {
  const body = repos.map((r, i) =>
    `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) {${REPO_FIELDS}\n${r.targets.map(treeAlias).join('\n')}\n}`);
  return `query {\n  rateLimit { cost remaining resetAt }\n${body.join('\n')}\n}`;
}

async function runBatch(repos) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'stardew-modsite-data',
        },
        body: JSON.stringify({ query: buildQuery(repos) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.data) throw new Error(JSON.stringify(json.errors || json).slice(0, 300));
      if (json.data.rateLimit) {
        const { cost, remaining } = json.data.rateLimit;
        console.log(`  batch of ${repos.length}: cost ${cost}, ${remaining} points left`);
      }
      return json.data;
    } catch (err) {
      console.warn(`  batch attempt ${attempt} failed: ${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return null;
}

/* Raw files */

// Returns the text, '' if the file does not exist, or null if GitHub kept refusing (rate limit, outage).
// The difference matters: a missing file is final, a refused one must be retried on the next run.
async function fetchText(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'stardew-modsite-data' } });
      if (res.ok) return await res.text();
      if (res.status === 404) return '';
      const wait = Number(res.headers.get('retry-after'));
      await sleep(Math.min(wait > 0 ? wait * 1000 : attempt * BACKOFF_MS, 30000));
    } catch {
      await sleep(attempt * BACKOFF_MS);
    }
  }
  return null;
}

const README_EXT = ['md', 'markdown', 'mdown', 'mkd', 'txt', 'rst', 'adoc', 'org', ''];
const README_GUESSES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README'];

// The README file names in a folder listing, best first
function readmeNames(entries) {
  return entries
    .filter((e) => e.type === 'blob' && /^readme(\.[a-z]+)?$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const rank = (n) => { const i = README_EXT.indexOf((n.split('.')[1] || '').toLowerCase()); return i < 0 ? 99 : i; };
      return rank(a) - rank(b);
    });
}

// { text, ok }: ok is false when a download failed, so the result is not trustworthy
async function fetchReadme(base, folder, entries) {
  const prefix = folder ? folder + '/' : '';
  let ok = true;
  for (const name of entries ? readmeNames(entries) : README_GUESSES) {
    const text = await fetchText(makeLoc(base.owner, base.repo, base.ref, prefix + name).raw);
    if (text === null) ok = false;
    else if (text) return { text, ok: true };
  }
  return { text: '', ok };
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* One mod */

// The raw data for one mod. Releases are always fresh, the text files are reused from the previous run
// when the repository has not been pushed to since, but only if that run downloaded them all successfully.
async function buildBundle(target, repo, prev) {
  const base = {
    owner: target.owner,
    repo: target.repo,
    ref: target.ref || (repo.defaultBranchRef && repo.defaultBranchRef.name) || 'HEAD',
  };

  const releases = target.path ? [] : (repo.releases.nodes || [])
    .filter((r) => r && !r.isDraft)
    .map((r) => ({
      name: r.name || r.tagName,
      tag: r.tagName,
      url: r.url,
      date: r.publishedAt,
      body: r.description || '',
      prerelease: r.isPrerelease,
      assets: ((r.releaseAssets && r.releaseAssets.nodes) || []).map((a) => ({
        name: a.name, url: a.downloadUrl, type: a.contentType, size: a.size,
      })),
    }));

  const bundle = {
    id: target.id, key: target.key, owner: target.owner, repo: target.repo,
    ref: base.ref, path: target.path,
    url: repo.url, stars: repo.stargazerCount, description: repo.description || '',
    pushedAt: repo.pushedAt, external: false, filesOk: true,
    readme: '', descText: '', manifestText: '',
    releases,
  };

  if (!FULL_REFRESH && prev && prev.filesOk && prev.pushedAt && prev.pushedAt === repo.pushedAt
      && prev.ref === base.ref && !prev.external) {
    Object.assign(bundle, { readme: prev.readme, descText: prev.descText, manifestText: prev.manifestText });
    return bundle;
  }

  let ok = true;
  const readme = await fetchReadme(base, target.path, (repo.trees || {})[target.id]);
  bundle.readme = readme.text;
  ok = ok && readme.ok;

  // README can point at a separate description file, and either file can name the manifest
  let bodies = extractBlocks(bundle.readme).blocks;
  const descLoc = locate(parseInfo(bodies).modDescription, base);
  if (descLoc) {
    const text = await fetchText(descLoc.raw);
    if (text === null) ok = false;
    else { bundle.descText = text; if (text) bodies = bodies.concat(extractBlocks(text).blocks); }
  }
  const manifestLoc = locate(parseInfo(bodies).manifest, base);
  if (manifestLoc) {
    const text = await fetchText(manifestLoc.raw);
    if (text === null) ok = false; else bundle.manifestText = text;
  }

  const own = `${RAW}/${target.owner}/${target.repo}/`.toLowerCase();
  bundle.external = [descLoc, manifestLoc].some((l) => l && !l.raw.toLowerCase().startsWith(own));

  if (!ok) {
    // Do not let a failed download wipe out good data, and make sure the next run tries again
    bundle.filesOk = false;
    if (prev && prev.readme) {
      Object.assign(bundle, { readme: prev.readme, descText: prev.descText, manifestText: prev.manifestText });
      console.warn(`Could not refresh files for ${target.key}; kept the previous ones, will retry next run`);
    } else {
      console.warn(`Could not download all files for ${target.key}; will retry next run`);
    }
  }
  return bundle;
}

/* Output */

// A readable, collision-free file name for a mod id
function fileName(id) {
  const slug = id.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${slug}-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}.json`;
}

// What the cards, search and filters need, and nothing more
function indexEntry(bundle, file, taxonomy) {
  const m = deriveMod(bundle, taxonomy);
  return {
    id: m.id, key: m.key, owner: m.owner, repo: m.repo, ref: m.ref, path: m.path,
    url: m.url, repoUrl: m.repoUrl, stars: m.stars,
    name: m.name, author: m.author, version: m.version, summary: m.summary,
    uniqueId: m.uniqueId, packFor: m.packFor,
    manifestDeps: m.manifestDeps, blockDeps: m.blockDeps, pairs: m.pairs,
    tags: [...m.tagIds].sort(),
    thumb: m.thumb,
    file,
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/* Main */

async function main() {
  if (!TOKEN) { console.error('GITHUB_TOKEN is not set.'); process.exit(1); }

  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  if (!Array.isArray(list)) throw new Error('mods.json must be an array of URLs');
  const taxonomy = readJson(TAGS_FILE) || { categories: [], standalone: [] };

  // Last run's data, used for unchanged repos and as a fallback when GitHub fails
  const prevIndex = readJson(INDEX_FILE);
  const prevEntries = (prevIndex && prevIndex.mods) || [];
  const prevFile = new Map(prevEntries.map((e) => [e.id, e.file]));
  const readPrev = (id) => (prevFile.has(id) ? readJson(path.join(MODS_DIR, prevFile.get(id))) : null);

  // Mods to fetch, de-duplicated, and the unique repositories they live in
  const targets = new Map();
  for (const url of list) {
    const t = parseRef(url);
    if (!t) { console.warn(`Skipping unrecognised URL: ${url}`); continue; }
    if (!/^[\w.-]+$/.test(t.owner) || !/^[\w.-]+$/.test(t.repo)) { console.warn(`Skipping odd name: ${url}`); continue; }
    if (!targets.has(t.id)) targets.set(t.id, t);
  }
  const repoKey = (t) => `${t.owner}/${t.repo}`.toLowerCase();
  const repos = new Map();
  for (const t of targets.values()) {
    if (!repos.has(repoKey(t))) repos.set(repoKey(t), { owner: t.owner, repo: t.repo, targets: [] });
    repos.get(repoKey(t)).targets.push(t);
  }
  console.log(`${targets.size} mods in ${repos.size} repositories${FULL_REFRESH ? ' (full refresh)' : ''}`);

  // Repo info and releases, in batches
  const repoData = new Map();
  const repoList = [...repos.entries()];
  for (let i = 0; i < repoList.length; i += BATCH_SIZE) {
    const batch = repoList.slice(i, i + BATCH_SIZE);
    const data = await runBatch(batch.map(([, r]) => r));
    if (!data) continue;
    batch.forEach(([key, r], n) => {
      const found = data[`r${n}`];
      if (!found) return console.warn(`Repository not found: ${r.owner}/${r.repo}`);
      found.trees = {};
      r.targets.forEach((t, j) => { found.trees[t.id] = found[`t${j}`] ? found[`t${j}`].entries : null; });
      repoData.set(key, found);
    });
  }

  // README, description and manifest files
  const bundles = new Map();
  await pool([...targets.values()], FILE_CONCURRENCY, async (t) => {
    const prev = readPrev(t.id);
    const repo = repoData.get(repoKey(t));
    if (!repo) {
      if (prev) { bundles.set(t.id, prev); console.warn(`Kept previous data for ${t.key}`); }
      return;
    }
    try { bundles.set(t.id, await buildBundle(t, repo, prev)); }
    catch (err) {
      console.warn(`Failed to build ${t.key}: ${err.message}`);
      if (prev) bundles.set(t.id, prev);
    }
  });

  // One file per mod, rewritten only when its content changed
  const ids = [...bundles.keys()].sort();
  fs.mkdirSync(MODS_DIR, { recursive: true });
  let written = 0;
  const entries = [];
  for (const id of ids) {
    const file = fileName(id);
    const text = JSON.stringify(bundles.get(id)) + '\n';
    const target = path.join(MODS_DIR, file);
    let old = '';
    try { old = fs.readFileSync(target, 'utf8'); } catch {}
    if (old !== text) { fs.writeFileSync(target, text); written++; }
    entries.push(indexEntry(bundles.get(id), file, taxonomy));
  }

  // Remove files for mods that are no longer in the list, and the old single-file format
  const keep = new Set(entries.map((e) => e.file));
  let removed = 0;
  for (const f of fs.readdirSync(MODS_DIR)) {
    if (f.endsWith('.json') && !keep.has(f)) { fs.rmSync(path.join(MODS_DIR, f)); removed++; }
  }
  fs.rmSync(path.join(DATA_DIR, 'mods.json'), { force: true });

  // The index is rewritten only when an entry changed, so `generated` does not cause a commit by itself
  let indexChanged = !prevIndex || JSON.stringify(prevEntries) !== JSON.stringify(entries);
  if (indexChanged) {
    fs.writeFileSync(INDEX_FILE,
      `{"generated":${JSON.stringify(new Date().toISOString())},"mods":[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`);
  }
  console.log(`${entries.length} mods: ${written} files written, ${removed} removed, index ${indexChanged ? 'updated' : 'unchanged'}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });

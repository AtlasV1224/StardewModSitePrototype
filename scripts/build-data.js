#!/usr/bin/env node
// Fetches the data for every mod in mods.json and writes it to data/mods.json.
// Repo info and releases come from the GraphQL API (many repos per request), README, description
// and manifest files come from raw.githubusercontent.com, which is not API rate limited i think.
// Needs a token in GITHUB_TOKEN. Run by .github/workflows/update-data.yml.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseRef, makeLoc, locate, extractBlocks, parseInfo } = require('../parser.js');

const ROOT = path.join(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'mods.json');
const OUT_FILE = path.join(ROOT, 'data', 'mods.json');
const API = process.env.GRAPHQL_URL || 'https://api.github.com/graphql';
const TOKEN = process.env.GITHUB_TOKEN;
const BATCH_SIZE = 25;       // repositories per GraphQL request
const RELEASES = 5;          // releases kept per mod
const FILE_CONCURRENCY = 8;  // simultaneous raw file downloads

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* GraphQL */

const REPO_FIELDS = `
  description
  url
  stargazerCount
  defaultBranchRef { name }
  releases(first: ${RELEASES}, orderBy: { field: CREATED_AT, direction: DESC }) {
    nodes {
      name tagName url publishedAt description isPrerelease isDraft
      releaseAssets(first: 20) { nodes { name downloadUrl contentType size } }
    }
  }`;

function buildQuery(repos) {
  const body = repos.map((r, i) =>
    `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) {${REPO_FIELDS}\n}`);
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

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'stardew-modsite-data' } });
      if (res.ok) return await res.text();
      if (res.status === 404) return '';
    } catch {}
    await sleep(attempt * 1000);
  }
  return '';
}

async function fetchReadme(base, folder) {
  const prefix = folder ? folder + '/' : '';
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']) {
    const text = await fetchText(makeLoc(base.owner, base.repo, base.ref, prefix + name).raw);
    if (text) return text;
  }
  return '';
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* One mod */

// Same shape the site's REST fallback produces, so the site can use either
async function buildBundle(target, repo) {
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
    readme: await fetchReadme(base, target.path),
    descText: '', manifestText: '',
    releases,
  };

  // README can point at a separate description file, and either file can name the manifest
  let bodies = extractBlocks(bundle.readme).blocks;
  const descLoc = locate(parseInfo(bodies).modDescription, base);
  if (descLoc) {
    bundle.descText = await fetchText(descLoc.raw);
    if (bundle.descText) bodies = bodies.concat(extractBlocks(bundle.descText).blocks);
  }
  const manifestLoc = locate(parseInfo(bodies).manifest, base);
  if (manifestLoc) bundle.manifestText = await fetchText(manifestLoc.raw);
  return bundle;
}

/* Main */

async function main() {
  if (!TOKEN) { console.error('GITHUB_TOKEN is not set.'); process.exit(1); }

  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  if (!Array.isArray(list)) throw new Error('mods.json must be an array of URLs');

  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).mods || {}; } catch {}

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
  for (const t of targets.values()) if (!repos.has(repoKey(t))) repos.set(repoKey(t), { owner: t.owner, repo: t.repo });
  console.log(`${targets.size} mods in ${repos.size} repositories`);

  // Repo info and releases, in batches
  const repoData = new Map();
  const repoList = [...repos.entries()];
  for (let i = 0; i < repoList.length; i += BATCH_SIZE) {
    const batch = repoList.slice(i, i + BATCH_SIZE);
    const data = await runBatch(batch.map(([, r]) => r));
    if (!data) continue;
    batch.forEach(([key, r], n) => {
      if (data[`r${n}`]) repoData.set(key, data[`r${n}`]);
      else console.warn(`Repository not found: ${r.owner}/${r.repo}`);
    });
  }

  // README, description and manifest files, then assemble the output
  const mods = {};
  await pool([...targets.values()], FILE_CONCURRENCY, async (t) => {
    const repo = repoData.get(repoKey(t));
    if (!repo) {
      if (previous[t.id]) { mods[t.id] = previous[t.id]; console.warn(`Kept previous data for ${t.key}`); }
      return;
    }
    try { mods[t.id] = await buildBundle(t, repo); }
    catch (err) {
      console.warn(`Failed to build ${t.key}: ${err.message}`);
      if (previous[t.id]) mods[t.id] = previous[t.id];
    }
  });

  // Only rewrite the file when something changed, so the repo is not committed to every run
  const ids = Object.keys(mods).sort();
  const sorted = Object.fromEntries(ids.map((id) => [id, mods[id]]));
  if (JSON.stringify(sorted) === JSON.stringify(previous)) { console.log('No changes.'); return; }

  const lines = ids.map((id) => `${JSON.stringify(id)}: ${JSON.stringify(mods[id])}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE,
    `{\n"generated": ${JSON.stringify(new Date().toISOString())},\n"mods": {\n${lines.join(',\n')}\n}\n}\n`);
  console.log(`Wrote ${ids.length} mods to data/mods.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });

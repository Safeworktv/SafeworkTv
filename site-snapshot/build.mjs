import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const ORIGIN = 'https://safeworktv.vercel.app';
const AST_COMMIT = 'cc670520af127605cd24b9a4b77397d44f0cac4d';
const AST_BASE = `https://raw.githubusercontent.com/Safeworktv/SafeworkTv/${AST_COMMIT}/ast-public`;
const DIST = path.resolve('dist');

const seedRoutes = [
  '/', '/simuladores', '/herramientas', '/recursos', '/capacitacion', '/libro',
  '/simuladores/extintores', '/herramientas/evaluacion-riesgos', '/herramientas/epp', '/herramientas/ruido'
];
const routes = new Set(seedRoutes);
const fetchedRoutes = new Set();
const assetQueue = [];
const queuedAssets = new Set();
const fetchedAssets = new Set();

function isAsset(p) {
  return /\.(?:css|js|mjs|json|webp|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|mp3|wav|mp4)(?:\?|$)/i.test(p);
}
function cleanPath(p) {
  try {
    const u = new URL(p, ORIGIN);
    if (u.origin !== ORIGIN) return null;
    return u.pathname + (isAsset(u.pathname) ? u.search : '');
  } catch { return null; }
}
function mapPublicPath(pathname) {
  return pathname.startsWith('/_next/static/') ? pathname.replace('/_next/static/', '/portal-static/') : pathname;
}
function queueAsset(p) {
  const c = cleanPath(p);
  if (!c || !isAsset(c) || queuedAssets.has(c)) return;
  queuedAssets.add(c); assetQueue.push(c);
}
function discoverFromHtml(html, allowRoutes = true) {
  for (const m of html.matchAll(/\b(?:src|href)=(["'])(.*?)\1/gi)) {
    const raw = m[2].replaceAll('&amp;', '&');
    if (raw.startsWith('/_next/image?')) {
      try {
        const u = new URL(raw, ORIGIN);
        const underlying = u.searchParams.get('url');
        if (underlying?.startsWith('/')) queueAsset(underlying);
      } catch {}
      continue;
    }
    const c = cleanPath(raw);
    if (!c) continue;
    if (isAsset(c)) queueAsset(c);
    else if (allowRoutes && raw.startsWith('/') && !raw.startsWith('/_next/') && !raw.startsWith('/api/')) {
      const pathname = c.split('?')[0].replace(/\/$/, '') || '/';
      if (routes.size < 40 && pathname !== '/herramientas/ast') routes.add(pathname);
    }
  }
  for (const m of html.matchAll(/\/_next\/image\?url=([^&"'\s]+)/g)) {
    try { const p = decodeURIComponent(m[1]); if (p.startsWith('/')) queueAsset(p); } catch {}
  }
}
function stripPortalScripts(html) {
  html = html.replace(/<link\b[^>]*rel=["']preload["'][^>]*as=["']script["'][^>]*>/gi, '');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return html;
}
function patchTools(html) {
  const oldBlock = '<a class="catalog-card upcoming" href="/herramientas/ast"><span class="catalog-code">AST</span><span class="status-pill">EN PREPARACIÓN</span><h2>Análisis seguro de trabajo</h2><p>La herramienta se incorporará dentro de esta estructura de SafeWorkTV.</p><strong>Ver información →</strong></a>';
  const newBlock = '<a class="catalog-card" href="/herramientas/ast"><span class="catalog-code">AST</span><span class="status-pill" style="border-color:rgba(85,218,141,.55);color:#55da8d">DISPONIBLE</span><h2>Análisis seguro de trabajo</h2><p>Elabora el AST paso a paso, identifica peligros, evalúa riesgos, define controles y genera el formato para guardar, descargar o imprimir.</p><strong>Abrir herramienta →</strong></a>';
  if (!html.includes(oldBlock)) throw new Error('No se encontró la tarjeta AST esperada para actualizar.');
  return html.replace(oldBlock, newBlock);
}
async function fetchOk(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'SafeWorkTV snapshot builder/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}
async function saveRoute(route) {
  const res = await fetchOk(ORIGIN + route);
  let html = await res.text();
  discoverFromHtml(html, true);
  if (route === '/herramientas') html = patchTools(html);
  if (route !== '/simuladores/extintores') html = stripPortalScripts(html);
  html = html.replaceAll('/_next/static/', '/portal-static/');
  const rel = route === '/' ? 'index.html' : route.replace(/^\//,'') + '.html';
  const out = path.join(DIST, rel);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html);
  fetchedRoutes.add(route);
  console.log('route', route, html.length);
}
function discoverFromText(text) {
  for (const m of text.matchAll(/\/_next\/static\/[A-Za-z0-9_./~@%+\-]+\.(?:js|css|woff2?)/g)) queueAsset(m[0]);
  for (const m of text.matchAll(/\/(?:simuladores|images|assets)\/[A-Za-z0-9_./~@%+\-]+\.(?:webp|png|jpe?g|svg|mp3|wav)/g)) queueAsset(m[0]);
}
async function saveAsset(p) {
  const pathname = p.split('?')[0];
  const res = await fetch(ORIGIN + p, { headers: { 'user-agent': 'SafeWorkTV snapshot builder/1.0' } });
  if (!res.ok) { console.warn('asset-skip', res.status, p); return; }
  let buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const isText = /javascript|text\/css|text\/plain/.test(ct) || /\.(?:js|css)$/.test(pathname);
  if (isText) {
    const originalText = buf.toString('utf8');
    discoverFromText(originalText);
    if (/\.css$/i.test(pathname) || /text\/css/.test(ct)) {
      for (const m of originalText.matchAll(/url\((['"]?)([^)'"\s]+)\1\)/g)) {
        const raw = m[2];
        if (raw.startsWith('data:') || raw.startsWith('http:') || raw.startsWith('https:')) continue;
        try {
          const resolved = new URL(raw, ORIGIN + pathname);
          if (resolved.origin === ORIGIN) queueAsset(resolved.pathname);
        } catch {}
      }
    }
    buf = Buffer.from(originalText.replaceAll('/_next/static/', '/portal-static/'), 'utf8');
  }
  const publicPath = mapPublicPath(pathname);
  const out = path.join(DIST, publicPath.replace(/^\//,''));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf);
  fetchedAssets.add(p);
}
async function addScenarioCandidates() {
  for (const letter of ['a','b','c','d','k']) {
    for (let i=1;i<=12;i++) queueAsset(`/simuladores/extintores/scenarios/${letter}${String(i).padStart(2,'0')}.webp`);
  }
}
async function writeAst() {
  const parts = await Promise.all(Array.from({length:7}, async (_,i) => {
    const r = await fetchOk(`${AST_BASE}/chunk-${String(i).padStart(2,'0')}.txt`);
    return (await r.text()).trim();
  }));
  const html = gunzipSync(Buffer.from(parts.join(''), 'base64'));
  const out = path.join(DIST, 'herramientas/ast.html');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html);
  console.log('AST', html.length);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

let index = 0;
while (index < [...routes].length && fetchedRoutes.size < 40) {
  const route = [...routes][index++];
  if (fetchedRoutes.has(route) || route === '/herramientas/ast') continue;
  try { await saveRoute(route); } catch (e) { console.warn('route-skip', route, e.message); }
}
await addScenarioCandidates();

while (assetQueue.length) {
  const p = assetQueue.shift();
  if (fetchedAssets.has(p)) continue;
  try { await saveAsset(p); } catch (e) { console.warn('asset-error', p, e.message); }
}
for (const p of ['/safeworktv-symbol.webp','/safeworktv-portada-oficial.webp','/favicon.svg','/og.jpg']) {
  if (!fetchedAssets.has(p)) { try { await saveAsset(p); } catch {} }
}
await writeAst();
console.log(`snapshot complete: ${fetchedRoutes.size} routes, ${fetchedAssets.size} assets`);

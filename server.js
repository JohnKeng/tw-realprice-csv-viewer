// server.js
// A tiny viewer for MOI Real Price CSVs using ONLY Node core modules.
// Usage:
//   1) Put index.html in ./public (你已經有了)
//   2) node server.js
//   3) Open http://localhost:3000
//
// 這版特點：上傳 ZIP 直接解壓到 ./data（覆蓋舊檔，沒有批次目錄）
//          前端可讀 /api/manifest 拿到期間文字(period)與城市清單

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const readline = require('readline');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_ROOT = path.join(__dirname, 'data');

function log(...args){ console.log(`[${new Date().toISOString()}]`, ...args); }
function logErr(...args){ console.error(`[${new Date().toISOString()}]`, ...args); }

// ---------- small utils ----------
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let reqPath = url.parse(req.url).pathname;
  if (reqPath === '/') reqPath = '/index.html';
  const full = path.join(__dirname, 'public', path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

async function emptyDir(dir){
  await fs.promises.mkdir(dir, { recursive: true });
  const items = await fs.promises.readdir(dir);
  await Promise.all(items.map(async (name)=>{
    const p = path.join(dir, name);
    await fs.promises.rm(p, { recursive: true, force: true });
  }));
}

function saveIncomingFile(req, destPath, maxBytes = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const ws = fs.createWriteStream(destPath);
    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) {
        ws.destroy();
        req.destroy();
        reject(new Error('檔案過大，請分批或壓縮後再上傳'));
      }
    });
    req.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
    req.pipe(ws);
  });
}

function execCmd(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], ...opts });
    let out = '', err = '';
    p.stdout && p.stdout.on('data', d => out += d.toString());
    p.stderr && p.stderr.on('data', d => err += d.toString());
    p.on('error', (e)=>{ logErr(cmd, 'spawn error', e); reject(e); });
    p.on('exit', code => {
      if (code === 0) { if (out) log(cmd, 'ok:', out.trim()); return resolve(); }
      const msg = `${cmd} exited ${code}: ${err || out}`;
      logErr(msg); reject(new Error(msg));
    });
  });
}

async function flattenIfSingleDir(dest) {
  try {
    const items = await fs.promises.readdir(dest, { withFileTypes: true });
    const subdirs = items.filter(d => d.isDirectory());
    const files = items.filter(d => d.isFile());
    if (files.length === 0 && subdirs.length === 1) {
      const inner = path.join(dest, subdirs[0].name);
      const innerItems = await fs.promises.readdir(inner, { withFileTypes: true });
      for (const it of innerItems) {
        const from = path.join(inner, it.name);
        const to = path.join(dest, it.name);
        await fs.promises.rename(from, to).catch(async () => {
          await fs.promises.cp(from, to, { recursive: true, force: true });
        });
      }
      try { await fs.promises.rmdir(inner); } catch {}
    }
  } catch {}
}

async function extractZip(zipPath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  try { await execCmd('unzip', ['-o', zipPath, '-d', destDir]); return; } catch {}
  if (process.platform === 'win32') {
    try {
      await execCmd('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`]);
      return;
    } catch {}
  }
  try { await execCmd('bsdtar', ['-xf', zipPath, '-C', destDir]); return; } catch {}
  try { await execCmd('tar', ['-xf', zipPath, '-C', destDir]); return; } catch {}
  throw new Error('找不到系統解壓工具（請安裝 unzip，或在 Windows 使用 PowerShell 的 Expand-Archive）');
}

// ---------- CSV helpers ----------
function parseCSVLine(s) {
  const out = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
  }
  out.push(field); return out;
}

async function streamCSV(filePath, onHeader, onRow) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  let header = null; let lineNum = 0;
  for await (let line of rl) {
    lineNum++;
    if (lineNum === 1 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1); // BOM
    const cells = parseCSVLine(line);
    if (cells.length === 1 && cells[0].trim() === '') continue; // skip empty
    if (!header) { header = cells; if (onHeader) onHeader(header); continue; }
    if (/^[A-Za-z]/.test(cells[0])) continue; // skip English titles line
    await onRow(cells, header);
  }
}

// ---------- dataset helpers ----------
const CITY_NAMES = {
  a:'臺北市', b:'臺中市', c:'基隆市', d:'臺南市', e:'高雄市', f:'新北市',
  g:'宜蘭縣', h:'桃園市', i:'嘉義市', j:'新竹縣', k:'苗栗縣',
  m:'南投縣', n:'彰化縣', o:'新竹市', p:'雲林縣', q:'嘉義縣',
  t:'屏東縣', u:'花蓮縣', v:'臺東縣', w:'金門縣', x:'澎湖縣', z:'連江縣'
};
const TYPE_META = {
  a: { title: '不動產買賣', needs: ['land', 'build', 'park'] },
  b: { title: '預售屋買賣', needs: ['land', 'park'] },
  c: { title: '不動產租賃', needs: ['land', 'build', 'park'] }
};

function loadManifest(dataDir) {
  const manifestPath = path.join(dataDir, 'manifest.csv');
  const cities = {};  // code -> {code, name}
  const files = {};   // code -> { a,b,c,a_land,... }
  if (!fs.existsSync(manifestPath)) return { cities: {}, files: {} };

  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const name = row[0];
    if (!name || !name.endsWith('.csv')) continue;
    const code = name.split('_')[0];
    files[code] = files[code] || {};
    if (name.endsWith('_lvr_land_a.csv')) files[code].a = name;
    if (name.endsWith('_lvr_land_b.csv')) files[code].b = name;
    if (name.endsWith('_lvr_land_c.csv')) files[code].c = name;
    if (name.endsWith('_lvr_land_a_land.csv')) files[code].a_land = name;
    if (name.endsWith('_lvr_land_a_build.csv')) files[code].a_build = name;
    if (name.endsWith('_lvr_land_a_park.csv')) files[code].a_park = name;
    if (name.endsWith('_lvr_land_b_land.csv')) files[code].b_land = name;
    if (name.endsWith('_lvr_land_b_park.csv')) files[code].b_park = name;
    if (name.endsWith('_lvr_land_c_land.csv')) files[code].c_land = name;
    if (name.endsWith('_lvr_land_c_build.csv')) files[code].c_build = name;
    if (name.endsWith('_lvr_land_c_park.csv')) files[code].c_park = name;
  }
  const cityObjs = {};
  for (const code of Object.keys(files)) { cityObjs[code] = { code, name: CITY_NAMES[code] || code }; }
  return { cities: cityObjs, files };
}

// build_time.xml => lvr_time 期間字串（你提供的那段）
function loadPeriod(dataDir) {
  try {
    const xml = fs.readFileSync(path.join(dataDir, 'build_time.xml'), 'utf8');
    const m = xml.match(/<lvr_time>(.*?)<\/lvr_time>/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// 友善顯示（民國年月日 → y/m/d 範圍），失敗就回原文
function parsePeriodParts(text){
  const rx = (label) => new RegExp(label + '\\s*([0-9]{3})年\\s*([0-9]{1,2})月\\s*([0-9]{1,2})日\\s*至\\s*([0-9]{3})年\\s*([0-9]{1,2})月\\s*([0-9]{1,2})日');
  const saleM = text.match(rx('登記日期'));
  const rentM = text.match(rx('訂約日期'));
  const preM  = text.match(rx('交易日期'));
  function fmt(m){
    if (!m) return '';
    const y1=m[1], mo1=m[2].padStart(2,'0'), d1=m[3].padStart(2,'0');
    const y2=m[4], mo2=m[5].padStart(2,'0'), d2=m[6].padStart(2,'0');
    return { y1, mo1, d1, y2, mo2, d2 };
  }
  return { sale: fmt(saleM), rent: fmt(rentM), presale: fmt(preM) };
}
function friendlyLabelFromPeriod(text){
  if (!text) return '';
  const p = parsePeriodParts(text);
  const sale = p.sale ? `買賣:${p.sale.y1}/${p.sale.mo1}/${p.sale.d1}–${p.sale.y2}/${p.sale.mo2}/${p.sale.d2}` : '';
  const rent = p.rent ? `租賃:${p.rent.y1}/${p.rent.mo1}/${p.rent.d1}–${p.rent.y2}/${p.rent.mo2}/${p.rent.d2}` : '';
  const presale = p.presale ? `預售:${p.presale.y1}/${p.presale.mo1}/${p.presale.d1}–${p.presale.y2}/${p.presale.mo2}/${p.presale.d2}` : '';
  const parts = [sale, rent, presale].filter(Boolean);
  return parts.length ? parts.join('｜') : text;
}

// ---------- HTTP handlers ----------
async function handleUpload(req, res) {
  const filenameHeader = req.headers['x-filename'] || 'upload.zip';
  const safeName = filenameHeader.replace(/[^A-Za-z0-9._-]/g, '_');
  const tmpZip = path.join(os.tmpdir(), `${Date.now()}_${safeName}`);
  try {
    await saveIncomingFile(req, tmpZip);
    // 覆蓋 data：先清空，再解壓到 data 根目錄
    await fs.promises.mkdir(DATA_ROOT, { recursive: true });
    await emptyDir(DATA_ROOT);
    await extractZip(tmpZip, DATA_ROOT);
    await flattenIfSingleDir(DATA_ROOT);

    const period = loadPeriod(DATA_ROOT);
    json(res, 200, { ok: true, period, periodFriendly: friendlyLabelFromPeriod(period) });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  } finally {
    fs.unlink(tmpZip, () => {});
  }
}

async function listHandler(req, res, q) {
  const { city='a', type='a', page='1', limit='20', keyword='', district='' } = q;
  const file = path.join(DATA_ROOT, `${city}_lvr_land_${type}.csv`);
  if (!fs.existsSync(file)) return json(res, 200, { header: [], rows: [], page: 1, limit: 20, total: 0 });

  let total = 0;
  const L = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
  const P = Math.max(1, parseInt(page, 10) || 1);
  const start = (P - 1) * L;
  const picked = [];
  let header = null;
  const keywordLower = (keyword || '').trim().toLowerCase();

  await streamCSV(file, (h) => { header = h; }, async (row, h) => {
    let ok = true;
    if (keywordLower) {
      const ai = h.indexOf('土地位置建物門牌');
      const di = h.indexOf('鄉鎮市區');
      const mi = h.indexOf('備註');
      const joined = [ai>=0?row[ai]:'', di>=0?row[di]:'', mi>=0?row[mi]:''].join(' ').toLowerCase();
      ok = joined.includes(keywordLower);
    }
    if (!ok) return;
    if (district && header.indexOf('鄉鎮市區') >= 0) {
      const di = header.indexOf('鄉鎮市區');
      if (row[di] !== district) return;
    }
    total++;
    if (total > start && picked.length < L) picked.push(row);
  });

  json(res, 200, { header, rows: picked, page: P, limit: L, total });
}

async function districtsHandler(req, res, q) {
  const { city='a', type='a' } = q;
  const file = path.join(DATA_ROOT, `${city}_lvr_land_${type}.csv`);
  if (!fs.existsSync(file)) return json(res, 200, { header: [], districts: [] });
  const set = new Set(); let header = null;
  await streamCSV(file, (h)=>{ header = h; }, async (row, h) => {
    const idx = h.indexOf('鄉鎮市區');
    if (idx >= 0 && row[idx]) set.add(row[idx]);
  });
  const arr = Array.from(set);
  arr.sort((a,b)=>a.localeCompare(b, 'zh-Hant'));
  json(res, 200, { header, districts: arr });
}

async function detailHandler(req, res, q) {
  const { city='a', type='a', id } = q;
  if (!id) return json(res, 400, { error: 'missing id' });
  const mainFile = path.join(DATA_ROOT, `${city}_lvr_land_${type}.csv`);
  if (!fs.existsSync(mainFile)) return json(res, 404, { error: 'not found' });

  let header = null; let mainRow = null;
  await streamCSV(mainFile, (h)=>{ header = h; }, async (row, h) => {
    const idx = h.indexOf('編號');
    if (idx >= 0 && row[idx] === id) { mainRow = row; }
  });
  if (!mainRow) return json(res, 404, { error: 'not found' });

  const details = { land: [], build: [], park: [] };
  const needs = TYPE_META[type]?.needs || [];
  for (const kind of needs) {
    const f = path.join(DATA_ROOT, `${city}_lvr_land_${type}_${kind}.csv`);
    if (!fs.existsSync(f)) continue;
    let h2 = null;
    await streamCSV(f, (h)=>{ h2 = h; }, async (row) => {
      if (row[0] === id) details[kind].push(row);
    });
    details[`${kind}Header`] = h2;
  }
  json(res, 200, { header, row: mainRow, details });
}

function manifestHandler(req, res) {
  const period = loadPeriod(DATA_ROOT);
  const { cities, files } = loadManifest(DATA_ROOT);
  json(res, 200, {
    period,
    periodFriendly: friendlyLabelFromPeriod(period),
    cities: Object.values(cities),
    files,
    types: TYPE_META
  });
}

function healthHandler(req, res) { json(res, 200, { ok: true }); }

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try { log(req.method, req.url); } catch {}
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  try {
    if (pathname === '/upload' && req.method === 'POST') return handleUpload(req, res);
    if (pathname.startsWith('/api/manifest')) return manifestHandler(req, res);
    if (pathname.startsWith('/api/health')) return healthHandler(req, res);
    if (pathname.startsWith('/api/list')) return listHandler(req, res, query);
    if (pathname.startsWith('/api/detail')) return detailHandler(req, res, query);
    if (pathname.startsWith('/api/districts')) return districtsHandler(req, res, query);
    return serveStatic(req, res);
  } catch (e) {
    logErr('Top-level handler error:', e?.stack || e?.message || e);
    json(res, 500, { ok:false, error: e?.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`Real Price viewer running at http://localhost:${PORT}`);
});

process.on('uncaughtException', (e)=>logErr('uncaughtException', e?.stack||e));
process.on('unhandledRejection', (e)=>logErr('unhandledRejection', e));

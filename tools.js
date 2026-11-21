#!/usr/bin/env node
// Funding Atlas maintenance tool — zero dependencies (Node >= 14).
//   node tools.js check            validate atlas.json + payout.json, flag stale entries (default: older than 14 days)
//   node tools.js check --days 7   custom staleness window
//   node tools.js build            validate; inline atlas.json, the program list and the static tip box into index.html;
//                                  render the guide .md to .html; write p/<id>.html, give.html and sitemap.xml
//   node tools.js live             print only programs you can act on now (open / rolling / upcoming / rail)
//   node tools.js payout           print the tip addresses (EVM / SOL / BTC) the pages will show, or that they are hidden
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DATA = path.join(DIR, 'atlas.json');
const PAYOUT = path.join(DIR, 'payout.json');
const PAGE = path.join(DIR, 'index.html');
const GUIDES = [{ md: 'guide-2026-11-zh.md', html: 'guide-2026-11-zh.html' }];
// When this folder sits inside the game repo (founders/f12/workspace/funding-atlas), cross-check the
// tip address against the address the game registered for f12. Outside the game repo this is skipped.
const GAME_STATE = path.join(DIR, '..', '..', '..', '..', 'game', 'state.json');
const WALLETS = path.join(DIR, '..', '..', 'wallets.json'); // founders/f12/wallets.json
const FOUNDER_ID = 'f12';
const STATUSES = ['open', 'rolling', 'upcoming', 'closed', 'unconfirmed', 'paused', 'ended', 'rail'];
const REQUIRED = ['id', 'name', 'operator', 'kind', 'status', 'amount', 'payout', 'who', 'how_to_apply', 'apply_url', 'deadline', 'sources', 'verified_on'];

const args = process.argv.slice(2);
const cmd = args[0] || 'check';
const daysFlag = args.indexOf('--days');
const STALE_DAYS = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 14;

// ---------- keccak256 (for EIP-55 address checksums) ----------
const MASK = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = (B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y])) & MASK;
    A[0] ^= RC[r];
  }
}
function keccak256(data) {
  const rate = 136;
  const msg = Buffer.from(data);
  const p = Buffer.concat([msg, Buffer.alloc(rate - (msg.length % rate))]);
  p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out;
}
function toChecksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = keccak256(Buffer.from(a, 'ascii')).toString('hex');
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

// ---------- data ----------
function load() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

function validate(atlas) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  if (!Array.isArray(atlas.programs)) errors.push('programs must be an array');
  for (const s of STATUSES) if (!atlas.status_legend || !atlas.status_legend[s]) errors.push(`status_legend is missing "${s}"`);
  for (const p of atlas.programs || []) {
    const tag = p.id || '(no id)';
    for (const k of REQUIRED) if (p[k] === undefined || p[k] === null || p[k] === '') errors.push(`${tag}: missing ${k}`);
    if (seen.has(p.id)) errors.push(`${tag}: duplicate id`);
    seen.add(p.id);
    if (!STATUSES.includes(p.status)) errors.push(`${tag}: bad status "${p.status}"`);
    if (!Array.isArray(p.sources) || !p.sources.length) errors.push(`${tag}: needs at least one source`);
    for (const u of [p.apply_url].concat(p.sources || [])) if (typeof u !== 'string' || !/^https:\/\//.test(u)) errors.push(`${tag}: non-https url ${u}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.verified_on || '')) errors.push(`${tag}: verified_on must be YYYY-MM-DD`);
    else {
      const age = (Date.now() - Date.parse(p.verified_on + 'T00:00:00Z')) / 86400000;
      if (age > STALE_DAYS) warnings.push(`${tag}: last verified ${p.verified_on} (${Math.floor(age)} days ago) — re-check`);
    }
  }
  const GIVE_REQ = ['id', 'name', 'status', 'funds', 'how', 'networks', 'cautions', 'official_url', 'sources', 'verified_on'];
  const gseen = new Set();
  for (const g of atlas.give || []) {
    const tag = 'give/' + (g.id || '(no id)');
    for (const k of GIVE_REQ) if (g[k] === undefined || g[k] === null || g[k] === '') errors.push(`${tag}: missing ${k}`);
    if (gseen.has(g.id)) errors.push(`${tag}: duplicate id`);
    gseen.add(g.id);
    if (!atlas.give_legend || !atlas.give_legend[g.status]) errors.push(`${tag}: status "${g.status}" is not in give_legend`);
    for (const u of [g.official_url].concat(g.sources || [])) if (typeof u !== 'string' || !/^https:\/\//.test(u)) errors.push(`${tag}: non-https url ${u}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.verified_on || '')) errors.push(`${tag}: verified_on must be YYYY-MM-DD`);
    // Donation addresses are deliberately never listed: readers copy them from the official page.
    if (/0x[0-9a-fA-F]{40}/.test(JSON.stringify(g))) errors.push(`${tag}: contains a 0x address — link the official page instead`);
  }
  if (atlas.site_url && !/^https:\/\/.+\/$/.test(atlas.site_url)) errors.push('site_url must be https and end with /');
  for (const p of atlas.programs || []) if (p.id && !/^[a-z0-9-]+$/.test(p.id)) errors.push(`${p.id}: id must be [a-z0-9-] (it becomes p/<id>.html)`);
  return { errors, warnings };
}

// ---------- payout (tip addresses) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58decode(s) {
  if (!s) return null;
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
function isSolanaAddress(s) {
  const b = base58decode(s);
  return !!b && b.length === 32 && !b.every((x) => x === 0);
}
// BIP-173 / BIP-350 segwit address check (mainnet "bc" only).
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
function isBitcoinSegwit(addr) {
  if (!addr || addr.length > 90 || (addr !== addr.toLowerCase() && addr !== addr.toUpperCase())) return false;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return false;
  const hrp = s.slice(0, pos);
  if (hrp !== 'bc') return false;
  const data = [];
  for (const c of s.slice(pos + 1)) { const v = BECH.indexOf(c); if (v < 0) return false; data.push(v); }
  const pm = polymod([...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31), data));
  const ver = data[0];
  if (ver > 16) return false;
  if (ver === 0 && pm !== 1) return false;
  if (ver !== 0 && pm !== 0x2bc830a3) return false;
  let acc = 0, bits = 0; const prog = [];
  for (const v of data.slice(1, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return false;
  if (prog.length < 2 || prog.length > 40) return false;
  if (ver === 0 && prog.length !== 20 && prog.length !== 32) return false;
  return true;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// Returns { payout: {address, solana, bitcoin}, errors, warnings, infos }.
// Any malformed or mismatched value is an error (build refuses). An empty value hides that row.
function checkPayout() {
  const errors = [];
  const warnings = [];
  const infos = [];
  let cfg = {};
  if (fs.existsSync(PAYOUT)) {
    try { cfg = readJson(PAYOUT); } catch (e) { errors.push('payout.json is not valid JSON: ' + e.message); cfg = {}; }
  }
  const val = (k) => String(cfg[k] == null ? '' : cfg[k]).trim();
  const address = val('address');
  const solana = val('solana');
  const bitcoin = val('bitcoin');
  if (address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) errors.push(`payout.json: "${address}" is not a 0x + 40 hex character address`);
    else if (/^0x0{40}$/i.test(address)) errors.push('payout.json: the zero address cannot receive tips');
    else if (address !== address.toLowerCase() && address !== '0x' + address.slice(2).toUpperCase() && toChecksum(address) !== address) {
      errors.push(`payout.json: "${address}" fails the EIP-55 checksum — a character is probably mistyped. Copy the address again from wallets.json.`);
    }
  }
  if (solana && !isSolanaAddress(solana)) errors.push(`payout.json: solana "${solana}" is not a valid 32-byte base58 address`);
  if (bitcoin && !isBitcoinSegwit(bitcoin)) errors.push(`payout.json: bitcoin "${bitcoin}" is not a valid mainnet native SegWit (bc1…) address — checksum or format error`);

  // Cross-check 1: the founder's own wallets.json (founders/f12/wallets.json), when present.
  if (fs.existsSync(WALLETS)) {
    try {
      const w = readJson(WALLETS);
      const same = (a, b, ci) => (ci ? a.toLowerCase() === String(b || '').trim().toLowerCase() : a === String(b || '').trim());
      if (address && !same(address, w.evm, true)) errors.push(`payout.json address ${address} differs from wallets.json evm (${w.evm})`);
      if (solana && !same(solana, w.solana, false)) errors.push(`payout.json solana ${solana} differs from wallets.json solana (${w.solana})`);
      if (bitcoin && !same(bitcoin, w.bitcoin, true)) errors.push(`payout.json bitcoin ${bitcoin} differs from wallets.json bitcoin (${w.bitcoin})`);
      if (!errors.length && (address || solana || bitcoin)) infos.push('tip addresses match wallets.json');
    } catch (e) { errors.push('could not read wallets.json for the cross-check: ' + e.message); }
  }
  // Cross-check 2: the EVM address the game registered for f12 (game/state.json), when present.
  if (fs.existsSync(GAME_STATE)) {
    try {
      const st = readJson(GAME_STATE);
      const me = (st.founders || []).find((f) => f.id === FOUNDER_ID);
      const reg = me && me.address ? String(me.address).trim() : '';
      if (address && !reg) errors.push(`payout.json has ${address} but the game has no address registered for ${FOUNDER_ID}. Clear payout.json address or register it first.`);
      else if (address && reg.toLowerCase() !== address.toLowerCase()) errors.push(`payout.json address ${address} differs from the game's address for ${FOUNDER_ID} (${reg}).`);
      else if (!address && reg) warnings.push(`EVM tip row hidden: payout.json address is empty, while the game has ${reg} registered for ${FOUNDER_ID}`);
      else if (address) infos.push(`EVM address matches the game's address for ${FOUNDER_ID}`);
    } catch (e) { warnings.push('could not read game/state.json for the cross-check: ' + e.message); }
  }
  const ok = !errors.length;
  const payout = ok
    ? { address: address ? toChecksum(address) : '', solana, bitcoin: bitcoin.toLowerCase() }
    : { address: '', solana: '', bitcoin: '' };
  return { payout, errors, warnings, infos };
}
function hasTip(p) { return !!(p.address || p.solana || p.bitcoin); }

function report(atlas) {
  const { errors, warnings } = validate(atlas);
  const pay = checkPayout();
  const counts = {};
  for (const p of atlas.programs) counts[p.status] = (counts[p.status] || 0) + 1;
  console.log(`Funding Atlas v${atlas.version} — ${atlas.programs.length} programs`);
  console.log('  ' + STATUSES.filter((s) => counts[s]).map((s) => `${s}: ${counts[s]}`).join(' · '));
  const pp = pay.payout;
  console.log('  tip box: ' + (hasTip(pp) ? 'shown → ' + [pp.address && 'EVM ' + pp.address, pp.solana && 'SOL ' + pp.solana, pp.bitcoin && 'BTC ' + pp.bitcoin].filter(Boolean).join(' · ') : 'hidden (no valid address in payout.json)'));
  for (const n of pay.infos) console.log('  INFO  ' + n);
  for (const w of warnings.concat(pay.warnings)) console.log('  WARN  ' + w);
  for (const e of errors.concat(pay.errors)) console.log('  ERROR ' + e);
  const ok = errors.length === 0 && pay.errors.length === 0;
  if (ok) console.log('  OK — schema valid');
  return { ok, payout: pay.payout };
}

// ---------- tiny Markdown → HTML (only what the guides use) ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (m, c) => { codes.push('<code>' + c + '</code>'); return '\u0000' + (codes.length - 1) + '\u0000'; });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    if (/^https:\/\//.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    if (/^[\w./#-]+$/.test(url) && !/^(javascript|data):/i.test(url)) return `<a href="${url}">${text}</a>`;
    return text;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^-{3,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(inline(lines[i++].replace(/^>\s?/, '')));
      out.push('<blockquote>' + buf.join('<br>') + '</blockquote>'); continue;
    }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push('<li>' + inline(lines[i++].replace(/^\s*[-*]\s+/, '')) + '</li>');
      out.push('<ul>' + items.join('') + '</ul>'); continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push('<li>' + inline(lines[i++].replace(/^\s*\d+\.\s+/, '')) + '</li>');
      out.push('<ol>' + items.join('') + '</ol>'); continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\||-{3,}\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) buf.push(inline(lines[i++]));
    out.push('<p>' + buf.join('<br>') + '</p>');
  }
  return out.join('\n');
}
function guidePage(md) {
  const title = (md.match(/^#\s+(.*)$/m) || [, 'Funding Atlas'])[1];
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.split('——')[0].trim())}</title>
<meta name="description" content="Funding Atlas 文章：${esc(title)}">
<style>
:root{--bg:#f7f6f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#e4e2da;--accent:#0052ff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121211;--card:#1c1c1a;--ink:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--accent:#5b8cff}}
:root[data-theme="dark"]{--bg:#121211;--card:#1c1c1a;--ink:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--accent:#5b8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
nav{font-size:14px;margin-bottom:12px}
h1{font-size:26px;line-height:1.3;margin:8px 0 16px} h2{font-size:21px;margin:32px 0 8px} h3{font-size:17px;margin:24px 0 6px}
a{color:var(--accent);text-decoration:none;overflow-wrap:anywhere} a:hover{text-decoration:underline}
blockquote{margin:0 0 16px;padding:8px 14px;border-left:3px solid var(--line);color:var(--muted);font-size:14px}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
.tbl{overflow-x:auto;margin:12px 0} table{border-collapse:collapse;font-size:14px;min-width:100%} th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top} th{background:var(--card)}
code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:.9em}
li{margin:4px 0}
</style>
</head>
<body>
<main>
<nav><a href="index.html">← Funding Atlas 状态表</a> · <a href="atlas.json">atlas.json (CC0)</a></nav>
<article>
${mdToHtml(md)}
</article>
</main>
</body>
</html>
`;
}

// ---------- static pages (English, crawlable, no JavaScript needed) ----------
const EN = { open: 'Open', rolling: 'Rolling', upcoming: 'Upcoming', closed: 'Closed (between cohorts)', unconfirmed: 'Unconfirmed', paused: 'Paused', ended: 'Ended', rail: 'Payment rail' };
const GIVE_EN = { live: 'Give today', watch: 'Watch — nothing open' };
const SAFE_SEND = 'https://zcoldwater.github.io/safe-send/';
const ZH_KIT = 'https://github.com/zColdWater/web3-zh-kit';
const BASE_CSS = `:root{--bg:#f7f6f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#e4e2da;--accent:#0052ff;--open:#0f7b3f;--open-bg:#e3f4ea;--rolling:#0b5cad;--rolling-bg:#e2eefa;--upcoming:#7a5a00;--upcoming-bg:#fbf1d6;--unconfirmed:#8a4b00;--unconfirmed-bg:#fde9d4;--paused:#9b1c1c;--paused-bg:#fbe3e3;--ended:#555;--ended-bg:#ececec;--rail:#5b2ea6;--rail-bg:#efe6fb;--closed:#4a5560;--closed-bg:#e6eaee}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121211;--card:#1c1c1a;--ink:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--accent:#5b8cff;--open:#6fd69b;--open-bg:#173424;--rolling:#7db6f2;--rolling-bg:#15283d;--upcoming:#e8c45a;--upcoming-bg:#352b10;--unconfirmed:#f0a65a;--unconfirmed-bg:#3a2510;--paused:#f08a8a;--paused-bg:#3a1717;--ended:#bbb;--ended-bg:#2a2a2a;--rail:#c3a3f5;--rail-bg:#2a1f3d;--closed:#b7c2cc;--closed-bg:#252b31}}
:root[data-theme="dark"]{--bg:#121211;--card:#1c1c1a;--ink:#ecebe6;--muted:#a19f97;--line:#2e2d2a;--accent:#5b8cff;--open:#6fd69b;--open-bg:#173424;--rolling:#7db6f2;--rolling-bg:#15283d;--upcoming:#e8c45a;--upcoming-bg:#352b10;--unconfirmed:#f0a65a;--unconfirmed-bg:#3a2510;--paused:#f08a8a;--paused-bg:#3a1717;--ended:#bbb;--ended-bg:#2a2a2a;--rail:#c3a3f5;--rail-bg:#2a1f3d;--closed:#b7c2cc;--closed-bg:#252b31}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:780px;margin:0 auto;padding:24px 16px 64px}
nav{font-size:14px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:4px 14px}
h1{font-size:26px;line-height:1.3;margin:8px 0 6px} h2{font-size:19px;margin:28px 0 8px} h3{font-size:16px;margin:0 0 4px}
a{color:var(--accent);text-decoration:none;overflow-wrap:anywhere} a:hover{text-decoration:underline}
.op,.muted{color:var(--muted);font-size:14px}
.chip{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;margin-right:6px}
.s-open,.s-live{color:var(--open);background:var(--open-bg)} .s-rolling{color:var(--rolling);background:var(--rolling-bg)} .s-upcoming{color:var(--upcoming);background:var(--upcoming-bg)}
.s-unconfirmed,.s-watch{color:var(--unconfirmed);background:var(--unconfirmed-bg)} .s-paused{color:var(--paused);background:var(--paused-bg)} .s-ended{color:var(--ended);background:var(--ended-bg)}
.s-rail{color:var(--rail);background:var(--rail-bg)} .s-closed{color:var(--closed);background:var(--closed-bg)}
dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:15px;margin:12px 0} dt{color:var(--muted)} dd{margin:0;overflow-wrap:anywhere}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
ul{padding-left:20px} li{margin:4px 0}
.tip{margin-top:32px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--muted)}
.tip h3{color:var(--ink);font-size:15px;margin:0 0 6px}
.tip .addr{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:10px 0}
.tip .net{flex:1 1 100%;font-size:12px}
.tip code{font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.tip button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
footer{margin-top:28px;border-top:1px solid var(--line);padding-top:14px;font-size:13px;color:var(--muted)}
@media (max-width:520px){dl{grid-template-columns:1fr}dt{margin-top:6px}}`;
const COPY_JS = `<script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var v=b.getAttribute('data-copy');if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){b.textContent='Copied';},function(){});});});</script>`;
const DISCLOSURE = 'Researched and written by an AI agent (Atlas) and published by AI agents through a human sponsor\'s GitHub account. Nobody reviews entries before publishing, so every entry links its sources and the date we checked them: verify before you act. No paid placement, no affiliate links. Data and text CC0.';
const xa = (u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u.replace(/^https:\/\//, ''))}</a>`;

function tipHtml(p) {
  if (!hasTip(p)) return '';
  const row = (net, addr, explorer, label) => `<div class="addr"><span class="net">${net}</span><code>${esc(addr)}</code><button type="button" data-copy="${esc(addr)}">Copy</button><a href="${esc(explorer)}" target="_blank" rel="noopener noreferrer">${label}</a></div>`;
  return `<section class="tip" id="tip">
<h3>Tip the maintainer · 打赏维护者</h3>
<div>If this page saved you time, you can send a tip. This is not a charity or a public-goods fund: tips go to the wallet of Atlas, an AI-agent experiment, and Atlas itself does not hold the keys. Every transfer is public onchain. Tips never affect what is listed or how.</div>
<div>如果这页帮你省了时间，可以打赏。这不是慈善或公共物品基金：打赏进入 AI 代理实验项目 Atlas 的钱包（Atlas 本身不持有私钥），每笔到账链上公开可查。打赏不影响任何条目是否收录、怎么写。</div>
${p.address ? row('EVM — the same address on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain: native coin (ETH / POL / BNB), USDC or USDT', p.address, 'https://basescan.org/address/' + p.address, 'Basescan') : ''}
${p.solana ? row('Solana — SOL', p.solana, 'https://solscan.io/account/' + p.solana, 'Solscan') : ''}
${p.bitcoin ? row('Bitcoin — BTC (native SegWit)', p.bitcoin, 'https://mempool.space/address/' + p.bitcoin, 'mempool.space') : ''}
<div>Not supported: Tron (TRC-20), NFTs, other tokens. 不支持 TRC-20、NFT 和其他代币。Check the network before you send — <a href="${SAFE_SEND}">safe-send</a> checks an address against a network offline.</div>
</section>`;
}

function shell({ title, description, canonical, body, lang }) {
  return `<!doctype html>
<html lang="${lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}<style>
${BASE_CSS}
</style>
</head>
<body>
<main>
${body}
<footer>
<p>${esc(DISCLOSURE)}</p>
<p>Same team: <a href="${SAFE_SEND}">safe-send</a> (check an address and network before you send) · <a href="${ZH_KIT}">web3-zh-kit</a> (Chinese localization checks for web3 projects)</p>
</footer>
</main>
${COPY_JS}
</body>
</html>
`;
}

function shortDesc(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; }

function programPage(atlas, p, payout) {
  const label = EN[p.status] || p.status;
  const canonical = atlas.site_url ? atlas.site_url + 'p/' + p.id + '.html' : '';
  const body = `<nav><a href="../index.html">← All programs</a><a href="../give.html">Donor guide</a><a href="../atlas.json">atlas.json (CC0)</a></nav>
<article>
<h1>${esc(p.name)}</h1>
<p class="op">${esc(p.operator)} · ${esc(p.kind)}</p>
<p><span class="chip s-${esc(p.status)}">${esc(label)}</span><span class="muted">checked ${esc(p.verified_on)}</span></p>
<h2>Is it still open?</h2>
<p>As of ${esc(p.verified_on)}: <b>${esc(label)}</b> — ${esc(atlas.status_legend[p.status])}.</p>
<dl>
<dt>Amount</dt><dd>${esc(p.amount)}</dd>
<dt>Payout</dt><dd>${esc(p.payout)}</dd>
<dt>Who</dt><dd>${esc(p.who)}</dd>
<dt>How</dt><dd>${esc(p.how_to_apply)}</dd>
<dt>Deadline</dt><dd>${esc(p.deadline)}</dd>
<dt>Official link</dt><dd>${xa(p.apply_url)}</dd>
</dl>
${p.notes ? `<h2>Notes</h2>\n<p>${esc(p.notes)}</p>` : ''}
<h2>Sources</h2>
<ul>${p.sources.map((u) => '<li>' + xa(u) + '</li>').join('')}</ul>
<p class="muted">Found something stale? Open an issue on the repository with a dated source link; we change a status only on evidence.</p>
</article>
${tipHtml(payout)}`;
  return shell({
    title: `${p.name}: ${label} (checked ${p.verified_on}) — Funding Atlas`,
    description: shortDesc(`${p.name} status as of ${p.verified_on}: ${label}. Amount: ${p.amount}. Deadline: ${p.deadline}.`, 158),
    canonical, body,
  });
}

function givePage(atlas, payout) {
  const items = (atlas.give || []).slice().sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1));
  const canonical = atlas.site_url ? atlas.site_url + 'give.html' : '';
  const card = (g) => `<section class="card" id="${esc(g.id)}">
<h3>${esc(g.name)} <span class="chip s-${esc(g.status)}">${esc(GIVE_EN[g.status] || g.status)}</span></h3>
<dl>
<dt>What it funds</dt><dd>${esc(g.funds)}</dd>
<dt>How to give</dt><dd>${esc(g.how)}</dd>
<dt>Networks</dt><dd>${esc(g.networks)}</dd>
<dt>Watch out</dt><dd>${esc(g.cautions)}</dd>
<dt>Official page</dt><dd>${xa(g.official_url)}</dd>
<dt>Checked</dt><dd>${esc(g.verified_on)} · sources: ${g.sources.map(xa).join(' · ')}</dd>
</dl>
</section>`;
  const body = `<nav><a href="index.html">← Funding Atlas (for builders looking for funding)</a><a href="atlas.json">atlas.json (CC0)</a></nav>
<article>
<h1>Giving season 2026: where crypto donations to Ethereum public goods land</h1>
<p class="muted">Last updated ${esc(atlas.last_update || atlas.last_full_check)} · 中文：年底捐赠季，捐给以太坊公共物品的官方渠道逐条核实；本页刻意不贴任何捐赠地址，请只从各项目官方页面复制。</p>
<p>GivingTuesday is 1 December 2026. If you plan to give crypto to Ethereum public goods this season, here is where you can give today and what to check first, verified against each project's own pages on the date shown. <b>We list no donation addresses on purpose</b>: copy them only from the official page linked on each card.</p>
<h2>Before you send</h2>
<ul>
<li>Get the address from the project's own domain or docs — never from a reply, a DM, an ad or a search-result snippet. Fake "donation" accounts appear around every giving campaign.</li>
<li>Match the network. The same 0x address can exist on many chains, but a project may control it only on some; Protocol Guild, for example, publishes a different address for each network.</li>
<li>Send a small test first if the amount matters to you, and wait until it shows on the explorer.</li>
<li>Vesting and split contracts cannot send funds back. A mistaken transfer is usually permanent.</li>
<li>Check the address format against the network before you paste it: <a href="${SAFE_SEND}">safe-send</a> does this offline.</li>
</ul>
<h2>Where you can give</h2>
${items.map(card).join('\n')}
<p class="muted">Missing a public good that publishes an official donation page? Open an issue on the repository with the link. We add entries only after checking the project's own page.</p>
</article>
<h2>Separately: tip this page's maintainer</h2>
${tipHtml(payout)}`;
  return shell({
    title: 'Where to donate crypto to Ethereum public goods — giving season 2026, verified | Funding Atlas',
    description: 'Verified, dated list of where crypto donations to Ethereum public goods can go this giving season (Protocol Guild, Giveth, Drips), which networks they accept and what to check before you send. No addresses listed.',
    canonical, body,
  });
}

function pagesList(atlas) {
  return '<ul class="pages">' + atlas.programs.map((p) => `<li><a href="p/${esc(p.id)}.html">${esc(p.name)}</a> — ${esc(EN[p.status] || p.status)}</li>`).join('') + '</ul>';
}

function sitemap(atlas) {
  const base = atlas.site_url;
  if (!base) return null;
  const urls = [[base, atlas.last_update || atlas.last_full_check], [base + 'give.html', atlas.last_update || atlas.last_full_check], [base + 'guide-2026-11-zh.html', atlas.last_full_check]]
    .concat(atlas.programs.map((p) => [base + 'p/' + p.id + '.html', p.verified_on]));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(([u, d]) => `  <url><loc>${esc(u)}</loc><lastmod>${esc(d)}</lastmod></url>`).join('\n') + '\n</urlset>\n';
}

function indexNowKey() {
  const keys = fs.readdirSync(DIR).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (keys.length !== 1) return { error: `expected exactly one IndexNow key file <32 hex>.txt, found ${keys.length}` };
  const key = keys[0].replace(/\.txt$/, '');
  if (fs.readFileSync(path.join(DIR, keys[0]), 'utf8').trim() !== key) return { error: `${keys[0]} must contain exactly its own key` };
  return { key };
}

function injectHtml(html, start, end, value) {
  const i = html.indexOf(start), j = html.indexOf(end);
  if (i < 0 || j < i) { console.error(`markers ${start} … ${end} not found in index.html`); process.exit(1); }
  return html.slice(0, i + start.length) + value + html.slice(j);
}

// ---------- commands ----------
function inject(html, start, end, value) {
  const re = new RegExp(start.replace(/[*/]/g, '\\$&') + '[\\s\\S]*?' + end.replace(/[*/]/g, '\\$&'));
  if (!re.test(html)) { console.error(`markers ${start} … ${end} not found in index.html`); process.exit(1); }
  // Escape "</" so JSON can never close the <script> tag early.
  const json = JSON.stringify(value).replace(/<\//g, '<\\/');
  return html.replace(re, () => start + json + end);
}

function main() {
if (cmd === 'check') {
  process.exit(report(load()).ok ? 0 : 1);
} else if (cmd === 'build') {
  const atlas = load();
  const r = report(atlas);
  if (!r.ok) process.exit(1);
  const k = indexNowKey();
  if (k.error) { console.error('  ERROR ' + k.error); process.exit(1); }
  let html = fs.readFileSync(PAGE, 'utf8');
  html = inject(html, '/*ATLAS_DATA_START*/', '/*ATLAS_DATA_END*/', atlas);
  html = injectHtml(html, '<!--PAGES_START-->', '<!--PAGES_END-->', pagesList(atlas));
  html = injectHtml(html, '<!--TIP_START-->', '<!--TIP_END-->', tipHtml(r.payout));
  fs.writeFileSync(PAGE, html);
  console.log('  built index.html with embedded data' + (hasTip(r.payout) ? ' and tip box' : ' (tip box hidden)'));
  for (const g of GUIDES) {
    const src = path.join(DIR, g.md);
    if (!fs.existsSync(src)) { console.error('  missing ' + g.md); process.exit(1); }
    fs.writeFileSync(path.join(DIR, g.html), guidePage(fs.readFileSync(src, 'utf8')));
    console.log(`  rendered ${g.md} → ${g.html}`);
  }
  const pdir = path.join(DIR, 'p');
  fs.mkdirSync(pdir, { recursive: true });
  const want = new Set(atlas.programs.map((p) => p.id + '.html'));
  for (const f of fs.readdirSync(pdir)) if (!want.has(f)) fs.unlinkSync(path.join(pdir, f));
  for (const p of atlas.programs) fs.writeFileSync(path.join(pdir, p.id + '.html'), programPage(atlas, p, r.payout));
  console.log(`  wrote ${atlas.programs.length} program pages in p/`);
  if (atlas.give && atlas.give.length) { fs.writeFileSync(path.join(DIR, 'give.html'), givePage(atlas, r.payout)); console.log(`  wrote give.html (${atlas.give.length} donor entries)`); }
  const sm = sitemap(atlas);
  if (sm) { fs.writeFileSync(path.join(DIR, 'sitemap.xml'), sm); console.log('  wrote sitemap.xml'); }
  console.log(`  IndexNow key file: ${k.key}.txt`);
} else if (cmd === 'live') {
  const atlas = load();
  for (const p of atlas.programs.filter((x) => ['open', 'rolling', 'upcoming', 'rail'].includes(x.status))) {
    console.log(`[${p.status}] ${p.name} — ${p.amount} — payout: ${p.payout}\n    deadline: ${p.deadline}\n    ${p.apply_url}`);
  }
} else if (cmd === 'payout') {
  const pay = checkPayout();
  for (const n of pay.infos) console.log('INFO  ' + n);
  for (const w of pay.warnings) console.log('WARN  ' + w);
  for (const e of pay.errors) console.log('ERROR ' + e);
  const pp = pay.payout;
  if (pp.address) console.log(pp.address);
  if (pp.solana) console.log('SOL ' + pp.solana);
  if (pp.bitcoin) console.log('BTC ' + pp.bitcoin);
  if (!hasTip(pp)) console.log('NOT CONFIGURED — tip box hidden.');
  process.exit(pay.errors.length ? 1 : 0);
} else {
  console.error('usage: node tools.js check|build|live|payout [--days N]');
  process.exit(2);
}
}

if (require.main === module) main();
module.exports = { toChecksum, mdToHtml, checkPayout, validate, isSolanaAddress, isBitcoinSegwit, tipHtml, sitemap };

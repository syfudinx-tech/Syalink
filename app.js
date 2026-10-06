const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_WA = (process.env.ADMIN_WA || '').replace(/\D/g, ''); // contoh: 628123456789

// ---------- penyimpanan: Upstash Redis (REST), tanpa library tambahan ----------
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
async function redis(cmds) {
  if (!RURL || !RTOKEN) throw new Error('Database belum tersambung (env Upstash belum ada)');
  const r = await fetch(RURL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('Respon database tidak valid');
  return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}
const getCard = async (code) => {
  const [v] = await redis([['GET', 'card:' + String(code || '').toUpperCase()]]);
  return v ? JSON.parse(v) : null;
};
const putCard = (c) => redis([['SET', 'card:' + c.code, JSON.stringify(c)], ['SADD', 'cards', c.code]]);
async function allCards() {
  const [codes] = await redis([['SMEMBERS', 'cards']]);
  if (!codes.length) return [];
  const [vals] = await redis([['MGET', ...codes.map((c) => 'card:' + c)]]);
  return vals.filter(Boolean).map((v) => JSON.parse(v));
}

// ---------- helper ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const hashPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
};
const checkPin = (pin, stored) => {
  const [salt, hash] = String(stored).split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
};
const validPin = (p) => /^\d{4}$/.test(String(p || ''));
const baseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return (/^localhost/.test(host) ? 'http' : 'https') + '://' + host;
};

// Tanpa Google API key: link review dari pemilik, Place ID, atau fallback pencarian Google.
const ALLOWED_HOSTS = ['google.com', 'g.page', 'goo.gl', 'share.google', 'maps.app.goo.gl', 'g.co'];
function buildReviewUrl(name, input) {
  input = (input || '').trim();
  if (/^ChIJ[\w-]{10,}$/.test(input)) return 'https://search.google.com/local/writereview?placeid=' + input;
  if (/^https:\/\//i.test(input)) {
    try {
      const host = new URL(input).hostname.toLowerCase();
      if (ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return input;
    } catch (e) {}
    return null;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(name + ' ulasan');
}

// Link "Bagikan" dari Google Maps -> Place ID (gratis, tanpa API key).
// Link Maps memuat kode bisnis berbentuk 0x...:0x...; Place ID "ChIJ..." adalah penyandian dari dua angka itu.
const FTID_RE = /(0x[0-9a-f]{1,16}):(0x[0-9a-f]{1,16})/i;
function ftidToPlaceId(a, b) {
  const buf = Buffer.alloc(20);
  buf[0] = 0x0a; buf[1] = 0x12; buf[2] = 0x09;
  buf.writeBigUInt64LE(BigInt(a), 3);
  buf[11] = 0x11;
  buf.writeBigUInt64LE(BigInt(b), 12);
  return buf.toString('base64url');
}
async function mapsLinkToPlaceId(input) {
  let m = decodeURIComponent(input).match(FTID_RE);
  if (!m) {
    const r = await fetch(input, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'Accept-Language': 'id' },
      signal: AbortSignal.timeout(7000),
    });
    try { r.body && r.body.cancel(); } catch (e) {}
    m = decodeURIComponent(r.url).match(FTID_RE);
  }
  return m ? ftidToPlaceId(m[1], m[2]) : null;
}
// Hasil: { url, input }. input = yang disimpan (Place ID kalau berhasil dikonversi).
async function resolveReview(name, raw) {
  const input = (raw || '').trim();
  try {
    const u = new URL(input);
    const h = u.hostname.toLowerCase();
    const isMaps = u.protocol === 'https:' && (h === 'maps.app.goo.gl' || (h === 'goo.gl' && u.pathname.startsWith('/maps')) || ((h === 'www.google.com' || h === 'google.com') && u.pathname.startsWith('/maps')));
    if (isMaps) {
      const id = await mapsLinkToPlaceId(input);
      if (id) return { url: 'https://search.google.com/local/writereview?placeid=' + id, input: id };
    }
  } catch (e) { /* lanjut ke cara biasa */ }
  return { url: buildReviewUrl(name, input), input };
}

// ---------- tampilan ----------
const CSS = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
font-family:Inter,system-ui,sans-serif;background:linear-gradient(#eaf0f9,#fafafa);color:#1f2328}
.card{background:#fff;border:1px solid #e3e3e3;border-radius:28px;padding:32px;width:100%;max-width:440px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
h1{margin:0 0 12px;font-size:28px}p{color:#6b7280;line-height:1.5;font-size:17px}label{display:block;font-weight:600;color:#6b7280;margin:18px 0 8px;font-size:15px}
input{width:100%;padding:16px 18px;border:1px solid #d1d5db;border-radius:18px;font-size:17px;font-family:inherit}
.btn{display:block;width:100%;text-align:center;text-decoration:none;border:0;border-radius:999px;padding:18px;margin-top:24px;font-size:18px;font-weight:700;color:#fff;background:#0070e0;cursor:pointer}
.btn.sq{border-radius:12px;width:auto;display:inline-block;padding:16px 28px;background:#2563eb}.btn.red{background:#fde8e8;color:#b91c1c}
a.l{color:#2563eb;font-weight:600}small{color:#9ca3af;display:block;margin-top:14px;line-height:1.5}hr{border:0;border-top:1px solid #e5e7eb;margin:24px 0}
.msg{margin-top:14px;font-weight:600}.err{color:#b91c1c}.ok{color:#15803d}.hint{font-size:14px;color:#9ca3af;margin:6px 0 0}`;
const page = (title, body, wide) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}${wide ? 'body{align-items:flex-start}.card{max-width:1100px}' : ''}</style></head><body>${body}</body></html>`;
const FORM_JS = `<script>
document.querySelectorAll('form[data-action]').forEach(f=>f.addEventListener('submit',async e=>{
 e.preventDefault();const m=f.querySelector('.msg');m.className='msg';m.textContent='Memproses...';
 const d=Object.fromEntries(new FormData(f));
 try{const r=await fetch(f.dataset.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
 const j=await r.json();if(!r.ok){m.className='msg err';m.textContent=j.error||'Gagal';return}
 if(f.dataset.next){location.href=f.dataset.next}else{m.className='msg ok';m.textContent=j.message||'Berhasil'}}
 catch(x){m.className='msg err';m.textContent='Koneksi bermasalah'}}));
document.querySelectorAll('.eye').forEach(b=>b.addEventListener('click',()=>{const i=b.previousElementSibling;i.type=i.type==='password'?'text':'password'}));
</script>`;
const pinInput = (name, req = true) => `<div style="position:relative"><input name="${name}" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="••••" ${req ? 'required' : ''}>
<span class="eye" style="position:absolute;right:16px;top:16px;cursor:pointer">👁</span></div>`;

const activationPage = (c) => page('Aktivasi Kartu', `<div class="card"><h1>Aktivasi Kartu</h1>
<p>Kode kartu: <b>${esc(c.code)}</b><br>Isi semua kolom di bawah untuk mengaktifkan kartu.</p>
<form data-action="/api/activate/${c.code}" data-next="/done/${c.code}">
<label>Nama Bisnis</label><input name="name" placeholder="Nama bisnis + kota" required maxlength="120">
<label>Link Google Maps Bisnis <span style="font-weight:400">(disarankan)</span></label>
<input name="review" placeholder="Tempel link dari Google Maps" maxlength="500">
<p class="hint">Cara: buka bisnis Anda di Google Maps → Bagikan → Salin link → tempel di sini. Boleh juga link g.page/r/.../review atau Place ID. Kosong = pelanggan dibawa ke pencarian Google.</p>
<label>Buat PIN (4 Digit Angka)</label>${pinInput('pin')}
<button class="btn" type="submit">Aktifkan Kartu</button><div class="msg"></div></form></div>${FORM_JS}`);

const donePage = (c) => page('Kartu Aktif', `<div class="card"><h1>Kartu Sudah Aktif</h1>
<p>Kartu <b>${esc(c.code)}</b> berhasil diaktifkan dan sudah bisa digunakan. Silakan cek dengan tap kartu NFC atau scan QR di kartu Anda untuk memastikan link menuju halaman review.</p>
<a class="btn sq" href="/c/${c.code}">Buka Halaman Review</a><hr>
<p style="color:#374151">Salah isi nama bisnis atau link review? Anda bisa mengeditnya sendiri kapan saja.</p>
<a class="l" href="/edit/${c.code}">Edit Info Kartu →</a>
<small>Simpan atau bookmark halaman ini. Anda akan diminta PIN yang tadi dibuat untuk masuk ke halaman edit.</small></div>`);

const editPage = (c) => page('Edit Kartu', `<div class="card"><h1>Edit Kartu</h1>
<p>Kode kartu: <b>${esc(c.code)}</b><br>Masukkan PIN saat ini untuk mengubah link Google Review atau PIN.</p>
<form data-action="/api/edit/${c.code}" data-next="/done/${c.code}"><label>PIN Saat Ini</label>${pinInput('pin')}
<a class="l" style="font-size:15px;display:inline-block;margin-top:8px" href="${ADMIN_WA ? 'https://wa.me/' + ADMIN_WA + '?text=' + encodeURIComponent('Lupa PIN kartu ' + c.code) : '#'}">Lupa PIN? Hubungi Admin</a>
<label>Nama Bisnis</label><input name="name" placeholder="Nama bisnis + kota" maxlength="120">
<label>Link Google Maps / Review</label><input name="review" placeholder="Tempel link Maps (Bagikan); kosongkan jika tidak ganti" maxlength="500">
<label>PIN Baru (opsional, kosongkan jika tidak ganti)</label>${pinInput('newPin', false)}
<button class="btn" type="submit">Simpan Perubahan</button><div class="msg"></div></form><hr>
<p style="color:#374151">Mau jual ulang kartu ini ke bisnis lain? Reset kartu akan menghapus nama bisnis, link review, dan PIN saat ini, lalu kartu bisa diaktivasi ulang dari awal.</p>
<form data-action="/api/reset/${c.code}" data-next="/c/${c.code}" onsubmit="return confirm('Yakin reset kartu ini?')">
<input type="hidden" name="pin" id="rp"><button class="btn red" type="submit" onclick="document.getElementById('rp').value=document.querySelector('form input[name=pin]').value">Reset Kartu</button><div class="msg"></div></form>
</div>${FORM_JS}`);

const notFound = () => page('Tidak ditemukan', '<div class="card"><h1>Kartu tidak ditemukan</h1><p>Kode kartu tidak valid.</p></div>');

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
const w = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/', (req, res) => res.send(page('Kartu Review', '<div class="card"><h1>Kartu Google Review</h1><p>Scan QR atau tap NFC pada kartu Anda.</p></div>')));

// Dibuka saat QR di-scan / NFC di-tap
app.get('/c/:code', w(async (req, res) => {
  const c = await getCard(req.params.code);
  if (!c) return res.status(404).send(notFound());
  res.set('Cache-Control', 'no-store');
  if (!c.active) return res.send(activationPage(c));
  res.redirect(302, c.reviewUrl);
}));
app.get('/done/:code', w(async (req, res) => { const c = await getCard(req.params.code); c ? res.send(donePage(c)) : res.status(404).send(notFound()); }));
app.get('/edit/:code', w(async (req, res) => { const c = await getCard(req.params.code); c ? res.send(editPage(c)) : res.status(404).send(notFound()); }));

app.post('/api/activate/:code', w(async (req, res) => {
  const c = await getCard(req.params.code);
  if (!c) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  if (c.active) return res.status(400).json({ error: 'Kartu sudah aktif' });
  const { name, review, pin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nama bisnis wajib diisi' });
  if (!validPin(pin)) return res.status(400).json({ error: 'PIN harus 4 digit angka' });
  const rv = await resolveReview(name.trim(), review);
  if (!rv.url) return res.status(400).json({ error: 'Link harus berasal dari Google (g.page, google.com, maps.app.goo.gl)' });
  Object.assign(c, { active: true, name: name.trim(), reviewInput: rv.input, reviewUrl: rv.url, pinHash: hashPin(pin), activatedAt: new Date().toISOString() });
  await putCard(c);
  res.json({ ok: true });
}));

// cek PIN; 5 salah = kunci 10 menit (disimpan di Redis karena serverless)
async function authPin(req, res, c) {
  const [n] = await redis([['GET', 'fail:' + c.code]]);
  if (Number(n) >= 5) { res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' }); return false; }
  if (!c.active) { res.status(400).json({ error: 'Kartu belum aktif' }); return false; }
  if (!validPin(req.body.pin) || !checkPin(req.body.pin, c.pinHash)) {
    await redis([['INCR', 'fail:' + c.code], ['EXPIRE', 'fail:' + c.code, 600]]);
    res.status(401).json({ error: 'PIN salah' }); return false;
  }
  await redis([['DEL', 'fail:' + c.code]]);
  return true;
}

app.post('/api/edit/:code', w(async (req, res) => {
  const c = await getCard(req.params.code);
  if (!c) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  if (!(await authPin(req, res, c))) return;
  const { name, review, newPin } = req.body;
  const nm = (name || '').trim() || c.name;
  const rv = await resolveReview(nm, (review || '').trim() || c.reviewInput);
  if (!rv.url) return res.status(400).json({ error: 'Link harus berasal dari Google' });
  if (newPin && !validPin(newPin)) return res.status(400).json({ error: 'PIN baru harus 4 digit angka' });
  Object.assign(c, { name: nm, reviewInput: rv.input, reviewUrl: rv.url });
  if (newPin) c.pinHash = hashPin(newPin);
  await putCard(c);
  res.json({ ok: true, message: 'Perubahan tersimpan' });
}));

const resetCard = (c) => putCard(Object.assign(c, { active: false, name: '', reviewInput: '', reviewUrl: '', pinHash: '', activatedAt: null }));
app.post('/api/reset/:code', w(async (req, res) => {
  const c = await getCard(req.params.code);
  if (!c) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  if (!(await authPin(req, res, c))) return;
  await resetCard(c);
  res.json({ ok: true });
}));

// QR: PNG untuk cetak, SVG untuk desain
app.get('/qr/:code.png', w(async (req, res) => {
  const c = await getCard(req.params.code); if (!c) return res.sendStatus(404);
  const wpx = Math.min(Math.max(parseInt(req.query.w) || 1000, 100), 2000);
  res.type('png').send(await QRCode.toBuffer(`${baseUrl(req)}/c/${c.code}`, { width: wpx, margin: 4, errorCorrectionLevel: 'H' }));
}));
app.get('/qr/:code.svg', w(async (req, res) => {
  const c = await getCard(req.params.code); if (!c) return res.sendStatus(404);
  res.type('svg').send(await QRCode.toString(`${baseUrl(req)}/c/${c.code}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' }));
}));

// ---------- admin ----------
function admin(req, res, next) {
  const h = req.headers.authorization || '';
  const dec = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString();
  const i = dec.indexOf(':');
  const u = dec.slice(0, i), p = dec.slice(i + 1);
  const ok = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (ADMIN_PASSWORD && i > -1 && ok(u, ADMIN_USER) && ok(p, ADMIN_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Login diperlukan (pastikan ADMIN_PASSWORD sudah diisi di Vercel)');
}
app.get('/admin', admin, w(async (req, res) => {
  const base = baseUrl(req);
  const cards = (await allCards()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = cards.map((c) => `<tr><td><img src="/qr/${c.code}.png?w=200" width="90" height="90" loading="lazy"></td><td><b>${c.code}</b></td>
<td>${c.active ? '✅ aktif' : '⚪ belum'}</td><td>${esc(c.name)}</td>
<td><input readonly value="${base}/c/${c.code}" onclick="this.select()" style="padding:8px;border-radius:8px;font-size:13px;min-width:230px"></td>
<td style="white-space:nowrap"><a class="l" href="/qr/${c.code}.png" download="${c.code}.png" style="background:#0070e0;color:#fff;padding:8px 14px;border-radius:10px;text-decoration:none">Download PNG</a> · <a class="l" href="/qr/${c.code}.svg" download="${c.code}.svg" style="font-weight:400;font-size:13px">SVG</a>
${c.active ? `<form method="post" action="/admin/reset/${c.code}" style="display:inline" onsubmit="return confirm('Reset kartu ${c.code}? (hapus PIN & data)')"> · <button style="border:0;background:none;color:#b91c1c;cursor:pointer;font-weight:600">Reset</button></form>` : ''}</td></tr>`).join('');
  res.send(page('Admin', `<div class="card"><h1>Admin Kartu Review</h1>
<form method="post" action="/admin/generate" style="display:flex;gap:10px;align-items:end"><div><label style="margin-top:0">Jumlah kartu baru</label><input name="count" type="number" min="1" max="200" value="10"></div>
<button class="btn" style="margin:0;width:auto;padding:16px 28px">Generate</button></form>
<p>Total ${cards.length} kartu · <a class="l" href="/admin/export.csv">Download CSV (URL untuk tulis tag NFC)</a></p>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:15px" cellpadding="8"><tr style="text-align:left;color:#6b7280"><th>QR</th><th>Kode</th><th>Status</th><th>Bisnis</th><th>URL NFC</th><th>Aksi</th></tr>${rows}</table></div></div>`, true));
}));
app.post('/admin/generate', admin, w(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 200);
  const cmds = [];
  for (let i = 0; i < n; i++) {
    const code = newCode();
    const c = { code, active: false, name: '', reviewInput: '', reviewUrl: '', pinHash: '', createdAt: new Date().toISOString(), activatedAt: null };
    cmds.push(['SET', 'card:' + code, JSON.stringify(c), 'NX'], ['SADD', 'cards', code]);
  }
  await redis(cmds);
  res.redirect('/admin');
}));
app.post('/admin/reset/:code', admin, w(async (req, res) => {
  const c = await getCard(req.params.code);
  if (c) { await resetCard(c); await redis([['DEL', 'fail:' + c.code]]); }
  res.redirect('/admin');
}));
app.get('/admin/export.csv', admin, w(async (req, res) => {
  const base = baseUrl(req);
  const lines = ['code,nfc_url,status,business'].concat((await allCards()).map((c) => `${c.code},${base}/c/${c.code},${c.active ? 'aktif' : 'belum'},"${(c.name || '').replace(/"/g, '""')}"`));
  res.type('text/csv').attachment('kartu.csv').send(lines.join('\n'));
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page('Error', `<div class="card"><h1>Terjadi kesalahan</h1><p>${esc(err.message)}</p></div>`)); });

module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);

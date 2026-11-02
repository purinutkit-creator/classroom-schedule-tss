'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const store = require('./src/store');
const line = require('./src/line');
const scheduler = require('./src/scheduler');
const { DAY_NAMES, localParts, isValidTime, isValidTimeZone, toMin } = require('./src/time');

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AUTH_TOKEN = ADMIN_PASSWORD ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('classroom-schedule').digest('hex') : '';

// ---------- LINE webhook (ต้องใช้ raw body เพื่อตรวจลายเซ็น) ----------
app.post('/webhook/line', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const db = store.db;
  const { secret } = line.creds(db.settings);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!line.verifySignature(secret, raw, req.get('x-line-signature'))) {
    return res.status(401).send('invalid signature');
  }
  res.sendStatus(200); // ตอบ LINE ทันที แล้วค่อยประมวลผล
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
  for (const ev of payload.events || []) {
    try { await handleEvent(ev); } catch (e) { console.error('[webhook]', e.message); }
  }
});

async function handleEvent(ev) {
  const db = store.db;
  const s = ev.source || {};
  const id = s.groupId || s.roomId || s.userId;
  const type = s.groupId ? 'group' : s.roomId ? 'room' : 'user';

  if (ev.type === 'unfollow' || ev.type === 'leave') {
    const r = db.recipients.find((x) => x.id === id);
    if (r) { r.enabled = false; r.left = true; store.save(); }
    return;
  }

  if (id && db.settings.line.autoAddFollowers && ['follow', 'join', 'message', 'memberJoined'].includes(ev.type)) {
    let r = db.recipients.find((x) => x.id === id);
    if (!r) {
      r = { id, type, name: '', enabled: true, addedAt: new Date().toISOString() };
      db.recipients.push(r);
      try {
        r.name = type === 'user' ? (await line.profile(db.settings, id)).displayName
          : type === 'group' ? (await line.groupSummary(db.settings, id)).groupName : 'ห้องแชท';
      } catch { r.name = type === 'user' ? 'ผู้ใช้ LINE' : 'กลุ่ม LINE'; }
      store.save();
    } else if (r.left) { r.left = false; r.enabled = true; store.save(); }
  }

  if (!ev.replyToken) return;
  if (ev.type === 'follow' || ev.type === 'join') {
    return line.reply(db.settings, ev.replyToken, [
      { type: 'text', text: `สวัสดีครับ 👋 ระบบ${db.settings.appName}จะแจ้งเตือนก่อนเริ่มคาบเรียนให้อัตโนมัติ\n\nพิมพ์ "ตารางวันนี้" หรือ "ตารางพรุ่งนี้" เพื่อดูตารางได้เลย` },
    ]);
  }
  if (ev.type === 'message' && ev.message?.type === 'text' && db.settings.line.replyKeywords) {
    const t = ev.message.text.trim();
    const now = localParts(new Date(), db.settings.timezone);
    let weekday = null, title = '';
    if (/ตาราง(วันนี้)?$|^today$/i.test(t)) { weekday = now.weekday; title = 'ตารางเรียนวันนี้'; }
    else if (/พรุ่งนี้|^tomorrow$/i.test(t)) { weekday = (now.weekday + 1) % 7; title = 'ตารางเรียนพรุ่งนี้'; }
    else {
      const idx = DAY_NAMES.findIndex((d) => t.includes(d));
      if (idx >= 0 && t.includes('ตาราง')) { weekday = idx; title = `ตารางเรียนวัน${DAY_NAMES[idx]}`; }
    }
    if (weekday === null) return;
    const list = db.classes.filter((c) => Number(c.day) === weekday).sort((a, b) => toMin(a.start) - toMin(b.start));
    return line.reply(db.settings, ev.replyToken, [line.dayScheduleMessage(list, db.rooms, weekday, db.settings, title)]);
  }
}

// ---------- ทั่วไป ----------
app.use(express.json({ limit: '1mb' }));
// health check (ใช้กับ Render และบริการปลุกเซิร์ฟเวอร์)
app.get('/healthz', (req, res) => res.json({ ok: true, storage: store.usingPostgres ? 'postgres' : 'file', time: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use('/fonts', express.static(store.FONT_DIR, { maxAge: '30d', immutable: true }));

// ธีมฟอนต์: CSS ที่สร้างจากการตั้งค่า (Google Font หรือฟอนต์ที่อัปโหลด)
app.get('/theme.css', (req, res) => {
  const { settings, fonts } = store.db;
  const css = [];
  const f = settings.font || {};
  let family = 'system-ui';
  if (f.source === 'google' && f.googleFamily) {
    css.push(`@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.googleFamily).replace(/%20/g, '+')}:wght@300;400;500;600;700&display=swap');`);
    family = `'${cssStr(f.googleFamily)}'`;
  }
  for (const font of fonts) {
    css.push(`@font-face{font-family:'${cssStr(font.family)}';src:url('/fonts/${font.file}') format('${font.format}');font-weight:${font.weight || '100 900'};font-style:normal;font-display:swap;}`);
  }
  const custom = fonts.find((x) => x.id === f.customFontId);
  if (f.source === 'custom' && custom) family = `'${cssStr(custom.family)}'`;
  css.push(`:root{--font:${family},'Noto Sans Thai',system-ui,-apple-system,'Segoe UI',sans-serif;--accent:${/^#[0-9a-f]{6}$/i.test(settings.accentColor) ? settings.accentColor : '#4f46e5'};}`);
  res.type('text/css').set('Cache-Control', 'no-cache').send(css.join('\n'));
});
const cssStr = (s) => String(s).replace(/['"\\<>;{}]/g, '');

// ---------- Auth ----------
app.get('/api/auth', (req, res) => res.json({ required: !!ADMIN_PASSWORD, ok: !ADMIN_PASSWORD || req.get('authorization') === `Bearer ${AUTH_TOKEN}` }));
app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.json({ token: '' });
  const ok = typeof req.body?.password === 'string'
    && crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  if (!ok) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ token: AUTH_TOKEN });
});
app.use('/api', (req, res, next) => {
  if (!ADMIN_PASSWORD || req.get('authorization') === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
});

// ---------- State ----------
function publicUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function maskedSettings(settings) {
  const { line: l, ...rest } = settings;
  const tok = l.channelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const sec = l.channelSecret || process.env.LINE_CHANNEL_SECRET || '';
  return {
    ...rest,
    line: {
      sendMode: l.sendMode, autoAddFollowers: l.autoAddFollowers, replyKeywords: l.replyKeywords,
      hasToken: !!tok, tokenHint: tok ? '••••' + tok.slice(-4) : '',
      hasSecret: !!sec, secretHint: sec ? '••••' + sec.slice(-4) : '',
      fromEnv: !l.channelAccessToken && !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
  };
}
app.get('/api/state', (req, res) => {
  const db = store.db;
  const now = localParts(new Date(), db.settings.timezone);
  res.json({
    settings: maskedSettings(db.settings),
    rooms: db.rooms, classes: db.classes, recipients: db.recipients, fonts: db.fonts,
    history: db.history.slice(0, 30),
    now,
    webhookUrl: publicUrl(req) + '/webhook/line',
  });
});

// ---------- Settings ----------
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
app.put('/api/settings', (req, res) => {
  const s = store.db.settings;
  const b = req.body || {};
  const next = pick(b, ['appName', 'schoolName', 'timezone', 'defaultReminderMinutes', 'remindersEnabled', 'visibleDays', 'dayStart', 'dayEnd', 'accentColor']);
  if (next.timezone && !isValidTimeZone(next.timezone)) return res.status(400).json({ error: 'โซนเวลาไม่ถูกต้อง' });
  for (const k of ['dayStart', 'dayEnd']) if (next[k] && !isValidTime(next[k])) return res.status(400).json({ error: 'รูปแบบเวลาไม่ถูกต้อง' });
  if (next.dayStart && next.dayEnd && toMin(next.dayEnd) <= toMin(next.dayStart)) return res.status(400).json({ error: 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม' });
  if (next.defaultReminderMinutes !== undefined) {
    const m = Number(next.defaultReminderMinutes);
    if (!Number.isInteger(m) || m < 0 || m > 1440) return res.status(400).json({ error: 'นาทีแจ้งเตือนต้องอยู่ระหว่าง 0–1440' });
    next.defaultReminderMinutes = m;
  }
  if (next.visibleDays) next.visibleDays = [...new Set(next.visibleDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  if (b.font) {
    const f = b.font;
    s.font = {
      source: ['google', 'custom', 'system'].includes(f.source) ? f.source : s.font.source,
      googleFamily: typeof f.googleFamily === 'string' ? f.googleFamily.trim().slice(0, 60) : s.font.googleFamily,
      customFontId: f.customFontId !== undefined ? f.customFontId : s.font.customFontId,
    };
  }
  Object.assign(s, next);
  store.save();
  res.json(maskedSettings(s));
});

app.put('/api/settings/line', (req, res) => {
  const l = store.db.settings.line;
  const b = req.body || {};
  if (typeof b.channelAccessToken === 'string' && b.channelAccessToken.trim()) l.channelAccessToken = b.channelAccessToken.trim();
  if (typeof b.channelSecret === 'string' && b.channelSecret.trim()) l.channelSecret = b.channelSecret.trim();
  if (b.clearCredentials) { l.channelAccessToken = ''; l.channelSecret = ''; }
  if (['broadcast', 'push'].includes(b.sendMode)) l.sendMode = b.sendMode;
  if (typeof b.autoAddFollowers === 'boolean') l.autoAddFollowers = b.autoAddFollowers;
  if (typeof b.replyKeywords === 'boolean') l.replyKeywords = b.replyKeywords;
  store.save();
  res.json(maskedSettings(store.db.settings));
});

app.post('/api/line/verify', async (req, res) => {
  try { res.json(await line.botInfo(store.db.settings)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function buildMessage(db, body) {
  const cls = db.classes.find((c) => c.id === body.classId) || body.class;
  if (!cls) throw Object.assign(new Error('ไม่พบคาบเรียน'), { status: 404 });
  const room = db.rooms.find((r) => r.id === cls.roomId);
  const minutes = body.minutes ?? scheduler.reminderMinutesOf(cls, db.settings);
  return line.reminderMessage(cls, room, Number(minutes), db.settings);
}
app.post('/api/line/preview', (req, res) => {
  try { res.json(buildMessage(store.db, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/line/test', async (req, res) => {
  const db = store.db;
  try {
    const msg = req.body?.day !== undefined
      ? line.dayScheduleMessage(db.classes.filter((c) => Number(c.day) === Number(req.body.day)).sort((a, b) => toMin(a.start) - toMin(b.start)), db.rooms, Number(req.body.day), db.settings, `ตารางเรียนวัน${DAY_NAMES[Number(req.body.day)]}`)
      : buildMessage(db, req.body || {});
    const result = await line.send(db.settings, db.recipients, [msg]);
    res.json({ ok: true, result });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// ---------- Rooms ----------
function cleanRoom(b) {
  const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  const lat = num(b.lat), lng = num(b.lng);
  if (lat !== null && (lat < -90 || lat > 90)) throw new Error('ละติจูดไม่ถูกต้อง');
  if (lng !== null && (lng < -180 || lng > 180)) throw new Error('ลองจิจูดไม่ถูกต้อง');
  const name = String(b.name || '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อห้อง');
  return {
    name: name.slice(0, 80),
    building: String(b.building || '').trim().slice(0, 80),
    floor: String(b.floor || '').trim().slice(0, 20),
    detail: String(b.detail || '').trim().slice(0, 300),
    mapUrl: /^https?:\/\//.test(b.mapUrl || '') ? String(b.mapUrl).slice(0, 500) : '',
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#4f46e5',
    lat, lng,
  };
}
crud('rooms', cleanRoom, (id) => {
  for (const c of store.db.classes) if (c.roomId === id) c.roomId = null;
});

// ---------- Classes ----------
function cleanClass(b) {
  const subject = String(b.subject || '').trim();
  if (!subject) throw new Error('กรุณาใส่ชื่อวิชา');
  if (!isValidTime(b.start) || !isValidTime(b.end)) throw new Error('รูปแบบเวลาไม่ถูกต้อง (HH:MM)');
  if (toMin(b.end) <= toMin(b.start)) throw new Error('เวลาเลิกต้องหลังเวลาเริ่ม');
  const day = Number(b.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('วันไม่ถูกต้อง');
  let rm = b.reminderMinutes;
  if (rm === '' || rm === undefined || rm === null) rm = null;
  else {
    rm = Number(rm);
    if (!Number.isInteger(rm) || rm < 0 || rm > 1440) throw new Error('นาทีแจ้งเตือนต้องอยู่ระหว่าง 0–1440');
  }
  const roomId = b.roomId && store.db.rooms.some((r) => r.id === b.roomId) ? b.roomId : null;
  return {
    subject: subject.slice(0, 100),
    code: String(b.code || '').trim().slice(0, 40),
    teacher: String(b.teacher || '').trim().slice(0, 80),
    note: String(b.note || '').trim().slice(0, 400),
    roomId, day, start: b.start, end: b.end,
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#6366f1',
    reminderEnabled: b.reminderEnabled !== false,
    reminderMinutes: rm,
  };
}
crud('classes', cleanClass);

function crud(name, clean, onDelete) {
  app.post(`/api/${name}`, (req, res) => {
    try {
      const item = { id: store.uid(), ...clean(req.body || {}) };
      store.db[name].push(item); store.save(); res.status(201).json(item);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put(`/api/${name}/:id`, (req, res) => {
    const item = store.db[name].find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    try {
      Object.assign(item, clean({ ...item, ...req.body }));
      if (name === 'classes') clearSentFor(item.id); // แก้เวลาแล้วให้แจ้งเตือนใหม่ได้
      store.save(); res.json(item);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${name}/:id`, (req, res) => {
    const list = store.db[name];
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    list.splice(i, 1);
    onDelete?.(req.params.id);
    store.save(); res.json({ ok: true });
  });
}
function clearSentFor(classId) {
  for (const k of Object.keys(store.db.sent)) if (k.startsWith(classId + '@')) delete store.db.sent[k];
}

// ---------- Recipients ----------
app.post('/api/recipients', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!/^[UCR][0-9a-f]{32}$/.test(id)) return res.status(400).json({ error: 'ID ต้องขึ้นต้นด้วย U/C/R ตามด้วยอักขระ 32 ตัว' });
  if (store.db.recipients.some((r) => r.id === id)) return res.status(409).json({ error: 'มีผู้รับนี้แล้ว' });
  const r = { id, type: { U: 'user', C: 'group', R: 'room' }[id[0]], name: String(req.body.name || '').slice(0, 80) || 'ผู้รับ', enabled: true, addedAt: new Date().toISOString() };
  store.db.recipients.push(r); store.save(); res.status(201).json(r);
});
app.put('/api/recipients/:id', (req, res) => {
  const r = store.db.recipients.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบผู้รับ' });
  if (typeof req.body.enabled === 'boolean') r.enabled = req.body.enabled;
  if (typeof req.body.name === 'string') r.name = req.body.name.slice(0, 80);
  store.save(); res.json(r);
});
app.delete('/api/recipients/:id', (req, res) => {
  store.db.recipients = store.db.recipients.filter((x) => x.id !== req.params.id);
  store.save(); res.json({ ok: true });
});

// ---------- Fonts ----------
const FONT_EXT = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' };
const upload = multer({
  storage: multer.diskStorage({
    destination: store.FONT_DIR,
    filename: (req, file, cb) => cb(null, `${store.uid()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(FONT_EXT[path.extname(file.originalname).toLowerCase()] ? null : new Error('รองรับเฉพาะไฟล์ .ttf .otf .woff .woff2'), true),
});
app.post('/api/fonts', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 15MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์ฟอนต์' });
    const ext = path.extname(req.file.filename);
    const family = (String(req.body.family || '').trim() || path.basename(req.file.originalname, path.extname(req.file.originalname)))
      .replace(/['"\\<>;{}]/g, '').slice(0, 60);
    const font = { id: store.uid(), family, file: req.file.filename, format: FONT_EXT[ext], originalName: req.file.originalname, size: req.file.size, addedAt: new Date().toISOString() };
    try { await store.persistFont(font.file); } catch (e) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(500).json({ error: 'บันทึกฟอนต์ไม่สำเร็จ: ' + e.message });
    }
    store.db.fonts.push(font); store.save();
    res.status(201).json(font);
  });
});
app.delete('/api/fonts/:id', (req, res) => {
  const db = store.db;
  const font = db.fonts.find((f) => f.id === req.params.id);
  if (!font) return res.status(404).json({ error: 'ไม่พบฟอนต์' });
  db.fonts = db.fonts.filter((f) => f.id !== font.id);
  store.removeFont(font.file).catch((e) => console.error('[fonts]', e.message));
  if (db.settings.font.customFontId === font.id) db.settings.font = { ...db.settings.font, source: 'google', customFontId: null };
  store.save(); res.json({ ok: true });
});

// ---------- Backup ----------
app.get('/api/export', (req, res) => {
  const { rooms, classes } = store.db;
  res.attachment('timetable-backup.json').json({ version: 1, rooms, classes });
});
app.post('/api/import', (req, res) => {
  const { rooms, classes } = req.body || {};
  if (!Array.isArray(rooms) || !Array.isArray(classes)) return res.status(400).json({ error: 'ไฟล์ไม่ถูกต้อง' });
  try {
    const db = store.db;
    const prevRooms = db.rooms;
    db.rooms = rooms.map((r) => ({ id: String(r.id || store.uid()), ...cleanRoom(r) }));
    try {
      db.classes = classes.map((c) => ({ id: String(c.id || store.uid()), ...cleanClass(c) }));
    } catch (e) { db.rooms = prevRooms; throw e; }
    db.sent = {};
    store.save();
    res.json({ ok: true, rooms: db.rooms.length, classes: db.classes.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API' }));

// Render free plan จะหลับเมื่อไม่มีคนเข้า 15 นาที ซึ่งทำให้แจ้งเตือนไม่ทำงาน
// จึงปิงตัวเองผ่าน URL สาธารณะทุก 10 นาที (ปิดได้ด้วย KEEP_ALIVE=false)
function startKeepAlive() {
  const base = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base || process.env.KEEP_ALIVE === 'false') return;
  const url = base.replace(/\/$/, '') + '/healthz';
  setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(20000) }).catch((e) => console.warn('[keep-alive]', e.message));
  }, 10 * 60 * 1000).unref();
  console.log(`[keep-alive] ปิง ${url} ทุก 10 นาที`);
}

if (require.main === module) {
  store.init().then(() => {
    app.listen(PORT, () => {
      console.log(`📚 ตารางสอนพร้อมใช้งานที่ http://localhost:${PORT}`);
      scheduler.start();
      startKeepAlive();
    });
  }).catch((e) => {
    console.error('เริ่มระบบไม่สำเร็จ (เชื่อมต่อฐานข้อมูลไม่ได้?):', e.message);
    process.exit(1);
  });
  const shutdown = () => { store.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;

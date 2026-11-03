'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const store = require('./src/store');
const line = require('./src/line');
const scheduler = require('./src/scheduler');
const vision = require('./src/vision');
const cal = require('./src/calendar');
const notify = require('./src/notify');
const richmenu = require('./src/richmenu');
const members = require('./src/members');
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
      r = { id, type, name: '', enabled: true, code: members.genCode(db), addedAt: new Date().toISOString() };
      db.recipients.push(r);
      try {
        r.name = type === 'user' ? (await line.profile(db.settings, id)).displayName
          : type === 'group' ? (await line.groupSummary(db.settings, id)).groupName : 'ห้องแชท';
      } catch { r.name = type === 'user' ? 'ผู้ใช้ LINE' : 'กลุ่ม LINE'; }
      store.save();
    } else if (r.left) { r.left = false; r.enabled = true; store.save(); }
    if (r && !r.code) { r.code = members.genCode(db); store.save(); }
  }

  if (!ev.replyToken) return;
  if (ev.type === 'follow' || ev.type === 'join') {
    const me = db.recipients.find((x) => x.id === id);
    const msgs = [{ type: 'text', text: `สวัสดีครับ 👋 ระบบ${db.settings.appName}จะแจ้งเตือนก่อนเริ่มคาบเรียนให้อัตโนมัติ\n\nกดเมนูด้านล่าง หรือพิมพ์ "ตารางวันนี้" "ตารางพรุ่งนี้" "คาบถัดไป" "วันหยุด" "รหัส" ได้เลย` }];
    if (me?.code) msgs.push(line.memberCardMessage(me, db.groups.find((g) => g.id === me.groupId), db));
    // ผู้ใช้ใหม่: สร้างริชเมนูส่วนตัวที่มีรหัสสมาชิกให้ทันที
    if (me && me.type === 'user') richmenu.linkRecipient(db, me).catch((e) => console.error('[richmenu] personal:', e.message));
    return line.reply(db.settings, ev.replyToken, msgs);
  }
  if (ev.type === 'message' && ev.message?.type === 'text' && db.settings.line.replyKeywords) {
    const msgs = keywordReply(db, ev.message.text, db.recipients.find((x) => x.id === id));
    if (msgs) return line.reply(db.settings, ev.replyToken, msgs);
  }
}

/** คาบเรียนของชั้น/ห้อง (คาบที่ไม่ระบุห้อง = ทุกห้อง) */
function classesFor(db, groupId, weekday) {
  return db.classes
    .filter((c) => c.day === weekday && (!c.groupId || c.groupId === groupId))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}

/** ตอบคำสั่งจากเมนู/ข้อความ ตามชั้นเรียนของผู้ส่ง */
function keywordReply(db, text, recipient) {
  const t = String(text || '').trim();
  const tz = db.settings.timezone;
  const now = localParts(new Date(), tz);
  const todayKey = richmenu.todayKeyOf(db);
  const group = recipient?.groupId ? db.groups.find((g) => g.id === recipient.groupId) : null;
  const gid = group ? group.id : null;
  const gname = group ? group.name : '';
  const noGroupNote = !group && db.groups.length
    ? [{ type: 'text', text: `ℹ️ บัญชีนี้ยังไม่ได้เข้าชั้นเรียน จึงแสดงเฉพาะคาบที่ใช้ร่วมทุกห้อง${recipient?.code ? `\nแจ้งรหัสสมาชิก ${recipient.code} กับครูเพื่อเข้าห้อง` : ''}` }]
    : [];

  const dayReply = (key, title) => {
    const sd = cal.specialOn(db, key);
    if (sd && sd.suspendClasses !== false) return [line.specialDayMessage(sd, key, db, key === todayKey ? 'today' : 'tomorrow')];
    const wd = cal.weekdayOf(key);
    const sub = [gname, cal.thaiDate(key, { weekday: true })].filter(Boolean).join(' · ');
    const msgs = [line.dayScheduleMessage(classesFor(db, gid, wd), db.rooms, wd, db.settings, title, sub)];
    if (sd) msgs.push(line.specialDayMessage(sd, key, db, key === todayKey ? 'today' : 'tomorrow'));
    return msgs.concat(noGroupNote);
  };

  if (/^(ตาราง)?วันนี้$|^ตาราง$|^today$/i.test(t)) return dayReply(todayKey, 'ตารางเรียนวันนี้');
  if (/^(ตาราง)?พรุ่งนี้$|^tomorrow$/i.test(t)) return dayReply(cal.shiftKey(todayKey, 1), 'ตารางเรียนพรุ่งนี้');
  if (/ทั้งสัปดาห์|^ตารางสัปดาห์$|^week$/i.test(t)) {
    const days = [...(db.settings.visibleDays || [1, 2, 3, 4, 5])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    return [line.weekScheduleMessage(days.map((wd) => ({ weekday: wd, classes: classesFor(db, gid, wd) })), db.rooms, db.settings, gname)].concat(noGroupNote);
  }
  if (/^คาบ(ถัดไป|ต่อไป)$|^next$/i.test(t)) {
    const nowMin = now.hour * 60 + now.minute;
    for (let off = 0; off < 21; off++) {
      const key = cal.shiftKey(todayKey, off);
      if (cal.isSuspended(db, key)) continue;
      const c = classesFor(db, gid, cal.weekdayOf(key)).find((x) => off > 0 || toMin(x.start) > nowMin);
      if (c) {
        const room = db.rooms.find((r) => r.id === c.roomId);
        const mins = off * 1440 + toMin(c.start) - nowMin;
        const label = off === 0 ? 'วันนี้' : off === 1 ? 'พรุ่งนี้' : cal.thaiDate(key, { short: true, weekday: false });
        const msg = mins < 24 * 60
          ? line.reminderMessage(c, room, mins, db.settings, group)
          : { type: 'flex', altText: `คาบถัดไป: ${c.subject} ${label}`, contents: line.classBubble(c, room, { settings: db.settings, dateLabel: `${label} ${c.start} น.`, group }) };
        return [msg].concat(noGroupNote);
      }
    }
    return [{ type: 'text', text: 'ไม่พบคาบเรียนในอีก 3 สัปดาห์ข้างหน้า' }].concat(noGroupNote);
  }
  if (/^(วันหยุด|ปฏิทิน|กิจกรรม|holiday)/i.test(t)) return [line.upcomingSpecialMessage(cal.upcoming(db, todayKey, 10), db, todayKey)];
  if (/^(ห้องของฉัน|ชั้นของฉัน|รหัส|รหัสสมาชิก|my ?code|code)$/i.test(t)) {
    if (!recipient) return [{ type: 'text', text: 'ยังไม่พบบัญชีนี้ในระบบ กรุณาลองพิมพ์อีกครั้ง' }];
    return [line.memberCardMessage(recipient, group, db)];
  }
  const idx = DAY_NAMES.findIndex((d) => t.includes(d));
  if (idx >= 0 && t.includes('ตาราง')) {
    return [line.dayScheduleMessage(classesFor(db, gid, idx), db.rooms, idx, db.settings, `ตารางเรียนวัน${DAY_NAMES[idx]}`, gname || undefined)].concat(noGroupNote);
  }
  return null;
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
// ข้อมูลสาธารณะสำหรับหน้านโยบายความเป็นส่วนตัว / ข้อกำหนดการใช้บริการ (ไม่ต้องล็อกอิน)
app.get('/public-info.json', (req, res) => {
  const s = store.db.settings;
  res.set('Cache-Control', 'no-cache').json({ appName: s.appName, schoolName: s.schoolName || '', contactEmail: s.contactEmail || '', url: publicUrl(req) });
});

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
  const { line: l, ai = {}, ...rest } = settings;
  const aiKey = vision.apiKeyOf(settings);
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
    ai: { hasKey: !!aiKey, keyHint: aiKey ? '••••' + aiKey.slice(-4) : '', fromEnv: !ai.apiKey && !!process.env.ANTHROPIC_API_KEY, model: vision.MODEL },
  };
}
app.get('/api/state', (req, res) => {
  const db = store.db;
  const now = localParts(new Date(), db.settings.timezone);
  res.json({
    settings: maskedSettings(db.settings),
    rooms: db.rooms, classes: db.classes, recipients: db.recipients, fonts: db.fonts,
    groups: db.groups, specialDays: db.specialDays,
    todayKey: richmenu.todayKeyOf(db),
    history: db.history.slice(0, 30),
    storage: store.usingPostgres ? 'postgres' : 'file',
    now,
    webhookUrl: publicUrl(req) + '/webhook/line',
  });
});

// ---------- Settings ----------
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
app.put('/api/settings', (req, res) => {
  const s = store.db.settings;
  const b = req.body || {};
  const next = pick(b, ['appName', 'schoolName', 'contactEmail', 'timezone', 'defaultReminderMinutes', 'remindersEnabled', 'visibleDays', 'dayStart', 'dayEnd', 'accentColor', 'announceEnabled', 'announceTime', 'announceEve']);
  if (next.announceTime !== undefined && !isValidTime(next.announceTime)) return res.status(400).json({ error: 'เวลาประกาศไม่ถูกต้อง' });
  for (const k of ['announceEnabled', 'announceEve']) if (next[k] !== undefined) next[k] = !!next[k];
  if (next.contactEmail !== undefined) {
    next.contactEmail = String(next.contactEmail).trim().slice(0, 120);
    if (next.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.contactEmail)) return res.status(400).json({ error: 'อีเมลติดต่อไม่ถูกต้อง' });
  }
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
  markDirty();
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

app.put('/api/settings/ai', (req, res) => {
  const s = store.db.settings;
  s.ai = s.ai || { apiKey: '' };
  if (typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()) s.ai.apiKey = req.body.apiKey.trim();
  if (req.body?.clear) s.ai.apiKey = '';
  store.save();
  res.json(maskedSettings(s));
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
  return line.reminderMessage(cls, room, Number(minutes), db.settings, db.groups.find((g) => g.id === cls.groupId));
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

// ---------- ริชเมนูรายวัน ----------
function markDirty() {
  const rm = store.db.settings.richMenu;
  if (rm && rm.enabled) { rm.dirtyAt = Date.now(); rm.failedAt = null; }
}
async function sendPreview(req, res, design) {
  const db = store.db;
  const q = { ...req.query, ...(req.body || {}) };
  const gid = q.group && db.groups.some((g) => g.id === q.group) ? q.group : null;
  const key = cal.isDateKey(q.date) ? q.date : richmenu.todayKeyOf(db);
  try {
    const img = await richmenu.preview(db, gid, key, design, { code: q.code ? String(q.code) : undefined });
    res.type(img.contentType).set('Cache-Control', 'no-store').set('X-Image-Bytes', String(img.data.length));
    if (img.warning) res.set('X-Font-Warning', encodeURIComponent(img.warning));
    res.send(img.data);
  } catch (e) { res.status(400).json({ error: e.message }); }
}
app.get('/api/richmenu/preview.png', (req, res) => sendPreview(req, res));
// ดูตัวอย่างการออกแบบที่ยังไม่บันทึก
app.post('/api/richmenu/preview', (req, res) => sendPreview(req, res, req.body?.design));
app.get('/api/richmenu/design', (req, res) => {
  res.json({ design: richmenu.normalizeDesign(store.db.settings.richMenu.design), layouts: richmenu.LAYOUTS, actions: richmenu.ACTIONS });
});
app.put('/api/richmenu/design', async (req, res) => {
  const db = store.db;
  const design = richmenu.normalizeDesign(req.body?.design);
  if (design.font.source === 'google') {
    try { await richmenu.ensureGoogleFont(design.font.family); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  db.settings.richMenu.design = design;
  markDirty();
  store.save();
  res.json({ design });
});
// อัปโหลดโลโก้/รูปพื้นหลังของริชเมนู
const IMG_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg' };
const rmImageUpload = multer({
  storage: multer.diskStorage({ destination: store.FONT_DIR, filename: (req, file, cb) => cb(null, `img-${store.uid()}${IMG_EXT[file.mimetype] || '.png'}`) }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(IMG_EXT[file.mimetype] ? null : new Error('รองรับเฉพาะรูป PNG หรือ JPG'), true),
});
app.post('/api/richmenu/image', (req, res) => {
  rmImageUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'รูปใหญ่เกิน 5MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูป' });
    try { await store.persistFont(req.file.filename); } catch (e) { return res.status(500).json({ error: e.message }); }
    res.status(201).json({ file: req.file.filename });
  });
});
app.get('/api/richmenu/image/:file', (req, res) => {
  const f = path.basename(req.params.file);
  if (!/^img-[a-z0-9]+\.(png|jpe?g)$/i.test(f)) return res.status(404).end();
  res.sendFile(path.join(store.FONT_DIR, f), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
app.put('/api/richmenu', async (req, res) => {
  const db = store.db;
  const rm = db.settings.richMenu;
  const b = req.body || {};
  try {
    if (typeof b.selected === 'boolean') rm.selected = b.selected;
    if (typeof b.enabled === 'boolean' && b.enabled !== rm.enabled) {
      rm.enabled = b.enabled;
      if (!b.enabled && line.creds(db.settings).token) await richmenu.removeAll(db);
      if (b.enabled) { rm.builtFor = null; rm.failedAt = null; }
    }
    store.save();
    res.json(maskedSettings(db.settings));
  } catch (e) { store.save(); res.status(400).json({ error: e.message }); }
});
app.post('/api/richmenu/rebuild', async (req, res) => {
  const db = store.db;
  if (!db.settings.richMenu.enabled) return res.status(400).json({ error: 'กรุณาเปิดใช้ริชเมนูก่อน' });
  if (!line.creds(db.settings).token) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Channel Access Token' });
  try { res.json({ ok: true, ...(await scheduler.richMenuTick(db, { force: true })) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- ประกาศวันหยุด ----------
app.post('/api/announce/preview', (req, res) => {
  const db = store.db;
  const sd = db.specialDays.find((x) => x.id === req.body?.id) || req.body?.special;
  if (!sd) return res.status(404).json({ error: 'ไม่พบวันพิเศษ' });
  const key = cal.isDateKey(sd.start) ? sd.start : richmenu.todayKeyOf(db);
  res.json(line.specialDayMessage(sd, key, db, req.body?.mode === 'tomorrow' ? 'tomorrow' : 'today'));
});
app.post('/api/announce/test', async (req, res) => {
  const db = store.db;
  const sd = db.specialDays.find((x) => x.id === req.body?.id);
  if (!sd) return res.status(404).json({ error: 'ไม่พบวันพิเศษ' });
  try { res.json({ ok: true, detail: await notify.sendToAll(db, [line.specialDayMessage(sd, sd.start, db, 'today')]) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- ชั้นเรียน (ม./ห้อง) ----------
function cleanGroup(b, current) {
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('กรุณาใส่ชื่อชั้นเรียน เช่น ม.4/1');
  if (store.db.groups.some((g) => g.name === name && g.id !== current?.id)) throw new Error(`มีชั้นเรียน ${name} แล้ว`);
  return { name: name.slice(0, 40), note: String(b.note || '').trim().slice(0, 200) };
}
crud('groups', cleanGroup, (id) => {
  for (const c of store.db.classes) if (c.groupId === id) c.groupId = null;
  for (const r of store.db.recipients) if (r.groupId === id) r.groupId = null;
});
app.post('/api/groups/bulk', (req, res) => {
  const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => String(n).trim()).filter(Boolean).slice(0, 200);
  const added = [];
  for (const name of names) {
    if (store.db.groups.some((g) => g.name === name)) continue;
    const g = { id: store.uid(), ...cleanGroup({ name }) };
    store.db.groups.push(g); added.push(g);
  }
  sortGroups(); markDirty(); store.save();
  res.json({ added: added.length });
});
function sortGroups() {
  store.db.groups.sort((a, b) => a.name.localeCompare(b.name, 'th', { numeric: true }));
}

// ---------- วันพิเศษ (หยุดทั้งโรงเรียน) ----------
function cleanSpecial(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อวันพิเศษ');
  if (!cal.TYPES[b.type]) throw new Error('ประเภทไม่ถูกต้อง');
  if (!cal.isDateKey(b.start) || !cal.isDateKey(b.end || b.start)) throw new Error('วันที่ไม่ถูกต้อง');
  const end = b.end || b.start;
  if (end < b.start) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (cal.daysBetween(b.start, end) > 366) throw new Error('ช่วงวันยาวเกิน 1 ปี');
  return {
    name: name.slice(0, 80), type: b.type, start: b.start, end,
    suspendClasses: b.type === 'activity' ? b.suspendClasses !== false : true,
    note: String(b.note || '').trim().slice(0, 300),
  };
}
crud('specialDays', cleanSpecial);

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
  const groupId = b.groupId && store.db.groups.some((g) => g.id === b.groupId) ? b.groupId : null;
  return {
    groupId,
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
      store.db[name].push(item);
      if (name === 'groups') sortGroups();
      markDirty(); store.save(); res.status(201).json(item);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put(`/api/${name}/:id`, (req, res) => {
    const item = store.db[name].find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    try {
      Object.assign(item, clean({ ...item, ...req.body }, item));
      if (name === 'classes') clearSentFor(item.id); // แก้เวลาแล้วให้แจ้งเตือนใหม่ได้
      if (name === 'groups') sortGroups();
      markDirty(); store.save(); res.json(item);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${name}/:id`, (req, res) => {
    const list = store.db[name];
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    list.splice(i, 1);
    onDelete?.(req.params.id);
    markDirty(); store.save(); res.json({ ok: true });
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
  const r = { id, type: { U: 'user', C: 'group', R: 'room' }[id[0]], name: String(req.body.name || '').slice(0, 80) || 'ผู้รับ', enabled: true, code: members.genCode(store.db), addedAt: new Date().toISOString() };
  store.db.recipients.push(r); store.save(); res.status(201).json(r);
});
app.put('/api/recipients/:id', (req, res) => {
  const r = store.db.recipients.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบผู้รับ' });
  if (typeof req.body.enabled === 'boolean') r.enabled = req.body.enabled;
  if (typeof req.body.name === 'string') r.name = req.body.name.slice(0, 80);
  if (req.body.groupId !== undefined) {
    const gid = req.body.groupId && store.db.groups.some((g) => g.id === req.body.groupId) ? req.body.groupId : null;
    if (gid !== (r.groupId || null)) {
      r.groupId = gid;
      // เปลี่ยนริชเมนูของผู้ใช้คนนี้ให้เป็นของชั้นเรียนใหม่ทันที
      richmenu.linkRecipient(store.db, r).catch((e) => console.error('[richmenu] link:', e.message));
    }
  }
  store.save(); res.json(r);
});
// เพิ่มบัญชี LINE เข้าชั้นเรียนด้วยรหัสสมาชิก 6 หลัก
app.post('/api/members/assign', (req, res) => {
  const db = store.db;
  const code = members.normalizeCode(req.body?.code);
  if (code.length !== 6) return res.status(400).json({ error: 'รหัสสมาชิกต้องเป็นตัวเลข 6 หลัก' });
  const r = members.findByCode(db, code);
  if (!r) return res.status(404).json({ error: `ไม่พบรหัส ${code} — ให้นักเรียนพิมพ์ “รหัส” ใน LINE เพื่อดูรหัสที่ถูกต้อง` });
  const group = db.groups.find((g) => g.id === req.body.groupId);
  if (!group) return res.status(400).json({ error: 'กรุณาเลือกชั้นเรียน' });
  const moved = r.groupId && r.groupId !== group.id ? db.groups.find((g) => g.id === r.groupId)?.name : null;
  r.groupId = group.id;
  if (r.left) { r.left = false; r.enabled = true; }
  store.save();
  richmenu.linkRecipient(db, r).catch((e) => console.error('[richmenu] link:', e.message));
  res.json({ ok: true, recipient: r, group: group.name, movedFrom: moved });
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

// ---------- v2.0: เพิ่มตารางจากรูป ----------
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(IMAGE_TYPES.includes(file.mimetype) ? null : new Error('รองรับเฉพาะรูป JPG, PNG, WEBP, GIF'), true),
});
const CLASS_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#06b6d4', '#84cc16', '#f43f5e'];

/** เพิ่มรายการที่ตรวจแล้วเข้าระบบ (สร้างห้องใหม่ให้ถ้ายังไม่มี) */
function commitEntries(list) {
  const db = store.db;
  const added = [], failed = [], results = [];
  const createdRooms = [];
  for (const e of list) {
    try {
      let roomId = e.roomId && db.rooms.some((r) => r.id === e.roomId) ? e.roomId : null;
      const roomName = String(e.newRoomName || e.roomName || '').trim();
      if (!roomId && roomName) {
        let room = vision.findRoom(db.rooms, roomName);
        if (!room) {
          room = { id: store.uid(), ...cleanRoom({ name: roomName, color: CLASS_COLORS[db.rooms.length % CLASS_COLORS.length] }) };
          db.rooms.push(room);
          createdRooms.push(room.name);
        }
        roomId = room.id;
      }
      const same = db.classes.find((c) => c.subject.trim().toLowerCase() === String(e.subject).trim().toLowerCase());
      const used = new Set(db.classes.map((c) => c.color));
      const color = e.color || same?.color || CLASS_COLORS.find((c) => !used.has(c)) || CLASS_COLORS[db.classes.length % CLASS_COLORS.length];
      const item = { id: store.uid(), ...cleanClass({ ...e, groupId: e.groupId || null, roomId, color, reminderEnabled: true, reminderMinutes: null, note: e.note || '' }) };
      db.classes.push(item);
      added.push(item);
      results.push({ ok: true, id: item.id });
    } catch (err) {
      failed.push({ subject: e.subject, error: err.message });
      results.push({ ok: false, error: err.message });
    }
  }
  store.save();
  return { added, failed, createdRooms, results };
}

app.post('/api/vision/analyze', (req, res) => {
  imageUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'รูปใหญ่เกิน 10MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกรูปตารางสอน' });
    try {
      const result = await vision.extractFromImage(store.db.settings, {
        data: req.file.buffer.toString('base64'), mediaType: req.file.mimetype, hint: req.body.hint,
      });
      const groupId = req.body.groupId && store.db.groups.some((g) => g.id === req.body.groupId) ? req.body.groupId : null;
      const entries = vision.review(result.entries, store.db, groupId);
      entries.forEach((e) => { e.groupId = groupId; });
      let commit = null;
      if (req.body.auto === '1') {
        const ok = entries.filter((e) => e.status === 'ok');
        commit = commitEntries(ok);
        ok.forEach((e) => { e.status = 'added'; });
      }
      res.json({ entries, warnings: result.warnings, model: result.model, commit });
    } catch (e) {
      console.error('[vision]', e.message);
      res.status(e.status || 500).json({ error: e.message });
    }
  });
});

app.post('/api/vision/commit', (req, res) => {
  const list = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 200) : null;
  if (!list || !list.length) return res.status(400).json({ error: 'ไม่มีรายการที่จะเพิ่ม' });
  res.json(commitEntries(list));
});

// ---------- Backup ----------
// สำรองข้อมูลทั้งหมด (รวมการตั้งค่า LINE และผู้รับ) — ไฟล์มีรหัสลับ ควรเก็บเป็นความลับ
app.get('/api/export', (req, res) => {
  const { settings, rooms, classes, recipients, groups, specialDays } = store.db;
  res.attachment('timetable-backup.json').json({ version: 3, exportedAt: new Date().toISOString(), settings, groups, specialDays, rooms, classes, recipients });
});
app.post('/api/import', (req, res) => {
  const { rooms, classes, settings, recipients, groups, specialDays } = req.body || {};
  if (!Array.isArray(rooms) || !Array.isArray(classes)) return res.status(400).json({ error: 'ไฟล์ไม่ถูกต้อง' });
  const db = store.db;
  const prev = { rooms: db.rooms, classes: db.classes, settings: db.settings, recipients: db.recipients, groups: db.groups, specialDays: db.specialDays };
  try {
    if (Array.isArray(groups)) { db.groups = []; for (const g of groups) db.groups.push({ id: String(g.id || store.uid()), ...cleanGroup(g) }); sortGroups(); }
    if (Array.isArray(specialDays)) db.specialDays = specialDays.map((x) => ({ id: String(x.id || store.uid()), ...cleanSpecial(x) }));
    db.rooms = rooms.map((r) => ({ id: String(r.id || store.uid()), ...cleanRoom(r) }));
    db.classes = classes.map((c) => ({ id: String(c.id || store.uid()), ...cleanClass(c) }));
    if (settings && typeof settings === 'object') {
      const keep = pick(settings, ['appName', 'schoolName', 'contactEmail', 'timezone', 'defaultReminderMinutes', 'remindersEnabled', 'visibleDays', 'dayStart', 'dayEnd', 'accentColor']);
      if (keep.timezone && !isValidTimeZone(keep.timezone)) delete keep.timezone;
      db.settings = {
        ...db.settings, ...keep,
        line: { ...db.settings.line, ...(settings.line || {}) },
        ai: { ...(db.settings.ai || {}), ...(settings.ai || {}) },
        richMenu: db.settings.richMenu,
        // ฟอนต์ที่อัปโหลดไม่ได้อยู่ในไฟล์สำรอง จึงคงฟอนต์ปัจจุบันไว้ ยกเว้น Google Font
        font: settings.font && settings.font.source !== 'custom' ? { ...db.settings.font, ...settings.font } : db.settings.font,
      };
    }
    if (Array.isArray(recipients)) {
      db.recipients = recipients
        .filter((r) => r && /^[UCR][0-9a-f]{32}$/.test(r.id))
        .map((r) => ({ id: r.id, type: { U: 'user', C: 'group', R: 'room' }[r.id[0]], name: String(r.name || '').slice(0, 80), enabled: r.enabled !== false, left: !!r.left, groupId: r.groupId && db.groups.some((g) => g.id === r.groupId) ? r.groupId : null, code: /^\d{6}$/.test(r.code || '') ? r.code : undefined, addedAt: r.addedAt || new Date().toISOString() }));
    }
    members.ensureCodes(db);
    db.sent = {};
    markDirty();
    store.save();
    res.json({ ok: true, groups: db.groups.length, specialDays: db.specialDays.length, rooms: db.rooms.length, classes: db.classes.length, recipients: db.recipients.length, settings: !!settings });
  } catch (e) {
    Object.assign(db, prev);
    res.status(400).json({ error: e.message });
  }
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
    const filled = members.ensureCodes(store.db);
    if (filled) { console.log(`[members] สร้างรหัสสมาชิกให้บัญชีเดิม ${filled} บัญชี`); store.save(); }
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

app.locals.keywordReply = keywordReply; // สำหรับทดสอบ
module.exports = app;

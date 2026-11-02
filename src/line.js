'use strict';
// LINE Messaging API: ส่งข้อความ, ตรวจลายเซ็น webhook และสร้าง Flex Message
const crypto = require('crypto');
const { DAY_NAMES } = require('./time');
const cal = require('./calendar');

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

function creds(settings) {
  return {
    token: settings.line.channelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    secret: settings.line.channelSecret || process.env.LINE_CHANNEL_SECRET || '',
  };
}

async function call(token, pathname, body, method = 'POST') {
  if (!token) throw new Error('ยังไม่ได้ตั้งค่า Channel Access Token');
  let res;
  try {
    res = await fetch(API + pathname, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`เชื่อมต่อ LINE API ไม่ได้ (${e.cause?.code || e.name}) — ตรวจสอบอินเทอร์เน็ตของเซิร์ฟเวอร์`);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.details ? ' — ' + data.details.map((d) => `${d.property}: ${d.message}`).join('; ') : '';
    throw new Error(`LINE API ${res.status}: ${data.message || text}${detail}`);
  }
  return data;
}

function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ส่งข้อความตามโหมดที่ตั้งไว้ (broadcast ถึงเพื่อนทุกคน หรือ push ถึงผู้รับที่เลือก) */
async function send(settings, recipients, messages) {
  const { token } = creds(settings);
  if (settings.line.sendMode === 'push') {
    const ids = recipients.filter((r) => r.enabled).map((r) => r.id);
    if (!ids.length) throw new Error('ยังไม่มีผู้รับที่เปิดใช้งาน (เพิ่มเพื่อน OA หรือเพิ่มบอทเข้ากลุ่มก่อน)');
    const results = [];
    for (const id of ids) {
      try { await call(token, '/message/push', { to: id, messages }); results.push({ id, ok: true }); }
      catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) throw new Error(failed[0].error);
    return { mode: 'push', sent: results.length - failed.length, failed: failed.length };
  }
  await call(token, '/message/broadcast', { messages });
  return { mode: 'broadcast' };
}

const reply = (settings, replyToken, messages) => call(creds(settings).token, '/message/reply', { replyToken, messages });
const botInfo = (settings) => call(creds(settings).token, '/info', null, 'GET');
const profile = (settings, userId) => call(creds(settings).token, `/profile/${encodeURIComponent(userId)}`, null, 'GET');
const groupSummary = (settings, groupId) => call(creds(settings).token, `/group/${encodeURIComponent(groupId)}/summary`, null, 'GET');

/** multicast ถึงผู้ใช้ได้ครั้งละไม่เกิน 500 คน */
async function multicast(settings, userIds, messages) {
  const token = creds(settings).token;
  for (let i = 0; i < userIds.length; i += 500) {
    await call(token, '/message/multicast', { to: userIds.slice(i, i + 500), messages });
  }
}
const push = (settings, to, messages) => call(creds(settings).token, '/message/push', { to, messages });
const broadcast = (settings, messages) => call(creds(settings).token, '/message/broadcast', { messages });

// ---------------- Rich menu ----------------
const richMenu = {
  create: (settings, menu) => call(creds(settings).token, '/richmenu', menu),
  async upload(settings, richMenuId, png) {
    const token = creds(settings).token;
    if (!token) throw new Error('ยังไม่ได้ตั้งค่า Channel Access Token');
    let res;
    try {
      res = await fetch(`${DATA_API}/richmenu/${encodeURIComponent(richMenuId)}/content`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: png,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) { throw new Error(`อัปโหลดรูปริชเมนูไม่ได้ (${e.cause?.code || e.name})`); }
    if (!res.ok) throw new Error(`LINE API ${res.status}: ${await res.text()}`);
  },
  setDefault: (settings, id) => call(creds(settings).token, `/user/all/richmenu/${encodeURIComponent(id)}`, {}),
  clearDefault: (settings) => call(creds(settings).token, '/user/all/richmenu', null, 'DELETE'),
  linkUser: (settings, userId, id) => call(creds(settings).token, `/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(id)}`, {}),
  unlinkUser: (settings, userId) => call(creds(settings).token, `/user/${encodeURIComponent(userId)}/richmenu`, null, 'DELETE'),
  async bulkLink(settings, id, userIds) {
    for (let i = 0; i < userIds.length; i += 500) {
      await call(creds(settings).token, '/richmenu/bulk/link', { richMenuId: id, userIds: userIds.slice(i, i + 500) });
    }
  },
  remove: (settings, id) => call(creds(settings).token, `/richmenu/${encodeURIComponent(id)}`, null, 'DELETE'),
  list: (settings) => call(creds(settings).token, '/richmenu/list', null, 'GET'),
};

// ---------------- Flex Message ----------------

function hex(c, fallback = '#4f46e5') {
  return /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : fallback;
}

/** ผสมสีกับขาว (ratio 0..1) เพื่อทำสีพื้นอ่อน */
function tint(c, ratio) {
  const n = parseInt(hex(c).slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * ratio);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function navUrl(room) {
  if (!room) return null;
  if (room.lat != null && room.lng != null && room.lat !== '' && room.lng !== '') {
    return `https://www.google.com/maps/dir/?api=1&destination=${Number(room.lat)},${Number(room.lng)}&travelmode=walking`;
  }
  if (room.mapUrl && /^https?:\/\//.test(room.mapUrl)) return room.mapUrl;
  return null;
}

function trim(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function row(icon, label, value, color = '#334155') {
  return {
    type: 'box', layout: 'baseline', spacing: 'md',
    contents: [
      { type: 'text', text: icon, size: 'sm', flex: 0 },
      { type: 'text', text: label, size: 'sm', color: '#94a3b8', flex: 2 },
      { type: 'text', text: trim(value, 300) || '-', size: 'sm', color, flex: 5, wrap: true, weight: 'bold' },
    ],
  };
}

function minutesLabel(m) {
  if (m <= 0) return 'เริ่มแล้วตอนนี้';
  if (m < 60) return `อีก ${m} นาที`;
  const h = Math.floor(m / 60), r = m % 60;
  return `อีก ${h} ชม.${r ? ` ${r} นาที` : ''}`;
}

/** Bubble แจ้งเตือนคาบเรียน */
function classBubble(cls, room, { minutesBefore, settings, dateLabel, group }) {
  const color = hex(cls.color || room?.color, hex(settings.accentColor));
  const url = navUrl(room);
  const place = [room?.building, room?.floor ? `ชั้น ${room.floor}` : ''].filter(Boolean).join(' · ');

  const body = [
    row('🕘', 'เวลา', `${cls.start} – ${cls.end} น.`),
    row('📍', 'ห้อง', room ? room.name : 'ยังไม่ระบุห้อง', color),
  ];
  if (place) body.push(row('🏢', 'อาคาร', place));
  if (cls.teacher) body.push(row('👩‍🏫', 'ผู้สอน', cls.teacher));
  if (room?.detail) body.push(row('🧭', 'ทางไป', room.detail));
  if (cls.note) {
    body.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
    body.push({
      type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '12px', cornerRadius: '10px', backgroundColor: tint(color, 0.9),
      contents: [{ type: 'text', text: `📝 ${trim(cls.note, 400)}`, size: 'sm', color: '#334155', wrap: true }],
    });
  }

  const footer = [];
  if (url) {
    footer.push({ type: 'button', style: 'primary', color, height: 'sm', action: { type: 'uri', label: '🧭 นำทางไปห้อง', uri: url } });
  }
  footer.push({ type: 'button', style: 'link', height: 'sm', color: '#64748b', action: { type: 'message', label: 'ดูตารางวันนี้', text: 'ตารางวันนี้' } });

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: color, spacing: 'sm',
      contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            {
              type: 'box', layout: 'vertical', flex: 0, paddingStart: '10px', paddingEnd: '10px', paddingTop: '3px', paddingBottom: '3px',
              cornerRadius: '20px', backgroundColor: '#ffffff33',
              contents: [{ type: 'text', text: minutesBefore != null ? `⏰ ${minutesLabel(minutesBefore)}` : `📅 ${dateLabel || ''}`, size: 'xs', color: '#ffffff', weight: 'bold' }],
            },
            { type: 'filler' },
            { type: 'text', text: trim(group ? group.name : settings.appName || 'ตารางสอน', 30), size: group ? 'sm' : 'xs', weight: group ? 'bold' : 'regular', color: group ? '#ffffff' : '#ffffffcc', align: 'end', gravity: 'center', flex: 0 },
          ],
        },
        { type: 'text', text: trim(cls.subject, 80), size: 'xl', weight: 'bold', color: '#ffffff', wrap: true, margin: 'md' },
        ...(cls.code ? [{ type: 'text', text: trim(cls.code, 60), size: 'sm', color: '#ffffffcc' }] : []),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', paddingTop: '0px', contents: footer },
    styles: { footer: { separator: false } },
  };
}

function reminderMessage(cls, room, minutesBefore, settings, group) {
  const where = room ? ` ที่ ${room.name}` : '';
  return {
    type: 'flex',
    altText: trim(`⏰ ${group ? `${group.name} · ` : ''}${minutesLabel(minutesBefore)} เรียน ${cls.subject}${where} (${cls.start} น.)`, 400),
    contents: classBubble(cls, room, { minutesBefore, settings, group }),
  };
}

function dayHeader(weekday, title, subtitle) {
  const bg = cal.DAY_COLORS[weekday], fg = cal.DAY_TEXT[weekday];
  return {
    type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: bg, contents: [
      { type: 'text', text: trim(title, 60), color: fg, weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: trim(subtitle, 120), color: fg === '#ffffff' ? '#ffffffcc' : '#3b2f00cc', size: 'xs', wrap: true },
    ],
  };
}

/** bubble ตารางของวันหนึ่ง (หัวสีตามวัน) */
function dayScheduleBubble(classes, rooms, weekday, settings, title, subtitle) {
  const sub = subtitle || `วัน${DAY_NAMES[weekday]}`;
  if (!classes.length) {
    return {
      type: 'bubble', size: 'kilo',
      header: dayHeader(weekday, title, sub),
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'sm', contents: [
          { type: 'text', text: '🎉', size: 'xxl', align: 'center' },
          { type: 'text', text: 'ไม่มีคาบเรียน', size: 'sm', align: 'center', color: '#64748b' },
        ],
      },
    };
  }
  const accent = hex(settings.accentColor);
  const items = classes.slice(0, 20).map((c) => {
    const room = rooms.find((r) => r.id === c.roomId);
    const color = hex(c.color, accent);
    const box = {
      type: 'box', layout: 'horizontal', spacing: 'md', paddingAll: '10px', cornerRadius: '10px', backgroundColor: tint(color, 0.9),
      contents: [
        { type: 'box', layout: 'vertical', width: '4px', backgroundColor: color, cornerRadius: '2px', contents: [{ type: 'filler' }] },
        {
          type: 'box', layout: 'vertical', flex: 2, contents: [
            { type: 'text', text: c.start, size: 'sm', weight: 'bold', color },
            { type: 'text', text: c.end, size: 'xs', color: '#94a3b8' },
          ],
        },
        {
          type: 'box', layout: 'vertical', flex: 6, contents: [
            { type: 'text', text: trim(c.subject, 60), size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
            { type: 'text', text: `📍 ${room ? trim(room.name, 60) : '-'}${navUrl(room) ? '  ›' : ''}`, size: 'xs', color: '#64748b', wrap: true },
          ],
        },
      ],
    };
    if (navUrl(room)) box.action = { type: 'uri', label: 'นำทาง', uri: navUrl(room) };
    return box;
  });
  return {
    type: 'bubble', size: 'mega',
    header: dayHeader(weekday, title, `${sub} · ${classes.length} คาบ · แตะเพื่อนำทาง`),
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: items },
  };
}

function dayScheduleMessage(classes, rooms, weekday, settings, title, subtitle) {
  return {
    type: 'flex',
    altText: trim(`${title}: ${classes.length ? `${classes.length} คาบ` : 'ไม่มีคาบเรียน'}`, 400),
    contents: dayScheduleBubble(classes, rooms, weekday, settings, title, subtitle),
  };
}

/** ตารางทั้งสัปดาห์ (carousel วันละ 1 bubble) */
function weekScheduleMessage(byDay, rooms, settings, groupName) {
  const bubbles = byDay.slice(0, 12).map(({ weekday, classes }) => dayScheduleBubble(classes, rooms, weekday, settings, `วัน${DAY_NAMES[weekday]}`, groupName || 'ตารางเรียน'));
  return { type: 'flex', altText: `ตารางเรียนทั้งสัปดาห์${groupName ? ` ${groupName}` : ''}`, contents: { type: 'carousel', contents: bubbles } };
}

/** แจ้งวันพิเศษ: mode = today | tomorrow | ask (ถามตารางในวันพิเศษ) */
function specialDayBubble(sd, dateKey, db, mode = 'today') {
  const t = cal.typeInfo(sd.type);
  const total = cal.daysBetween(sd.start, sd.end) + 1;
  const nth = cal.daysBetween(sd.start, dateKey) + 1;
  const reopen = cal.nextSchoolDay(db, sd.end);
  const suspended = sd.suspendClasses !== false;
  const headline = mode === 'tomorrow'
    ? (suspended ? 'พรุ่งนี้หยุดเรียน' : `พรุ่งนี้${t.label}`)
    : (suspended ? 'วันนี้หยุดเรียน' : `วันนี้${t.label}`);
  const rows = [
    row('📅', 'วันที่', cal.thaiDate(dateKey, { weekday: true })),
    row('🗓️', 'ช่วง', `${cal.thaiRange(sd.start, sd.end)}${total > 1 ? ` (${total} วัน)` : ''}`),
  ];
  if (total > 1 && mode !== 'tomorrow' && nth >= 1) rows.push(row('⏳', 'วันที่', `${nth} จาก ${total} วัน`));
  if (suspended && reopen) rows.push(row('🏫', 'เปิดเรียน', cal.thaiDate(reopen, { weekday: true }), t.color));
  if (sd.note) {
    rows.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
    rows.push({ type: 'text', text: `📝 ${trim(sd.note, 400)}`, size: 'sm', color: '#334155', wrap: true, margin: 'lg' });
  }
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: t.color, spacing: 'sm', contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            {
              type: 'box', layout: 'vertical', flex: 0, paddingStart: '10px', paddingEnd: '10px', paddingTop: '3px', paddingBottom: '3px',
              cornerRadius: '20px', backgroundColor: '#ffffff33',
              contents: [{ type: 'text', text: `${mode === 'tomorrow' ? '🔔' : '📢'} ${t.label}`, size: 'xs', color: '#ffffff', weight: 'bold' }],
            },
            { type: 'filler' },
            { type: 'text', text: trim(db.settings.schoolName || db.settings.appName || 'ตารางสอน', 30), size: 'xs', color: '#ffffffcc', align: 'end', gravity: 'center', flex: 0 },
          ],
        },
        { type: 'text', text: headline, size: 'sm', color: '#ffffffdd', margin: 'md' },
        { type: 'text', text: trim(sd.name, 80), size: 'xl', weight: 'bold', color: '#ffffff', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', contents: rows },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '0px', contents: [
        { type: 'button', style: 'link', height: 'sm', color: t.color, action: { type: 'message', label: 'ดูวันหยุดทั้งหมด', text: 'วันหยุด' } },
      ],
    },
    styles: { footer: { separator: false } },
  };
}
function specialDayMessage(sd, dateKey, db, mode = 'today') {
  const t = cal.typeInfo(sd.type);
  const when = mode === 'tomorrow' ? 'พรุ่งนี้' : 'วันนี้';
  const verb = sd.suspendClasses !== false ? 'หยุดเรียน' : t.label;
  return { type: 'flex', altText: trim(`📢 ${when}${verb}: ${sd.name} (${cal.thaiRange(sd.start, sd.end)})`, 400), contents: specialDayBubble(sd, dateKey, db, mode) };
}

/** รายการวันพิเศษที่จะมาถึง */
function upcomingSpecialMessage(list, db, todayKey) {
  const accent = hex(db.settings.accentColor);
  const items = list.length ? list.map((sd) => {
    const t = cal.typeInfo(sd.type);
    const now = sd.start <= todayKey && todayKey <= sd.end;
    return {
      type: 'box', layout: 'horizontal', spacing: 'md', paddingAll: '10px', cornerRadius: '10px', backgroundColor: tint(t.color, 0.9),
      contents: [
        { type: 'box', layout: 'vertical', width: '4px', backgroundColor: t.color, cornerRadius: '2px', contents: [{ type: 'filler' }] },
        {
          type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: `${now ? '● ตอนนี้ · ' : ''}${t.label}`, size: 'xxs', color: t.color, weight: 'bold' },
            { type: 'text', text: trim(sd.name, 60), size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
            { type: 'text', text: cal.thaiRange(sd.start, sd.end), size: 'xs', color: '#64748b' },
          ],
        },
      ],
    };
  }) : [{ type: 'text', text: 'ยังไม่มีวันหยุดหรือกิจกรรมที่จะมาถึง', size: 'sm', color: '#64748b', wrap: true, align: 'center' }];
  return {
    type: 'flex', altText: 'วันหยุดและกิจกรรมที่จะมาถึง',
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: accent, contents: [
          { type: 'text', text: 'วันหยุดและกิจกรรม', color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: 'หยุดทั้งโรงเรียน', color: '#ffffffcc', size: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: items },
    },
  };
}

module.exports = {
  creds, call, verifySignature, send, reply, botInfo, profile, groupSummary, multicast, push, broadcast, richMenu,
  navUrl, classBubble, reminderMessage, dayScheduleMessage, dayScheduleBubble, weekScheduleMessage,
  specialDayMessage, upcomingSpecialMessage, minutesLabel,
};

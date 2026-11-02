'use strict';
// LINE Messaging API: ส่งข้อความ, ตรวจลายเซ็น webhook และสร้าง Flex Message
const crypto = require('crypto');
const { DAY_NAMES } = require('./time');

const API = 'https://api.line.me/v2/bot';

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
function classBubble(cls, room, { minutesBefore, settings, dateLabel }) {
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
            { type: 'text', text: trim(settings.appName || 'ตารางสอน', 30), size: 'xs', color: '#ffffffcc', align: 'end', gravity: 'center', flex: 0 },
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

function reminderMessage(cls, room, minutesBefore, settings) {
  const where = room ? ` ที่ ${room.name}` : '';
  return {
    type: 'flex',
    altText: trim(`⏰ ${minutesLabel(minutesBefore)} เรียน ${cls.subject}${where} (${cls.start} น.)`, 400),
    contents: classBubble(cls, room, { minutesBefore, settings }),
  };
}

/** สรุปตารางของวัน (carousel ไม่เกิน 12 bubble) */
function dayScheduleMessage(classes, rooms, weekday, settings, title) {
  const accent = hex(settings.accentColor);
  if (!classes.length) {
    return {
      type: 'flex', altText: `${title}: ไม่มีคาบเรียน`,
      contents: {
        type: 'bubble', size: 'kilo',
        body: {
          type: 'box', layout: 'vertical', paddingAll: '24px', spacing: 'md', contents: [
            { type: 'text', text: '🎉', size: '3xl', align: 'center' },
            { type: 'text', text: title, weight: 'bold', size: 'lg', align: 'center', color: accent },
            { type: 'text', text: `วัน${DAY_NAMES[weekday]}ไม่มีคาบเรียน`, size: 'sm', align: 'center', color: '#64748b' },
          ],
        },
      },
    };
  }
  const items = classes.slice(0, 20).map((c) => {
    const room = rooms.find((r) => r.id === c.roomId);
    const color = hex(c.color, accent);
    return {
      type: 'box', layout: 'horizontal', spacing: 'md', paddingAll: '10px', cornerRadius: '10px', backgroundColor: tint(color, 0.9),
      action: navUrl(room) ? { type: 'uri', label: 'นำทาง', uri: navUrl(room) } : undefined,
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
            { type: 'text', text: `📍 ${room ? room.name : '-'}${navUrl(room) ? '  ›' : ''}`, size: 'xs', color: '#64748b', wrap: true },
          ],
        },
      ],
    };
  });

  return {
    type: 'flex', altText: `${title}: ${classes.length} คาบ`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: accent, contents: [
          { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: `วัน${DAY_NAMES[weekday]} · ${classes.length} คาบ · แตะเพื่อนำทาง`, color: '#ffffffcc', size: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: items },
    },
  };
}

module.exports = { creds, call, verifySignature, send, reply, botInfo, profile, groupSummary, navUrl, classBubble, reminderMessage, dayScheduleMessage, minutesLabel };

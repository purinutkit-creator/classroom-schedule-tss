'use strict';
// ริชเมนูรายวัน: สร้างรูปใหม่ทุกวันตามชั้น/ห้อง สีตามวัน มีวันที่ ชื่อวัน และแจ้ง "พรุ่งนี้หยุด"
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const line = require('./line');
const cal = require('./calendar');
const { DAY_NAMES, localParts, dateKey, toMin } = require('./time');

const W = 2500, H = 1686;
const HEADER = 560, STRIP = 150, GRID_TOP = HEADER + STRIP;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONTS = ['Prompt-Regular.ttf', 'Prompt-SemiBold.ttf', 'Prompt-Bold.ttf'].map((f) => path.join(FONT_DIR, f));
const DEFAULT_KEY = '_default';

const BUTTONS = [
  { label: 'ตารางวันนี้', text: 'ตารางวันนี้', icon: 'today' },
  { label: 'ตารางพรุ่งนี้', text: 'ตารางพรุ่งนี้', icon: 'tomorrow' },
  { label: 'คาบถัดไป', text: 'คาบถัดไป', icon: 'next' },
  { label: 'ทั้งสัปดาห์', text: 'ตารางทั้งสัปดาห์', icon: 'week' },
  { label: 'วันหยุด', text: 'วันหยุด', icon: 'flag' },
  { label: 'ห้องของฉัน', text: 'ห้องของฉัน', icon: 'me' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// ประมาณความกว้างข้อความ (สระบน-ล่าง/วรรณยุกต์ไทยไม่กินที่)
function textWidth(s, size) {
  const chars = [...String(s)].filter((c) => !/[ัิ-ฺ็-๎]/.test(c));
  return chars.reduce((w, c) => w + (/[฀-๿]/.test(c) ? 0.6 : /[A-Z0-9]/.test(c) ? 0.66 : 0.52), 0) * size;
}
function fit(s, size, max) {
  let t = String(s);
  while (t.length > 1 && textWidth(t, size) > max) t = t.slice(0, -1);
  return t === String(s) ? t : t.slice(0, -1) + '…';
}
function mix(hex, ratio, to = 255) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (to - v) * ratio);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}

function shortDate(key) {
  const d = cal.parseKey(key);
  return `${d.getUTCDate()} ${cal.MONTHS_SHORT[d.getUTCMonth()]}`;
}

function icon(kind, cx, cy, color) {
  const s = `stroke="${color}" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case 'today': return `<rect x="${cx - 44}" y="${cy - 36}" width="88" height="80" rx="12" ${s}/><path d="M${cx - 44} ${cy - 10}h88M${cx - 22} ${cy - 52}v28M${cx + 22} ${cy - 52}v28" ${s}/><circle cx="${cx}" cy="${cy + 16}" r="9" fill="${color}"/>`;
    case 'tomorrow': return `<circle cx="${cx}" cy="${cy}" r="46" ${s}/><path d="M${cx} ${cy - 24}v26l18 14" ${s}/>`;
    case 'next': return `<path d="M${cx - 40} ${cy}h70M${cx + 6} ${cy - 30}l30 30-30 30" ${s}/>`;
    case 'week': return [-30, 0, 30].flatMap((dy) => [-30, 0, 30].map((dx) => `<rect x="${cx + dx - 11}" y="${cy + dy - 11}" width="22" height="22" rx="5" fill="${color}"/>`)).join('');
    case 'flag': return `<path d="M${cx - 32} ${cy + 50}v-100M${cx - 32} ${cy - 46}h62l-14 26 14 26h-62" ${s}/>`;
    default: return `<circle cx="${cx}" cy="${cy - 18}" r="22" ${s}/><path d="M${cx - 42} ${cy + 46}c6-30 24-42 42-42s36 12 42 42" ${s}/>`;
  }
}

/** ข้อมูลที่ใช้วาดเมนูของชั้น/ห้องหนึ่งในวันหนึ่ง */
function menuInfo(db, groupId, todayKey) {
  const weekday = cal.weekdayOf(todayKey);
  const tomorrowKey = cal.shiftKey(todayKey, 1);
  const group = db.groups.find((g) => g.id === groupId) || null;
  // คาบของห้องนี้ + คาบที่ใช้ร่วมทุกห้อง (เหมือนที่ตอบใน LINE)
  const classesOf = (wd) => db.classes.filter((c) => c.day === wd && (!c.groupId || c.groupId === groupId)).sort((a, b) => toMin(a.start) - toMin(b.start));
  const today = cal.isSuspended(db, todayKey) ? [] : classesOf(weekday);
  const tomorrow = cal.isSuspended(db, tomorrowKey) ? [] : classesOf(cal.weekdayOf(tomorrowKey));
  const nextSpecial = cal.upcoming(db, todayKey, 1)[0] || null;
  return {
    weekday, todayKey, tomorrowKey, group,
    specialToday: cal.specialOn(db, todayKey),
    specialTomorrow: cal.specialOn(db, tomorrowKey),
    today, tomorrow, nextSpecial,
    title: db.settings.schoolName || db.settings.appName || 'ตารางสอน',
  };
}

function buildSvg(db, groupId, todayKey) {
  const i = menuInfo(db, groupId, todayKey);
  const bg = cal.DAY_COLORS[i.weekday], fg = cal.DAY_TEXT[i.weekday];
  const dark = mix(bg, 0.35, 0);
  const d = cal.parseKey(todayKey);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Prompt">`);
  out.push(`<rect width="${W}" height="${H}" fill="#f3f4f8"/>`);
  // ส่วนหัว: สีประจำวัน
  out.push(`<rect width="${W}" height="${HEADER}" fill="${bg}"/>`);
  out.push(`<circle cx="${W - 160}" cy="-60" r="420" fill="#ffffff" opacity="0.12"/><circle cx="1500" cy="${HEADER + 120}" r="260" fill="#ffffff" opacity="0.08"/>`);
  out.push(`<text x="120" y="150" font-size="62" font-weight="600" fill="${fg}" opacity="0.85">${esc(fit(i.title, 62, 1250))}</text>`);
  out.push(`<text x="112" y="325" font-size="180" font-weight="700" fill="${fg}">วัน${DAY_NAMES[i.weekday]}</text>`);
  out.push(`<text x="120" y="478" font-size="86" font-weight="400" fill="${fg}">${esc(cal.thaiDate(todayKey))}</text>`);
  // ป้ายชั้น/ห้อง
  const gname = i.group ? i.group.name : 'ทุกชั้นเรียน';
  const gsize = 84, gw = Math.min(760, textWidth(gname, gsize) + 110);
  out.push(`<rect x="${1910 - gw}" y="96" width="${gw}" height="140" rx="70" fill="#ffffff" opacity="0.94"/>`);
  out.push(`<text x="${1910 - gw / 2}" y="194" font-size="${gsize}" font-weight="700" fill="${dark}" text-anchor="middle">${esc(fit(gname, gsize, gw - 70))}</text>`);
  // ปฏิทินเล็ก
  out.push(`<rect x="1990" y="96" width="390" height="390" rx="56" fill="#ffffff"/>`);
  out.push(`<path d="M1990 152a56 56 0 0 1 56-56h278a56 56 0 0 1 56 56v58h-390z" fill="${dark}"/>`);
  out.push(`<text x="2185" y="190" font-size="62" font-weight="600" fill="#ffffff" text-anchor="middle">${cal.MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}</text>`);
  out.push(`<text x="2185" y="430" font-size="220" font-weight="700" fill="${dark}" text-anchor="middle">${d.getUTCDate()}</text>`);

  // แถบแจ้งเตือน
  let stripBg = '#ffffff', stripFg = '#1e2235', msg;
  if (i.specialToday) {
    const t = cal.typeInfo(i.specialToday.type);
    const reopen = cal.nextSchoolDay(db, i.specialToday.end);
    stripBg = t.color; stripFg = '#ffffff';
    msg = `${i.specialToday.suspendClasses !== false ? 'วันนี้หยุดเรียน' : `วันนี้${t.label}`}: ${i.specialToday.name}${reopen && i.specialToday.suspendClasses !== false ? ` · เปิดเรียน ${cal.thaiDate(reopen, { short: true })}` : ''}`;
  } else if (i.specialTomorrow) {
    const t = cal.typeInfo(i.specialTomorrow.type);
    stripBg = t.color; stripFg = '#ffffff';
    msg = `${i.specialTomorrow.suspendClasses !== false ? 'พรุ่งนี้หยุด' : `พรุ่งนี้${t.label}`}: ${i.specialTomorrow.name} (${cal.thaiRange(i.specialTomorrow.start, i.specialTomorrow.end)})`;
  } else {
    msg = i.today.length ? `วันนี้มี ${i.today.length} คาบ · เริ่ม ${i.today[0].start} น. · เลิก ${i.today[i.today.length - 1].end} น.` : 'วันนี้ไม่มีคาบเรียน';
  }
  out.push(`<rect y="${HEADER}" width="${W}" height="${STRIP}" fill="${stripBg}"/>`);
  out.push(`<circle cx="150" cy="${HEADER + STRIP / 2}" r="26" fill="${stripBg === '#ffffff' ? bg : '#ffffff'}"/>`);
  out.push(`<text x="210" y="${HEADER + STRIP / 2 + 26}" font-size="70" font-weight="600" fill="${stripFg}">${esc(fit(msg, 70, W - 300))}</text>`);

  // ปุ่ม 2 แถว × 3 คอลัมน์
  const subs = [
    i.specialToday && i.specialToday.suspendClasses !== false ? 'วันนี้หยุด' : i.today.length ? `${i.today.length} คาบ` : 'ไม่มีคาบเรียน',
    i.specialTomorrow && i.specialTomorrow.suspendClasses !== false ? 'พรุ่งนี้หยุด' : `${shortDate(i.tomorrowKey)} · ${i.tomorrow.length ? `${i.tomorrow.length} คาบ` : 'ไม่มีคาบ'}`,
    'พร้อมปุ่มนำทาง',
    'ดูทุกวัน',
    i.nextSpecial ? `${shortDate(i.nextSpecial.start)} ${i.nextSpecial.name}` : 'และวันกิจกรรม',
    i.group ? i.group.name : 'ยังไม่ระบุห้อง',
  ];
  const pad = 40, gap = 28, cw = (W - pad * 2 - gap * 2) / 3, ch = (H - GRID_TOP - pad * 2 - gap) / 2;
  const iconBg = mix(bg, 0.82), iconFg = i.weekday === 1 ? '#8a6d00' : bg;
  BUTTONS.forEach((b, k) => {
    const x = pad + (k % 3) * (cw + gap), y = GRID_TOP + pad + Math.floor(k / 3) * (ch + gap);
    out.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="44" fill="#ffffff"/>`);
    out.push(`<circle cx="${x + 150}" cy="${y + ch / 2}" r="92" fill="${iconBg}"/>`);
    out.push(icon(b.icon, x + 150, y + ch / 2, iconFg));
    out.push(`<text x="${x + 285}" y="${y + ch / 2 - 4}" font-size="76" font-weight="700" fill="#1e2235">${esc(fit(b.label, 76, cw - 320))}</text>`);
    out.push(`<text x="${x + 287}" y="${y + ch / 2 + 74}" font-size="46" font-weight="400" fill="#6b7290">${esc(fit(subs[k], 46, cw - 320))}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}

function render(svg) {
  return new Resvg(svg, { fitTo: { mode: 'original' }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Prompt' } }).render().asPng();
}

function menuDefinition(db, groupId, todayKey) {
  const d = cal.parseKey(todayKey);
  const group = db.groups.find((g) => g.id === groupId);
  const cw = Math.floor(W / 3), rh = Math.floor((H - GRID_TOP) / 2);
  const areas = [{ bounds: { x: 0, y: 0, width: W, height: GRID_TOP }, action: { type: 'message', label: 'ตารางวันนี้', text: 'ตารางวันนี้' } }];
  BUTTONS.forEach((b, k) => {
    const col = k % 3, rowI = Math.floor(k / 3);
    areas.push({
      bounds: { x: col * cw, y: GRID_TOP + rowI * rh, width: col === 2 ? W - 2 * cw : cw, height: rowI === 1 ? H - GRID_TOP - rh : rh },
      action: { type: 'message', label: b.label.slice(0, 20), text: b.text },
    });
  });
  return {
    size: { width: W, height: H },
    selected: db.settings.richMenu?.selected !== false,
    name: `classroom ${todayKey} ${group ? group.name : 'default'}`.slice(0, 300),
    chatBarText: `เมนู ${d.getUTCDate()} ${cal.MONTHS_SHORT[d.getUTCMonth()]}`.slice(0, 14),
    areas,
  };
}

function todayKeyOf(db, now = new Date()) {
  return dateKey(localParts(now, db.settings.timezone || 'Asia/Bangkok'));
}

function preview(db, groupId, key) {
  return render(buildSvg(db, groupId || null, key || todayKeyOf(db)));
}

/** สร้างริชเมนูใหม่ของวันนี้ให้ทุกชั้น/ห้อง แล้วผูกกับผู้ใช้ และลบเมนูเก่า */
async function rebuild(db) {
  const { settings } = db;
  const rm = settings.richMenu;
  const key = todayKeyOf(db);
  const targets = [null, ...db.groups.map((g) => g.id)];
  const created = {};
  try {
    for (const gid of targets) {
      const png = render(buildSvg(db, gid, key));
      if (png.length > 1024 * 1024) throw new Error(`รูปริชเมนูใหญ่เกิน 1MB (${png.length} bytes)`);
      const { richMenuId } = await line.richMenu.create(settings, menuDefinition(db, gid, key));
      created[gid || DEFAULT_KEY] = richMenuId;
      await line.richMenu.upload(settings, richMenuId, png);
    }
    await line.richMenu.setDefault(settings, created[DEFAULT_KEY]);
    let linked = 0;
    for (const g of db.groups) {
      const users = db.recipients.filter((r) => r.type === 'user' && r.groupId === g.id && r.enabled !== false && !r.left).map((r) => r.id);
      if (users.length) { await line.richMenu.bulkLink(settings, created[g.id], users); linked += users.length; }
    }
    const old = Object.values(rm.menus || {}).filter((id) => !Object.values(created).includes(id));
    for (const id of old) { try { await line.richMenu.remove(settings, id); } catch { /* ลบไปแล้ว */ } }
    rm.menus = created;
    rm.builtFor = key;
    rm.builtAt = new Date().toISOString();
    rm.lastError = null;
    rm.failedAt = null;
    rm.dirtyAt = null;
    rm.linked = linked;
    console.log(`[richmenu] สร้างริชเมนู ${targets.length} ชุดของวันที่ ${key} และผูกผู้ใช้ ${linked} คน`);
    return { menus: targets.length, linked, date: key };
  } catch (e) {
    for (const id of Object.values(created)) { try { await line.richMenu.remove(settings, id); } catch { /* ignore */ } }
    rm.lastError = e.message;
    rm.failedAt = Date.now();
    console.error('[richmenu] สร้างไม่สำเร็จ:', e.message);
    throw e;
  }
}

/** ผูกผู้ใช้คนเดียวกับเมนูของชั้น/ห้อง (ไม่มีห้อง → ใช้เมนูค่าเริ่มต้น) */
async function linkRecipient(db, r) {
  const rm = db.settings.richMenu;
  if (!rm?.enabled || r.type !== 'user' || !line.creds(db.settings).token) return;
  const id = r.groupId && rm.menus ? rm.menus[r.groupId] : null;
  if (id) await line.richMenu.linkUser(db.settings, r.id, id);
  else { try { await line.richMenu.unlinkUser(db.settings, r.id); } catch { /* ไม่ได้ผูกไว้ */ } }
}

/** ลบริชเมนูทั้งหมดที่ระบบสร้าง (ตอนปิดฟีเจอร์) */
async function removeAll(db) {
  const rm = db.settings.richMenu;
  try { await line.richMenu.clearDefault(db.settings); } catch { /* ignore */ }
  for (const id of Object.values(rm.menus || {})) { try { await line.richMenu.remove(db.settings, id); } catch { /* ignore */ } }
  rm.menus = {};
  rm.builtFor = null;
}

module.exports = { W, H, BUTTONS, buildSvg, render, preview, menuDefinition, menuInfo, rebuild, linkRecipient, removeAll, todayKeyOf, textWidth };

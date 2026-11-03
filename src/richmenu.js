'use strict';
// ริชเมนูรายวัน: สร้างรูปใหม่ทุกวันตามชั้น/ห้อง พร้อมวันที่ ชื่อวัน และแจ้ง "พรุ่งนี้หยุด"
// แอดมินออกแบบได้: รูปแบบ (layout) สี รูปโลโก้/พื้นหลัง ฟอนต์ และปุ่ม
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const jpeg = require('jpeg-js');
const line = require('./line');
const cal = require('./calendar');
const store = require('./store');
const { DAY_NAMES, localParts, dateKey, toMin } = require('./time');

const W = 2500;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const BUNDLED = ['Prompt-Regular.ttf', 'Prompt-SemiBold.ttf', 'Prompt-Bold.ttf'].map((f) => path.join(FONT_DIR, f));
const DEFAULT_KEY = '_default';
const MAX_BYTES = 1024 * 1024;

// ---------------- ปุ่มที่เลือกได้ ----------------
const ACTIONS = {
  today: { label: 'ตารางวันนี้', text: 'ตารางวันนี้', icon: 'today' },
  tomorrow: { label: 'ตารางพรุ่งนี้', text: 'ตารางพรุ่งนี้', icon: 'tomorrow' },
  next: { label: 'คาบถัดไป', text: 'คาบถัดไป', icon: 'next' },
  week: { label: 'ทั้งสัปดาห์', text: 'ตารางทั้งสัปดาห์', icon: 'week' },
  holiday: { label: 'วันหยุด', text: 'วันหยุด', icon: 'flag' },
  me: { label: 'ห้องของฉัน', text: 'ห้องของฉัน', icon: 'me' },
  code: { label: 'รหัสสมาชิก', text: 'รหัส', icon: 'key' },
  link: { label: 'เว็บไซต์', text: '', icon: 'link' },
};

// ---------------- รูปแบบ (layout) ----------------
const LAYOUTS = {
  grid6: { name: 'ใหญ่ · 6 ปุ่ม', h: 1686, slots: 6 },
  grid4: { name: 'ใหญ่ · 4 ปุ่ม', h: 1686, slots: 4 },
  compact3: { name: 'ครึ่งจอ · 3 ปุ่ม', h: 843, slots: 3 },
  banner4: { name: 'ครึ่งจอ · หัวซ้าย 4 ปุ่ม', h: 843, slots: 4 },
};

const DEFAULT_DESIGN = () => ({
  layout: 'grid6',
  colorMode: 'day', // day = สีตามวันแบบไทย, custom = สีที่ตั้งเอง
  colors: { header: '#4f46e5', headerText: '#ffffff', accent: '#4f46e5', page: '#f3f4f8', button: '#ffffff', buttonText: '#1e2235', subText: '#6b7290' },
  font: { source: 'bundled', family: 'Prompt', customFontId: null },
  title: '',
  logoFile: null,
  bgFile: null,
  bgOverlay: 0.45,
  radius: 44,
  showTitle: true,
  showCalendar: true,
  showGroup: true,
  showStrip: true,
  showIcons: true,
  memberCode: 'all',
  buttons: [
    { action: 'today', label: '' }, { action: 'tomorrow', label: '' }, { action: 'next', label: '' },
    { action: 'week', label: '' }, { action: 'holiday', label: '' }, { action: 'me', label: '' },
  ],
});

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);

/** ตรวจและเติมค่าการออกแบบให้ครบ (ใช้ทั้งตอนบันทึกและตอนวาด) */
function normalizeDesign(input) {
  const d = DEFAULT_DESIGN();
  const x = input && typeof input === 'object' ? input : {};
  const colors = { ...d.colors };
  for (const k of Object.keys(colors)) if (HEX.test(x.colors?.[k] || '')) colors[k] = x.colors[k];
  const font = { ...d.font };
  if (['bundled', 'google', 'custom'].includes(x.font?.source)) font.source = x.font.source;
  if (typeof x.font?.family === 'string' && x.font.family.trim()) font.family = x.font.family.trim().replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 60) || 'Prompt';
  if (typeof x.font?.customFontId === 'string') font.customFontId = x.font.customFontId;
  if (font.source === 'bundled') font.family = 'Prompt';
  const layout = LAYOUTS[x.layout] ? x.layout : d.layout;
  const slots = LAYOUTS[layout].slots;
  const src = Array.isArray(x.buttons) ? x.buttons : d.buttons;
  const buttons = [];
  for (let i = 0; i < slots; i++) {
    const b = src[i] || d.buttons[i] || { action: 'today' };
    const action = ACTIONS[b.action] ? b.action : 'today';
    const url = typeof b.url === 'string' && /^https:\/\/\S+$/i.test(b.url.trim()) ? b.url.trim().slice(0, 1000) : '';
    buttons.push({ action: action === 'link' && !url ? 'today' : action, label: String(b.label || '').trim().slice(0, 20), sub: String(b.sub || '').trim().slice(0, 40), url });
  }
  const file = (f) => (typeof f === 'string' && /^img-[a-z0-9]+\.(png|jpe?g)$/i.test(f) ? f : null);
  return {
    layout,
    colorMode: x.colorMode === 'custom' ? 'custom' : 'day',
    colors, font,
    title: String(x.title ?? '').trim().slice(0, 60),
    logoFile: file(x.logoFile),
    bgFile: file(x.bgFile),
    bgOverlay: clamp(x.bgOverlay, 0, 1, d.bgOverlay),
    radius: Math.round(clamp(x.radius, 0, 90, d.radius)),
    showTitle: x.showTitle !== false,
    showCalendar: x.showCalendar !== false,
    showGroup: x.showGroup !== false,
    showStrip: x.showStrip !== false,
    showIcons: x.showIcons !== false,
    // รหัสสมาชิกบนริชเมนูของแต่ละคน: all = ทุกคน, unassigned = เฉพาะคนที่ยังไม่เข้าห้อง, off = ไม่แสดง
    memberCode: ['all', 'unassigned', 'off'].includes(x.memberCode) ? x.memberCode : 'all',
    buttons,
  };
}

// ---------------- ตัวช่วยวาด ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// ประมาณความกว้างข้อความ (สระบน-ล่าง/วรรณยุกต์ไทยไม่กินที่)
function textWidth(s, size) {
  const chars = [...String(s)].filter((c) => !/[ัิ-ฺ็-๎]/.test(c));
  return chars.reduce((w, c) => w + (/[฀-๿]/.test(c) ? 0.6 : /[A-Z0-9]/.test(c) ? 0.66 : 0.52), 0) * size;
}
function fit(s, size, max) {
  let t = String(s);
  if (max <= 0) return '';
  while (t.length > 1 && textWidth(t, size) > max) t = t.slice(0, -1);
  return t === String(s) ? t : t.slice(0, -1) + '…';
}
function mix(hex, ratio, to = 255) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (to - v) * ratio);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function shortDate(key) {
  const d = cal.parseKey(key);
  return `${d.getUTCDate()} ${cal.MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** ป้ายรหัสสมาชิก: คืน { svg, w } — ป้ายชิดขวาที่ตำแหน่ง right */
function codePill(code, { right, y, h, bg, fg, short }) {
  const lsz = h * 0.34, csz = h * 0.56, pad = h * 0.42, gap = h * 0.25, ls = csz * 0.14;
  const label = short ? 'รหัส' : 'รหัสสมาชิก';
  const lw = textWidth(label, lsz) * 1.08;
  const dw = code.length * (csz * 0.6 + ls);
  const w = pad + lw + gap + dw + pad * 0.8;
  const x = right - w;
  const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>`
    + `<text x="${x + pad}" y="${y + h / 2 + lsz * 0.36}" font-size="${lsz}" font-weight="600" fill="${fg}" opacity="0.85">${label}</text>`
    + `<text x="${x + pad + lw + gap}" y="${y + h / 2 + csz * 0.36}" font-size="${csz}" font-weight="700" fill="${fg}" letter-spacing="${ls}">${code}</text>`;
  return { svg, w };
}

function icon(kind, cx, cy, color, k = 1) {
  const s = `stroke="${color}" stroke-width="${12 * k}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  const p = (n) => n * k;
  switch (kind) {
    case 'today': return `<rect x="${cx - p(44)}" y="${cy - p(36)}" width="${p(88)}" height="${p(80)}" rx="${p(12)}" ${s}/><path d="M${cx - p(44)} ${cy - p(10)}h${p(88)}M${cx - p(22)} ${cy - p(52)}v${p(28)}M${cx + p(22)} ${cy - p(52)}v${p(28)}" ${s}/><circle cx="${cx}" cy="${cy + p(16)}" r="${p(9)}" fill="${color}"/>`;
    case 'tomorrow': return `<circle cx="${cx}" cy="${cy}" r="${p(46)}" ${s}/><path d="M${cx} ${cy - p(24)}v${p(26)}l${p(18)} ${p(14)}" ${s}/>`;
    case 'next': return `<path d="M${cx - p(40)} ${cy}h${p(70)}M${cx + p(6)} ${cy - p(30)}l${p(30)} ${p(30)}-${p(30)} ${p(30)}" ${s}/>`;
    case 'week': return [-30, 0, 30].flatMap((dy) => [-30, 0, 30].map((dx) => `<rect x="${cx + p(dx - 11)}" y="${cy + p(dy - 11)}" width="${p(22)}" height="${p(22)}" rx="${p(5)}" fill="${color}"/>`)).join('');
    case 'flag': return `<path d="M${cx - p(32)} ${cy + p(50)}v-${p(100)}M${cx - p(32)} ${cy - p(46)}h${p(62)}l-${p(14)} ${p(26)} ${p(14)} ${p(26)}h-${p(62)}" ${s}/>`;
    case 'key': return `<circle cx="${cx - p(18)}" cy="${cy}" r="${p(26)}" ${s}/><path d="M${cx + p(8)} ${cy}h${p(44)}M${cx + p(36)} ${cy}v${p(22)}M${cx + p(50)} ${cy}v${p(16)}" ${s}/>`;
    case 'link': return `<path d="M${cx - p(6)} ${cy + p(14)}l${p(20)}-${p(20)}M${cx - p(14)} ${cy - p(6)}l-${p(14)} ${p(14)}a${p(20)} ${p(20)} 0 0 0 ${p(28)} ${p(28)}l${p(14)}-${p(14)}M${cx + p(14)} ${cy + p(6)}l${p(14)}-${p(14)}a${p(20)} ${p(20)} 0 0 0-${p(28)}-${p(28)}l-${p(14)} ${p(14)}" ${s}/>`;
    default: return `<circle cx="${cx}" cy="${cy - p(18)}" r="${p(22)}" ${s}/><path d="M${cx - p(42)} ${cy + p(46)}c${p(6)}-${p(30)} ${p(24)}-${p(42)} ${p(42)}-${p(42)}s${p(36)} ${p(12)} ${p(42)} ${p(42)}" ${s}/>`;
  }
}

// ---------------- รูปภาพ (โลโก้/พื้นหลัง) ----------------
const imgCache = new Map();
function imageDataUri(file) {
  if (!file) return null;
  if (imgCache.has(file)) return imgCache.get(file);
  const p = path.join(store.FONT_DIR, path.basename(file));
  if (!fs.existsSync(p)) return null;
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  const uri = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  imgCache.set(file, uri);
  return uri;
}
function forgetImage(file) { imgCache.delete(file); }

// ---------------- ฟอนต์ ----------------
const googleFontFiles = new Map(); // family -> [paths]
/** ดาวน์โหลดไฟล์ TTF ของ Google Font มาเก็บไว้ (ครั้งเดียว) */
async function ensureGoogleFont(family) {
  if (googleFontFiles.has(family)) return googleFontFiles.get(family);
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const local = fs.readdirSync(store.FONT_DIR).filter((f) => f.startsWith(`gf-${slug}-`) && f.endsWith('.ttf'));
  if (local.length) {
    const files = local.map((f) => path.join(store.FONT_DIR, f));
    googleFontFiles.set(family, files);
    return files;
  }
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  let css = '';
  for (const q of [`family=${fam}:wght@400;600;700`, `family=${fam}:wght@400;700`, `family=${fam}`]) {
    // User-Agent แบบง่ายทำให้ Google ส่งไฟล์ .ttf (ไลบรารีวาดรูปไม่รองรับ woff2)
    const res = await fetch(`https://fonts.googleapis.com/css2?${q}`, { headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) { css = await res.text(); break; }
  }
  if (!css) throw new Error(`ไม่พบฟอนต์ "${family}" ใน Google Fonts`);
  const faces = [...css.matchAll(/font-weight:\s*(\d+);[\s\S]*?src:\s*url\(([^)]+\.ttf)\)/g)];
  if (!faces.length) throw new Error(`ดาวน์โหลดฟอนต์ "${family}" ไม่ได้`);
  const files = [];
  for (const [, weight, url] of faces) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    const file = `gf-${slug}-${weight}.ttf`;
    fs.writeFileSync(path.join(store.FONT_DIR, file), Buffer.from(await res.arrayBuffer()));
    await store.persistFont(file).catch(() => {});
    files.push(path.join(store.FONT_DIR, file));
  }
  if (!files.length) throw new Error(`ดาวน์โหลดฟอนต์ "${family}" ไม่ได้`);
  googleFontFiles.set(family, files);
  return files;
}

/** หาฟอนต์ที่ใช้วาด: คืน { family, files } (Prompt อยู่ท้ายเสมอเพื่อรองรับภาษาไทย) */
async function resolveFont(db, design) {
  const f = design.font;
  try {
    if (f.source === 'google' && f.family) return { family: f.family, files: [...await ensureGoogleFont(f.family), ...BUNDLED] };
    if (f.source === 'custom' && f.customFontId) {
      const font = (db.fonts || []).find((x) => x.id === f.customFontId);
      if (font && /\.(ttf|otf)$/i.test(font.file)) {
        const p = path.join(store.FONT_DIR, font.file);
        if (fs.existsSync(p)) return { family: font.family, files: [p, ...BUNDLED] };
      }
      throw new Error('ฟอนต์ที่เลือกใช้กับริชเมนูไม่ได้ (ต้องเป็นไฟล์ .ttf หรือ .otf)');
    }
  } catch (e) {
    return { family: 'Prompt', files: BUNDLED, warning: e.message };
  }
  return { family: 'Prompt', files: BUNDLED };
}

// ---------------- ข้อมูลของเมนู ----------------
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
  };
}

function stripMessage(db, i) {
  if (i.specialToday) {
    const t = cal.typeInfo(i.specialToday.type);
    const reopen = cal.nextSchoolDay(db, i.specialToday.end);
    const off = i.specialToday.suspendClasses !== false;
    return { color: t.color, text: `${off ? 'วันนี้หยุดเรียน' : `วันนี้${t.label}`}: ${i.specialToday.name}${reopen && off ? ` · เปิดเรียน ${cal.thaiDate(reopen, { short: true })}` : ''}` };
  }
  if (i.specialTomorrow) {
    const t = cal.typeInfo(i.specialTomorrow.type);
    const off = i.specialTomorrow.suspendClasses !== false;
    return { color: t.color, text: `${off ? 'พรุ่งนี้หยุด' : `พรุ่งนี้${t.label}`}: ${i.specialTomorrow.name} (${cal.thaiRange(i.specialTomorrow.start, i.specialTomorrow.end)})` };
  }
  return { color: null, text: i.today.length ? `วันนี้มี ${i.today.length} คาบ · เริ่ม ${i.today[0].start} น. · เลิก ${i.today[i.today.length - 1].end} น.` : 'วันนี้ไม่มีคาบเรียน' };
}

function buttonText(b, i, code) {
  const a = ACTIONS[b.action];
  const def = {
    today: i.specialToday && i.specialToday.suspendClasses !== false ? 'วันนี้หยุด' : i.today.length ? `${i.today.length} คาบ` : 'ไม่มีคาบเรียน',
    tomorrow: i.specialTomorrow && i.specialTomorrow.suspendClasses !== false ? 'พรุ่งนี้หยุด' : `${shortDate(i.tomorrowKey)} · ${i.tomorrow.length ? `${i.tomorrow.length} คาบ` : 'ไม่มีคาบ'}`,
    next: 'พร้อมปุ่มนำทาง',
    week: 'ดูทุกวัน',
    holiday: i.nextSpecial ? `${shortDate(i.nextSpecial.start)} ${i.nextSpecial.name}` : 'และวันกิจกรรม',
    me: i.group ? i.group.name : code ? `รหัส ${code}` : 'แตะเพื่อดูรหัสสมาชิก',
    code: code ? `รหัส ${code}` : 'แตะเพื่อดูรหัส 6 หลัก',
    link: b.url ? b.url.replace(/^https:\/\//, '').replace(/\/$/, '') : '',
  }[b.action];
  // เมนูของคนที่ยังไม่เข้าห้อง: ปุ่ม "ห้องของฉัน" แสดงเป็น "รหัสสมาชิก"
  const label = b.label || (b.action === 'me' && !i.group ? 'รหัสสมาชิก' : a.label);
  return { label, sub: b.sub || def, icon: b.action === 'me' && !i.group ? 'key' : a.icon };
}

/** พื้นที่ของแต่ละส่วนตาม layout */
function geometry(layout) {
  const L = LAYOUTS[layout];
  const H = L.h;
  if (layout === 'compact3') {
    const header = { x: 0, y: 0, w: W, h: 330 }, strip = { x: 0, y: 330, w: W, h: 100 };
    const top = 430, pad = 30, gap = 24, cw = (W - pad * 2 - gap * 2) / 3, ch = H - top - pad * 2;
    return { H, k: 330 / 560, header, strip, cells: [0, 1, 2].map((c) => ({ x: pad + c * (cw + gap), y: top + pad, w: cw, h: ch, area: { x: Math.round(c * W / 3), y: top, w: Math.round(W / 3), h: H - top } })) };
  }
  if (layout === 'banner4') {
    const pw = 1020;
    const header = { x: 0, y: 0, w: pw, h: H - 120 }, strip = { x: 0, y: H - 120, w: pw, h: 120 };
    const pad = 30, gap = 24, cw = (W - pw - pad * 2 - gap) / 2, ch = (H - pad * 2 - gap) / 2;
    const cells = [0, 1, 2, 3].map((k) => {
      const c = k % 2, r = Math.floor(k / 2);
      return { x: pw + pad + c * (cw + gap), y: pad + r * (ch + gap), w: cw, h: ch, area: { x: pw + Math.round(c * (W - pw) / 2), y: Math.round(r * H / 2), w: Math.round((W - pw) / 2), h: Math.round(H / 2) } };
    });
    return { H, k: 0.78, header, strip, cells, narrow: true };
  }
  const cols = layout === 'grid4' ? 2 : 3;
  const header = { x: 0, y: 0, w: W, h: 560 }, strip = { x: 0, y: 560, w: W, h: 150 };
  const top = 710, pad = 40, gap = 28, rows = 2;
  const cw = (W - pad * 2 - gap * (cols - 1)) / cols, ch = (H - top - pad * 2 - gap) / rows;
  const cells = [];
  for (let k = 0; k < cols * rows; k++) {
    const c = k % cols, r = Math.floor(k / cols);
    cells.push({ x: pad + c * (cw + gap), y: top + pad + r * (ch + gap), w: cw, h: ch, area: { x: Math.round(c * W / cols), y: top + Math.round(r * (H - top) / 2), w: Math.round(W / cols), h: Math.round((H - top) / 2) } });
  }
  return { H, k: 1, header, strip, cells };
}

function themeColors(design, weekday) {
  if (design.colorMode === 'custom') return { ...design.colors };
  const bg = cal.DAY_COLORS[weekday];
  return { header: bg, headerText: cal.DAY_TEXT[weekday], accent: weekday === 1 ? '#8a6d00' : bg, page: '#f3f4f8', button: '#ffffff', buttonText: '#1e2235', subText: '#6b7290' };
}

function buildSvg(db, groupId, todayKey, designIn, fontFamily = 'Prompt', opts = {}) {
  const code = /^\d{6}$/.test(opts.code || '') ? opts.code : null;
  const design = normalizeDesign(designIn || db.settings.richMenu?.design);
  const i = menuInfo(db, groupId, todayKey);
  const g = geometry(design.layout);
  const c = themeColors(design, i.weekday);
  const dark = luminance(c.header) > 0.6 ? mix(c.header, 0.55, 0) : mix(c.header, 0.35, 0);
  const d = cal.parseKey(todayKey);
  const ff = esc(fontFamily);
  const R = design.radius;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${g.H}" viewBox="0 0 ${W} ${g.H}" font-family="${ff}, Prompt">`);
  out.push(`<rect width="${W}" height="${g.H}" fill="${c.page}"/>`);

  // ---- ส่วนหัว ----
  const h = g.header, k = g.k;
  out.push(`<clipPath id="hc"><rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}"/></clipPath>`);
  out.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="${c.header}"/>`);
  const bg = imageDataUri(design.bgFile);
  if (bg) {
    out.push(`<image clip-path="url(#hc)" x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" preserveAspectRatio="xMidYMid slice" href="${bg}"/>`);
    out.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="${c.header}" opacity="${design.bgOverlay}"/>`);
  } else {
    out.push(`<g clip-path="url(#hc)"><circle cx="${h.x + h.w - 160 * k}" cy="${-60 * k}" r="${420 * k}" fill="#ffffff" opacity="0.12"/><circle cx="${h.x + h.w * 0.6}" cy="${h.y + h.h + 120 * k}" r="${260 * k}" fill="#ffffff" opacity="0.08"/></g>`);
  }
  let tx = h.x + 120 * k;
  const logo = imageDataUri(design.logoFile);
  if (logo) {
    const ls = 150 * k;
    out.push(`<image x="${tx}" y="${h.y + 60 * k}" width="${ls}" height="${ls}" preserveAspectRatio="xMidYMid meet" href="${logo}"/>`);
    if (!g.narrow) tx += ls + 40 * k;
  }
  const rightReserve = (design.showCalendar && !g.narrow ? 520 : 0) + (design.showGroup && !g.narrow ? 640 : 0);
  const textMax = h.w - (tx - h.x) - 80 * k - rightReserve * k;
  const title = design.title || db.settings.schoolName || db.settings.appName || 'ตารางสอน';
  const titleY = logo && g.narrow ? h.y + 280 * k : h.y + 150 * k;
  const yShift = logo && g.narrow ? 150 * k : 0;
  if (design.showTitle) out.push(`<text x="${tx}" y="${titleY}" font-size="${62 * k}" font-weight="600" fill="${c.headerText}" opacity="0.85">${esc(fit(title, 62 * k, g.narrow ? h.w - 200 * k : textMax))}</text>`);
  const dayText = `วัน${DAY_NAMES[i.weekday]}`;
  const daySize = Math.min(180 * k, (g.narrow ? h.w - 220 * k : textMax) / Math.max(1, textWidth(dayText, 1)));
  out.push(`<text x="${tx - 8 * k}" y="${h.y + 325 * k + yShift}" font-size="${daySize}" font-weight="700" fill="${c.headerText}">${dayText}</text>`);
  out.push(`<text x="${tx}" y="${h.y + 478 * k + yShift}" font-size="${86 * k}" font-weight="400" fill="${c.headerText}">${esc(cal.thaiDate(todayKey))}</text>`);
  const gname = i.group ? i.group.name : 'ทุกชั้นเรียน';
  if (design.showGroup) {
    const gs = 84 * k;
    const gw = Math.min(700 * k, textWidth(gname, gs) + 110 * k);
    const gx = g.narrow ? tx : (design.showCalendar ? h.x + h.w - 550 * k - gw : h.x + h.w - 120 * k - gw);
    const gy = g.narrow ? h.y + 560 * k + yShift : h.y + 96 * k;
    if (!g.narrow || gy + 140 * k < h.y + h.h) {
      out.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="${140 * k}" rx="${70 * k}" fill="#ffffff" opacity="0.94"/>`);
      out.push(`<text x="${gx + gw / 2}" y="${gy + 98 * k}" font-size="${gs}" font-weight="700" fill="${dark}" text-anchor="middle">${esc(fit(gname, gs, gw - 70 * k))}</text>`);
    }
  }
  if (code && g.narrow) {
    const ph = 140 * k;
    const y = h.y + 560 * k + yShift;
    const pill = codePill(code, { right: h.x + h.w - 60 * k, y: y + ph + 30 * k > h.y + h.h ? h.y + 60 * k : y, h: ph, bg: '#ffffff', fg: dark, short: true });
    out.push(pill.svg);
  }
  if (design.showCalendar && !g.narrow) {
    const cx = h.x + h.w - 510 * k, cy = h.y + 96 * k, cs = 390 * k, cr = Math.min(56 * k, R);
    out.push(`<rect x="${cx}" y="${cy}" width="${cs}" height="${cs}" rx="${cr}" fill="#ffffff"/>`);
    out.push(`<path d="M${cx} ${cy + cr}a${cr} ${cr} 0 0 1 ${cr}-${cr}h${cs - 2 * cr}a${cr} ${cr} 0 0 1 ${cr} ${cr}v${114 * k - cr}h-${cs}z" fill="${dark}"/>`);
    out.push(`<text x="${cx + cs / 2}" y="${cy + 94 * k}" font-size="${62 * k}" font-weight="600" fill="#ffffff" text-anchor="middle">${cal.MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}</text>`);
    out.push(`<text x="${cx + cs / 2}" y="${cy + 334 * k}" font-size="${220 * k}" font-weight="700" fill="${dark}" text-anchor="middle">${d.getUTCDate()}</text>`);
  }

  // ---- แถบแจ้งเตือน ----
  const s = g.strip;
  const msg = stripMessage(db, i);
  if (design.showStrip || msg.color || code) {
    const sb = msg.color || c.button, sf = msg.color ? '#ffffff' : c.buttonText;
    const fsz = Math.min(70, s.h * 0.47);
    out.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${sb}"/>`);
    // รหัสสมาชิกของผู้ใช้คนนี้ (ด้านขวาของแถบ)
    let reserve = 0;
    if (code && !g.narrow) {
      const ph = s.h * 0.72;
      const pill = codePill(code, { right: s.x + s.w - 50, y: s.y + (s.h - ph) / 2, h: ph, bg: msg.color ? '#ffffff' : c.accent, fg: msg.color ? msg.color : (luminance(c.accent) > 0.6 ? '#1e2235' : '#ffffff') });
      out.push(pill.svg);
      reserve = pill.w + 70;
    }
    out.push(`<circle cx="${s.x + 80 + fsz * 0.3}" cy="${s.y + s.h / 2}" r="${fsz * 0.37}" fill="${msg.color ? '#ffffff' : c.accent}"/>`);
    out.push(`<text x="${s.x + 140 + fsz * 0.3}" y="${s.y + s.h / 2 + fsz * 0.37}" font-size="${fsz}" font-weight="600" fill="${sf}">${esc(fit(msg.text, fsz, s.w - 200 - fsz - reserve))}</text>`);
  } else {
    out.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${c.page}"/>`);
  }

  // ---- ปุ่ม ----
  const iconBg = mix(c.accent, 0.84);
  g.cells.forEach((cell, n) => {
    const b = design.buttons[n];
    if (!b) return;
    const t = buttonText(b, i, code);
    const kc = Math.min(cell.h / 434, cell.w / 788);
    out.push(`<rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}" rx="${Math.min(R, cell.h / 2)}" fill="${c.button}"/>`);
    const vertical = cell.w < cell.h * 1.25; // ปุ่มแคบ: ไอคอนบน ข้อความล่าง
    if (vertical) {
      const cx = cell.x + cell.w / 2;
      if (design.showIcons) {
        out.push(`<circle cx="${cx}" cy="${cell.y + cell.h * 0.36}" r="${92 * kc}" fill="${iconBg}"/>`);
        out.push(icon(t.icon, cx, cell.y + cell.h * 0.36, c.accent, kc));
      }
      const ly = design.showIcons ? cell.y + cell.h * 0.36 + 190 * kc : cell.y + cell.h / 2;
      out.push(`<text x="${cx}" y="${ly}" font-size="${76 * kc}" font-weight="700" fill="${c.buttonText}" text-anchor="middle">${esc(fit(t.label, 76 * kc, cell.w - 60))}</text>`);
      out.push(`<text x="${cx}" y="${ly + 70 * kc}" font-size="${46 * kc}" font-weight="400" fill="${c.subText}" text-anchor="middle">${esc(fit(t.sub, 46 * kc, cell.w - 60))}</text>`);
    } else {
      const ix = cell.x + 150 * kc;
      const lx = design.showIcons ? cell.x + 285 * kc : cell.x + 80 * kc;
      if (design.showIcons) {
        out.push(`<circle cx="${ix}" cy="${cell.y + cell.h / 2}" r="${92 * kc}" fill="${iconBg}"/>`);
        out.push(icon(t.icon, ix, cell.y + cell.h / 2, c.accent, kc));
      }
      const maxW = cell.x + cell.w - lx - 40 * kc;
      out.push(`<text x="${lx}" y="${cell.y + cell.h / 2 - 4 * kc}" font-size="${76 * kc}" font-weight="700" fill="${c.buttonText}">${esc(fit(t.label, 76 * kc, maxW))}</text>`);
      out.push(`<text x="${lx + 2}" y="${cell.y + cell.h / 2 + 74 * kc}" font-size="${46 * kc}" font-weight="400" fill="${c.subText}">${esc(fit(t.sub, 46 * kc, maxW))}</text>`);
    }
  });
  out.push('</svg>');
  return out.join('');
}

/** วาดรูป: ใช้ PNG ถ้าไม่เกิน 1MB ไม่งั้นแปลงเป็น JPEG (LINE รับรูปริชเมนูไม่เกิน 1MB) */
function render(svg, fontFiles = BUNDLED) {
  const img = new Resvg(svg, { fitTo: { mode: 'original' }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Prompt' } }).render();
  const png = img.asPng();
  if (png.length <= MAX_BYTES) return { data: png, contentType: 'image/png' };
  for (const q of [90, 82, 72, 60]) {
    const j = jpeg.encode({ data: img.pixels, width: img.width, height: img.height }, q).data;
    if (j.length <= MAX_BYTES) return { data: Buffer.from(j), contentType: 'image/jpeg' };
  }
  throw new Error('รูปริชเมนูใหญ่เกิน 1MB แม้บีบอัดแล้ว ลองใช้รูปพื้นหลังที่เล็กลง');
}

async function renderMenu(db, groupId, key, designIn, opts = {}) {
  const design = normalizeDesign(designIn || db.settings.richMenu?.design);
  const font = await resolveFont(db, design);
  const out = render(buildSvg(db, groupId, key, design, font.family, opts), font.files);
  return { ...out, warning: font.warning || null };
}

function menuDefinition(db, groupId, todayKey, designIn, opts = {}) {
  const design = normalizeDesign(designIn || db.settings.richMenu?.design);
  const d = cal.parseKey(todayKey);
  const group = db.groups.find((x) => x.id === groupId);
  const g = geometry(design.layout);
  const i = { group };
  const areas = [{ bounds: { x: g.header.x, y: 0, width: g.header.w, height: g.strip.y + g.strip.h }, action: { type: 'message', label: 'ตารางวันนี้', text: 'ตารางวันนี้' } }];
  g.cells.forEach((cell, n) => {
    const b = design.buttons[n];
    if (!b) return;
    const a = ACTIONS[b.action];
    const label = (b.label || (b.action === 'me' && !i.group ? 'รหัสสมาชิก' : a.label)).slice(0, 20);
    const action = b.action === 'link' && b.url
      ? { type: 'uri', label, uri: b.url }
      : { type: 'message', label, text: a.text };
    const ar = cell.area;
    areas.push({ bounds: { x: ar.x, y: ar.y, width: Math.min(ar.w, W - ar.x), height: Math.min(ar.h, g.H - ar.y) }, action });
  });
  return {
    size: { width: W, height: g.H },
    selected: db.settings.richMenu?.selected !== false,
    name: `classroom ${todayKey} ${group ? group.name : 'default'}${opts.code ? ` #${opts.code}` : ''}`.slice(0, 300),
    chatBarText: `เมนู ${d.getUTCDate()} ${cal.MONTHS_SHORT[d.getUTCMonth()]}`.slice(0, 14),
    areas,
  };
}

function todayKeyOf(db, now = new Date()) {
  return dateKey(localParts(now, db.settings.timezone || 'Asia/Bangkok'));
}

function preview(db, groupId, key, design, opts) {
  return renderMenu(db, groupId || null, key || todayKeyOf(db), design, opts);
}

// ---------------- เมนูส่วนตัว (มีรหัสสมาชิกของแต่ละคน) ----------------
// LINE ให้มีริชเมนูได้ไม่เกิน 1,000 ชุดต่อบัญชี จึงจำกัดเมนูส่วนตัวไว้ และให้คนที่ยังไม่เข้าห้องก่อน
const MAX_MENUS = 950;
function personalTargets(db, design = normalizeDesign(db.settings.richMenu?.design)) {
  if (design.memberCode === 'off') return { users: [], skipped: 0 };
  const active = db.recipients.filter((r) => r.type === 'user' && r.enabled !== false && !r.left && /^\d{6}$/.test(r.code || ''));
  let list = design.memberCode === 'unassigned' ? active.filter((r) => !r.groupId) : active;
  list = [...list].sort((a, b) => (a.groupId ? 1 : 0) - (b.groupId ? 1 : 0)); // ยังไม่เข้าห้องก่อน
  const room = Math.max(0, MAX_MENUS - db.groups.length - 1);
  return { users: list.slice(0, room), skipped: Math.max(0, list.length - room) };
}
const wantsPersonal = (db, r, design) => personalTargets(db, design).users.some((x) => x.id === r.id);

/** สร้าง/อัปเดตเมนูส่วนตัวของผู้ใช้คนเดียว แล้วผูกให้ทันที (ใช้ตอนเพิ่มเพื่อนหรือย้ายห้อง) */
async function buildPersonal(db, r, key = todayKeyOf(db)) {
  const rm = db.settings.richMenu;
  rm.personal = rm.personal || {};
  const img = await renderMenu(db, r.groupId || null, key, null, { code: r.code });
  const { richMenuId } = await line.richMenu.create(db.settings, menuDefinition(db, r.groupId || null, key, null, { code: r.code }));
  try {
    await line.richMenu.upload(db.settings, richMenuId, img.data, img.contentType);
    await line.richMenu.linkUser(db.settings, r.id, richMenuId);
  } catch (e) {
    try { await line.richMenu.remove(db.settings, richMenuId); } catch { /* ignore */ }
    throw e;
  }
  const old = rm.personal[r.id];
  rm.personal[r.id] = richMenuId;
  if (old && old !== richMenuId) { try { await line.richMenu.remove(db.settings, old); } catch { /* ลบไปแล้ว */ } }
  store.save();
  return richMenuId;
}

/** สร้างริชเมนูใหม่ของวันนี้ให้ทุกชั้น/ห้อง แล้วผูกกับผู้ใช้ และลบเมนูเก่า */
async function rebuild(db) {
  const { settings } = db;
  const rm = settings.richMenu;
  const key = todayKeyOf(db);
  const targets = [null, ...db.groups.map((g) => g.id)];
  const created = {};
  try {
    let warning = null;
    for (const gid of targets) {
      const img = await renderMenu(db, gid, key);
      warning = warning || img.warning;
      const { richMenuId } = await line.richMenu.create(settings, menuDefinition(db, gid, key));
      created[gid || DEFAULT_KEY] = richMenuId;
      await line.richMenu.upload(settings, richMenuId, img.data, img.contentType);
    }
    await line.richMenu.setDefault(settings, created[DEFAULT_KEY]);
    // คนที่จะได้เมนูส่วนตัวไม่ต้องผูกแบบกลุ่ม (bulk link ทำงานเบื้องหลัง อาจทับเมนูส่วนตัวได้)
    const { users: personalUsers, skipped } = personalTargets(db);
    const personalIds = new Set(personalUsers.map((r) => r.id));
    let linked = 0;
    for (const g of db.groups) {
      const users = db.recipients.filter((r) => r.type === 'user' && r.groupId === g.id && r.enabled !== false && !r.left && !personalIds.has(r.id)).map((r) => r.id);
      if (users.length) { await line.richMenu.bulkLink(settings, created[g.id], users); linked += users.length; }
    }
    // เมนูส่วนตัวที่มีรหัสสมาชิก (สร้างหลังเมนูห้อง ถ้าสร้างไม่สำเร็จผู้ใช้ยังใช้เมนูห้องได้)
    const personal = {};
    let personalFailed = 0;
    for (const r of personalUsers) {
      try {
        const img = await renderMenu(db, r.groupId || null, key, null, { code: r.code });
        const { richMenuId } = await line.richMenu.create(settings, menuDefinition(db, r.groupId || null, key, null, { code: r.code }));
        await line.richMenu.upload(settings, richMenuId, img.data, img.contentType);
        await line.richMenu.linkUser(settings, r.id, richMenuId);
        personal[r.id] = richMenuId;
      } catch (e) {
        personalFailed++;
        if (personalFailed === 1) console.error('[richmenu] เมนูส่วนตัวไม่สำเร็จ:', e.message);
      }
    }
    const keep = new Set([...Object.values(created), ...Object.values(personal)]);
    const old = [...Object.values(rm.menus || {}), ...Object.values(rm.personal || {})].filter((id) => !keep.has(id));
    for (const id of old) { try { await line.richMenu.remove(settings, id); } catch { /* ลบไปแล้ว */ } }
    rm.personal = personal;
    rm.personalCount = Object.keys(personal).length;
    rm.personalSkipped = skipped;
    rm.personalFailed = personalFailed;
    rm.menus = created;
    rm.builtFor = key;
    rm.builtAt = new Date().toISOString();
    rm.lastError = null;
    rm.warning = warning;
    rm.failedAt = null;
    rm.dirtyAt = null;
    rm.linked = linked;
    console.log(`[richmenu] สร้างริชเมนู ${targets.length} ชุด + เมนูส่วนตัว ${rm.personalCount} คน ของวันที่ ${key}`);
    return { menus: targets.length, linked, personal: rm.personalCount, personalSkipped: skipped, personalFailed, date: key, warning };
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
  if (rm.builtFor && wantsPersonal(db, r)) return buildPersonal(db, r);
  if (rm.personal?.[r.id]) { // เคยมีเมนูส่วนตัว แต่ตอนนี้ไม่ต้องใช้แล้ว
    const pid = rm.personal[r.id];
    delete rm.personal[r.id];
    line.richMenu.remove(db.settings, pid).catch(() => {});
  }
  const id = r.groupId && rm.menus ? rm.menus[r.groupId] : null;
  if (id) await line.richMenu.linkUser(db.settings, r.id, id);
  else { try { await line.richMenu.unlinkUser(db.settings, r.id); } catch { /* ไม่ได้ผูกไว้ */ } }
}

/** ลบริชเมนูทั้งหมดที่ระบบสร้าง (ตอนปิดฟีเจอร์) */
async function removeAll(db) {
  const rm = db.settings.richMenu;
  try { await line.richMenu.clearDefault(db.settings); } catch { /* ignore */ }
  for (const id of [...Object.values(rm.menus || {}), ...Object.values(rm.personal || {})]) { try { await line.richMenu.remove(db.settings, id); } catch { /* ignore */ } }
  rm.menus = {};
  rm.personal = {};
  rm.builtFor = null;
}

module.exports = {
  W, ACTIONS, LAYOUTS, DEFAULT_DESIGN, normalizeDesign, geometry,
  buildSvg, render, renderMenu, preview, menuDefinition, menuInfo, rebuild, linkRecipient, removeAll, todayKeyOf, textWidth,
  ensureGoogleFont, forgetImage, buildPersonal, personalTargets, MAX_MENUS,
};

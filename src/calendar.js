'use strict';
// วันพิเศษของโรงเรียน (หยุดทั้งโรงเรียน): วันหยุดพิเศษ / ปิดภาคเรียน / วันกิจกรรม
const { DAY_NAMES } = require('./time');

const TYPES = {
  holiday: { label: 'วันหยุดพิเศษ', short: 'วันหยุด', color: '#e11d48' },
  semester_break: { label: 'ปิดภาคเรียน', short: 'ปิดภาค', color: '#7c3aed' },
  activity: { label: 'วันกิจกรรม', short: 'กิจกรรม', color: '#ea580c' },
};

// สีประจำวันแบบไทย (อาทิตย์ → เสาร์)
const DAY_COLORS = ['#e53935', '#fdd835', '#ec407a', '#43a047', '#fb8c00', '#1e88e5', '#8e24aa'];
const DAY_TEXT = ['#ffffff', '#3b2f00', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'];
const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function keyOf(date) {
  return date.toISOString().slice(0, 10);
}
function shiftKey(key, days) {
  const d = parseKey(key);
  d.setUTCDate(d.getUTCDate() + days);
  return keyOf(d);
}
function weekdayOf(key) {
  return parseKey(key).getUTCDay();
}
function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86400000);
}

/** "2 พฤศจิกายน 2569" (ปี พ.ศ.) */
function thaiDate(key, { short = false, weekday = false } = {}) {
  const d = parseKey(key);
  const txt = `${d.getUTCDate()} ${(short ? MONTHS_SHORT : MONTHS)[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
  return weekday ? `วัน${DAY_NAMES[d.getUTCDay()]}ที่ ${txt}` : txt;
}
function thaiRange(start, end) {
  if (start === end) return thaiDate(start, { short: true });
  return `${thaiDate(start, { short: true })} – ${thaiDate(end, { short: true })}`;
}

/** วันพิเศษที่ครอบคลุมวันที่ key (เลือกรายการที่งดเรียนก่อน) */
function specialOn(db, key) {
  const hits = (db.specialDays || []).filter((s) => s.start <= key && key <= s.end);
  return hits.find((s) => s.suspendClasses !== false) || hits[0] || null;
}
function isSuspended(db, key) {
  return (db.specialDays || []).some((s) => s.suspendClasses !== false && s.start <= key && key <= s.end);
}

/** วันเปิดเรียนถัดไปหลังวัน key (ข้ามวันที่งดเรียนและวันที่ไม่มีการเรียน) */
function nextSchoolDay(db, key) {
  const days = db.settings.visibleDays && db.settings.visibleDays.length ? db.settings.visibleDays : [1, 2, 3, 4, 5];
  let k = shiftKey(key, 1);
  for (let i = 0; i < 400; i++, k = shiftKey(k, 1)) {
    if (days.includes(weekdayOf(k)) && !isSuspended(db, k)) return k;
  }
  return null;
}

/** วันพิเศษที่กำลังดำเนินอยู่หรือจะมาถึง เรียงตามวันเริ่ม */
function upcoming(db, fromKey, limit = 10) {
  return (db.specialDays || [])
    .filter((s) => s.end >= fromKey)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .slice(0, limit);
}

function typeInfo(type) {
  return TYPES[type] || TYPES.holiday;
}

module.exports = {
  TYPES, DAY_COLORS, DAY_TEXT, MONTHS, MONTHS_SHORT,
  isDateKey, parseKey, keyOf, shiftKey, weekdayOf, daysBetween,
  thaiDate, thaiRange, specialOn, isSuspended, nextSchoolDay, upcoming, typeInfo,
};

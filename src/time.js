'use strict';
// ตัวช่วยเรื่องเวลาตามโซนเวลา (ไม่พึ่งโซนเวลาของเซิร์ฟเวอร์)

const DAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const DAY_COLORS = ['#ef4444', '#eab308', '#ec4899', '#22c55e', '#f97316', '#3b82f6', '#a855f7'];

/** แปลง Date เป็นส่วนประกอบของเวลาท้องถิ่นตาม timezone */
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: wd,
  };
}

/** "นาทีท้องถิ่น" นับจาก epoch — ใช้เทียบเวลาแบบไม่สน DST/โซนเวลา */
function localMinutes(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 60000) + parts.hour * 60 + parts.minute + (parts.second || 0) / 60;
}

function toMin(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** วันที่ท้องถิ่นของวันที่ +offset วันจาก parts */
function addDays(parts, offset) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, second: 0, weekday: d.getUTCDay() };
}

function isValidTime(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
}

function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { DAY_NAMES, DAY_COLORS, localParts, localMinutes, toMin, dateKey, addDays, isValidTime, isValidTimeZone };

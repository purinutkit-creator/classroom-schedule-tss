'use strict';
// ตัวจับเวลา (ทุก 20 วินาที):
//  1) แจ้งเตือนก่อนเริ่มคาบ (คาบละ 1 ครั้ง) — ข้ามวันที่โรงเรียนหยุด
//  2) แจ้งวันหยุดทั้งโรงเรียน เวลา 08:00 ทุกวันในช่วงวันหยุด (และแจ้งล่วงหน้า 1 วันถ้าเปิดไว้)
//  3) สร้างริชเมนูรายวันใหม่เมื่อขึ้นวันใหม่ หรือเมื่อข้อมูลเปลี่ยน
const store = require('./store');
const line = require('./line');
const notify = require('./notify');
const cal = require('./calendar');
const richmenu = require('./richmenu');
const { localParts, localMinutes, toMin, dateKey, addDays } = require('./time');

const GRACE_MIN = 5; // ถ้าเซิร์ฟเวอร์หลับไป ส่งแจ้งเตือนคาบย้อนหลังได้ไม่เกิน 5 นาที
const ANNOUNCE_GRACE_MIN = 120; // ประกาศวันหยุดส่งย้อนหลังได้ถึง 2 ชั่วโมง
const RICHMENU_DEBOUNCE_MS = 15 * 1000;
const RICHMENU_RETRY_MS = 10 * 60 * 1000;

function reminderMinutesOf(cls, settings) {
  const m = cls.reminderMinutes;
  return m === null || m === undefined || m === '' ? Number(settings.defaultReminderMinutes) || 0 : Number(m);
}

/** หาคาบที่ถึงเวลาแจ้งเตือน ณ เวลา now */
function dueReminders(db, now = new Date()) {
  const { settings } = db;
  const tz = settings.timezone || 'Asia/Bangkok';
  const today = localParts(now, tz);
  const nowMin = localMinutes(today);
  const due = [];

  // ตรวจคาบของวันนี้และพรุ่งนี้ (กรณีแจ้งเตือนข้ามเที่ยงคืน)
  for (const offset of [0, 1]) {
    const d = addDays(today, offset);
    const key = dateKey(d);
    if (cal.isSuspended(db, key)) continue; // วันหยุดทั้งโรงเรียน: ไม่แจ้งคาบเรียน
    for (const cls of db.classes) {
      if (cls.reminderEnabled === false || Number(cls.day) !== d.weekday) continue;
      const before = reminderMinutesOf(cls, settings);
      const startAt = localMinutes(d) + toMin(cls.start);
      const fireAt = startAt - before;
      const sentKey = `${cls.id}@${key}`;
      if (nowMin >= fireAt && nowMin < fireAt + GRACE_MIN && nowMin < startAt + 1 && !db.sent[sentKey]) {
        due.push({ cls, key: sentKey, minutesBefore: Math.max(0, Math.round(startAt - nowMin)) });
      }
    }
  }
  return due;
}

/** ประกาศวันหยุดที่ถึงเวลาส่ง: [{ sd, dateKey, mode: 'today'|'tomorrow', key }] */
function dueAnnouncements(db, now = new Date()) {
  const { settings } = db;
  if (settings.announceEnabled === false) return [];
  const today = localParts(now, settings.timezone || 'Asia/Bangkok');
  const nowMin = today.hour * 60 + today.minute;
  const at = toMin(settings.announceTime || '08:00');
  if (nowMin < at || nowMin >= at + ANNOUNCE_GRACE_MIN) return [];
  const todayKey = dateKey(today);
  const out = [];
  const sdToday = cal.specialOn(db, todayKey);
  if (sdToday && !db.sent[`announce@${todayKey}`]) out.push({ sd: sdToday, dateKey: todayKey, mode: 'today', key: `announce@${todayKey}` });
  if (settings.announceEve) {
    const tomorrowKey = cal.shiftKey(todayKey, 1);
    const sdTomorrow = cal.specialOn(db, tomorrowKey);
    // แจ้งล่วงหน้าเฉพาะวันแรกของช่วง (วันนี้ยังไม่อยู่ในช่วงเดียวกัน)
    if (sdTomorrow && sdTomorrow.start === tomorrowKey && !db.sent[`eve@${tomorrowKey}`]) {
      out.push({ sd: sdTomorrow, dateKey: tomorrowKey, mode: 'tomorrow', key: `eve@${tomorrowKey}` });
    }
  }
  return out;
}

function log(db, entry) {
  db.history.unshift({ at: new Date().toISOString(), ok: true, ...entry });
  db.history = db.history.slice(0, 100);
  store.save();
}

async function reminderTick(db) {
  if (!db.settings.remindersEnabled) return;
  for (const { cls, key, minutesBefore } of dueReminders(db)) {
    db.sent[key] = Date.now(); // กันส่งซ้ำก่อนเรียก API
    store.save();
    const room = db.rooms.find((r) => r.id === cls.roomId);
    const group = db.groups.find((g) => g.id === cls.groupId);
    const entry = { classId: cls.id, subject: cls.subject, room: room?.name || '', group: group?.name || '', minutesBefore };
    try {
      entry.detail = await notify.sendForClass(db, cls, [line.reminderMessage(cls, room, minutesBefore, db.settings, group)]);
      console.log(`[reminder] ส่งแล้ว: ${cls.subject} (${key})`);
    } catch (e) {
      entry.ok = false;
      entry.detail = e.message;
      console.error(`[reminder] ส่งไม่สำเร็จ: ${cls.subject}:`, e.message);
    }
    log(db, entry);
  }
}

async function announceTick(db) {
  for (const a of dueAnnouncements(db)) {
    db.sent[a.key] = Date.now();
    store.save();
    const entry = { kind: 'announce', subject: `${a.mode === 'tomorrow' ? 'แจ้งล่วงหน้า' : 'ประกาศวันหยุด'}: ${a.sd.name}`, room: '', minutesBefore: null };
    try {
      entry.detail = await notify.sendToAll(db, [line.specialDayMessage(a.sd, a.dateKey, db, a.mode)]);
      console.log(`[announce] ส่งประกาศ ${a.key}`);
    } catch (e) {
      entry.ok = false;
      entry.detail = e.message;
      console.error('[announce] ส่งไม่สำเร็จ:', e.message);
    }
    log(db, entry);
  }
}

let building = false;
function richMenuNeeded(db, nowMs = Date.now()) {
  const rm = db.settings.richMenu;
  if (!rm || !rm.enabled || building) return false;
  if (rm.failedAt && nowMs - rm.failedAt < RICHMENU_RETRY_MS) return false;
  if (rm.builtFor !== richmenu.todayKeyOf(db)) return true;
  return !!rm.dirtyAt && nowMs - rm.dirtyAt >= RICHMENU_DEBOUNCE_MS;
}
async function richMenuTick(db, { force = false } = {}) {
  if (building) throw new Error('กำลังสร้างริชเมนูอยู่');
  if (!force && !richMenuNeeded(db)) return null;
  building = true;
  try { return await richmenu.rebuild(db); } finally { building = false; store.save(); }
}

async function tick() {
  const db = store.db;
  if (!line.creds(db.settings).token) return; // ยังไม่ได้เชื่อม LINE
  await reminderTick(db);
  await announceTick(db);
  await richMenuTick(db).catch(() => { /* บันทึก lastError แล้ว */ });
  prune(db);
}

function prune(db) {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  let changed = false;
  for (const [k, t] of Object.entries(db.sent)) if (t < cutoff) { delete db.sent[k]; changed = true; }
  if (changed) store.save();
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => tick().catch((e) => console.error('[scheduler]', e));
  run();
  timer = setInterval(run, 20 * 1000);
}

module.exports = { start, tick, dueReminders, dueAnnouncements, reminderMinutesOf, richMenuTick, richMenuNeeded };

'use strict';
// ตัวจับเวลาแจ้งเตือน: ตรวจทุก 20 วินาที ส่งแจ้งเตือนก่อนเริ่มคาบตามจำนวนนาทีที่ตั้งไว้ (คาบละ 1 ครั้ง)
const store = require('./store');
const line = require('./line');
const { localParts, localMinutes, toMin, dateKey, addDays } = require('./time');

const GRACE_MIN = 5; // ถ้าเซิร์ฟเวอร์หลับไป ส่งย้อนหลังได้ไม่เกิน 5 นาที

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
    for (const cls of db.classes) {
      if (cls.reminderEnabled === false || Number(cls.day) !== d.weekday) continue;
      const before = reminderMinutesOf(cls, settings);
      const startAt = localMinutes(d) + toMin(cls.start);
      const fireAt = startAt - before;
      const key = `${cls.id}@${dateKey(d)}`;
      if (nowMin >= fireAt && nowMin < fireAt + GRACE_MIN && nowMin < startAt + 1 && !db.sent[key]) {
        due.push({ cls, key, minutesBefore: Math.max(0, Math.round(startAt - nowMin)) });
      }
    }
  }
  return due;
}

async function tick() {
  const db = store.db;
  if (!db.settings.remindersEnabled) return;
  if (!line.creds(db.settings).token) return; // ยังไม่ได้เชื่อม LINE: ไม่ใช้สิทธิ์แจ้งเตือนของคาบ
  const due = dueReminders(db);
  for (const { cls, key, minutesBefore } of due) {
    db.sent[key] = Date.now(); // กันส่งซ้ำก่อนเรียก API
    store.save();
    const room = db.rooms.find((r) => r.id === cls.roomId);
    const entry = { at: new Date().toISOString(), classId: cls.id, subject: cls.subject, room: room?.name || '', minutesBefore, ok: true };
    try {
      const result = await line.send(db.settings, db.recipients, [line.reminderMessage(cls, room, minutesBefore, db.settings)]);
      entry.detail = result.mode === 'push' ? `push สำเร็จ ${result.sent} / ล้มเหลว ${result.failed}` : 'broadcast';
      console.log(`[reminder] ส่งแล้ว: ${cls.subject} (${key})`);
    } catch (e) {
      entry.ok = false;
      entry.detail = e.message;
      console.error(`[reminder] ส่งไม่สำเร็จ: ${cls.subject}:`, e.message);
    }
    db.history.unshift(entry);
    db.history = db.history.slice(0, 100);
    store.save();
  }
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

module.exports = { start, tick, dueReminders, reminderMinutesOf };

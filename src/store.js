'use strict';
// ที่เก็บข้อมูลแบบไฟล์ JSON (เขียนแบบ atomic) — ไม่ต้องติดตั้งฐานข้อมูล
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FONT_DIR = path.join(DATA_DIR, 'fonts');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(FONT_DIR, { recursive: true });

const DEFAULT_DB = () => ({
  settings: {
    appName: 'ตารางสอน',
    schoolName: '',
    timezone: 'Asia/Bangkok',
    defaultReminderMinutes: 10,
    remindersEnabled: true,
    visibleDays: [1, 2, 3, 4, 5],
    dayStart: '08:00',
    dayEnd: '17:00',
    accentColor: '#4f46e5',
    font: { source: 'google', googleFamily: 'Prompt', customFontId: null },
    line: {
      channelAccessToken: '',
      channelSecret: '',
      sendMode: 'broadcast', // broadcast | push
      autoAddFollowers: true,
      replyKeywords: true,
    },
  },
  rooms: [],
  classes: [],
  recipients: [],
  fonts: [],
  sent: {},
  history: [],
});

let db = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = DEFAULT_DB();
    return {
      ...base,
      ...raw,
      settings: {
        ...base.settings,
        ...(raw.settings || {}),
        font: { ...base.settings.font, ...((raw.settings || {}).font || {}) },
        line: { ...base.settings.line, ...((raw.settings || {}).line || {}) },
      },
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] อ่าน db.json ไม่ได้ ใช้ค่าเริ่มต้นแทน:', e.message);
    return seed(DEFAULT_DB());
  }
}

// ข้อมูลตัวอย่างสำหรับการเปิดใช้ครั้งแรก
function seed(d) {
  const r1 = { id: uid(), name: 'ห้อง 301', building: 'อาคาร 3', floor: '3', detail: 'ขึ้นบันไดฝั่งโรงอาหาร ห้องที่ 2 ทางซ้าย', lat: 13.7563, lng: 100.5018, color: '#4f46e5' };
  const r2 = { id: uid(), name: 'ห้องปฏิบัติการคอมพิวเตอร์ 1', building: 'อาคาร 5', floor: '2', detail: 'ข้างห้องสมุด', lat: 13.7570, lng: 100.5030, color: '#0ea5e9' };
  d.rooms.push(r1, r2);
  d.classes.push(
    { id: uid(), subject: 'คณิตศาสตร์พื้นฐาน', code: 'ค31101', teacher: 'ครูสมชาย', roomId: r1.id, day: 1, start: '08:30', end: '10:10', color: '#6366f1', reminderEnabled: true, reminderMinutes: null, note: 'นำเครื่องคิดเลขมาด้วย' },
    { id: uid(), subject: 'วิทยาการคำนวณ', code: 'ว31181', teacher: 'ครูมาลี', roomId: r2.id, day: 1, start: '13:00', end: '14:40', color: '#0ea5e9', reminderEnabled: true, reminderMinutes: 15, note: '' },
    { id: uid(), subject: 'ภาษาไทย', code: 'ท31101', teacher: 'ครูวิภา', roomId: r1.id, day: 3, start: '10:20', end: '12:00', color: '#f43f5e', reminderEnabled: true, reminderMinutes: null, note: '' },
  );
  return d;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}
function flush() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
if (!fs.existsSync(DB_FILE)) flush();

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

module.exports = {
  DATA_DIR,
  FONT_DIR,
  get db() { return db; },
  save,
  flush,
  uid,
};

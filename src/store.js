'use strict';
// ที่เก็บข้อมูล: ไฟล์ JSON (ค่าเริ่มต้น) หรือ PostgreSQL เมื่อกำหนด DATABASE_URL
// (โฮสต์ฟรีอย่าง Render free ไม่มีดิสก์ถาวร จึงต้องเก็บใน Postgres)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FONT_DIR = path.join(DATA_DIR, 'fonts');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

fs.mkdirSync(FONT_DIR, { recursive: true });

const DEFAULT_DB = () => ({
  settings: {
    appName: 'ตารางสอน',
    schoolName: '',
    contactEmail: '',
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
    ai: { apiKey: '' },
  },
  rooms: [],
  classes: [],
  recipients: [],
  fonts: [],
  sent: {},
  history: [],
});

/** รวมข้อมูลที่อ่านมากับค่าเริ่มต้น (รองรับข้อมูลเก่าที่ยังไม่มีฟิลด์ใหม่) */
function normalize(raw) {
  const base = DEFAULT_DB();
  return {
    ...base,
    ...raw,
    settings: {
      ...base.settings,
      ...(raw.settings || {}),
      font: { ...base.settings.font, ...((raw.settings || {}).font || {}) },
      line: { ...base.settings.line, ...((raw.settings || {}).line || {}) },
      ai: { ...base.settings.ai, ...((raw.settings || {}).ai || {}) },
    },
  };
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

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------------- ไฟล์ JSON ----------------
function loadFile() {
  try {
    return normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] อ่าน db.json ไม่ได้ ใช้ค่าเริ่มต้นแทน:', e.message);
    return seed(DEFAULT_DB());
  }
}
function writeFile() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------- PostgreSQL ----------------
let pool = null;
function pgPool() {
  if (!pool) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
    // Render internal URL ไม่ใช้ SSL ส่วน external URL ต้องใช้ SSL
    const internal = /@dpg-[^.]+(:\d+)?\//.test(DATABASE_URL);
    // Neon / Postgres ภายนอกใช้ SSL; ฐานข้อมูลฟรีของ Neon จะหลับเมื่อไม่มีการใช้งาน จึงเผื่อเวลาให้ตื่น
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: local || internal ? false : { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 60000,
    });
    pool.on('error', (e) => console.error('[store] postgres:', e.message));
  }
  return pool;
}
async function initPg() {
  const p = pgPool();
  // ลองเชื่อมต่อซ้ำ เผื่อฐานข้อมูลกำลังตื่นจากโหมดพัก
  for (let i = 1; ; i++) {
    try { await p.query('SELECT 1'); break; } catch (e) {
      if (i >= 5) throw e;
      console.warn(`[store] เชื่อมต่อ Postgres ไม่สำเร็จ (ครั้งที่ ${i}): ${e.message} — ลองใหม่`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  await p.query(`CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS font_files (file text PRIMARY KEY, data bytea NOT NULL)`);
  const { rows } = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (rows.length) db = normalize(rows[0].data);
  else { db = seed(DEFAULT_DB()); await writePg(); }
  // คืนไฟล์ฟอนต์ที่อัปโหลดไว้ลงดิสก์ชั่วคราว เพื่อให้เสิร์ฟแบบ static ได้
  const fonts = await p.query('SELECT file, data FROM font_files');
  for (const f of fonts.rows) fs.writeFileSync(path.join(FONT_DIR, path.basename(f.file)), f.data);
  console.log(`[store] ใช้ PostgreSQL (ฟอนต์ ${fonts.rows.length} ไฟล์)`);
}
async function writePg() {
  await pgPool().query(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(db)],
  );
}

// ---------------- API ----------------
let db = DATABASE_URL ? normalize({}) : loadFile();
let saveTimer = null;
let writing = Promise.resolve();

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}
function flush() {
  clearTimeout(saveTimer);
  if (!DATABASE_URL) return writeFile();
  // เขียนตามลำดับ ไม่ให้การบันทึกเก่าทับของใหม่
  writing = writing.then(writePg).catch((e) => console.error('[store] บันทึกลง Postgres ไม่สำเร็จ:', e.message));
  return writing;
}

async function init() {
  if (DATABASE_URL) await initPg();
  else if (!fs.existsSync(DB_FILE)) writeFile();
}

/** เก็บไฟล์ฟอนต์ให้ถาวร (เฉพาะโหมด Postgres; โหมดไฟล์อยู่บนดิสก์อยู่แล้ว) */
async function persistFont(file) {
  if (!DATABASE_URL) return;
  const data = fs.readFileSync(path.join(FONT_DIR, file));
  await pgPool().query('INSERT INTO font_files (file, data) VALUES ($1, $2) ON CONFLICT (file) DO UPDATE SET data = EXCLUDED.data', [file, data]);
}
async function removeFont(file) {
  fs.rm(path.join(FONT_DIR, file), { force: true }, () => {});
  if (DATABASE_URL) await pgPool().query('DELETE FROM font_files WHERE file = $1', [file]);
}

async function close() {
  clearTimeout(saveTimer);
  if (DATABASE_URL) { await flush(); await pool?.end(); }
  else writeFile();
}

module.exports = {
  DATA_DIR,
  FONT_DIR,
  usingPostgres: !!DATABASE_URL,
  get db() { return db; },
  init,
  save,
  flush,
  close,
  persistFont,
  removeFont,
  uid,
};

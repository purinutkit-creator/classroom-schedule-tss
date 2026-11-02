'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-school-'));
delete process.env.DATABASE_URL;
const cal = require('../src/calendar');
const scheduler = require('../src/scheduler');
const line = require('../src/line');
const notify = require('../src/notify');
const richmenu = require('../src/richmenu');

const at = (hhmm, day) => new Date(`${day}T${hhmm}:00+07:00`);
const baseSettings = () => ({
  timezone: 'Asia/Bangkok', defaultReminderMinutes: 10, remindersEnabled: true, visibleDays: [1, 2, 3, 4, 5],
  announceEnabled: true, announceTime: '08:00', announceEve: false, appName: 'ตารางสอน', schoolName: 'โรงเรียนทดสอบ', accentColor: '#4f46e5',
  line: { sendMode: 'push', channelAccessToken: 't' }, richMenu: { enabled: true, menus: {} },
});
const mkDb = (o = {}) => ({
  settings: baseSettings(), sent: {}, history: [], rooms: [],
  groups: [{ id: 'g41', name: 'ม.4/1' }, { id: 'g42', name: 'ม.4/2' }],
  classes: [
    { id: 'c1', groupId: 'g41', subject: 'คณิต', day: 2, start: '08:30', end: '09:20', reminderEnabled: true, reminderMinutes: null },
    { id: 'c2', groupId: 'g42', subject: 'ฟิสิกส์', day: 2, start: '08:30', end: '09:20', reminderEnabled: true, reminderMinutes: null },
    { id: 'c3', groupId: null, subject: 'เคารพธงชาติ', day: 2, start: '07:50', end: '08:10', reminderEnabled: true, reminderMinutes: 5 },
  ],
  recipients: [
    { id: 'U' + 'a'.repeat(32), type: 'user', groupId: 'g41', enabled: true },
    { id: 'U' + 'b'.repeat(32), type: 'user', groupId: 'g42', enabled: true },
    { id: 'C' + 'c'.repeat(32), type: 'group', groupId: 'g41', enabled: true },
    { id: 'U' + 'd'.repeat(32), type: 'user', groupId: 'g41', enabled: false },
  ],
  specialDays: [
    { id: 's1', name: 'วันลอยกระทง', type: 'holiday', start: '2026-11-24', end: '2026-11-24', suspendClasses: true },
    { id: 's2', name: 'ปิดภาคเรียน', type: 'semester_break', start: '2026-12-01', end: '2026-12-06', suspendClasses: true },
    { id: 's3', name: 'กีฬาสี', type: 'activity', start: '2026-12-08', end: '2026-12-08', suspendClasses: false },
  ],
  ...o,
});

test('ปฏิทิน: วันที่ไทย ช่วงวัน และวันเปิดเรียนถัดไป', () => {
  assert.equal(cal.thaiDate('2026-11-02'), '2 พฤศจิกายน 2569');
  assert.equal(cal.thaiDate('2026-11-02', { weekday: true }), 'วันจันทร์ที่ 2 พฤศจิกายน 2569');
  assert.equal(cal.thaiRange('2026-12-01', '2026-12-06'), '1 ธ.ค. 2569 – 6 ธ.ค. 2569');
  const db = mkDb();
  assert.ok(cal.isSuspended(db, '2026-12-03'));
  assert.ok(!cal.isSuspended(db, '2026-12-08'), 'วันกิจกรรมที่ไม่งดเรียน');
  assert.equal(cal.nextSchoolDay(db, '2026-12-06'), '2026-12-07'); // อาทิตย์ 6 → จันทร์ 7
  assert.equal(cal.nextSchoolDay(db, '2026-11-24'), '2026-11-25');
});

test('ไม่แจ้งเตือนคาบเรียนในวันหยุดทั้งโรงเรียน', () => {
  const db = mkDb();
  // อังคารปกติ 08:20 = 10 นาทีก่อนคาบของทั้ง ม.4/1 และ ม.4/2
  assert.deepEqual(scheduler.dueReminders(db, at('08:20', '2026-11-17')).map((d) => d.cls.id).sort(), ['c1', 'c2']);
  assert.equal(scheduler.dueReminders(db, at('08:20', '2026-11-24')).length, 0); // อังคาร วันลอยกระทง
  assert.equal(scheduler.dueReminders(db, at('08:20', '2026-12-01')).length, 0); // ปิดภาค
});

test('ประกาศวันหยุด 08:00 ทุกวันในช่วงหยุด ส่งวันละครั้ง', () => {
  const db = mkDb();
  assert.equal(scheduler.dueAnnouncements(db, at('07:59', '2026-12-02')).length, 0);
  const a = scheduler.dueAnnouncements(db, at('08:00', '2026-12-02'));
  assert.equal(a.length, 1);
  assert.equal(a[0].sd.id, 's2');
  assert.equal(a[0].key, 'announce@2026-12-02');
  db.sent[a[0].key] = 1;
  assert.equal(scheduler.dueAnnouncements(db, at('08:30', '2026-12-02')).length, 0);
  assert.equal(scheduler.dueAnnouncements(db, at('08:00', '2026-12-03')).length, 1, 'วันถัดไปในช่วงหยุดก็แจ้งอีก');
  assert.equal(scheduler.dueAnnouncements(db, at('08:00', '2026-11-30')).length, 0, 'ไม่แจ้งล่วงหน้าถ้าปิดไว้');
  db.settings.announceEve = true;
  const eve = scheduler.dueAnnouncements(db, at('08:00', '2026-11-30'));
  assert.equal(eve[0].mode, 'tomorrow');
  db.settings.announceEnabled = false;
  assert.equal(scheduler.dueAnnouncements(db, at('08:00', '2026-12-02')).length, 0);
});

test('ส่งแจ้งเตือนคาบเฉพาะผู้รับของ ม./ห้อง นั้น', async (t) => {
  const calls = [];
  t.mock.method(line, 'multicast', async (s, ids) => { calls.push(['multicast', ids]); });
  t.mock.method(line, 'push', async (s, to) => { calls.push(['push', to]); });
  const db = mkDb();
  const detail = await notify.sendForClass(db, db.classes[0], [{ type: 'text', text: 'x' }]);
  assert.match(detail, /ส่งถึงห้อง 2/);
  assert.deepEqual(calls, [['multicast', ['U' + 'a'.repeat(32)]], ['push', 'C' + 'c'.repeat(32)]]);
  await assert.rejects(notify.sendForClass({ ...db, recipients: [] }, db.classes[0], []), /ยังไม่มีผู้รับ/);
});

test('ประกาศทั้งโรงเรียน: broadcast + กลุ่มแชท', async (t) => {
  const calls = [];
  t.mock.method(line, 'broadcast', async () => { calls.push('broadcast'); });
  t.mock.method(line, 'push', async (s, to) => { calls.push(to); });
  const db = mkDb();
  db.settings.line.sendMode = 'broadcast';
  const d = await notify.sendToAll(db, []);
  assert.deepEqual(calls, ['broadcast', 'C' + 'c'.repeat(32)]);
  assert.match(d, /broadcast \+ 1 กลุ่ม/);
});

test('ริชเมนู: สร้างครบทุกห้อง ผูกผู้ใช้ตามห้อง ลบเมนูเก่า', async (t) => {
  const made = [], linked = [], removed = [];
  let def = null, n = 0;
  t.mock.method(line.richMenu, 'create', async (s, menu) => { made.push(menu); return { richMenuId: `rm${++n}` }; });
  t.mock.method(line.richMenu, 'upload', async (s, id, png) => { assert.ok(png.length > 1000 && png.length < 1024 * 1024); });
  t.mock.method(line.richMenu, 'setDefault', async (s, id) => { def = id; });
  t.mock.method(line.richMenu, 'bulkLink', async (s, id, users) => { linked.push([id, users]); });
  t.mock.method(line.richMenu, 'remove', async (s, id) => { removed.push(id); });
  const db = mkDb();
  db.settings.richMenu.menus = { _default: 'old1', g41: 'old2' };
  const r = await richmenu.rebuild(db);
  assert.equal(r.menus, 3);
  assert.equal(def, 'rm1');
  assert.deepEqual(linked, [['rm2', ['U' + 'a'.repeat(32)]], ['rm3', ['U' + 'b'.repeat(32)]]]);
  assert.deepEqual(removed.sort(), ['old1', 'old2']);
  assert.deepEqual(db.settings.richMenu.menus, { _default: 'rm1', g41: 'rm2', g42: 'rm3' });
  const m = made[1];
  assert.equal(m.size.width, 2500);
  assert.equal(m.areas.length, 7);
  assert.ok(m.chatBarText.length <= 14);
  for (const a of m.areas) {
    assert.ok(a.bounds.x + a.bounds.width <= 2500 && a.bounds.y + a.bounds.height <= 1686);
    assert.ok(a.action.label.length <= 20);
  }
  assert.ok(!scheduler.richMenuNeeded(db), 'สร้างแล้ววันนี้ไม่ต้องสร้างซ้ำ');
  db.settings.richMenu.dirtyAt = Date.now() - 60000;
  assert.ok(scheduler.richMenuNeeded(db), 'ข้อมูลเปลี่ยน → สร้างใหม่');
});

test('ริชเมนู: แถบ "พรุ่งนี้หยุด" และ "วันนี้หยุดเรียน"', () => {
  const db = mkDb();
  assert.match(richmenu.buildSvg(db, 'g41', '2026-11-23'), /พรุ่งนี้หยุด: วันลอยกระทง/);
  assert.match(richmenu.buildSvg(db, 'g41', '2026-11-24'), /วันนี้หยุดเรียน: วันลอยกระทง · เปิดเรียน 25 พ.ย. 2569/);
  assert.match(richmenu.buildSvg(db, 'g41', '2026-11-17'), /วันนี้มี 2 คาบ/); // คณิต + คาบรวมทุกห้อง
  assert.match(richmenu.buildSvg(db, 'g41', '2026-11-17'), /fill="#ec407a"/); // อังคารสีชมพู
});

test('ตอบคำสั่ง LINE ตามชั้นเรียนของผู้ส่ง และวันหยุด', (t) => {
  const app = require('../server');
  const reply = app.locals.keywordReply;
  const db = mkDb();
  const r41 = db.recipients[0];
  // จำลองวันนี้ = อังคาร 17 พ.ย. 2569 08:00
  t.mock.method(Date, 'now', () => at('08:00', '2026-11-17').getTime());
  const RealDate = Date;
  t.mock.method(global, 'Date', function (...a) { return a.length ? new RealDate(...a) : new RealDate(at('08:00', '2026-11-17')); });
  Object.assign(global.Date, { UTC: RealDate.UTC, parse: RealDate.parse, now: () => at('08:00', '2026-11-17').getTime() });

  const today = reply(db, 'ตารางวันนี้', r41);
  const subjects = JSON.stringify(today);
  assert.match(subjects, /คณิต/);
  assert.match(subjects, /เคารพธงชาติ/, 'คาบร่วมทุกห้อง');
  assert.doesNotMatch(subjects, /ฟิสิกส์/, 'ไม่เห็นคาบของ ม.4/2');
  assert.match(today[0].contents.header.contents[1].text, /ม\.4\/1/);

  const week = reply(db, 'ตารางทั้งสัปดาห์', r41);
  assert.equal(week[0].contents.type, 'carousel');
  assert.equal(week[0].contents.contents.length, 5);

  const holidays = reply(db, 'วันหยุด', r41);
  assert.match(JSON.stringify(holidays), /วันลอยกระทง/);

  const unassigned = reply(db, 'ตารางวันนี้', { id: 'U' + 'e'.repeat(32), type: 'user' });
  assert.match(JSON.stringify(unassigned), /ยังไม่ได้ผูกกับชั้นเรียน/);
  assert.match(JSON.stringify(reply(db, 'ห้องของฉัน', r41)), /ม\.4\/1/);
  assert.equal(reply(db, 'สวัสดี', r41), null);
});

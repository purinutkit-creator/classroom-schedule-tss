'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
const { dueReminders } = require('../src/scheduler');
const line = require('../src/line');

const settings = { timezone: 'Asia/Bangkok', defaultReminderMinutes: 10, accentColor: '#4f46e5', appName: 'ตารางสอน' };
// 2026-11-02 เป็นวันจันทร์ ; 08:20 เวลาไทย = 01:20 UTC
const at = (hhmm, day = '2026-11-02') => new Date(`${day}T${hhmm}:00+07:00`);
const mk = (o) => ({ id: 'c1', subject: 'คณิต', day: 1, start: '08:30', end: '09:20', reminderEnabled: true, reminderMinutes: null, ...o });

test('แจ้งเตือนตรงเวลาตามค่าเริ่มต้น 10 นาที', () => {
  const db = { settings, classes: [mk()], sent: {} };
  assert.equal(dueReminders(db, at('08:19')).length, 0);
  const due = dueReminders(db, at('08:20'));
  assert.equal(due.length, 1);
  assert.equal(due[0].minutesBefore, 10);
  assert.equal(due[0].key, 'c1@2026-11-02');
});

test('ส่งครั้งเดียว และไม่ส่งย้อนหลังเกิน 5 นาที', () => {
  const db = { settings, classes: [mk()], sent: { 'c1@2026-11-02': 1 } };
  assert.equal(dueReminders(db, at('08:21')).length, 0);
  assert.equal(dueReminders({ settings, classes: [mk()], sent: {} }, at('08:26')).length, 0);
});

test('ตั้งนาทีรายคาบ และแจ้งข้ามเที่ยงคืน', () => {
  const db = { settings, classes: [mk({ reminderMinutes: 30 }), mk({ id: 'c2', day: 2, start: '00:10', reminderMinutes: 20 })], sent: {} };
  assert.equal(dueReminders(db, at('08:00'))[0].cls.id, 'c1');
  const cross = dueReminders(db, at('23:50'));
  assert.equal(cross.length, 1);
  assert.equal(cross[0].key, 'c2@2026-11-03');
});

test('ปิดแจ้งเตือนรายคาบ', () => {
  assert.equal(dueReminders({ settings, classes: [mk({ reminderEnabled: false })], sent: {} }, at('08:20')).length, 0);
});

test('ตรวจลายเซ็น webhook', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = crypto.createHmac('sha256', 's3cret').update(body).digest('base64');
  assert.ok(line.verifySignature('s3cret', body, sig));
  assert.ok(!line.verifySignature('wrong', body, sig));
});

test('Flex Message มีปุ่มนำทาง Google Maps', () => {
  const room = { name: 'ห้อง 301', lat: 13.75, lng: 100.5 };
  const msg = line.reminderMessage(mk({ color: '#ef4444' }), room, 10, settings);
  assert.equal(msg.type, 'flex');
  assert.match(msg.altText, /อีก 10 นาที.*ห้อง 301/);
  const btn = msg.contents.footer.contents[0];
  assert.equal(btn.action.uri, 'https://www.google.com/maps/dir/?api=1&destination=13.75,100.5&travelmode=walking');
});

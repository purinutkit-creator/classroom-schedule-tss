'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vision-'));
delete process.env.DATABASE_URL;
const vision = require('../src/vision');
const store = require('../src/store');
const app = require('../server');

const db = {
  rooms: [{ id: 'r1', name: 'ห้อง 301' }, { id: 'r2', name: 'Lab Com 1' }],
  classes: [{ id: 'c1', subject: 'คณิตศาสตร์', day: 1, start: '08:30', end: '10:10' }],
};
const e = (o) => ({ subject: 'ภาษาไทย', code: '', teacher: '', room: '', day: 2, start: '08:30', end: '09:20', confidence: 'high', remark: '', ...o });

test('แปลงรูปแบบเวลา', () => {
  assert.equal(vision.fixTime('8.30'), '08:30');
  assert.equal(vision.fixTime('13:00 น.'), '13:00');
  assert.equal(vision.fixTime('25:00'), '');
  assert.equal(vision.fixTime(''), '');
});

test('จับคู่ห้องที่มีอยู่แบบยืดหยุ่น', () => {
  assert.equal(vision.findRoom(db.rooms, '301').id, 'r1');
  assert.equal(vision.findRoom(db.rooms, 'ห้อง301').id, 'r1');
  assert.equal(vision.findRoom(db.rooms, 'lab com 1').id, 'r2');
  assert.equal(vision.findRoom(db.rooms, '999'), null);
});

test('ตรวจสอบ: พร้อมเพิ่ม / ซ้ำ / ชน / ไม่ครบ / ชนกันเองในรูป', () => {
  const out = vision.review([
    e({ room: '301' }),
    e({ subject: 'คณิตศาสตร์', day: 1, start: '08:30', end: '10:10' }),
    e({ subject: 'อังกฤษ', day: 1, start: '09:00', end: '10:00' }),
    e({ subject: 'สังคม', start: '10:00', end: '09:00' }),
    e({ subject: 'ศิลปะ', day: 2, start: '09:20', end: '10:10' }),
    e({ subject: 'ดนตรี', day: 2, start: '09:30', end: '10:20', room: 'ห้องดนตรี' }),
  ], db);
  const by = Object.fromEntries(out.map((x) => [x.subject, x]));
  assert.equal(by['ภาษาไทย'].status, 'ok');
  assert.equal(by['ภาษาไทย'].roomId, 'r1');
  assert.equal(by['คณิตศาสตร์'].status, 'duplicate');
  assert.equal(by['อังกฤษ'].status, 'conflict');
  assert.equal(by['สังคม'].status, 'invalid');
  assert.equal(by['ศิลปะ'].status, 'ok');
  assert.equal(by['ดนตรี'].status, 'conflict');
  assert.equal(by['ดนตรี'].newRoom, true);
});

test('ไม่มี API key → แจ้งให้ตั้งค่า', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(vision.extractFromImage({ ai: {} }, { data: 'x', mediaType: 'image/png' }), /API Key/);
});

test('อัปโหลดรูป → ตรวจ → เพิ่มอัตโนมัติ และสร้างห้องใหม่', async () => {
  await store.init();
  const before = store.db.classes.length;
  vision.extractFromImage = async () => ({
    model: 'stub', warnings: [],
    entries: [
      e({ subject: 'ฟิสิกส์', day: 4, start: '08:30', end: '10:10', room: 'ห้อง 301', teacher: 'ครูเอ' }),
      e({ subject: 'เคมี', day: 4, start: '10:20', end: '12:00', room: 'Lab วิทย์ 2' }),
      e({ subject: 'ชีวะ', day: 4, start: '11:00', end: '11:50' }),
    ],
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fd = new FormData();
    fd.append('image', new Blob([Buffer.from('fakepng')], { type: 'image/png' }), 't.png');
    fd.append('auto', '1');
    const r = await (await fetch(base + '/api/vision/analyze', { method: 'POST', body: fd })).json();
    const st = Object.fromEntries(r.entries.map((x) => [x.subject, x.status]));
    assert.deepEqual(st, { 'ฟิสิกส์': 'added', 'เคมี': 'added', 'ชีวะ': 'conflict' });
    assert.equal(r.commit.added.length, 2);
    assert.deepEqual(r.commit.createdRooms, ['Lab วิทย์ 2']);
    assert.equal(store.db.classes.length, before + 2);
    assert.ok(store.db.classes.find((c) => c.subject === 'ฟิสิกส์').roomId);

    // เพิ่มรายการที่ผู้ใช้แก้แล้วด้วยตัวเอง
    const c = await (await fetch(base + '/api/vision/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ subject: 'ชีวะ', day: 4, start: '13:00', end: '13:50' }, { subject: 'ผิด', day: 4, start: '14:00', end: '13:00' }] }),
    })).json();
    assert.deepEqual(c.results.map((x) => x.ok), [true, false]);

    const bad = await fetch(base + '/api/vision/analyze', { method: 'POST', body: (() => { const f = new FormData(); f.append('image', new Blob(['x'], { type: 'text/plain' }), 'a.txt'); return f; })() });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

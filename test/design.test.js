'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-design-'));
delete process.env.DATABASE_URL;
const store = require('../src/store');
const members = require('../src/members');
const richmenu = require('../src/richmenu');
const line = require('../src/line');
const jpeg = require('jpeg-js');

const mkDb = () => ({
  settings: { timezone: 'Asia/Bangkok', visibleDays: [1, 2, 3, 4, 5], schoolName: 'Thammasat Secondary School', appName: 'ตารางสอน', accentColor: '#4f46e5', richMenu: { enabled: true, menus: {} } },
  groups: [{ id: 'g1', name: 'ม.4/1' }], rooms: [], fonts: [], sent: {}, history: [],
  classes: [{ id: 'c1', groupId: 'g1', subject: 'คณิต', day: 2, start: '08:30', end: '09:20' }],
  recipients: [{ id: 'U' + 'a'.repeat(32), type: 'user' }, { id: 'U' + 'b'.repeat(32), type: 'user', code: '123456' }],
  specialDays: [{ id: 's1', name: 'วันลอยกระทง', type: 'holiday', start: '2026-11-24', end: '2026-11-24', suspendClasses: true }],
});

test('รหัสสมาชิก 6 หลัก: ไม่ซ้ำ เติมให้บัญชีเดิม และค้นหาได้', () => {
  const db = mkDb();
  assert.equal(members.ensureCodes(db), 1);
  assert.match(db.recipients[0].code, /^\d{6}$/);
  assert.equal(db.recipients[1].code, '123456', 'รหัสเดิมไม่เปลี่ยน');
  assert.notEqual(db.recipients[0].code, '123456');
  assert.equal(members.findByCode(db, '123 456').id, 'U' + 'b'.repeat(32));
  assert.equal(members.findByCode(db, '12345'), null);
  const codes = new Set();
  const big = { recipients: [] };
  for (let i = 0; i < 2000; i++) { const c = members.genCode(big); big.recipients.push({ code: c }); codes.add(c); }
  assert.equal(codes.size, 2000);
});

test('บัตรรหัสสมาชิกใน LINE: ยังไม่เข้าห้อง / เข้าห้องแล้ว', () => {
  const db = mkDb();
  const r = db.recipients[1];
  const card = line.memberCardMessage(r, null, db);
  assert.match(card.altText, /123456/);
  assert.match(JSON.stringify(card), /ยังไม่ได้เข้าชั้นเรียน/);
  assert.equal(card.contents.footer.contents[0].action.type, 'clipboard');
  assert.equal(card.contents.footer.contents[0].action.clipboardText, '123456');
  assert.match(JSON.stringify(line.memberCardMessage(r, db.groups[0], db)), /อยู่ในชั้นเรียน ม\.4\/1/);
});

test('เพิ่มบัญชีเข้าห้องด้วยรหัส (API)', async () => {
  await store.init();
  const app = require('../server');
  const db = store.db;
  db.groups.push({ id: 'gx', name: 'ม.6/2' });
  db.recipients.push({ id: 'U' + 'c'.repeat(32), type: 'user', name: 'นักเรียน', enabled: true, code: '654321' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/members/assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const ok = await post({ code: '654321', groupId: 'gx' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).group, 'ม.6/2');
    assert.equal(db.recipients.find((r) => r.code === '654321').groupId, 'gx');
    assert.equal((await post({ code: '000000', groupId: 'gx' })).status, 404);
    assert.equal((await post({ code: '12', groupId: 'gx' })).status, 400);
    assert.equal((await post({ code: '654321', groupId: 'nope' })).status, 400);
    const reply = app.locals.keywordReply(db, 'รหัส', db.recipients.find((r) => r.code === '654321'));
    assert.match(JSON.stringify(reply), /654321/);
    assert.match(JSON.stringify(reply), /ม\.6\/2/);
  } finally { server.close(); }
});

test('การออกแบบ: ค่าที่ผิดถูกแก้ให้ถูก และจำนวนปุ่มตามรูปแบบ', () => {
  const d = richmenu.normalizeDesign({ layout: 'grid4', colorMode: 'custom', colors: { header: 'red', accent: '#123456' }, radius: 999, buttons: [{ action: 'link', url: 'javascript:x' }, { action: 'link', url: 'https://school.ac.th' }, { action: 'nope' }] });
  assert.equal(d.buttons.length, 4);
  assert.equal(d.buttons[0].action, 'today', 'ลิงก์ที่ไม่ใช่ https ใช้ไม่ได้');
  assert.equal(d.buttons[1].url, 'https://school.ac.th');
  assert.equal(d.buttons[2].action, 'today');
  assert.equal(d.colors.header, '#4f46e5');
  assert.equal(d.colors.accent, '#123456');
  assert.equal(d.radius, 90);
  assert.equal(richmenu.normalizeDesign({ layout: 'compact3' }).buttons.length, 3);
});

test('ทุกรูปแบบ: ขนาดรูป พื้นที่กด และลิงก์ถูกต้อง', async () => {
  const db = mkDb();
  for (const layout of Object.keys(richmenu.LAYOUTS)) {
    const design = { layout, buttons: [{ action: 'today' }, { action: 'link', url: 'https://school.ac.th', label: 'เว็บโรงเรียน' }, { action: 'me' }, { action: 'code' }, { action: 'week' }, { action: 'holiday' }] };
    const img = await richmenu.renderMenu(db, 'g1', '2026-11-23', design);
    assert.ok(img.data.length <= 1024 * 1024, layout);
    const def = richmenu.menuDefinition(db, 'g1', '2026-11-23', design);
    assert.equal(def.size.height, richmenu.LAYOUTS[layout].h);
    assert.equal(def.areas.length, richmenu.LAYOUTS[layout].slots + 1);
    for (const a of def.areas) {
      assert.ok(a.bounds.x >= 0 && a.bounds.y >= 0 && a.bounds.x + a.bounds.width <= 2500 && a.bounds.y + a.bounds.height <= def.size.height, `${layout} area`);
      assert.ok(a.action.label.length <= 20);
    }
    assert.deepEqual(def.areas[2].action, { type: 'uri', label: 'เว็บโรงเรียน', uri: 'https://school.ac.th' });
  }
});

test('เมนูค่าเริ่มต้น: ปุ่ม "ห้องของฉัน" กลายเป็น "รหัสสมาชิก"', () => {
  const db = mkDb();
  const svg = richmenu.buildSvg(db, null, '2026-11-17');
  assert.match(svg, /รหัสสมาชิก/);
  assert.match(svg, /แตะเพื่อดูรหัสสมาชิก/);
  assert.match(richmenu.buildSvg(db, 'g1', '2026-11-17'), /ห้องของฉัน/);
});

test('สีที่ตั้งเอง และรูปพื้นหลังขนาดใหญ่ถูกบีบเป็น JPEG ไม่เกิน 1MB', async () => {
  const db = mkDb();
  const w = 1600, h = 900, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = Math.random() * 255; px[i + 1] = Math.random() * 255; px[i + 2] = Math.random() * 255; px[i + 3] = 255; }
  fs.writeFileSync(path.join(store.FONT_DIR, 'img-noise.jpg'), jpeg.encode({ data: px, width: w, height: h }, 95).data);
  const design = { colorMode: 'custom', colors: { header: '#0f766e', headerText: '#ffffff', accent: '#0f766e', page: '#ecfeff', button: '#ffffff', buttonText: '#134e4a', subText: '#5f7d7a' }, bgFile: 'img-noise.jpg', bgOverlay: 0.1 };
  const svg = richmenu.buildSvg(db, 'g1', '2026-11-17', design);
  assert.match(svg, /fill="#0f766e"/);
  assert.match(svg, /data:image\/jpeg;base64/);
  const img = await richmenu.renderMenu(db, 'g1', '2026-11-17', design);
  assert.equal(img.contentType, 'image/jpeg');
  assert.ok(img.data.length <= 1024 * 1024);
});

test('ฟอนต์ที่อัปโหลดเป็น woff2 ใช้กับริชเมนูไม่ได้ → ใช้ Prompt พร้อมคำเตือน', async () => {
  const db = mkDb();
  db.fonts.push({ id: 'f1', family: 'MyFont', file: 'x.woff2' });
  const img = await richmenu.renderMenu(db, 'g1', '2026-11-17', { font: { source: 'custom', customFontId: 'f1' } });
  assert.match(img.warning, /\.ttf/);
  assert.ok(img.data.length > 1000);
});

test('ริชเมนูส่วนตัว: มีรหัสสมาชิกของแต่ละคน ผูกรายคน และไม่ถูก bulk link ทับ', async (t) => {
  const db = mkDb();
  db.recipients = [
    { id: 'U' + '1'.repeat(32), type: 'user', code: '111111', groupId: 'g1', enabled: true },
    { id: 'U' + '2'.repeat(32), type: 'user', code: '222222', enabled: true },
    { id: 'U' + '3'.repeat(32), type: 'user', code: '333333', groupId: 'g1', left: true },
    { id: 'C' + '4'.repeat(32), type: 'group', code: '444444', groupId: 'g1', enabled: true },
  ];
  db.settings.richMenu.personal = { ['U' + '2'.repeat(32)]: 'oldP' };
  let n = 0;
  const made = [], linkedOne = [], bulk = [], removed = [];
  t.mock.method(line.richMenu, 'create', async (s, m) => { made.push(m.name); return { richMenuId: `rm${++n}` }; });
  t.mock.method(line.richMenu, 'upload', async () => {});
  t.mock.method(line.richMenu, 'setDefault', async () => {});
  t.mock.method(line.richMenu, 'bulkLink', async (s, id, users) => { bulk.push(...users); });
  t.mock.method(line.richMenu, 'linkUser', async (s, uid, id) => { linkedOne.push([uid, id]); });
  t.mock.method(line.richMenu, 'remove', async (s, id) => { removed.push(id); });
  const r = await richmenu.rebuild(db);
  assert.equal(r.personal, 2);
  assert.deepEqual(bulk, [], 'คนที่มีเมนูส่วนตัวไม่ถูกผูกแบบกลุ่ม');
  assert.deepEqual(linkedOne.map((x) => x[0]).sort(), ['U' + '1'.repeat(32), 'U' + '2'.repeat(32)]);
  assert.ok(made.some((m) => /#111111/.test(m)) && made.some((m) => /#222222/.test(m)));
  assert.ok(removed.includes('oldP'));
  // เฉพาะคนที่ยังไม่เข้าห้อง
  db.settings.richMenu.design = { memberCode: 'unassigned' };
  assert.deepEqual(richmenu.personalTargets(db).users.map((x) => x.code), ['222222']);
  db.settings.richMenu.design = { memberCode: 'off' };
  assert.equal(richmenu.personalTargets(db).users.length, 0);
});

test('ริชเมนูส่วนตัว: จำกัดจำนวนตามเพดานของ LINE และให้คนที่ยังไม่เข้าห้องก่อน', () => {
  const db = mkDb();
  db.recipients = [];
  for (let i = 0; i < 1000; i++) db.recipients.push({ id: `U${String(i).padStart(32, '0')}`, type: 'user', code: String(100000 + i), groupId: i < 900 ? 'g1' : null });
  const { users, skipped } = richmenu.personalTargets(db);
  assert.equal(users.length, richmenu.MAX_MENUS - 2);
  assert.equal(skipped, 1000 - users.length);
  assert.ok(users.slice(0, 100).every((r) => !r.groupId), 'คนที่ยังไม่เข้าห้องได้ก่อน');
});

test('รหัสสมาชิกแสดงบนแถบด้านบนของเมนู', () => {
  const db = mkDb();
  const svg = richmenu.buildSvg(db, null, '2026-11-17', null, 'Prompt', { code: '482913' });
  assert.match(svg, /รหัสสมาชิก/);
  assert.match(svg, /letter-spacing="[0-9.]+">482913</);
  assert.match(svg, /รหัส 482913/, 'ปุ่มรหัสสมาชิกแสดงรหัสด้วย');
  assert.doesNotMatch(richmenu.buildSvg(db, null, "2026-11-17"), />482913</);
});

test('ผู้ใช้ที่ทักมา (ไม่เคยถูกบันทึก) ได้รหัส + เมนูส่วนตัวทันที แม้ปิดเพิ่มผู้รับอัตโนมัติ', async (t) => {
  await store.init();
  const app = require('../server');
  const crypto = require('crypto');
  const db = store.db;
  db.settings.line.channelSecret = 'sec';
  db.settings.line.channelAccessToken = 'tok';
  db.settings.line.autoAddFollowers = false;
  db.settings.richMenu = { ...db.settings.richMenu, enabled: true, builtFor: richmenu.todayKeyOf(db), menus: {}, personal: {}, design: { memberCode: 'all' } };
  const replies = [], linked = [];
  t.mock.method(line, 'reply', async (s, tok, msgs) => { replies.push(msgs); });
  t.mock.method(line, 'profile', async () => ({ displayName: 'นักเรียนใหม่' }));
  t.mock.method(line.richMenu, 'create', async () => ({ richMenuId: 'rmP' }));
  t.mock.method(line.richMenu, 'upload', async () => {});
  t.mock.method(line.richMenu, 'linkUser', async (s, uid, id) => { linked.push([uid, id]); });
  t.mock.method(line.richMenu, 'remove', async () => {});
  const uid = 'U' + 'f'.repeat(32);
  const body = JSON.stringify({ events: [{ type: 'message', replyToken: 'r1', source: { type: 'user', userId: uid }, message: { type: 'text', text: 'รหัส' } }] });
  const sig = crypto.createHmac('sha256', 'sec').update(body).digest('base64');
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook/line`, { method: 'POST', headers: { 'x-line-signature': sig, 'content-type': 'application/json' }, body });
    assert.equal(res.status, 200);
    for (let i = 0; i < 50 && !linked.length; i++) await new Promise((r) => setTimeout(r, 20));
  } finally { server.close(); }
  const r = db.recipients.find((x) => x.id === uid);
  assert.ok(r, 'บันทึกบัญชีแล้ว');
  assert.match(r.code, /^\d{6}$/);
  assert.equal(r.enabled, false, 'ปิดเพิ่มผู้รับอัตโนมัติ: ยังไม่ส่งแจ้งเตือน');
  assert.deepEqual(linked, [[uid, 'rmP']], 'ผูกเมนูส่วนตัวแล้ว');
  assert.equal(db.settings.richMenu.personal[uid], 'rmP');
  assert.match(JSON.stringify(replies[0]), new RegExp(r.code), 'ตอบบัตรรหัสสมาชิก');
});

'use strict';
// ส่งข้อความให้ถูกคน: ตามชั้น/ห้อง (ม.) หรือทั้งโรงเรียน
const line = require('./line');

const active = (r) => r.enabled !== false && !r.left;

function recipientsOfGroup(db, groupId) {
  return db.recipients.filter((r) => active(r) && r.groupId === groupId);
}

/** ส่งถึงรายชื่อผู้รับ: ผู้ใช้ส่งแบบ multicast ส่วนกลุ่ม/ห้องแชทส่งแบบ push ทีละรายการ */
async function sendTo(settings, recipients, messages) {
  const users = recipients.filter((r) => r.type === 'user').map((r) => r.id);
  const chats = recipients.filter((r) => r.type !== 'user');
  let sent = 0, failed = 0;
  const errors = [];
  if (users.length) {
    try { await line.multicast(settings, users, messages); sent += users.length; } catch (e) { failed += users.length; errors.push(e.message); }
  }
  for (const c of chats) {
    try { await line.push(settings, c.id, messages); sent++; } catch (e) { failed++; errors.push(e.message); }
  }
  if (!sent && failed) throw new Error(errors[0]);
  return { sent, failed };
}

/** ส่งถึงทั้งโรงเรียน: Broadcast (เพื่อนทุกคน) + กลุ่มแชท หรือ push ถึงผู้รับที่เปิดไว้ทั้งหมด */
async function sendToAll(db, messages) {
  const { settings } = db;
  if (settings.line.sendMode === 'broadcast') {
    await line.broadcast(settings, messages);
    const chats = db.recipients.filter((r) => active(r) && r.type !== 'user');
    let extra = 0;
    for (const c of chats) { try { await line.push(settings, c.id, messages); extra++; } catch { /* กลุ่มที่บอทออกไปแล้ว */ } }
    return `broadcast${extra ? ` + ${extra} กลุ่ม` : ''}`;
  }
  const list = db.recipients.filter(active);
  if (!list.length) throw new Error('ยังไม่มีผู้รับที่เปิดใช้งาน');
  const r = await sendTo(settings, list, messages);
  return `ส่งสำเร็จ ${r.sent} / ล้มเหลว ${r.failed}`;
}

/** ส่งแจ้งเตือนของคาบเรียน: คาบที่ผูกกับชั้น/ห้อง → เฉพาะผู้รับของห้องนั้น */
async function sendForClass(db, cls, messages) {
  if (cls.groupId) {
    const list = recipientsOfGroup(db, cls.groupId);
    if (!list.length) throw new Error('ยังไม่มีผู้รับที่ผูกกับชั้นเรียนนี้');
    const r = await sendTo(db.settings, list, messages);
    return `ส่งถึงห้อง ${r.sent} / ล้มเหลว ${r.failed}`;
  }
  const result = await line.send(db.settings, db.recipients, messages);
  return result.mode === 'push' ? `push สำเร็จ ${result.sent} / ล้มเหลว ${result.failed}` : 'broadcast';
}

module.exports = { recipientsOfGroup, sendTo, sendToAll, sendForClass, active };

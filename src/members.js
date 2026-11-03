'use strict';
// รหัสสมาชิก 6 หลัก: ผู้ใช้/กลุ่ม LINE ทุกบัญชีมีรหัสของตัวเอง ครูใส่รหัสนี้เพื่อเพิ่มเข้าชั้นเรียน
const crypto = require('crypto');

function genCode(db) {
  const used = new Set(db.recipients.map((r) => r.code).filter(Boolean));
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!used.has(code)) return code;
  }
  throw new Error('สร้างรหัสสมาชิกไม่ได้');
}

/** เติมรหัสให้บัญชีเดิมที่ยังไม่มี (คืนจำนวนที่เติม) */
function ensureCodes(db) {
  let n = 0;
  for (const r of db.recipients) if (!/^\d{6}$/.test(r.code || '')) { r.code = genCode(db); n++; }
  return n;
}

const normalizeCode = (s) => String(s || '').replace(/\D/g, '');

function findByCode(db, code) {
  const c = normalizeCode(code);
  return c.length === 6 ? db.recipients.find((r) => r.code === c) || null : null;
}

module.exports = { genCode, ensureCodes, findByCode, normalizeCode };

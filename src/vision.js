'use strict';
// v2.0: อ่านตารางสอนจากรูปภาพด้วย Claude (vision + structured output) แล้วตรวจสอบก่อนเพิ่มเข้าระบบ
const Anthropic = require('@anthropic-ai/sdk');
const { toMin, isValidTime } = require('./time');

const MODEL = 'claude-opus-5-5';
const AnthropicClient = Anthropic.default || Anthropic;

const SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'ชื่อวิชาตามที่เขียนในรูป' },
          code: { type: 'string', description: 'รหัสวิชา หรือ "" ถ้าไม่มี' },
          teacher: { type: 'string', description: 'ชื่อผู้สอน หรือ "" ถ้าไม่มี' },
          room: { type: 'string', description: 'ห้องเรียน/สถานที่ หรือ "" ถ้าไม่มี' },
          day: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6], description: '0=อาทิตย์ 1=จันทร์ ... 6=เสาร์' },
          start: { type: 'string', description: 'เวลาเริ่ม HH:MM (24 ชม.)' },
          end: { type: 'string', description: 'เวลาเลิก HH:MM (24 ชม.)' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          remark: { type: 'string', description: 'ข้อสังเกตเมื่ออ่านไม่ชัดหรือต้องเดา หรือ ""' },
        },
        required: ['subject', 'code', 'teacher', 'room', 'day', 'start', 'end', 'confidence', 'remark'],
        additionalProperties: false,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['entries', 'warnings'],
  additionalProperties: false,
};

const PROMPT = `รูปนี้คือตารางเรียน/ตารางสอนรายสัปดาห์ (ส่วนใหญ่เป็นภาษาไทย) ให้ถอดทุกคาบเรียนออกมาเป็นรายการ

หลักการ:
- หนึ่งรายการ = วิชาหนึ่งในวันหนึ่งช่วงเวลาหนึ่ง ถ้าวิชาเดียวกันอยู่ติดกันหลายคาบในวันเดียวกัน ให้รวมเป็นรายการเดียว (เริ่มคาบแรก เลิกคาบสุดท้าย)
- เวลาใช้รูปแบบ 24 ชั่วโมง HH:MM เช่น 08:30, 13:00 ถ้าตารางระบุเป็น "คาบที่" ให้แปลงเป็นเวลาจากหัวตาราง ถ้าในรูปไม่มีเวลาเลยให้ใช้ข้อมูลเพิ่มเติมจากผู้ใช้ (ถ้ามี) หรือเดาอย่างสมเหตุสมผลแล้วตั้ง confidence เป็น low และอธิบายใน remark
- day: 0=อาทิตย์ 1=จันทร์ 2=อังคาร 3=พุธ 4=พฤหัสบดี 5=ศุกร์ 6=เสาร์ (อักษรย่อ จ. อ. พ. พฤ. ศ. ส. อา. หรือ Mon–Sun)
- ข้ามช่องที่ไม่ใช่คาบเรียน เช่น พักกลางวัน พักเที่ยง โฮมรูม (ยกเว้นผู้ใช้ขอ) ช่องว่าง
- คัดลอกชื่อวิชา รหัสวิชา ผู้สอน ห้อง ตามที่เขียนในรูป ห้ามแต่งเพิ่ม ถ้าไม่มีให้ใส่ ""
- ถ้าอ่านไม่ชัด ให้ใส่ค่าที่น่าจะเป็นที่สุด ตั้ง confidence ให้ตรงกับความมั่นใจ และอธิบายใน remark
- warnings: ปัญหาภาพรวม เช่น ภาพเบลอ ตัดขอบ ไม่ใช่ตารางเรียน ถ้าไม่มีให้เป็น []`;

function apiKeyOf(settings) {
  return (settings.ai && settings.ai.apiKey) || process.env.ANTHROPIC_API_KEY || '';
}

/** ส่งรูปให้ Claude อ่าน คืนค่า { entries, warnings } */
async function extractFromImage(settings, { data, mediaType, hint }) {
  const apiKey = apiKeyOf(settings);
  if (!apiKey) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า Anthropic API Key (หน้าตั้งค่า → AI อ่านตารางจากรูป)'), { status: 400 });
  const client = new AnthropicClient({ apiKey, timeout: 180000, maxRetries: 2 });

  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
    { type: 'text', text: PROMPT + (hint ? `\n\nข้อมูลเพิ่มเติมจากผู้ใช้:\n${String(hint).slice(0, 1000)}` : '') },
  ];
  const base = {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    // เปิด server-side fallback: ถ้าโมเดลหลักปฏิเสธ จะให้โมเดลที่ Anthropic แนะนำทำต่อ
    response = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof AnthropicClient.BadRequestError && /fallback/i.test(e.message)) {
      response = await client.messages.create(base); // บัญชีที่ยังไม่รองรับ fallback
    } else throw friendlyError(e);
  }

  if (response.stop_reason === 'refusal') throw Object.assign(new Error('AI ปฏิเสธการประมวลผลรูปนี้'), { status: 422 });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('ตารางยาวเกินไป ลองครอปรูปเป็นส่วน ๆ'), { status: 422 });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('อ่านผลลัพธ์จาก AI ไม่ได้ ลองใหม่อีกครั้ง'), { status: 502 }); }
  return {
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    model: response.model,
  };
}

function friendlyError(e) {
  const C = AnthropicClient;
  let msg = e.message;
  if (e instanceof C.AuthenticationError) msg = 'Anthropic API Key ไม่ถูกต้อง';
  else if (e instanceof C.PermissionDeniedError) msg = 'API Key นี้ไม่มีสิทธิ์ใช้งานโมเดล';
  else if (e instanceof C.RateLimitError) msg = 'เรียกใช้ AI ถี่เกินไปหรือเครดิตไม่พอ ลองใหม่ภายหลัง';
  else if (e instanceof C.BadRequestError) msg = `รูปหรือคำขอไม่ถูกต้อง: ${e.message}`;
  else if (e instanceof C.APIConnectionError) msg = 'เชื่อมต่อ Anthropic API ไม่ได้';
  else if (e instanceof C.APIError) msg = `Anthropic API ผิดพลาด (${e.status})`;
  return Object.assign(new Error(msg), { status: e.status && e.status < 500 ? 400 : 502 });
}

// ---------------- ตรวจสอบผลลัพธ์ ----------------

const norm = (s) => String(s || '').toLowerCase().replace(/^ห้อง\s*/, '').replace(/[\s.\-_/()]/g, '');

/** "8.30" "08:30" "8:30 น." → "08:30" */
function fixTime(t) {
  const m = String(t || '').match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (!m) return '';
  const s = `${m[1].padStart(2, '0')}:${m[2]}`;
  return isValidTime(s) ? s : '';
}

function findRoom(rooms, name) {
  const n = norm(name);
  if (!n) return null;
  return rooms.find((r) => norm(r.name) === n)
    || rooms.find((r) => norm(r.name).includes(n) || n.includes(norm(r.name)))
    || null;
}

const overlap = (a, b) => toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

/**
 * ตรวจแต่ละรายการ: รูปแบบเวลา, ห้องที่มีอยู่, ซ้ำกับตารางเดิม, ชนเวลากับคาบอื่น
 * status: ok | duplicate | conflict | invalid
 */
function review(entries, db, groupId = null) {
  // ตรวจซ้ำ/ชนเฉพาะคาบของชั้นเรียนเดียวกัน (รวมคาบที่ใช้ร่วมทุกห้อง)
  db = { ...db, classes: db.classes.filter((c) => !c.groupId || !groupId || c.groupId === groupId) };
  const out = [];
  for (const raw of entries) {
    const e = {
      subject: String(raw.subject || '').trim().slice(0, 100),
      code: String(raw.code || '').trim().slice(0, 40),
      teacher: String(raw.teacher || '').trim().slice(0, 80),
      roomName: String(raw.room || '').trim().slice(0, 80),
      day: Number(raw.day),
      start: fixTime(raw.start),
      end: fixTime(raw.end),
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
      remark: String(raw.remark || '').trim().slice(0, 300),
      issues: [],
    };
    const room = findRoom(db.rooms, e.roomName);
    e.roomId = room ? room.id : null;
    e.newRoom = !room && !!e.roomName;

    if (!e.subject) e.issues.push('ไม่มีชื่อวิชา');
    if (!Number.isInteger(e.day) || e.day < 0 || e.day > 6) e.issues.push('ไม่ทราบวัน');
    if (!e.start || !e.end) e.issues.push('เวลาไม่ถูกต้อง');
    else if (toMin(e.end) <= toMin(e.start)) e.issues.push('เวลาเลิกก่อนเวลาเริ่ม');

    if (e.issues.length) e.status = 'invalid';
    else {
      const sameDay = db.classes.filter((c) => c.day === e.day);
      const dup = sameDay.find((c) => norm(c.subject) === norm(e.subject) && c.start === e.start);
      const clash = sameDay.find((c) => overlap(c, e));
      const inBatch = out.find((o) => o.status !== 'invalid' && o.day === e.day && overlap(o, e));
      if (dup) { e.status = 'duplicate'; e.issues.push('มีคาบนี้ในตารางแล้ว'); }
      else if (clash) { e.status = 'conflict'; e.issues.push(`ชนกับ “${clash.subject}” ${clash.start}–${clash.end}`); }
      else if (inBatch) { e.status = 'conflict'; e.issues.push(`ชนกับ “${inBatch.subject}” ในรูปเดียวกัน`); }
      else e.status = 'ok';
    }
    out.push(e);
  }
  return out.sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || toMin(a.start) - toMin(b.start));
}

module.exports = { MODEL, SCHEMA, extractFromImage, review, findRoom, fixTime, apiKeyOf };

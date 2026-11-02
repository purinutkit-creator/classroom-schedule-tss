'use strict';
(() => {
  const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const DAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const DAY_COLORS = ['#ef4444', '#eab308', '#ec4899', '#22c55e', '#f97316', '#3b82f6', '#a855f7'];
  const PALETTE = ['#4f46e5', '#6366f1', '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#f43f5e', '#ec4899', '#a855f7', '#64748b'];
  const THAI_FONTS = ['Prompt', 'Kanit', 'Sarabun', 'Mitr', 'Noto Sans Thai', 'IBM Plex Sans Thai', 'Anuphan', 'Bai Jamjuree', 'Chakra Petch', 'K2D', 'Niramit', 'Krub', 'Athiti', 'Mali', 'Itim', 'Pridi', 'Taviraj', 'Trirong', 'Noto Serif Thai', 'Chonburi', 'Sriracha', 'Charm', 'Pattaya', 'Kodchasan', 'KoHo', 'Fahkwang', 'Thasadith', 'Charmonman'];
  const TIMEZONES = ['Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Vientiane', 'Asia/Phnom_Penh', 'Asia/Yangon', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kolkata', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  let token = localStorage.getItem('tt-token') || '';
  let S = null; // state จากเซิร์ฟเวอร์
  let view = localStorage.getItem('tt-view') || 'week';

  // ---------------- API ----------------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(data.error || 'กรุณาเข้าสู่ระบบ'); }
    if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
    return data;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    // แสดงเหนือ dialog ที่เปิดอยู่ (dialog อยู่ใน top layer)
    const host = document.querySelector('dialog[open]');
    let box = host ? host.querySelector('.toasts') : $('#toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; host.append(box); }
    box.append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, type === 'err' ? 5000 : 2800);
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  }

  // ---------------- เวลาตามโซนที่ตั้ง ----------------
  function nowLocal() {
    const tz = S?.settings.timezone || 'Asia/Bangkok';
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: +p.hour * 60 + +p.minute, sec: +p.second, hh: p.hour, mm: p.minute };
  }
  const roomOf = (id) => S.rooms.find((r) => r.id === id);
  const navUrl = (room) => room && room.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${room.lat},${room.lng}&travelmode=walking` : room?.mapUrl || '';
  const reminderOf = (c) => (c.reminderMinutes == null ? S.settings.defaultReminderMinutes : c.reminderMinutes);
  const classesOn = (d) => S.classes.filter((c) => c.day === d).sort((a, b) => toMin(a.start) - toMin(b.start));

  // ---------------- Router ----------------
  function route() {
    const page = (location.hash || '#dashboard').slice(1);
    const valid = ['dashboard', 'timetable', 'rooms', 'line', 'settings'].includes(page) ? page : 'dashboard';
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${valid}`));
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === valid));
    if (valid === 'rooms') setTimeout(renderOverviewMap, 50);
    if (valid === 'line') renderPreview();
    window.scrollTo(0, 0);
  }

  // ---------------- Render ----------------
  function renderAll() {
    $$('[data-bind="appName"]').forEach((e) => (e.textContent = S.settings.appName || 'ตารางสอน'));
    $$('[data-bind="schoolName"]').forEach((e) => (e.textContent = S.settings.schoolName || 'Classroom Schedule'));
    document.title = S.settings.appName || 'ตารางสอน';
    document.documentElement.style.setProperty('--accent', S.settings.accentColor);
    $('meta[name=theme-color]').content = S.settings.accentColor;
    renderDashboard();
    renderTimetable();
    renderRooms();
    renderLine();
    renderSettings();
  }

  function renderDashboard() {
    const n = nowLocal();
    const h = +n.hh;
    $('#greet').textContent = h < 12 ? 'อรุณสวัสดิ์ ☀️' : h < 17 ? 'สวัสดีตอนบ่าย 🌤️' : 'สวัสดีตอนเย็น 🌙';
    $('#today-label').textContent = `วัน${DAYS[n.weekday]} · ${new Intl.DateTimeFormat('th-TH', { timeZone: S.settings.timezone, dateStyle: 'long' }).format(new Date())}`;
    const today = classesOn(n.weekday);
    $('#today-count').textContent = `${today.length} คาบ`;
    $('#today-list').innerHTML = today.length ? today.map((c) => {
      const room = roomOf(c.roomId);
      const live = n.min >= toMin(c.start) && n.min < toMin(c.end);
      const past = n.min >= toMin(c.end);
      const url = navUrl(room);
      return `<div class="tl-item ${live ? 'live' : ''} ${past ? 'past' : ''}" style="--c:${c.color}" data-edit-class="${c.id}">
        <div class="tl-time"><b>${c.start}</b><span>${c.end}</span></div>
        <div><div class="tl-sub">${live ? '🔴 ' : ''}${esc(c.subject)}</div><div class="tl-room">📍 ${esc(room?.name || 'ยังไม่ระบุห้อง')}${c.teacher ? ` · ${esc(c.teacher)}` : ''}</div></div>
        ${url ? `<a class="nav-pill" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🧭 นำทาง</a>` : '<span></span>'}
      </div>`;
    }).join('') : '<div class="empty"><span class="big">🎉</span>วันนี้ไม่มีคาบเรียน</div>';

    renderNowCard();

    const l = S.settings.line;
    const enabled = S.recipients.filter((r) => r.enabled).length;
    const status = [
      { ok: l.hasToken && l.hasSecret, t: 'LINE OA', d: l.hasToken && l.hasSecret ? `เชื่อมต่อแล้ว · โหมด ${l.sendMode === 'push' ? `เลือกผู้รับ (${enabled})` : 'Broadcast'}` : 'ยังไม่ได้ใส่ Token / Secret', link: '#line' },
      { ok: S.settings.remindersEnabled, t: 'แจ้งเตือนอัตโนมัติ', d: S.settings.remindersEnabled ? `เปิดอยู่ · ค่าเริ่มต้น ${S.settings.defaultReminderMinutes} นาทีก่อนเริ่ม` : 'ปิดอยู่', link: '#settings' },
      { ok: S.rooms.length > 0 && S.rooms.every((r) => r.lat != null || r.mapUrl), t: 'ตำแหน่งห้องเรียน', d: `${S.rooms.filter((r) => r.lat != null || r.mapUrl).length}/${S.rooms.length} ห้องปักหมุดแล้ว`, link: '#rooms' },
      { ok: S.classes.length > 0, t: 'ตารางสอน', d: `${S.classes.length} คาบต่อสัปดาห์`, link: '#timetable' },
      { ok: S.storage === 'postgres', t: 'การบันทึกข้อมูล', d: S.storage === 'postgres' ? 'ถาวร (ฐานข้อมูล) ข้อมูลไม่หายเมื่ออัปเดต' : 'ชั่วคราว ข้อมูลจะหายเมื่อรีสตาร์ต ให้ส่งออกสำรองไว้', link: '#settings' },
    ];
    $('#status-list').innerHTML = status.map((s) => `<div class="status"><i class="dot ${s.ok ? 'ok' : 'warn'}"></i><div><b>${s.t}</b><span>${esc(s.d)}</span></div><a href="${s.link}">จัดการ ›</a></div>`).join('');

    $('#history').innerHTML = S.history.length ? S.history.map((h) => `<div class="h-item"><span class="ic">${h.ok ? '✅' : '⚠️'}</span><div><b>${esc(h.subject)}</b> ${h.room ? `· ${esc(h.room)}` : ''}<small>${new Date(h.at).toLocaleString('th-TH', { timeZone: S.settings.timezone, dateStyle: 'medium', timeStyle: 'short' })} · ก่อน ${h.minutesBefore} นาที · ${esc(h.detail || '')}</small></div></div>`).join('')
      : '<div class="empty"><span class="big">🔔</span>ยังไม่มีการแจ้งเตือน</div>';
  }

  function renderNowCard() {
    const n = nowLocal();
    const card = $('#now-card');
    const nowSec = n.min * 60 + n.sec;
    // หาคาบปัจจุบัน หรือคาบถัดไปภายใน 7 วัน
    let current = classesOn(n.weekday).find((c) => n.min >= toMin(c.start) && n.min < toMin(c.end));
    let next = null, nextIn = 0;
    for (let off = 0; off < 7 && !next; off++) {
      const d = (n.weekday + off) % 7;
      const c = classesOn(d).find((x) => off > 0 || toMin(x.start) * 60 > nowSec);
      if (c) { next = c; nextIn = off * 86400 + toMin(c.start) * 60 - nowSec; }
    }
    if (current) {
      const room = roomOf(current.roomId);
      const total = (toMin(current.end) - toMin(current.start)) * 60;
      const done = nowSec - toMin(current.start) * 60;
      const left = total - done;
      card.style.setProperty('--hc', current.color);
      card.innerHTML = `<div><span class="label">🔴 กำลังเรียนอยู่</span><h2>${esc(current.subject)}</h2>
        <div class="meta"><span>🕘 ${current.start}–${current.end}</span><span>📍 ${esc(room?.name || '-')}</span>${current.teacher ? `<span>👩‍🏫 ${esc(current.teacher)}</span>` : ''}</div></div>
        <div><div class="row" style="justify-content:space-between;align-items:flex-end"><div><div class="small" style="opacity:.8">เหลืออีก</div><div class="countdown">${fmtDur(left)}</div></div>${navUrl(room) ? `<a class="btn" href="${esc(navUrl(room))}" target="_blank" rel="noopener">🧭 นำทาง</a>` : ''}</div>
        <div class="bar"><i style="width:${Math.min(100, (done / total) * 100).toFixed(1)}%"></i></div></div>`;
    } else if (next) {
      const room = roomOf(next.roomId);
      card.style.setProperty('--hc', next.color);
      const when = nextIn < 86400 && next.day === n.weekday ? 'วันนี้' : `วัน${DAYS[next.day]}`;
      card.innerHTML = `<div><span class="label">⏭️ คาบถัดไป · ${when}</span><h2>${esc(next.subject)}</h2>
        <div class="meta"><span>🕘 ${next.start}–${next.end}</span><span>📍 ${esc(room?.name || '-')}</span><span>🔔 ${next.reminderEnabled ? `แจ้งก่อน ${reminderOf(next)} นาที` : 'ปิดแจ้งเตือน'}</span></div></div>
        <div class="row" style="justify-content:space-between;align-items:flex-end"><div><div class="small" style="opacity:.8">เริ่มในอีก</div><div class="countdown">${fmtDur(nextIn)}</div></div>${navUrl(room) ? `<a class="btn" href="${esc(navUrl(room))}" target="_blank" rel="noopener">🧭 นำทาง</a>` : ''}</div>`;
    } else {
      card.style.removeProperty('--hc');
      card.innerHTML = `<div><span class="label">✨ เริ่มต้นใช้งาน</span><h2>ยังไม่มีคาบเรียน</h2><div class="meta">เพิ่มห้องเรียนและคาบเรียนแรกของคุณ</div></div><div><button class="btn" data-action="new-class">＋ เพิ่มคาบเรียน</button></div>`;
    }
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d} วัน ${h} ชม.`;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function renderTimetable() {
    $$('#tt-view button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('#timetable-wrap').classList.toggle('hidden', view !== 'week');
    $('#class-list').classList.toggle('hidden', view !== 'list');
    const n = nowLocal();
    const days = [...S.settings.visibleDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // เริ่มวันจันทร์
    // ขยายช่วงเวลาอัตโนมัติถ้ามีคาบอยู่นอกช่วงที่ตั้งไว้
    let startH = Math.floor(toMin(S.settings.dayStart) / 60);
    let endH = Math.ceil(toMin(S.settings.dayEnd) / 60);
    for (const c of S.classes) if (days.includes(c.day)) { startH = Math.min(startH, Math.floor(toMin(c.start) / 60)); endH = Math.max(endH, Math.ceil(toMin(c.end) / 60)); }
    const hourPx = 64;
    const height = (endH - startH) * hourPx;
    const top = (t) => ((toMin(t) - startH * 60) / 60) * hourPx;

    const tt = $('#timetable');
    tt.style.setProperty('--cols', days.length || 1);
    let html = '<div class="tt-corner"></div>';
    html += days.map((d) => `<div class="tt-day ${d === n.weekday ? 'today' : ''}"><b>${DAYS[d]}</b><span>${classesOn(d).length} คาบ</span></div>`).join('');
    html += `<div class="tt-times" style="height:${height}px">${Array.from({ length: endH - startH }, (_, i) => `<div>${String(startH + i).padStart(2, '0')}:00</div>`).join('')}</div>`;
    html += days.map((d) => {
      const blocks = classesOn(d).map((c) => {
        const room = roomOf(c.roomId);
        const h = Math.max(top(c.end) - top(c.start), 26);
        return `<div class="tt-block" style="--c:${c.color};top:${top(c.start)}px;height:${h - 3}px" data-edit-class="${c.id}" title="${esc(c.subject)}">
          ${c.reminderEnabled ? `<span class="bell">🔔${reminderOf(c)}′</span>` : ''}
          <b>${esc(c.subject)}</b>${h > 44 ? `<span>${c.start}–${c.end}</span>` : ''}${h > 62 ? `<span>📍 ${esc(room?.name || '-')}</span>` : ''}${h > 80 && c.teacher ? `<span>${esc(c.teacher)}</span>` : ''}
        </div>`;
      }).join('');
      const nowLine = d === n.weekday && n.min >= startH * 60 && n.min <= endH * 60 ? `<div class="tt-now" style="top:${((n.min - startH * 60) / 60) * hourPx}px"></div>` : '';
      return `<div class="tt-col ${d === n.weekday ? 'today' : ''}" data-day="${d}" data-start-h="${startH}" style="height:${height}px">${blocks}${nowLine}</div>`;
    }).join('');
    tt.innerHTML = html;

    // มุมมองรายการ
    const allDays = [1, 2, 3, 4, 5, 6, 0];
    $('#class-list').innerHTML = allDays.filter((d) => classesOn(d).length).map((d) => `<div><h3 style="--dc:${DAY_COLORS[d]}"><i></i>วัน${DAYS[d]}</h3><div class="timeline">${classesOn(d).map((c) => {
      const room = roomOf(c.roomId);
      const url = navUrl(room);
      return `<div class="tl-item" style="--c:${c.color}" data-edit-class="${c.id}"><div class="tl-time"><b>${c.start}</b><span>${c.end}</span></div>
        <div><div class="tl-sub">${esc(c.subject)} ${c.code ? `<span class="muted small">${esc(c.code)}</span>` : ''}</div><div class="tl-room">📍 ${esc(room?.name || '-')} · 🔔 ${c.reminderEnabled ? `${reminderOf(c)} นาที` : 'ปิด'}</div></div>
        ${url ? `<a class="nav-pill" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🧭</a>` : '<span></span>'}</div>`;
    }).join('')}</div></div>`).join('') || '<div class="card empty"><span class="big">🗓️</span>ยังไม่มีคาบเรียน</div>';
  }

  // ---------------- Rooms ----------------
  let overviewMap = null, overviewLayer = null;
  function pinIcon(color) {
    return L.divIcon({ className: 'pin-wrap', html: `<div class="pin" style="--c:${color}"></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
  }
  function renderRooms() {
    $('#room-grid').innerHTML = S.rooms.length ? S.rooms.map((r) => {
      const uses = S.classes.filter((c) => c.roomId === r.id);
      const url = navUrl(r);
      return `<div class="room-card" style="--c:${r.color}">
        <div class="room-top"><div class="room-ico">🏫</div><div class="grow"><h3>${esc(r.name)}</h3>
          <p>${esc([r.building, r.floor ? `ชั้น ${r.floor}` : ''].filter(Boolean).join(' · ') || 'ไม่ระบุอาคาร')}</p>
          ${r.detail ? `<p>🧭 ${esc(r.detail)}</p>` : ''}
          <p>${r.lat != null ? `📌 ${(+r.lat).toFixed(5)}, ${(+r.lng).toFixed(5)}` : r.mapUrl ? '🔗 ลิงก์แผนที่' : '⚠️ ยังไม่ปักหมุด'}</p></div></div>
        <div class="room-uses">${uses.length ? uses.map((c) => `<span>${DAYS_SHORT[c.day]} ${c.start} ${esc(c.subject)}</span>`).join('') : '<span>ยังไม่มีคาบที่ใช้ห้องนี้</span>'}</div>
        <div class="room-actions"><button class="btn" data-edit-room="${r.id}">✏️ แก้ไข</button>${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">🧭 นำทาง</a>` : ''}</div>
      </div>`;
    }).join('') : '<div class="card empty" style="grid-column:1/-1"><span class="big">📍</span>ยังไม่มีห้องเรียน กด “เพิ่มห้อง” เพื่อเริ่มต้น</div>';
    if (overviewMap) renderOverviewMap();
  }
  function renderOverviewMap() {
    if (!window.L || !$('#page-rooms').classList.contains('active')) return;
    if (!overviewMap) {
      overviewMap = L.map('overview-map', { scrollWheelZoom: false }).setView([13.7563, 100.5018], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap' }).addTo(overviewMap);
      overviewLayer = L.featureGroup().addTo(overviewMap);
    }
    overviewMap.invalidateSize();
    overviewLayer.clearLayers();
    for (const r of S.rooms.filter((x) => x.lat != null)) {
      L.marker([r.lat, r.lng], { icon: pinIcon(r.color) }).addTo(overviewLayer)
        .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.building || '')}<br><a href="${esc(navUrl(r))}" target="_blank" rel="noopener">🧭 นำทาง</a>`);
    }
    if (overviewLayer.getLayers().length) overviewMap.fitBounds(overviewLayer.getBounds().pad(0.3), { maxZoom: 18 });
  }

  // Room dialog
  let roomMap = null, roomMarker = null, editingRoom = null;
  function openRoom(id) {
    editingRoom = id ? S.rooms.find((r) => r.id === id) : null;
    const r = editingRoom || { name: '', building: '', floor: '', detail: '', mapUrl: '', lat: null, lng: null, color: PALETTE[S.rooms.length % PALETTE.length] };
    const f = $('#room-form');
    $('#room-dialog-title').textContent = editingRoom ? 'แก้ไขห้องเรียน' : 'เพิ่มห้องเรียน';
    for (const k of ['name', 'building', 'floor', 'detail', 'mapUrl']) f[k].value = r[k] || '';
    f.lat.value = r.lat ?? ''; f.lng.value = r.lng ?? '';
    swatches($('#room-colors'), r.color, () => updateRoomMarker());
    $('#room-delete').classList.toggle('hidden', !editingRoom);
    $('#room-dialog').showModal();
    setTimeout(() => {
      updateNavLink();
      if (!window.L) { $('#room-map').innerHTML = '<div class="empty">โหลดแผนที่ไม่ได้ — ใส่พิกัดหรือลิงก์ Google Maps แทนได้</div>'; return; }
      if (!roomMap) {
        roomMap = L.map('room-map').setView([13.7563, 100.5018], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap' }).addTo(roomMap);
        roomMap.on('click', (e) => setRoomLatLng(e.latlng.lat, e.latlng.lng));
      }
      roomMap.invalidateSize();
      if (roomMarker) { roomMarker.remove(); roomMarker = null; }
      const center = r.lat != null ? [r.lat, r.lng] : S.rooms.find((x) => x.lat != null) ? [S.rooms.find((x) => x.lat != null).lat, S.rooms.find((x) => x.lat != null).lng] : [13.7563, 100.5018];
      roomMap.setView(center, 17);
      if (r.lat != null) setRoomLatLng(r.lat, r.lng, false);
      updateNavLink();
    }, 60);
  }
  function setRoomLatLng(lat, lng, pan = true) {
    const f = $('#room-form');
    f.lat.value = (+lat).toFixed(6); f.lng.value = (+lng).toFixed(6);
    updateNavLink();
    if (!roomMap) return;
    if (!roomMarker) {
      roomMarker = L.marker([lat, lng], { draggable: true, icon: pinIcon(selectedSwatch($('#room-colors'))) }).addTo(roomMap);
      roomMarker.on('dragend', () => { const p = roomMarker.getLatLng(); setRoomLatLng(p.lat, p.lng, false); });
    } else roomMarker.setLatLng([lat, lng]);
    if (pan) roomMap.panTo([lat, lng]);
    updateNavLink();
  }
  function updateRoomMarker() { if (roomMarker) roomMarker.setIcon(pinIcon(selectedSwatch($('#room-colors')))); }
  function updateNavLink() {
    const f = $('#room-form');
    const url = f.lat.value && f.lng.value ? navUrl({ lat: f.lat.value, lng: f.lng.value }) : f.mapUrl.value;
    const a = $('#room-nav');
    a.href = url || '#';
    a.classList.toggle('hidden', !url);
  }
  // ดึงพิกัดจากลิงก์ Google Maps
  function parseMapUrl(url) {
    const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|query|destination|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/];
    for (const p of pats) { const m = url.match(p); if (m) return [+m[1], +m[2]]; }
    return null;
  }

  // ---------------- Class dialog ----------------
  let editingClass = null;
  function openClass(id, preset = {}) {
    editingClass = id ? S.classes.find((c) => c.id === id) : null;
    const n = nowLocal();
    const c = editingClass || { subject: '', code: '', teacher: '', note: '', roomId: S.rooms[0]?.id || '', day: S.settings.visibleDays.includes(n.weekday) ? n.weekday : S.settings.visibleDays[0] ?? 1, start: '08:30', end: '09:20', color: PALETTE[(S.classes.length + 1) % PALETTE.length], reminderEnabled: true, reminderMinutes: null, ...preset };
    const f = $('#class-form');
    $('#class-dialog-title').textContent = editingClass ? 'แก้ไขคาบเรียน' : 'เพิ่มคาบเรียน';
    for (const k of ['subject', 'code', 'teacher', 'note', 'start', 'end']) f[k].value = c[k] || '';
    $('#class-room').innerHTML = `<option value="">— ไม่ระบุห้อง —</option>` + S.rooms.map((r) => `<option value="${r.id}">${esc(r.name)}${r.building ? ` (${esc(r.building)})` : ''}</option>`).join('');
    f.roomId.value = c.roomId || '';
    f.reminderEnabled.checked = c.reminderEnabled !== false;
    f.reminderMinutes.value = c.reminderMinutes ?? '';
    dayPicker($('#class-day'), [c.day], true, updateClassPreview);
    swatches($('#class-colors'), c.color, updateClassPreview);
    $('#class-delete').classList.toggle('hidden', !editingClass);
    $('#class-dialog').showModal();
    updateClassPreview();
  }
  function classFromForm() {
    const f = $('#class-form');
    return {
      subject: f.subject.value.trim() || 'ชื่อวิชา', code: f.code.value, teacher: f.teacher.value, note: f.note.value,
      start: f.start.value, end: f.end.value, roomId: f.roomId.value || null,
      day: selectedDays($('#class-day'))[0] ?? 1, color: selectedSwatch($('#class-colors')),
      reminderEnabled: f.reminderEnabled.checked, reminderMinutes: f.reminderMinutes.value === '' ? null : Number(f.reminderMinutes.value),
    };
  }
  let previewTimer = null;
  function updateClassPreview() {
    const c = classFromForm();
    const f = $('#class-form');
    $('#class-dialog-head').style.setProperty('--dc', c.color);
    syncChips($('.chips-row[data-for=reminderMinutes]'), f.reminderMinutes.value);
    const mins = c.reminderMinutes ?? S.settings.defaultReminderMinutes;
    const fire = toMin(c.start) - mins;
    $('#reminder-hint').innerHTML = c.reminderEnabled
      ? `จะส่งแจ้งเตือน <b>วัน${DAYS[fire < 0 ? (c.day + 6) % 7 : c.day]} เวลา ${fmtMin((fire + 1440) % 1440)} น.</b> ${c.reminderMinutes == null ? `(ค่าเริ่มต้น ${mins} นาที)` : ''}`
      : 'ปิดการแจ้งเตือนสำหรับคาบนี้';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try { $('#class-preview').innerHTML = renderFlex(await api('/api/line/preview', { method: 'POST', body: { class: c, minutes: mins } })); } catch { /* ignore */ }
    }, 200);
  }

  // ---------------- LINE ----------------
  function renderLine() {
    const l = S.settings.line;
    const ok = l.hasToken && l.hasSecret;
    const badge = $('#line-badge');
    badge.textContent = ok ? '● เชื่อมต่อแล้ว' : 'ยังไม่เชื่อมต่อ';
    badge.classList.toggle('ok', ok);
    const f = $('#line-form');
    f.channelAccessToken.placeholder = l.hasToken ? `บันทึกแล้ว ${l.tokenHint}${l.fromEnv ? ' (จาก .env)' : ''} — ใส่ใหม่เพื่อเปลี่ยน` : 'วางโทเคนที่นี่';
    f.channelSecret.placeholder = l.hasSecret ? `บันทึกแล้ว ${l.secretHint} — ใส่ใหม่เพื่อเปลี่ยน` : 'วาง secret ที่นี่';
    $('#webhook-url').value = S.webhookUrl;
    const site = S.webhookUrl.replace(/\/webhook\/line$/, '');
    $('#privacy-url').value = site + '/privacy';
    $('#terms-url').value = site + '/terms';
    const m = $('#line-mode-form');
    m.querySelector(`[name=sendMode][value=${l.sendMode}]`).checked = true;
    m.autoAddFollowers.checked = l.autoAddFollowers;
    m.replyKeywords.checked = l.replyKeywords;
    $('#recipients').innerHTML = S.recipients.length ? S.recipients.map((r) => `<div class="rcp">
        <div class="rcp-av">${r.type === 'user' ? '👤' : '👥'}</div>
        <div class="grow"><div class="rcp-name">${esc(r.name || 'ไม่ทราบชื่อ')} ${r.left ? '<span class="muted small">(ออกแล้ว)</span>' : ''}</div><div class="rcp-id">${esc(r.id)}</div></div>
        <input type="checkbox" class="switch" data-rcp-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''} title="เปิด/ปิดการส่ง" />
        <button type="button" class="icon-btn" data-rcp-del="${esc(r.id)}" title="ลบ">🗑</button>
      </div>`).join('')
      : `<div class="empty small"><span class="big">👋</span>ยังไม่มีผู้รับ<br>ให้นักเรียนเพิ่มเพื่อน LINE OA หรือเชิญบอทเข้ากลุ่ม แล้วผู้รับจะขึ้นที่นี่อัตโนมัติ</div>`;
    const sel = $('#preview-class');
    const prev = sel.value;
    sel.innerHTML = S.classes.map((c) => `<option value="${c.id}">${DAYS_SHORT[c.day]} ${c.start} · ${esc(c.subject)}</option>`).join('');
    if (prev && S.classes.some((c) => c.id === prev)) sel.value = prev;
  }
  let lastFlex = null;
  async function renderPreview() {
    const id = $('#preview-class').value;
    if (!id) { $('#flex-preview').innerHTML = '<div class="empty" style="color:#fff">เพิ่มคาบเรียนเพื่อดูตัวอย่าง</div>'; return; }
    try {
      lastFlex = await api('/api/line/preview', { method: 'POST', body: { classId: id } });
      $('#flex-preview').innerHTML = renderFlex(lastFlex);
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------------- Settings ----------------
  function renderSettings() {
    const s = S.settings;
    const f = $('#settings-form');
    f.appName.value = s.appName; f.schoolName.value = s.schoolName || ''; f.contactEmail.value = s.contactEmail || '';
    const tzs = TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
    $('#tz-select').innerHTML = tzs.map((t) => `<option ${t === s.timezone ? 'selected' : ''}>${t}</option>`).join('');
    f.dayStart.value = s.dayStart; f.dayEnd.value = s.dayEnd;
    f.remindersEnabled.checked = s.remindersEnabled;
    f.defaultReminderMinutes.value = s.defaultReminderMinutes;
    syncChips($('.chips-row[data-for=defaultReminderMinutes]'), String(s.defaultReminderMinutes));
    dayPicker($('#day-picker'), s.visibleDays, false);
    swatches($('#accent-swatches'), s.accentColor, (c) => document.documentElement.style.setProperty('--accent', c));
    renderFonts();
    renderAi();
    $('#storage-note').innerHTML = S.storage === 'postgres' ? '✅ ข้อมูลบันทึกถาวรในฐานข้อมูลแล้ว' : '⚠️ ตอนนี้บันทึกแบบชั่วคราว ข้อมูลจะหายเมื่อเซิร์ฟเวอร์รีสตาร์ต';
  }

  function renderFonts() {
    const f = S.settings.font;
    $$('#font-source button').forEach((b) => b.classList.toggle('active', b.dataset.src === fontTab));
    $('#font-google').classList.toggle('hidden', fontTab !== 'google');
    $('#font-custom').classList.toggle('hidden', fontTab !== 'custom');
    $('#font-system').classList.toggle('hidden', fontTab !== 'system');
    $('#gf-list').innerHTML = THAI_FONTS.map((x) => `<option value="${x}">`).join('');
    if (!$('#gf-input').value) $('#gf-input').value = f.googleFamily || '';
    const list = [...new Set([f.googleFamily, ...THAI_FONTS].filter(Boolean))];
    if (fontTab === 'google') loadGooglePreview(list);
    $('#gf-grid').innerHTML = list.map((fam) => `<button type="button" class="font-tile ${f.source === 'google' && f.googleFamily === fam ? 'active' : ''}" data-gfont="${esc(fam)}">
      <span class="sample" style="font-family:'${esc(fam)}',system-ui">ตารางสอน Aa</span><small>${esc(fam)}</small></button>`).join('');
    $('#custom-fonts').innerHTML = S.fonts.map((ft) => `<div class="font-tile ${f.source === 'custom' && f.customFontId === ft.id ? 'active' : ''}" data-cfont="${ft.id}" role="button" tabindex="0">
      <span class="sample" style="font-family:'${esc(ft.family)}'">ตารางสอน Aa</span><small>${esc(ft.family)} · ${(ft.size / 1024).toFixed(0)} KB</small>
      <button type="button" class="del" data-cfont-del="${ft.id}" title="ลบฟอนต์">✕</button></div>`).join('') || '<p class="muted small" style="grid-column:1/-1">ยังไม่มีฟอนต์ที่อัปโหลด</p>';
  }
  let fontTab = 'google';
  const loadedPreview = new Set();
  function loadGooglePreview(families) {
    const todo = families.filter((f) => !loadedPreview.has(f));
    if (!todo.length) return;
    todo.forEach((f) => loadedPreview.add(f));
    // โหลดเฉพาะตัวอักษรที่ใช้แสดงตัวอย่าง เพื่อให้เร็ว
    for (let i = 0; i < todo.length; i += 12) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?${todo.slice(i, i + 12).map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}`).join('&')}&display=swap&text=${encodeURIComponent('ตารางสอน Aa')}`;
      document.head.append(link);
    }
  }
  async function saveFont(font) {
    S.settings = await api('/api/settings', { method: 'PUT', body: { font } });
    reloadTheme();
    renderFonts();
    toast('เปลี่ยนฟอนต์แล้ว ✨', 'ok');
  }
  function reloadTheme() { $('#theme-css').href = `/theme.css?v=${Date.now()}`; }

  // ---------------- Widgets ----------------
  function dayPicker(el, selected, single, onChange) {
    el.innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" data-day="${d}" style="--dc:${DAY_COLORS[d]}" class="${selected.includes(d) ? 'active' : ''}" title="${DAYS[d]}">${DAYS_SHORT[d]}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (single) $$('button', el).forEach((x) => x.classList.toggle('active', x === b));
      else b.classList.toggle('active');
      onChange?.();
    };
  }
  const selectedDays = (el) => $$('button.active', el).map((b) => +b.dataset.day);
  function swatches(el, value, onChange) {
    const colors = PALETTE.includes(value) ? PALETTE : [...PALETTE, value];
    el.innerHTML = colors.map((c) => `<button type="button" data-color="${c}" style="background:${c}" class="${c === value ? 'active' : ''}"></button>`).join('') + `<input type="color" value="${value}" title="เลือกสีเอง" />`;
    el.dataset.value = value;
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      pick(b.dataset.color);
    };
    el.querySelector('input').oninput = (e) => pick(e.target.value, true);
    function pick(c, fromInput) {
      el.dataset.value = c;
      $$('button', el).forEach((x) => x.classList.toggle('active', x.dataset.color === c));
      if (!fromInput) el.querySelector('input').value = c;
      onChange?.(c);
    }
  }
  const selectedSwatch = (el) => el.dataset.value;
  function syncChips(row, value) {
    $$('button', row).forEach((b) => b.classList.toggle('active', b.dataset.min === String(value ?? '')));
  }

  // ---------------- Events ----------------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-action=new-class]')) return S.rooms.length || confirm('ยังไม่มีห้องเรียน ต้องการเพิ่มคาบโดยไม่ระบุห้องหรือไม่?') ? openClass() : (location.hash = '#rooms');
    if (t.closest('[data-action=new-room]')) return openRoom();
    if (t.closest('[data-action=vision]')) return openVision();
    const ec = t.closest('[data-edit-class]'); if (ec) return openClass(ec.dataset.editClass);
    const er = t.closest('[data-edit-room]'); if (er) return openRoom(er.dataset.editRoom);
    if (t.closest('[data-close]')) return t.closest('dialog').close();
    const cp = t.closest('[data-copy]');
    if (cp) { await navigator.clipboard.writeText($(cp.dataset.copy).value); return toast('คัดลอกแล้ว', 'ok'); }
    const col = t.closest('.tt-col');
    if (col && !t.closest('.tt-block')) {
      const rect = col.getBoundingClientRect();
      const mins = Math.floor(((e.clientY - rect.top) / 64) * 2) * 30 + +col.dataset.startH * 60;
      return openClass(null, { day: +col.dataset.day, start: fmtMin(mins), end: fmtMin(Math.min(mins + 50, 1439)) });
    }
    const chip = t.closest('.chips-row button');
    if (chip) {
      const row = chip.parentElement;
      const input = row.closest('form')[row.dataset.for];
      input.value = chip.dataset.min;
      syncChips(row, chip.dataset.min);
      if (row.dataset.for === 'reminderMinutes') updateClassPreview();
    }
  });

  $('#tt-view').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.view; localStorage.setItem('tt-view', view); renderTimetable(); };

  // Class form
  const cf = $('#class-form');
  cf.addEventListener('input', updateClassPreview);
  cf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || cf.querySelector('[type=submit]');
    await busy(btn, async () => {
      const body = classFromForm();
      body.subject = cf.subject.value.trim();
      if (editingClass) await api(`/api/classes/${editingClass.id}`, { method: 'PUT', body });
      else await api('/api/classes', { method: 'POST', body });
      $('#class-dialog').close();
      toast('บันทึกคาบเรียนแล้ว', 'ok');
      await refresh();
    });
  });
  $('#class-delete').onclick = async () => {
    if (!editingClass || !confirm(`ลบวิชา "${editingClass.subject}" ?`)) return;
    await busy($('#class-delete'), async () => { await api(`/api/classes/${editingClass.id}`, { method: 'DELETE' }); $('#class-dialog').close(); toast('ลบแล้ว'); await refresh(); });
  };
  $('#class-test').onclick = () => busy($('#class-test'), async () => {
    const c = classFromForm();
    await api('/api/line/test', { method: 'POST', body: { class: c, minutes: c.reminderMinutes ?? S.settings.defaultReminderMinutes } });
    toast('ส่งข้อความทดสอบไปที่ LINE แล้ว 📨', 'ok');
  });

  // Room form
  const rf = $('#room-form');
  rf.addEventListener('input', (e) => {
    if (e.target.name === 'mapUrl') {
      const ll = parseMapUrl(e.target.value);
      if (ll) { setRoomLatLng(ll[0], ll[1]); roomMap?.setZoom(18); toast('ดึงพิกัดจากลิงก์แล้ว 📌', 'ok'); }
    }
    if ((e.target.name === 'lat' || e.target.name === 'lng') && rf.lat.value && rf.lng.value && !isNaN(rf.lat.value) && !isNaN(rf.lng.value)) setRoomLatLng(+rf.lat.value, +rf.lng.value);
    updateNavLink();
  });
  rf.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(e.submitter || rf.querySelector('[type=submit]'), async () => {
      const body = { name: rf.name.value, building: rf.building.value, floor: rf.floor.value, detail: rf.detail.value, mapUrl: rf.mapUrl.value, lat: rf.lat.value, lng: rf.lng.value, color: selectedSwatch($('#room-colors')) };
      if (editingRoom) await api(`/api/rooms/${editingRoom.id}`, { method: 'PUT', body });
      else await api('/api/rooms', { method: 'POST', body });
      $('#room-dialog').close();
      toast('บันทึกห้องเรียนแล้ว', 'ok');
      await refresh();
    });
  });
  $('#room-delete').onclick = async () => {
    if (!editingRoom || !confirm(`ลบห้อง "${editingRoom.name}" ? (คาบที่ใช้ห้องนี้จะกลายเป็นไม่ระบุห้อง)`)) return;
    await busy($('#room-delete'), async () => { await api(`/api/rooms/${editingRoom.id}`, { method: 'DELETE' }); $('#room-dialog').close(); toast('ลบแล้ว'); await refresh(); });
  };
  $('#map-locate').onclick = () => {
    if (!navigator.geolocation) return toast('อุปกรณ์ไม่รองรับการระบุตำแหน่ง', 'err');
    navigator.geolocation.getCurrentPosition((p) => { setRoomLatLng(p.coords.latitude, p.coords.longitude); roomMap?.setZoom(18); }, () => toast('ไม่สามารถระบุตำแหน่งได้', 'err'), { enableHighAccuracy: true });
  };
  $('#map-search').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = e.target.value.trim(); if (!q || !roomMap) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=th&q=${encodeURIComponent(q)}`);
      const [hit] = await res.json();
      if (!hit) return toast('ไม่พบสถานที่', 'err');
      roomMap.setView([+hit.lat, +hit.lon], 17);
      toast(`พบ: ${hit.display_name.split(',').slice(0, 2).join(',')} — แตะแผนที่เพื่อปักหมุดห้อง`);
    } catch { toast('ค้นหาไม่สำเร็จ', 'err'); }
  });

  // LINE
  $('#line-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await busy(e.submitter, async () => {
      S.settings = await api('/api/settings/line', { method: 'PUT', body: { channelAccessToken: f.channelAccessToken.value, channelSecret: f.channelSecret.value } });
      f.channelAccessToken.value = ''; f.channelSecret.value = '';
      renderLine(); renderDashboard();
      toast('บันทึกข้อมูล LINE แล้ว', 'ok');
    });
  });
  $('#line-verify').onclick = () => busy($('#line-verify'), async () => {
    const info = await api('/api/line/verify', { method: 'POST' });
    $('#bot-info').innerHTML = `<div class="bot">${info.pictureUrl ? `<img src="${esc(info.pictureUrl)}" alt="">` : '<div class="rcp-av">💬</div>'}<div><b>${esc(info.displayName)}</b><div class="muted small">${esc(info.basicId || '')} · เชื่อมต่อสำเร็จ ✅</div></div></div>`;
  });
  $('#line-mode-form').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.rcpToggle) {
      await api(`/api/recipients/${encodeURIComponent(t.dataset.rcpToggle)}`, { method: 'PUT', body: { enabled: t.checked } }).catch((er) => toast(er.message, 'err'));
      return refresh();
    }
    const f = e.currentTarget;
    try {
      S.settings = await api('/api/settings/line', { method: 'PUT', body: { sendMode: f.querySelector('[name=sendMode]:checked').value, autoAddFollowers: f.autoAddFollowers.checked, replyKeywords: f.replyKeywords.checked } });
      renderDashboard();
      toast('บันทึกแล้ว', 'ok');
    } catch (er) { toast(er.message, 'err'); }
  });
  $('#recipients').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rcp-del]'); if (!b) return;
    if (!confirm('ลบผู้รับนี้?')) return;
    await api(`/api/recipients/${encodeURIComponent(b.dataset.rcpDel)}`, { method: 'DELETE' });
    refresh();
  });
  $('#add-recipient').onclick = async () => {
    const id = prompt('ใส่ LINE User ID / Group ID (ขึ้นต้นด้วย U หรือ C)');
    if (!id) return;
    const name = prompt('ตั้งชื่อเรียก (ไม่บังคับ)') || '';
    try { await api('/api/recipients', { method: 'POST', body: { id: id.trim(), name } }); toast('เพิ่มผู้รับแล้ว', 'ok'); refresh(); } catch (er) { toast(er.message, 'err'); }
  };
  $('#preview-class').onchange = renderPreview;
  $('#send-test').onclick = () => busy($('#send-test'), async () => {
    if (!$('#preview-class').value) throw new Error('ยังไม่มีคาบเรียน');
    await api('/api/line/test', { method: 'POST', body: { classId: $('#preview-class').value } });
    toast('ส่งข้อความทดสอบแล้ว 📨', 'ok');
  });
  $('#send-day').onclick = () => busy($('#send-day'), async () => {
    await api('/api/line/test', { method: 'POST', body: { day: nowLocal().weekday } });
    toast('ส่งตารางวันนี้แล้ว 📨', 'ok');
  });
  $('#copy-flex').onclick = async () => {
    if (!lastFlex) return;
    await navigator.clipboard.writeText(JSON.stringify(lastFlex.contents, null, 2));
    toast('คัดลอก JSON แล้ว — วางใน Flex Message Simulator ได้เลย', 'ok');
  };

  // Settings
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await busy(e.submitter, async () => {
      const visibleDays = selectedDays($('#day-picker'));
      if (!visibleDays.length) throw new Error('เลือกอย่างน้อย 1 วัน');
      S.settings = await api('/api/settings', { method: 'PUT', body: {
        appName: f.appName.value.trim() || 'ตารางสอน', schoolName: f.schoolName.value.trim(), contactEmail: f.contactEmail.value.trim(), timezone: f.timezone.value,
        dayStart: f.dayStart.value, dayEnd: f.dayEnd.value, remindersEnabled: f.remindersEnabled.checked,
        defaultReminderMinutes: Number(f.defaultReminderMinutes.value), visibleDays, accentColor: selectedSwatch($('#accent-swatches')),
      } });
      reloadTheme();
      renderAll();
      toast('บันทึกการตั้งค่าแล้ว ✨', 'ok');
    });
  });
  $('#settings-form').defaultReminderMinutes.addEventListener('input', (e) => syncChips($('.chips-row[data-for=defaultReminderMinutes]'), e.target.value));

  // Fonts
  $('#font-source').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    fontTab = b.dataset.src;
    renderFonts();
    if (fontTab === 'system') saveFont({ source: 'system' });
  };
  $('#gf-grid').onclick = (e) => { const b = e.target.closest('[data-gfont]'); if (b) { $('#gf-input').value = b.dataset.gfont; saveFont({ source: 'google', googleFamily: b.dataset.gfont }); } };
  $('#gf-apply').onclick = async () => {
    const fam = $('#gf-input').value.trim();
    if (!fam) return;
    // ตรวจว่ามีฟอนต์นี้ใน Google Fonts จริง
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}&display=swap`).catch(() => null);
    if (res && !res.ok) return toast(`ไม่พบฟอนต์ "${fam}" ใน Google Fonts (ตรวจตัวพิมพ์เล็ก-ใหญ่)`, 'err');
    saveFont({ source: 'google', googleFamily: fam });
  };
  $('#custom-fonts').onclick = async (e) => {
    const del = e.target.closest('[data-cfont-del]');
    if (del) {
      if (!confirm('ลบฟอนต์นี้?')) return;
      await api(`/api/fonts/${del.dataset.cfontDel}`, { method: 'DELETE' }).catch((er) => toast(er.message, 'err'));
      await refresh(); reloadTheme(); return;
    }
    const tile = e.target.closest('[data-cfont]');
    if (tile) saveFont({ source: 'custom', customFontId: tile.dataset.cfont });
  };
  const dz = $('#dropzone');
  const fileInput = dz.querySelector('input');
  fileInput.onchange = () => ($('#dz-file').textContent = fileInput.files[0]?.name || '');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; fileInput.onchange(); } });
  $('#font-upload').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fileInput.files.length) return toast('กรุณาเลือกไฟล์ฟอนต์', 'err');
    await busy(e.submitter, async () => {
      const font = await api('/api/fonts', { method: 'POST', body: new FormData(e.target) });
      e.target.reset(); $('#dz-file').textContent = '';
      await refresh();
      reloadTheme();
      await saveFont({ source: 'custom', customFontId: font.id });
    });
  });

  // Backup
  $('#export-btn').onclick = async (e) => {
    e.preventDefault();
    const data = await api('/api/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `timetable-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#import-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('การนำเข้าจะแทนที่ข้อมูลปัจจุบันด้วยข้อมูลในไฟล์ (ตาราง ห้อง และถ้ามีในไฟล์: ผู้รับ การตั้งค่า) ดำเนินการต่อ?')) return (e.target.value = '');
    try {
      const r = await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
      toast(`นำเข้าแล้ว: ${r.rooms} ห้อง, ${r.classes} คาบ, ผู้รับ ${r.recipients} ราย${r.settings ? ' และการตั้งค่า' : ''}`, 'ok');
      refresh();
    } catch (er) { toast(er.message, 'err'); }
    e.target.value = '';
  };

  // ---------------- v2.0: เพิ่มตารางจากรูป ----------------
  const VS_STATUS = { ok: '✓ พร้อมเพิ่ม', added: '✓ เพิ่มแล้ว', duplicate: 'ซ้ำ', conflict: '⚠ เวลาชน', invalid: '✕ ไม่ครบ' };
  let vsBlob = null, vsEntries = [], vsWarnings = [];

  function vsStep(name) {
    for (const s of ['upload', 'loading', 'result']) $(`#vs-${s}`).classList.toggle('hidden', s !== name);
    $('#vs-analyze').hidden = name !== 'upload';
    $('#vs-commit').hidden = name !== 'result';
    $('#vs-back').hidden = name !== 'result';
    $('#vs-foot-note').textContent = name === 'upload' && !S.settings.ai?.hasKey ? '⚠️ ต้องตั้งค่า Anthropic API Key ในหน้าตั้งค่าก่อน' : '';
  }
  function openVision() {
    vsBlob = null; vsEntries = [];
    $('#vs-file').value = '';
    $('#vs-preview').classList.add('hidden');
    $('#vs-empty').classList.remove('hidden');
    $('#vs-analyze').disabled = true;
    vsStep('upload');
    $('#vision-dialog').showModal();
  }

  /** ย่อรูปฝั่งเบราว์เซอร์ (ด้านยาวสุด 2000px) ให้ส่งเร็วและไม่เกินขนาดที่ AI รับได้ */
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('เปิดรูปนี้ไม่ได้ (ลองแปลงเป็น JPG/PNG)')); i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale === 1 && file.size < 3.5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
    } finally { URL.revokeObjectURL(url); }
  }
  async function vsSetFile(file) {
    if (!file || !file.type.startsWith('image/')) return toast('กรุณาเลือกไฟล์รูปภาพ', 'err');
    try {
      vsBlob = await shrinkImage(file);
      const url = URL.createObjectURL(vsBlob);
      $('#vs-preview').src = url; $('#vs-scan-img').src = url;
      $('#vs-preview').classList.remove('hidden');
      $('#vs-empty').classList.add('hidden');
      $('#vs-analyze').disabled = false;
    } catch (e) { toast(e.message, 'err'); }
  }

  async function vsAnalyze() {
    if (!vsBlob) return;
    if (!S.settings.ai?.hasKey) { toast('กรุณาตั้งค่า Anthropic API Key ก่อน', 'err'); $('#vision-dialog').close(); location.hash = '#settings'; return; }
    vsStep('loading');
    const msgs = ['AI กำลังอ่านตารางสอน…', 'กำลังแยกวิชา วัน และเวลา…', 'กำลังตรวจสอบคาบซ้ำและเวลาชน…'];
    let i = 0;
    const t = setInterval(() => { $('#vs-loading-text').textContent = msgs[++i % msgs.length]; }, 4000);
    try {
      const fd = new FormData();
      fd.append('image', vsBlob, 'timetable.jpg');
      fd.append('hint', $('#vs-hint').value);
      fd.append('auto', $('#vs-auto').checked ? '1' : '0');
      const r = await api('/api/vision/analyze', { method: 'POST', body: fd });
      vsEntries = r.entries;
      vsWarnings = r.warnings || [];
      if (r.commit) {
        const n = r.commit.added.length;
        toast(n ? `เพิ่ม ${n} คาบเข้าตารางแล้ว 🎉${r.commit.createdRooms.length ? ` (สร้างห้องใหม่ ${r.commit.createdRooms.length} ห้อง)` : ''}` : 'ไม่มีรายการที่เพิ่มอัตโนมัติได้ กรุณาตรวจสอบ', n ? 'ok' : '');
        await refresh();
      }
      renderVisionResult();
      vsStep('result');
    } catch (e) {
      toast(e.message, 'err');
      vsStep('upload');
    } finally { clearInterval(t); }
  }

  function renderVisionResult() {
    const warnings = vsWarnings;
    const count = (st) => vsEntries.filter((e) => e.status === st).length;
    const sum = [
      ['📋', `พบ ${vsEntries.length} คาบ`],
      count('added') && ['✅', `เพิ่มแล้ว ${count('added')}`],
      count('ok') && ['🟢', `พร้อมเพิ่ม ${count('ok')}`],
      count('conflict') && ['⚠️', `เวลาชน ${count('conflict')}`],
      count('duplicate') && ['♻️', `ซ้ำ ${count('duplicate')}`],
      count('invalid') && ['✕', `ต้องแก้ ${count('invalid')}`],
    ].filter(Boolean);
    $('#vs-summary').innerHTML = sum.map(([i, t]) => `<span>${i} ${t}</span>`).join('');
    $('#vs-warnings').innerHTML = warnings.map((w) => `<div class="vs-warn">⚠️ ${esc(w)}</div>`).join('')
      + (vsEntries.length ? '' : '<div class="empty"><span class="big">🤔</span>ไม่พบคาบเรียนในรูปนี้ ลองใช้รูปที่ชัดขึ้น หรือเพิ่มข้อมูลเพิ่มเติม</div>');
    $('#vs-rooms').innerHTML = S.rooms.map((r) => `<option value="${esc(r.name)}">`).join('');
    const dayOpts = (d) => [1, 2, 3, 4, 5, 6, 0].map((x) => `<option value="${x}" ${x === d ? 'selected' : ''}>${DAYS[x]}</option>`).join('');
    $('#vs-rows').innerHTML = vsEntries.map((e, i) => {
      const done = e.status === 'added';
      const checked = e.status === 'ok';
      return `<tr data-i="${i}" class="${checked || done ? '' : 'off'} ${e.confidence === 'low' ? 'conf-low' : ''}">
        <td><input type="checkbox" data-f="pick" ${checked ? 'checked' : ''} ${done ? 'disabled' : ''} /></td>
        <td><span class="st ${e.status}">${VS_STATUS[e.status]}</span>${e.issues.length ? `<div class="why">${esc(e.issues.join(' · '))}</div>` : ''}${e.confidence === 'low' ? '<div class="why">🔎 AI ไม่แน่ใจ</div>' : ''}${e.remark ? `<div class="why">💬 ${esc(e.remark)}</div>` : ''}</td>
        <td><select data-f="day" ${done ? 'disabled' : ''}>${dayOpts(e.day)}</select></td>
        <td><div class="t2"><input type="time" data-f="start" value="${esc(e.start)}" ${done ? 'disabled' : ''} />–<input type="time" data-f="end" value="${esc(e.end)}" ${done ? 'disabled' : ''} /></div></td>
        <td><input data-f="subject" value="${esc(e.subject)}" ${done ? 'disabled' : ''} />${e.code ? `<div class="why">${esc(e.code)}</div>` : ''}</td>
        <td><input data-f="roomName" list="vs-rooms" value="${esc(e.roomName)}" ${done ? 'disabled' : ''} />${e.newRoom && !done ? '<div class="newroom">＋ จะสร้างห้องใหม่</div>' : ''}</td>
        <td><input data-f="teacher" value="${esc(e.teacher)}" ${done ? 'disabled' : ''} /></td>
      </tr>`;
    }).join('');
    vsUpdateCommit();
  }
  function vsUpdateCommit() {
    const n = $$('#vs-rows [data-f=pick]:checked:not(:disabled)').length;
    $('#vs-commit').textContent = n ? `เพิ่ม ${n} รายการที่เลือก` : 'เสร็จสิ้น';
    $('#vs-all').checked = n > 0 && n === $$('#vs-rows [data-f=pick]:not(:disabled)').length;
  }

  $('#vs-file').onchange = (e) => vsSetFile(e.target.files[0]);
  const vsDrop = $('#vs-drop');
  ['dragenter', 'dragover'].forEach((ev) => vsDrop.addEventListener(ev, (e) => { e.preventDefault(); vsDrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => vsDrop.addEventListener(ev, (e) => { e.preventDefault(); vsDrop.classList.remove('over'); }));
  vsDrop.addEventListener('drop', (e) => vsSetFile(e.dataTransfer.files[0]));
  document.addEventListener('paste', (e) => {
    if (!$('#vision-dialog').open || $('#vs-upload').classList.contains('hidden')) return;
    const item = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
    if (item) vsSetFile(item.getAsFile());
  });
  $('#vs-analyze').onclick = vsAnalyze;
  $('#vs-back').onclick = () => openVision();
  $('#vs-rows').addEventListener('input', (e) => {
    const tr = e.target.closest('tr'); const f = e.target.dataset.f;
    if (!tr || !f) return;
    const entry = vsEntries[+tr.dataset.i];
    if (f === 'pick') tr.classList.toggle('off', !e.target.checked);
    else {
      entry[f] = f === 'day' ? +e.target.value : e.target.value;
      if (f === 'roomName') entry.roomId = null;
      const pick = tr.querySelector('[data-f=pick]');
      if (!pick.checked && entry.status === 'invalid' && entry.subject && entry.start && entry.end) { pick.checked = true; tr.classList.remove('off'); }
    }
    vsUpdateCommit();
  });
  $('#vs-all').onchange = (e) => {
    $$('#vs-rows [data-f=pick]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; c.closest('tr').classList.toggle('off', !c.checked); });
    vsUpdateCommit();
  };
  $('#vs-commit').onclick = () => busy($('#vs-commit'), async () => {
    const picked = $$('#vs-rows tr').filter((tr) => { const c = tr.querySelector('[data-f=pick]'); return c.checked && !c.disabled; }).map((tr) => vsEntries[+tr.dataset.i]);
    if (!picked.length) { $('#vision-dialog').close(); return; }
    const r = await api('/api/vision/commit', { method: 'POST', body: { entries: picked } });
    picked.forEach((p, k) => {
      const res = r.results[k];
      p.status = res.ok ? 'added' : 'invalid';
      if (!res.ok) p.issues = [res.error];
    });
    if (r.failed.length) toast(`เพิ่มไม่สำเร็จ ${r.failed.length} รายการ: ${r.failed[0].subject} — ${r.failed[0].error}`, 'err');
    if (r.added.length) toast(`เพิ่ม ${r.added.length} คาบเข้าตารางแล้ว 🎉${r.createdRooms.length ? ` (สร้างห้องใหม่ ${r.createdRooms.length} ห้อง)` : ''}`, 'ok');
    await refresh();
    renderVisionResult();
  });

  // AI settings
  function renderAi() {
    const ai = S.settings.ai || {};
    const b = $('#ai-badge');
    b.textContent = ai.hasKey ? `● พร้อมใช้ ${ai.keyHint}${ai.fromEnv ? ' (.env)' : ''}` : 'ยังไม่ตั้งค่า';
    b.classList.toggle('ok', !!ai.hasKey);
    $('#ai-form').apiKey.placeholder = ai.hasKey ? 'บันทึกแล้ว — ใส่ใหม่เพื่อเปลี่ยน' : 'sk-ant-...';
  }
  $('#ai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      if (!e.target.apiKey.value.trim()) throw new Error('กรุณาใส่ API Key');
      S.settings = await api('/api/settings/ai', { method: 'PUT', body: { apiKey: e.target.apiKey.value } });
      e.target.apiKey.value = '';
      renderAi();
      toast('บันทึก API Key แล้ว ✨', 'ok');
    });
  });
  $('#ai-clear').onclick = async () => {
    if (!confirm('ลบ API Key?')) return;
    S.settings = await api('/api/settings/ai', { method: 'PUT', body: { clear: true } });
    renderAi();
  };

  // ---------------- Login / boot ----------------
  function showLogin() { $('#login').classList.remove('hidden'); }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/login', { method: 'POST', body: { password: e.target.password.value } });
      token = r.token; localStorage.setItem('tt-token', token);
      $('#login').classList.add('hidden');
      boot();
    } catch (er) { $('#login-error').textContent = er.message; }
  });

  async function refresh(background = false) {
    S = await api('/api/state');
    // รีเฟรชเบื้องหลัง: ไม่แตะฟอร์มตั้งค่าที่ผู้ใช้อาจกำลังแก้อยู่
    if (background) { renderDashboard(); renderTimetable(); return; }
    renderAll();
    if ($('#page-line').classList.contains('active')) renderPreview();
  }

  function tickClock() {
    if (!S) return;
    const n = nowLocal();
    $('#clock').textContent = `${n.hh}:${n.mm}`;
    $('#clock-date').textContent = `วัน${DAYS[n.weekday]}`;
    renderNowCard();
    if (n.sec === 0) { renderDashboard(); renderTimetable(); }
  }

  let booted = false, bgTimer = null;
  async function boot() {
    const auth = await fetch('/api/auth', { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((r) => r.json());
    if (auth.required && !auth.ok) return showLogin();
    fontTab = 'google';
    await refresh();
    fontTab = S.settings.font.source;
    renderFonts();
    route();
    if (!booted) { booted = true; window.addEventListener('hashchange', route); setInterval(tickClock, 1000); }
    tickClock();
    if (!bgTimer) bgTimer = setInterval(() => refresh(true).catch(() => {}), 60000);
  }
  boot().catch((e) => toast(e.message, 'err'));
})();

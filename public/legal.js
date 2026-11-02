// สลับภาษาไทย/อังกฤษ และเติมข้อมูลผู้ให้บริการจากการตั้งค่า
(function () {
  const params = new URLSearchParams(location.search);
  let lang = params.get('lang');
  if (!['th', 'en'].includes(lang)) {
    try { lang = localStorage.getItem('legal-lang'); } catch { lang = null; }
  }
  if (!['th', 'en'].includes(lang)) lang = 'th'; // ค่าเริ่มต้นภาษาไทย (เลือก EN ได้ที่ปุ่มหรือ ?lang=en)

  function setLang(l) {
    lang = l;
    document.documentElement.lang = l;
    try { localStorage.setItem('legal-lang', l); } catch { /* ignore */ }
    document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.set === l)));
    const t = document.querySelector(`meta[name="title-${l}"]`);
    if (t) document.title = t.content.replace('{app}', info.appName || 'ตารางสอน');
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    history.replaceState(null, '', u);
    document.querySelectorAll('.tabs a').forEach((a) => { const x = new URL(a.href, location.href); x.searchParams.set('lang', l); a.href = x.pathname + x.search; });
  }

  let info = {};
  function fill() {
    const text = {
      app: info.appName || 'ตารางสอน',
      org: info.schoolName || (lang === 'th' ? 'ผู้ดูแลระบบ' : 'the administrator'),
      url: info.url || location.origin,
    };
    document.querySelectorAll('[data-fill]').forEach((el) => {
      const k = el.dataset.fill;
      if (k === 'org') el.textContent = info.schoolName || (el.closest('[data-lang="en"]') ? 'the system administrator' : 'ผู้ดูแลระบบ');
      else if (k === 'contact') {
        const en = !!el.closest('[data-lang="en"]');
        el.innerHTML = '';
        if (info.contactEmail) {
          const a = document.createElement('a');
          a.href = 'mailto:' + info.contactEmail; a.textContent = info.contactEmail;
          el.append(en ? 'Email: ' : 'อีเมล: ', a, en ? ', or send a message to our LINE Official Account' : ' หรือส่งข้อความถึง LINE Official Account ของเรา');
        } else el.textContent = en ? 'Send a message to our LINE Official Account' : 'ส่งข้อความถึง LINE Official Account ของเรา';
      } else el.textContent = text[k] ?? '';
    });
  }

  document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => { setLang(b.dataset.set); fill(); }));
  setLang(lang);
  fill();
  fetch('/public-info.json').then((r) => r.json()).then((d) => { info = d; fill(); setLang(lang); }).catch(() => {});
})();

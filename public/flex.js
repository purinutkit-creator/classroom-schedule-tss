// ตัวแสดงผล Flex Message แบบย่อ (เลียนแบบหน้าตาใน LINE) สำหรับดูตัวอย่างในเว็บ
(function () {
  const SIZE = { xxs: 10, xs: 11, sm: 13, md: 14, lg: 16, xl: 19, xxl: 22, '3xl': 28, '4xl': 34, '5xl': 40 };
  const SPACE = { none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 20 };
  const px = (v) => (v == null ? null : SPACE[v] != null ? SPACE[v] + 'px' : v);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = (c) => c; // #RRGGBBAA ใช้ใน CSS ได้โดยตรง

  function node(n, parent, idx) {
    if (!n) return '';
    const st = [];
    const flex = n.flex != null ? n.flex : parent === 'horizontal' || parent === 'baseline' ? (n.type === 'box' && n.width ? 0 : 1) : 0;
    if (parent === 'horizontal' || parent === 'baseline') st.push(`flex:${flex} ${flex} ${flex ? '0' : 'auto'}`, 'min-width:0');
    else if (n.flex != null) st.push(`flex:${n.flex}`);
    if (idx > 0 && n.margin) st.push(parent === 'vertical' ? `margin-top:${px(n.margin)}` : `margin-left:${px(n.margin)}`);
    if (n.type === 'box') {
      const dir = n.layout === 'vertical' ? 'column' : 'row';
      st.push('display:flex', `flex-direction:${dir}`);
      if (n.layout === 'baseline') st.push('align-items:baseline');
      if (n.spacing) st.push(`gap:${px(n.spacing)}`);
      if (n.backgroundColor) st.push(`background:${color(n.backgroundColor)}`);
      if (n.cornerRadius) st.push(`border-radius:${px(n.cornerRadius)}`);
      if (n.width) st.push(`width:${n.width}`);
      if (n.paddingAll) st.push(`padding:${px(n.paddingAll)}`);
      for (const [k, css] of [['paddingTop', 'padding-top'], ['paddingBottom', 'padding-bottom'], ['paddingStart', 'padding-left'], ['paddingEnd', 'padding-right']]) if (n[k]) st.push(`${css}:${px(n[k])}`);
      const kids = (n.contents || []).map((c, i) => node(c, n.layout, i)).join('');
      const tag = n.action?.uri ? `a href="${esc(n.action.uri)}" target="_blank" rel="noopener"` : 'div';
      return `<${tag} class="fx-box" style="${st.join(';')}">${kids}</${tag.split(' ')[0]}>`;
    }
    if (n.type === 'text') {
      st.push(`font-size:${SIZE[n.size] || 14}px`, `color:${color(n.color) || '#111'}`);
      if (n.weight === 'bold') st.push('font-weight:700');
      if (n.align) st.push(`text-align:${n.align === 'end' ? 'right' : n.align === 'start' ? 'left' : 'center'}`);
      if (n.gravity === 'center') st.push('align-self:center');
      st.push(n.wrap ? 'white-space:pre-wrap;word-break:break-word' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
      return `<div class="fx-text" style="${st.join(';')}">${esc(n.text)}</div>`;
    }
    if (n.type === 'button') {
      const primary = n.style === 'primary';
      st.push(primary ? `background:${n.color || '#17c950'};color:#fff` : `color:${n.color || '#42659a'}`);
      st.push(`height:${n.height === 'sm' ? 40 : 52}px`);
      const href = n.action?.uri ? `href="${esc(n.action.uri)}" target="_blank" rel="noopener"` : '';
      return `<a class="fx-btn ${primary ? 'primary' : ''}" ${href} style="${st.join(';')}">${esc(n.action?.label)}</a>`;
    }
    if (n.type === 'separator') return `<div class="fx-sep" style="${st.join(';')};background:${n.color || '#e5e5e5'}"></div>`;
    if (n.type === 'filler') return `<div style="flex:1"></div>`;
    return '';
  }

  function bubble(b) {
    const sec = (name) => b[name] ? `<div class="fx-${name}">${node(b[name], 'vertical', 0)}</div>` : '';
    return `<div class="fx-bubble fx-${b.size || 'mega'}">${sec('header')}${sec('hero')}${sec('body')}${sec('footer')}</div>`;
  }

  window.renderFlex = function (msg) {
    if (!msg) return '';
    const c = msg.contents || msg;
    if (c.type === 'carousel') return `<div class="fx-carousel">${c.contents.map(bubble).join('')}</div>`;
    return bubble(c);
  };
})();

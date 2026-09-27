/* GoFoods Ops — admin console / order desk. Plain JS + supabase-js, no build step.
   Everything goes through RLS and the same database functions the apps use. */
(() => {
  const cfg = window.GOFOODS_CONFIG;
  if (!cfg || cfg.url.startsWith('__')) { document.body.innerHTML = '<p style="padding:24px">Missing config: set GOFOODS_CONFIG (url, anon) in config.js.</p>'; return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anon);

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sym = (c) => c === 'NGN' ? '₦' : 'GH₵';
  const money = (minor, cur) => `${sym(cur)}${(Number(minor || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
  const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const digits = (p) => String(p || '').replace(/\D/g, '');
  const plus = (p) => p ? (String(p).startsWith('+') ? p : '+' + p) : '';
  const toast = (msg, err = false) => { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3000); };
  const friendly = (e) => { const s = e?.message || String(e); return s.replace(/^.*?(not_allowed|insufficient_balance|reference_required|job_taken|wrong_delivery_pin|cannot_demote_yourself|order_not_found|amount_must_be_positive|note_required)[^ ]*/, '$1').replace(/_/g, ' '); };
  const fail = (e) => { console.error(e); toast(friendly(e), true); };

  /** Modal form. fields: [{name,label,type,value,options,required,hint}] → resolves to values or null. */
  function dialog(title, fields, { okText = 'Save', danger = false, intro = '' } = {}) {
    return new Promise((resolve) => {
      const dlg = $('#dlg'), form = $('#dlg-form');
      form.innerHTML = `<h3>${esc(title)}</h3>${intro ? `<p class="muted">${intro}</p>` : ''}` + fields.map((f) => {
        if (f.type === 'select') return `<label>${esc(f.label)}<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o) === String(f.value) ? 'selected' : ''}>${esc(o.label ?? o)}</option>`).join('')}</select></label>`;
        if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea name="${f.name}" rows="3">${esc(f.value ?? '')}</textarea></label>`;
        if (f.type === 'checkbox') return `<label class="row"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''} style="width:auto"> ${esc(f.label)}</label>`;
        return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} placeholder="${esc(f.placeholder || '')}">${f.hint ? `<span class="small">${esc(f.hint)}</span>` : ''}</label>`;
      }).join('') + `<div class="foot"><button class="btn" value="cancel" type="button" id="dlg-cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okText)}</button></div>`;
      $('#dlg-cancel').onclick = () => { dlg.close(); resolve(null); };
      form.onsubmit = (ev) => { ev.preventDefault(); const out = {}; for (const f of fields) { const el = form.elements[f.name]; out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim(); } dlg.close(); resolve(out); };
      dlg.showModal();
    });
  }
  const confirm2 = (title, text, okText = 'Confirm') => dialog(title, [], { okText, danger: true, intro: text }).then((r) => r !== null);

  // ---------- auth ----------
  let me = null, phoneE164 = '';
  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await enter(); else showLogin();
    sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
  }
  function showLogin() { $('#login').classList.remove('hidden'); $('#shell').classList.add('hidden'); }
  $('#login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#login-error'); err.textContent = '';
    const btn = $('#login-btn'); btn.disabled = true;
    try {
      if ($('#login-step2').classList.contains('hidden')) {
        phoneE164 = '+' + digits($('#login-phone').value);
        const { error } = await sb.auth.signInWithOtp({ phone: phoneE164 });
        if (error) throw error;
        $('#login-step2').classList.remove('hidden'); btn.textContent = 'Sign in'; $('#login-code').focus();
      } else {
        const { error } = await sb.auth.verifyOtp({ phone: phoneE164, token: $('#login-code').value.trim(), type: 'sms' });
        if (error) throw error;
        await enter();
      }
    } catch (e) { err.textContent = e.message; } finally { btn.disabled = false; }
  };
  $('#signout').onclick = () => sb.auth.signOut();

  async function enter() {
    const { data: { user } } = await sb.auth.getUser();
    const { data: p } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!p || !['admin', 'order_desk'].includes(p.role)) {
      await sb.auth.signOut();
      $('#login-error').textContent = 'This number is not an admin or order-desk account.'; showLogin(); return;
    }
    me = p;
    $('#me-phone').textContent = plus(p.phone); $('#me-role').textContent = p.role.replace('_', ' ');
    $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
    sb.channel('ops-orders').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { refreshBadge(); if (view === 'orders') render(); }).subscribe();
    refreshBadge();
    route();
  }
  const isAdmin = () => me?.role === 'admin';

  // ---------- routing ----------
  let view = 'orders';
  window.addEventListener('hashchange', route);
  function route() {
    view = (location.hash || '#orders').slice(1).split('/')[0];
    $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    render();
  }
  async function render() {
    const main = $('#main');
    try {
      await ({ orders, vendors, riders, customers, money: moneyView, settings }[view] || orders)(main);
    } catch (e) { main.innerHTML = `<p class="error">${esc(friendly(e))}</p>`; console.error(e); }
  }
  async function refreshBadge() {
    const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'placed').eq('booked_by_vendor', false);
    $('#badge-orders').textContent = count ? String(count) : '';
  }

  // ---------- ORDERS DESK ----------
  const ORDER_SEL = '*, vendors(name, whatsapp_phone, tier), customer:profiles!orders_customer_id_fkey(phone, full_name), rider:profiles!orders_rider_id_fkey(phone, full_name), order_items(name, quantity, options)';
  let ordersTimer = null;
  async function orders(main) {
    clearInterval(ordersTimer);
    const { data: live, error } = await sb.from('orders').select(ORDER_SEL).in('status', ['placed', 'accepted', 'ready', 'picked_up']).order('created_at');
    if (error) throw error;
    const { data: done } = await sb.from('orders').select(ORDER_SEL).in('status', ['delivered', 'cancelled', 'failed']).order('created_at', { ascending: false }).limit(40);
    const counts = (s) => live.filter((o) => o.status === s).length;
    main.innerHTML = `
      <div class="topbar"><h2>Orders desk</h2><span class="muted">${live.length} live · updates live</span><div class="grow"></div>
        <button class="btn" id="refresh">Refresh</button></div>
      <div class="tiles">
        ${tile('Waiting for vendor', counts('placed'), 'accept on their behalf if they are a WhatsApp vendor')}
        ${tile('Preparing', counts('accepted'), '')}${tile('Waiting for rider', counts('ready'), '')}${tile('On the way', counts('picked_up'), '')}
      </div>
      ${ordersTable(live, true)}
      <h3 style="margin-top:22px">Recent completed</h3>
      ${ordersTable(done || [], false)}`;
    $('#refresh').onclick = render;
    bindOrderActions(main, [...live, ...(done || [])]);
    ordersTimer = setInterval(() => $$('.timer', main).forEach(tickTimer), 1000);
  }
  const tile = (k, v, s) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;
  function tickTimer(el) {
    const left = Math.round((new Date(el.dataset.until) - Date.now()) / 1000);
    el.textContent = left <= 0 ? 'overdue' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', left < 120);
  }
  function ordersTable(list, live) {
    if (!list.length) return `<p class="muted">Nothing here.</p>`;
    return `<table><thead><tr><th>Order</th><th>Status</th><th>Vendor</th><th>Customer</th><th>Rider</th><th>Parcel</th><th>Money</th><th>Actions</th></tr></thead><tbody>
      ${list.map((o) => {
        const items = o.booked_by_vendor ? `<span class="chip">Vendor booking</span> ${esc(o.customer_note || '')}` : (o.order_items || []).map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ');
        const cust = o.booked_by_vendor ? `${esc(o.recipient_name || '')} ${plus(o.recipient_phone)}` : `${esc(o.customer?.full_name || '')} ${plus(o.customer?.phone)}`;
        const age = Math.round((Date.now() - new Date(o.paid_at || o.created_at)) / 60000);
        const cls = o.status === 'placed' && age > 5 ? 'late' : o.status === 'placed' ? 'hot' : '';
        const timer = o.status === 'placed' && o.accept_by ? `<div class="timer" data-until="${o.accept_by}"></div>` : '';
        return `<tr class="${cls}" data-id="${o.id}">
          <td><div class="code">${esc(o.code)}</div><div class="small">${when(o.paid_at || o.created_at)}</div>${timer}</td>
          <td><span class="status ${o.status}">${esc(o.status.replace('_', ' '))}</span>${o.cancel_reason ? `<div class="small">${esc(o.cancel_reason)} ${esc(o.cancel_note || '')}</div>` : ''}</td>
          <td>${esc(o.vendors?.name)}<div class="small">${esc(o.vendors?.tier)} · ${plus(o.vendors?.whatsapp_phone)}</div></td>
          <td>${cust}<div class="small">${esc(o.drop_landmark)}</div></td>
          <td>${o.rider ? `${esc(o.rider.full_name || 'Rider')}<div class="small">${plus(o.rider.phone)}</div>` : '<span class="muted">—</span>'}</td>
          <td><div class="small">${items}</div><div class="small">${esc(o.parcel_size)} ${(o.flags || []).map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></td>
          <td>${money(o.total_minor, o.currency)}<div class="small">fee ${money(o.delivery_fee_minor, o.currency)}${o.refunded_minor ? ` · refunded ${money(o.refunded_minor, o.currency)}` : ''}</div></td>
          <td><div class="actions">${live ? orderButtons(o) : ''}</div></td></tr>`;
      }).join('')}</tbody></table>`;
  }
  function orderButtons(o) {
    const b = [];
    if (o.vendors?.whatsapp_phone && ['placed', 'accepted'].includes(o.status) && !o.booked_by_vendor) b.push(`<button class="btn sm" data-act="wa">WhatsApp vendor</button>`);
    if (o.status === 'placed') b.push(`<button class="btn sm primary" data-act="accepted">Accept for vendor</button>`);
    if (o.status === 'accepted') b.push(`<button class="btn sm primary" data-act="ready">Mark ready</button>`);
    if (o.rider_id && ['placed', 'accepted', 'ready'].includes(o.status)) b.push(`<button class="btn sm" data-act="unassign">Unassign rider</button>`);
    if (['placed', 'accepted', 'ready'].includes(o.status)) b.push(`<button class="btn sm danger" data-act="cancel">Cancel + refund</button>`);
    if (o.status === 'picked_up') b.push(`<button class="btn sm" data-act="deliver">Force delivered</button>`);
    return b.join('');
  }
  function bindOrderActions(main, list) {
    $$('button[data-act]', main).forEach((btn) => btn.onclick = async () => {
      const o = list.find((x) => x.id === btn.closest('tr').dataset.id); const act = btn.dataset.act;
      try {
        if (act === 'wa') {
          const lines = (o.order_items || []).map((i) => `${i.quantity}x ${i.name}${i.options?.length ? ' (' + i.options.map((x) => x.name).join(', ') + ')' : ''}`).join('\n');
          const txt = `GoFoods order ${o.code}\n${lines}\n${o.customer_note ? 'Note: ' + o.customer_note + '\n' : ''}Paid ${money(o.subtotal_minor, o.currency)}. A rider will collect. Reply OK to accept, or how many minutes.`;
          window.open(`https://wa.me/${digits(o.vendors.whatsapp_phone)}?text=${encodeURIComponent(txt)}`, '_blank'); return;
        }
        if (act === 'accepted' || act === 'ready') { const { error } = await sb.rpc('advance_order', { p_order: o.id, p_status: act }); if (error) throw error; toast(`Order ${o.code} → ${act}`); }
        if (act === 'unassign') { if (!await confirm2('Unassign rider?', `Order ${o.code} goes back on the board for other riders.`, 'Unassign')) return; const { error } = await sb.rpc('release_order', { p_order: o.id, p_reason: 'unassigned by desk' }); if (error) throw error; toast('Rider unassigned'); }
        if (act === 'cancel') {
          const r = await dialog(`Cancel order ${o.code}`, [
            { name: 'reason', label: 'Reason (the customer sees this)', type: 'select', value: 'other', options: [{ value: 'sold_out', label: 'Vendor sold out' }, { value: 'closed', label: 'Vendor closed' }, { value: 'too_busy', label: 'Vendor too busy' }, { value: 'rider_unavailable', label: 'No rider available' }, { value: 'customer', label: 'Customer asked to cancel' }, { value: 'other', label: 'Other' }] },
            { name: 'note', label: 'Note (optional, shown to customer)' }], { okText: 'Cancel order & refund', danger: true, intro: `Refunds ${money(o.total_minor, o.currency)} to the customer's GoFoods wallet.` });
          if (!r) return;
          const { error } = await sb.rpc('advance_order', { p_order: o.id, p_status: 'cancelled', p_reason: r.reason, p_note: r.note || null }); if (error) throw error; toast('Cancelled and refunded');
        }
        if (act === 'deliver') {
          const r = await dialog(`Force delivered ${o.code}`, [{ name: 'pin', label: 'Customer PIN (ask the customer)', required: true }], { okText: 'Mark delivered', intro: 'Only when the rider confirms hand-over but their app failed. Pays the rider.' });
          if (!r) return;
          const { error } = await sb.rpc('advance_order', { p_order: o.id, p_status: 'delivered', p_pin: r.pin }); if (error) throw error; toast('Marked delivered');
        }
        render();
      } catch (e) { fail(e); }
    });
  }

  // ---------- VENDORS ----------
  async function vendors(main) {
    const [{ data: vb, error }, { data: zones }] = await Promise.all([
      sb.from('vendor_balances').select('*').order('name'),
      sb.from('zones').select('id, name, country').order('name')]);
    if (error) throw error;
    main.innerHTML = `<div class="topbar"><h2>Vendors</h2><span class="muted">${vb.length}</span><div class="grow"></div>
        ${isAdmin() ? '<button class="btn primary" id="new-vendor">+ New vendor</button>' : ''}</div>
      <table><thead><tr><th>Vendor</th><th>Status</th><th>Tier</th><th>Balance</th><th>Orders</th><th>Actions</th></tr></thead><tbody>
      ${vb.map((v) => `<tr data-id="${v.vendor_id}">
        <td><b>${esc(v.name)}</b><div class="small">${plus(v.whatsapp_phone)} · ${esc(v.country)}</div></td>
        <td>${v.is_active ? `<span class="status ${v.is_open ? 'ready' : 'cancelled'}">${v.is_open ? 'Switched on' : 'Switched off'}</span>` : '<span class="status">Inactive</span>'}</td>
        <td>${esc(v.tier)}</td>
        <td class="${v.balance_minor < 0 ? 'neg' : 'pos'}">${money(v.balance_minor, v.currency)}</td>
        <td>${v.orders_paid}</td>
        <td><div class="actions">
          <button class="btn sm" data-act="toggle">${v.is_open ? 'Close' : 'Open'}</button>
          <button class="btn sm" data-act="menu">Menu</button>
          <button class="btn sm" data-act="staff">Staff</button>
          <button class="btn sm" data-act="edit">Edit</button>
          ${isAdmin() && v.balance_minor > 0 ? `<button class="btn sm" data-act="payout">Pay out</button>` : ''}
          ${isAdmin() ? `<button class="btn sm" data-act="topup">Top up</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table>`;
    $('#new-vendor') && ($('#new-vendor').onclick = async () => {
      const r = await dialog('New vendor', [
        { name: 'name', label: 'Name', required: true }, { name: 'zone_id', label: 'Zone', type: 'select', options: zones.map((z) => ({ value: z.id, label: `${z.name} (${z.country})` })) },
        { name: 'category', label: 'Category', type: 'select', value: 'local_food', options: ['local_food', 'fast_food', 'groceries', 'pharmacy'] },
        { name: 'tier', label: 'How they receive orders', type: 'select', value: 'whatsapp', options: [{ value: 'app', label: 'Vendor app' }, { value: 'whatsapp', label: 'WhatsApp relay (desk forwards)' }, { value: 'order_desk', label: 'Order desk calls' }, { value: 'rider_purchase', label: 'Rider buys on arrival' }] },
        { name: 'whatsapp_phone', label: 'WhatsApp number', placeholder: '+233…' }, { name: 'lat', label: 'Latitude', type: 'number', step: 'any', required: true }, { name: 'lng', label: 'Longitude', type: 'number', step: 'any', required: true },
        { name: 'commission_bps', label: 'Commission (basis points, 1200 = 12%)', type: 'number', value: 1200 }, { name: 'prep_minutes', label: 'Typical prep minutes', type: 'number', value: 20 }, { name: 'description', label: 'One-line description' }]);
      if (!r) return;
      r.whatsapp_phone = r.whatsapp_phone ? '+' + digits(r.whatsapp_phone) : null;
      const { error } = await sb.from('vendors').insert(r); if (error) return fail(error); toast('Vendor created'); render();
    });
    $$('button[data-act]', main).forEach((btn) => btn.onclick = async () => {
      const v = vb.find((x) => x.vendor_id === btn.closest('tr').dataset.id); const act = btn.dataset.act;
      try {
        if (act === 'toggle') { const { error } = await sb.from('vendors').update({ is_open: !v.is_open }).eq('id', v.vendor_id); if (error) throw error; toast(v.is_open ? 'Closed' : 'Opened'); render(); }
        if (act === 'edit') await editVendor(v.vendor_id, zones);
        if (act === 'menu') await vendorMenu(main, v);
        if (act === 'staff') await vendorStaff(v);
        if (act === 'payout') await moneyOp('vendor_payout', `vendor:${v.vendor_id}`, v.currency, v.balance_minor, `Pay out ${v.name}`);
        if (act === 'topup') await moneyOp('vendor_topup', `vendor:${v.vendor_id}`, v.currency, null, `Top up ${v.name}`);
      } catch (e) { fail(e); }
    });
  }
  async function editVendor(id, zones) {
    const { data: v } = await sb.from('vendors').select('*').eq('id', id).single();
    const r = await dialog(`Edit ${v.name}`, [
      { name: 'name', label: 'Name', value: v.name, required: true }, { name: 'zone_id', label: 'Zone', type: 'select', value: v.zone_id, options: zones.map((z) => ({ value: z.id, label: `${z.name} (${z.country})` })) },
      { name: 'tier', label: 'How they receive orders', type: 'select', value: v.tier, options: ['app', 'whatsapp', 'order_desk', 'rider_purchase'] },
      { name: 'whatsapp_phone', label: 'WhatsApp number', value: v.whatsapp_phone || '' }, { name: 'lat', label: 'Latitude', type: 'number', step: 'any', value: v.lat }, { name: 'lng', label: 'Longitude', type: 'number', step: 'any', value: v.lng },
      { name: 'commission_bps', label: 'Commission (bps)', type: 'number', value: v.commission_bps }, { name: 'prep_minutes', label: 'Prep minutes', type: 'number', value: v.prep_minutes },
      { name: 'accept_timeout_min', label: 'Accept window override (min, blank = adaptive)', type: 'number', value: v.accept_timeout_min ?? '' },
      { name: 'booking_credit_minor', label: 'Booking credit override (minor units, blank = country default)', type: 'number', value: v.booking_credit_minor ?? '' },
      { name: 'min_basket_minor', label: 'Minimum basket override (minor units, blank = country default)', type: 'number', value: v.min_basket_minor ?? '' },
      { name: 'hours', label: 'Opening hours — one line per day: mon 08:00-21:00, 18:00-02:00 (blank line or missing day = closed; leave all empty = always open when switched on)', type: 'textarea', value: hoursToText(v.hours) },
      { name: 'description', label: 'Description', value: v.description || '' }, { name: 'is_active', label: 'Active (visible to customers)', type: 'checkbox', value: v.is_active }]);
    if (!r) return;
    r.whatsapp_phone = r.whatsapp_phone ? '+' + digits(r.whatsapp_phone) : null;
    try { r.hours = hoursFromText(r.hours); } catch (e) { return toast(e.message, true); }
    const { error } = await sb.from('vendors').update(r).eq('id', id); if (error) throw error; toast('Saved'); render();
  }
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  function hoursToText(h) {
    if (!h) return '';
    return DAYS.map((d) => `${d} ${(h[d] || []).map(([a, b]) => `${a}-${b}`).join(', ')}`.trim()).join('\n');
  }
  function hoursFromText(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const out = {}; DAYS.forEach((d) => out[d] = []);
    for (const l of lines) {
      const [day, ...rest] = l.split(/\s+/); const d = day.slice(0, 3).toLowerCase();
      if (!DAYS.includes(d)) throw new Error(`Unknown day "${day}" — use mon, tue, wed, thu, fri, sat, sun`);
      const slots = rest.join(' ').split(',').map((x) => x.trim()).filter(Boolean);
      for (const sl of slots) {
        const m = sl.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (!m) throw new Error(`Bad time range "${sl}" on ${d} — use 08:00-21:00`);
        out[d].push([m[1].padStart(5, '0'), m[2].padStart(5, '0')]);
      }
    }
    return out;
  }
  async function vendorStaff(v) {
    const [{ data: staff }, { data: invites }] = await Promise.all([
      sb.from('vendor_staff').select('user_id, profiles(phone, full_name)').eq('vendor_id', v.vendor_id),
      sb.from('vendor_staff_invites').select('phone, created_at').eq('vendor_id', v.vendor_id)]);
    const list = [...(staff || []).map((s) => `${plus(s.profiles?.phone)} ${esc(s.profiles?.full_name || '')} (signed in)`), ...(invites || []).filter((i) => !(staff || []).some((s) => digits(s.profiles?.phone) === i.phone)).map((i) => `${plus(i.phone)} (invited, not signed in yet)`)];
    const r = await dialog(`Staff — ${v.name}`, [{ name: 'phone', label: 'Add staff phone', placeholder: '+233 24 000 0003' }], { okText: 'Invite', intro: list.length ? list.join('<br>') : 'No staff yet.' });
    if (!r || !r.phone) return;
    const { error } = await sb.from('vendor_staff_invites').insert({ phone: digits(r.phone), vendor_id: v.vendor_id, note: `added by ${plus(me.phone)}` }); if (error) throw error; toast('Invited — they become staff on next sign-in');
  }
  async function vendorMenu(main, v) {
    const [{ data: items }, { data: cats }] = await Promise.all([
      sb.from('menu_items').select('*, menu_categories(name)').eq('vendor_id', v.vendor_id).order('sort'),
      sb.from('menu_categories').select('*').eq('vendor_id', v.vendor_id).order('sort')]);
    main.innerHTML = `<div class="topbar"><button class="btn" id="back">← Vendors</button><h2>${esc(v.name)} — menu</h2><div class="grow"></div>
        <button class="btn" id="new-cat">+ Category</button><button class="btn primary" id="new-item">+ Item</button></div>
      <table><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Available</th><th>Alcohol</th><th>Size units</th><th></th></tr></thead><tbody>
      ${(items || []).map((i) => `<tr data-id="${i.id}"><td><b>${esc(i.name)}</b><div class="small">${esc(i.description || '')}</div></td><td>${esc(i.menu_categories?.name || '—')}</td>
        <td>${money(i.price_minor, v.currency)}</td>
        <td><input type="checkbox" data-field="is_available" ${i.is_available ? 'checked' : ''} style="width:auto"></td>
        <td><input type="checkbox" data-field="contains_alcohol" ${i.contains_alcohol ? 'checked' : ''} style="width:auto"></td>
        <td><input type="number" min="1" max="10" data-field="size_units" value="${i.size_units}" style="width:70px"></td>
        <td><button class="btn sm" data-act="edit">Edit</button></td></tr>`).join('')}</tbody></table>
      <p class="small" style="margin-top:8px">Size units: how many "packs" one of this item is — parcel size shown to riders is computed from them (≤3 small, ≤6 medium, else large).</p>`;
    $('#back').onclick = render;
    $$('input[data-field]', main).forEach((el) => el.onchange = async () => {
      const id = el.closest('tr').dataset.id, val = el.type === 'checkbox' ? el.checked : Number(el.value);
      const { error } = await sb.from('menu_items').update({ [el.dataset.field]: val }).eq('id', id); if (error) fail(error); else toast('Saved');
    });
    const itemDialog = async (i) => {
      const r = await dialog(i ? `Edit ${i.name}` : 'New item', [
        { name: 'name', label: 'Name', value: i?.name || '', required: true }, { name: 'description', label: 'Description', value: i?.description || '' },
        { name: 'price', label: `Price (${sym(v.currency)})`, type: 'number', step: '0.01', value: i ? i.price_minor / 100 : '', required: true },
        { name: 'category_id', label: 'Category', type: 'select', value: i?.category_id || '', options: [{ value: '', label: '—' }, ...(cats || []).map((c) => ({ value: c.id, label: c.name }))] },
        { name: 'size_units', label: 'Size units (packs)', type: 'number', value: i?.size_units ?? 1 }, { name: 'contains_alcohol', label: 'Contains alcohol (rider must check ID)', type: 'checkbox', value: i?.contains_alcohol || false }]);
      if (!r) return;
      const row = { vendor_id: v.vendor_id, name: r.name, description: r.description || null, price_minor: Math.round(r.price * 100), category_id: r.category_id || null, size_units: r.size_units || 1, contains_alcohol: r.contains_alcohol };
      const { error } = i ? await sb.from('menu_items').update(row).eq('id', i.id) : await sb.from('menu_items').insert(row);
      if (error) fail(error); else { toast('Saved'); vendorMenu(main, v); }
    };
    $('#new-item').onclick = () => itemDialog(null);
    $$('button[data-act=edit]', main).forEach((b) => b.onclick = () => itemDialog(items.find((x) => x.id === b.closest('tr').dataset.id)));
    $('#new-cat').onclick = async () => { const r = await dialog('New category', [{ name: 'name', label: 'Name', required: true }]); if (!r) return; const { error } = await sb.from('menu_categories').insert({ vendor_id: v.vendor_id, name: r.name, sort: (cats || []).length }); if (error) fail(error); else vendorMenu(main, v); };
  }

  // ---------- RIDERS ----------
  async function riders(main) {
    const [{ data: rb, error }, { data: invites }] = await Promise.all([
      sb.from('rider_balances').select('*').order('full_name'), sb.from('rider_invites').select('*').order('created_at', { ascending: false })]);
    if (error) throw error;
    const signedPhones = new Set(rb.map((r) => digits(r.phone)));
    const pending = (invites || []).filter((i) => !signedPhones.has(i.phone));
    main.innerHTML = `<div class="topbar"><h2>Riders</h2><span class="muted">${rb.length} active · ${pending.length} invited</span><div class="grow"></div>
        ${isAdmin() ? '<button class="btn primary" id="invite">+ Invite rider</button>' : ''}</div>
      <table><thead><tr><th>Rider</th><th>Country</th><th>Balance owed</th><th>Deliveries</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
      ${rb.map((r) => `<tr data-id="${r.rider_id}"><td><b>${esc(r.full_name || 'No name yet')}</b><div class="small">${plus(r.phone)}</div></td><td>${esc(r.country || '')}</td>
        <td class="${r.balance_minor > 0 ? 'pos' : ''}">${r.currency ? money(r.balance_minor, r.currency) : '—'}</td><td>${r.deliveries_paid}</td><td>${ago(r.last_seen_at)}</td>
        <td><div class="actions">${isAdmin() && r.balance_minor > 0 ? `<button class="btn sm primary" data-act="payout">Pay out</button>` : ''}
          <a class="btn sm" href="https://wa.me/${digits(r.phone)}" target="_blank">WhatsApp</a>
          ${isAdmin() ? `<button class="btn sm danger" data-act="suspend">Suspend</button>` : ''}</div></td></tr>`).join('')}
      ${pending.map((i) => `<tr><td><b>${plus(i.phone)}</b><div class="small">invited ${ago(i.created_at)} · ${esc(i.note || '')}</div></td><td colspan="4" class="muted">Not signed in yet</td><td></td></tr>`).join('')}
      </tbody></table>`;
    $('#invite') && ($('#invite').onclick = async () => {
      const r = await dialog('Invite rider', [{ name: 'phone', label: 'Phone', placeholder: '+233 24 …', required: true }, { name: 'note', label: 'Name / note' }], { okText: 'Invite', intro: 'They become a rider the moment they sign in to the GoFoods Rider app with this number.' });
      if (!r) return; const { error } = await sb.from('rider_invites').insert({ phone: digits(r.phone), note: r.note || null }); if (error) fail(error); else { toast('Invited'); render(); }
    });
    $$('button[data-act]', main).forEach((btn) => btn.onclick = async () => {
      const r = rb.find((x) => x.rider_id === btn.closest('tr').dataset.id);
      try {
        if (btn.dataset.act === 'payout') await moneyOp('rider_payout', `rider:${r.rider_id}`, r.currency, r.balance_minor, `Pay out ${r.full_name || plus(r.phone)}`);
        if (btn.dataset.act === 'suspend') { if (!await confirm2('Suspend rider?', 'They drop to a customer account and cannot take jobs. Re-invite to reinstate.', 'Suspend')) return; const { error } = await sb.rpc('set_role', { p_user: r.rider_id, p_role: 'customer' }); if (error) throw error; toast('Suspended'); render(); }
      } catch (e) { fail(e); }
    });
  }

  // ---------- money op dialog ----------
  async function moneyOp(kind, account, currency, maxMinor, title) {
    const isOut = kind.endsWith('payout');
    const r = await dialog(title, [
      { name: 'amount', label: `Amount (${sym(currency)})${maxMinor != null ? ` — balance ${money(maxMinor, currency)}` : ''}`, type: 'number', step: '0.01', value: maxMinor != null ? (maxMinor / 100).toFixed(2) : '', required: true },
      { name: 'reference', label: isOut ? 'MoMo transaction ID (after you have sent it)' : 'MoMo transaction ID received', required: kind !== 'goodwill_credit' },
      { name: 'note', label: 'Note' }], { okText: isOut ? 'Record payout' : 'Record', intro: isOut ? 'Send the MoMo first, then record it here. This debits their balance.' : '' });
    if (!r) return;
    const { error } = await sb.rpc('record_money_op', { p_kind: kind, p_account: account, p_currency: currency, p_amount: Math.round(r.amount * 100), p_reference: r.reference || null, p_note: r.note || null });
    if (error) throw error; toast('Recorded'); render();
  }

  // ---------- CUSTOMERS ----------
  async function customers(main) {
    main.innerHTML = `<div class="topbar"><h2>Customers</h2></div>
      <div class="card"><label>Find by phone<input id="q" placeholder="024… or +233…"></label><button class="btn primary" id="go">Search</button></div><div id="res" style="margin-top:16px"></div>`;
    const go = async () => {
      const q = digits($('#q').value); if (q.length < 4) return;
      const { data: ps, error } = await sb.from('profiles').select('*').ilike('phone', `%${q}%`).limit(10); if (error) return fail(error);
      const res = $('#res');
      if (!ps.length) { res.innerHTML = '<p class="muted">No account with that number.</p>'; return; }
      res.innerHTML = '';
      for (const p of ps) {
        const cur = p.country === 'NG' ? 'NGN' : 'GHS';
        const [{ data: bal }, { data: ords }] = await Promise.all([sb.rpc('account_balance', { p_account: `wallet:${p.id}`, p_currency: cur }), sb.from('orders').select('code, status, total_minor, currency, created_at, cancel_reason, vendors(name)').eq('customer_id', p.id).order('created_at', { ascending: false }).limit(8)]);
        const card = document.createElement('div'); card.className = 'card'; card.style.marginBottom = '12px';
        card.innerHTML = `<div class="row"><div><b>${esc(p.full_name || 'No name')}</b> <span class="pill" style="background:#e5e7e3;color:#333">${esc(p.role)}</span><div class="small">${plus(p.phone)} · ${esc(p.country || '')} · joined ${when(p.created_at)}</div></div><div class="grow"></div>
          <div><span class="small">Wallet</span><div class="v" style="font-size:20px;font-weight:800">${money(bal, cur)}</div></div>
          ${isAdmin() ? `<button class="btn sm" data-act="goodwill">Goodwill credit</button><button class="btn sm" data-act="topup">Wallet top-up</button>` : ''}</div>
          <table style="margin-top:10px"><tbody>${(ords || []).map((o) => `<tr><td class="code">${esc(o.code)}</td><td>${esc(o.vendors?.name)}</td><td><span class="status ${o.status}">${esc(o.status)}</span> ${esc(o.cancel_reason || '')}</td><td>${money(o.total_minor, o.currency)}</td><td class="small">${when(o.created_at)}</td></tr>`).join('') || '<tr><td class="muted">No orders yet</td></tr>'}</tbody></table>`;
        $$('button[data-act]', card).forEach((b) => b.onclick = () => moneyOp(b.dataset.act === 'goodwill' ? 'goodwill_credit' : 'wallet_topup', `wallet:${p.id}`, cur, null, `${b.dataset.act === 'goodwill' ? 'Goodwill credit' : 'Wallet top-up'} — ${plus(p.phone)}`).catch(fail));
        res.appendChild(card);
      }
    };
    $('#go').onclick = go; $('#q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  // ---------- MONEY ----------
  async function moneyView(main) {
    const [{ data: pa }, { data: vb }, { data: rb }, { data: ops }] = await Promise.all([
      sb.from('platform_accounts').select('*'), sb.from('vendor_balances').select('*'), sb.from('rider_balances').select('*'),
      sb.from('money_ops').select('*, profiles(phone)').order('created_at', { ascending: false }).limit(50)]);
    const get = (acc, cur) => (pa || []).find((a) => a.account === acc && a.currency === cur)?.balance_minor || 0;
    const owedV = (cur) => (vb || []).filter((v) => v.currency === cur && v.balance_minor > 0).reduce((s, v) => s + Number(v.balance_minor), 0);
    const owedR = (cur) => (rb || []).filter((r) => r.currency === cur && r.balance_minor > 0).reduce((s, r) => s + Number(r.balance_minor), 0);
    const block = (cur) => `<h3>${cur === 'GHS' ? 'Ghana' : 'Nigeria'}</h3><div class="tiles">
      ${tile('Platform revenue', money(get('platform:revenue', cur), cur), 'commission + service fees, cumulative')}
      ${tile('Delivery fees held', money(get('platform:delivery_pending', cur), cur), 'released to riders on delivery')}
      ${tile('Owed to vendors', money(owedV(cur), cur), 'app-order shares minus bookings')}
      ${tile('Owed to riders', money(owedR(cur), cur), 'delivery fees not yet paid out')}
      ${tile('Collected via Paystack', money(-get('gateway:paystack', cur), cur), 'customer payments received')}
      ${tile('Paid out (MoMo)', money(get('gateway:momo_out', cur), cur), 'rider + vendor payouts recorded')}
      ${tile('Goodwill given', money(-get('platform:goodwill', cur), cur), 'wallet credits to customers')}
    </div>`;
    main.innerHTML = `<div class="topbar"><h2>Money</h2><span class="muted">every figure is a sum over the ledger</span></div>${block('GHS')}${block('NGN')}
      <h3>Recent money operations</h3>
      <table><thead><tr><th>When</th><th>Kind</th><th>Account</th><th>Amount</th><th>Reference</th><th>By</th></tr></thead><tbody>
      ${(ops || []).map((o) => `<tr><td class="small">${when(o.created_at)}</td><td>${esc(o.kind.replace('_', ' '))}</td><td class="small">${esc(o.account)}</td><td>${money(o.amount_minor, o.currency)}</td><td>${esc(o.reference || '')} <span class="small">${esc(o.note || '')}</span></td><td class="small">${plus(o.profiles?.phone)}</td></tr>`).join('') || '<tr><td class="muted" colspan="6">None yet</td></tr>'}</tbody></table>`;
  }

  // ---------- SETTINGS ----------
  async function settings(main) {
    const [{ data: cs }, { data: zones }, { data: bands }, { data: admins }] = await Promise.all([
      sb.from('country_settings').select('*'), sb.from('zones').select('*').order('country'), sb.from('zone_fee_bands').select('*').order('max_km'), sb.from('admin_invites').select('*')]);
    main.innerHTML = `<div class="topbar"><h2>Settings</h2></div>
      <div class="grid2">
        ${(cs || []).map((c) => `<div class="card" data-country="${c.country}"><h3>${c.country === 'GH' ? 'Ghana' : 'Nigeria'} (${c.currency})</h3>
          <label>Service fee (bps)<input name="service_fee_bps" type="number" value="${c.service_fee_bps}"></label>
          <label>Service fee minimum (minor)<input name="service_fee_min_minor" type="number" value="${c.service_fee_min_minor}"></label>
          <label>Minimum basket (minor)<input name="min_basket_minor" type="number" value="${c.min_basket_minor}"></label>
          <label>Payment window (min)<input name="payment_timeout_min" type="number" value="${c.payment_timeout_min}"></label>
          <label>Vendor accept window: default / floor (min)<div class="row"><input name="accept_timeout_min" type="number" value="${c.accept_timeout_min}"><input name="accept_timeout_floor_min" type="number" value="${c.accept_timeout_floor_min}"></div></label>
          <label>Vendor booking credit (minor)<input name="vendor_booking_credit_minor" type="number" value="${c.vendor_booking_credit_minor}"></label>
          <label>Far delivery: surcharge per km beyond the zone radius (minor) / hard limit (km)<div class="row"><input name="far_surcharge_per_km_minor" type="number" value="${c.far_surcharge_per_km_minor}"><input name="far_max_km" type="number" step="0.5" value="${c.far_max_km}"></div></label>
          <label>Support WhatsApp<input name="support_whatsapp" value="${esc(c.support_whatsapp || '')}"></label>
          <button class="btn primary block" data-act="save-country" ${isAdmin() ? '' : 'disabled'}>Save</button></div>`).join('')}
      </div>
      <h3 style="margin-top:22px">Zones & delivery fees</h3>
      <table><thead><tr><th>Zone</th><th>Centre</th><th>Radius km</th><th>Fee bands (up to km → fee)</th><th></th></tr></thead><tbody>
      ${(zones || []).map((z) => `<tr data-id="${z.id}"><td><b>${esc(z.name)}</b><div class="small">${esc(z.city)} · ${z.country} ${z.is_active ? '' : '· inactive'}</div></td><td class="small">${z.center_lat}, ${z.center_lng}</td><td>${z.radius_km}</td>
        <td>${(bands || []).filter((b) => b.zone_id === z.id).map((b) => `<span class="chip">≤${b.max_km} km → ${money(b.fee_minor, z.country === 'NG' ? 'NGN' : 'GHS')}</span>`).join('')}</td>
        <td>${isAdmin() ? `<button class="btn sm" data-act="edit-zone">Edit</button><button class="btn sm" data-act="bands">Fee bands</button>` : ''}</td></tr>`).join('')}</tbody></table>
      ${isAdmin() ? `<button class="btn" id="new-zone" style="margin-top:10px">+ New zone</button>` : ''}
      <h3 style="margin-top:22px">Admin & order-desk accounts</h3>
      <table><tbody>${(admins || []).map((a) => `<tr><td>${plus(a.phone)}</td><td>${esc(a.role)}</td><td class="small">${esc(a.note || '')}</td></tr>`).join('')}</tbody></table>
      ${isAdmin() ? `<button class="btn" id="new-admin" style="margin-top:10px">+ Add admin / desk account</button>` : ''}`;
    $$('button[data-act=save-country]', main).forEach((b) => b.onclick = async () => {
      const card = b.closest('.card'); const row = {}; $$('input', card).forEach((i) => row[i.name] = i.type === 'number' ? Number(i.value) : i.value);
      const { error } = await sb.from('country_settings').update(row).eq('country', card.dataset.country); if (error) fail(error); else toast('Saved');
    });
    const zoneDialog = async (z) => {
      const r = await dialog(z ? `Edit ${z.name}` : 'New zone', [
        { name: 'name', label: 'Name', value: z?.name || '', required: true }, { name: 'city', label: 'City', value: z?.city || '', required: true },
        { name: 'country', label: 'Country', type: 'select', value: z?.country || 'GH', options: ['GH', 'NG'] },
        { name: 'center_lat', label: 'Centre latitude', type: 'number', step: 'any', value: z?.center_lat ?? '', required: true }, { name: 'center_lng', label: 'Centre longitude', type: 'number', step: 'any', value: z?.center_lng ?? '', required: true },
        { name: 'radius_km', label: 'Radius km', type: 'number', step: '0.1', value: z?.radius_km ?? 5 }, { name: 'is_active', label: 'Active', type: 'checkbox', value: z ? z.is_active : true }]);
      if (!r) return; const { error } = z ? await sb.from('zones').update(r).eq('id', z.id) : await sb.from('zones').insert(r); if (error) fail(error); else { toast('Saved'); render(); }
    };
    $('#new-zone') && ($('#new-zone').onclick = () => zoneDialog(null));
    $('#new-admin') && ($('#new-admin').onclick = async () => {
      const r = await dialog('Add admin / order-desk account', [{ name: 'phone', label: 'Phone', required: true }, { name: 'role', label: 'Role', type: 'select', value: 'order_desk', options: [{ value: 'order_desk', label: 'Order desk (orders + vendors, no money)' }, { value: 'admin', label: 'Admin (everything incl. payouts)' }] }, { name: 'note', label: 'Name / note' }]);
      if (!r) return; const { error } = await sb.from('admin_invites').insert({ phone: digits(r.phone), role: r.role, note: r.note || null }); if (error) fail(error); else { toast('Added — effective on their next sign-in'); render(); }
    });
    $$('button[data-act=edit-zone]', main).forEach((b) => b.onclick = () => zoneDialog(zones.find((z) => z.id === b.closest('tr').dataset.id)));
    $$('button[data-act=bands]', main).forEach((b) => b.onclick = async () => {
      const z = zones.find((x) => x.id === b.closest('tr').dataset.id); const cur = z.country === 'NG' ? 'NGN' : 'GHS';
      const mine = (bands || []).filter((x) => x.zone_id === z.id);
      const r = await dialog(`Fee bands — ${z.name}`, [{ name: 'text', label: `One band per line: max_km=fee_${cur} e.g. 2=20`, type: 'textarea', value: mine.map((x) => `${x.max_km}=${x.fee_minor / 100}`).join('\n') }], { okText: 'Replace bands', intro: 'The first band whose max km is ≥ the trip distance sets the fee. Beyond the last band (up to the country far limit) = last band fee + per-km surcharge, which the customer must accept at checkout.' });
      if (!r) return;
      const rows = r.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [km, fee] = l.split('='); return { zone_id: z.id, max_km: Number(km), fee_minor: Math.round(Number(fee) * 100) }; });
      if (rows.some((x) => !(x.max_km > 0) || !(x.fee_minor >= 0))) return toast('Check the format: 2=20', true);
      let { error } = await sb.from('zone_fee_bands').delete().eq('zone_id', z.id); if (error) return fail(error);
      ({ error } = await sb.from('zone_fee_bands').insert(rows)); if (error) fail(error); else { toast('Bands saved'); render(); }
    });
  }

  boot();
})();

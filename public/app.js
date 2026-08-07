/* PCG Leaderboard — frontend */

const state = {
  role: 'viewer',
  location: 'joint',
  preset: 'mtd',
  month: '',
  from: '',
  to: '',
  barMax: 30000,
  locations: [],
  configWarnings: [],
  dealsOpen: false,
};

// Broker headshots. Keys are matched against the first name of the GHL user,
// lowercased — so "Daniel Rodriguez" in GHL resolves to the 'daniel' entry.
const BROKER_PHOTOS = {
  david:   'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/69977debdf9bdfbf1120370d.jpeg',
  ari:     'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/69977deb3ff516121661ed22.jpeg',
  edward:  'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/6997724c1817158d5eaf4608.jpeg',
  daniel:  'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c220c03540a01609bf.jpeg',
  charles: 'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c218171539feae9b03.png',
  jack:    'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c2df9bdf6c421a9d30.jpeg',
  jason:   'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c23ff51625895c237e.jpeg',
  james:   'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c23873af660fa6e90a.jpeg',
  jake:    'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c2f83453c9f43cfc0a.jpeg',
  scott:   'https://assets.cdn.filesafe.space/HGdEDZywHQOMySe6z0OJ/media/699770c24c2502fc85a09900.jpeg',
};

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const $ = (id) => document.getElementById(id);

const fmtMoney = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

const initials = (name) =>
  String(name).split(' ').map((p) => p[0] || '').join('').slice(0, 2).toUpperCase();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function barClass(total, max) {
  const pct = (total / max) * 100;
  if (pct < 25) return 'bar-red';
  if (pct < 80) return 'bar-yellow';
  return 'bar-green';
}

function avatarHTML(name, cls) {
  const first = String(name).split(' ')[0].toLowerCase();
  const photo = BROKER_PHOTOS[first];
  if (photo) {
    return `<div class="avatar ${cls}" style="background:transparent">
      <img src="${photo}" alt="" onerror="this.parentElement.style.background='';this.parentElement.textContent='${initials(name)}'">
    </div>`;
  }
  return `<div class="avatar ${cls}">${initials(name)}</div>`;
}

// ── STATS ────────────────────────────────────────────────────────────────
function renderStats(totals, isAdmin) {
  const cards = [
    { icon: '💰', label: 'Total Funded', value: fmtMoney(totals.fundedAmount), color: 'var(--gold)' },
    { icon: '📋', label: 'Deals Funded', value: (totals.deals || 0).toLocaleString(), color: 'var(--accent)' },
    { icon: '👥', label: 'Active Brokers', value: (totals.brokers || 0).toLocaleString(), color: 'var(--accent2)' },
  ];

  if (isAdmin) {
    cards.push(
      { icon: '🏆', label: 'Commission', value: fmtMoney(totals.commission), color: 'var(--gold)' },
      { icon: '💎', label: 'Fees', value: fmtMoney(totals.fee), color: 'var(--purple)' },
      { icon: '🚀', label: 'Comm + Fees', value: fmtMoney(totals.total), color: 'var(--accent2)' },
    );
  }

  $('stats-row').style.gridTemplateColumns = `repeat(${cards.length}, 1fr)`;
  $('stats-row').innerHTML = cards.map((c) => `
    <div class="stat-card" style="--bar:${c.color}">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-label">${c.label}</div>
      <div class="stat-value" style="color:${c.color}">${c.value}</div>
    </div>`).join('');
}

// ── LEADERBOARD ──────────────────────────────────────────────────────────
function renderBoard(rows, isAdmin) {
  const showLoc = state.location === 'joint' && state.locations.length > 1;

  const head = ['<th class="center" style="width:50px">#</th>', '<th>Broker</th>',
                '<th class="center">Deals</th>', '<th class="right">Funded Amount</th>'];
  if (isAdmin) {
    head.push('<th class="right">Commission</th>', '<th class="right">Fees</th>', '<th class="right">Total</th>');
  }
  $('board-head').innerHTML = head.join('');

  if (!rows.length) {
    $('board-table').hidden = true;
    $('empty').hidden = false;
    $('empty').innerHTML = 'No funded deals in this period.';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const avCls  = ['avatar-1', 'avatar-2', 'avatar-3'];
  const max    = isAdmin
    ? Math.max(state.barMax, rows[0]?.total || 0)
    : Math.max(...rows.map((r) => r.fundedAmount), 1);

  $('board-body').innerHTML = rows.map((r, i) => {
    const rank = i < 3 ? `<span class="medal">${medals[i]}</span>`
                       : `<span class="rank-other">${i + 1}</span>`;
    const av   = i < 3 ? avCls[i] : 'avatar-n';
    const locChip = showLoc && r.locations?.length
      ? `<span class="loc-chip">${esc(r.locations.join(' + '))}</span>` : '';

    const cells = [
      `<td class="center">${rank}</td>`,
      `<td><div class="employee-cell">${avatarHTML(r.broker, av)}
         <div><div class="emp-name">${esc(r.broker)}${locChip}</div>
         ${r.lenderCount ? `<div class="emp-sub">${r.lenderCount} lender${r.lenderCount > 1 ? 's' : ''}</div>` : ''}
         </div></div></td>`,
      `<td class="center"><span class="deals-badge">${r.deals}</span></td>`,
    ];

    if (isAdmin) {
      const pct = Math.min((r.total / max) * 100, 100);
      cells.push(
        `<td class="right"><span class="num funded">${fmtMoney(r.fundedAmount)}</span></td>`,
        `<td class="right"><span class="num commission">${fmtMoney(r.commission)}</span></td>`,
        `<td class="right"><span class="num fee">${fmtMoney(r.fee)}</span></td>`,
        `<td class="right"><div class="total-cell">
           <span class="num total">${fmtMoney(r.total)}</span>
           <div class="bar-bg"><div class="bar-fill ${barClass(r.total, max)}" style="width:${pct}%"></div></div>
         </div></td>`
      );
    } else {
      const pct = Math.min((r.fundedAmount / max) * 100, 100);
      cells.push(
        `<td class="right"><div class="total-cell">
           <span class="num funded">${fmtMoney(r.fundedAmount)}</span>
           <div class="bar-bg"><div class="bar-fill bar-green" style="width:${pct}%"></div></div>
         </div></td>`
      );
    }

    return `<tr style="animation-delay:${i * 0.04}s">${cells.join('')}</tr>`;
  }).join('');

  $('empty').hidden = true;
  $('board-table').hidden = false;
}

// ── DEAL DETAIL ──────────────────────────────────────────────────────────
function renderDeals(deals, isAdmin) {
  const head = ['<th>Business</th>', '<th>Broker</th>', '<th>Lender</th>',
                '<th class="right">Funded</th>'];
  if (isAdmin) head.push('<th class="right">Commission</th>', '<th class="right">Fee</th>');
  head.push('<th class="right">Funded Date</th>');
  $('deals-head').innerHTML = head.join('');

  $('deals-body').innerHTML = deals.slice(0, 250).map((d, i) => {
    const date = d.fundedDate
      ? new Date(d.fundedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    const cells = [
      `<td><span class="emp-name">${esc(d.businessName)}</span></td>`,
      `<td>${esc(d.broker)}</td>`,
      `<td class="lender-cell">${esc(d.lender)}</td>`,
      `<td class="right"><span class="num funded">${fmtMoney(d.fundedAmount)}</span></td>`,
    ];
    if (isAdmin) {
      cells.push(
        `<td class="right"><span class="num commission">${fmtMoney(d.commission)}</span></td>`,
        `<td class="right"><span class="num fee">${fmtMoney(d.fee)}</span></td>`
      );
    }
    cells.push(`<td class="right date-cell">${date}</td>`);

    return `<tr style="animation-delay:${Math.min(i * 0.02, 1)}s">${cells.join('')}</tr>`;
  }).join('');
}

// ── MONTH DROPDOWNS ──────────────────────────────────────────────────────
function fillMonthSelects(months) {
  const opts = months.map((m) => {
    const [y, mo] = m.key.split('-').map(Number);
    return `<option value="${m.key}">${MONTHS[mo - 1]} ${y}</option>`;
  }).join('');

  const monthSel = $('month-select');
  if (monthSel.options.length <= 1) {
    monthSel.innerHTML = '<option value="">— Pick a month —</option>' + opts;
    $('from-select').innerHTML = '<option value="">From</option>' + opts;
    $('to-select').innerHTML = '<option value="">To</option>' + opts;
  }
}

// ── FETCH ────────────────────────────────────────────────────────────────
async function load() {
  $('loading').hidden = false;
  $('board-table').hidden = true;
  $('empty').hidden = true;

  const params = new URLSearchParams({ location: state.location });
  if (state.from && state.to) {
    params.set('from', state.from);
    params.set('to', state.to);
  } else if (state.month) {
    params.set('month', state.month);
  } else {
    params.set('preset', state.preset);
  }

  try {
    const res = await fetch('/api/leaderboard?' + params);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Request failed');

    state.role = data.role;
    const isAdmin = data.role === 'admin';

    $('role-chip').textContent = isAdmin ? 'Admin' : 'Viewer';
    $('role-chip').className = 'role-chip' + (isAdmin ? ' admin' : '');
    $('auth-btn').textContent = isAdmin ? 'Log out' : 'Admin login';
    $('refresh-btn').hidden = !isAdmin;

    $('period-label').textContent = data.range.label;
    $('header-sub').textContent =
      data.locations.map((l) => l.name).join(' + ') + ' — ' + data.range.label;

    if (data.cache?.cachedAt) {
      const mins = Math.round((Date.now() - data.cache.cachedAt) / 60000);
      $('cache-note').textContent = mins < 1 ? 'Updated just now' : `Updated ${mins}m ago`;
    }

    const allWarnings = [...(state.configWarnings || []), ...(data.warnings || [])];
    if (allWarnings.length) {
      $('warnings').hidden = false;
      $('warnings').innerHTML = allWarnings.map((w) => `<div>⚠️ ${esc(w)}</div>`).join('');
    } else {
      $('warnings').hidden = true;
    }

    fillMonthSelects(data.months || []);
    renderStats(data.totals, isAdmin);
    renderBoard(data.leaderboard, isAdmin);
    renderDeals(data.deals, isAdmin);

    $('footer-meta').textContent = `${data.totals.deals} deals · ${data.leaderboard.length} brokers`;
    $('loading').hidden = true;

  } catch (err) {
    $('loading').hidden = true;
    $('empty').hidden = false;
    $('empty').innerHTML =
      `<div style="font-size:26px;margin-bottom:8px">⚠️</div>
       <div style="color:var(--danger);font-weight:600">${esc(err.message)}</div>
       <div style="font-size:12px;margin-top:8px">Check your Railway environment variables.</div>`;
  }
}

// ── LOCATION TOGGLE ──────────────────────────────────────────────────────
function buildLocationToggle(locations) {
  state.locations = locations;
  const btns = locations.map(
    (l) => `<button class="seg-btn" data-loc="${l.key}">${esc(l.name)}</button>`
  );
  if (locations.length > 1) {
    btns.push('<button class="seg-btn active" data-loc="joint">Joint</button>');
  } else if (btns.length) {
    btns[0] = btns[0].replace('seg-btn', 'seg-btn active');
    state.location = locations[0].key;
  }
  $('location-seg').innerHTML = btns.join('');

  $('location-seg').querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $('location-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.location = b.dataset.loc;
      load();
    });
  });
}

// ── EVENTS ───────────────────────────────────────────────────────────────
$('preset-seg').querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    $('preset-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.preset = b.dataset.preset;
    state.month = ''; state.from = ''; state.to = '';
    $('month-select').value = '';
    $('from-select').value = ''; $('to-select').value = '';
    load();
  });
});

$('month-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.month = e.target.value;
  state.from = ''; state.to = '';
  $('from-select').value = ''; $('to-select').value = '';
  $('preset-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  load();
});

$('apply-range').addEventListener('click', () => {
  const from = $('from-select').value;
  const to = $('to-select').value;
  if (!from || !to) return;
  // Selecting them backwards is an easy mistake; just swap rather than erroring.
  state.from = from <= to ? from : to;
  state.to   = from <= to ? to : from;
  state.month = '';
  $('month-select').value = '';
  $('preset-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  load();
});

$('deals-toggle').addEventListener('click', () => {
  state.dealsOpen = !state.dealsOpen;
  $('deals-wrap').hidden = !state.dealsOpen;
  $('deals-chev').classList.toggle('open', state.dealsOpen);
});

$('refresh-btn').addEventListener('click', async () => {
  $('refresh-btn').textContent = '↻ Refreshing…';
  await fetch('/api/refresh', { method: 'POST' });
  await load();
  $('refresh-btn').textContent = '↻ Refresh data';
});

// ── AUTH ─────────────────────────────────────────────────────────────────
$('auth-btn').addEventListener('click', async () => {
  if (state.role === 'admin') {
    await fetch('/api/logout', { method: 'POST' });
    load();
  } else {
    $('login-modal').hidden = false;
    $('password-input').focus();
  }
});

$('login-cancel').addEventListener('click', () => {
  $('login-modal').hidden = true;
  $('login-err').hidden = true;
  $('password-input').value = '';
});

async function submitLogin() {
  const password = $('password-input').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (res.ok) {
    $('login-modal').hidden = true;
    $('password-input').value = '';
    $('login-err').hidden = true;
    load();
  } else {
    const data = await res.json().catch(() => ({}));
    $('login-err').hidden = false;
    $('login-err').textContent = data.error || 'Login failed.';
  }
}

$('login-submit').addEventListener('click', submitLogin);
$('password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitLogin();
});

// ── INIT ─────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch('/api/session');
    const s = await res.json();
    state.role = s.role;
    state.barMax = s.barMax || 30000;

    if (!s.configured) {
      $('loading').hidden = true;
      $('empty').hidden = false;
      $('empty').innerHTML =
        `<div style="font-size:26px;margin-bottom:10px">⚙️</div>
         <div style="color:var(--warning);font-weight:600;margin-bottom:10px">Setup required</div>
         ${(s.configErrors || []).map((e) => `<div style="font-size:12px;margin-top:4px">• ${esc(e)}</div>`).join('')}
         <div style="font-size:11px;margin-top:14px;color:var(--muted)">Set these in Railway → Variables, then redeploy.</div>`;
      return;
    }

    // Non-blocking config notes (e.g. only one office wired up). Held in state
    // so each load() can re-render them alongside any live data warnings.
    state.configWarnings = s.configWarnings || [];

    buildLocationToggle(s.locations || []);
    load();
  } catch {
    $('loading').hidden = true;
    $('empty').hidden = false;
    $('empty').textContent = 'Could not reach the server.';
  }
})();

// Auto-refresh every 10 minutes.
setInterval(load, 10 * 60 * 1000);

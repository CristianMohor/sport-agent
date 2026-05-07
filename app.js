'use strict';

const state = {
  data: null,
  tab: 'fixture',
  comp: 'liga-primera',
  fecha: 0,
  favorito: localStorage.getItem('favorito') || '',
  notifs: localStorage.getItem('notifs') === 'true',
};

// --- Service Worker ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- Fetch data ---
async function loadData(forceRefresh = false) {
  const url = forceRefresh
    ? `/data/fixture.json?t=${Date.now()}`
    : '/data/fixture.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Network error');
  state.data = await res.json();
}

// --- DOM refs ---
const mainEl      = document.getElementById('main');
const compTabsEl  = document.getElementById('comp-tabs');
const tabContents = {};
['fixture','tabla','config'].forEach(id => {
  tabContents[id] = document.getElementById(`tab-${id}`);
});
const navItems   = document.querySelectorAll('.nav-item');
const lastUpEl   = document.getElementById('last-update');
const toastEl    = document.getElementById('toast');

// --- Helpers ---
const DAY_NAMES   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MONTH_NAMES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAY_NAMES[dt.getDay()]} ${d} ${MONTH_NAMES[m-1]}`;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function getCurrentComp() {
  return state.data?.competiciones?.find(c => c.id === state.comp) ?? null;
}

function setDefaultFecha(comp) {
  if (!comp?.fechas?.length) { state.fecha = 0; return; }
  const activa = comp.fechas.find(f => f.estado === 'proxima' || f.estado === 'en-curso');
  state.fecha = activa ? activa.numero : comp.fechas[0].numero;
}

// --- Tab switch ---
function switchTab(tab) {
  state.tab = tab;
  navItems.forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  Object.entries(tabContents).forEach(([id, el]) => {
    el.classList.toggle('active', id === tab);
  });
}

navItems.forEach(el => {
  el.addEventListener('click', () => switchTab(el.dataset.tab));
});

// --- Competition tabs ---
function renderCompTabs() {
  if (!state.data?.competiciones) return;
  compTabsEl.innerHTML = '';
  state.data.competiciones.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'comp-tab' + (c.id === state.comp ? ' active' : '');
    btn.textContent = c.nombre;
    btn.addEventListener('click', () => switchComp(c.id));
    compTabsEl.appendChild(btn);
  });
}

function switchComp(compId) {
  state.comp = compId;
  setDefaultFecha(getCurrentComp());
  renderCompTabs();
  renderFixture();
  renderTabla();
}

// --- Render fixture ---
function renderFixture() {
  const comp = getCurrentComp();

  const dateTabsRow = tabContents.fixture.querySelector('.date-tabs-row');
  const content     = document.getElementById('fixture-content');

  if (!comp?.fechas?.length) {
    const dateTabs = tabContents.fixture.querySelector('.date-tabs');
    dateTabs.innerHTML = '';
    content.innerHTML  = `
      <div class="empty-state">
        <span class="empty-icon">📅</span>
        Sin partidos disponibles para este torneo.<br>Los datos se actualizan automáticamente.
      </div>`;
    // Hide export btn if present
    const exportBtn = dateTabsRow.querySelector('.export-btn');
    if (exportBtn) exportBtn.style.display = 'none';
    return;
  }

  const fechaData = comp.fechas.find(f => f.numero === state.fecha);
  if (!fechaData) return;

  // Date tabs
  const dateTabs = tabContents.fixture.querySelector('.date-tabs');
  dateTabs.innerHTML = '';
  comp.fechas.forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'date-tab' + (f.numero === state.fecha ? ' active' : '');
    btn.textContent = f.nombre;
    btn.addEventListener('click', () => {
      state.fecha = f.numero;
      renderFixture();
    });
    dateTabs.appendChild(btn);
  });

  // Export button
  let exportBtn = dateTabsRow.querySelector('.export-btn');
  if (!exportBtn) {
    exportBtn = document.createElement('button');
    exportBtn.className = 'export-btn';
    exportBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 17l4 4 4-4m-4-5v9M20 12V7a2 2 0 00-2-2H6a2 2 0 00-2 2v5"/></svg>ICS`;
    dateTabsRow.appendChild(exportBtn);
  }
  exportBtn.style.display = '';
  exportBtn.onclick = () => exportICS(fechaData);

  // Group by day
  const byDay = {};
  fechaData.partidos.forEach(p => {
    if (!byDay[p.fecha]) byDay[p.fecha] = [];
    byDay[p.fecha].push(p);
  });

  content.innerHTML = '';
  Object.entries(byDay).forEach(([date, matches]) => {
    const hdr = document.createElement('div');
    hdr.className = 'day-header';
    hdr.textContent = formatDate(date);
    content.appendChild(hdr);

    matches.forEach((p, i) => {
      const isFav = state.favorito && (p.local === state.favorito || p.visita === state.favorito);
      const card = document.createElement('div');
      card.className = 'match-card' + (isFav ? ' favorite' : '');
      card.style.animationDelay = `${i * 0.05}s`;

      const homeHighlight = state.favorito && p.local === state.favorito ? ' highlight' : '';
      const awayHighlight = state.favorito && p.visita === state.favorito ? ' highlight' : '';

      let centerBlock;
      if (p.resultado !== null) {
        const [gl, ga] = p.resultado;
        centerBlock = `
          <div class="score-block">
            <span class="score">${gl}</span>
            <span class="score-sep">-</span>
            <span class="score">${ga}</span>
          </div>`;
      } else {
        centerBlock = `<div class="vs-block">VS</div>`;
      }

      let bottomBlock = '';
      if (p.resultado === null && p.prob) {
        const [pl, pd, pa] = p.prob;
        bottomBlock = `
          <div class="prob-bar-wrap">
            <div class="prob-bar">
              <div class="seg-local" style="width:${pl}%"></div>
              <div class="seg-draw"  style="width:${pd}%"></div>
              <div class="seg-away"  style="width:${pa}%"></div>
            </div>
            <div class="prob-labels">
              <span class="l">${pl}%</span>
              <span>${pd}%</span>
              <span class="a">${pa}%</span>
            </div>
          </div>`;
      }

      card.innerHTML = `
        <div class="match-time-row">
          <span class="match-time">${p.hora} hrs</span>
          <span class="match-stadium">${p.estadio}</span>
        </div>
        <div class="match-teams">
          <span class="team home${homeHighlight}">${p.local}</span>
          ${centerBlock}
          <span class="team away${awayHighlight}">${p.visita}</span>
        </div>
        ${bottomBlock}`;

      content.appendChild(card);
    });
  });
}

// --- Render tabla ---
function buildTablaTable(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'tabla-wrap';
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr>
      <th>POS</th><th class="col-equipo">EQUIPO</th><th>PTS</th>
      <th>PJ</th><th>PG</th><th>PE</th><th>PP</th>
      <th>GF</th><th>GC</th><th>DIF</th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const isFav = state.favorito && row.equipo === state.favorito;
    const tr = document.createElement('tr');
    tr.className = isFav ? 'fav-row' : '';
    const posClass = row.pos <= 3 ? ' pos-top3' : '';
    const difStr = row.dif > 0 ? `+${row.dif}` : String(row.dif);
    tr.innerHTML = `
      <td class="col-pos${posClass}">${row.pos}</td>
      <td class="col-equipo">${row.equipo}</td>
      <td class="col-pts">${row.pts}</td>
      <td>${row.pj}</td><td>${row.pg}</td><td>${row.pe}</td><td>${row.pp}</td>
      <td>${row.gf}</td><td>${row.gc}</td>
      <td class="col-dif">${difStr}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderTabla() {
  const comp      = getCurrentComp();
  const container = document.getElementById('tabla-container');
  container.innerHTML = '';

  if (comp?.grupos?.length) {
    comp.grupos.forEach(g => {
      const group = document.createElement('div');
      group.className = 'tabla-group';
      const title = document.createElement('div');
      title.className = 'tabla-group-title';
      title.textContent = g.nombre;
      group.appendChild(title);
      group.appendChild(buildTablaTable(g.tabla));
      container.appendChild(group);
    });
    return;
  }

  if (comp?.tabla?.length) {
    container.appendChild(buildTablaTable(comp.tabla));
    return;
  }

  container.innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">📊</span>
      Sin tabla disponible para este torneo.
    </div>`;
}

// --- Render config ---
function renderConfig() {
  const select = document.getElementById('fav-select');
  if (!select) return;

  // Build team list from all competitions
  const teams = new Set();
  state.data.competiciones.forEach(c => {
    c.tabla?.forEach(r => teams.add(r.equipo));
    c.fechas.forEach(f =>
      f.partidos.forEach(p => { teams.add(p.local); teams.add(p.visita); })
    );
  });

  select.innerHTML = '<option value="">— Ninguno —</option>';
  [...teams].sort().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === state.favorito) opt.selected = true;
    select.appendChild(opt);
  });

  select.onchange = () => {
    state.favorito = select.value;
    localStorage.setItem('favorito', state.favorito);
    renderFixture();
    renderTabla();
    showToast(state.favorito ? `Favorito: ${state.favorito}` : 'Sin equipo favorito');
  };

  const toggleBtn = document.getElementById('notif-toggle');
  if (toggleBtn) {
    toggleBtn.className = 'toggle' + (state.notifs ? ' on' : '');
    toggleBtn.onclick = async () => {
      if (!state.notifs) {
        if ('Notification' in window) {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            showToast('Permiso de notificaciones denegado');
            return;
          }
        }
        state.notifs = true;
      } else {
        state.notifs = false;
      }
      localStorage.setItem('notifs', state.notifs);
      toggleBtn.className = 'toggle' + (state.notifs ? ' on' : '');
      showToast(state.notifs ? 'Notificaciones activadas' : 'Notificaciones desactivadas');
    };
  }
}

// --- Export ICS ---
function exportICS(fechaData) {
  const pad  = n => String(n).padStart(2, '0');
  const fmtZ = dt =>
    `${dt.getUTCFullYear()}${pad(dt.getUTCMonth()+1)}${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`;

  const comp = getCurrentComp();
  const calName = `${fechaData.nombre} — ${comp?.nombre ?? 'Chile 2026'}`;

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fútbol Chile 2026//CL',
    'X-WR-CALNAME:' + calName,
    'X-WR-TIMEZONE:America/Santiago', 'CALSCALE:GREGORIAN'];

  fechaData.partidos.forEach(p => {
    const [y, m, d] = p.fecha.split('-').map(Number);
    const [h, min]  = p.hora.split(':').map(Number);

    // Chile invernal = UTC-4; se suma 4h para convertir a UTC.
    const start = new Date(Date.UTC(y, m - 1, d, h + 4, min));
    const end   = new Date(start.getTime() + 2 * 3600 * 1000);

    lines.push('BEGIN:VEVENT',
      `UID:${p.id}@futbolchile2026`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)}Z`,
      `DTSTART:${fmtZ(start)}`,
      `DTEND:${fmtZ(end)}`,
      `SUMMARY:${p.local} vs ${p.visita} — ${fechaData.nombre}`,
      `DESCRIPTION:${comp?.nombre ?? ''} | ${fechaData.nombre} | ${p.estadio}`,
      `LOCATION:${p.estadio}`,
      'END:VEVENT');
  });

  lines.push('END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${state.comp}-fecha${fechaData.numero}-2026.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Calendario exportado');
}

// --- Pull to refresh ---
let ptrStart = 0;
let ptrActive = false;
const ptrEl = document.getElementById('ptr-indicator');

mainEl.addEventListener('touchstart', e => {
  if (mainEl.scrollTop === 0) {
    ptrStart = e.touches[0].clientY;
    ptrActive = true;
  }
}, { passive: true });

mainEl.addEventListener('touchmove', e => {
  if (!ptrActive) return;
  const dy = e.touches[0].clientY - ptrStart;
  if (dy > 30) {
    ptrEl.classList.add('visible');
    ptrEl.textContent = dy > 70 ? '↑ Suelta para actualizar' : '↓ Desliza para actualizar';
  }
}, { passive: true });

mainEl.addEventListener('touchend', async e => {
  if (!ptrActive) return;
  ptrActive = false;
  const dy = e.changedTouches[0].clientY - ptrStart;
  if (dy > 70) {
    ptrEl.textContent = 'Actualizando…';
    try {
      await loadData(true);
      renderAll();
      showToast('Datos actualizados');
    } catch {
      showToast('Sin conexión — datos en caché');
    }
  }
  ptrEl.classList.remove('visible');
}, { passive: true });

// --- Render all ---
function renderAll() {
  if (!state.data) return;
  lastUpEl.textContent = `Actualizado: ${state.data.actualizado}`;
  renderCompTabs();
  renderFixture();
  renderTabla();
  renderConfig();
}

// --- Init ---
(async () => {
  try {
    await loadData();
  } catch {
    showToast('Cargando desde caché…');
  }
  if (state.data) {
    const comp = getCurrentComp();
    setDefaultFecha(comp);
  }
  renderAll();
  switchTab('fixture');
})();

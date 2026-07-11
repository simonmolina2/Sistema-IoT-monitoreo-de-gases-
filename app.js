// ============================================================
//  GEOPORTAL EMVARIAS — Lógica del frontend (Leaflet)
//  Dos vistas: supervisor · trayectoria
// ============================================================

const API = '';

const COLORES = { normal: '#3fb27f', advertencia: '#e0a13c', critico: '#d9534f', sindatos: '#8fa1ab' };
const VARIABLES = {
  h2s:  { label: 'H₂S',   unidad: 'ppm',   max: 5 },
  ch4:  { label: 'CH₄',   unidad: 'ppm',   max: 5000 },
  co2:  { label: 'CO₂',   unidad: 'ppm',   max: 30000 },
  pm25: { label: 'PM2.5', unidad: 'µg/m³', max: 75 },
  pm10: { label: 'PM10',  unidad: 'µg/m³', max: 150 },
};
const UMBRALES_JS = {
  h2s:  { adv: 1.0,   crit: 5.0   },
  ch4:  { adv: 2500,  crit: 5000  },
  co2:  { adv: 5000,  crit: 30000 },
  pm25: { adv: 37,    crit: 75    },
  pm10: { adv: 75,    crit: 150   },
};

function nivelColor(variable, valor) {
  const u = UMBRALES_JS[variable];
  if (!u || valor == null) return COLORES.sindatos;
  if (valor >= u.crit) return COLORES.critico;
  if (valor >= u.adv)  return COLORES.advertencia;
  return COLORES.normal;
}
function nivelLabel(variable, valor) {
  const u = UMBRALES_JS[variable];
  if (!u || valor == null) return 'sin datos';
  if (valor >= u.crit) return 'critico';
  if (valor >= u.adv)  return 'advertencia';
  return 'normal';
}

// --- Mapa -------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([6.2442, -75.5812], 13);

// Capas base conmutables
const basemaps = {
  'Oscuro': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap · © CARTO', maxZoom: 19,
  }),
  'Claro': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap · © CARTO', maxZoom: 19,
  }),
  'Calles': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }),
  'Satélite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri · Maxar · Earthstar Geographics', maxZoom: 19,
  }),
};
basemaps['Oscuro'].addTo(map);
L.control.layers(basemaps, null, { position: 'topright', collapsed: true }).addTo(map);

let capaVehiculos = L.markerClusterGroup({
  maxClusterRadius: 45,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
});
map.addLayer(capaVehiculos);
let capaRutas     = L.layerGroup().addTo(map);
let capaTray      = L.layerGroup().addTo(map);
let capaHeat      = null;
let capaZonas     = null;

const sidebar   = document.getElementById('sidebar');
const legend    = document.getElementById('legend');
const syncLabel = document.getElementById('sync-label');

let lecturasSupervisor = [];  // últimas lecturas para tabla/alertas/semáforo

// --- Utilidades -------------------------------------------------------------
async function getJSON(url) {
  const r = await fetch(API + url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
function fmtHora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
    timeZone: 'America/Bogota',
  });
}
function limpiarMapa() {
  if (capaHeatTray) { map.removeLayer(capaHeatTray); capaHeatTray = null; }
  if (trayChart)    { trayChart.destroy(); trayChart = null; }
  if (polylineaTrayB && capaTray) { capaTray.removeLayer(polylineaTrayB); polylineaTrayB = null; }
  capaVehiculos.clearLayers();
  capaRutas.clearLayers();
  capaTray.clearLayers();
  if (capaHeat)  { map.removeLayer(capaHeat);  capaHeat  = null; }
  if (capaZonas) { map.removeLayer(capaZonas); capaZonas = null; }
}

// --- Health -----------------------------------------------------------------
async function checkHealth() {
  const pill = document.getElementById('db-state');
  try {
    const h = await getJSON('/api/health');
    pill.textContent = h.ok ? 'BD conectada' : 'BD error';
    pill.className   = 'db-pill ' + (h.ok ? 'ok' : 'error');
  } catch {
    pill.textContent = 'BD sin conexión';
    pill.className   = 'db-pill error';
  }
}

// ============================================================
//  VISTA 1 — SUPERVISOR
// ============================================================
async function vistaSupervisor() {
  limpiarMapa();
  legend.innerHTML = `
    <div style="font-weight:600;color:var(--text);margin-bottom:.3rem;">Estado</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.critico}"></span>Crítico</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.advertencia}"></span>Advertencia</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.normal}"></span>Normal</div>`;

  let fc;
  try {
    fc = await getJSON('/api/vehiculos/ultimo');
  } catch (e) {
    sidebar.innerHTML = `<div class="card">No se pudieron cargar los datos.<br><small>${e.message}</small></div>`;
    return;
  }

  const feats  = fc.features;
  const cuenta = { critico: 0, advertencia: 0, normal: 0 };
  let ultimoTs = null;
  lecturasSupervisor = [];   // para tabla y alertas

  feats.forEach((f) => {
    const p = f.properties;
    cuenta[p.nivel_global] = (cuenta[p.nivel_global] || 0) + 1;
    if (!ultimoTs || new Date(p.ts) > new Date(ultimoTs)) ultimoTs = p.ts;
    lecturasSupervisor.push(p);
    if (f.geometry) {
      const [lon, lat] = f.geometry.coordinates;
      const marker = L.circleMarker([lat, lon], {
        radius: 9, fillColor: COLORES[p.nivel_global], color: '#fff', weight: 2, fillOpacity: 0.9,
      });
      marker.bindTooltip(
        `${p.vehiculo_id} · ${(p.nivel_global || '').toUpperCase()}`,
        { direction: 'top', offset: [0, -8] }
      );
      marker.bindPopup(`
        <div class="popup-title">${p.vehiculo_id} · ${p.ruta_nombre || p.ruta_id || ''}</div>
        <div class="popup-row"><span>H₂S</span><span>${p.h2s_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>CH₄</span><span>${p.ch4_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>CO₂</span><span>${p.co2_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>PM2.5</span><span>${p.pm25_ugm3 ?? '—'} µg/m³</span></div>
        <div class="popup-row"><span>PM10</span><span>${p.pm10_ugm3 ?? '—'} µg/m³</span></div>
        <div class="popup-row" style="margin-top:.3rem;color:var(--text-dim)">
          <span>Sincronizado</span><span>${fmtHora(p.ts)}</span>
        </div>`);
      marker.addTo(capaVehiculos);
    }
  });

  syncLabel.textContent = 'Última sincronización: ' + fmtHora(ultimoTs);

  try {
    const rutas = await getJSON('/api/sig/microrutas');
    L.geoJSON(rutas, { style: { color: '#2f9e9b', weight: 2, opacity: 0.4, dashArray: '4 4' } })
      .addTo(capaRutas);
  } catch { /* opcional */ }

  const filas = feats.map((f) => {
    const p = f.properties;
    return `
      <div class="veh-row" data-id="${p.vehiculo_id}"
           data-lat="${f.geometry?.coordinates[1]}" data-lon="${f.geometry?.coordinates[0]}">
        <span class="dot ${p.nivel_global}"></span>
        <div>
          <div class="veh-id">${p.vehiculo_id}</div>
          <div class="veh-meta">${p.ruta_nombre || p.ruta_id || 'Sin ruta'} · ${fmtHora(p.ts)}</div>
        </div>
        <span class="veh-badge ${p.nivel_global}">${p.nivel_global}</span>
      </div>`;
  }).join('');

  sidebar.innerHTML = `
    <div class="card">
      <div class="card-label">Resumen del turno</div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-val">${feats.length}</div><div class="kpi-label">Vehículos con datos</div></div>
        <div class="kpi crit"><div class="kpi-val">${cuenta.critico || 0}</div><div class="kpi-label">Críticos</div></div>
        <div class="kpi warn"><div class="kpi-val">${cuenta.advertencia || 0}</div><div class="kpi-label">Advertencias</div></div>
        <div class="kpi ok"><div class="kpi-val">${cuenta.normal || 0}</div><div class="kpi-label">Sin novedad</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-label">Semáforo por variable (peor lectura actual)</div>
      <div id="semaforo-body"></div>
    </div>
    <div class="card">
      <div class="card-label">Alertas activas</div>
      <div id="alertas-body"></div>
    </div>
    <div class="card">
      <div class="card-label">Flota — última sincronización</div>
      ${filas || '<div class="veh-meta">Sin vehículos con datos.</div>'}
    </div>
    <div class="card">
      <div class="card-label">Lecturas recientes</div>
      <div class="control-group" style="margin-bottom:.5rem;">
        <label>Filtrar desde</label>
        <input type="datetime-local" id="filtro-tabla-desde" />
      </div>
      <div id="tabla-body"></div>
    </div>
    <div class="card" id="umbral-card">
      <div class="card-label">Umbrales normativos</div>
      <div class="veh-meta">Cargando…</div>
    </div>`;

  sidebar.querySelectorAll('.veh-row').forEach((row) => {
    row.addEventListener('click', () => {
      const lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        map.setView([lat, lon], 15);
        capaVehiculos.eachLayer((l) => {
          const ll = l.getLatLng();
          if (Math.abs(ll.lat - lat) < 1e-6 && Math.abs(ll.lng - lon) < 1e-6) l.openPopup();
        });
      }
    });
  });

  renderSemaforo();
  renderAlertas();
  renderTablaLecturas();
  document.getElementById('filtro-tabla-desde')
    ?.addEventListener('change', renderTablaLecturas);
  cargarUmbrales();
}

// --- Semáforo por variable -------------------------------------------------
function renderSemaforo() {
  const cont = document.getElementById('semaforo-body');
  if (!cont) return;
  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const rows = Object.keys(VARIABLES).map((v) => {
    const col = colKey[v];
    const vals = lecturasSupervisor.map((p) => p[col]).filter((x) => x != null);
    const peor = vals.length ? Math.max(...vals) : null;
    const nivel = nivelLabel(v, peor);
    const color = nivelColor(v, peor);
    return `
      <div class="semaforo-row">
        <span class="semaforo-led" style="background:${color}"></span>
        <span class="semaforo-var">${VARIABLES[v].label}</span>
        <span class="semaforo-val">${peor != null ? peor.toFixed(2) + ' ' + VARIABLES[v].unidad : '—'}</span>
        <span class="semaforo-nivel nivel-${nivel}">${nivel}</span>
      </div>`;
  }).join('');
  cont.innerHTML = rows;
}

// --- Panel de alertas ------------------------------------------------------
function construirAlertas() {
  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const alertas = [];
  lecturasSupervisor.forEach((p) => {
    Object.keys(VARIABLES).forEach((v) => {
      const valor = p[colKey[v]];
      const nivel = nivelLabel(v, valor);
      if (nivel === 'advertencia' || nivel === 'critico') {
        alertas.push({
          vehiculo: p.vehiculo_id, variable: VARIABLES[v].label,
          valor, unidad: VARIABLES[v].unidad, nivel, ts: p.ts,
        });
      }
    });
  });
  // Críticos primero, luego por valor relativo
  const orden = { critico: 0, advertencia: 1 };
  alertas.sort((a, b) => orden[a.nivel] - orden[b.nivel] || new Date(b.ts) - new Date(a.ts));
  return alertas;
}

function renderAlertas() {
  const cont = document.getElementById('alertas-body');
  if (!cont) return;
  const alertas = construirAlertas();
  if (!alertas.length) {
    cont.innerHTML = '<div class="veh-meta">Sin alertas activas.</div>';
    return;
  }
  cont.innerHTML = alertas.map((a) => `
    <div class="alerta-row nivel-${a.nivel}">
      <span class="alerta-dot ${a.nivel === 'critico' ? 'critico' : 'advertencia'}"></span>
      <div class="alerta-info">
        <div class="alerta-top"><strong>${a.vehiculo}</strong> · ${a.variable}</div>
        <div class="alerta-meta">${a.valor?.toFixed(2)} ${a.unidad} · ${fmtHora(a.ts)}</div>
      </div>
      <span class="veh-badge ${a.nivel}">${a.nivel}</span>
    </div>`).join('');
}

// --- Tabla de lecturas recientes -------------------------------------------
function renderTablaLecturas() {
  const cont = document.getElementById('tabla-body');
  if (!cont) return;
  const desdeVal = document.getElementById('filtro-tabla-desde')?.value;
  const desde = desdeVal ? new Date(desdeVal) : null;

  let filas = [...lecturasSupervisor];
  if (desde) filas = filas.filter((p) => new Date(p.ts) >= desde);
  filas.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  if (!filas.length) {
    cont.innerHTML = '<div class="veh-meta">Sin lecturas para el filtro seleccionado.</div>';
    return;
  }

  const head = `
    <table class="tabla-lecturas">
      <thead><tr>
        <th>Vehículo</th><th>H₂S</th><th>CH₄</th><th>CO₂</th><th>PM2.5</th><th>PM10</th><th>Hora</th>
      </tr></thead><tbody>`;
  const body = filas.map((p) => `
    <tr>
      <td>${p.vehiculo_id}</td>
      <td>${p.h2s_ppm ?? '—'}</td>
      <td>${p.ch4_ppm ?? '—'}</td>
      <td>${p.co2_ppm ?? '—'}</td>
      <td>${p.pm25_ugm3 ?? '—'}</td>
      <td>${p.pm10_ugm3 ?? '—'}</td>
      <td>${fmtHora(p.ts)}</td>
    </tr>`).join('');
  cont.innerHTML = head + body + '</tbody></table>';
}

async function cargarUmbrales() {
  try {
    const u = await getJSON('/api/umbrales');
    const card = document.getElementById('umbral-card');
    if (!card) return;
    const rows = u.map((x) => `
      <div class="umbral-row">
        <span>${VARIABLES[x.variable]?.label || x.variable}</span>
        <span>${x.advertencia} / ${x.critico} ${x.unidad === 'ugm3' ? 'µg/m³' : x.unidad}</span>
      </div>`).join('');
    card.innerHTML = `<div class="card-label">Umbrales (adv / crítico)</div>${rows}
      <div class="ref-note">Ref: ACGIH 2023 · OMS AQG 2021 (proxy PM)</div>`;
  } catch { /* opcional */ }
}

// ============================================================
//  VISTA 3 — TRAYECTORIA
//  Muestra la ruta completa de un vehículo sobre la malla vial,
//  con puntos coloreados por nivel de alerta y slider de animación
// ============================================================

let trayData       = [];   // features ordenados por ts
let trayVariable   = 'h2s';
let animTimer      = null;
let animIdx        = 0;
let marcadorActivo = null;
let polylineaTray  = null;
let capaHeatTray   = null;
let animVelocidad  = 120;  // ms entre puntos (ajustable)
let trayChart      = null; // gráfica de series temporales
let trayDataB      = [];   // segundo recorrido para comparación
let polylineaTrayB = null;
let trayInicio     = null;
let trayFin        = null;

function vistaTrayectoria() {
  limpiarMapa();
  syncLabel.textContent = 'Modo trayectoria';

  // Defaults: datos reales C-07
  const desdeDefault = '2026-05-15T06:00';
  const hastaDefault = '';

  sidebar.innerHTML = `
    <div class="card">
      <div class="card-label">Trayectoria del vehículo</div>
      <div class="control-group">
        <label>Vehículo</label>
        <select id="inp-vehiculo"><option value="C-16">C-16</option></select>
      </div>
      <div class="control-group">
        <label>Variable a colorear</label>
        <select id="sel-var-tray">
          <option value="h2s">H₂S</option>
          <option value="ch4">CH₄</option>
          <option value="co2">CO₂</option>
          <option value="pm25">PM2.5</option>
          <option value="pm10">PM10</option>
        </select>
      </div>
      <div class="control-group">
        <label>Desde</label>
        <input type="datetime-local" id="inp-desde-tray" value="${desdeDefault}" />
      </div>
      <div class="control-group">
        <label>Hasta</label>
        <input type="datetime-local" id="inp-hasta-tray" value="${hastaDefault}" />
      </div>
      <button class="btn-primary" id="btn-cargar-tray">Cargar trayectoria</button>
      <button class="btn-primary" id="btn-cargar-flota" style="margin-top:.5rem;background:var(--surface-2);border:1px solid var(--accent);color:var(--accent);">🚛 Cargar toda la flota</button>
      <button class="btn-ghost" id="btn-heat-tray" style="display:none;">🌡 Mapa de calor</button>
      <button class="btn-ghost" id="btn-puntos-tray" style="display:none;">● Volver a puntos</button>
      <div class="control-group" style="margin-top:.8rem;">
        <label>Comparar con otro vehículo (opcional)</label>
        <select id="inp-vehiculo-b"><option value="">— sin comparar —</option></select>
      </div>
    </div>

    <div class="card" id="card-anim" style="display:none;">
      <div class="card-label">Reproducción</div>
      <div class="tray-controls">
        <button class="tray-btn" id="btn-play" title="Reproducir">▶</button>
        <button class="tray-btn" id="btn-pause" title="Pausar">⏸</button>
        <button class="tray-btn" id="btn-stop" title="Reiniciar">⏹</button>
      </div>
      <div class="control-group" style="margin-top:.6rem;">
        <label>Velocidad: <span id="lbl-vel">1×</span></label>
        <input type="range" id="slider-vel" min="0" max="4" value="2" step="1"
               style="width:100%;accent-color:var(--accent);" />
      </div>
      <div class="control-group" style="margin-top:.6rem;">
        <label>Punto <span id="lbl-idx">1</span> de <span id="lbl-total">—</span></label>
        <input type="range" id="slider-tray" min="0" max="199" value="0" style="width:100%;accent-color:var(--accent);" />
      </div>
      <div id="tray-tiempos" class="tray-tiempos"></div>
      <div id="info-punto" class="info-punto"></div>
    </div>

    <div class="card" id="card-chart" style="display:none;">
      <div class="card-label">Serie temporal — <span id="chart-var-label">H₂S</span></div>
      <div class="chart-wrap"><canvas id="tray-chart"></canvas></div>
    </div>

    <div class="card" id="card-stats" style="display:none;">
      <div class="card-label">Estadísticas del recorrido</div>
      <div id="stats-body"></div>
    </div>

    <div class="card" id="card-resumen-tray" style="display:none;">
      <div class="card-label">Resumen del recorrido</div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-val" id="kpi-tray-total">0</div><div class="kpi-label">Lecturas</div></div>
        <div class="kpi crit"><div class="kpi-val" id="kpi-tray-crit">0</div><div class="kpi-label">Críticos</div></div>
        <div class="kpi warn"><div class="kpi-val" id="kpi-tray-adv">0</div><div class="kpi-label">Advertencias</div></div>
        <div class="kpi ok"><div class="kpi-val" id="kpi-tray-norm">0</div><div class="kpi-label">Sin novedad</div></div>
      </div>
    </div>

    <div class="card" id="umbral-card-tray" style="display:none;">
      <div class="card-label">Umbrales normativos</div>
      <div class="veh-meta">Cargando…</div>
    </div>`;

  document.getElementById('btn-cargar-tray').addEventListener('click', cargarTrayectoria);
  document.getElementById('btn-cargar-flota').addEventListener('click', cargarFlotaCompleta);
  legend.innerHTML = `
    <div style="font-weight:600;color:var(--text);margin-bottom:.3rem;">Nivel de exposición</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.critico}"></span>Crítico</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.advertencia}"></span>Advertencia</div>
    <div class="legend-item"><span class="legend-swatch" style="background:${COLORES.normal}"></span>Normal</div>`;

  poblarSelectVehiculos();
}

// --- Poblar los desplegables con los vehículos de la BD --------------------
async function poblarSelectVehiculos() {
  const selA = document.getElementById('inp-vehiculo');
  const selB = document.getElementById('inp-vehiculo-b');
  if (!selA) return;
  let ids = [];
  try {
    const fc = await getJSON('/api/vehiculos/ultimo');
    ids = (fc.features || [])
      .map((f) => f.properties.vehiculo_id)
      .filter((v, i, a) => v && a.indexOf(v) === i)   // únicos
      .sort();
  } catch {
    ids = ['C-16'];   // fallback
  }
  if (!ids.length) ids = ['C-16'];

  selA.innerHTML = ids.map((id) => `<option value="${id}">${id}</option>`).join('');
  if (ids.includes('C-07')) selA.value = 'C-07';
  else if (ids.includes('C-16')) selA.value = 'C-16';

  if (selB) {
    selB.innerHTML = '<option value="">— sin comparar —</option>' +
      ids.map((id) => `<option value="${id}">${id}</option>`).join('');
  }
}

async function cargarTrayectoria() {
  detenerAnimacion();
  capaTray.clearLayers();
  polylineaTrayB = null;   // se recreará si hay comparación

  const vehiculo = document.getElementById('inp-vehiculo').value.trim();
  trayVariable   = document.getElementById('sel-var-tray').value;
  const desde    = document.getElementById('inp-desde-tray').value;
  const hasta    = document.getElementById('inp-hasta-tray').value;

  if (!vehiculo) return;

  const btn = document.getElementById('btn-cargar-tray');
  btn.textContent = 'Cargando…';
  btn.disabled    = true;

  let fc;
  try {
    const qs = [];
    if (desde) qs.push('desde=' + encodeURIComponent(new Date(desde).toISOString()));
    if (hasta) qs.push('hasta=' + encodeURIComponent(new Date(hasta).toISOString()));
    const url = `/api/vehiculos/${encodeURIComponent(vehiculo)}/trayectoria` +
                (qs.length ? '?' + qs.join('&') : '');
    fc = await getJSON(url);
  } catch (e) {
    btn.textContent = 'Cargar trayectoria';
    btn.disabled    = false;
    alert('Error al cargar: ' + e.message);
    return;
  }

  btn.textContent = 'Cargar trayectoria';
  btn.disabled    = false;

  trayData = fc.features.filter((f) => f.geometry);
  if (!trayData.length) {
    alert('No hay datos para ese vehículo y rango de fechas.');
    return;
  }

  // ── 1. Polyline OSRM completa (ruta real sobre malla vial)
  if (typeof OSRM_ROUTE !== 'undefined' && OSRM_ROUTE.length) {
    polylineaTray = L.polyline(OSRM_ROUTE, {
      color: '#2f9e9b', weight: 3, opacity: 0.7,
    }).addTo(capaTray);
  } else {
    // Fallback: polyline desde puntos de BD
    const coordsLine = trayData.map((f) => { const [lon,lat]=f.geometry.coordinates; return [lat,lon]; });
    polylineaTray = L.polyline(coordsLine, { color: '#2f9e9b', weight: 3, opacity: 0.7 }).addTo(capaTray);
  }
  // ── 2. Puntos coloreados por nivel ────────────────────────────────────
  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const campo  = colKey[trayVariable];

  trayData.forEach((f, idx) => {
    const p      = f.properties;
    const valor  = p[campo];
    const color  = nivelColor(trayVariable, valor);
    const [lon, lat] = f.geometry.coordinates;

    const circle = L.circleMarker([lat, lon], {
      radius: 5, fillColor: color, color: color,
      weight: 1, fillOpacity: 0.85,
    });

    circle.bindPopup(`
      <div class="popup-title">${p.vehiculo_id} · ${fmtHora(p.ts)}</div>
      <div class="popup-row"><span>H₂S</span><span>${p.h2s_ppm ?? '—'} ppm</span></div>
      <div class="popup-row"><span>CH₄</span><span>${p.ch4_ppm ?? '—'} ppm</span></div>
      <div class="popup-row"><span>CO₂</span><span>${p.co2_ppm ?? '—'} ppm</span></div>
      <div class="popup-row"><span>PM2.5</span><span>${p.pm25_ugm3 ?? '—'} µg/m³</span></div>
      <div class="popup-row"><span>PM10</span><span>${p.pm10_ugm3 ?? '—'} µg/m³</span></div>
      <div class="popup-row" style="margin-top:.3rem;color:var(--text-dim)">
        <span>Punto</span><span>${idx + 1} / ${trayData.length}</span>
      </div>`);
    circle.addTo(capaTray);
  });

  // Centrar mapa en la extensión de todos los puntos
  const grupo = L.featureGroup(capaTray.getLayers());
  if (grupo.getLayers().length) {
    map.fitBounds(grupo.getBounds(), { padding: [40, 40] });
  }

  // ── 3. Estadísticas ───────────────────────────────────────────────────
  const vals = trayData.map((f) => f.properties[campo]).filter((v) => v != null);
  const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
  const max  = Math.max(...vals);
  const min  = Math.min(...vals);
  const excAdv  = vals.filter((v) => v >= UMBRALES_JS[trayVariable]?.adv).length;
  const excCrit = vals.filter((v) => v >= UMBRALES_JS[trayVariable]?.crit).length;
  const unidad  = VARIABLES[trayVariable].unidad;

  // Mostrar botones de heatmap
  document.getElementById('btn-heat-tray').style.display  = 'block';
  document.getElementById('btn-puntos-tray').style.display = 'block';

  document.getElementById('btn-heat-tray').onclick = () => renderHeatTray();
  document.getElementById('btn-puntos-tray').onclick = () => {
    if (capaHeatTray) { map.removeLayer(capaHeatTray); capaHeatTray = null; }
    capaTray.eachLayer((l) => { if (l instanceof L.CircleMarker) l.setStyle({ opacity: 1, fillOpacity: 0.85 }); });
  };

  document.getElementById('card-stats').style.display = 'block';
  document.getElementById('stats-body').innerHTML = `
    <div class="umbral-row"><span>Puntos</span><span>${vals.length}</span></div>
    <div class="umbral-row"><span>Promedio</span><span>${avg.toFixed(3)} ${unidad}</span></div>
    <div class="umbral-row"><span>Mínimo</span><span>${min.toFixed(3)} ${unidad}</span></div>
    <div class="umbral-row"><span>Máximo</span><span style="color:${max >= UMBRALES_JS[trayVariable]?.crit ? 'var(--alert)' : max >= UMBRALES_JS[trayVariable]?.adv ? 'var(--warn)' : 'var(--ok)'}">${max.toFixed(3)} ${unidad}</span></div>
    <div class="umbral-row"><span>En advertencia</span><span style="color:var(--warn)">${excAdv} pts</span></div>
    <div class="umbral-row"><span>En crítico</span><span style="color:var(--alert)">${excCrit} pts</span></div>
    <div class="ref-note">Variable: ${VARIABLES[trayVariable].label} · ${trayData.length} lecturas totales</div>`;

  // ── 3b. Resumen tipo supervisor (KPIs por nivel global del recorrido) ──
  const cuenta = { critico: 0, advertencia: 0, normal: 0 };
  trayData.forEach((f) => {
    const p = f.properties;
    let nivel = p.nivel_global;
    if (!nivel) {
      // Derivar nivel global a partir del peor nivel entre todas las variables
      nivel = 'normal';
      const campos = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
      for (const [v, col] of Object.entries(campos)) {
        const lv = nivelLabel(v, p[col]);
        if (lv === 'critico') { nivel = 'critico'; break; }
        if (lv === 'advertencia') nivel = 'advertencia';
      }
    }
    cuenta[nivel] = (cuenta[nivel] || 0) + 1;
  });

  document.getElementById('card-resumen-tray').style.display = 'block';
  document.getElementById('kpi-tray-total').textContent = trayData.length;
  document.getElementById('kpi-tray-crit').textContent  = cuenta.critico || 0;
  document.getElementById('kpi-tray-adv').textContent   = cuenta.advertencia || 0;
  document.getElementById('kpi-tray-norm').textContent  = cuenta.normal || 0;

  // ── 3c. Umbrales normativos ───────────────────────────────────────────
  cargarUmbralesTray();

  // ── 3d. Marca de tiempo y duración del recorrido ──────────────────────
  const tsList = trayData.map((f) => new Date(f.properties.ts)).filter((d) => !isNaN(d));
  const tsIni  = tsList.length ? new Date(Math.min(...tsList)) : null;
  const tsFin  = tsList.length ? new Date(Math.max(...tsList)) : null;
  const durMin = (tsIni && tsFin) ? Math.round((tsFin - tsIni) / 60000) : 0;
  const durTxt = durMin >= 60 ? `${Math.floor(durMin / 60)} h ${durMin % 60} min` : `${durMin} min`;
  trayInicio = tsIni;
  trayFin    = tsFin;

  // ── 3e. Gráfica de serie temporal ─────────────────────────────────────
  renderTrayChart();

  // ── 4. Controles de animación ─────────────────────────────────────────
  const cardAnim = document.getElementById('card-anim');
  cardAnim.style.display = 'block';

  const slider    = document.getElementById('slider-tray');
  slider.max      = trayData.length - 1;
  slider.value    = 0;
  document.getElementById('lbl-total').textContent = trayData.length;

  document.getElementById('tray-tiempos').innerHTML = `
    <div class="umbral-row"><span>Inicio</span><span>${fmtHora(tsIni)}</span></div>
    <div class="umbral-row"><span>Fin</span><span>${fmtHora(tsFin)}</span></div>
    <div class="umbral-row"><span>Duración</span><span>${durTxt}</span></div>`;

  // Control de velocidad
  const velMap = [480, 240, 120, 60, 30];          // ms por paso
  const velLbl = ['0.25×', '0.5×', '1×', '2×', '4×'];
  const sliderVel = document.getElementById('slider-vel');
  sliderVel.value = 2;
  animVelocidad   = velMap[2];
  document.getElementById('lbl-vel').textContent = velLbl[2];
  sliderVel.addEventListener('input', () => {
    const i = parseInt(sliderVel.value);
    animVelocidad = velMap[i];
    document.getElementById('lbl-vel').textContent = velLbl[i];
    if (animTimer) { detenerAnimacion(); iniciarAnimacion(); }  // aplicar en caliente
  });

  actualizarPunto(0);

  slider.addEventListener('input', () => {
    detenerAnimacion();
    actualizarPunto(parseInt(slider.value));
  });

  document.getElementById('btn-play').addEventListener('click', iniciarAnimacion);
  document.getElementById('btn-pause').addEventListener('click', detenerAnimacion);
  document.getElementById('btn-stop').addEventListener('click', () => {
    detenerAnimacion();
    slider.value = 0;
    actualizarPunto(0);
  });

  // ── 5. Comparación con segundo vehículo (opcional) ────────────────────
  const vehB = document.getElementById('inp-vehiculo-b')?.value.trim();
  if (vehB && vehB.toUpperCase() !== vehiculo.toUpperCase()) {
    await cargarComparacion(vehB, desde, hasta);
  } else {
    trayDataB = [];
    if (polylineaTrayB) { capaTray.removeLayer(polylineaTrayB); polylineaTrayB = null; }
    renderTrayChart();
  }
}

// --- Carga TODA la flota: dibuja los recorridos de todos los vehículos -----
async function cargarFlotaCompleta() {
  detenerAnimacion();
  limpiarMapa();
  trayData = [];
  trayDataB = [];
  polylineaTrayB = null;

  trayVariable = document.getElementById('sel-var-tray').value;
  const desde  = document.getElementById('inp-desde-tray').value;
  const hasta  = document.getElementById('inp-hasta-tray').value;
  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const campo  = colKey[trayVariable];

  // Lista de vehículos desde el desplegable (ya poblado desde la BD)
  const sel = document.getElementById('inp-vehiculo');
  const ids = Array.from(sel.options).map((o) => o.value);

  const btn = document.getElementById('btn-cargar-flota');
  btn.disabled = true;
  const txtOrig = btn.textContent;

  const qs = [];
  if (desde) qs.push('desde=' + encodeURIComponent(new Date(desde).toISOString()));
  if (hasta) qs.push('hasta=' + encodeURIComponent(new Date(hasta).toISOString()));
  const sufijo = qs.length ? '?' + qs.join('&') : '';

  let totalPuntos = 0;
  let vehConDatos = 0;
  const todosLosPuntos = [];   // para ajustar el encuadre del mapa
  const cuenta = { critico: 0, advertencia: 0, normal: 0 };

  for (let k = 0; k < ids.length; k++) {
    const veh = ids[k];
    btn.textContent = `Cargando ${veh}… (${k + 1}/${ids.length})`;

    let fc;
    try {
      fc = await getJSON(`/api/vehiculos/${encodeURIComponent(veh)}/trayectoria${sufijo}`);
    } catch {
      continue;   // si un vehículo falla, seguimos con los demás
    }
    const feats = (fc.features || []).filter((f) => f.geometry);
    if (!feats.length) continue;
    vehConDatos++;

    // Polyline del recorrido (gris tenue, sirve de hilo conductor)
    const coordsLine = feats.map((f) => { const [lon, lat] = f.geometry.coordinates; return [lat, lon]; });
    L.polyline(coordsLine, { color: '#5a6b75', weight: 2, opacity: 0.5 }).addTo(capaTray);

    // Puntos coloreados por nivel de la variable elegida
    feats.forEach((f) => {
      const p = f.properties;
      const valor = p[campo];
      const color = nivelColor(trayVariable, valor);
      const nivel = nivelLabel(trayVariable, valor);
      if (cuenta[nivel] != null) cuenta[nivel]++;
      const [lon, lat] = f.geometry.coordinates;
      todosLosPuntos.push([lat, lon]);

      const circle = L.circleMarker([lat, lon], {
        radius: 4, fillColor: color, color: color, weight: 1, fillOpacity: 0.85,
      });
      circle.bindTooltip(`${veh} · ${VARIABLES[trayVariable].label}: ${valor?.toFixed(2) ?? '—'} ${VARIABLES[trayVariable].unidad}`,
        { direction: 'top', offset: [0, -6] });
      circle.bindPopup(`
        <div class="popup-title">${veh} · ${fmtHora(p.ts)}</div>
        <div class="popup-row"><span>H₂S</span><span>${p.h2s_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>CH₄</span><span>${p.ch4_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>CO₂</span><span>${p.co2_ppm ?? '—'} ppm</span></div>
        <div class="popup-row"><span>PM2.5</span><span>${p.pm25_ugm3 ?? '—'} µg/m³</span></div>
        <div class="popup-row"><span>PM10</span><span>${p.pm10_ugm3 ?? '—'} µg/m³</span></div>`);
      circle.addTo(capaTray);
    });
    totalPuntos += feats.length;
  }

  btn.disabled = false;
  btn.textContent = txtOrig;

  // Encruadre del mapa a todos los recorridos
  if (todosLosPuntos.length) {
    map.fitBounds(L.latLngBounds(todosLosPuntos), { padding: [40, 40] });
  } else {
    alert('No se encontraron recorridos para el rango de fechas seleccionado.');
    return;
  }

  syncLabel.textContent = `Flota completa · ${vehConDatos} vehículos`;

  // Ocultar paneles propios de un solo recorrido (animación, gráfica, etc.)
  ['card-anim', 'card-chart', 'card-resumen-tray'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  document.getElementById('btn-heat-tray').style.display = 'none';
  document.getElementById('btn-puntos-tray').style.display = 'none';

  // Resumen de la flota en la tarjeta de estadísticas
  document.getElementById('card-stats').style.display = 'block';
  document.getElementById('stats-body').innerHTML = `
    <div class="umbral-row"><span>Vehículos</span><span>${vehConDatos} / ${ids.length}</span></div>
    <div class="umbral-row"><span>Puntos totales</span><span>${totalPuntos}</span></div>
    <div class="umbral-row"><span>Normales</span><span style="color:var(--ok)">${cuenta.normal}</span></div>
    <div class="umbral-row"><span>En advertencia</span><span style="color:var(--warn)">${cuenta.advertencia}</span></div>
    <div class="umbral-row"><span>En crítico</span><span style="color:var(--alert)">${cuenta.critico}</span></div>
    <div class="ref-note">Variable: ${VARIABLES[trayVariable].label} · flota completa</div>`;

  cargarUmbralesTray();
}

// --- Carga del segundo recorrido para comparar -----------------------------
async function cargarComparacion(vehiculo, desde, hasta) {
  let fc;
  try {
    const qs = [];
    if (desde) qs.push('desde=' + encodeURIComponent(new Date(desde).toISOString()));
    if (hasta) qs.push('hasta=' + encodeURIComponent(new Date(hasta).toISOString()));
    const url = `/api/vehiculos/${encodeURIComponent(vehiculo)}/trayectoria` +
                (qs.length ? '?' + qs.join('&') : '');
    fc = await getJSON(url);
  } catch (e) {
    alert('No se pudo cargar el vehículo de comparación: ' + e.message);
    return;
  }
  trayDataB = (fc.features || []).filter((f) => f.geometry);
  if (!trayDataB.length) { alert('El vehículo de comparación no tiene datos en ese rango.'); return; }

  // Polyline del segundo recorrido (punteada, color distinto)
  const coordsB = trayDataB.map((f) => { const [lon, lat] = f.geometry.coordinates; return [lat, lon]; });
  if (polylineaTrayB) capaTray.removeLayer(polylineaTrayB);
  polylineaTrayB = L.polyline(coordsB, {
    color: '#b06fd6', weight: 3, opacity: 0.7, dashArray: '6 6',
  }).addTo(capaTray);

  renderTrayChart();   // re-render con la segunda serie
}

// --- Gráfica de serie temporal (Chart.js) ----------------------------------
function renderTrayChart() {
  const canvas = document.getElementById('tray-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const cardChart = document.getElementById('card-chart');
  cardChart.style.display = 'block';
  document.getElementById('chart-var-label').textContent = VARIABLES[trayVariable].label;

  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const campo  = colKey[trayVariable];

  const serieA = trayData.map((f) => ({
    x: new Date(f.properties.ts).getTime(), y: f.properties[campo],
  })).filter((d) => d.y != null);

  const datasets = [{
    label: 'Recorrido A',
    data: serieA,
    borderColor: '#2f9e9b',
    backgroundColor: 'rgba(47,158,155,0.15)',
    borderWidth: 2, pointRadius: 0, tension: 0.25, fill: true,
  }];

  if (trayDataB.length) {
    const serieB = trayDataB.map((f) => ({
      x: new Date(f.properties.ts).getTime(), y: f.properties[campo],
    })).filter((d) => d.y != null);
    datasets.push({
      label: 'Recorrido B',
      data: serieB,
      borderColor: '#b06fd6',
      backgroundColor: 'rgba(176,111,214,0.12)',
      borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false, borderDash: [6, 6],
    });
  }

  // Líneas de umbral (advertencia / crítico)
  const u = UMBRALES_JS[trayVariable];
  const annotationData = [];
  if (u) {
    const xs = serieA.map((d) => d.x);
    if (xs.length) {
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      annotationData.push(
        { label: 'adv', y: u.adv, color: '#e0a13c', x0, x1 },
        { label: 'crit', y: u.crit, color: '#d9534f', x0, x1 },
      );
    }
  }
  annotationData.forEach((a) => {
    datasets.push({
      label: a.label === 'adv' ? 'Advertencia' : 'Crítico',
      data: [{ x: a.x0, y: a.y }, { x: a.x1, y: a.y }],
      borderColor: a.color, borderWidth: 1, borderDash: [3, 3],
      pointRadius: 0, fill: false,
    });
  });

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#8fa1ab';
  const gridColor = 'rgba(128,128,128,0.15)';

  if (trayChart) trayChart.destroy();
  trayChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: textColor, maxTicksLimit: 6,
            callback: (v) => new Date(v).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
          },
          grid: { color: gridColor },
        },
        y: {
          ticks: { color: textColor },
          grid: { color: gridColor },
          title: { display: true, text: VARIABLES[trayVariable].unidad, color: textColor },
        },
      },
      plugins: {
        legend: { labels: { color: textColor, boxWidth: 12, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString('es-CO', {
              hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
            }),
          },
        },
      },
    },
  });
}

function renderHeatTray() {
  // Quitar heatmap anterior si existe
  if (capaHeatTray) { map.removeLayer(capaHeatTray); capaHeatTray = null; }

  const colKey = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' };
  const campo  = colKey[trayVariable];
  const maxVar = VARIABLES[trayVariable].max;

  const puntos = trayData
    .filter((f) => f.geometry && f.properties[campo] != null)
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const intensidad = Math.min(f.properties[campo] / maxVar, 1);
      return [lat, lon, intensidad];
    });

  if (!puntos.length) return;

  capaHeatTray = L.heatLayer(puntos, {
    radius: 20, blur: 15, maxZoom: 17,
    gradient: { 0.0: '#2f9e9b', 0.5: '#e0a13c', 1.0: '#d9534f' },
  }).addTo(map);

  // Atenuar los marcadores de puntos para que el heatmap se vea mejor
  capaTray.eachLayer((l) => {
    if (l instanceof L.CircleMarker) l.setStyle({ opacity: 0.2, fillOpacity: 0.15 });
  });

  // Actualizar leyenda
  legend.innerHTML = `
    <div style="font-weight:600;color:var(--text);margin-bottom:.3rem;">
      ${VARIABLES[trayVariable].label} — Calor</div>
    <div class="legend-item">
      <span class="legend-swatch" style="background:linear-gradient(90deg,#2f9e9b,#e0a13c,#d9534f)"></span>
      bajo → alto</div>
    <div style="font-size:.68rem;color:var(--text-dim);margin-top:.3rem;">
      ${puntos.length} lecturas</div>`;
}

async function cargarUmbralesTray() {
  const card = document.getElementById('umbral-card-tray');
  if (!card) return;
  card.style.display = 'block';
  try {
    const u = await getJSON('/api/umbrales');
    const rows = u.map((x) => `
      <div class="umbral-row">
        <span>${VARIABLES[x.variable]?.label || x.variable}</span>
        <span>${x.advertencia} / ${x.critico} ${x.unidad === 'ugm3' ? 'µg/m³' : x.unidad}</span>
      </div>`).join('');
    card.innerHTML = `<div class="card-label">Umbrales (adv / crítico)</div>${rows}
      <div class="ref-note">Ref: ACGIH 2023 · OMS AQG 2021 (proxy PM)</div>`;
  } catch {
    card.innerHTML = `<div class="card-label">Umbrales normativos</div>
      <div class="veh-meta">No disponibles.</div>`;
  }
}

function actualizarPunto(idx) {
  animIdx = idx;
  const slider = document.getElementById('slider-tray');
  if (slider) slider.value = idx;
  document.getElementById('lbl-idx').textContent = idx + 1;

  const f     = trayData[idx];
  const p     = f.properties;
  const campo = { h2s: 'h2s_ppm', ch4: 'ch4_ppm', co2: 'co2_ppm', pm25: 'pm25_ugm3', pm10: 'pm10_ugm3' }[trayVariable];
  const valor = p[campo];
  const color = nivelColor(trayVariable, valor);
  const nivel = nivelLabel(trayVariable, valor);
  const unidad = VARIABLES[trayVariable].unidad;
  const [lon, lat] = f.geometry.coordinates;

  // Marcador animado
  if (marcadorActivo) capaTray.removeLayer(marcadorActivo);
  marcadorActivo = L.circleMarker([lat, lon], {
    radius: 10, fillColor: color, color: '#fff', weight: 2, fillOpacity: 1,
  }).addTo(capaTray);

  // Info panel
  document.getElementById('info-punto').innerHTML = `
    <div class="punto-ts">${fmtHora(p.ts)}</div>
    <div class="punto-valor" style="color:${color}">
      ${VARIABLES[trayVariable].label}: <strong>${valor?.toFixed(3) ?? '—'}</strong> ${unidad}
    </div>
    <div class="punto-nivel nivel-${nivel}">${nivel.toUpperCase()}</div>
    <div class="punto-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;

  // Pan suave al punto activo (sin zoom)
  map.panTo([lat, lon], { animate: true, duration: 0.3 });
}

function iniciarAnimacion() {
  if (animTimer) return;
  if (animIdx >= trayData.length - 1) animIdx = 0;
  animTimer = setInterval(() => {
    if (animIdx >= trayData.length - 1) {
      detenerAnimacion();
      return;
    }
    actualizarPunto(animIdx + 1);
  }, animVelocidad);
}

function detenerAnimacion() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
}

// ============================================================
//  Navegación entre vistas
// ============================================================
const btnSup  = document.getElementById('btn-supervisor');
const btnTray = document.getElementById('btn-trayectoria');

function setVistaActiva(activo) {
  [btnSup, btnTray].forEach((b) => b?.classList.remove('active'));
  activo?.classList.add('active');
}

btnSup.addEventListener('click', () => { setVistaActiva(btnSup); vistaSupervisor(); });
btnTray?.addEventListener('click', () => { setVistaActiva(btnTray); vistaTrayectoria(); });

// ============================================================
//  Reloj automático (fecha y hora)
// ============================================================
function actualizarReloj() {
  const el = document.getElementById('clock');
  if (!el) return;
  el.textContent = new Date().toLocaleString('es-CO', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ============================================================
//  Tema claro / oscuro
// ============================================================
const btnTheme = document.getElementById('btn-theme');

function aplicarTema(claro) {
  document.body.classList.toggle('light', claro);
  if (btnTheme) btnTheme.textContent = claro ? '☀️' : '🌙';
  try { localStorage.setItem('tema', claro ? 'light' : 'dark'); } catch {}
}

btnTheme?.addEventListener('click', () => {
  aplicarTema(!document.body.classList.contains('light'));
});

// Restaurar preferencia guardada (por defecto, oscuro)
let temaGuardado = 'dark';
try { temaGuardado = localStorage.getItem('tema') || 'dark'; } catch {}
aplicarTema(temaGuardado === 'light');

// --- Arranque ---------------------------------------------------------------
checkHealth();
vistaSupervisor();
setInterval(checkHealth, 30000);
actualizarReloj();
setInterval(actualizarReloj, 1000);

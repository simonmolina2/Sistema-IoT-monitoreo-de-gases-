// ============================================================
//  GEOPORTAL EMVARIAS — ETL ThingsBoard Cloud → PostgreSQL/PostGIS
//  v3.0
//
//  Autenticación: API Key de ThingsBoard (TB_API_KEY en .env)
//
//  EJECUCIÓN:
//    node etl.js                              ← últimas 24h
//    node etl.js --horas 48                   ← últimas 48h
//    node etl.js --desde 2026-05-05T00:00:00  ← desde fecha exacta
//    node etl.js --info                       ← ver keys disponibles
//
//  VARIABLES DE ENTORNO (.env):
//    TB_API_KEY    API Key de ThingsBoard
//    TB_DEVICE_ID  UUID del dispositivo
//    TB_VEHICULO   vehiculo_id en geoportal (ej: C-07)
//    TB_RUTA       ruta_id en geoportal (ej: C07-REAL)
//    PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
// ============================================================

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// ── Configuración ThingsBoard ────────────────────────────────
const TB_HOST      = process.env.TB_HOST      || 'https://thingsboard.cloud';
const TB_API_KEY   = process.env.TB_API_KEY;
const TB_DEVICE_ID = process.env.TB_DEVICE_ID || '767377d0-6741-11f1-85a3-7f815107dff5';
const TB_VEHICULO  = process.env.TB_VEHICULO  || 'C-07';
const TB_RUTA      = process.env.TB_RUTA      || null;

// Keys que publica el ESP32
// mq4=CH₄ | mq9=CO₂ proxy | pm25 | pm10 | h2s (pendiente)
const TB_KEYS = 'mq4_ppm,mq9_ppm,h2s,pm25,pm10,lat,lon,sat,temp,presion,altitud';

// GPS fallback cuando no hay fix (lat=0 / lon=0)
const GPS_FALLBACK_LAT = 6.2442;
const GPS_FALLBACK_LON = -75.5812;
const GPS_MIN_LAT = 5.5;
const GPS_MAX_LAT = 6.9;
const GPS_MIN_LON = -76.2;
const GPS_MAX_LON = -75.0;

// ── Conexión PostgreSQL ──────────────────────────────────────
const pool = new pg.Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'geoportal_emvarias',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

// ── Umbrales (ACGIH 2023 / OMS AQG 2021) ────────────────────
const UMBRALES = {
  h2s:  { alerta: 1,    critico: 5     },  // ppm
  ch4:  { alerta: 5000, critico: 10000 },  // ppm
  co2:  { alerta: 1000, critico: 5000  },  // ppm
  pm25: { alerta: 37,   critico: 75    },  // µg/m³
  pm10: { alerta: 75,   critico: 150   },  // µg/m³
};

// ── Utilidades ───────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--info')) return { modo: 'info' };

  const idxDesde = args.indexOf('--desde');
  if (idxDesde !== -1) {
    const ts = new Date(args[idxDesde + 1]);
    if (isNaN(ts.getTime())) {
      console.error('❌  Fecha inválida. Usa formato: 2026-05-05T00:00:00');
      process.exit(1);
    }
    return { modo: 'sync', startMs: ts.getTime() };
  }

  const idxHoras = args.indexOf('--horas');
  const horas = idxHoras !== -1 ? Number(args[idxHoras + 1]) : 24;
  return { modo: 'sync', startMs: Date.now() - horas * 3_600_000 };
}

function clasificarAlerta(variable, valor) {
  if (valor === null || valor === undefined || isNaN(valor)) return null;
  const u = UMBRALES[variable];
  if (!u) return null;
  if (valor >= u.critico) return 'CRITICO';
  if (valor >= u.alerta)  return 'ALERTA';
  return 'NORMAL';
}

function validarGPS(lat, lon) {
  const latN = Number(lat);
  const lonN = Number(lon);
  if (
    isNaN(latN) || isNaN(lonN) ||
    latN === 0  || lonN === 0  ||
    latN < GPS_MIN_LAT || latN > GPS_MAX_LAT ||
    lonN < GPS_MIN_LON || lonN > GPS_MAX_LON
  ) {
    return { lat: GPS_FALLBACK_LAT, lon: GPS_FALLBACK_LON, fallback: true };
  }
  return { lat: latN, lon: lonN, fallback: false };
}

// ── API ThingsBoard ──────────────────────────────────────────

function tbHeaders() {
  if (!TB_API_KEY) {
    console.error('❌  TB_API_KEY no definido en .env');
    process.exit(1);
  }
  return {
    'Content-Type': 'application/json',
    'X-Authorization': `ApiKey ${TB_API_KEY}`,
  };
}

async function tbGet(path) {
  const url = `${TB_HOST}${path}`;
  const res = await fetch(url, { headers: tbHeaders() });

  if (res.status === 401) {
    console.error('❌  API Key inválida o sin permisos.');
    console.error('    Verifica TB_API_KEY en el .env');
    process.exit(1);
  }
  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`ThingsBoard ${res.status}: ${texto}`);
  }
  return res.json();
}

async function obtenerInfoDispositivo() {
  console.log(`🔍  Consultando dispositivo ${TB_DEVICE_ID}...`);
  const info = await tbGet(`/api/device/${TB_DEVICE_ID}`);
  console.log('\n📟  Dispositivo:');
  console.log(`    Nombre: ${info.name}`);
  console.log(`    Tipo:   ${info.type}`);
  console.log(`    ID:     ${info.id.id}`);

  const keys = await tbGet(`/api/plugins/telemetry/DEVICE/${TB_DEVICE_ID}/keys/timeseries`);
  console.log(`\n📡  Keys disponibles en ThingsBoard: ${keys.join(', ')}`);
}

async function obtenerTelemetria(startMs, endMs) {
  const url = `/api/plugins/telemetry/DEVICE/${TB_DEVICE_ID}/values/timeseries` +
    `?keys=${TB_KEYS}` +
    `&startTs=${startMs}` +
    `&endTs=${endMs}` +
    `&limit=50000` +
    `&orderBy=ASC`;

  console.log(`\n📡  Consultando ThingsBoard...`);
  console.log(`    Desde: ${new Date(startMs).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
  console.log(`    Hasta: ${new Date(endMs).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);

  return tbGet(url);
}

// ── Pivot por timestamp ──────────────────────────────────────

function pivotearLecturas(data) {
  const puntos = [];
  for (const [key, valores] of Object.entries(data)) {
    for (const { ts, value } of valores) {
      puntos.push({ ts: Number(ts), key, value });
    }
  }
  if (puntos.length === 0) return [];

  puntos.sort((a, b) => a.ts - b.ts);

  const VENTANA_MS = 10_000;
  const grupos = [];
  let grupoActual = null;

  for (const punto of puntos) {
    if (!grupoActual || punto.ts - grupoActual.tsBase > VENTANA_MS) {
      grupoActual = { tsBase: punto.ts, valores: {} };
      grupos.push(grupoActual);
    }
    grupoActual.valores[punto.key] = punto.value;
  }

  return grupos;
}

// ── Carga a PostgreSQL ───────────────────────────────────────

async function asegurarVehiculo(client) {
  await client.query(`
    INSERT INTO vehiculo (vehiculo_id, descripcion, placa, activo)
    VALUES ($1, $2, $3, true)
    ON CONFLICT (vehiculo_id) DO NOTHING
  `, [TB_VEHICULO, `Vehículo ${TB_VEHICULO}`, TB_VEHICULO]);
}

async function asegurarMicroruta(client) {
  if (!TB_RUTA) return;
  await client.query(`
    INSERT INTO microruta (ruta_id, nombre, zona, comuna, turno)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (ruta_id) DO NOTHING
  `, [TB_RUTA, `Ruta ${TB_RUTA}`, 'Sin zona', 'Sin comuna', 'Diurno']);
}

async function insertarLecturas(grupos) {
  const client = await pool.connect();
  let insertados = 0;
  let duplicados = 0;
  let errores    = 0;
  let fallbackGPS = 0;

  try {
    await client.query('BEGIN');
    await asegurarVehiculo(client);
    await asegurarMicroruta(client);

    for (const grupo of grupos) {
      const v = grupo.valores;

      const ch4_ppm   = v.mq4_ppm !== undefined ? Number(v.mq4_ppm) : null;
      const co2_ppm   = v.mq9_ppm !== undefined ? Number(v.mq9_ppm) : null;
      const h2s_ppm   = v.h2s     !== undefined ? Number(v.h2s)     : null;
      const pm25_ugm3 = v.pm25    !== undefined ? Number(v.pm25)    : null;
      const pm10_ugm3 = v.pm10    !== undefined ? Number(v.pm10)    : null;
      const temp_c    = v.temp    !== undefined ? Number(v.temp)    : null;
      const presion   = v.presion !== undefined ? Number(v.presion) : null;
      const altitud   = v.altitud !== undefined ? Number(v.altitud) : null;
      const gps_sat   = v.sat     !== undefined ? Number(v.sat)     : null;

      const gps = validarGPS(v.lat, v.lon);
      if (gps.fallback) fallbackGPS++;

      // Nivel de alerta más grave
      const niveles = [
        clasificarAlerta('h2s',  h2s_ppm),
        clasificarAlerta('ch4',  ch4_ppm),
        clasificarAlerta('co2',  co2_ppm),
        clasificarAlerta('pm25', pm25_ugm3),
        clasificarAlerta('pm10', pm10_ugm3),
      ].filter(Boolean);

      let nivel_alerta = 'NORMAL';
      if (niveles.includes('CRITICO'))    nivel_alerta = 'CRITICO';
      else if (niveles.includes('ALERTA')) nivel_alerta = 'ALERTA';

      // Timestamp con offset Colombia
      const ts = new Date(grupo.tsBase).toISOString(); // UTC puro — PostgreSQL maneja la zona horaria

      try {
        const res = await client.query(`
          INSERT INTO lectura (
            vehiculo_id, ruta_id, ts,
            geom,
            ch4_ppm, co2_ppm, h2s_ppm,
            pm25_ugm3, pm10_ugm3,
            temp_c, presion_hpa, altitud_m, gps_sat
          ) VALUES (
            $1, $2, $3,
            ST_SetSRID(ST_MakePoint($4, $5), 4326),
            $6, $7, $8,
            $9, $10,
            $11, $12, $13, $14
          )
          ON CONFLICT (vehiculo_id, ts) DO NOTHING
        `, [
          TB_VEHICULO, TB_RUTA, ts,
          gps.lon, gps.lat,
          ch4_ppm, co2_ppm, h2s_ppm,
          pm25_ugm3, pm10_ugm3,
          temp_c, presion, altitud, gps_sat,
        ]);

        if (res.rowCount > 0) insertados++;
        else duplicados++;

      } catch (rowErr) {
        errores++;
        if (errores <= 3) {
          console.error(`  ⚠️  Error fila ts=${grupo.tsBase}: ${rowErr.message}`);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { insertados, duplicados, errores, fallbackGPS };
}

// ── Resumen DB ───────────────────────────────────────────────

async function obtenerResumenDB() {
  const res = await pool.query(`
    SELECT
      COUNT(*)                                           AS total,
      MIN(ts AT TIME ZONE 'America/Bogota')              AS primera,
      MAX(ts AT TIME ZONE 'America/Bogota')              AS ultima,
      COUNT(*) FILTER (WHERE ch4_ppm  IS NOT NULL)       AS con_ch4,
      COUNT(*) FILTER (WHERE co2_ppm  IS NOT NULL)       AS con_co2,
      COUNT(*) FILTER (WHERE pm25_ugm3 IS NOT NULL)      AS con_pm25,
      COUNT(*) FILTER (WHERE pm10_ugm3 IS NOT NULL)      AS con_pm10,
      ROUND(AVG(ch4_ppm)::numeric,  2)                   AS ch4_avg,
      ROUND(AVG(co2_ppm)::numeric,  2)                   AS co2_avg,
      ROUND(AVG(pm25_ugm3)::numeric, 2)                  AS pm25_avg,
      ROUND(AVG(pm10_ugm3)::numeric, 2)                  AS pm10_avg
    FROM lectura
    WHERE vehiculo_id = $1
  `, [TB_VEHICULO]);
  return res.rows[0];
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log('\n══════════════════════════════════════════════════');
  console.log('  EMVARIAS — ETL ThingsBoard → PostgreSQL/PostGIS ');
  console.log('  v3.0 — Autenticación: API Key                   ');
  console.log('══════════════════════════════════════════════════');

  try {
    await pool.query('SELECT 1');
    console.log('\n✅  PostgreSQL: OK');
    console.log(`    Vehículo:  ${TB_VEHICULO}`);
    console.log(`    Ruta:      ${TB_RUTA || 'NULL (sin ruta)'}`);

    if (args.modo === 'info') {
      await obtenerInfoDispositivo();
      return; // pool.end() se ejecuta en finally
    }

    const endMs   = Date.now();
    const startMs = args.startMs;

    // 1. Extraer
    const rawData = await obtenerTelemetria(startMs, endMs);
    const keysObtenidas = Object.keys(rawData);

    if (keysObtenidas.length === 0) {
      console.log('\n⚠️   ThingsBoard no devolvió datos para ese período.');
      return;
    }

    const totalBrutos = Object.values(rawData).reduce((s, a) => s + a.length, 0);
    console.log(`\n📊  Recibido de ThingsBoard:`);
    console.log(`    Keys:          ${keysObtenidas.join(', ')}`);
    console.log(`    Puntos brutos: ${totalBrutos}`);

    // 2. Transformar
    const grupos = pivotearLecturas(rawData);
    console.log(`    Lecturas (ventana 10s): ${grupos.length}`);

    if (grupos.length === 0) {
      console.log('\n⚠️   Sin lecturas tras el agrupamiento.');
      return;
    }

    // 3. Cargar
    console.log('\n💾  Insertando en PostgreSQL...');
    const { insertados, duplicados, errores, fallbackGPS } = await insertarLecturas(grupos);

    console.log(`\n✅  Carga completada:`);
    console.log(`    Insertadas:  ${insertados}`);
    console.log(`    Duplicadas:  ${duplicados}`);
    if (errores > 0)    console.log(`    ⚠️  Errores:   ${errores}`);
    if (fallbackGPS > 0) {
      console.log(`    ⚠️  GPS fallback (sin fix): ${fallbackGPS} lecturas`);
      console.log(`       → Coord usada: ${GPS_FALLBACK_LAT}, ${GPS_FALLBACK_LON}`);
    }

    // 4. Resumen
    const r = await obtenerResumenDB();
    console.log(`\n📈  Estado en DB — ${TB_VEHICULO}:`);
    console.log(`    Total lecturas: ${r.total}`);
    if (r.primera) {
      console.log(`    Primera:        ${new Date(r.primera).toLocaleString('es-CO')}`);
      console.log(`    Última:         ${new Date(r.ultima).toLocaleString('es-CO')}`);
    }
    console.log(`    Con CH₄:   ${r.con_ch4}  | promedio: ${r.ch4_avg ?? 'N/D'} ppm`);
    console.log(`    Con CO₂:   ${r.con_co2}  | promedio: ${r.co2_avg ?? 'N/D'} ppm`);
    console.log(`    Con PM2.5: ${r.con_pm25} | promedio: ${r.pm25_avg ?? 'N/D'} µg/m³`);
    console.log(`    Con PM10:  ${r.con_pm10} | promedio: ${r.pm10_avg ?? 'N/D'} µg/m³`);

  } catch (err) {
    console.error('\n❌  Error ETL:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

main();

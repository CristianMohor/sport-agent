#!/usr/bin/env node
'use strict';

/**
 * scraper.js — actualiza data/fixture.json via TheSportsDB (gratuita, sin key)
 *
 * Estrategia:
 *   • Itera jornadas 1-30 con /eventsround.php?id=4627&r=N&s=2026
 *   • Merge cross-fecha: busca cada partido por (local, visita) en TODAS las
 *     fechas existentes → tolera el offset de numeración entre TheSportsDB y
 *     la numeración propia del fixture.json
 *   • Preserva probabilidades calculadas manualmente
 *   • Actualiza resultado sólo cuando intHomeScore no es null
 *
 * Uso local:  node scraper.js
 */

const fs  = require('fs');
const path = require('path');

const FIXTURE_PATH  = path.join(__dirname, 'data', 'fixture.json');
const LEAGUE_ID     = 4627;   // Chile Primera Division (Liga de Primera)
const SEASON        = 2026;
const TOTAL_ROUNDS  = 30;
const BATCH_SIZE    = 5;      // peticiones en paralelo por lote
const CHILE_OFFSET  = -4;     // UTC-4 invierno (abr–sep)

// ── Fetch de una jornada ────────────────────────────────────────────────────

async function fetchRound(round) {
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsround.php` +
              `?id=${LEAGUE_ID}&r=${round}&s=${SEASON}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sport-agent-bot/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} en jornada ${round}`);
  const data = await res.json();
  return data.events ?? [];
}

async function fetchAllRounds() {
  const all = [];
  for (let start = 1; start <= TOTAL_ROUNDS; start += BATCH_SIZE) {
    const rounds = Array.from(
      { length: Math.min(BATCH_SIZE, TOTAL_ROUNDS - start + 1) },
      (_, i) => start + i
    );
    const results = await Promise.all(rounds.map(fetchRound));
    results.forEach((evs, i) => {
      if (evs.length) all.push({ round: rounds[i], events: evs });
    });
    // Pausa mínima entre lotes para no saturar la API
    if (start + BATCH_SIZE <= TOTAL_ROUNDS) await sleep(300);
  }
  return all;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Parseo de evento ────────────────────────────────────────────────────────

function parseEvent(ev, roundNum) {
  const dateStr = ev.dateEvent ?? '';
  const timeStr = ev.strTime   ?? '00:00:00';

  let localFecha = dateStr;
  let hora       = '00:00';

  if (dateStr) {
    const [y, m, d]   = dateStr.split('-').map(Number);
    const [h, min]    = timeStr.split(':').map(Number);
    const utcMs       = Date.UTC(y, m - 1, d, h, min);
    const localDt     = new Date(utcMs + CHILE_OFFSET * 3600_000);
    localFecha        = localDt.toISOString().slice(0, 10);
    hora              = `${pad(localDt.getUTCHours())}:${pad(localDt.getUTCMinutes())}`;
  }

  const hs = ev.intHomeScore;
  const as = ev.intAwayScore;
  const resultado = (hs !== null && hs !== undefined && as !== null && as !== undefined)
    ? [hs, as] : null;

  return {
    roundNum,
    fecha:    localFecha,
    hora,
    local:    normalizeEquipo(ev.strHomeTeam ?? ''),
    visita:   normalizeEquipo(ev.strAwayTeam ?? ''),
    estadio:  ev.strVenue ?? '',
    resultado,
  };
}

// ── Merge ────────────────────────────────────────────────────────────────────
// TheSportsDB es la fuente de verdad para equipos, fechas, horarios y resultados.
// El merge solo preserva el campo "prob" de un partido existente cuando
// (local, visita) coincide DENTRO DE LA MISMA JORNADA (mismo round).
// Esto evita que resultados de jornadas pasadas contaminen fechas incorrectas.

function mergeFixture(existing, roundsData) {
  const today = new Date().toISOString().slice(0, 10);

  // Índice de probs existentes: "round:local:visita" → prob
  const probIndex = {};
  for (const ef of existing.fechas) {
    for (const ep of ef.partidos) {
      if (ep.prob !== null && ep.prob !== undefined) {
        probIndex[`${ef.numero}:${ep.local}:${ep.visita}`] = ep.prob;
      }
    }
  }

  // Reconstruye fechas completamente desde TheSportsDB
  const fechas = roundsData.map(({ round, events }) => {
    const partidos = events
      .map(ev => parseEvent(ev, round))
      .filter(p => p.local && p.visita)
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora))
      .map((p, i) => ({
        id:        `f${round}-${String(i + 1).padStart(2, '0')}`,
        fecha:     p.fecha,
        hora:      p.hora,
        local:     p.local,
        visita:    p.visita,
        estadio:   p.estadio,
        resultado: p.resultado,
        prob:      probIndex[`${round}:${p.local}:${p.visita}`] ?? null,
      }));

    const todos  = partidos.every(p => p.resultado !== null);
    const alguno = partidos.some(p  => p.resultado !== null);
    const estado = todos ? 'finalizada' : alguno ? 'en-curso' : 'proxima';

    return { numero: round, nombre: `Fecha ${round}`, estado, partidos };
  });

  fechas.sort((a, b) => a.numero - b.numero);

  return {
    ...existing,
    actualizado: today,
    fechas,
  };
}

// ── Normalización de equipos ────────────────────────────────────────────────

const EQUIPO_MAP = [
  [/universidad\s+de\s+chile/i,              'U. de Chile'],
  [/universidad\s+cat[oó]lica/i,             'U. Católica'],
  [/u\.?\s*(de\s+)?chile\b/i,                'U. de Chile'],
  [/dep\.?\s*la\s+serena|la\s+serena\b/i,    'D. La Serena'],
  [/dep\.?\s*limache|limache\b/i,            'D. Limache'],
  [/universidad\s+de\s+concepc/i,            'U. Concepción'],
  [/^dep(ortes)?\s+concepc/i,               'D. Concepción'],  // distinto de U. Concepción
  [/uni[oó]n\s+espa[nñ]ola/i,               'Unión Española'],
  [/uni[oó]n\s+la\s+calera/i,               'Unión La Calera'],
  [/coquimbo/i,                              'Coquimbo Unido'],
  [/audax/i,                                 'Audax Italiano'],
  [/cobresal/i,                              'Cobresal'],
  [/palestino/i,                             'Palestino'],
  [/everton/i,                               'Everton'],
  [/[nñ]ublense/i,                           'Ñublense'],
  [/magallanes/i,                            'Magallanes'],
  [/o'?higgins/i,                            "O'Higgins"],
  [/rangers/i,                               'Rangers'],
  [/huachipato/i,                            'Huachipato'],
  [/colo[\s-]colo/i,                         'Colo Colo'],
];

function normalizeEquipo(nombre) {
  for (const [re, canonical] of EQUIPO_MAP) {
    if (re.test(nombre)) return canonical;
  }
  return nombre.trim();
}

const pad = n => String(n).padStart(2, '0');

// ── Vercel deploy hook ──────────────────────────────────────────────────────

async function triggerVercelDeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) { console.log('ℹ VERCEL_DEPLOY_HOOK no configurado — se omite deploy'); return; }
  const res = await fetch(hook, { method: 'POST' });
  console.log(res.ok ? '🚀 Deploy Vercel disparado' : `⚠ Vercel webhook → ${res.status}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔎 TheSportsDB — Liga de Primera Chile (id=${LEAGUE_ID}, s=${SEASON})`);
  console.log(`   Descargando ${TOTAL_ROUNDS} jornadas en lotes de ${BATCH_SIZE}…`);

  const roundsData = await fetchAllRounds();
  const totalEvs   = roundsData.reduce((n, r) => n + r.events.length, 0);
  console.log(`✅ ${roundsData.length} jornadas con datos / ${totalEvs} partidos`);

  if (!roundsData.length) {
    console.error('❌ Sin datos — verifica LEAGUE_ID y SEASON');
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const merged   = mergeFixture(existing, roundsData);

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log('💾 data/fixture.json actualizado');

  await triggerVercelDeploy();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * scraper.js — actualiza data/fixture.json via TheSportsDB (gratuita, sin key)
 *
 * Itera todas las competiciones activas 2026 (Liga de Primera, Copa de la Liga,
 * Primera B, Copa Chile), descarga jornadas y hace merge preservando probs y tabla.
 *
 * Uso local:  node scraper.js
 */

const fs  = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'data', 'fixture.json');
const SEASON       = 2026;
const REQ_DELAY    = 2000;  // ms entre peticiones (evita rate limit en free tier)
const CHILE_OFFSET = -4;   // UTC-4 invierno (abr–sep)

const COMPETITIONS = [
  { id: 'liga-primera', nombre: 'Liga de Primera ML', sportsdb_id: 4627, rounds: 30 },
  { id: 'copa-liga',    nombre: 'Copa de la Liga',    sportsdb_id: 5858, rounds: 5  },
  { id: 'primera-b',   nombre: 'Primera B',           sportsdb_id: 4899, rounds: 30 },
  { id: 'copa-chile',  nombre: 'Copa Chile',          sportsdb_id: 5378, rounds: 10 },
];

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchRound(leagueId, round, retries = 3) {
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsround.php` +
              `?id=${leagueId}&r=${round}&s=${SEASON}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'sport-agent-bot/1.0' } });
    if (res.status === 429) {
      const wait = attempt * 10_000;
      console.log(`   ⏳ Rate limit jornada ${round} — esperando ${wait/1000}s…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} en jornada ${round}`);
    const data = await res.json();
    return data.events ?? [];
  }
  throw new Error(`Rate limit persistente en jornada ${round}`);
}

async function fetchAllRounds(leagueId, totalRounds) {
  const all = [];
  for (let r = 1; r <= totalRounds; r++) {
    const evs = await fetchRound(leagueId, r);
    if (evs.length) all.push({ round: r, events: evs });
    if (r < totalRounds) await sleep(REQ_DELAY);
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

// ── Merge competición ────────────────────────────────────────────────────────
// Reconstruye fechas desde TheSportsDB.
// Preserva el campo "prob" (round:local:visita) y la "tabla" intactos.

function mergeComp(existingComp, roundsData) {
  const probIndex = {};
  for (const ef of (existingComp.fechas ?? [])) {
    for (const ep of ef.partidos) {
      if (ep.prob !== null && ep.prob !== undefined) {
        probIndex[`${ef.numero}:${ep.local}:${ep.visita}`] = ep.prob;
      }
    }
  }

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
    ...existingComp,
    fechas,
    // tabla se preserva sin modificar (actualización manual)
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
  [/^dep(ortes)?\s+concepc/i,               'D. Concepción'],
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
  const today    = new Date().toISOString().slice(0, 10);
  const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  const updatedComps = [];

  for (const comp of COMPETITIONS) {
    console.log(`\n🔎 ${comp.nombre} (id=${comp.sportsdb_id}) — hasta ${comp.rounds} jornadas`);

    const existingComp = existing.competiciones.find(c => c.id === comp.id) ?? {
      id:         comp.id,
      nombre:     comp.nombre,
      sportsdb_id: comp.sportsdb_id,
      rounds:     comp.rounds,
      fechas:     [],
      tabla:      null,
    };

    let roundsData;
    try {
      roundsData = await fetchAllRounds(comp.sportsdb_id, comp.rounds);
    } catch (err) {
      console.log(`   ⚠ Error: ${err.message} — se conserva existente`);
      updatedComps.push(existingComp);
      if (comp !== COMPETITIONS[COMPETITIONS.length - 1]) await sleep(3000);
      continue;
    }

    const totalEvs = roundsData.reduce((n, r) => n + r.events.length, 0);
    console.log(`   ✅ ${roundsData.length} jornadas con datos / ${totalEvs} partidos`);

    if (roundsData.length) {
      updatedComps.push(mergeComp(existingComp, roundsData));
    } else {
      console.log(`   ⚠ Sin datos — se conserva existente`);
      updatedComps.push(existingComp);
    }

    // Pausa entre competiciones para no saturar la API
    if (comp !== COMPETITIONS[COMPETITIONS.length - 1]) await sleep(3000);
  }

  const merged = {
    ...existing,
    actualizado: today,
    competiciones: updatedComps,
  };

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log('\n💾 data/fixture.json actualizado');

  await triggerVercelDeploy();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });

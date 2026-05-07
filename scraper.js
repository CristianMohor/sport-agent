#!/usr/bin/env node
'use strict';

/**
 * scraper.js — actualiza data/fixture.json vía API-Football (RapidAPI)
 *
 * Requisitos:
 *   1. Crear cuenta gratis en https://rapidapi.com
 *   2. Suscribirse a "API-Football" (plan Basic gratuito, 100 req/día)
 *   3. Agregar el API key como secret en GitHub: API_FOOTBALL_KEY
 *
 * Uso local:
 *   API_FOOTBALL_KEY=xxx node scraper.js
 */

const fs   = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'data', 'fixture.json');
const API_HOST     = 'api-football-v1.p.rapidapi.com';
const API_BASE     = `https://${API_HOST}/v3`;
const LEAGUE       = 265;   // Chile - Liga de Primera (verificar en RapidAPI si cambia)
const SEASON       = 2026;
// Chile invernal (abr–sep) = UTC-4
const CHILE_OFFSET = -4;

// ── API fetch ───────────────────────────────────────────────────────────────

async function apiFetch(endpoint) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('Falta API_FOOTBALL_KEY — agrégala como secret en GitHub o variable de entorno local');

  const url = `${API_BASE}${endpoint}`;
  console.log(`  → GET ${url}`);

  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key':  key,
      'X-RapidAPI-Host': API_HOST,
    },
  });

  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  const json = await res.json();

  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
  }
  console.log(`     ${json.results ?? json.response?.length ?? '?'} resultados`);
  return json.response;
}

// ── Parseo de respuesta API ─────────────────────────────────────────────────

function apiToFechas(fixtures) {
  // Agrupa partidos por fecha/jornada
  const byRound = {};

  for (const f of fixtures) {
    // league.round → "Regular Season - 13" o "Fecha 13"
    const roundStr = f.league?.round ?? '';
    const numMatch = roundStr.match(/(\d+)\s*$/);
    if (!numMatch) continue;
    const numero = parseInt(numMatch[1], 10);
    if (numero < 1 || numero > 38) continue;

    if (!byRound[numero]) byRound[numero] = [];
    byRound[numero].push(f);
  }

  return Object.entries(byRound)
    .map(([num, matches]) => {
      const numero   = parseInt(num, 10);
      const partidos = matches
        .map((m, i) => {
          // Convierte UTC → hora local Chile
          const utcDt   = new Date(m.fixture.date);
          const localDt = new Date(utcDt.getTime() + CHILE_OFFSET * 3600 * 1000);
          const fecha   = localDt.toISOString().slice(0, 10);
          const hora    = `${pad(localDt.getUTCHours())}:${pad(localDt.getUTCMinutes())}`;

          const local  = normalizeEquipo(m.teams.home.name);
          const visita = normalizeEquipo(m.teams.away.name);

          const gh = m.goals?.home;
          const ga = m.goals?.away;
          const resultado = (gh !== null && gh !== undefined && ga !== null && ga !== undefined)
            ? [gh, ga] : null;

          return {
            id:        `f${numero}-${String(i + 1).padStart(2, '0')}`,
            fecha,
            hora,
            local,
            visita,
            estadio:   m.fixture.venue?.name ?? '',
            resultado,
            prob:      null,
          };
        })
        // Ordena por fecha y hora
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora))
        // Reasigna IDs después de ordenar
        .map((p, i) => ({ ...p, id: `f${numero}-${String(i + 1).padStart(2, '0')}` }));

      return { numero, nombre: `Fecha ${numero}`, partidos };
    })
    .sort((a, b) => a.numero - b.numero);
}

// ── Normalización de equipos ────────────────────────────────────────────────
// API-Football devuelve nombres en inglés o con variantes; aquí los
// homologamos a los nombres canónicos usados en el fixture.json.

const EQUIPO_MAP = [
  [/universidad\s+de\s+chile/i,   'U. de Chile'],
  [/universidad\s+cat/i,          'U. Católica'],
  [/u\.?\s*cat[oó]lica/i,         'U. Católica'],
  [/u\.?\s*(de\s+)?chile/i,       'U. de Chile'],
  [/dep\.?\s*la\s+serena/i,       'D. La Serena'],
  [/la\s+serena/i,                'D. La Serena'],
  [/dep\.?\s*limache/i,           'D. Limache'],
  [/limache/i,                    'D. Limache'],
  [/dep\.?\s*concepc/i,           'U. Concepción'],
  [/universidad\s+de\s+concepc/i, 'U. Concepción'],
  [/uni[oó]n\s+espa[nñ]ola/i,     'Unión Española'],
  [/uni[oó]n\s+la\s+calera/i,     'Unión La Calera'],
  [/coquimbo/i,                   'Coquimbo Unido'],
  [/audax/i,                      'Audax Italiano'],
  [/cobresal/i,                   'Cobresal'],
  [/palestino/i,                  'Palestino'],
  [/everton/i,                    'Everton'],
  [/[nñ]ublense/i,                'Ñublense'],
  [/magallanes/i,                 'Magallanes'],
  [/o'?higgins/i,                 "O'Higgins"],
  [/rangers/i,                    'Rangers'],
  [/huachipato/i,                 'Huachipato'],
  [/colo[\s-]colo/i,              'Colo Colo'],
];

function normalizeEquipo(nombre) {
  if (!nombre) return '';
  for (const [re, canonical] of EQUIPO_MAP) {
    if (re.test(nombre)) return canonical;
  }
  return nombre.trim();
}

const pad = n => String(n).padStart(2, '0');

// ── Merge inteligente ───────────────────────────────────────────────────────

function mergeFixture(existing, scraped) {
  const today  = new Date().toISOString().slice(0, 10);
  const result = { ...existing, actualizado: today };

  for (const sf of scraped) {
    const ef = result.fechas.find(f => f.numero === sf.numero);

    if (!ef) {
      result.fechas.push({ numero: sf.numero, nombre: sf.nombre, estado: 'proxima', partidos: sf.partidos });
      continue;
    }

    for (const sp of sf.partidos) {
      const ep = ef.partidos.find(p => p.local === sp.local && p.visita === sp.visita);
      if (!ep) {
        ef.partidos.push(sp);
      } else {
        if (sp.fecha)              ep.fecha    = sp.fecha;
        if (sp.hora)               ep.hora     = sp.hora;
        if (sp.estadio)            ep.estadio  = sp.estadio;
        if (sp.resultado !== null) ep.resultado = sp.resultado;
        // Preserva las probabilidades calculadas manualmente
      }
    }

    const todos  = ef.partidos.every(p => p.resultado !== null);
    const alguno = ef.partidos.some(p  => p.resultado !== null);
    ef.estado = todos ? 'finalizada' : alguno ? 'en-curso' : 'proxima';
  }

  result.fechas.sort((a, b) => a.numero - b.numero);
  return result;
}

// ── Vercel deploy hook ──────────────────────────────────────────────────────

async function triggerVercelDeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) { console.log('ℹ VERCEL_DEPLOY_HOOK no definido — se omite'); return; }
  const res = await fetch(hook, { method: 'POST' });
  console.log(res.ok ? '🚀 Deploy Vercel disparado' : `⚠ Vercel webhook → ${res.status}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔎 Descargando fixture de API-Football…');
  const raw     = await apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}`);
  const scraped = apiToFechas(raw);

  if (!scraped.length) {
    console.error(`❌ Sin datos — verifica que LEAGUE=${LEAGUE} y SEASON=${SEASON} son correctos`);
    process.exit(1);
  }
  console.log(`✅ ${scraped.length} fechas / ${raw.length} partidos procesados`);

  const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const merged   = mergeFixture(existing, scraped);

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log('💾 data/fixture.json actualizado');

  await triggerVercelDeploy();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });

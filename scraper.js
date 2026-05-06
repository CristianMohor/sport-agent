#!/usr/bin/env node
'use strict';

/**
 * scraper.js — actualiza data/fixture.json con datos de livefutbol.com
 *
 * Uso local:          node scraper.js
 * En GitHub Actions:  se ejecuta automáticamente (ver .github/workflows/update-fixture.yml)
 *
 * Variables de entorno (configura como Secrets en GitHub):
 *   VERCEL_DEPLOY_HOOK  — URL del Deploy Hook de Vercel (opcional)
 */

const fs   = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'data', 'fixture.json');
const SOURCE_URL   = 'https://www.livefutbol.com/campeonato-nacional/';
const SEASON       = 2026;

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'es-CL,es;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al obtener ${url}`);
  return res.text();
}

// ── Parseo HTML ─────────────────────────────────────────────────────────────
// Ajusta los selectores CSS en parseWithCheerio() si el HTML del sitio cambia.

function parseHtml(html) {
  try {
    const cheerio = require('cheerio');
    return parseWithCheerio(cheerio, html);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error('Instala las dependencias primero: npm install');
    }
    throw e;
  }
}

function parseWithCheerio(cheerio, html) {
  const $ = cheerio.load(html);
  const fechas = [];

  // ─────────────────────────────────────────────────────────────────────────
  // SELECTORES — ajusta según el HTML real de livefutbol.com.
  // Para inspeccionarlos: abre la URL en el navegador → F12 → Network → Doc.
  //
  // Estrategia: busca contenedores de "Fecha N" y dentro los partidos.
  // ─────────────────────────────────────────────────────────────────────────

  // Selector del bloque de cada fecha/jornada
  const FECHA_SELECTOR = [
    '.fecha', '[class*="fecha"]',
    '.jornada', '[class*="jornada"]',
    '.round', '[class*="round"]',
    '.matchday', '[class*="matchday"]',
  ].join(', ');

  // Selector del título de cada fecha
  const TITULO_SELECTOR = '.titulo, .nombre, h2, h3, h4, [class*="titulo"], [class*="nombre"]';

  // Selector de cada partido dentro del bloque de fecha
  const PARTIDO_SELECTOR = [
    '.partido', '[class*="partido"]',
    '.match', '[class*="match"]',
    '.fixture-row', '[class*="fixture"]',
  ].join(', ');

  $(FECHA_SELECTOR).each((_, bloque) => {
    const titulo   = $(bloque).find(TITULO_SELECTOR).first().text().trim();
    const numMatch = titulo.match(/\d+/);
    if (!numMatch) return;
    const numero   = parseInt(numMatch[0], 10);
    if (numero < 1 || numero > 30) return;       // solo fechas válidas del torneo

    const partidos = [];
    $(bloque).find(PARTIDO_SELECTOR).each((i, el) => {
      const local   = extractTeam($, el, 'local,home');
      const visita  = extractTeam($, el, 'visita,away,visitor');
      if (!local || !visita) return;

      const hora    = extractText($, el, 'hora,time,horario').replace(/\s*hrs?\.?/i, '').trim();
      const estadio = extractText($, el, 'estadio,venue,estadio-nombre,ground');
      const fechaStr = $(el).attr('data-fecha')
                    || $(el).attr('data-date')
                    || extractText($, el, 'fecha,date');

      // Resultado: "2-1", "2 - 1", etc.
      const resRaw = extractText($, el, 'resultado,score,marcador,result');
      const resultado = parseResultado(resRaw);

      partidos.push({
        id:        `f${numero}-${String(i + 1).padStart(2, '0')}`,
        fecha:     normalizeFecha(fechaStr) || '',
        hora:      normalizeHora(hora),
        local:     normalizeEquipo(local),
        visita:    normalizeEquipo(visita),
        estadio:   estadio,
        resultado: resultado,
        prob:      null,
      });
    });

    if (partidos.length) {
      fechas.push({ numero, nombre: `Fecha ${numero}`, partidos });
    }
  });

  // Fallback: si el sitio no usa esos contenedores, intentar parsear la
  // lista plana de partidos con la fecha indicada en un atributo data-fecha.
  if (!fechas.length) {
    console.warn(
      '⚠ No se encontraron bloques de fecha. Intentando parseo alternativo…\n' +
      '  Abre ' + SOURCE_URL + ' en el navegador, inspecciona el HTML\n' +
      '  y actualiza los selectores en scraper.js → parseWithCheerio()'
    );

    const byFecha = {};
    $('[class*="partido"], [class*="match"], [class*="fixture"]').each((_, el) => {
      const fechaAttr = $(el).attr('data-fecha') || $(el).attr('data-round') || '';
      const numMatch  = fechaAttr.match(/\d+/);
      if (!numMatch) return;
      const numero = parseInt(numMatch[0], 10);
      if (!byFecha[numero]) byFecha[numero] = [];

      const local  = extractTeam($, el, 'local,home');
      const visita = extractTeam($, el, 'visita,away,visitor');
      if (!local || !visita) return;

      const hora    = extractText($, el, 'hora,time').replace(/\s*hrs?\.?/i, '').trim();
      const estadio = extractText($, el, 'estadio,venue');
      const resRaw  = extractText($, el, 'resultado,score,marcador');
      const fechaStr = $(el).attr('data-date') || extractText($, el, 'fecha,date');

      byFecha[numero].push({
        id:        `f${numero}-${String(byFecha[numero].length + 1).padStart(2, '0')}`,
        fecha:     normalizeFecha(fechaStr) || '',
        hora:      normalizeHora(hora),
        local:     normalizeEquipo(local),
        visita:    normalizeEquipo(visita),
        estadio:   estadio,
        resultado: parseResultado(resRaw),
        prob:      null,
      });
    });

    for (const [num, partidos] of Object.entries(byFecha)) {
      fechas.push({ numero: parseInt(num, 10), nombre: `Fecha ${num}`, partidos });
    }
  }

  return fechas;
}

// ── Helpers de extracción ───────────────────────────────────────────────────

function extractTeam($, el, keys) {
  for (const k of keys.split(',')) {
    const sel = `.${k}, [class*="${k}"]`;
    const txt = $(el).find(sel).first().text().trim();
    if (txt) return txt;
  }
  return '';
}

function extractText($, el, keys) {
  for (const k of keys.split(',')) {
    const sel = `.${k}, [class*="${k}"]`;
    const txt = $(el).find(sel).first().text().trim();
    if (txt) return txt;
  }
  return '';
}

// ── Normalización ───────────────────────────────────────────────────────────

const EQUIPO_MAP = [
  [/universidad\s+de\s+chile/i,       'U. de Chile'],
  [/universidad\s+cat[oó]lica/i,      'U. Católica'],
  [/u\.?\s*cat[oó]lica/i,             'U. Católica'],
  [/u\.?\s*(de\s+)?chile/i,           'U. de Chile'],
  [/deportes\s+la\s+serena/i,         'D. La Serena'],
  [/deportes\s+limache/i,             'D. Limache'],
  [/deportes\s+concepc/i,             'U. Concepción'],   // alias frecuente en webs
  [/universidad\s+de\s+concepc/i,     'U. Concepción'],
  [/uni[oó]n\s+espa[nñ]ola/i,         'Unión Española'],
  [/uni[oó]n\s+la\s+calera/i,         'Unión La Calera'],
  [/coquimbo\s+unido/i,               'Coquimbo Unido'],
  [/coquimbo/i,                       'Coquimbo Unido'],
  [/audax\s+italiano/i,               'Audax Italiano'],
  [/audax/i,                          'Audax Italiano'],
  [/cobresal/i,                       'Cobresal'],
  [/palestino/i,                      'Palestino'],
  [/everton/i,                        'Everton'],
  [/[nñ]ublense/i,                    'Ñublense'],
  [/magallanes/i,                     'Magallanes'],
  [/o'?higgins/i,                     "O'Higgins"],
  [/rangers/i,                        'Rangers'],
  [/huachipato/i,                     'Huachipato'],
  [/colo[\s-]colo/i,                  'Colo Colo'],
];

function normalizeEquipo(nombre) {
  for (const [re, canonical] of EQUIPO_MAP) {
    if (re.test(nombre)) return canonical;
  }
  return nombre.trim();
}

function normalizeHora(str) {
  const m = str.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : str;
}

function normalizeFecha(str) {
  if (!str) return null;
  str = str.trim();
  // ISO yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // dd/mm/yyyy
  const d1 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (d1) return `${d1[3]}-${d1[2].padStart(2,'0')}-${d1[1].padStart(2,'0')}`;
  // "22 may 2026"
  const MONTHS = {ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12};
  const d2 = str.match(/(\d{1,2})\s+([a-záéíóú]{3})\s+(\d{4})/i);
  if (d2) {
    const mo = MONTHS[d2[2].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')];
    if (mo) return `${d2[3]}-${String(mo).padStart(2,'0')}-${d2[1].padStart(2,'0')}`;
  }
  return null;
}

function parseResultado(str) {
  if (!str) return null;
  const m = str.match(/(\d+)\s*[-–:]\s*(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

// ── Merge inteligente ───────────────────────────────────────────────────────
// Preserva resultados y probabilidades existentes; solo actualiza lo que el
// scraper encontró. Agrega fechas/partidos nuevos sin borrar historial.

function mergeFixture(existing, scraped) {
  const today  = new Date().toISOString().slice(0, 10);
  const result = { ...existing, actualizado: today };

  for (const sf of scraped) {
    const ef = result.fechas.find(f => f.numero === sf.numero);

    if (!ef) {
      result.fechas.push({
        numero:   sf.numero,
        nombre:   sf.nombre,
        estado:   'proxima',
        partidos: sf.partidos.map(p => ({ ...p, prob: null })),
      });
      continue;
    }

    for (const sp of sf.partidos) {
      const ep = ef.partidos.find(
        p => p.local === sp.local && p.visita === sp.visita
      );
      if (!ep) {
        ef.partidos.push({ ...sp, prob: null });
      } else {
        if (sp.fecha)                ep.fecha    = sp.fecha;
        if (sp.hora)                 ep.hora     = sp.hora;
        if (sp.estadio)              ep.estadio  = sp.estadio;
        if (sp.resultado !== null)   ep.resultado = sp.resultado;
      }
    }

    // Actualiza estado de la fecha
    const todos   = ef.partidos.every(p => p.resultado !== null);
    const alguno  = ef.partidos.some(p  => p.resultado !== null);
    ef.estado = todos ? 'finalizada' : alguno ? 'en-curso' : 'proxima';
  }

  result.fechas.sort((a, b) => a.numero - b.numero);
  return result;
}

// ── Vercel deploy hook ──────────────────────────────────────────────────────

async function triggerVercelDeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) {
    console.log('ℹ VERCEL_DEPLOY_HOOK no definido — se omite el deploy automático');
    return;
  }
  const res = await fetch(hook, { method: 'POST' });
  if (res.ok) console.log('🚀 Deploy en Vercel disparado correctamente');
  else        console.warn(`⚠ Vercel webhook respondió ${res.status}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔎 Obteniendo fixture de ${SOURCE_URL}…`);
  const html    = await fetchPage(SOURCE_URL);
  const scraped = parseHtml(html);

  if (!scraped.length) {
    console.error(
      '❌ No se encontraron partidos en el HTML descargado.\n' +
      '   Revisa los selectores en parseWithCheerio() dentro de scraper.js.'
    );
    process.exit(1);
  }

  console.log(`✅ ${scraped.length} fechas encontradas`);

  const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const merged   = mergeFixture(existing, scraped);

  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log('💾 data/fixture.json actualizado');

  await triggerVercelDeploy();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });

import * as M from './model.js?v=20261024a';
import { EXAMPLES } from './examples.js?v=20261024a';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  fips: null,
  mw: 300,
  basis: 'facility',
  cooling: 'unknown',
  source: 'unknown',
  util: M.PARAMS.defaultUtil,
  cycles: 4,
  pue: null,
  claimValue: '',
  claimKind: 'peak',
  placeLabel: '',
};

let DATA = null;          // { meta, byFips: Map, list: [] }
let PLACES = null;        // [[name, st, fips], ...] loaded lazily
let placesLoading = null;

// ---------------- data ----------------
async function loadCounties() {
  const [json, drought] = await Promise.all([
    fetch('data/counties.json').then((r) => r.json()),
    fetch('data/drought.json').then((r) => r.json()).catch(() => null),
  ]);
  const cols = json.cols;
  const byFips = new Map();
  const list = [];
  for (const r of json.rows) {
    const o = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    o.search = norm(o.n.replace(/ (County|Parish|Borough|Census Area|Municipality|City and Borough|Planning Region|Municipio|city)$/i, ''));
    o.dr = drought?.rows?.[o.f] || null;
    byFips.set(o.f, o);
    list.push(o);
  }
  const meta = { ...json.meta };
  if (drought?.date) {
    const d = String(drought.date);
    meta.droughtDate = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  DATA = { meta, byFips, list };
}

function loadPlaces() {
  if (PLACES) return Promise.resolve(PLACES);
  if (!placesLoading) {
    placesLoading = fetch('data/places.json').then((r) => r.json()).then((j) => {
      PLACES = j.rows.map(([n, st, f, pop]) => ({ n, st, f, pop: pop || 0, search: norm(n) }));
      return PLACES;
    }).catch(() => { PLACES = []; return PLACES; });
  }
  return placesLoading;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto rico' };

function parseQuery(q) {
  // "waco, tx" / "pima county az" / "goochland virginia"
  let text = norm(q);
  let st = null;
  const parts = text.split(' ');
  const last = parts[parts.length - 1];
  const last2 = parts.slice(-2).join(' ');
  for (const [abbr, name] of Object.entries(STATES)) {
    if (parts.length > 1 && last === abbr.toLowerCase()) { st = abbr; text = parts.slice(0, -1).join(' '); break; }
    if (text.endsWith(' ' + name) || text === name) { st = abbr; text = text.slice(0, -name.length).trim(); break; }
    if (parts.length > 2 && last2 === name) { st = abbr; text = parts.slice(0, -2).join(' '); break; }
  }
  text = text.replace(/^(city|town|village) of /, '').trim();
  // Counties are matched without their suffix; places keep words like "city"
  // so "Cedar City" and "Carson City" still match.
  const countyText = text.replace(/\b(county|parish|borough|census area|municipio)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, countyText, st };
}

function search(q) {
  if (!DATA) return [];
  const { text, countyText, st } = parseQuery(q);
  if (!text) return [];
  const out = [];
  const saysCounty = countyText !== text;
  for (const c of DATA.list) {
    if (st && c.s !== st) continue;
    if (!countyText) continue;
    const i = c.search.indexOf(countyText);
    if (i === -1) continue;
    const score = (i === 0 ? 0 : 2) + (c.search === countyText ? -1 : 0) + (saysCounty ? -1 : 0) - Math.log10((c.pop || 1)) / 10;
    out.push({ kind: 'county', fips: c.f, label: `${c.n}, ${c.s}`, note: 'county', score });
  }
  if (PLACES) {
    for (const p of PLACES) {
      if (st && p.st !== st) continue;
      const i = p.search.indexOf(text);
      if (i === -1) continue;
      const county = DATA.byFips.get(p.f);
      if (!county) continue;
      const score = (i === 0 ? 0.5 : 2.5) + (p.search === text ? -1 : 0) - Math.log10((p.pop || 1)) / 8;
      out.push({ kind: 'place', fips: p.f, label: `${p.n}, ${p.st}`, note: county.n, score });
    }
  }
  out.sort((a, b) => a.score - b.score);
  const seen = new Set();
  return out.filter((r) => { const k = r.label + r.fips; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
}

// ---------------- URL state ----------------
function writeHash() {
  const p = new URLSearchParams();
  if (state.fips) p.set('fips', state.fips);
  p.set('mw', String(state.mw));
  if (state.basis !== 'facility') p.set('basis', state.basis);
  if (state.cooling !== 'unknown') p.set('cooling', state.cooling);
  if (state.source !== 'unknown') p.set('source', state.source);
  if (state.util !== M.PARAMS.defaultUtil) p.set('util', String(Math.round(state.util * 100)));
  if (state.cycles !== 4) p.set('cycles', String(state.cycles));
  if (state.pue) p.set('pue', String(state.pue));
  if (state.claimValue) { p.set('claim', String(state.claimValue)); p.set('claimKind', state.claimKind); }
  if (state.placeLabel) p.set('place', state.placeLabel);
  history.replaceState(null, '', '#' + p.toString());
  lastHash = location.hash;
}
let lastHash = '';
const DEFAULTS = { ...state };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('fips')) state.fips = p.get('fips');
  if (p.get('mw')) state.mw = clampNum(p.get('mw'), 1, 20000, 300);
  if (p.get('basis') === 'it') state.basis = 'it';
  if (['evaporative', 'hybrid', 'dry'].includes(p.get('cooling'))) state.cooling = p.get('cooling');
  if (['potable', 'groundwater', 'surface', 'reclaimed'].includes(p.get('source'))) state.source = p.get('source');
  if (p.get('util')) state.util = clampNum(p.get('util'), 40, 95, 65) / 100;
  if (p.get('cycles')) state.cycles = clampNum(p.get('cycles'), 2, 10, 4);
  if (p.get('pue')) state.pue = clampNum(p.get('pue'), 1.03, 2.5, null);
  if (p.get('claim')) { state.claimValue = clampNum(p.get('claim'), 0, 1e12, ''); state.claimKind = ['peak', 'avg', 'annualMg', 'annualAf'].includes(p.get('claimKind')) ? p.get('claimKind') : 'peak'; }
  if (p.get('place')) state.placeLabel = p.get('place').slice(0, 80);
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------- form wiring ----------------
function syncForm() {
  $('#mw').value = state.mw;
  document.querySelectorAll('[data-basis]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.basis === state.basis)));
  const radio = document.querySelector(`input[name="cooling"][value="${state.cooling}"]`);
  if (radio) radio.checked = true;
  $('#source').value = state.source;
  $('#util').value = Math.round(state.util * 100);
  $('#utilOut').textContent = Math.round(state.util * 100) + '%';
  $('#cycles').value = state.cycles;
  $('#cyclesOut').textContent = state.cycles;
  $('#pue').value = state.pue || '';
  if (state.util !== M.PARAMS.defaultUtil || state.cycles !== 4 || state.pue) $('#adv').open = true;
  renderPlaceChip();
}

function renderPlaceChip() {
  const c = state.fips && DATA?.byFips.get(state.fips);
  const chip = $('#placeChip');
  if (!c) { chip.innerHTML = ''; return; }
  const z = M.CLIMATES[M.climateClass(c.z)].label;
  chip.innerHTML = `<span class="place-chip">${esc(c.n)}, ${esc(c.s)} · climate zone ${esc(c.z || '–')} (${esc(z.toLowerCase())})</span>`;
  if (!$('#place').value) $('#place').value = state.placeLabel || `${c.n}, ${c.s}`;
}

function wireForm() {
  const place = $('#place');
  const list = $('#placeList');
  let items = [];
  let active = -1;
  const close = () => { list.hidden = true; place.setAttribute('aria-expanded', 'false'); active = -1; };
  const open = () => { list.hidden = false; place.setAttribute('aria-expanded', 'true'); };
  const paint = () => {
    list.innerHTML = items.map((r, i) => `<li role="option" id="opt${i}" data-i="${i}" aria-selected="${i === active}">${esc(r.label)}<small>${esc(r.note)}</small></li>`).join('');
    if (active >= 0) place.setAttribute('aria-activedescendant', 'opt' + active); else place.removeAttribute('aria-activedescendant');
  };
  const choose = (r) => {
    state.fips = r.fips;
    state.placeLabel = r.kind === 'place' ? r.label : '';
    place.value = r.label;
    close();
    renderPlaceChip();
    update();
  };
  const refresh = () => {
    items = search(place.value);
    if (!items.length) { close(); return; }
    active = 0;
    paint();
    open();
  };
  place.addEventListener('input', () => {
    if (!PLACES && place.value.trim().length >= 2) loadPlaces().then(() => { if (document.activeElement === place) refresh(); });
    refresh();
  });
  place.addEventListener('focus', () => { loadPlaces(); });
  place.addEventListener('keydown', (e) => {
    if (list.hidden) { if (e.key === 'ArrowDown') refresh(); return; }
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[active]) choose(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(items[+li.dataset.i]); } });
  place.addEventListener('blur', () => setTimeout(close, 120));

  $('#mw').addEventListener('input', (e) => { const v = Number(e.target.value); if (v > 0) { state.mw = Math.min(v, 20000); update(); } });
  document.querySelectorAll('[data-basis]').forEach((b) => b.addEventListener('click', () => { state.basis = b.dataset.basis; syncForm(); update(); }));
  document.querySelectorAll('input[name="cooling"]').forEach((r) => r.addEventListener('change', () => { state.cooling = r.value; update(); }));
  $('#source').addEventListener('change', (e) => { state.source = e.target.value; update(); });
  $('#util').addEventListener('input', (e) => { state.util = Number(e.target.value) / 100; $('#utilOut').textContent = e.target.value + '%'; update(); });
  $('#cycles').addEventListener('input', (e) => { state.cycles = Number(e.target.value); $('#cyclesOut').textContent = e.target.value; update(); });
  $('#pue').addEventListener('input', (e) => { const v = Number(e.target.value); state.pue = v >= 1.03 && v <= 2.5 ? v : null; update(); });

  const ex = $('#examples');
  ex.innerHTML = '<span style="font-size:13px;color:var(--text-3);align-self:center">Real cases:</span>' + EXAMPLES.map((x, i) => `<button type="button" class="chip" data-ex="${i}">${esc(x.chip)}</button>`).join('');
  ex.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    const x = EXAMPLES[+b.dataset.ex];
    Object.assign(state, { fips: x.fips, mw: x.mw, basis: x.basis || 'facility', cooling: x.cooling || 'unknown', source: x.source || 'unknown', util: M.PARAMS.defaultUtil, cycles: 4, pue: null, claimValue: x.claim?.value || '', claimKind: x.claim?.kind || 'peak', placeLabel: x.place || '' });
    $('#place').value = x.place || '';
    syncForm();
    update();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('basin-theme', root.dataset.theme); } catch (e) {}
  });
}

// ---------------- rendering ----------------
let lastResult = null;

function update() {
  writeHash();
  const county = state.fips ? DATA.byFips.get(state.fips) : null;
  const res = $('#results');
  if (!county) {
    res.innerHTML = `<div class="card empty"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c4.6 6.2 9 11.2 9 16a9 9 0 0 1-18 0c0-4.8 4.4-9.8 9-16z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><p style="margin-top:12px">Choose a county or city to see the estimate.</p></div>`;
    lastResult = null;
    return;
  }
  const input = { mw: state.mw, basis: state.basis, cooling: state.cooling, source: state.source, util: state.util, cycles: state.cycles, pue: state.pue };
  const r = M.estimate(input, county);
  lastResult = { input, county, r };
  const claimOpen = document.activeElement && document.activeElement.id === 'claimValue';
  res.innerHTML = [
    headlineCard(input, county, r),
    contextCard(input, county, r),
    chartCard(input, county, r),
    claimCard(input, county),
    leversCard(input, county, r),
    questionsCard(input, county),
    shareCard(),
    embedAttrib(),
  ].join('');
  wireResults();
  if (claimOpen) { const el = $('#claimValue'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

const g = (x) => M.fmtGal(x);
const gs = (x) => M.fmtGal(x, { short: true });

function headlineCard(input, county, r) {
  const where = `${esc(county.n)}, ${esc(county.s)}`;
  const size = `${M.fmtNum(input.mw, 3)} MW ${input.basis === 'it' ? 'IT load' : 'total power'}`;
  if (r.selected) {
    const s = r.selected;
    const c = s.central;
    return `<section class="card headline">
      <div class="eyebrow">Water drawn · ${esc(M.COOLING[input.cooling].short.toLowerCase())} cooling · ${size}</div>
      <div class="hero-num">${gs(c.peakDailyGal)}<span class="unit">gallons on a peak summer day</span></div>
      <p class="hero-range">Likely range ${gs(s.low.peakDailyGal)} to ${gs(s.high.peakDailyGal)} gallons. Average day about ${g(c.avgDailyGal)}. Per year about ${g(c.annualGal)} (${M.fmtNum(c.annualGal / M.GAL_PER_ACRE_FOOT)} acre-feet).</p>
      <div class="kv">
        <div>Evaporated (lost to air) <b>${g(c.annualConsumedGal)}/yr</b></div>
        <div>Water at power plants <b>${g(c.indirectAnnualGal)}/yr</b></div>
        <div>Electricity <b>${M.fmtNum(c.facilityKwhYear / 1e6)} GWh/yr</b></div>
        <div>WUE <b>${M.fmtNum(c.wue, 2)} L/kWh</b></div>
      </div>
    </section>`;
  }
  const e = r.byCooling.evaporative.central, h = r.byCooling.hybrid.central, d = r.byCooling.dry.central;
  return `<section class="card headline">
    <div class="eyebrow">Water drawn · cooling not disclosed · ${size}</div>
    <div class="hero-num">${gs(d.peakDailyGal)} – ${gs(e.peakDailyGal)}<span class="unit block">gallons on a peak summer day</span></div>
    <p class="hero-range">The cooling system is the biggest factor, so the first thing to ask is which one the developer plans to use. Typical estimates for ${where}:</p>
    <div class="tiles">
      ${scenTile('Evaporative / towers', e)}
      ${scenTile('Hybrid / adiabatic', h)}
      ${scenTile('Closed-loop / air-cooled', d)}
    </div>
  </section>`;
}

function scenTile(label, c) {
  return `<div class="tile"><div class="t-label">${esc(label)}</div><div class="t-value">${gs(c.peakDailyGal)}</div><div class="t-note">gal on a peak day<br>${g(c.annualGal)} per year</div></div>`;
}

function droughtBadge(county) {
  const dr = county.dr;
  if (!dr) return '<span class="badge b-neutral">No data</span>';
  const [d0, d1, d2, d3, d4] = dr;
  if (d3 >= 20) return `<span class="badge b-crit">Extreme drought</span>`;
  if (d2 >= 20) return `<span class="badge b-crit">Severe drought</span>`;
  if (d1 >= 20) return `<span class="badge b-warn">Moderate drought</span>`;
  if (d0 >= 20) return `<span class="badge b-warn">Abnormally dry</span>`;
  return `<span class="badge b-ok">No drought</span>`;
}

function droughtNote(county) {
  const dr = county.dr;
  if (!dr) return '';
  const names = ['abnormally dry (D0) or worse', 'moderate drought (D1) or worse', 'severe drought (D2) or worse', 'extreme drought (D3) or worse', 'exceptional drought (D4)'];
  let i = 4;
  while (i > 0 && dr[i] < 1) i--;
  if (dr[i] < 1) return 'None of the county is abnormally dry. ';
  return `${Math.round(dr[i])}% of the county is in ${names[i]}. `;
}

const WS_LABELS = ['Low', 'Low–medium', 'Medium–high', 'High', 'Extremely high'];
function stressBadge(county) {
  if (county.ws == null || county.ws < 0) return county.ws === -1 ? '<span class="badge b-warn">Arid, low water use</span>' : '<span class="badge b-neutral">No data</span>';
  const cls = county.ws >= 3 ? 'b-crit' : county.ws === 2 ? 'b-warn' : 'b-ok';
  return `<span class="badge ${cls}">${WS_LABELS[county.ws]}</span>`;
}

function contextCard(input, county, r) {
  const est = r.selected || r.byCooling.evaporative;
  const ctx = r.context;
  const assumed = r.selected ? '' : ' <span class="t-note">(if evaporative)</span>';
  const meta = DATA.meta;
  const tiles = [];
  tiles.push(`<div class="tile"><div class="t-label">Same as the daily use of</div><div class="t-value">${M.fmtNum(ctx.householdsAvg)} homes</div><div class="t-note">${M.fmtNum(ctx.householdsPeak)} homes on a peak day${assumed}. 300 gal per household per day (EPA).</div></div>`);
  if (ctx.shareOfPublicSupplyAvg != null) {
    const served = county.psPop ? `Public systems here serve about ${M.fmtNum(county.psPop)} people with ${M.fmtNum(county.ps, 3)} million gal/day` : `Public supply here: ${M.fmtNum(county.ps, 3)} million gal/day`;
    tiles.push(`<div class="tile"><div class="t-label">Of the county's public water supply</div><div class="t-value">${M.fmtPct(ctx.shareOfPublicSupplyAvg)}</div><div class="t-note">${M.fmtPct(ctx.shareOfPublicSupplyPeak)} on a peak day${assumed}. ${served} (USGS ${meta.usgsYear}).</div></div>`);
  }
  tiles.push(`<div class="tile"><div class="t-label">Drought now</div><div class="t-value" style="font-size:16px;margin-top:6px">${droughtBadge(county)}</div><div class="t-note">${droughtNote(county)}U.S. Drought Monitor, ${esc(meta.droughtDate || '')}.</div></div>`);
  tiles.push(`<div class="tile"><div class="t-label">Long-term water stress</div><div class="t-value" style="font-size:16px;margin-top:6px">${stressBadge(county)}</div><div class="t-note">Baseline water stress in this county's watershed (WRI Aqueduct 4.0).</div></div>`);
  const notes = [];
  if (input.source === 'reclaimed') notes.push(`<div class="callout ok">${icon('check')}<div>Reclaimed wastewater doesn't come out of the drinking-water supply. Ask what that water would otherwise do: return to a river, recharge an aquifer, or go to other reuse customers.</div></div>`);
  if (input.source === 'groundwater' && ctx.shareOfGroundwaterAvg != null) notes.push(`<div class="callout warn">${icon('info')}<div>That's about <b>${M.fmtPct(ctx.shareOfGroundwaterAvg)}</b> of all fresh groundwater pumped in the county on an average day (USGS ${meta.usgsYear}). Effects on nearby wells depend on the aquifer and where the wells sit.</div></div>`);
  if (ctx.shareOfPublicSupplyPeak != null && ctx.shareOfPublicSupplyPeak >= 1 && input.source !== 'reclaimed' && input.cooling !== 'dry') notes.push(`<div class="callout crit">${icon('alert')}<div>On a peak day this is more than all the county's public water systems deliver today (${M.fmtPct(ctx.shareOfPublicSupplyPeak)}). It would need new sources or water from a neighboring utility. Ask where it will come from and who pays for the pipes and plants.</div></div>`);
  else if (ctx.shareOfPublicSupplyPeak != null && ctx.shareOfPublicSupplyPeak >= 0.1 && input.source !== 'reclaimed' && input.cooling !== 'dry') notes.push(`<div class="callout crit">${icon('alert')}<div>On a peak day this is ${M.fmtPct(ctx.shareOfPublicSupplyPeak)} of everything the county's public systems supply. A demand that size usually needs new supply, treatment or pipeline capacity. Ask who pays for it.</div></div>`);
  if (!county.ps) notes.push(`<div class="callout info">${icon('info')}<div>USGS doesn't report a public-supply total for this county, so only the household comparison is shown.</div></div>`);
  return `<section class="card">
    <h2>Next to ${esc(county.n)}'s water</h2>
    <p class="sub">Central estimate${r.selected ? '' : ' assuming evaporative cooling, the highest-water case'}, compared with the water public systems deliver to the county's residents and businesses. The site may be served by a smaller local system or a larger regional one.</p>
    <div class="tiles two">${tiles.join('')}</div>
    ${notes.join('')}
  </section>`;
}

function chartCard(input, county, r) {
  const rows = ['evaporative', 'hybrid', 'dry'].map((k) => ({ k, label: M.COOLING[k].short, on: r.byCooling[k].central.annualGal / 1e6, off: r.byCooling[k].central.indirectAnnualGal / 1e6, onLo: r.byCooling[k].low.annualGal / 1e6, onHi: r.byCooling[k].high.annualGal / 1e6 }));
  const max = Math.max(...rows.map((x) => x.on + x.off));
  const W = 640, labelW = 104, valW = 92, barH = 22, gap = 26, top = 6;
  const plotW = W - labelW - valW;
  const H = top + rows.length * (barH + gap) - gap + 30;
  const x = (v) => (v / max) * plotW;
  const ticks = niceTicks(max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual water by cooling choice, million gallons">`;
  for (const t of ticks) {
    const tx = labelW + x(t);
    svg += `<line class="gridline" x1="${tx}" x2="${tx}" y1="${top - 4}" y2="${H - 22}"/><text class="lbl" x="${tx}" y="${H - 6}" text-anchor="middle">${M.fmtNum(t, 3)}</text>`;
  }
  rows.forEach((row, i) => {
    const y = top + i * (barH + gap);
    const w1 = x(row.on), w2 = x(row.off);
    const selected = r.selected && input.cooling === row.k;
    svg += `<text class="cat" x="0" y="${y + barH / 2 + 4}">${esc(row.label)}</text>`;
    svg += barPath(labelW, y, Math.max(w1, 0.5), barH, w2 < 2, 's1', `On-site water: ${M.fmtNum(row.on)} million gal/yr (range ${M.fmtNum(row.onLo)}–${M.fmtNum(row.onHi)})`);
    if (w2 >= 1) svg += barPath(labelW + w1 + 2, y, Math.max(w2 - 2, 0.5), barH, true, 's2', `At power plants: ${M.fmtNum(row.off)} million gal/yr (water consumed generating this site's electricity, usually outside the county)`);
    svg += `<text class="val" x="${labelW + w1 + w2 + 8}" y="${y + barH / 2 + 4}">${M.fmtNum(row.on + row.off)}${selected ? ' ◂ selected' : ''}</text>`;
  });
  svg += `</svg>`;
  const table = `<table class="data"><thead><tr><th>Cooling</th><th>On-site, M gal/yr</th><th>Range</th><th>Power plants, M gal/yr</th><th>Peak day, gal</th></tr></thead><tbody>${['evaporative', 'hybrid', 'dry'].map((k) => { const b = r.byCooling[k]; return `<tr><td>${esc(M.COOLING[k].short)}</td><td>${M.fmtNum(b.central.annualGal / 1e6)}</td><td>${M.fmtNum(b.low.annualGal / 1e6)}–${M.fmtNum(b.high.annualGal / 1e6)}</td><td>${M.fmtNum(b.central.indirectAnnualGal / 1e6)}</td><td>${M.fmtNum(b.central.peakDailyGal)}</td></tr>`; }).join('')}</tbody></table>`;
  return `<section class="card">
    <h2>Water by cooling choice</h2>
    <p class="sub">Million gallons per year in this climate${input.basis === 'facility' ? `, all at the same ${M.fmtNum(input.mw, 3)} MW of total power. Lower-water designs spend more of that power on cooling, so less is left for computing` : `, all for the same ${M.fmtNum(input.mw, 3)} MW of computing. Lower-water designs need more electricity, and power plants use water too`}.</p>
    <div class="chart" id="chart">${svg}</div>
    <div class="legend"><span><i style="background:var(--series-1)"></i>On-site (from local supply)</span><span><i style="background:var(--series-2)"></i>At power plants (often elsewhere)</span></div>
    <details class="table-toggle"><summary>Show as table</summary>${table}</details>
  </section>`;
}

function barPath(x, y, w, h, roundEnd, cls, tip) {
  const r = roundEnd ? Math.min(4, w / 2, h / 2) : 0;
  const d = `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
  return `<path class="${cls}" d="${d}" data-tip="${esc(tip)}"/><rect x="${x}" y="${y - 6}" width="${Math.max(w, 12)}" height="${h + 12}" fill="transparent" data-tip="${esc(tip)}"/>`;
}

function niceTicks(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || p * 10;
  const out = [];
  for (let v = 0; v <= max * 1.001; v += step) out.push(v);
  return out;
}

function claimCard(input, county) {
  const res = state.claimValue ? M.checkClaim(input, county, { value: state.claimValue, kind: state.claimKind }) : null;
  let verdict = '';
  if (res) {
    const pct = res.impliedFraction;
    const what = { dry: 'closed-loop or air cooling, with little or no evaporation', hybrid: 'hybrid or adiabatic cooling, or evaporative cooling for only part of the heat', evaporative: 'mostly evaporative cooling', over: 'more than evaporative cooling of the entire facility could use' }[res.matches];
    const cls = res.matches === 'over' || res.mismatch ? 'warn' : 'info';
    let extra = '';
    if (res.matches === 'over') extra = `Check the megawatt figure (is it one phase or the full campus?), whether the number includes other uses such as on-site power generation, landscaping or construction, and whether it is a contract cap rather than expected use.`;
    else if (res.mismatch === 'more-than-stated') extra = `That's more water than ${M.COOLING[res.cooling].short.toLowerCase()} cooling should need at this size. Ask whether there is evaporative “trim” cooling on hot days, an initial fill, or other water uses.`;
    else if (res.mismatch === 'less-than-stated') extra = `That's less than ${M.COOLING[res.cooling].short.toLowerCase()} cooling would normally need at this size. Ask how it was calculated: annual average or peak day, first phase or full build-out, staff use only, or very high cycles of concentration.`;
    else if (res.matches === 'dry') extra = `Closed-loop systems still need an initial fill (often millions of gallons) and some make-up water. Their extra electricity also means more water used at power plants.`;
    else if (res.matches === 'evaporative') extra = `This is physically plausible for evaporative cooling at this size.`;
    else extra = `This is plausible if water is only used on the hottest days or for part of the cooling load.`;
    const top = res.isPeak ? 1.5 : 1.3;
    // square-root scale so the narrow closed-loop band is still visible
    const pos = (v) => Math.sqrt(Math.max(0, Math.min(v, top)) / top) * 100;
    const b = res.bands;
    const zones = [
      ['dry', 0, b.dry, 'closed-loop'],
      ['hybrid', b.dry, b.hybrid, 'hybrid'],
      ['evaporative', b.hybrid, b.evaporative, 'evaporative'],
      ['over', b.evaporative, top, 'too high'],
    ];
    const zoneHtml = zones.map(([k, a, z, label]) => `<div class="meter-zone z-${k}${res.matches === k ? ' on' : ''}" style="left:${pos(a)}%;width:${pos(z) - pos(a)}%" title="${label}"></div>`).join('');
    const labels = zones.map(([k, a, z, label]) => `<span style="left:${(pos(a) + pos(z)) / 2}%"${res.matches === k ? ' class="on"' : ''}>${label}</span>`).join('');
    verdict = `<div class="verdict callout ${cls}">${icon(cls === 'warn' ? 'alert' : 'info')}<div style="flex:1;min-width:0">
      <h3>Implies about ${M.fmtPct(pct)} of the heat removed by evaporation</h3>
      <p>That's consistent with <b>${what}</b>. ${extra}</p>
      <div class="meter" aria-hidden="true"><div class="meter-track">${zoneHtml}<div class="meter-mark" style="left:${pos(pct)}%"></div></div>
      <div class="meter-labels">${labels}</div></div>
    </div></div>`;
  }
  const kinds = [['peak', 'gallons per day (peak / max day)'], ['avg', 'gallons per day (average)'], ['annualMg', 'million gallons per year'], ['annualAf', 'acre-feet per year']];
  const ex = EXAMPLES.find((x) => x.fips === state.fips && x.claim && Number(x.claim.value) === Number(state.claimValue) && x.claim.kind === state.claimKind);
  const exNote = ex ? `<p class="src" style="margin-top:8px">Reported figure for ${esc(ex.title)}: ${esc(ex.claimText)}. Source: <a href="${esc(ex.url)}" rel="noopener" target="_blank">${esc(ex.who)}, ${esc(ex.date)}</a>.</p>` : '';
  return `<section class="card claim">
    <h2>Check a water claim</h2>
    <p class="sub">Enter a figure from the developer, utility or news coverage. Basin compares it with what cooling ${M.fmtNum(input.mw, 3)} MW physically requires.</p>
    ${exNote}
    <div class="row">
      <input class="input" id="claimValue" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 600000" value="${esc(state.claimValue)}" aria-label="Claimed water amount">
      <select class="select" id="claimKind" aria-label="Unit">${kinds.map(([k, l]) => `<option value="${k}"${state.claimKind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
    ${verdict}
  </section>`;
}

function leversCard(input, county, r) {
  const L = M.levers(input, county, r);
  if (!L.length) return '';
  const items = L.map((l) => {
    if (l.id === 'cycles') return `<li><div class="lv-txt">Raise cycles of concentration from ${l.from} to ${l.to}<small>Better water treatment means each gallon is reused more before blowdown.</small></div><div class="lv-num">−${M.fmtPct(l.saveFraction)} · ${g(l.saveGalYear)}/yr</div></li>`;
    if (l.id === 'reclaimed') return `<li><div class="lv-txt">Use reclaimed wastewater instead of drinking water<small>Takes the demand off the potable supply entirely, if a treatment plant is close enough.</small></div><div class="lv-num">−${g(l.saveGalYear)}/yr potable</div></li>`;
    if (l.id === 'hybrid') return `<li><div class="lv-txt">Switch to hybrid / adiabatic cooling<small>Needs about ${M.fmtNum(l.extraMwhYear)} MWh/yr more electricity for the same computing.</small></div><div class="lv-num">−${M.fmtPct(l.saveFraction)} · ${g(l.saveGalYear)}/yr</div></li>`;
    if (l.id === 'dry') return `<li><div class="lv-txt">Closed-loop / air-cooled<small>Needs about ${M.fmtNum(Math.max(0, l.extraMwhYear))} MWh/yr more electricity for the same computing (${g(Math.max(0, l.extraIndirectGal))}/yr more water at power plants)${input.basis === 'facility' ? `, or about ${M.fmtPct(Math.abs(l.itChange))} less computing within the same ${M.fmtNum(input.mw, 3)} MW` : ''}.</small></div><div class="lv-num">−${M.fmtPct(l.saveFraction)} on-site</div></li>`;
    return '';
  }).join('');
  const assume = input.cooling && input.cooling !== 'unknown' ? '' : ' Assumes evaporative cooling, since none was given.';
  return `<section class="card"><h2>Ways to cut it</h2><p class="sub">What each design choice would change for this project. All of them have costs.${assume}</p><ul class="levers">${items}</ul></section>`;
}

function questionsCard(input, county) {
  const qs = M.questions(input, county);
  return `<section class="card"><h2>Questions to ask</h2><p class="sub">For a hearing, a records request or a story. Tailored to what's still unknown.</p><ul class="qs">${qs.map((q) => `<li>${esc(q)}</li>`).join('')}</ul><div class="actions"><button class="btn" type="button" id="copyQs">${icon('copy')}Copy questions</button></div></section>`;
}

function shareCard() {
  return `<section class="card share-card"><h2>Share this estimate</h2><p class="sub">The link reproduces every input. The image works on social posts and slides.</p>
    <div class="actions">
      <button class="btn primary" type="button" id="copyLink">${icon('link')}Copy link</button>
      <button class="btn" type="button" id="dlImg">${icon('image')}Download image</button>
      <button class="btn" type="button" id="copyText">${icon('copy')}Copy summary</button>
      <button class="btn" type="button" id="printBtn">${icon('print')}Print</button>
      <button class="btn" type="button" id="embedBtn">${icon('code')}Embed</button>
    </div>
    <p class="src">Estimates come from engineering relationships and published ranges, not from the facility's design. <a href="methodology.html">How it works</a>.</p>
  </section>`;
}

function embedAttrib() {
  if (!document.documentElement.classList.contains('embed')) return '';
  const full = location.href.replace(/[?&]embed(=[^&#]*)?/, '').replace(/\?(#|$)/, '$1');
  return `<div class="embed-attrib"><span>Estimate by Basin, an open-source data center water calculator.</span><a href="${esc(full)}" target="_blank" rel="noopener">Open the full calculator ↗</a></div>`;
}

function icon(name) {
  const p = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',
    print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  }[name];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

function wireResults() {
  const cv = $('#claimValue');
  if (cv) {
    cv.addEventListener('input', () => { state.claimValue = cv.value ? Number(cv.value) : ''; debounceUpdate(); });
    $('#claimKind').addEventListener('change', (e) => { state.claimKind = e.target.value; update(); });
  }
  $('#copyQs')?.addEventListener('click', () => copy(M.questions(lastResult.input, lastResult.county).map((q, i) => `${i + 1}. ${q}`).join('\n'), 'Questions copied'));
  $('#copyLink')?.addEventListener('click', () => copy(location.href, 'Link copied'));
  $('#copyText')?.addEventListener('click', () => copy(summaryText(), 'Summary copied'));
  $('#printBtn')?.addEventListener('click', () => window.print());
  $('#embedBtn')?.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('embed', '1');
    copy(`<iframe src="${u.toString()}" title="Data center water estimate (Basin)" width="100%" height="1400" style="border:0;max-width:820px" loading="lazy"></iframe>`, 'Embed code copied');
  });
  $('#dlImg')?.addEventListener('click', downloadImage);
  const chart = $('#chart');
  if (chart) {
    let tip = null;
    chart.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip?.remove(); tip = null; return; }
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      tip.textContent = t.dataset.tip;
      const x = Math.min(e.clientX + 14, window.innerWidth - 280);
      tip.style.left = x + 'px';
      tip.style.top = e.clientY + 14 + 'px';
    });
    chart.addEventListener('mouseleave', () => { tip?.remove(); tip = null; });
  }
}

let debounceT = null;
function debounceUpdate() { clearTimeout(debounceT); debounceT = setTimeout(update, 250); }

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg); } catch (e2) { toast('Copy failed'); }
    ta.remove();
  }
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

function summaryText() {
  const { input, county, r } = lastResult;
  const where = `${county.n}, ${county.s}`;
  const size = `${M.fmtNum(input.mw, 3)} MW (${input.basis === 'it' ? 'IT load' : 'total power'})`;
  const lines = [`Data center water estimate: ${size} in ${where}`];
  if (r.selected) {
    const c = r.selected.central;
    lines.push(`${M.COOLING[input.cooling].label}: about ${g(c.peakDailyGal)} on a peak day (range ${g(r.selected.low.peakDailyGal)}–${g(r.selected.high.peakDailyGal)}), ${g(c.annualGal)} per year.`);
  } else {
    const b = r.byCooling;
    lines.push(`Cooling not disclosed. Peak day: evaporative about ${g(b.evaporative.central.peakDailyGal)}, hybrid about ${g(b.hybrid.central.peakDailyGal)}, closed-loop about ${g(b.dry.central.peakDailyGal)}.`);
  }
  if (r.context.shareOfPublicSupplyAvg != null) lines.push(`That's about ${M.fmtPct(r.context.shareOfPublicSupplyAvg)} of the county's public water supply on an average day${r.selected ? '' : ' (if evaporative)'}.`);
  lines.push(`Estimate by Basin (open source): ${location.href}`);
  return lines.join('\n');
}

function downloadImage() {
  const { input, county, r } = lastResult;
  const css = getComputedStyle(document.documentElement);
  const W = 1200, H = 675;
  const cv = document.createElement('canvas');
  cv.width = W * 2; cv.height = H * 2;
  const ctx = cv.getContext('2d');
  ctx.scale(2, 2);
  const font = css.getPropertyValue('--font');
  const bg = '#0f1a24', ink = '#ffffff', muted = '#a9b6c3', accent = '#5ea2ef';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 8);
  ctx.fillStyle = muted; ctx.font = `600 22px ${font}`;
  ctx.fillText('DATA CENTER WATER ESTIMATE', 64, 84);
  ctx.fillStyle = ink; ctx.font = `700 40px ${font}`;
  ctx.fillText(`${M.fmtNum(input.mw, 3)} MW in ${county.n}, ${county.s}`, 64, 140);
  let big, sub;
  if (r.selected) {
    const c = r.selected.central;
    big = `${gs(c.peakDailyGal)} gal`;
    sub = `on a peak summer day with ${M.COOLING[input.cooling].short.toLowerCase()} cooling · ${g(c.annualGal)} per year`;
  } else {
    big = `${gs(r.byCooling.dry.central.peakDailyGal)} – ${gs(r.byCooling.evaporative.central.peakDailyGal)} gal`;
    sub = 'on a peak summer day, depending on the cooling system (not disclosed)';
  }
  ctx.fillStyle = ink; ctx.font = `800 92px ${font}`;
  fitText(ctx, big, 64, 270, W - 128, 92, font, 800);
  ctx.fillStyle = muted; ctx.font = `500 26px ${font}`;
  fitText(ctx, sub, 64, 318, W - 128, 26, font, 500);
  const ctxr = r.context;
  const facts = [];
  facts.push(`≈ ${M.fmtNum(ctxr.householdsAvg)} homes' daily water use${r.selected ? '' : ' (if evaporative)'}`);
  if (ctxr.shareOfPublicSupplyAvg != null) facts.push(`≈ ${M.fmtPct(ctxr.shareOfPublicSupplyAvg)} of the county's public water supply`);
  const dr = county.dr ? `${Math.round(county.dr[1])}% of county in drought (D1+)` : null;
  if (dr) facts.push(dr);
  ctx.font = `600 30px ${font}`;
  facts.slice(0, 3).forEach((f, i) => {
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(76, 412 + i * 58 - 10, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink; fitText(ctx, f, 98, 412 + i * 58, W - 160, 30, font, 600);
  });
  ctx.fillStyle = muted; ctx.font = `500 22px ${font}`;
  ctx.fillText('Basin · open-source data center water calculator · aquamesh.github.io/basin', 64, H - 48);
  const a = document.createElement('a');
  a.download = `basin-${county.n.replace(/\W+/g, '-').toLowerCase()}-${county.s.toLowerCase()}-${Math.round(input.mw)}mw.png`;
  a.href = cv.toDataURL('image/png');
  a.click();
}

function fitText(ctx, text, x, y, maxW, size, font, weight) {
  let s = size;
  ctx.font = `${weight} ${s}px ${font}`;
  while (ctx.measureText(text).width > maxW && s > 12) { s -= 2; ctx.font = `${weight} ${s}px ${font}`; }
  ctx.fillText(text, x, y);
}

// ---------------- boot ----------------
(async function boot() {
  readHash();
  wireForm();
  try {
    await loadCounties();
  } catch (e) {
    $('#results').innerHTML = `<div class="card callout crit">Couldn't load county data. Please reload the page.</div>`;
    return;
  }
  syncForm();
  update();
  // A pasted link in the same tab only changes the hash, so re-read it.
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    Object.assign(state, DEFAULTS);
    $('#place').value = '';
    readHash();
    syncForm();
    update();
  });
})();

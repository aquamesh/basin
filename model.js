// Basin water model. Pure functions, no DOM, so it runs the same in the
// browser and under `node --test`. Every constant is listed in
// methodology.html with its source.

export const L_PER_GAL = 3.785411784;
export const GAL_PER_ACRE_FOOT = 325851;
export const HOURS_PER_YEAR = 8760;

// Water evaporated per kWh of heat removed purely by evaporation.
// Latent heat of vaporization of water at ~30 °C is ~2,430 kJ/kg, and
// 1 kWh = 3,600 kJ, so 3,600 / 2,430 ≈ 1.48 kg ≈ 1.48 L.
export const L_EVAP_PER_KWH_HEAT = 3600 / 2430;

// Climate classes, built from IECC/ASHRAE 169 county climate zones.
export const CLIMATES = {
  'hot-dry':   { label: 'Hot and dry',      zones: ['2B', '3B', '4B'] },
  'hot-humid': { label: 'Hot and humid',    zones: ['0A', '1A', '2A', '3A'] },
  'temperate': { label: 'Mild / marine',    zones: ['3C', '4A', '4C', '5C'] },
  'cold-dry':  { label: 'Cold and dry',     zones: ['5B', '6B'] },
  'cold':      { label: 'Cold',             zones: ['5A', '6A', '7', '8'] },
};

export function climateClass(zone) {
  if (!zone) return 'temperate';
  const z = String(zone).toUpperCase().trim();
  for (const [k, v] of Object.entries(CLIMATES)) if (v.zones.includes(z)) return k;
  if (z.startsWith('7') || z.startsWith('8')) return 'cold';
  return 'temperate';
}

export const COOLING = {
  evaporative: { label: 'Evaporative / cooling towers', short: 'Evaporative' },
  hybrid:      { label: 'Hybrid / adiabatic',           short: 'Hybrid' },
  dry:         { label: 'Closed-loop / air-cooled',     short: 'Closed-loop' },
};

// [low, central, high] parameters. Sources and reasoning: methodology.html.
export const PARAMS = {
  // Power usage effectiveness by cooling design (facility energy / IT energy).
  // Large new campuses: Google 1.09, Meta 1.08, AWS 1.14-1.15, Microsoft
  // 1.16-1.17; LBNL AI facilities 1.14; Uptime survey >=20 MW sites 1.44.
  pue: {
    evaporative: [1.08, 1.15, 1.30],
    hybrid:      [1.10, 1.20, 1.35],
    dry:         [1.12, 1.28, 1.45],
  },
  // Share of the year's heat that leaves the site as evaporated water.
  // Calibrated so the resulting WUE matches LBNL 2024 (towers 1.7-2.8 L/kWh,
  // adiabatic 0-0.58), Google's tower fleet (~1.3 L/kWh withdrawn) and
  // Microsoft's WUE by state (AZ 1.63, WA 0.95, TX 0.25, VA/IA 0.14).
  annualEvapFraction: {
    evaporative: { 'hot-dry': [0.70, 0.85, 0.95], 'hot-humid': [0.65, 0.80, 0.92], 'temperate': [0.45, 0.65, 0.82], 'cold-dry': [0.40, 0.60, 0.78], 'cold': [0.30, 0.50, 0.70] },
    hybrid:      { 'hot-dry': [0.10, 0.25, 0.55], 'hot-humid': [0.04, 0.10, 0.25], 'temperate': [0.02, 0.06, 0.25], 'cold-dry': [0.03, 0.10, 0.40], 'cold': [0.01, 0.05, 0.15] },
    dry:         { 'hot-dry': [0.001, 0.005, 0.03], 'hot-humid': [0.001, 0.005, 0.03], 'temperate': [0.0005, 0.003, 0.02], 'cold-dry': [0.0005, 0.003, 0.02], 'cold': [0.0005, 0.002, 0.015] },
  },
  // Peak-day ÷ average-day water, from utility meter data (Han, Li, Wierman
  // & Ren 2026): towers ≥2.2 (Phoenix, The Dalles); adiabatic 3-10 (Northern
  // Virginia 3.5-10, Iowa ≥6.45, Leesburg ~8).
  peakRatio: {
    evaporative: { 'hot-dry': [1.5, 2.0, 2.5], 'hot-humid': [1.5, 1.9, 2.4], 'temperate': [1.7, 2.2, 2.9], 'cold-dry': [1.8, 2.4, 3.2], 'cold': [2.0, 2.6, 3.5] },
    hybrid:      { 'hot-dry': [2.5, 3.5, 5.0], 'hot-humid': [3.0, 4.5, 7.0], 'temperate': [3.5, 6.0, 10], 'cold-dry': [3.0, 5.0, 8.0], 'cold': [4.0, 7.0, 12] },
    dry:         { 'hot-dry': [1, 1.5, 3], 'hot-humid': [1, 1.5, 3], 'temperate': [1, 1.5, 3], 'cold-dry': [1, 1.5, 3], 'cold': [1, 1.5, 3] },
  },
  // Physical ceiling on a day's evaporation, as a multiple of the facility's
  // heat at 100% evaporation. Hot, dry air can push it a little above 1
  // because the air also gives up heat to the water.
  peakLatentCap: 1.25,
  // Water consumed at power plants per kWh. Central value is the county's
  // state: EIA 2024 thermoelectric cooling-water consumption ÷ all state
  // generation (U.S. 0.82 L/kWh). The range multiplies it by these factors.
  // Hydropower reservoir evaporation is excluded; including it (LBNL 2024)
  // gives ~4.4 L/kWh for the U.S.
  indirectSpread: [0.75, 1, 1.5],
  indirectUs: 0.82,
  // Average U.S. household water use at home (EPA WaterSense).
  householdGalPerDay: 300,
  // Cycles of concentration when not specified (EPA/FEMP: "two to four" is common).
  defaultCycles: 4,
  // Average load as a share of announced capacity (LBNL assumes 50% of grid
  // interconnection; California Energy Commission 67%).
  defaultUtil: 0.65,
};

const pick = (arr, i) => arr[i];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Makeup water multiplier: makeup = evaporation × C / (C − 1). */
export function blowdownMultiplier(cycles) {
  const c = clamp(Number(cycles) || PARAMS.defaultCycles, 1.5, 50);
  return c / (c - 1);
}

/**
 * Core estimate for one cooling type.
 * @param {object} p
 * @param {number} p.mw          MW figure as announced
 * @param {'facility'|'it'} p.basis
 * @param {'evaporative'|'hybrid'|'dry'} p.cooling
 * @param {string} p.climate     key of CLIMATES
 * @param {number} [p.util]      average IT load as a share of capacity (0–1)
 * @param {number} [p.cycles]
 * @param {number} [p.pue]       override
 * @param {number} [p.indirect]  override, L/kWh
 */
export function estimateCooling(p) {
  const cooling = p.cooling;
  const climate = CLIMATES[p.climate] ? p.climate : 'temperate';
  const util = clamp(p.util ?? PARAMS.defaultUtil, 0.05, 1);
  const mult = cooling === 'dry' ? 1 : blowdownMultiplier(p.cycles);
  // IT capacity is held fixed across the low/central/high cases (and, in
  // estimate(), across cooling types) so only the design assumptions vary.
  const itMw = p.itMw ?? itMwFor(p.mw, p.basis, cooling, p.pue);
  const out = {};
  for (const [i, k] of [[0, 'low'], [1, 'central'], [2, 'high']]) {
    // Higher PUE means more heat to reject and more water, so the "high"
    // water case pairs with the high PUE.
    const pue = p.pue ? p.pue : pick(PARAMS.pue[cooling], i);
    const facilityMw = itMw * pue;
    const itKwhYear = itMw * 1000 * HOURS_PER_YEAR * util;
    const facilityKwhYear = itKwhYear * pue;
    const heatKwhYear = facilityKwhYear; // all electricity ends up as heat
    const fAnnual = pick(PARAMS.annualEvapFraction[cooling][climate], i);
    const evapL = heatKwhYear * fAnnual * L_EVAP_PER_KWH_HEAT;
    const drawnL = evapL * mult;
    const avgDrawnL = drawnL / 365;
    const heatKwhDay = facilityMw * 1000 * 24 * util;
    const capFrac = cooling === 'dry' ? 0.05 : PARAMS.peakLatentCap;
    const peakCapL = heatKwhDay * capFrac * L_EVAP_PER_KWH_HEAT * mult;
    const peakDrawnL = Math.min(avgDrawnL * pick(PARAMS.peakRatio[cooling][climate], i), peakCapL);
    const wi = p.indirect ?? (p.wi > 0 ? p.wi : PARAMS.indirectUs) * pick(PARAMS.indirectSpread, i);
    const indirectL = facilityKwhYear * wi;
    out[k] = {
      pue, itMw, facilityMw, itKwhYear, facilityKwhYear,
      annualGal: drawnL / L_PER_GAL,
      annualConsumedGal: evapL / L_PER_GAL,
      avgDailyGal: avgDrawnL / L_PER_GAL,
      // the peak day can never be below the average day
      peakDailyGal: Math.max(peakDrawnL, avgDrawnL) / L_PER_GAL,
      indirectAnnualGal: indirectL / L_PER_GAL,
      wue: drawnL / itKwhYear, // L per kWh of IT energy (The Green Grid WUE)
    };
  }
  return out;
}

/** IT capacity implied by an announced MW figure. */
export function itMwFor(mw, basis, cooling, pueOverride) {
  if (basis === 'it') return mw;
  const pue = pueOverride || PARAMS.pue[cooling || 'hybrid'][1];
  return mw / pue;
}

/**
 * Estimate for all three cooling types plus the selected one. A total-power
 * figure stays fixed across designs ("a 300 MW campus" is 300 MW whatever it
 * uses), so lower-water designs leave less of it for computing. An IT-load
 * figure stays fixed instead, so lower-water designs draw more power.
 */
export function estimate(input, county) {
  const climate = county ? climateClass(county.z) : 'temperate';
  const base = { mw: input.mw, basis: input.basis, climate, util: input.util, cycles: input.cycles, pue: input.pue || undefined, wi: county?.wi };
  const byCooling = {};
  for (const c of Object.keys(COOLING)) byCooling[c] = estimateCooling({ ...base, cooling: c });
  const selected = input.cooling && input.cooling !== 'unknown' ? byCooling[input.cooling] : null;
  // Range when cooling is unknown: closed-loop low to evaporative high.
  const span = {
    peakLow: byCooling.dry.low.peakDailyGal,
    peakHigh: byCooling.evaporative.high.peakDailyGal,
    annualLow: byCooling.dry.low.annualGal,
    annualHigh: byCooling.evaporative.high.annualGal,
  };
  return { climate, byCooling, selected, span, context: county ? context(input, county, selected || byCooling.evaporative) : null };
}

/** Local context for one estimate (uses the central case, with the range). */
export function context(input, county, est) {
  const hh = PARAMS.householdGalPerDay;
  const c = est.central;
  const res = {
    householdsAvg: c.avgDailyGal / hh,
    householdsPeak: c.peakDailyGal / hh,
    acreFeetYear: c.annualGal / GAL_PER_ACRE_FOOT,
  };
  if (county.ps > 0) {
    const psGal = county.ps * 1e6;
    res.shareOfPublicSupplyAvg = c.avgDailyGal / psGal;
    res.shareOfPublicSupplyPeak = c.peakDailyGal / psGal;
    res.shareOfPublicSupplyRange = [est.low.avgDailyGal / psGal, est.high.avgDailyGal / psGal];
  }
  if (county.gw > 0) res.shareOfGroundwaterAvg = c.avgDailyGal / (county.gw * 1e6);
  if (county.psPop > 0 && county.ps > 0) {
    // Gallons per person per day served by the public supply (all uses).
    res.psGalPerPerson = (county.ps * 1e6) / county.psPop;
    res.peopleEquivalentAvg = c.avgDailyGal / res.psGalPerPerson;
  }
  return res;
}

/**
 * Check a stated water figure against the physics for this size.
 * Returns the implied share of heat removed by evaporation and a verdict.
 * @param {object} input same shape as estimate()
 * @param {{value:number, kind:'peak'|'avg'|'annualMg'|'annualAf'}} claim
 */
export function checkClaim(input, county, claim) {
  const value = Number(claim?.value);
  if (!(value > 0) || !(input.mw > 0)) return null;
  const climate = county ? climateClass(county.z) : 'temperate';
  const cooling = input.cooling && input.cooling !== 'unknown' ? input.cooling : null;
  const pue = input.pue || PARAMS.pue[cooling || 'evaporative'][1];
  const itMw = input.basis === 'it' ? input.mw : input.mw / pue;
  const facilityMw = itMw * pue;
  const mult = blowdownMultiplier(input.cycles);
  let impliedFraction;
  let galPerDay;
  if (claim.kind === 'peak') {
    // Developers usually quote the maximum day at full build-out: full load.
    galPerDay = value;
    const maxL = facilityMw * 1000 * 24 * L_EVAP_PER_KWH_HEAT * mult;
    impliedFraction = (value * L_PER_GAL) / maxL;
  } else {
    const util = clamp(input.util ?? PARAMS.defaultUtil, 0.05, 1);
    const annualGal = claim.kind === 'avg' ? value * 365 : claim.kind === 'annualAf' ? value * GAL_PER_ACRE_FOOT : value * 1e6;
    galPerDay = annualGal / 365;
    const heatKwh = facilityMw * 1000 * HOURS_PER_YEAR * util;
    impliedFraction = (annualGal * L_PER_GAL) / (heatKwh * L_EVAP_PER_KWH_HEAT * mult);
  }
  const isPeak = claim.kind === 'peak';
  // Bands of implied evaporative share and the designs they match.
  // Peak day: share of full-load heat at 100% evaporation (a hot, dry day can
  // exceed 1 slightly, see peakLatentCap). Annual: the hybrid/evaporative
  // boundary sits between the hybrid high case and the evaporative low case
  // for this climate.
  const annualSplit = (PARAMS.annualEvapFraction.hybrid[climate][2] + PARAMS.annualEvapFraction.evaporative[climate][0]) / 2;
  const bands = isPeak
    ? [[0.05, 'dry'], [0.6, 'hybrid'], [PARAMS.peakLatentCap + 0.05, 'evaporative'], [Infinity, 'over']]
    : [[0.03, 'dry'], [annualSplit, 'hybrid'], [1.15, 'evaporative'], [Infinity, 'over']];
  const matches = bands.find(([hi]) => impliedFraction < hi)[1];
  const edges = { dry: bands[0][0], hybrid: bands[1][0], evaporative: bands[2][0] };
  let mismatch = null;
  if (cooling && matches !== 'over' && matches !== cooling) {
    const order = { dry: 0, hybrid: 1, evaporative: 2 };
    mismatch = order[matches] > order[cooling] ? 'more-than-stated' : 'less-than-stated';
  }
  return { impliedFraction, matches, mismatch, cooling, galPerDay, isPeak, facilityMw, bands: edges };
}

/** Levers that cut water, computed for this project. */
export function levers(input, county, result) {
  const out = [];
  const cooling = input.cooling && input.cooling !== 'unknown' ? input.cooling : 'evaporative';
  const cur = result.byCooling[cooling].central;
  const wi = (county?.wi > 0 ? county.wi : PARAMS.indirectUs);
  // Electricity a design change needs for the same computing (IT) load, and
  // the computing given up if total power is fixed instead.
  const swap = (to) => {
    const alt = result.byCooling[to].central;
    const altPue = alt.pue;
    const extraKwh = cur.itKwhYear * (altPue - cur.pue);
    return {
      saveFraction: 1 - alt.annualGal / cur.annualGal * (alt.itKwhYear ? cur.itKwhYear / alt.itKwhYear : 1),
      saveGalYear: cur.annualGal - alt.annualGal * (cur.itKwhYear / alt.itKwhYear),
      extraMwhYear: extraKwh / 1000,
      extraIndirectGal: extraKwh * wi / L_PER_GAL,
      itChange: cur.pue / altPue - 1,
    };
  };
  const c0 = Number(input.cycles) || PARAMS.defaultCycles;
  if (cooling !== 'dry') {
    const c1 = Math.min(c0 + 2, 12);
    const save = 1 - blowdownMultiplier(c1) / blowdownMultiplier(c0);
    if (save > 0.005) out.push({ id: 'cycles', from: c0, to: c1, saveFraction: save, saveGalYear: cur.annualGal * save });
  }
  if (input.source !== 'reclaimed' && cooling !== 'dry') {
    out.push({ id: 'reclaimed', saveFraction: 1, saveGalYear: cur.annualGal });
  }
  if (cooling === 'evaporative') out.push({ id: 'hybrid', ...swap('hybrid') });
  if (cooling !== 'dry') out.push({ id: 'dry', ...swap('dry') });
  return out;
}

/** Questions to ask, tailored to what is (not) known. */
export function questions(input, county) {
  const q = [];
  const cooling = input.cooling || 'unknown';
  const src = input.source || 'unknown';
  if (cooling === 'unknown') q.push('Which cooling system will the campus use, and on how many days a year will it evaporate water?');
  q.push('What is the maximum-day water demand at full build-out, not just the annual average? How many phases and total megawatts are planned?');
  if (src === 'unknown') q.push('Where will the water come from: the city system, private wells, a river, or reclaimed wastewater?');
  if (src === 'potable' || src === 'unknown') q.push('Has the utility confirmed in writing that it can supply the maximum day, including in a drought year, without new sources or rate increases for residents?');
  if (src === 'groundwater') q.push('Has a hydrogeologic study assessed the effect on nearby wells and aquifer levels? Who monitors it, and what happens if levels drop?');
  if (src === 'reclaimed') q.push('Which treatment plant supplies the reclaimed water, and would that water otherwise flow back to a river or be reused locally?');
  if (src === 'surface') q.push('Which water right or permit covers the withdrawal, and what are the curtailment rules in low-flow periods?');
  if (cooling !== 'dry') q.push('What cycles of concentration will the cooling system run, and where does the blowdown go? Is it covered by a sewer or discharge permit?');
  if (cooling === 'dry') q.push('Closed-loop cooling uses more electricity. What is the design PUE, and is there any evaporative “trim” cooling for the hottest days?');
  const drought = county?.dr ? (county.dr[1] || 0) : 0;
  const stressed = county?.ws >= 3;
  if (drought >= 25 || stressed) q.push('Will the site cut water use during droughts or utility emergencies, and is that written into the agreement?');
  q.push('Will the operator publish actual monthly water use once the campus is running?');
  q.push('Is any agreement with the city, county or utility covered by a non-disclosure agreement?');
  return q;
}

// ---------- formatting ----------
export function sig(x, digits = 2) {
  if (!isFinite(x) || x === 0) return 0;
  const p = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * p) / p;
}

export function fmtGal(g, { short = false } = {}) {
  if (!isFinite(g)) return '–';
  const a = Math.abs(g);
  if (a >= 1e9) return `${sig(g / 1e9, 2).toLocaleString('en-US')} billion${short ? '' : ' gal'}`;
  if (a >= 1e6) return `${sig(g / 1e6, 2).toLocaleString('en-US')} million${short ? '' : ' gal'}`;
  if (a >= 1000) return `${sig(g, 2).toLocaleString('en-US')}${short ? '' : ' gal'}`;
  if (a >= 1) return `${Math.round(g).toLocaleString('en-US')}${short ? '' : ' gal'}`;
  return short ? '0' : '0 gal';
}

export function fmtNum(x, digits = 2) {
  if (!isFinite(x)) return '–';
  if (Math.abs(x) >= 1000) return Math.round(sig(x, digits)).toLocaleString('en-US');
  return sig(x, digits).toLocaleString('en-US');
}

export function fmtPct(x) {
  if (!isFinite(x)) return '–';
  const p = x * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${sig(p, 2)}%`;
  if (p >= 0.1) return `${sig(p, 1)}%`;
  return p > 0 ? '<0.1%' : '0%';
}

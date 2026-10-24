import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../model.js';

const base = { mw: 100, basis: 'facility', util: 0.75, cycles: 4 };

test('climate zones map to classes', () => {
  assert.equal(M.climateClass('2B'), 'hot-dry');
  assert.equal(M.climateClass('3B'), 'hot-dry');
  assert.equal(M.climateClass('2A'), 'hot-humid');
  assert.equal(M.climateClass('4A'), 'temperate');
  assert.equal(M.climateClass('4C'), 'temperate');
  assert.equal(M.climateClass('5B'), 'cold-dry');
  assert.equal(M.climateClass('6A'), 'cold');
  assert.equal(M.climateClass('7'), 'cold');
  assert.equal(M.climateClass(''), 'temperate');
  assert.equal(M.climateClass(undefined), 'temperate');
});

test('blowdown multiplier follows C/(C-1)', () => {
  assert.equal(M.blowdownMultiplier(2), 2);
  assert.ok(Math.abs(M.blowdownMultiplier(4) - 4 / 3) < 1e-12);
  assert.ok(Math.abs(M.blowdownMultiplier(6) - 1.2) < 1e-12);
  // garbage falls back to the default
  assert.ok(Math.abs(M.blowdownMultiplier('x') - 4 / 3) < 1e-12);
});

test('evaporation constant is ~1.48 L per kWh of heat', () => {
  assert.ok(M.L_EVAP_PER_KWH_HEAT > 1.45 && M.L_EVAP_PER_KWH_HEAT < 1.51);
});

test('ranges are ordered low <= central <= high for every cooling and climate', () => {
  for (const cooling of Object.keys(M.COOLING)) {
    for (const climate of Object.keys(M.CLIMATES)) {
      const r = M.estimateCooling({ ...base, cooling, climate });
      for (const k of ['annualGal', 'peakDailyGal', 'avgDailyGal', 'indirectAnnualGal']) {
        assert.ok(r.low[k] <= r.central[k] + 1e-6, `${cooling}/${climate}/${k} low>central`);
        assert.ok(r.central[k] <= r.high[k] + 1e-6, `${cooling}/${climate}/${k} central>high`);
      }
      for (const k of ['low', 'central', 'high']) {
        assert.ok(r[k].peakDailyGal >= r[k].avgDailyGal - 1e-6, `${cooling}/${climate} peak < avg`);
        assert.ok(r[k].annualConsumedGal <= r[k].annualGal + 1e-6, 'consumed > drawn');
      }
    }
  }
});

test('evaporative > hybrid > closed-loop in every climate', () => {
  for (const climate of Object.keys(M.CLIMATES)) {
    const z = M.CLIMATES[climate].zones[0];
    const b = M.estimate({ ...base, basis: 'it', cooling: 'unknown' }, { f: '00000', n: 'Test', s: 'XX', z }).byCooling;
    const e = b.evaporative.central, h = b.hybrid.central, d = b.dry.central;
    assert.ok(Math.abs(e.itMw - d.itMw) < 1e-9, 'IT load held constant');
    assert.ok(e.annualGal > h.annualGal && h.annualGal > d.annualGal, climate);
    assert.ok(e.peakDailyGal > h.peakDailyGal && h.peakDailyGal > d.peakDailyGal, climate);
    // closed-loop uses more electricity, so more water at power plants
    assert.ok(d.indirectAnnualGal > e.indirectAnnualGal, climate);
  }
});

test('hot-dry evaporative uses more than cold evaporative', () => {
  const hot = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'hot-dry' }).central;
  const cold = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'cold' }).central;
  assert.ok(hot.annualGal > cold.annualGal * 1.3);
});

test('WUE lands inside published ranges', () => {
  // Evaporative towers: roughly 1-2.5 L/kWh. Hybrid/adiabatic: ~0.05-0.6.
  // Closed-loop: near zero. (Sources in methodology.html.)
  for (const climate of Object.keys(M.CLIMATES)) {
    const e = M.estimateCooling({ ...base, cooling: 'evaporative', climate }).central.wue;
    const h = M.estimateCooling({ ...base, cooling: 'hybrid', climate }).central.wue;
    const d = M.estimateCooling({ ...base, cooling: 'dry', climate }).central.wue;
    assert.ok(e >= 0.8 && e <= 2.6, `evap ${climate} ${e}`);
    assert.ok(h >= 0.03 && h <= 0.7, `hybrid ${climate} ${h}`);
    assert.ok(d >= 0 && d <= 0.05, `dry ${climate} ${d}`);
  }
});

test('peak day for evaporative 100 MW in a hot climate is ~1.2 million gallons at 4 cycles', () => {
  // 100 MW facility, 75% load: 1.8 GWh of heat a day. The hot-day ceiling is
  // 1.25 × 1.48 L/kWh evaporated = 3.33 ML, × 4/3 makeup = 4.44 ML ≈ 1.17 M gal.
  const r = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'hot-dry' }).central;
  assert.ok(r.peakDailyGal > 1.1e6 && r.peakDailyGal < 1.25e6, String(r.peakDailyGal));
  // and it is roughly 1.5x the average day, as utility data for Phoenix shows
  const ratio = r.peakDailyGal / r.avgDailyGal;
  assert.ok(ratio > 1.3 && ratio < 2.1, String(ratio));
});

test('peak ratio for hybrid cooling is much larger than for towers', () => {
  const e = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'temperate' }).central;
  const h = M.estimateCooling({ ...base, cooling: 'hybrid', climate: 'temperate' }).central;
  assert.ok(h.peakDailyGal / h.avgDailyGal > 3);
  assert.ok(e.peakDailyGal / e.avgDailyGal < 2.5);
});

test('off-site water uses the state intensity when given', () => {
  const lo = M.estimateCooling({ ...base, cooling: 'dry', climate: 'temperate', wi: 0.1 }).central;
  const hi = M.estimateCooling({ ...base, cooling: 'dry', climate: 'temperate', wi: 1.4 }).central;
  const us = M.estimateCooling({ ...base, cooling: 'dry', climate: 'temperate' }).central;
  assert.ok(Math.abs(hi.indirectAnnualGal / lo.indirectAnnualGal - 14) < 1e-9);
  assert.ok(Math.abs(us.indirectAnnualGal / lo.indirectAnnualGal - M.PARAMS.indirectUs / 0.1) < 1e-9);
});

test('a total-power figure stays fixed across cooling designs', () => {
  const b = M.estimate({ ...base, cooling: 'unknown' }, { f: '00000', n: 'Test', s: 'XX', z: '4A' }).byCooling;
  for (const k of Object.keys(M.COOLING)) assert.ok(Math.abs(b[k].central.facilityMw - 100) < 1e-9, k);
  assert.ok(b.dry.central.itMw < b.evaporative.central.itMw);
  // and the selected design matches its scenario exactly
  const sel = M.estimate({ ...base, cooling: 'evaporative' }, { f: '00000', n: 'Test', s: 'XX', z: '4A' });
  assert.equal(sel.selected.central.peakDailyGal, b.evaporative.central.peakDailyGal);
});

test('IT basis means more total power than facility basis', () => {
  const f = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'temperate' }).central;
  const it = M.estimateCooling({ ...base, basis: 'it', cooling: 'evaporative', climate: 'temperate' }).central;
  assert.ok(Math.abs(f.facilityMw - 100) < 1e-9);
  assert.ok(Math.abs(it.itMw - 100) < 1e-9);
  assert.ok(it.annualGal > f.annualGal);
});

test('water scales linearly with MW and utilization', () => {
  const a = M.estimateCooling({ ...base, cooling: 'evaporative', climate: 'temperate' }).central.annualGal;
  const b = M.estimateCooling({ ...base, mw: 200, cooling: 'evaporative', climate: 'temperate' }).central.annualGal;
  const c = M.estimateCooling({ ...base, util: 0.375, cooling: 'evaporative', climate: 'temperate' }).central.annualGal;
  assert.ok(Math.abs(b / a - 2) < 1e-9);
  assert.ok(Math.abs(c / a - 0.5) < 1e-9);
});

test('higher cycles mean less water drawn but the same evaporation', () => {
  const lo = M.estimateCooling({ ...base, cycles: 3, cooling: 'evaporative', climate: 'temperate' }).central;
  const hi = M.estimateCooling({ ...base, cycles: 8, cooling: 'evaporative', climate: 'temperate' }).central;
  assert.ok(hi.annualGal < lo.annualGal);
  assert.ok(Math.abs(hi.annualConsumedGal - lo.annualConsumedGal) < 1);
});

test('PUE override is respected', () => {
  const r = M.estimateCooling({ ...base, pue: 1.5, cooling: 'evaporative', climate: 'temperate' });
  assert.equal(r.low.pue, 1.5);
  assert.equal(r.high.pue, 1.5);
});

const county = { f: '04019', n: 'Pima County', s: 'AZ', z: '2B', ps: 150, psPop: 900000, gw: 250, dr: [80, 40, 10, 0, 0], ws: 4 };

test('estimate() returns all cooling types, context, and a span', () => {
  const r = M.estimate({ ...base, cooling: 'unknown', source: 'unknown' }, county);
  assert.equal(r.climate, 'hot-dry');
  assert.equal(r.selected, null);
  assert.ok(r.span.peakLow < r.span.peakHigh);
  assert.ok(r.context.householdsAvg > 0);
  assert.ok(r.context.shareOfPublicSupplyAvg > 0 && r.context.shareOfPublicSupplyAvg < 1);
  const s = M.estimate({ ...base, cooling: 'hybrid' }, county);
  assert.equal(s.selected, s.byCooling.hybrid);
});

test('context handles counties without USGS supply data', () => {
  const r = M.estimate({ ...base, cooling: 'evaporative' }, { ...county, ps: 0, gw: 0, psPop: 0 });
  assert.equal(r.context.shareOfPublicSupplyAvg, undefined);
  assert.equal(r.context.shareOfGroundwaterAvg, undefined);
  assert.ok(r.context.householdsAvg > 0);
});

test('claim checker classifies by implied evaporative share', () => {
  const inp = { ...base, cooling: 'unknown' };
  // 100 MW at full load: max evaporative makeup ≈ 2.4 GWh/day × 1.48 L × 4/3 ≈ 4.74 ML ≈ 1.25 M gal/day.
  assert.equal(M.checkClaim(inp, county, { value: 20000, kind: 'peak' }).matches, 'dry');
  assert.equal(M.checkClaim(inp, county, { value: 400000, kind: 'peak' }).matches, 'hybrid');
  assert.equal(M.checkClaim(inp, county, { value: 1000000, kind: 'peak' }).matches, 'evaporative');
  assert.equal(M.checkClaim(inp, county, { value: 3000000, kind: 'peak' }).matches, 'over');
  const full = M.checkClaim(inp, county, { value: 1.25e6, kind: 'peak' });
  assert.ok(full.impliedFraction > 0.95 && full.impliedFraction < 1.05, String(full.impliedFraction));
});

test('claim checker flags mismatches with the stated cooling', () => {
  const closed = M.checkClaim({ ...base, cooling: 'dry' }, county, { value: 900000, kind: 'peak' });
  assert.equal(closed.mismatch, 'more-than-stated');
  const evap = M.checkClaim({ ...base, cooling: 'evaporative' }, county, { value: 5000, kind: 'peak' });
  assert.equal(evap.mismatch, 'less-than-stated');
  const ok = M.checkClaim({ ...base, cooling: 'evaporative' }, county, { value: 1000000, kind: 'peak' });
  assert.equal(ok.mismatch, null);
});

test('claim checker annual units agree with each other', () => {
  const inp = { ...base, cooling: 'unknown' };
  const mg = M.checkClaim(inp, county, { value: 100, kind: 'annualMg' });
  const af = M.checkClaim(inp, county, { value: 100e6 / M.GAL_PER_ACRE_FOOT, kind: 'annualAf' });
  const avg = M.checkClaim(inp, county, { value: 100e6 / 365, kind: 'avg' });
  assert.ok(Math.abs(mg.impliedFraction - af.impliedFraction) < 1e-9);
  assert.ok(Math.abs(mg.impliedFraction - avg.impliedFraction) < 1e-9);
});

test('claim checker rejects empty or invalid input', () => {
  assert.equal(M.checkClaim({ ...base }, county, { value: '', kind: 'peak' }), null);
  assert.equal(M.checkClaim({ ...base }, county, { value: -5, kind: 'peak' }), null);
  assert.equal(M.checkClaim({ ...base, mw: 0 }, county, { value: 5, kind: 'peak' }), null);
});

test('levers: raising cycles 4 -> 6 saves 10%', () => {
  const inp = { ...base, cooling: 'evaporative', cycles: 4, source: 'potable' };
  const r = M.estimate(inp, county);
  const L = M.levers(inp, county, r);
  const cyc = L.find((l) => l.id === 'cycles');
  assert.ok(Math.abs(cyc.saveFraction - 0.1) < 1e-9);
  assert.ok(L.find((l) => l.id === 'reclaimed'));
  assert.ok(L.find((l) => l.id === 'hybrid').extraMwhYear > 0);
  assert.ok(L.find((l) => l.id === 'dry').extraIndirectGal > 0);
});

test('levers: closed-loop has no cycles or reclaimed lever', () => {
  const inp = { ...base, cooling: 'dry' };
  const L = M.levers(inp, county, M.estimate(inp, county));
  assert.equal(L.length, 0);
});

test('questions adapt to what is known', () => {
  const unknown = M.questions({ cooling: 'unknown', source: 'unknown' }, county);
  assert.ok(unknown.some((q) => q.startsWith('Which cooling system')));
  assert.ok(unknown.some((q) => q.includes('drought')));
  const known = M.questions({ cooling: 'dry', source: 'groundwater' }, { ...county, dr: [0, 0, 0, 0, 0], ws: 1 });
  assert.ok(!known.some((q) => q.startsWith('Which cooling system')));
  assert.ok(known.some((q) => q.includes('hydrogeologic')));
  assert.ok(known.some((q) => q.includes('PUE')));
  assert.ok(!known.some((q) => q.includes('drought')));
});

test('formatting', () => {
  assert.equal(M.fmtGal(1234567), '1.2 million gal');
  assert.equal(M.fmtGal(1234567, { short: true }), '1.2 million');
  assert.equal(M.fmtGal(48321), '48,000 gal');
  assert.equal(M.fmtGal(512), '512 gal');
  assert.equal(M.fmtGal(2.5e9), '2.5 billion gal');
  assert.equal(M.fmtPct(0.1234), '12%');
  assert.equal(M.fmtPct(0.0123), '1.2%');
  assert.equal(M.fmtPct(0.00123), '0.1%');
  assert.equal(M.fmtPct(0.00001), '<0.1%');
  assert.equal(M.fmtNum(12345), '12,000');
  assert.equal(M.fmtNum(1.234), '1.2');
});

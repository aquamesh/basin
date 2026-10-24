import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../model.js';
import { EXAMPLES } from '../examples.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const counties = read('../data/counties.json');
const places = read('../data/places.json');
const drought = read('../data/drought.json');
const rows = counties.rows.map((r) => Object.fromEntries(counties.cols.map((c, i) => [c, r[i]])));
const byFips = new Map(rows.map((r) => [r.f, r]));

test('county file covers the U.S. with unique FIPS codes', () => {
  assert.ok(rows.length >= 3200, String(rows.length));
  assert.equal(byFips.size, rows.length);
  for (const r of rows) assert.match(r.f, /^\d{5}$/);
  const states = new Set(rows.map((r) => r.s));
  assert.ok(states.size >= 51, String(states.size));
});

test('county fields are in plausible ranges', () => {
  const zones = new Set(Object.values(M.CLIMATES).flatMap((c) => c.zones));
  let withSupply = 0;
  for (const r of rows) {
    assert.ok(r.n && r.s, r.f);
    assert.ok(zones.has(r.z) || r.z === '', `${r.f} zone ${r.z}`);
    if (r.ps != null) { assert.ok(r.ps >= 0 && r.ps < 2500, `${r.f} ps ${r.ps}`); if (r.ps > 0) withSupply++; }
    if (r.gw != null) assert.ok(r.gw >= 0 && r.gw < 5000, `${r.f} gw ${r.gw}`);
    if (r.ws != null) assert.ok(Number.isInteger(r.ws) && r.ws >= -1 && r.ws <= 4, `${r.f} ws ${r.ws}`);
    if (r.wi != null) assert.ok(r.wi >= 0.03 && r.wi <= 3.5, `${r.f} wi ${r.wi}`);
  }
  assert.ok(withSupply / rows.length > 0.97, String(withSupply));
});

test('spot checks against known values', () => {
  // Maricopa (Phoenix): hot-dry, extremely high stress, hundreds of Mgal/d.
  const maricopa = byFips.get('04013');
  assert.equal(M.climateClass(maricopa.z), 'hot-dry');
  assert.equal(maricopa.ws, 4);
  assert.ok(maricopa.ps > 500 && maricopa.ps < 1000);
  // Loudoun (Data Center Alley): imports most of its water, so public use
  // (about 35 Mgal/d) is far above what is withdrawn inside the county (6.9).
  const loudoun = byFips.get('51107');
  assert.ok(loudoun.ps > 25 && loudoun.ps < 45, String(loudoun.ps));
  assert.equal(M.climateClass(loudoun.z), 'temperate');
});

test('drought file is recent and covers nearly every county', () => {
  const n = Object.keys(drought.rows).length;
  assert.ok(n >= 3100, String(n));
  const d = String(drought.date);
  const date = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  assert.ok(Date.now() - date < 1000 * 60 * 60 * 24 * 60, `drought data from ${d} is stale`);
  for (const v of Object.values(drought.rows)) {
    assert.equal(v.length, 5);
    for (let i = 1; i < 5; i++) assert.ok(v[i] <= v[i - 1] + 0.11, 'cumulative categories must not increase');
  }
});

test('every place points at a real county', () => {
  assert.ok(places.rows.length > 25000);
  for (const [name, st, fips] of places.rows) {
    assert.ok(name && st, fips);
    assert.ok(byFips.has(fips), `${name}, ${st} -> ${fips}`);
  }
  const find = (n, s) => places.rows.find((p) => p[0] === n && p[1] === s);
  assert.equal(find('Tucson', 'AZ')[2], '04019');
  assert.equal(find('Waco', 'TX')[2], '48309');
  assert.equal(find('Cedar City', 'UT')[2], '49021');
  assert.equal(find('Pocatello', 'ID')[2], '16005');
});

test('example cases load and produce sensible verdicts', () => {
  const expected = {
    '04019': 'dry',        // Project Blue: 31 M gal/yr, closed-loop
    '13103': 'dry',        // Effingham: 30,000 gal/day county estimate
    '51075': 'hybrid',     // Goochland: 600,000 gal/day on hot days, 900 MW
    '49021': 'dry',        // Antelope: 12.75 acre-feet/yr
    '48309': 'hybrid',     // InfraKey: 2 M gal/day reclaimed, 1,000 MW
  };
  for (const x of EXAMPLES) {
    const c = byFips.get(x.fips);
    assert.ok(c, x.fips);
    const input = { mw: x.mw, basis: x.basis || 'facility', cooling: x.cooling, source: x.source, util: M.PARAMS.defaultUtil, cycles: 4 };
    const r = M.estimate(input, c);
    assert.ok(r.byCooling.evaporative.central.annualGal > 0);
    const v = M.checkClaim(input, c, x.claim);
    assert.equal(v.matches, expected[x.fips], `${x.title}: ${v.matches} (${v.impliedFraction})`);
    assert.ok(x.url.startsWith('https://'));
  }
});

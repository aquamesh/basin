"""Build Basin's county and place data from public sources.

Run:  uv run --with shapely --with pyshp --with openpyxl --with xlrd scripts/build_data.py

Downloads land in .cache/raw (git-ignored). Outputs:
  data/counties.json  static county facts (USGS, Census, climate, Aqueduct, EIA)
  data/places.json    city/town -> county lookup for the search box
  data/drought.json   latest U.S. Drought Monitor week (also refreshed weekly
                      by scripts/update_drought.py in CI)
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / ".cache" / "raw"
OUT = ROOT / "data"
RAW.mkdir(parents=True, exist_ok=True)
OUT.mkdir(exist_ok=True)

SOURCES = {
    "usgs2015.csv": "https://www.sciencebase.gov/catalog/file/get/5af3311be4b0da30c1b245d8?f=__disk__eb%2F74%2Feb%2Feb74ebb41169c76aaf374990bd5a71cac82604c1",
    "gaz_counties.zip": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip",
    "gaz_place.zip": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip",
    "place_by_county2020.txt": "https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt",
    "sub_est2024.csv": "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv",
    "climate_zones.csv": "https://gist.githubusercontent.com/philngo/d3e251040569dba67942/raw/0c98f906f452b9c80d42aec3c8c3e1aafab9add8/climate_zones.csv",
    "hybas_na_lev06.zip": "https://data.hydrosheds.org/file/HydroBASINS/standard/hybas_na_lev06_v1c.zip",
    "hybas_ar_lev06.zip": "https://data.hydrosheds.org/file/HydroBASINS/standard/hybas_ar_lev06_v1c.zip",
    "eia_water_2024.xlsx": "https://www.eia.gov/electricity/data/water/xls/Cooling_Boiler_Generator_Data_Summary_2024.xlsx",
    "eia_gen_state.xls": "https://www.eia.gov/electricity/data/state/annual_generation_state.xls",
}
# Aqueduct 4.0 baseline CSV is extracted from a 261 MB zip with HTTP range
# requests (see fetch_aqueduct_csv) so we never download the whole archive.
AQUEDUCT_ZIP = "https://files.wri.org/aqueduct/aqueduct-4-0-water-risk-data.zip"
AQUEDUCT_MEMBER = "Aqueduct40_waterrisk_download_Y2023M07D05/CVS/Aqueduct40_baseline_annual_y2023m07d05.csv"

STATE_ABBR = {}


def fetch(name: str) -> Path:
    p = RAW / name
    if p.exists() and p.stat().st_size > 0:
        return p
    url = SOURCES[name]
    print(f"  downloading {name} ...", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "basin-data-build/1.0 (+https://github.com/aquamesh/basin)"})
    with urllib.request.urlopen(req, timeout=300) as r, open(p, "wb") as f:
        f.write(r.read())
    return p


class RangeFile(io.RawIOBase):
    """Seekable file over HTTP range requests, enough for zipfile."""

    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "basin-data-build/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}", "User-Agent": "basin-data-build/1.0"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def fetch_aqueduct_csv() -> Path:
    p = RAW / "aqueduct_baseline_annual.csv"
    if p.exists() and p.stat().st_size > 1_000_000:
        return p
    print("  extracting Aqueduct baseline CSV via range requests ...", file=sys.stderr)
    with zipfile.ZipFile(io.BufferedReader(RangeFile(AQUEDUCT_ZIP), buffer_size=1 << 20)) as z:
        member = next(n for n in z.namelist() if n.endswith("baseline_annual_y2023m07d05.csv"))
        with z.open(member) as src, open(p, "wb") as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
    return p


def num(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if s in ("", "--", "-", "N/A", "NA"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def zip_text(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".txt"))
        return z.read(name).decode("utf-8-sig")


# ---------------------------------------------------------------- counties
def load_gazetteer_counties():
    rows = {}
    reader = csv.DictReader(io.StringIO(zip_text(fetch("gaz_counties.zip"))), delimiter="|")
    for r in reader:
        r = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()}
        fips = r["GEOID"]
        STATE_ABBR[fips[:2]] = r["USPS"]
        rows[fips] = {
            "f": fips,
            "n": r["NAME"],
            "s": r["USPS"],
            "lat": float(r["INTPTLAT"]),
            "lon": float(r["INTPTLONG"]),
        }
    return rows


def load_usgs():
    text = fetch("usgs2015.csv").read_text(encoding="latin-1")
    lines = text.splitlines()[1:]  # first line is a citation
    reader = csv.DictReader(lines)
    out = {}
    for r in reader:
        r = {k.strip(): v for k, v in r.items() if k}
        fips = r["FIPS"].zfill(5)
        out[fips] = {
            "st": r["STATE"],
            "pop": (num(r.get("TP-TotPop")) or 0) * 1000,
            "psPop": (num(r.get("PS-TOPop")) or 0) * 1000,
            "psW": num(r.get("PS-Wtotl")) or 0,
            "gw": num(r.get("TO-WGWFr")),
            "doPc": num(r.get("DO-PSPCp")),
        }
    return out


def load_climate():
    out = {}
    with open(fetch("climate_zones.csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            fips = r["State FIPS"].zfill(2) + r["County FIPS"].zfill(3)
            zone = r["IECC Climate Zone"].strip()
            reg = r["IECC Moisture Regime"].strip()
            out[fips] = zone + (reg if reg and reg != "N/A" else "")
    return out


def load_drought():
    states = ",".join(sorted(set(STATE_ABBR.values()) - {"VI", "GU", "AS", "MP"}))
    url = (
        "https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent"
        f"?aoi={states}&startdate={{d}}&enddate={{d}}&statisticsType=1"
    )
    return fetch_drought(url)


def fetch_drought(url_tmpl: str):
    import datetime as dt

    today = dt.date.today()
    for back in range(0, 21, 1):
        d = today - dt.timedelta(days=back)
        url = url_tmpl.format(d=f"{d.month}/{d.day}/{d.year}")
        req = urllib.request.Request(url, headers={"User-Agent": "basin-data-build/1.0", "Accept": "text/csv"})
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(text)))
        if len(rows) > 3000:
            date = max(r["MapDate"] for r in rows)
            out = {}
            for r in rows:
                if r["MapDate"] != date:
                    continue
                out[r["FIPS"].zfill(5)] = [round(float(r[k]), 1) for k in ("D0", "D1", "D2", "D3", "D4")]
            return date, out
    raise RuntimeError("no drought data returned")


def load_aqueduct_by_pfaf():
    out = {}
    with open(fetch_aqueduct_csv(), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                pf = int(float(r["pfaf_id"]))
                cat = int(float(r["bws_cat"]))
            except (ValueError, TypeError):
                continue
            if cat == -9999:
                continue
            out.setdefault(pf, cat)
    return out


def basin_lookup(points):
    """Map each (lat, lon) to a HydroBASINS level-6 PFAF_ID."""
    import shapefile  # pyshp
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    geoms, pfafs = [], []
    for zname in ("hybas_na_lev06.zip", "hybas_ar_lev06.zip"):
        zpath = fetch(zname)
        with zipfile.ZipFile(zpath) as z:
            base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
            sf = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")), shx=io.BytesIO(z.read(base + ".shx")))
            fields = [f[0] for f in sf.fields[1:]]
            idx = fields.index("PFAF_ID")
            for sr in sf.iterShapeRecords():
                geoms.append(shape(sr.shape.__geo_interface__))
                pfafs.append(int(sr.record[idx]))
    tree = STRtree(geoms)
    out = {}
    for key, (lat, lon) in points.items():
        pt = Point(lon, lat)
        hit = None
        for i in tree.query(pt):
            if geoms[i].contains(pt):
                hit = pfafs[i]
                break
        if hit is None:
            i = tree.nearest(pt)
            if geoms[i].distance(pt) < 0.5:  # ~50 km; coastal points
                hit = pfafs[i]
        out[key] = hit
    return out


def load_offsite_intensity():
    """State water consumed at power plants per kWh generated (L/kWh), EIA 2024.

    Thermoelectric cooling-water consumption (EIA-923 cooling summary) divided
    by total state generation from all sources. Hydro reservoir evaporation is
    not included.
    """
    import openpyxl
    import xlrd

    wb = openpyxl.load_workbook(fetch("eia_water_2024.xlsx"), read_only=True)
    ws = wb.worksheets[0]
    header = None
    seen = {}
    for row in ws.iter_rows(values_only=True):
        if header is None:
            if row and row[1] == "State":
                header = [str(c).strip() if c else "" for c in row]
                i_state = header.index("State")
                i_plant = header.index("Plant Code")
                i_month = header.index("Month")
                i_cool = header.index("Cooling ID")
                i_cons = header.index("Water Consumption Volume (Million Gallons)")
            continue
        cons = num(row[i_cons])
        if cons is None:
            continue
        key = (row[i_state], row[i_plant], row[i_month], row[i_cool])
        # one cooling system can appear on several generator rows
        seen[key] = max(seen.get(key, 0), cons)
    cons_by_state = defaultdict(float)
    for (st, _, _, _), mg in seen.items():
        cons_by_state[st] += mg * 1e6  # gallons

    book = xlrd.open_workbook(fetch("eia_gen_state.xls"))
    sh = book.sheet_by_index(0)
    hdr_row = next(i for i in range(10) if "YEAR" in [str(c).upper() for c in sh.row_values(i)])
    hdr = [str(c).strip().upper() for c in sh.row_values(hdr_row)]
    iy, ist, ityp, isrc, igen = hdr.index("YEAR"), hdr.index("STATE"), hdr.index("TYPE OF PRODUCER"), hdr.index("ENERGY SOURCE"), next(i for i, h in enumerate(hdr) if h.startswith("GENERATION"))
    years = [int(v) for v in sh.col_values(iy)[hdr_row + 1 :] if str(v).strip() not in ("",)]
    year = max(y for y in years if y <= 2024)
    gen_by_state = {}
    for i in range(hdr_row + 1, sh.nrows):
        r = sh.row_values(i)
        try:
            if int(r[iy]) != year:
                continue
        except (ValueError, TypeError):
            continue
        if str(r[ityp]).strip().lower() != "total electric power industry" or str(r[isrc]).strip().lower() != "total":
            continue
        gen_by_state[str(r[ist]).strip()] = float(r[igen])  # MWh
    out = {}
    us_cons = sum(cons_by_state.values())
    us_gen = gen_by_state.get("US-TOTAL") or gen_by_state.get("US-Total") or sum(v for k, v in gen_by_state.items() if len(k) == 2)
    for st, gen in gen_by_state.items():
        if len(st) != 2 or gen <= 0:
            continue
        gal_per_mwh = cons_by_state.get(st, 0) / gen
        out[st] = round(gal_per_mwh * 3.785411784 / 1000, 3)  # L/kWh
    us = round(us_cons / us_gen * 3.785411784 / 1000, 3)
    # States with missing reports (0) or implausible ratios (one outlier
    # plant can dominate a small state) fall back to the U.S. value.
    for st, v in list(out.items()):
        if not (0.03 <= v <= 3.5):
            out[st] = us
    out["US"] = us
    return out, year


def load_state_pops_ct():
    """Connecticut planning-region populations (2024 estimates)."""
    pops = defaultdict(float)
    with open(fetch("sub_est2024.csv"), newline="", encoding="latin-1") as f:
        for r in csv.DictReader(f):
            if r["STATE"] == "09" and r["SUMLEV"] == "050":
                pops["09" + r["COUNTY"]] = float(r["POPESTIMATE2024"])
    return pops


def build_counties():
    print("counties ...", file=sys.stderr)
    gaz = load_gazetteer_counties()
    usgs = load_usgs()
    clim = load_climate()

    # State public-supply gallons per person per day (all public-supply uses).
    st_ps = defaultdict(lambda: [0.0, 0.0, 0.0])  # withdrawals Mgal/d, served pop, total pop
    for fips, u in usgs.items():
        s = st_ps[fips[:2]]
        s[0] += u["psW"]
        s[1] += u["psPop"]
        s[2] += u["pop"]
    st_pc = {k: (v[0] * 1e6 / v[1] if v[1] else None) for k, v in st_ps.items()}

    ct_pops = load_state_pops_ct()

    # Climate fallback: most common zone in the state.
    st_zone = defaultdict(Counter)
    for fips, z in clim.items():
        st_zone[fips[:2]][z] += 1

    print("aqueduct ...", file=sys.stderr)
    bws = load_aqueduct_by_pfaf()
    pf = basin_lookup({f: (c["lat"], c["lon"]) for f, c in gaz.items()})

    print("eia ...", file=sys.stderr)
    wi, eia_year = load_offsite_intensity()

    cols = ["f", "n", "s", "z", "ps", "psPop", "psW", "gw", "pop", "ws", "wi"]
    rows = []
    stats = Counter()
    for fips in sorted(gaz):
        c = gaz[fips]
        u = usgs.get(fips)
        pc = st_pc.get(fips[:2])
        if u:
            ps_pop = u["psPop"]
            ps = ps_pop * pc / 1e6 if (ps_pop and pc) else u["psW"]
            row_ps, row_psPop, row_psW, row_gw, row_pop = round(ps, 3), round(ps_pop), round(u["psW"], 3), (round(u["gw"], 3) if u["gw"] is not None else None), round(u["pop"])
            stats["usgs"] += 1
        elif fips.startswith("09") and fips in ct_pops and pc:
            served_share = st_ps["09"][1] / st_ps["09"][2]
            ps_pop = ct_pops[fips] * served_share
            row_ps, row_psPop, row_psW, row_gw, row_pop = round(ps_pop * pc / 1e6, 3), round(ps_pop), None, None, round(ct_pops[fips])
            stats["ct-estimated"] += 1
        else:
            row_ps = row_psPop = row_psW = row_gw = row_pop = None
            stats["no-usgs"] += 1
        z = clim.get(fips)
        if not z:
            z = st_zone[fips[:2]].most_common(1)[0][0] if st_zone[fips[:2]] else ""
            stats["zone-fallback"] += 1
        p = pf.get(fips)
        w = bws.get(p) if p is not None else None
        if w is None:
            stats["no-aqueduct"] += 1
        rows.append([fips, c["n"], c["s"], z, row_ps, row_psPop, row_psW, row_gw, row_pop, w, wi.get(c["s"])])
    print("  ", dict(stats), file=sys.stderr)
    return cols, rows, eia_year, wi.get("US")


# ------------------------------------------------------------------ places
LSAD_SUFFIX = re.compile(r" (city and borough|consolidated government \(balance\)|metropolitan government \(balance\)|unified government \(balance\)|metro government \(balance\)|city|town|village|borough|CDP|municipality|comunidad|zona urbana|plantation|corporation)$", re.I)


def build_places(county_pts):
    print("places ...", file=sys.stderr)
    pops = {}
    with open(fetch("sub_est2024.csv"), newline="", encoding="latin-1") as f:
        for r in csv.DictReader(f):
            if r["SUMLEV"] == "162":
                pops[r["STATE"] + r["PLACE"]] = int(float(r["POPESTIMATE2024"]))
    rel = defaultdict(list)
    with open(fetch("place_by_county2020.txt"), encoding="latin-1") as f:
        for r in csv.DictReader(f, delimiter="|"):
            rel[r["STATEFP"] + r["PLACEFP"]].append(r["STATEFP"] + r["COUNTYFP"])
    rows = []
    reader = csv.DictReader(io.StringIO(zip_text(fetch("gaz_place.zip"))), delimiter="|")
    for r in reader:
        r = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()}
        geoid = r["GEOID"]
        lat, lon = float(r["INTPTLAT"]), float(r["INTPTLONG"])
        cands = [c for c in rel.get(geoid, []) if c in county_pts]
        if not cands:
            cands = [c for c in county_pts if c[:2] == geoid[:2]]
        if not cands:
            continue

        def d2(c):
            la, lo = county_pts[c]
            return (la - lat) ** 2 + ((lo - lon) * math.cos(math.radians(lat))) ** 2

        fips = min(cands, key=d2) if len(cands) > 1 else cands[0]
        name = LSAD_SUFFIX.sub("", r["NAME"]).strip()
        pop = pops.get(geoid, 0)
        rows.append([name, r["USPS"], fips, pop])
    rows.sort(key=lambda x: (-x[3], x[0]))
    return rows


def main():
    cols, rows, eia_year, us_wi = build_counties()
    meta = {
        "usgsYear": 2015,
        "eiaYear": eia_year,
        "offsiteUs": us_wi,
        "built": __import__("datetime").date.today().isoformat(),
        "sources": {
            "usgs": "https://doi.org/10.5066/F7TB15V5",
            "gazetteer": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
            "climate": "https://gist.github.com/philngo/d3e251040569dba67942",
            "aqueduct": "https://www.wri.org/data/aqueduct-global-maps-40-data",
            "hydrobasins": "https://www.hydrosheds.org/products/hydrobasins",
            "eia": "https://www.eia.gov/electricity/data/water/",
        },
    }
    (OUT / "counties.json").write_text(json.dumps({"meta": meta, "cols": cols, "rows": rows}, separators=(",", ":")))
    gaz = load_gazetteer_counties()
    places = build_places({f: (c["lat"], c["lon"]) for f, c in gaz.items()})
    (OUT / "places.json").write_text(json.dumps({"rows": places}, separators=(",", ":"), ensure_ascii=False))
    print("drought ...", file=sys.stderr)
    date, dr = load_drought()
    (OUT / "drought.json").write_text(json.dumps({"date": date, "rows": dr}, separators=(",", ":")))
    print(f"wrote {len(rows)} counties, {len(places)} places, drought {date} ({len(dr)} counties)", file=sys.stderr)


if __name__ == "__main__":
    main()

"""Refresh data/drought.json from the U.S. Drought Monitor (stdlib only).

Run weekly by .github/workflows/drought.yml. The Drought Monitor's
statistics API sends no CORS headers, so the browser can't call it directly.
"""
import csv
import datetime as dt
import io
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATES = "AL,AK,AZ,AR,CA,CO,CT,DE,DC,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY,PR"
URL = ("https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent"
       "?aoi=" + STATES + "&startdate={d}&enddate={d}&statisticsType=1")


def main():
    today = dt.date.today()
    for back in range(0, 21):
        d = today - dt.timedelta(days=back)
        req = urllib.request.Request(URL.format(d=f"{d.month}/{d.day}/{d.year}"), headers={"User-Agent": "basin-drought-update/1.0", "Accept": "text/csv"})
        with urllib.request.urlopen(req, timeout=120) as r:
            rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8-sig"))))
        if len(rows) > 3000:
            date = max(r["MapDate"] for r in rows)
            out = {r["FIPS"].zfill(5): [round(float(r[k]), 1) for k in ("D0", "D1", "D2", "D3", "D4")] for r in rows if r["MapDate"] == date}
            if len(out) < 3000:
                sys.exit(f"only {len(out)} counties for {date}; not writing")
            path = ROOT / "data" / "drought.json"
            old = json.loads(path.read_text()) if path.exists() else {}
            if old.get("date") == date:
                print(f"already current ({date})")
                return
            path.write_text(json.dumps({"date": date, "rows": out}, separators=(",", ":")))
            print(f"wrote drought {date}: {len(out)} counties")
            return
    sys.exit("no drought data found in the last 3 weeks")


if __name__ == "__main__":
    main()

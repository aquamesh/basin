# Basin: how much water will this data center use?

**[aquamesh.github.io/basin](https://aquamesh.github.io/basin)**

Basin is a free, open calculator for the question showing up at county hearings all over the U.S. in 2026. Pick any of the 3,222 U.S. counties, enter the project's size and (if known) its cooling system and water source. You get:

- **Water drawn** on a peak summer day, on an average day and per year, with a likely range.
- **Local context:** equivalent homes, share of the county's public water supply, current drought, and long-term water stress.
- **Water by cooling choice:** evaporative, hybrid and closed-loop, including the water power plants use to make the extra electricity that water-saving designs need.
- **A claim checker.** Enter the developer's or utility's figure and Basin tells you what cooling design it implies, and whether it's physically plausible at that size.
- **Questions to ask** at a hearing or in a records request, tailored to what's still unknown.
- A shareable link and image for every estimate.

Everything runs in the browser. There is no build step, no tracking, and nothing you type leaves your machine.

## Why it exists

Local fights over data center water use are everywhere in 2026, and the facts are scarce. Developers often don't disclose cooling designs or water figures, some deals are under NDA, and only about 17% of Texas data centers answered the state's water survey. Residents, officials and reporters end up arguing over numbers no one can check. Developers who do plan low-water designs have no neutral way to show it.

Basin uses public data and basic physics to give everyone at the table the same starting point.

## How it works

The full method is in **[methodology.html](https://aquamesh.github.io/basin/methodology.html)**, every parameter has a source, and the tables on that page are generated from the same `model.js` the calculator runs. In short:

```
IT energy        = IT MW × 8,760 h × average load
Heat             = IT energy × PUE
Water evaporated = heat × (share of heat removed by evaporation) × 1.48 L/kWh
Water drawn      = evaporated × C / (C − 1)        (C = cycles of concentration)
Peak day         = average day × measured peak ratio, capped by hot-day physics
Off-site water   = facility energy × state power-plant water intensity (EIA 2024)
```

Parameters are calibrated against LBNL's 2024 *United States Data Center Energy Usage Report*, operator disclosures (Google, Microsoft, Meta, AWS), and utility meter data on peak days.

## Data

| Data | Source |
|---|---|
| Public-supply population, water per person, groundwater | USGS county water use, 2015 |
| Drought | U.S. Drought Monitor, refreshed weekly by GitHub Actions |
| Long-term water stress | WRI Aqueduct 4.0, joined to HydroBASINS |
| Power-plant water | EIA thermoelectric cooling water and state generation, 2024 |
| Counties, places, climate zones | Census Gazetteer, 2024 population estimates, IECC climate zones |

Rebuild the data:

```bash
uv run --with shapely --with pyshp --with openpyxl --with xlrd scripts/build_data.py
```

## Run locally and test

```bash
python3 -m http.server 5207   # then open http://localhost:5207
node --test tests/*.test.js   # model and data tests
```

## Limitations

Basin is a screening estimate, not an engineering study. Design choices can swing water use tenfold, announced megawatts are fuzzy, and USGS county data is from 2015. The methodology page lists all of this. When a developer publishes real numbers, put them in the claim checker.

## Contributing

Corrections, better data and real facility figures (with sources) are very welcome. Please open an issue or pull request.

## License

MIT. Built by [AquaMesh](https://aquamesh.ai), which makes water and cooling optimization software for industrial sites and data centers. Basin uses only public data.

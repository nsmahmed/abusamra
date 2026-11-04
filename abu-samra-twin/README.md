# WASL: the Abu Samra Digital Twin

WASL (وصل) is a live 3D digital twin of the **Abu Samra land border customs port**, the truck crossing between Qatar and Saudi Arabia. It runs in a web browser as a single HTML file, `dist/wasl.html`, with nothing to install. The port is drawn as a clean, illustrated rendering of the real site at true scale.

WASL lets a planner do four things in one place, in this order:

1. **Watch today.** Every truck moves through the port in real time. Live panels show occupancy, the current bottleneck, plate reads and any truck's journey.
2. **Ask what-if.** Move a slider, or type the change in plain English or Arabic. The port rebuilds itself and forecasts a full day against the baseline.
3. **Seek a goal.** Say where average time in port should be. WASL searches the levers and returns three costed plans: fast, balanced and cost-smart, each with its effect over the next three years.
4. **See the plan.** One click applies a plan to the twin, so leadership sees the new lanes, ramps and parking in place.

## Objective

Truck queues at Abu Samra cost time and fuel, and they produce emissions. Their impact reaches well beyond the port gates. Today, decisions about lanes, parking, inspection staffing, digital clearance and new infrastructure are made without a safe way to test them first.

WASL is that test environment. It places a true-scale 3D model of the port on the ground and drives it with a simulation of every import and export truck. Each truck drives the real roads from the GAC trip maps and stops at the radiation portals, gates, parking, X-ray scanning, inspection and release.

## Features

### Live operations (right panel)

- **Now:** trucks in the port, the public-road queue, average time in port, releases today, the current bottleneck and occupancy per stage.
- **Filters:** every truck carries attributes:
  - Risk lane: red (physical inspection) or green (no inspection).
  - Authorized Economic Operator (AEO) or not.
  - Pre-arrival declaration filed or not.
  - Country of loading (import) or destination (export).
  - Cargo type.

  Picking values greys out the trucks that do not match on the map and shows where the matching trucks are.
- **Bottleneck pattern:** compares the trucks held at the current bottleneck with every truck in the port and lists the attributes that are over-represented there, for example "red lane: 92% here against 35% port-wide". When nothing stands out, it says the stage is a plain capacity limit.
- **Gate reads** and **Track:** a plate-reader feed and a follow-camera for any truck, with its attributes and journey.

### Scenario planner (left panel)

- **What-if:** sliders for demand, gates and lanes, parking and ramps, time at each stage, and risk programmes (red-lane rate, AEO membership, pre-arrival filing). New capacity appears gold on the map, removed capacity red. "Run forecast" compares a typical day with the baseline.
- **Text to map:** write the change ("add 2 X-ray lanes and cut clearance time by 30 minutes"). Each phrase that names a resource becomes a planner setting; anything else is listed as ignored. Arabic works too.
- **Goal seek:** set a target average time in port and a yearly demand growth. WASL tests every lever in the twin, one step at a time, and builds three plans:
  - **Fast track:** quickest to land, usually the highest spend.
  - **Cost-smart:** lowest five-year cost, usually slower to land.
  - **Balanced:** a mix between the two.

  The plan comparison shows each plan's cost (capital plus five years of running cost, QAR millions), the time until every change is in service, the levers and what each saves, a 36-month projection against doing nothing, and a cost-against-hours-saved chart. **Visualize in the twin** applies the plan to the live port.

All capacities, process times, attribute mixes and lever costs are placeholders until they are calibrated with real customs data.

## How the trucks behave

- **Six truck types** after common GCC fleets: European cab-over with box or container semi-trailer, North-American long-nose with tanker or box trailer, and rigid box and curtain-side trucks. Most are white or silver, with a few fleet liveries.
- **Trucks stay on the roads.** Routes follow the measured carriageway centres, right-hand traffic. Trucks pull into bays, back onto inspection docks and queue single file on the public road.
- **Lots are filled from upstream.** Trucks wait in the external parking until the next gate and the next parking area have room.
- **Red-lane trucks go to inspection; green-lane trucks skip it.** AEO operators are sent to inspection far less often, and a pre-arrival declaration cuts clearance time.
- **Time control.** Real time (1×), 10×, 2 min/s, 10 min/s or 1 h/s. Lighting follows the clock or is fixed to dawn, day, dusk or night.

## Open it

Open `dist/wasl.html` in Chrome or Edge. The page needs internet access only to load three.js and the fonts.

| Control | Action |
|---|---|
| Left drag | Orbit |
| Right drag | Pan |
| Wheel | Zoom |
| Click a truck | Fly to it and follow it |
| Click a stage label or a stage in the bottom strip | Fly to that stage |
| `[` and `]` | Fold or unfold the planner and live panels |
| `Space` | Pause or resume |
| `Esc` | Close the plan comparison, or stop tracking |

## How the 3D scene is made

- **Imagery.** Three high-level Google Earth captures and fourteen close-ups (about 0.6 m per pixel), registered with SIFT feature matching and RANSAC homographies, give a base texture and three sharp tiles over the facility.
- **Illustrated rendering.** `pipeline/illustrate.py` turns the imagery into a clean rendered look. `pipeline/declutter.py` then:
  - Removes the vehicles photographed into the ground, so only the simulated 3D trucks remain.
  - Paints proper asphalt with white edge lines, a dashed centre line and a yellow kerb line along every truck route outside the yards.
- **Traced buildings**, inspection sheds with dock doors, lane canopies, drive-through X-ray tunnels, about 2,000 detected trees and street lights that come on at night.

## Project structure

```
data/map-imagery/   Google Earth captures (high level 1-3, closeup 1-14, overviews)
data/map-details/   GAC trip diagrams ("import trip.png" shows the export flow, "export trip.png" the import flow)
pipeline/           imagery and geometry pipeline (Python + OpenCV)
assets/             build inputs: photo ground and tiles (pipeline inputs), geo.json; assets/illus/ holds the textures the page uses
src/                page markup, simulation engine, flows, planning layer, 3D app
build.py            assembles dist/wasl.html
tests/              engine test (node), render test, view shooter and UI walk-through (Playwright)
```

### Rebuild

```
pip install numpy opencv-python pillow scipy scikit-image playwright
cd pipeline/work            # scratch folder for intermediate images
python ../mosaic.py         # stitch the three high-level images
python ../register.py       # register the close-ups onto the mosaic
python ../ground.py         # ground texture + high-res tiles (also cleans the main lot)
python ../composite.py      # full-resolution close-up composite (hr_full.png) for digitizing
python ../buildings.py      # building footprints + parking bay lattice -> assets/geo.json
python ../trees.py          # trees and shrubs -> assets/geo.json
python ../routes.py         # road-following truck routes, lots and stage anchors -> assets/geo.json
cd ../..
python pipeline/illustrate.py   # illustrated textures, vehicle removal, painted roads -> assets/illus/
python build.py                 # -> dist/wasl.html
python tests/ui_test.py out_dir [--quick]   # screenshots of every feature
```

`pipeline/zoom.py` and `pipeline/zoom2.py` render any area with a labelled mosaic-pixel grid; `zoom2.py` also draws the current routes. `tests/views.py` screenshots named camera positions in the built page.

## Connecting real data (next steps)

1. **Gate events.** Feed plate-recognizer events into the twin instead of synthetic arrivals. They use the same schema as the CSV export.
2. **Declarations.** Replace the synthetic truck attributes (lane, AEO, pre-arrival, origin, cargo) with declaration and risk-engine data.
3. **Calibration.** Calibrate stage capacities and times in `src/flows.js` and lever costs in `src/plan.js` from GAC history and programme budgets.
4. **Imagery licensing.** Replace the Google Earth imagery with GAC-licensed or drone orthophotos before any external use. Google Earth imagery is for internal prototyping only.

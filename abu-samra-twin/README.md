# Abu Samra Digital Twin

A live 3D digital twin of the **Abu Samra land border customs port**, the truck crossing between Qatar and Saudi Arabia. It runs in a web browser as a single HTML file, with nothing to install. It comes in two versions with the same features:

- **Satellite view** (`dist/abu-samra-twin.html`): the port on real Google Earth imagery.
- **Illustrated view** (`dist/abu-samra-twin-illustrated.html`): the same port as a clean, rendered illustration.

A link in the title bar switches between them.

## Objective

Truck queues at Abu Samra cost time and fuel, and they produce emissions. Their impact reaches well beyond the port gates. Today, decisions about lanes, parking, inspection staffing and new infrastructure are made without a safe way to test them first.

The twin provides that test environment. It places a true-scale 3D model of the port on the ground and drives it with a simulation of every import and export truck. Each truck drives the real roads from the GAC trip maps and stops at the radiation portals, gates, parking, X-ray scanning, inspection and release. Planners can change the port and watch the effect play out before committing money or staff.

## What it can be used for

- **Operational awareness:** shows where trucks are queuing right now, which stage is the bottleneck, and how full each parking area and ramp yard is.
- **What-if planning:** shows what happens if there are 40% more trucks during Eid, if X-ray capacity is expanded, or if two release lanes are added.
  - Every change appears on the map: new lanes, bays and ramps are drawn in gold, removed ones in red.
  - The twin forecasts a full day for each scenario and compares it with the baseline.
- **Investment decisions:** the optimizer finds the smallest increase in a resource (gates, lanes, parking or ramps) that meets a target time in port. It also reports when that resource is not the real constraint.
- **Truck tracking:** follow any plate. The camera flies to the truck and keeps it in view, with an optional chase camera. You can also export gate-read events in the same format a real plate-recognition system would produce.
- **Plain-language questions:** when the page is opened as a claude.ai artifact, a copilot answers questions such as "what is the cheapest way to get average time under 4 hours?" in Arabic or English. It runs the simulation itself to find the answer.
- **Briefings and stakeholder communication:** a single shareable page shows leadership and partners how the port works, by day or night, in a photographic or an illustrated style.

All capacities and process times are placeholders until they are calibrated with real customs data. See the section on connecting real data below.

## How the trucks behave

- **Trucks stay on the roads.** Routes are traced along the real carriageways shown in the GAC trip maps, and trucks keep to the right-hand lane. They pull into bays, back onto inspection docks, and queue single file on the public road without overtaking.
- **Lots are filled from upstream.** Trucks wait in the external parking until there is room further in, and leave only when the next gate and the next parking area have a free place. When the external parking is full, the queue forms on the road outside it.
  - **Export defaults:** 150 external, 12 operational parking, 10 inspection ramps.
  - **Import defaults:** 100 external, 700 main parking, 6 X-ray slots, 130 inspection ramps.
- **Every stage takes its configured time.** The planner's "Time at each stage" group sets the average time a truck spends at each stage, and the drive between stages takes the real distance at 25 km/h.
- **Time control.** You can run in real time (1×), 10×, 2 min/s, 10 min/s or 1 h/s. Lighting can follow the clock or be fixed to dawn, day, dusk or night. At night, trucks drive with headlights and tail lights.

## Open it

Open either file in `dist/` in Chrome or Edge. Both files must stay in the same folder for the view switch to work. The pages need internet access only to load three.js and the fonts.

| Control | Action |
|---|---|
| Left drag | Orbit |
| Right drag | Pan |
| Wheel | Zoom |
| Click a truck | Fly to it and follow it |
| Click a stage label or a stage in the bottom strip | Fly to that stage |
| `[` and `]` | Fold or unfold the planner and live panels |
| `Space` | Pause or resume |
| `Esc` | Stop tracking |

## How the 3D scene is made realistic

- **Real imagery, two levels of detail.**
  - Three high-level Google Earth captures cover the wider area.
  - Fourteen close-ups, about 0.6 m per pixel, are registered automatically onto them with SIFT feature matching and RANSAC homographies.
  - The close-ups become three sharp, alpha-blended ground tiles over the facility.
  - The desert beyond the imagery is synthesized from real sand texture so there are no visible edges.
- **Illustrated rendering.** The illustrated version is generated from the same imagery. Edge-preserving smoothing, gradient maps for asphalt, sand and sabkha, greenery and ink outlines give it a rendered-model look. Everything stays aligned.
- **Traced buildings.** 33 structures are measured from the imagery and extruded with their real roofs:
  - Inspection sheds with dock doors.
  - The customs halls and twin-dome buildings.
  - Lane canopies on pillars.
  - The X-ray canopies and service buildings.
  - Facade windows light up at night.
- **Detected vegetation.** About 2,000 trees and shrubs are placed where they appear in the imagery.
- **A clean main parking lot.** The trucks baked into the photograph were removed by rebuilding the lot from its repeating bay pattern. Simulated trucks park on the real bay rows.

## Project structure

```
data/map-imagery/   Google Earth captures (high level 1-3, closeup 1-14, overviews)
data/map-details/   GAC trip diagrams ("import trip.png" shows the export flow, "export trip.png" the import flow)
pipeline/           imagery and geometry pipeline (Python + OpenCV)
assets/             build inputs: ground texture, high-res tiles, geo.json; assets/illus/ holds the illustrated textures
src/                page markup, simulation engine, flows, 3D app
build.py            assembles both pages in dist/
tests/              engine test (node) and headless render test (Playwright)
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
python pipeline/illustrate.py   # illustrated textures -> assets/illus/
python build.py                 # -> dist/abu-samra-twin.html and dist/abu-samra-twin-illustrated.html
python tests/render_test.py out_dir --night            # add --illustrated for the second view
```

`pipeline/zoom.py` and `pipeline/zoom2.py` render any area with a labelled mosaic-pixel grid. `zoom2.py` also draws the current routes. Use them to measure footprints and trace roads.

## Connecting real data (next steps)

1. **Gate events.** Feed plate-recognizer events into the twin instead of synthetic arrivals. They use the same schema as the CSV export.
2. **Calibration.** Calibrate the stage capacities and times in `src/flows.js` from GAC gate, declaration and inspection history.
3. **Imagery licensing.** Replace the Google Earth imagery with GAC-licensed or drone orthophotos before any external use. Google Earth imagery is for internal prototyping only.

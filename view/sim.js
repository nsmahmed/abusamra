/* Live customs operations drawn on the Abu Samra road geometry. */
const AbuSamraSim = (() => {
  const CAR_COLORS = ["#f4f7f8", "#d6dbdf", "#5dade2", "#2c3e50"];

  function meters(a, b) {
    const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (b[0] - a[0]) * 111412 * Math.cos(lat);
    const dy = (b[1] - a[1]) * 110940;
    return Math.hypot(dx, dy);
  }

  function bearing(a, b) {
    const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (b[0] - a[0]) * Math.cos(lat);
    const dy = b[1] - a[1];
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  function prepare(path) {
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + meters(path[i - 1], path[i]));
    return cum;
  }

  function pointAt(path, cum, distance) {
    const last = path.length - 1;
    if (distance <= 0) return { lon: path[0][0], lat: path[0][1], bearing: bearing(path[0], path[1]) };
    if (distance >= cum[last]) return { lon: path[last][0], lat: path[last][1], bearing: bearing(path[last - 1], path[last]) };
    let i = 1;
    while (cum[i] < distance) i += 1;
    const span = cum[i] - cum[i - 1] || 1;
    const t = (distance - cum[i - 1]) / span;
    return {
      lon: path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
      lat: path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      bearing: bearing(path[i - 1], path[i])
    };
  }

  function icon(draw) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    draw(ctx);
    return ctx.getImageData(0, 0, 64, 64);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function carIcon(color) {
    return icon((ctx) => {
      ctx.translate(32, 32);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      roundRect(ctx, -11, -20, 22, 42, 6);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, -12, -22, 24, 42, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(20,30,40,0.78)";
      roundRect(ctx, -9, -16, 18, 10, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(-8, 8, 16, 2);
    });
  }

  function busIcon() {
    return icon((ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      roundRect(ctx, 16, 8, 32, 50, 6);
      ctx.fill();
      ctx.fillStyle = "#f7dc6f";
      roundRect(ctx, 15, 6, 34, 52, 7);
      ctx.fill();
      ctx.fillStyle = "rgba(20,30,40,0.8)";
      for (let y = 14; y <= 44; y += 10) roundRect(ctx, 20, y, 24, 6, 2), ctx.fill();
    });
  }

  function truckIcon(container) {
    return icon((ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      roundRect(ctx, 16, 6, 32, 52, 4);
      ctx.fill();
      ctx.fillStyle = "#f4f6f7";
      roundRect(ctx, 18, 4, 28, 16, 4);
      ctx.fill();
      ctx.fillStyle = container;
      roundRect(ctx, 15, 22, 34, 34, 3);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(20, 28, 24, 22);
    });
  }

  function laneFrom(record, kind) {
    if (!record.path || record.path.length < 2) return null;
    const cum = prepare(record.path);
    const length = cum[cum.length - 1];
    if (length < 30) return null;
    const stop = Math.max(8, Math.min(length - 8, (record.stop_m / record.path_m) * length));
    return {
      id: record.id,
      kind,
      name: record.name,
      nameAr: record.name_ar || "",
      path: record.path,
      cum,
      length,
      stop,
      hold: 0,
      vehicles: []
    };
  }

  function makeVehicle(lane, distance, kind) {
    const truck = kind === "truck";
    const bus = kind === "bus";
    return {
      lane: lane.id,
      kind,
      icon: truck ? (lane.id.endsWith("2") ? "truck-red" : "truck-teal") : bus ? "bus" : "car-" + (Math.floor(Math.random() * CAR_COLORS.length)),
      distance,
      state: "drive",
      cleared: distance > lane.stop + 12,
      hold: 0
    };
  }

  return {
    async start(map) {
      const response = await fetch("../data/processed/operations.json");
      if (!response.ok) return;
      const ops = await response.json();
      const lanes = [];
      ops.arrivals.forEach((item) => { const lane = laneFrom(item, "arrival"); if (lane) lanes.push(lane); });
      ops.departures.forEach((item) => { const lane = laneFrom(item, "departure"); if (lane) lanes.push(lane); });
      ops.scanners.forEach((item) => { const lane = laneFrom(item, "scanner"); if (lane) lanes.push(lane); });
      ops.platform_lanes.forEach((item) => { const lane = laneFrom(item, "platform"); if (lane) lanes.push(lane); });
      ops.yards.forEach((yard) => {
        yard.aisles.forEach((aisle, index) => {
          if (index % 2 === 1) return;
          const lane = laneFrom({ ...aisle, id: "aisle-" + aisle.osm_way_id, name: yard.name, name_ar: yard.name_ar, stop_m: aisle.length_m * 0.5, path_m: aisle.length_m }, "yard");
          if (lane) lanes.push(lane);
        });
      });

      lanes.forEach((lane) => {
        if (lane.kind === "arrival" || lane.kind === "departure") {
          for (let i = 0; i < 6; i += 1) {
            const kind = i % 6 === 0 ? "bus" : "car";
            const at = lane.stop - 14 - i * (kind === "bus" ? 18 : 14);
            if (at > 10) lane.vehicles.push(makeVehicle(lane, at, kind));
          }
          lane.vehicles.push(makeVehicle(lane, lane.stop + 36, "car"));
          lane.vehicles.push(makeVehicle(lane, lane.stop + 78, "car"));
        } else if (lane.kind === "scanner" || lane.kind === "platform") {
          lane.vehicles.push(makeVehicle(lane, Math.max(8, lane.stop - 28), "truck"));
          lane.vehicles.push(makeVehicle(lane, Math.max(8, lane.stop - 58), "truck"));
          if (lane.stop + 40 < lane.length) lane.vehicles.push(makeVehicle(lane, lane.stop + 40, "truck"));
        } else {
          const parked = Math.random() < 0.62;
          const vehicle = makeVehicle(lane, lane.length * (0.28 + Math.random() * 0.5), "truck");
          if (parked) {
            vehicle.state = "park";
            vehicle.hold = 40 + Math.random() * 80;
          }
          lane.vehicles.push(vehicle);
        }
      });
      ["car-0", "car-1", "car-2", "car-3"].forEach((name, index) => map.addImage(name, carIcon(CAR_COLORS[index]), { pixelRatio: 2 }));
      map.addImage("bus", busIcon(), { pixelRatio: 2 });
      map.addImage("truck-teal", truckIcon("#0f6e78"), { pixelRatio: 2 });
      map.addImage("truck-red", truckIcon("#c0392b"), { pixelRatio: 2 });

      const empty = { type: "FeatureCollection", features: [] };
      map.addSource("sim-vehicles", { type: "geojson", data: empty });
      map.addSource("sim-booths", { type: "geojson", data: empty });
      map.addSource("sim-scanners", { type: "geojson", data: empty });
      const siteFeatures = ops.sites.map((site) => ({
        type: "Feature",
        properties: { name: site.name, name_ar: site.name_ar, role: site.role, detail: site.name },
        geometry: { type: "Polygon", coordinates: [site.polygon] }
      }));
      ops.yards.forEach((yard) => {
        siteFeatures.push({
          type: "Feature",
          properties: { name: yard.name, role: "yard", detail: yard.aisles.length + " mapped parking aisles" },
          geometry: { type: "Point", coordinates: [yard.lon, yard.lat] }
        });
      });
      map.addSource("sim-sites", { type: "geojson", data: { type: "FeatureCollection", features: siteFeatures } });

      map.addLayer({
        id: "sim-sites-fill",
        type: "fill",
        source: "sim-sites",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": ["match", ["get", "role"], "arrival_canopy", "#2ecc71", "departure_canopy", "#5dade2", "customs_canopy", "#1abc9c", "truck_platform", "#f5b041", "scanner_hall", "#e74c3c", "#ffffff"],
          "fill-opacity": 0.22
        }
      });
      map.addLayer({
        id: "sim-sites-line",
        type: "line",
        source: "sim-sites",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": "#ffffff", "line-width": 1.6, "line-opacity": 0.9 }
      });
      map.addLayer({
        id: "sim-sites-label",
        type: "symbol",
        source: "sim-sites",
        minzoom: 15.4,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-font": ["Open Sans Bold"],
          "text-offset": [0, -1.1],
          "text-allow-overlap": false
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "#142028", "text-halo-width": 1.3 }
      });
      map.addLayer({
        id: "sim-booths",
        type: "circle",
        source: "sim-booths",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 17, 7],
          "circle-color": ["match", ["get", "state"], "busy", "#f5b041", "#2ecc71"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5
        }
      });
      map.addLayer({
        id: "sim-scanners",
        type: "circle",
        source: "sim-scanners",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 5, 17, 9],
          "circle-color": ["match", ["get", "state"], "busy", "#f5b041", "#e74c3c"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
      map.addLayer({
        id: "sim-vehicles",
        type: "symbol",
        source: "sim-vehicles",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 13.5, ["match", ["get", "kind"], "truck", 0.34, "bus", 0.32, 0.26], 17.5, ["match", ["get", "kind"], "truck", 0.85, "bus", 0.75, 0.62]],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true
        }
      });

      const boothFeatures = [...ops.arrivals, ...ops.departures].map((booth) => ({
        type: "Feature",
        properties: { id: booth.id, name: booth.name, name_ar: booth.name_ar, role: "booth", state: "open", detail: "Passport and customs lane" },
        geometry: { type: "Point", coordinates: [booth.lon, booth.lat] }
      }));
      const scannerFeatures = ops.scanners.map((scanner) => ({
        type: "Feature",
        properties: { id: scanner.id, name: scanner.name, name_ar: scanner.name_ar, role: "scanner", state: "open", detail: "Cargo x-ray on the service road in front of the gantry" },
        geometry: { type: "Point", coordinates: [scanner.lon, scanner.lat] }
      }));

      let running = true;
      let multiplier = 8;
      let scenario = 0;
      let last = performance.now();
      let cleared = { arrival: 0, departure: 0, scanner: 0, platform: 0 };
      let acc = 0;

      const toggle = document.getElementById("sim-toggle");
      const speed = document.getElementById("sim-speed");
      const speedLabel = document.getElementById("sim-speed-label");
      const focus = document.getElementById("sim-focus");
      if (toggle) toggle.addEventListener("click", () => {
        running = !running;
        toggle.textContent = running ? "Pause" : "Run";
        toggle.classList.toggle("primary", running);
      });
      if (speed) speed.addEventListener("input", () => {
        multiplier = Number(speed.value);
        if (speedLabel) speedLabel.textContent = multiplier + "×";
      });
      if (focus) focus.addEventListener("click", () => {
        const points = [...ops.arrivals, ...ops.departures, ...ops.scanners, ...ops.platform_lanes.map((lane) => lane.path[Math.floor(lane.path.length / 2)])];
        let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
        points.forEach((point) => {
          const lon = point.lon || point[0];
          const lat = point.lat || point[1];
          minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
          minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        });
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 70, maxZoom: 16.6, duration: 700 });
      });

      function cruise(lane, vehicle) {
        if (lane.kind === "yard") return 3.2;
        if (lane.kind === "scanner") return 6;
        if (lane.kind === "platform") return 5;
        const remaining = lane.stop - vehicle.distance;
        if (!vehicle.cleared && remaining < 70 && remaining > 0) return 4.2;
        return vehicle.kind === "bus" ? 11 : 13;
      }

      function step(dt) {
        scenario += dt;
        lanes.forEach((lane) => {
          const ordered = lane.vehicles.slice().sort((a, b) => b.distance - a.distance);
          ordered.forEach((vehicle, index) => {
            const leader = ordered[index - 1];
            if (vehicle.state === "process" || vehicle.state === "park") {
              vehicle.hold -= dt;
              if (vehicle.hold <= 0) {
                vehicle.state = "drive";
                vehicle.cleared = true;
                if (lane.kind === "arrival" || lane.kind === "departure" || lane.kind === "scanner" || lane.kind === "platform") {
                  cleared[lane.kind] += 1;
                }
                lane.hold = 0;
              }
              return;
            }
            let target = cruise(lane, vehicle);
            if (leader) {
              const gap = leader.distance - vehicle.distance;
              const need = vehicle.kind === "truck" ? 20 : vehicle.kind === "bus" ? 16 : 11;
              if (gap < need) target = Math.min(target, Math.max(0, leader.state === "drive" ? target * (gap / need) : 0));
              if (gap < 7) target = 0;
            }
            const arriving = !vehicle.cleared && vehicle.distance >= lane.stop - 6 && vehicle.distance <= lane.stop + 8;
            if (arriving && lane.kind !== "yard") {
              const front = !leader || leader.cleared || leader.distance > lane.stop + 10;
              if (front && lane.hold <= scenario) {
                vehicle.state = "process";
                vehicle.distance = lane.stop;
                vehicle.hold = lane.kind === "scanner" ? 28 + Math.random() * 14 : 22 + Math.random() * 12;
                lane.hold = scenario + vehicle.hold;
                return;
              }
              target = 0;
            }
            if (lane.kind === "yard" && !vehicle.cleared && vehicle.distance >= lane.stop && vehicle.state === "drive") {
              vehicle.state = "park";
              vehicle.hold = 25 + Math.random() * 50;
              return;
            }
            vehicle.distance += target * dt;
            if (vehicle.distance >= lane.length - 1) {
              const tail = lane.vehicles.reduce((min, other) => other === vehicle ? min : Math.min(min, other.distance), lane.length);
              vehicle.distance = tail > 22 ? 4 : -30;
              vehicle.cleared = false;
              vehicle.state = "drive";
            }
          });
        });
      }

      function publish() {
        const vehicles = [];
        const boothState = {};
        const scannerState = {};
        let inArrival = 0;
        let inDeparture = 0;
        let inYard = 0;
        let scannersBusy = 0;
        lanes.forEach((lane) => {
          const busy = lane.vehicles.some((vehicle) => vehicle.state === "process");
          if (lane.kind === "arrival" || lane.kind === "departure") boothState[lane.id] = busy ? "busy" : "open";
          if (lane.kind === "scanner") {
            scannerState[lane.id] = busy ? "busy" : "open";
            if (busy) scannersBusy += 1;
          }
          lane.vehicles.forEach((vehicle) => {
            if (vehicle.distance < 0 || vehicle.distance > lane.length) return;
            if (lane.kind === "arrival" && !vehicle.cleared) inArrival += 1;
            if (lane.kind === "departure" && !vehicle.cleared) inDeparture += 1;
            if (lane.kind === "yard") inYard += 1;
            const at = pointAt(lane.path, lane.cum, Math.max(0, vehicle.distance));
            const status = vehicle.state === "process" ? "Under inspection" : vehicle.state === "park" ? "Holding in the yard" : "Moving";
            vehicles.push({
              type: "Feature",
              properties: {
                name: (vehicle.kind === "truck" ? "Truck" : vehicle.kind === "bus" ? "Bus" : "Car") + " · " + lane.name,
                detail: status,
                amenity: lane.kind,
                kind: vehicle.kind,
                icon: vehicle.icon,
                bearing: at.bearing,
                scope: "port"
              },
              geometry: { type: "Point", coordinates: [at.lon, at.lat] }
            });
          });
        });
        map.getSource("sim-vehicles").setData({ type: "FeatureCollection", features: vehicles });
        boothFeatures.forEach((feature) => { feature.properties.state = boothState[feature.properties.id] || "open"; });
        scannerFeatures.forEach((feature) => { feature.properties.state = scannerState[feature.properties.id] || "open"; });
        map.getSource("sim-booths").setData({ type: "FeatureCollection", features: boothFeatures });
        map.getSource("sim-scanners").setData({ type: "FeatureCollection", features: scannerFeatures });
        const clock = document.getElementById("ops-clock");
        const minutes = Math.floor(8 * 60 + scenario / 60);
        if (clock) clock.textContent = String(Math.floor(minutes / 60) % 24).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
        const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = String(value); };
        set("n-arr", inArrival);
        set("n-dep", inDeparture);
        set("n-yard", inYard);
        set("n-scan", scannersBusy + " / " + ops.scanners.length);
        const meta = document.getElementById("ops-meta");
        if (meta) {
          const done = cleared.arrival + cleared.departure;
          const cargo = cleared.scanner + cleared.platform;
          meta.textContent = done + " passenger " + (done === 1 ? "clearance" : "clearances") + " · " + cargo + " cargo " + (cargo === 1 ? "clearance" : "clearances") + " in this run";
        }
      }

      function frame(now) {
        const dtReal = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (running) {
          step(dtReal * multiplier);
          acc += dtReal;
          if (acc > 0.08) {
            publish();
            acc = 0;
          }
        }
        requestAnimationFrame(frame);
      }
      publish();
      requestAnimationFrame(frame);

      const layerIds = ["sim-sites-fill", "sim-sites-line", "sim-sites-label", "sim-booths", "sim-scanners", "sim-vehicles"];
      const checkbox = document.getElementById("sim-visible");
      if (checkbox) checkbox.addEventListener("change", () => {
        const value = checkbox.checked ? "visible" : "none";
        layerIds.forEach((id) => map.setLayoutProperty(id, "visibility", value));
        const hud = document.getElementById("ops");
        if (hud) hud.style.display = checkbox.checked ? "" : "none";
      });
    }
  };
})();

(() => {
  'use strict';

  // Store Explorer — DA #10800 / Case #549
  // Projection prototype: cache-busted test.js?v=6
  // The WGS84 AEQD/LAEA coordinates below were computed independently
  // with pyproj against EPSG:4326 / WGS84 and embedded so this browser
  // prototype does not depend on a fragile projection-library runtime.

  const RADIUS = 2000;
  const DA_AREA = 95.21966578066349;
  const REF_PCT = 26.68635635403409;

  const DA = [
    [-79.6012114, 43.5721830],
    [-79.6011376, 43.5719941],
    [-79.6013006, 43.5721238]
  ];
  const CENTER = [-79.59694983, 43.55434149];

  const AEQD_DA = [
    [-344.2507576115536, 1982.266919497926],
    [-338.2902312072341, 1961.2790917233128],
    [-351.45670153984634, 1975.6899423155803]
  ];
  const LAEA_DA = [
    [-344.2508759126965, 1982.266535454955],
    [-338.29034624411656, 1961.2787162746617],
    [-351.45682191925783, 1975.6895593114812]
  ];

  const status = document.getElementById('status');
  const out = document.getElementById('out');

  function edgeTs(ax, ay, bx, by, radius) {
    const dx = bx - ax;
    const dy = by - ay;
    const A = dx * dx + dy * dy;
    if (A === 0) return [];

    const B = 2 * (ax * dx + ay * dy);
    const C = ax * ax + ay * ay - radius * radius;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return [];

    const sd = Math.sqrt(disc);
    const t1 = (-B - sd) / (2 * A);
    const t2 = (-B + sd) / (2 * A);
    const ts = [];

    if (t1 > 0 && t1 < 1) ts.push(t1);
    if (t2 > 0 && t2 < 1 && Math.abs(t2 - t1) > 1e-12) ts.push(t2);
    return ts.sort((a, b) => a - b);
  }

  function edgeContribution(ax, ay, bx, by, radius) {
    const ts = [0, ...edgeTs(ax, ay, bx, by, radius), 1];
    let area = 0;

    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      const x0 = ax + (bx - ax) * t0;
      const y0 = ay + (by - ay) * t0;
      const x1 = ax + (bx - ax) * t1;
      const y1 = ay + (by - ay) * t1;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;

      if (mx * mx + my * my <= radius * radius) {
        area += (x0 * y1 - x1 * y0) / 2;
      } else {
        const angle = Math.atan2(
          x0 * y1 - y0 * x1,
          x0 * x1 + y0 * y1
        );
        area += radius * radius * angle / 2;
      }
    }

    return area;
  }

  function clipArea(ring, radius) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      area += edgeContribution(p[0], p[1], q[0], q[1], radius);
    }
    return Math.abs(area);
  }

  function currentLocal(pt) {
    const lon0 = CENTER[0];
    const lat0 = CENTER[1];
    const earthRadius = 6371008.8;
    const rad = Math.PI / 180;
    const lonScale = rad * earthRadius * Math.cos(lat0 * rad);
    const latScale = rad * earthRadius;
    return [(pt[0] - lon0) * lonScale, (pt[1] - lat0) * latScale];
  }

  function runOne(name, ring) {
    const finite = ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!finite) throw new Error(`${name} produced non-finite projected coordinates`);

    const t0 = performance.now();
    const intersectionArea = clipArea(ring, RADIUS);
    const ms = performance.now() - t0;
    const overlap = intersectionArea / DA_AREA * 100;

    return {
      name,
      daArea: DA_AREA,
      intersectionArea,
      overlap,
      error: overlap - REF_PCT,
      ms
    };
  }

  function fmt(n, d = 6) {
    return Number(n).toFixed(d);
  }

  document.getElementById('run').addEventListener('click', () => {
    status.textContent = 'Running #549 projection comparison...';

    setTimeout(() => {
      try {
        const current = runOne('Current local model', DA.map(currentLocal));
        const aeqd = runOne('WGS84 Azimuthal Equidistant', AEQD_DA);
        const laea = runOne('WGS84 Lambert Azimuthal Equal-Area', LAEA_DA);

        const rows = [current, aeqd, laea]
          .map((r) => `<tr>
            <td>${r.name}</td>
            <td>${fmt(r.daArea)} m²</td>
            <td>${fmt(r.intersectionArea)} m²</td>
            <td>${fmt(r.overlap)}%</td>
            <td>${r.error >= 0 ? '+' : ''}${fmt(r.error)} pp</td>
            <td>${fmt(r.ms, 3)} ms</td>
          </tr>`)
          .join('');

        out.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>DA area used</th>
                <th>Intersection area</th>
                <th>Overlap</th>
                <th>Error vs independent ref</th>
                <th>Clip time</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="note">
            <b>Independent WGS84 reference:</b> ${fmt(REF_PCT)}%.
            <b>Current:</b> ${fmt(current.overlap)}%.
            <b>AEQD:</b> ${fmt(aeqd.overlap)}%.
            <b>LAEA:</b> ${fmt(laea.overlap)}%.
          </div>
          <div class="note">
            <b>Interpretation:</b> AEQD preserves distance from the store centre;
            LAEA preserves area. Both use the same specialized true-circle clipper.
          </div>
          <pre>DA #10800 vertices:
${DA.map((p) => p.map((v) => v.toFixed(8)).join(', ')).join('\n')}

Circle centre: ${CENTER.join(', ')}
Radius: ${RADIUS} m</pre>`;

        status.textContent = 'Complete.';
      } catch (err) {
        status.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
        console.error(err);
      }
    }, 0);
  });
})();

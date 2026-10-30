(() => {
  'use strict';

  // Store Explorer — Final AEQD validation, cache-busted test.js?v=7
  // Six fixed difficult Ontario DA / 2 km cases.
  const RADIUS = 2000;
  const cases = [
    {id:'#549', index:10800, ref:26.686356354034093, da:95.21967662069159, lng:-79.59694983, lat:43.55434149, pts:[[-344.2507576115536,1982.266919497926],[-338.2902312072341,1961.2790917233128],[-351.45670153984634,1975.6899423155803]]},
    {id:'#568', index:11045, ref:14.065190767369101, da:140132.2576161027, lng:-80.22940369, lat:43.56255375, pts:[[-1105.5316783962744,-1657.5463749947337],[-1171.71817502226,-1707.2872670274364],[-1341.764390872492,-1616.7839522755733],[-1714.6884454141864,-1546.5039880156692],[-1666.1612709440215,-1123.9452417146997],[-1247.7716942128904,-1531.9857051177364],[-1126.256846967493,-1589.1365566592701]]},
    {id:'#57', index:6459, ref:13.578490655999651, da:166154.29049492133, lng:-79.49235852, lat:43.66470299, pts:[[-1799.8138212396193,-772.1521685542267],[-1657.5392622124066,-1145.881259584995],[-1417.475451276589,-1312.3057446486125],[-1337.2676014096335,-1577.8642630005734],[-1477.9613804426147,-1558.3023503706936],[-1636.862619053316,-1604.4296921611863],[-1921.4648642948187,-740.3421632742094]]},
    {id:'#969', index:1193, ref:13.474527429872376, da:84061.12045153044, lng:-75.82032394, lat:45.33785755, pts:[[1688.5969071283175,1403.7106674885495],[1819.5168646150973,1036.5673390333286],[1679.1122507661946,1000.7973829091455],[1612.4595848729132,1151.3283183710143],[1580.4259025302376,1139.0616309946843],[1482.0831832222254,1367.5165187728492],[1571.4628644911281,1507.7173008177513]]},
    {id:'#653', index:8137, ref:12.87399514795201, da:46321.55073488683, lng:-79.33125549, lat:43.67975022, pts:[[1954.3351164187638,-887.0197375332012],[1864.7360445880465,-915.2328594658276],[1788.7340157180734,-764.6496309839014],[1934.3687391976182,-586.5063882700714],[1993.3427032263598,-638.7199567533497],[2040.9422990525843,-808.7420308090176],[1939.3204724343334,-837.7042212885718]]},
    {id:'#774', index:1573, ref:13.094061127809423, da:30488.510547101498, lng:-75.67559505, lat:45.40859536, pts:[[-1717.8274173556724,900.7381991586143],[-1885.862828691958,801.4494196431879],[-1964.4784723352009,937.2753241937585],[-1797.4554288477746,1035.5731696973544]]}
  ];

  const status = document.getElementById('status');
  const tbody = document.getElementById('tbody');
  const summary = document.getElementById('summary');
  const runButton = document.getElementById('run');

  function edgeTs(ax, ay, bx, by, radius) {
    const dx = bx - ax, dy = by - ay;
    const A = dx * dx + dy * dy;
    if (A === 0) return [];
    const B = 2 * (ax * dx + ay * dy);
    const C = ax * ax + ay * ay - radius * radius;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return [];
    const s = Math.sqrt(disc);
    const t1 = (-B - s) / (2 * A);
    const t2 = (-B + s) / (2 * A);
    const out = [];
    if (t1 > 0 && t1 < 1) out.push(t1);
    if (t2 > 0 && t2 < 1 && Math.abs(t2 - t1) > 1e-12) out.push(t2);
    return out.sort((a,b) => a-b);
  }

  function edgeContribution(ax, ay, bx, by, radius) {
    const ts = [0, ...edgeTs(ax, ay, bx, by, radius), 1];
    let area = 0;
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i+1];
      const x0 = ax + (bx-ax)*t0, y0 = ay + (by-ay)*t0;
      const x1 = ax + (bx-ax)*t1, y1 = ay + (by-ay)*t1;
      const mx = (x0+x1)/2, my = (y0+y1)/2;
      if (mx*mx + my*my <= radius*radius) {
        area += (x0*y1 - x1*y0)/2;
      } else {
        area += radius*radius*Math.atan2(x0*y1-y0*x1, x0*x1+y0*y1)/2;
      }
    }
    return area;
  }

  function clipArea(ring, radius) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i+1)%ring.length];
      area += edgeContribution(a[0],a[1],b[0],b[1],radius);
    }
    return Math.abs(area);
  }

  function polygonArea(ring) {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i+1)%ring.length];
      area += a[0]*b[1] - b[0]*a[1];
    }
    return Math.abs(area/2);
  }

  function runCase(c) {
    const finite = c.pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!finite) throw new Error(`${c.id}: non-finite AEQD coordinate`);
    const t0 = performance.now();
    const daArea = polygonArea(c.pts);
    const intersectionArea = clipArea(c.pts, RADIUS);
    const ms = performance.now() - t0;
    const overlap = intersectionArea / daArea * 100;
    return {c, daArea, intersectionArea, overlap, diff: overlap - c.ref, ms};
  }

  runButton.addEventListener('click', () => {
    runButton.disabled = true;
    status.textContent = 'Running final AEQD validation — 6 cases...';
    setTimeout(() => {
      try {
        const rows = cases.map((c, i) => {
          status.textContent = `Case ${i+1}/6: ${c.id}`;
          return runCase(c);
        });
        const abs = rows.map(r => Math.abs(r.diff));
        const mean = abs.reduce((a,b) => a+b, 0) / abs.length;
        const max = Math.max(...abs);
        const mismatches = rows.filter(r => (r.overlap >= 15) !== (r.c.ref >= 15)).length;
        const pass = max <= 0.05 && mismatches === 0;
        summary.innerHTML = `<div class="summary"><b>Independent reference:</b> WGS84 geodesic / GeographicLib benchmark values. <b>Projection:</b> WGS84 AEQD centered on each store. <b>Same clipper:</b> true-circle polygon clipping. <b>Mean abs error:</b> ${mean.toFixed(6)} pp. <b>Max:</b> ${max.toFixed(6)} pp. <b>15% mismatches:</b> ${mismatches}. <b>Result:</b> ${pass ? 'PASS' : 'FAIL — investigate before production'}.</div>`;
        tbody.innerHTML = rows.map(r => `<tr>
          <td>${r.c.id}</td><td>${r.c.index}</td>
          <td>${r.c.ref.toFixed(6)}%</td>
          <td>${r.overlap.toFixed(6)}%</td>
          <td>${(r.diff>=0?'+':'')+r.diff.toFixed(6)} pp</td>
          <td class="${((r.overlap>=15)===(r.c.ref>=15))?'ok':'bad'}">${r.c.ref>=15?'YES':'NO'} / ${r.overlap>=15?'YES':'NO'}</td>
          <td>${r.ms.toFixed(3)} ms</td>
        </tr>`).join('');
        status.textContent = 'Final AEQD validation complete.';
      } catch (e) {
        status.textContent = 'ERROR: ' + (e && e.message ? e.message : String(e));
        console.error(e);
      } finally {
        runButton.disabled = false;
      }
    }, 0);
  });
})();

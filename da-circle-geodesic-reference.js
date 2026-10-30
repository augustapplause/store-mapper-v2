(() => {
  'use strict';

  const R = 6371008.8;
  const BENCHMARK_VERSION = 'v11';
  const cases = [
    {id:'#549', index:10800, lng:-79.59694983, lat:43.55434149, radiusKm:2},
    {id:'#568', index:11045, lng:-80.22940369, lat:43.56255375, radiusKm:2},
    {id:'#57', index:6459, lng:-79.49235852, lat:43.66470299, radiusKm:2},
    {id:'#969', index:1193, lng:-75.82032394, lat:45.33785755, radiusKm:2},
    {id:'#653', index:8137, lng:-79.33125549, lat:43.67975022, radiusKm:2},
    {id:'#774', index:1573, lng:-75.67559505, lat:45.40859536, radiusKm:2}
  ];

  const els = {
    status: document.getElementById('status'),
    run: document.getElementById('run'),
    tbody: document.getElementById('tbody'),
    summary: document.getElementById('summary')
  };

  function decodeVarints(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const out=[]; let value=0, shift=0;
    for (const b of bytes) {
      value |= (b & 0x7f) << shift;
      if (b < 0x80) {
        out.push((value >>> 1) ^ -(value & 1));
        value=0; shift=0;
      } else shift += 7;
    }
    if (shift !== 0) throw new Error('Corrupt varint stream');
    return out;
  }

  function decodeGeometry(record, scale) {
    const nums = decodeVarints(record.g);
    let pos=0, x=0, y=0;
    const rings=[];
    for (let ri=0; ri<record.r.length; ri++) {
      const count=Number(record.r[ri]);
      const ring=[];
      if (ri===0) { x=nums[pos++]; y=nums[pos++]; }
      else { x+=nums[pos++]; y+=nums[pos++]; }
      ring.push([x/scale,y/scale]);
      for(let i=1;i<count;i++) {
        x+=nums[pos++]; y+=nums[pos++];
        ring.push([x/scale,y/scale]);
      }
      rings.push(ring);
    }
    if (Number(record.t)===1) {
      const polys=[]; let ro=0;
      for(const n0 of record.p) {
        const n=Number(n0); polys.push(rings.slice(ro,ro+n)); ro+=n;
      }
      return {type:'MultiPolygon', coordinates:polys};
    }
    return {type:'Polygon', coordinates:rings};
  }

  function segmentCircleTs(ax,ay,bx,by,r) {
    const dx=bx-ax, dy=by-ay, A=dx*dx+dy*dy;
    if(A===0) return [];
    const B=2*(ax*dx+ay*dy), C=ax*ax+ay*ay-r*r;
    const disc=B*B-4*A*C;
    if(disc<=0) return [];
    const sd=Math.sqrt(disc);
    const t1=(-B-sd)/(2*A), t2=(-B+sd)/(2*A);
    const out=[];
    if(t1>0 && t1<1) out.push(t1);
    if(t2>0 && t2<1 && Math.abs(t2-t1)>1e-12) out.push(t2);
    return out.sort((a,b)=>a-b);
  }

  function edgeContribution(ax,ay,bx,by,r) {
    const ts=[0,...segmentCircleTs(ax,ay,bx,by,r),1];
    let area=0;
    for(let i=0;i<ts.length-1;i++) {
      const t0=ts[i], t1=ts[i+1];
      const x0=ax+(bx-ax)*t0, y0=ay+(by-ay)*t0;
      const x1=ax+(bx-ax)*t1, y1=ay+(by-ay)*t1;
      const mx=(x0+x1)/2, my=(y0+y1)/2;
      if(mx*mx+my*my<=r*r) area += (x0*y1-x1*y0)/2;
      else area += (r*r*Math.atan2(x0*y1-y0*x1,x0*x1+y0*y1))/2;
    }
    return area;
  }

  function ringCircleArea(ring, centerLng, centerLat, radiusM) {
    const lonScale=Math.PI/180*R*Math.cos(centerLat*Math.PI/180);
    const latScale=Math.PI/180*R;
    let total=0;
    for(let i=0;i<ring.length;i++) {
      const a=ring[i], b=ring[(i+1)%ring.length];
      total += edgeContribution(
        (a[0]-centerLng)*lonScale,
        (a[1]-centerLat)*latScale,
        (b[0]-centerLng)*lonScale,
        (b[1]-centerLat)*latScale,
        radiusM
      );
    }
    return total;
  }

  function planarRingArea(ring, centerLng, centerLat) {
    const lonScale=Math.PI/180*R*Math.cos(centerLat*Math.PI/180);
    const latScale=Math.PI/180*R;
    let area=0;
    const pts=ring.map(([x,y])=>[(x-centerLng)*lonScale,(y-centerLat)*latScale]);
    for(let i=0;i<pts.length;i++) {
      const a=pts[i], b=pts[(i+1)%pts.length];
      area += a[0]*b[1]-b[0]*a[1];
    }
    return Math.abs(area/2);
  }

  function customAreaAndRatio(geom, centerLng, centerLat, radiusM) {
    const calcPoly = poly => {
      const da = poly.coordinates.reduce((sum, ring) => sum + planarRingArea(ring,centerLng,centerLat),0);
      const ia = poly.coordinates.reduce((sum, ring, i) => sum + (i===0?1:-1)*Math.abs(ringCircleArea(ring,centerLng,centerLat,radiusM)),0);
      return {da, ia:Math.max(0,ia)};
    };
    if(geom.type==='Polygon') {
      const r=calcPoly({coordinates:[geom.coordinates[0],...geom.coordinates.slice(1)]});
      const daOuter=planarRingArea(geom.coordinates[0],centerLng,centerLat);
      const daHoles=geom.coordinates.slice(1).reduce((s,r)=>s+planarRingArea(r,centerLng,centerLat),0);
      return {da:Math.max(0,daOuter-daHoles), ia:r.ia, pct:daOuter>0?100*r.ia/Math.max(1,daOuter-daHoles):0};
    }
    let da=0, ia=0;
    for(const poly of geom.coordinates) {
      const outer=planarRingArea(poly[0],centerLng,centerLat);
      const holes=poly.slice(1).reduce((s,r)=>s+planarRingArea(r,centerLng,centerLat),0);
      da += Math.max(0,outer-holes);
      ia += Math.max(0,Math.abs(ringCircleArea(poly[0],centerLng,centerLat,radiusM))-poly.slice(1).reduce((s,r)=>s+Math.abs(ringCircleArea(r,centerLng,centerLat,radiusM)),0));
    }
    return {da,ia,pct:da>0?100*ia/da:0};
  }

  // Independent references are precomputed offline with:
  // WGS84 Geodesic.Direct circle vertices (65,536 points),
  // Lambert azimuthal equal-area projection, Shapely intersection,
  // and GeographicLib WGS84 polygon area. They do not use Turf or the
  // production custom clipping routine.
  const reference = {
    // Independent WGS84 geodesic reference: 65,536-point geodesic circle,
    // local Lambert azimuthal equal-area intersection, GeographicLib area.
    '#549': {ratio:26.686356354034093, area:95.21967662069159, intersection:25.410662222156645},
    '#568': {ratio:14.065190767369101, area:140132.25375621996, intersection:19709.86881742609},
    '#57': {ratio:13.578490655999651, area:166154.29049492133, intersection:22561.244809395408},
    '#969': {ratio:13.474527429872376, area:84061.12045153044, intersection:11326.838733099527},
    '#653': {ratio:12.87399514795201, area:46321.55073488683, intersection:5963.434194065459},
    '#774': {ratio:13.094061127809423, area:30488.510547101498, intersection:3992.184209627283}
  };

  const embedded = {
    coordinate_scale: 10000000,
    geometry_records: {"10800":{"b":[-796013006,435719940,-796011376,435721831],"g":"o7mR9wXM2cSfA8QLwR27GaIU+A2gCQ==","r":[4],"p":[1],"t":0},"11045":{"b":[-802506220,435471862,-802430838,435524357],"g":"6/2g/QXo3aafA/l/+0XnyAKef4nRBdxi0F2k0gSUqQbbvQT86gGrUIwomWA=","r":[8],"p":[1],"t":0},"6459":{"b":[-795161787,436502606,-795089343,436580372],"g":"oeen9gXOk62gA+KTAsONBIbRA/vpAbqbAbf1Ar+QArwb3bMC9UDXpwSKvwnU6wHXLA==","r":[8],"p":[1],"t":0},"1193":{"b":[-758014115,453468605,-757971066,453514220],"g":"3+bv0gW0vb+wA+qEApuEBPmXAp0y54QB1NMB7z+dEfvDAZzBAqSyAYrFAcDpAaGSAQ==","r":[8],"p":[1],"t":0},"8137":{"b":[-793090753,436715103,-793059480,436744689],"g":"naqq9AWSob6gA82tAdEnlZMB5tMBopoCvPoBnnK5SZBcj+8B88QB1yiIHa1F","r":[8],"p":[1],"t":0},"1573":{"b":[-757006930,454158039,-756975416,454179108],"g":"75z00QWEp5CxA6/PAtOLAYGdAfa+Aa7NAqKKAYSfAcO9AQ==","r":[5],"p":[1],"t":0}}
  };

  async function run() {
    els.run.disabled = true;
    els.status.textContent = `${BENCHMARK_VERSION}: Running independent geodesic validation — 6 cases…`;
    await new Promise(r => setTimeout(r, 0));
    const t0 = performance.now();
    const rows = [];
    for (const c of cases) {
      els.status.textContent = `Case ${c.id}: decoding geometry and calculating custom true-circle result…`;
      await new Promise(r => setTimeout(r, 0));
      const geom = decodeGeometry(embedded.geometry_records[String(c.index)], embedded.coordinate_scale || 1e7);
      const custom = customAreaAndRatio(geom, c.lng, c.lat, c.radiusKm * 1000);
      const ref = reference[c.id];
      rows.push({ c, custom, ref, diff: custom.pct - ref.ratio, decisionCustom: custom.pct >= 15, decisionRef: ref.ratio >= 15 });
    }
    const elapsed = performance.now() - t0;
    const abs = rows.map(r => Math.abs(r.diff));
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const max = Math.max(...abs);
    const mismatches = rows.filter(r => r.decisionCustom !== r.decisionRef).length;
    const pass = mean <= 0.05 && max <= 0.10 && mismatches === 0;

    els.summary.innerHTML = `
      <div class="summary-grid">
        <div><b>Independent reference</b><span>WGS84 geodesic / LAEA / independent precomputed values</span></div>
        <div><b>Cases</b><span>${rows.length}</span></div>
        <div><b>Mean abs error</b><span>${mean.toFixed(6)} pp</span></div>
        <div><b>Max abs error</b><span>${max.toFixed(6)} pp</span></div>
        <div><b>15% decision mismatches</b><span>${mismatches}</span></div>
        <div><b>Custom compute time</b><span>${elapsed.toFixed(1)} ms</span></div>
        <div class="result ${pass ? 'pass' : 'fail'}"><b>Validation</b><span>${pass ? 'PASS' : 'FAIL — investigate geometry before production'}</span></div>
      </div>`;

    els.tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.c.id}</td>
        <td>${r.c.index}</td>
        <td>${r.ref.ratio.toFixed(6)}%</td>
        <td>${r.custom.pct.toFixed(6)}%</td>
        <td>${r.diff.toFixed(6)} pp</td>
        <td>${r.ref.intersection.toFixed(3)} m²</td>
        <td>${r.custom.ia.toFixed(3)} m²</td>
        <td class="${r.decisionCustom === r.decisionRef ? 'ok' : 'bad'}">${r.decisionRef ? 'YES' : 'NO'} / ${r.decisionCustom ? 'YES' : 'NO'}</td>
      </tr>`).join('');

    const worst = rows.slice().sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff))[0];
    els.status.textContent = `${BENCHMARK_VERSION}: Validation complete. Worst case: ${worst.c.id} (${worst.diff.toFixed(6)} pp).`;
    els.run.disabled = false;
  }

  els.run.addEventListener('click',()=>run().catch(e=>{els.status.textContent=`ERROR: ${e.message}`;els.run.disabled=false;}));
})();

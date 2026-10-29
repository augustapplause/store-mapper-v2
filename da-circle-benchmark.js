(() => {
  'use strict';

  const ASSETS = {
    AB:'AB_da_spatial_asset_v1.json', BC:'BC_da_spatial_asset_v1.json', MB:'MB_da_spatial_asset_v1.json',
    NB:'NB_da_spatial_asset_v1.json', NL:'NL_da_spatial_asset_v1.json', NS:'NS_da_spatial_asset_v1.json',
    NT:'NT_da_spatial_asset_v1.json', NU:'NU_da_spatial_asset_v1.json', ON:'ON_da_spatial_asset_v1.json',
    PE:'PE_da_spatial_asset_v1.json', QC:'QC_da_spatial_asset_v1.json', SK:'SK_da_spatial_asset_v1.json',
    YT:'YT_da_spatial_asset_v1.json'
  };

  const els = {
    province: document.getElementById('province'),
    pairs: document.getElementById('pairs'),
    radius: document.getElementById('radius'),
    seed: document.getElementById('seed'),
    run: document.getElementById('run'),
    status: document.getElementById('status'),
    results: document.getElementById('results')
  };

  for (const code of Object.keys(ASSETS)) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = code;
    els.province.appendChild(o);
  }
  els.province.value = 'ON';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function degToRad(v) { return v * Math.PI / 180; }
  function radToDeg(v) { return v * 180 / Math.PI; }

  function makeRng(seed) {
    let s = (Number(seed) >>> 0) || 1;
    return () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) / 4294967296);
    };
  }

  function decodeVarints(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const out = [];
    let value = 0, shift = 0;
    for (const b of bytes) {
      value |= (b & 0x7f) << shift;
      if (b < 0x80) {
        const signed = (value >>> 1) ^ -(value & 1);
        out.push(signed);
        value = 0; shift = 0;
      } else {
        shift += 7;
      }
    }
    if (shift !== 0) throw new Error('Corrupt varint stream');
    return out;
  }

  function decodeGeometry(record, scale) {
    const nums = decodeVarints(record.g);
    const pointCount = record.r.reduce((a,b) => a + Number(b || 0), 0);
    if (nums.length !== pointCount * 2) throw new Error('Geometry length mismatch');
    let pos = 0, x = 0, y = 0;
    const rings = [];
    for (let ringIndex = 0; ringIndex < record.r.length; ringIndex++) {
      const count = Number(record.r[ringIndex]);
      const ring = [];
      if (ringIndex === 0) { x = nums[pos++]; y = nums[pos++]; }
      else { x += nums[pos++]; y += nums[pos++]; }
      ring.push([x / scale, y / scale]);
      for (let i=1; i<count; i++) { x += nums[pos++]; y += nums[pos++]; ring.push([x/scale,y/scale]); }
      rings.push(ring);
    }
    if (record.t === 1) {
      const polys=[]; let ro=0;
      for (const n of record.p) { const c=Number(n); polys.push(rings.slice(ro,ro+c)); ro+=c; }
      return {type:'MultiPolygon',coordinates:polys};
    }
    return {type:'Polygon',coordinates:rings};
  }

  function bboxRecord(record, scale) {
    return [record.b[0]/scale, record.b[1]/scale, record.b[2]/scale, record.b[3]/scale];
  }

  function bboxQuery(asset, bbox) {
    const tree=asset.spatial_index;
    if(!tree?.levels?.length) return [];
    const scale=asset.coordinate_scale || 1e7;
    const q=[bbox[0]*scale,bbox[1]*scale,bbox[2]*scale,bbox[3]*scale];
    const intersects=n=>n.b[0]<=q[2]&&n.b[2]>=q[0]&&n.b[1]<=q[3]&&n.b[3]>=q[1];
    let nodes=tree.levels[tree.root_level]||[];
    for(let level=tree.root_level;level>=0;level--){
      const next=[];
      for(const node of nodes){
        if(!intersects(node)) continue;
        if(level===0){ for(const index of (node.c||[])) next.push(Number(index)); }
        else {
          const childLevel=tree.levels[level-1]||[];
          for(const index of (node.c||[])){ const child=childLevel[Number(index)]; if(child) next.push(child); }
        }
      }
      if(level===0) return [...new Set(next)];
      nodes=next;
    }
    return [];
  }

  function ringBbox(ring) {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of ring){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}
    return [minX,minY,maxX,maxY];
  }

  function bboxOutsideCircle(b, cx, cy, r) {
    const nx=clamp(cx,b[0],b[2]), ny=clamp(cy,b[1],b[3]);
    return (nx-cx)*(nx-cx)+(ny-cy)*(ny-cy) > r*r;
  }

  function bboxInsideCircle(b, cx, cy, r) {
    const pts=[[b[0],b[1]],[b[0],b[3]],[b[2],b[1]],[b[2],b[3]]];
    for(const [x,y] of pts) if((x-cx)*(x-cx)+(y-cy)*(y-cy)>r*r) return false;
    return true;
  }

  // Exact planar polygon/circle clipping-area algorithm.
  // Each polygon edge is split at circle crossings. Inside subsegments contribute
  // triangle area; outside subsegments contribute the corresponding circle sector.
  function segmentCircleTs(ax, ay, bx, by, r) {
    const dx=bx-ax, dy=by-ay;
    const A=dx*dx+dy*dy;
    if(A===0) return [];
    const B=2*(ax*dx+ay*dy);
    const C=ax*ax+ay*ay-r*r;
    const disc=B*B-4*A*C;
    if(disc<=0) return [];
    const sd=Math.sqrt(disc);
    const t1=(-B-sd)/(2*A), t2=(-B+sd)/(2*A);
    const out=[];
    if(t1>0 && t1<1) out.push(t1);
    if(t2>0 && t2<1 && Math.abs(t2-t1)>1e-12) out.push(t2);
    return out.sort((a,b)=>a-b);
  }

  function edgeContribution(ax, ay, bx, by, r) {
    const ts=[0,...segmentCircleTs(ax,ay,bx,by,r),1];
    let area=0;
    for(let i=0;i<ts.length-1;i++){
      const t0=ts[i], t1=ts[i+1];
      const x0=ax+(bx-ax)*t0, y0=ay+(by-ay)*t0;
      const x1=ax+(bx-ax)*t1, y1=ay+(by-ay)*t1;
      const mx=(x0+x1)/2, my=(y0+y1)/2;
      if(mx*mx+my*my <= r*r){
        area += (x0*y1-x1*y0)/2;
      } else {
        let ang=Math.atan2(x0*y1-y0*x1, x0*x1+y0*y1);
        area += (r*r*ang)/2;
      }
    }
    return area;
  }

  function planarRingSignedArea(ring) {
    let a=0;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) a += ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];
    return a/2;
  }

  function ringCircleIntersectionArea(ring, cx, cy, r, centerLatRad) {
    const lonScale=Math.PI/180 * 6371008.8 * Math.cos(centerLatRad);
    const latScale=Math.PI/180 * 6371008.8;
    let total=0;
    for(let i=0;i<ring.length;i++){
      const a=ring[i], b=ring[(i+1)%ring.length];
      const ax=(a[0]-cx)*lonScale, ay=(a[1]-cy)*latScale;
      const bx=(b[0]-cx)*lonScale, by=(b[1]-cy)*latScale;
      total += edgeContribution(ax,ay,bx,by,r);
    }
    return total;
  }

  function customIntersectionArea(geom, cx, cy, radiusMeters) {
    const centerLatRad=degToRad(cy);
    let total=0;
    const ringArea=(ring, sign)=>{
      const local=ringCircleIntersectionArea(ring,cx,cy,radiusMeters,centerLatRad);
      return sign>=0 ? Math.abs(local) : -Math.abs(local);
    };
    if(geom.type==='Polygon'){
      if(!geom.coordinates.length) return 0;
      total += ringArea(geom.coordinates[0],1);
      for(let i=1;i<geom.coordinates.length;i++) total += ringArea(geom.coordinates[i],-1);
    } else if(geom.type==='MultiPolygon'){
      for(const poly of geom.coordinates){
        if(!poly.length) continue;
        total += ringArea(poly[0],1);
        for(let i=1;i<poly.length;i++) total += ringArea(poly[i],-1);
      }
    }
    return Math.max(0,total);
  }

  function localCircleFeature(lng, lat, radiusKm) {
    return turf.circle([lng,lat], radiusKm, {units:'kilometers', steps:96});
  }

  function circleBBox(lng, lat, radiusKm) {
    const circle=localCircleFeature(lng,lat,radiusKm);
    return turf.bbox(circle);
  }

  function candidateInsideBBox(record, bbox, scale) {
    return false;
  }

  function samplePairs(asset, count, radiusKm, seed) {
    const rng=makeRng(seed);
    const scale=asset.coordinate_scale||1e7;
    const n=asset.feature_count;
    const pairs=[];
    const maxAttempts=count*12;
    let attempts=0;
    while(pairs.length<count && attempts<maxAttempts){
      attempts++;
      const idx=Math.floor(rng()*n);
      const rec=asset.geometry_records[idx];
      if(!rec?.b) continue;
      const b=bboxRecord(rec,scale);
      const lon=(b[0]+b[2])/2 + (rng()-0.5)*(b[2]-b[0])*2.5;
      const lat=(b[1]+b[3])/2 + (rng()-0.5)*(b[3]-b[1])*2.5;
      if(!Number.isFinite(lon)||!Number.isFinite(lat)) continue;
      pairs.push({idx,lng:lon,lat,radiusKm});
    }
    return pairs;
  }

  function pctCell(v) { return `${(v*100).toFixed(4)}%`; }

  async function loadAsset(code){
    const t0=performance.now();
    const res=await fetch(ASSETS[code], {cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status} for ${ASSETS[code]}`);
    const asset=await res.json();
    asset.__loadMs=performance.now()-t0;
    return asset;
  }

  function exactPair(asset, pair, method) {
    const scale=asset.coordinate_scale||1e7;
    const rec=asset.geometry_records[pair.idx];
    const b=bboxRecord(rec,scale);
    const cb=circleBBox(pair.lng,pair.lat,pair.radiusKm);
    if(b[2]<cb[0]||b[0]>cb[2]||b[3]<cb[1]||b[1]>cb[3]) return {area:0,pct:0,stage:'bbox-reject'};
    const corners=[[b[0],b[1]],[b[0],b[3]],[b[2],b[1]],[b[2],b[3]]];
    const bboxInside=corners.every(([lng,lat])=>turf.distance([pair.lng,pair.lat],[lng,lat],{units:'kilometers'}) <= pair.radiusKm + 1e-7);
    if(bboxInside) return {area:null,pct:100,stage:'bbox-inside'};
    const geom=decodeGeometry(rec,scale);
    const daFeature={type:'Feature',properties:{},geometry:geom};
    if(method==='turf'){
      const circle=localCircleFeature(pair.lng,pair.lat,pair.radiusKm);
      const inter=turf.intersect(turf.featureCollection([daFeature,circle]));
      if(!inter) return {area:0,pct:0,stage:'exact'};
      const area=turf.area(inter);
      const daArea=turf.area(daFeature);
      return {area,pct:daArea>0?area/daArea*100:0,stage:'exact'};
    }
    const radiusMeters=pair.radiusKm*1000;
    const area=customIntersectionArea(geom,pair.lng,pair.lat,radiusMeters);
    const daArea=turf.area(daFeature);
    return {area,pct:daArea>0?area/daArea*100:0,stage:'exact'};
  }

  async function run(){
    els.run.disabled=true;
    els.results.innerHTML='';
    try{
      if(typeof turf==='undefined') throw new Error('Turf failed to load.');
      const code=els.province.value;
      const count=Number(els.pairs.value);
      const radiusKm=Number(els.radius.value);
      const seed=Number(els.seed.value)||12345;
      els.status.textContent=`Loading ${code} asset…`;
      const asset=await loadAsset(code);
      els.status.textContent=`Loaded ${asset.feature_count.toLocaleString()} DAs in ${asset.__loadMs.toFixed(1)} ms. Generating ${count.toLocaleString()} sample pairs…`;
      const pairs=samplePairs(asset,count,radiusKm,seed);
      if(pairs.length<count) throw new Error(`Only generated ${pairs.length} pairs.`);
      await new Promise(r=>setTimeout(r,0));

      const stages={turf:{bboxReject:0,bboxInside:0,exact:0},custom:{bboxReject:0,bboxInside:0,exact:0}};
      const diffs=[];
      let mismatches=0;

      const t0=performance.now();
      const turfResults=new Array(pairs.length);
      for(let i=0;i<pairs.length;i++){
        const r=exactPair(asset,pairs[i],'turf');
        turfResults[i]=r;
        stages.turf[r.stage]++;
      }
      const turfMs=performance.now()-t0;

      await new Promise(r=>setTimeout(r,0));
      const t1=performance.now();
      const customResults=new Array(pairs.length);
      let maxDiff=0, sumDiff=0;
      for(let i=0;i<pairs.length;i++){
        const r=exactPair(asset,pairs[i],'custom');
        customResults[i]=r;
        stages.custom[r.stage]++;
        const a=turfResults[i].pct, b=r.pct;
        const diff=Math.abs(a-b);
        diffs.push(diff); sumDiff+=diff; maxDiff=Math.max(maxDiff,diff);
        const turfSel=a>=15, customSel=b>=15;
        if(turfSel!==customSel) mismatches++;
      }
      const customMs=performance.now()-t1;
      const meanDiff=sumDiff/pairs.length;

      const rows=[
        ['Asset load',`${asset.__loadMs.toFixed(1)} ms`,`${asset.feature_count.toLocaleString()} DAs`],
        ['Sample pairs',pairs.length.toLocaleString(),`${radiusKm} km radius`],
        ['Turf total',`${turfMs.toFixed(1)} ms`,`exact ${stages.turf.exact.toLocaleString()}`],
        ['Custom total',`${customMs.toFixed(1)} ms`,`exact ${stages.custom.exact.toLocaleString()}`],
        ['Speedup',customMs>0?(turfMs/customMs).toFixed(2)+'×':'—',customMs<turfMs?'custom faster':'custom slower'],
        ['Mean abs overlap error',`${meanDiff.toFixed(4)} percentage points`,'Turf vs custom'],
        ['Max abs overlap error',`${maxDiff.toFixed(4)} percentage points`,'Turf vs custom'],
        ['15% selection mismatches',mismatches.toLocaleString(),mismatches===0?'exactly matched':'needs investigation']
      ];
      els.results.innerHTML=`<table><thead><tr><th>Metric</th><th>Result</th><th>Notes</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td class="${r[0].includes('mismatch')&&mismatches===0?'good':''}">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>`;
      els.status.textContent='Benchmark complete.';
    }catch(err){
      console.error(err);
      els.status.textContent='ERROR: '+(err?.stack||err?.message||String(err));
    }finally{ els.run.disabled=false; }
  }

  els.run.addEventListener('click',run);
  els.status.textContent='Ready. Choose a province/sample size and run the benchmark.';
})();

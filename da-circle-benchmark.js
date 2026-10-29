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
    mode: document.getElementById('mode'),
    pairs: document.getElementById('pairs'),
    edgeWindow: document.getElementById('edgeWindow'),
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

  function bboxMeters(record, scale, centerLatDeg) {
    const b=bboxRecord(record,scale);
    const latScale=111320;
    const lonScale=111320*Math.max(0.15,Math.cos(degToRad(centerLatDeg)));
    return {
      width:(b[2]-b[0])*lonScale,
      height:(b[3]-b[1])*latScale,
      bbox:b
    };
  }

  function offsetLngLat(lng,lat,eastMeters,northMeters){
    const latRad=degToRad(lat);
    const lonMetersPerDeg=111320*Math.max(0.15,Math.cos(latRad));
    return {
      lng:lng + eastMeters/lonMetersPerDeg,
      lat:lat + northMeters/111320
    };
  }

  function turfOverlapPctFromGeom(geom, daArea, pair) {
    const daFeature={type:'Feature',properties:{},geometry:geom};
    const circle=localCircleFeature(pair.lng,pair.lat,pair.radiusKm);
    const inter=turf.intersect(turf.featureCollection([daFeature,circle]));
    if(!inter) return 0;
    const area=turf.area(inter);
    return daArea>0 ? area/daArea*100 : 0;
  }

  function findCrossingOnRay(geom, daArea, start, angleRad, radiusKm, targetPct, maxDistanceMeters) {
    const radiusMeters=radiusKm*1000;
    const dirX=Math.cos(angleRad), dirY=Math.sin(angleRad);
    let lo=0;
    let hi=maxDistanceMeters;
    const startPct=turfOverlapPctFromGeom(geom,daArea,{lng:start.lng,lat:start.lat,radiusKm});
    if(startPct < targetPct) return null;

    let endPoint=offsetLngLat(start.lng,start.lat,dirX*hi,dirY*hi);
    let endPct=turfOverlapPctFromGeom(geom,daArea,{lng:endPoint.lng,lat:endPoint.lat,radiusKm});
    let expand=0;
    while(endPct >= targetPct && expand<8){
      hi*=2;
      endPoint=offsetLngLat(start.lng,start.lat,dirX*hi,dirY*hi);
      endPct=turfOverlapPctFromGeom(geom,daArea,{lng:endPoint.lng,lat:endPoint.lat,radiusKm});
      expand++;
    }
    if(endPct >= targetPct) return null;

    for(let i=0;i<28;i++){
      const mid=(lo+hi)/2;
      const pt=offsetLngLat(start.lng,start.lat,dirX*mid,dirY*mid);
      const pct=turfOverlapPctFromGeom(geom,daArea,{lng:pt.lng,lat:pt.lat,radiusKm});
      if(pct>=targetPct) lo=mid;
      else hi=mid;
    }
    const dist=(lo+hi)/2;
    const pt=offsetLngLat(start.lng,start.lat,dirX*dist,dirY*dist);
    const pct=turfOverlapPctFromGeom(geom,daArea,{lng:pt.lng,lat:pt.lat,radiusKm});
    return {pair:{lng:pt.lng,lat:pt.lat,radiusKm},pct,distanceMeters:dist};
  }

  async function findEdgePairs(asset, count, radiusKm, seed, windowPctPoints) {
    const rng=makeRng(seed);
    const scale=asset.coordinate_scale||1e7;
    const n=asset.feature_count;
    const pairs=[];
    const screenedResults=[];
    const target=15;
    const targetMin=target-windowPctPoints;
    const targetMax=target+windowPctPoints;
    let attempts=0;
    let exactTests=0;
    const maxAttempts=Math.max(count*8, 5000);

    while(pairs.length<count && attempts<maxAttempts){
      attempts++;
      const idx=Math.floor(rng()*n);
      const rec=asset.geometry_records[idx];
      if(!rec?.b) continue;
      const scaleValue=asset.coordinate_scale||1e7;
      const geom=decodeGeometry(rec,scaleValue);
      const daFeature={type:'Feature',properties:{},geometry:geom};
      const daArea=turf.area(daFeature);
      if(!(daArea>0)) continue;

      const start=turf.pointOnFeature(daFeature).geometry.coordinates;
      if(!Array.isArray(start)||start.length<2) continue;
      const startPt={lng:Number(start[0]),lat:Number(start[1])};
      if(!Number.isFinite(startPt.lng)||!Number.isFinite(startPt.lat)) continue;

      const bm=bboxMeters(rec,scaleValue,startPt.lat);
      const maxDistance=Math.max(10000,Math.hypot(bm.width,bm.height)+radiusKm*2000);
      let found=null;

      // Try several outward rays.  Starting from an interior point means the
      // overlap is typically above 15%; moving outward forces a deliberate
      // crossing of the decision boundary.
      const rays=[
        rng()*Math.PI*2, rng()*Math.PI*2, rng()*Math.PI*2, rng()*Math.PI*2,
        0, Math.PI/2, Math.PI, 3*Math.PI/2
      ];
      for(const angle of rays){
        const crossing=findCrossingOnRay(geom,daArea,startPt,angle,radiusKm,target,maxDistance);
        exactTests += 30;
        if(crossing && crossing.pct>=targetMin && crossing.pct<=targetMax){
          found=crossing;
          break;
        }
      }
      if(!found) continue;

      pairs.push({idx,lng:found.pair.lng,lat:found.pair.lat,radiusKm});
      screenedResults.push({stage:'exact',pct:found.pct});
      if(pairs.length===1 || pairs.length%10===0){
        els.status.textContent=`Constructing 15% edge cases: ${pairs.length.toLocaleString()} / ${count.toLocaleString()} (${attempts.toLocaleString()} DAs tried)…`;
        await new Promise(r=>setTimeout(r,0));
      }
    }
    return {pairs, screenedResults, attempts, exactTests, targetMin, targetMax};
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


  function geometryVertexCount(geom){
    if(!geom) return 0;
    if(geom.type==='Polygon') return geom.coordinates.reduce((n,r)=>n+Math.max(0,(r?.length||0)-1),0);
    if(geom.type==='MultiPolygon') return geom.coordinates.reduce((n,p)=>n+p.reduce((m,r)=>m+Math.max(0,(r?.length||0)-1),0),0);
    return 0;
  }

  function localProject(lng, lat, cx, cy){
    const R=6371008.8, lat0=degToRad(cy);
    return [degToRad(lng-cx)*R*Math.cos(lat0), degToRad(lat-cy)*R];
  }

  function diagnosticSvg(geom, pair, width=700, height=430){
    const pts=[];
    function addRing(ring){ for(const pt of ring) pts.push(localProject(pt[0],pt[1],pair.lng,pair.lat)); }
    if(geom.type==='Polygon') geom.coordinates.forEach(addRing);
    else if(geom.type==='MultiPolygon') geom.coordinates.forEach(poly=>poly.forEach(addRing));
    const r=pair.radiusKm*1000;
    pts.push([-r,-r],[r,r]);
    let minX=Math.min(...pts.map(p=>p[0])), maxX=Math.max(...pts.map(p=>p[0]));
    let minY=Math.min(...pts.map(p=>p[1])), maxY=Math.max(...pts.map(p=>p[1]));
    const pad=Math.max(50, r*0.15); minX-=pad; maxX+=pad; minY-=pad; maxY+=pad;
    const sx=x=>40+(x-minX)/(maxX-minX)*(width-70);
    const sy=y=>height-30-(y-minY)/(maxY-minY)*(height-60);
    const pathForRing=ring=>ring.map((pt,i)=>{ const [x,y]=localProject(pt[0],pt[1],pair.lng,pair.lat); return `${i?'L':'M'} ${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`; }).join(' ')+' Z';
    let paths='';
    if(geom.type==='Polygon') paths=geom.coordinates.map(pathForRing).join(' ');
    else paths=geom.coordinates.map(poly=>poly.map(pathForRing).join(' ')).join(' ');
    const cx=sx(0), cy=sy(0), rx=Math.abs(sx(r)-sx(0)), ry=Math.abs(sy(r)-sy(0));
    return `<svg viewBox="0 0 ${width} ${height}" class="diag-svg" role="img" aria-label="Mismatch geometry diagnostic"><rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/><path d="${paths}" fill="#b9d8e4" fill-opacity="0.55" stroke="#244a5c" stroke-width="1.4" fill-rule="evenodd"/><ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="#c62828" stroke-width="2"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="#c62828"/><text x="12" y="20" font-size="12" fill="#333">Red = 2 km circle · blue = DA polygon</text></svg>`;
  }

  function buildMismatchDetails(asset, mismatch, turfResult, customResult){
    const scale=asset.coordinate_scale||1e7;
    const rec=asset.geometry_records[mismatch.pair.idx];
    const geom=decodeGeometry(rec,scale);
    const b=bboxRecord(rec,scale);
    const daFeature={type:'Feature',properties:{},geometry:geom};
    const daArea=turf.area(daFeature);
    const turfArea=turfResult.area;
    const customArea=customResult.area;
    const vertexCount=geometryVertexCount(geom);
    const circleArea=Math.PI*Math.pow(mismatch.pair.radiusKm*1000,2);
    return `<section class="diagnostic"><h3>Mismatch diagnostic — pair #${mismatch.index+1}</h3><div class="diag-grid"><div><table><tbody>
      <tr><th>DA index</th><td>${mismatch.pair.idx}</td></tr>
      <tr><th>Geometry type</th><td>${geom.type}</td></tr>
      <tr><th>Vertex count</th><td>${vertexCount.toLocaleString()}</td></tr>
      <tr><th>Circle centre</th><td>${mismatch.pair.lng.toFixed(8)}, ${mismatch.pair.lat.toFixed(8)}</td></tr>
      <tr><th>Radius</th><td>${mismatch.pair.radiusKm.toFixed(3)} km</td></tr>
      <tr><th>DA bbox</th><td>[${b.map(v=>v.toFixed(8)).join(', ')}]</td></tr>
      <tr><th>DA area</th><td>${daArea.toFixed(3)} m²</td></tr>
      <tr><th>Circle area</th><td>${circleArea.toFixed(3)} m²</td></tr>
      <tr><th>Turf intersection area</th><td>${Number(turfArea).toFixed(3)} m²</td></tr>
      <tr><th>Custom intersection area</th><td>${Number(customArea).toFixed(3)} m²</td></tr>
      <tr><th>Area difference</th><td>${(Number(customArea)-Number(turfArea)).toFixed(3)} m²</td></tr>
    </tbody></table></div><div class="diag-visual">${diagnosticSvg(geom,mismatch.pair)}</div></div></section>`;
  }

  async function run(){
    els.run.disabled=true;
    els.results.innerHTML='';
    try{
      if(typeof turf==='undefined') throw new Error('Turf failed to load.');
      const code=els.province.value;
      const mode=els.mode.value;
      const count=Number(els.pairs.value);
      const radiusKm=Number(els.radius.value);
      const edgeWindow=Number(els.edgeWindow.value);
      const seed=Number(els.seed.value)||12345;
      els.status.textContent=`Loading ${code} asset…`;
      const asset=await loadAsset(code);
      let pairs=[];
      let edgeMeta=null;
      if(mode==='edge15'){
        els.status.textContent=`Loaded ${asset.feature_count.toLocaleString()} DAs in ${asset.__loadMs.toFixed(1)} ms. Searching for ${count.toLocaleString()} pairs within ±${edgeWindow} percentage points of 15%…`;
        edgeMeta=await findEdgePairs(asset,count,radiusKm,seed,edgeWindow);
        pairs=edgeMeta.pairs;
        if(pairs.length<count){
          throw new Error(`Only found ${pairs.length.toLocaleString()} edge-case pairs after ${edgeMeta.attempts.toLocaleString()} samples. Try a wider edge window or fewer pairs.`);
        }
      } else {
        els.status.textContent=`Loaded ${asset.feature_count.toLocaleString()} DAs in ${asset.__loadMs.toFixed(1)} ms. Generating ${count.toLocaleString()} sample pairs…`;
        pairs=samplePairs(asset,count,radiusKm,seed);
        if(pairs.length<count) throw new Error(`Only generated ${pairs.length} pairs.`);
      }
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
        ['Mode',mode==='edge15'?'15% edge cases':'Random',mode==='edge15'?`target ${edgeMeta.targetMin.toFixed(2)}%–${edgeMeta.targetMax.toFixed(2)}%`:`seed ${seed}`],
        ['Sample pairs',pairs.length.toLocaleString(),`${radiusKm} km radius`],
        ...(edgeMeta ? [['Edge-case search',`${edgeMeta.attempts.toLocaleString()} samples`,`exact ${edgeMeta.exactTests.toLocaleString()}`]] : []),
        ['Turf total',`${turfMs.toFixed(1)} ms`,`exact ${stages.turf.exact.toLocaleString()}`],
        ['Custom total',`${customMs.toFixed(1)} ms`,`exact ${stages.custom.exact.toLocaleString()}`],
        ['Speedup',customMs>0?(turfMs/customMs).toFixed(2)+'×':'—',customMs<turfMs?'custom faster':'custom slower'],
        ['Mean abs overlap error',`${meanDiff.toFixed(4)} percentage points`,'Turf vs custom'],
        ['Max abs overlap error',`${maxDiff.toFixed(4)} percentage points`,'Turf vs custom'],
        ['15% selection mismatches',mismatches.toLocaleString(),mismatches===0?'exactly matched':'needs investigation']
      ];
      let html=`<table><thead><tr><th>Metric</th><th>Result</th><th>Notes</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td class="${r[0].includes('mismatch')&&mismatches===0?'good':''}">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>`;
      if(mismatches>0){
        const mismatchRows=[];
        for(let i=0;i<pairs.length;i++){
          const a=turfResults[i].pct, b=customResults[i].pct;
          if((a>=15)!==(b>=15)) mismatchRows.push({index:i,a,b,diff:Math.abs(a-b),pair:pairs[i]});
        }
        mismatchRows.sort((x,y)=>y.diff-x.diff);
        html+=`<table><thead><tr><th>Mismatch pair</th><th>Turf overlap</th><th>Custom overlap</th><th>Abs error</th><th>Decision</th></tr></thead><tbody>${mismatchRows.slice(0,20).map(m=>`<tr><td>#${m.index+1}</td><td>${m.a.toFixed(6)}%</td><td>${m.b.toFixed(6)}%</td><td>${m.diff.toFixed(6)} pp</td><td>${m.a>=15?'Turf YES':'Turf NO'} / ${m.b>=15?'Custom YES':'Custom NO'}</td></tr>`).join('')}</tbody></table>`;
        for(const m of mismatchRows.slice(0,5)){
          html += buildMismatchDetails(asset,m,turfResults[m.index],customResults[m.index]);
        }
      }
      els.results.innerHTML=html;
      els.status.textContent='Benchmark complete.';
    }catch(err){
      console.error(err);
      els.status.textContent='ERROR: '+(err?.stack||err?.message||String(err));
    }finally{ els.run.disabled=false; }
  }

  els.run.addEventListener('click',run);
  els.status.textContent='Ready. Choose a province/sample size and run the benchmark.';
})();

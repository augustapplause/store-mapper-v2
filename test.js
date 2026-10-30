// Rectangle intersection benchmark v0.2. Cache-buster: 2026-10-30T10:56:00-0400\n'use strict';

const PROVINCES=['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];
const ASSET_FILES=Object.fromEntries(PROVINCES.map(p=>[p,`${p}_da_spatial_asset_v1.json`]));
const state={assets:new Map(),features:[],loaded:false};
const $=id=>document.getElementById(id);

function log(msg){ $('status').textContent=String(msg); }

function zigZagDecode(n){ return (n>>>1)^-(n&1); }
function decodeVarints(base64){
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const out=[]; let value=0; let shift=0;
  for(let i=0;i<bytes.length;i++){
    const b=bytes[i]; value|=(b&127)<<shift;
    if(b<128){out.push(zigZagDecode(value));value=0;shift=0;}
    else shift+=7;
  }
  return out;
}
function decodeGeometry(record,scale){
  if(!record)return null;
  const nums=decodeVarints(record.g);
  let pos=0,x=0,y=0;
  const allRings=[];
  for(let ringIndex=0;ringIndex<record.r.length;ringIndex++){
    const count=Number(record.r[ringIndex]); const ring=[];
    if(ringIndex===0){x=nums[pos++];y=nums[pos++];}
    else{x+=nums[pos++];y+=nums[pos++];}
    ring.push([x/scale,y/scale]);
    for(let i=1;i<count;i++){x+=nums[pos++];y+=nums[pos++];ring.push([x/scale,y/scale]);}
    allRings.push(ring);
  }
  if(Number(record.t)===1){
    const polygons=[];let off=0;
    for(const countRaw of record.p){const count=Number(countRaw);polygons.push(allRings.slice(off,off+count));off+=count;}
    return {type:'MultiPolygon',coordinates:polygons};
  }
  return {type:'Polygon',coordinates:allRings};
}

function geometryFeature(asset,index){
  const scale=asset.coordinate_scale||1e7;
  return {type:'Feature',properties:{},geometry:decodeGeometry(asset.geometry_records[index],scale)};
}

function bboxOfRecord(asset,index){
  const b=asset.geometry_records[index]?.b;if(!Array.isArray(b)||b.length!==4)return null;
  const s=asset.coordinate_scale||1e7;return [b[0]/s,b[1]/s,b[2]/s,b[3]/s];
}

// ---------- Candidate rectangle intersection routine ----------
function pointInRing(x,y,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    const crosses=((yi>y)!==(yj>y))&&(x < (xj-xi)*(y-yi)/(yj-yi||Number.EPSILON)+xi);
    if(crosses)inside=!inside;
  }
  return inside;
}
function orientation(a,b,c){
  const v=(b[1]-a[1])*(c[0]-b[0])-(b[0]-a[0])*(c[1]-b[1]);
  if(Math.abs(v)<1e-12)return 0; return v>0?1:2;
}
function onSegment(a,b,p){
  return p[0]>=Math.min(a[0],b[0])-1e-12&&p[0]<=Math.max(a[0],b[0])+1e-12&&p[1]>=Math.min(a[1],b[1])-1e-12&&p[1]<=Math.max(a[1],b[1])+1e-12;
}
function segmentsIntersect(a,b,c,d){
  const o1=orientation(a,b,c),o2=orientation(a,b,d),o3=orientation(c,d,a),o4=orientation(c,d,b);
  if(o1!==o2&&o3!==o4)return true;
  if(o1===0&&onSegment(a,b,c))return true;
  if(o2===0&&onSegment(a,b,d))return true;
  if(o3===0&&onSegment(c,d,a))return true;
  if(o4===0&&onSegment(c,d,b))return true;
  return false;
}
function ringBoundaryIntersectsRect(ring,rect){
  if(!Array.isArray(ring)||ring.length<2)return false;
  const [minX,minY,maxX,maxY]=rect;
  for(const p of ring){if(p[0]>=minX&&p[0]<=maxX&&p[1]>=minY&&p[1]<=maxY)return true;}
  const c=[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];
    for(let j=0;j<4;j++)if(segmentsIntersect(a,b,c[j],c[(j+1)%4]))return true;
  }
  return false;
}
function polygonIntersectsRect(rings,rect){
  if(!Array.isArray(rings)||!rings.length)return false;
  // Any polygon boundary crossing the viewport rectangle means a non-empty intersection.
  for(const ring of rings)if(ringBoundaryIntersectsRect(ring,rect))return true;
  // No boundary crosses: classify one point. With no boundary crossing, the entire
  // rectangle is in the same inside/outside state for this polygon.
  const [minX,minY,maxX,maxY]=rect;
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  if(!pointInRing(cx,cy,rings[0]))return false;
  for(let i=1;i<rings.length;i++)if(pointInRing(cx,cy,rings[i]))return false;
  return true;
}
function geometryIntersectsRect(geometry,rect){
  if(!geometry)return false;
  if(geometry.type==='Polygon')return polygonIntersectsRect(geometry.coordinates,rect);
  if(geometry.type==='MultiPolygon'){
    for(const rings of geometry.coordinates||[])if(polygonIntersectsRect(rings,rect))return true;
  }
  return false;
}

function bboxOverlaps(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];}

function provinceBbox(code){
  const asset=state.assets.get(code); if(!asset)return null;
  let out=null;
  for(let i=0;i<asset.geometry_records.length;i++){
    const b=bboxOfRecord(asset,i);if(!b)continue;
    if(!out)out=b.slice();else{out[0]=Math.min(out[0],b[0]);out[1]=Math.min(out[1],b[1]);out[2]=Math.max(out[2],b[2]);out[3]=Math.max(out[3],b[3]);}
  }
  return out;
}
function unionBbox(codes){
  let out=null;
  for(const code of codes){const b=provinceBbox(code);if(!b)continue;if(!out)out=b.slice();else{out[0]=Math.min(out[0],b[0]);out[1]=Math.min(out[1],b[1]);out[2]=Math.max(out[2],b[2]);out[3]=Math.max(out[3],b[3]);}}
  return out;
}
function provinceCodesForScope(){
  const s=$('scope').value;
  if(s==='all')return PROVINCES.slice();
  if(s==='ON')return ['ON']; if(s==='QC')return ['QC']; if(s==='ONQC')return ['ON','QC'];
  if(s==='ABBC')return ['AB','BC']; if(s==='MB SK')return ['MB','SK']; return PROVINCES.slice();
}
function rectPresets(codes){
  const u=unionBbox(codes); if(!u)return [];
  const [minX,minY,maxX,maxY]=u; const w=maxX-minX,h=maxY-minY;
  return [
    [minX,minY,maxX,maxY],
    [minX,minY,minX+w*0.58,minY+h*0.62],
    [minX+w*0.22,minY+h*0.18,minX+w*0.78,minY+h*0.84],
    [minX+w*0.42,minY+h*0.30,maxX,minY+h*0.78],
    [minX+w*0.38,minY+h*0.35,minX+w*0.62,minY+h*0.60]
  ];
}
function randomRects(codes,n){
  const u=unionBbox(codes);if(!u)return [];
  const [minX,minY,maxX,maxY]=u,w=maxX-minX,h=maxY-minY;const out=[];
  for(let i=0;i<n;i++){
    const rw=w*(0.02+Math.random()*0.35), rh=h*(0.02+Math.random()*0.35);
    const x=minX+Math.random()*Math.max(0,w-rw),y=minY+Math.random()*Math.max(0,h-rh);
    out.push([x,y,x+rw,y+rh]);
  }
  return out;
}

function buildDataset(codes){
  const rows=[];
  for(const code of codes){
    const asset=state.assets.get(code);if(!asset)continue;
    for(let i=0;i<asset.geometry_records.length;i++){
      const bbox=bboxOfRecord(asset,i);if(!bbox)continue;
      rows.push({code,index:i,bbox,geometry:null});
    }
  }
  return rows;
}
function loadGeometry(row){
  if(!row.geometry){row.geometry=geometryFeature(state.assets.get(row.code),row.index);}
  return row.geometry;
}

async function loadAssets(){
  if(typeof turf==='undefined')throw new Error('Turf failed to load.');
  state.assets.clear();
  const codes=provinceCodesForScope();
  const counts=[];
  for(const code of codes){
    const res=await fetch(ASSET_FILES[code]);
    if(!res.ok)throw new Error(`${code}: HTTP ${res.status}`);
    const asset=await res.json();
    if(!Array.isArray(asset.geometry_records))throw new Error(`${code}: invalid geometry_records`);
    state.assets.set(code,asset);counts.push(`${code}:${asset.geometry_records.length.toLocaleString()}`);
  }
  state.loaded=true;
  $('benchBtn').disabled=false;
  const total=counts.reduce((s,x)=>s+Number(x.split(':')[1].replaceAll(',','')),0);
  log(`Loaded ${total.toLocaleString()} DAs across ${codes.length} province(s).\n${counts.join('  ')}`);
}

function makeTestRects(codes){
  const mode=$('rect').value;
  if(mode==='national')return [unionBbox(codes)];
  if(mode==='random')return randomRects(codes,Number($('randomRects').value)||500);
  return rectPresets(codes);
}

function runOne(rows,rect,method){
  let hits=0;
  for(const row of rows){
    if(!bboxOverlaps(row.bbox,rect))continue;
    const geom=loadGeometry(row);
    const hit=method(geom,rect);
    if(hit)hits++;
  }
  return hits;
}
function runTurf(rows,rect){
  const polygon=turf.bboxPolygon(rect);
  let hits=0;
  for(const row of rows){
    if(!bboxOverlaps(row.bbox,rect))continue;
    const geom=loadGeometry(row);
    if(turf.booleanIntersects(geom,polygon))hits++;
  }
  return hits;
}

function benchFunction(fn,loops){
  const t0=performance.now();let value=0;
  for(let i=0;i<loops;i++)value=fn();
  const ms=performance.now()-t0;return {ms,value};
}

async function benchmark(){
  const codes=provinceCodesForScope();
  if(!state.loaded)await loadAssets();
  const rows=buildDataset(codes); const rects=makeTestRects(codes); const loops=Math.max(1,Math.min(10,Number($('iterations').value)||3));
  log(`Prepared ${rows.length.toLocaleString()} DAs and ${rects.length.toLocaleString()} viewport rectangle(s).\nWarming caches...`);
  // Warm geometry decode and both algorithms once.
  for(const rect of rects.slice(0,Math.min(rects.length,5))){runOne(rows,rect,geometryIntersectsRect);runTurf(rows,rect);}

  let customHits=0,turfHits=0,customMs=0,turfMs=0,candidateChecks=0;
  const perRect=[];
  for(const rect of rects){
    let checks=0; for(const row of rows)if(bboxOverlaps(row.bbox,rect))checks++; candidateChecks+=checks;
    const a=benchFunction(()=>runOne(rows,rect,geometryIntersectsRect),loops);
    const b=benchFunction(()=>runTurf(rows,rect),loops);
    customMs+=a.ms; turfMs+=b.ms; customHits+=a.value; turfHits+=b.value;
    perRect.push({rect,checks,custom:a.value,turf:b.value,agree:a.value===b.value});
  }
  const disagreements=perRect.filter(x=>!x.agree);
  const speedup=turfMs/customMs;
  const accuracy=customHits===turfHits && disagreements.length===0;
  let html=`<h2>Results</h2>`;
  html+=`<p><strong>Candidate:</strong> custom rectangle boundary + containment test &nbsp; <strong>Reference:</strong> Turf booleanIntersects()</p>`;
  html+=`<table><tr><th>Metric</th><th>Custom</th><th>Turf</th></tr>`;
  html+=`<tr><td>Viewport rectangles</td><td>${rects.length.toLocaleString()}</td><td>${rects.length.toLocaleString()}</td></tr>`;
  html+=`<tr><td>DA bbox candidate checks</td><td colspan="2">${candidateChecks.toLocaleString()}</td></tr>`;
  html+=`<tr><td>Measured time (${loops}x)</td><td>${customMs.toFixed(1)} ms</td><td>${turfMs.toFixed(1)} ms</td></tr>`;
  html+=`<tr><td>Approx. speedup</td><td colspan="2">${speedup.toFixed(2)}x</td></tr>`;
  html+=`<tr><td>Total hit count across runs</td><td>${customHits.toLocaleString()}</td><td>${turfHits.toLocaleString()}</td></tr>`;
  html+=`<tr><td>Decision agreement</td><td colspan="2" class="${accuracy?'good':'bad'}">${accuracy?'PASS':'FAIL'}${disagreements.length?` — ${disagreements.length} rectangle(s) differ`:''}</td></tr>`;
  html+='</table>';
  if(disagreements.length){html+='<h3>Disagreements</h3><table><tr><th>#</th><th>Candidate checks</th><th>Custom</th><th>Turf</th><th>Rectangle</th></tr>';disagreements.slice(0,25).forEach((d,i)=>{html+=`<tr><td>${i+1}</td><td>${d.checks}</td><td>${d.custom}</td><td>${d.turf}</td><td>${d.rect.map(v=>v.toFixed(5)).join(', ')}</td></tr>`});html+='</table>';}
  html+='<h3>Per-rectangle results</h3><table><tr><th>#</th><th>Bbox checks</th><th>Custom hits</th><th>Turf hits</th><th>Agreement</th></tr>';
  perRect.slice(0,100).forEach((d,i)=>{html+=`<tr><td>${i+1}</td><td>${d.checks}</td><td>${d.custom}</td><td>${d.turf}</td><td>${d.agree?'PASS':'FAIL'}</td></tr>`});
  html+='</table>';
  $('results').innerHTML=html;
  log(`Benchmark complete.\nCustom: ${customMs.toFixed(1)} ms\nTurf:   ${turfMs.toFixed(1)} ms\nSpeedup: ${speedup.toFixed(2)}x\nAgreement: ${accuracy?'PASS':'FAIL'}`);
}

$('loadBtn').onclick=()=>loadAssets().catch(err=>log(`LOAD ERROR\n${err.stack||err}`));
$('benchBtn').onclick=()=>benchmark().catch(err=>log(`BENCHMARK ERROR\n${err.stack||err}`));
$('scope').onchange=()=>{state.loaded=false;$('benchBtn').disabled=true;log('Scope changed. Click Load DA assets.');};

(() => {
  'use strict';

  const R = 6371008.8;
  const DA = [
    [-79.6012114, 43.5721830],
    [-79.6011376, 43.5719941],
    [-79.6013006, 43.5721238]
  ];
  const CENTER = [-79.59694983, 43.55434149];
  const RADIUS = 2000;
  const DA_AREA_REF = 95.21966578066349;
  const TRUE_REF_PCT = 26.68635635403409;

  const status = document.getElementById('status');
  const out = document.getElementById('out');

  const deg = v => v * Math.PI / 180;
  const rad = v => v * 180 / Math.PI;

  function edgeTs(ax, ay, bx, by, r) {
    const dx = bx - ax, dy = by - ay;
    const A = dx*dx + dy*dy;
    if (A === 0) return [];
    const B = 2*(ax*dx + ay*dy);
    const C = ax*ax + ay*ay - r*r;
    const disc = B*B - 4*A*C;
    if (disc <= 0) return [];
    const sd = Math.sqrt(disc);
    const t1 = (-B-sd)/(2*A), t2 = (-B+sd)/(2*A);
    const ts=[];
    if(t1>0&&t1<1)ts.push(t1);
    if(t2>0&&t2<1&&Math.abs(t2-t1)>1e-12)ts.push(t2);
    return ts.sort((a,b)=>a-b);
  }

  function edgeContribution(ax,ay,bx,by,r){
    const ts=[0,...edgeTs(ax,ay,bx,by,r),1];
    let a=0;
    for(let i=0;i<ts.length-1;i++){
      const t0=ts[i],t1=ts[i+1];
      const x0=ax+(bx-ax)*t0, y0=ay+(by-ay)*t0;
      const x1=ax+(bx-ax)*t1, y1=ay+(by-ay)*t1;
      const mx=(x0+x1)/2, my=(y0+y1)/2;
      if(mx*mx+my*my<=r*r){
        a += (x0*y1-x1*y0)/2;
      }else{
        const ang=Math.atan2(x0*y1-y0*x1,x0*x1+y0*y1);
        a += r*r*ang/2;
      }
    }
    return a;
  }

  function clipArea(ring){
    let a=0;
    for(let i=0;i<ring.length;i++){
      const p=ring[i], q=ring[(i+1)%ring.length];
      a += edgeContribution(p[0],p[1],q[0],q[1],RADIUS);
    }
    return Math.abs(a);
  }

  function currentLocal(pt){
    const [lon0,lat0]=CENTER;
    const lonScale=deg(1)*R*Math.cos(deg(lat0));
    const latScale=deg(1)*R;
    return [(pt[0]-lon0)*lonScale,(pt[1]-lat0)*latScale];
  }

  const aeqdDef = `+proj=aeqd +lat_0=${CENTER[1]} +lon_0=${CENTER[0]} +datum=WGS84 +units=m +no_defs`;
  const laeaDef = `+proj=laea +lat_0=${CENTER[1]} +lon_0=${CENTER[0]} +datum=WGS84 +units=m +no_defs`;
  const wgs84 = '+proj=longlat +datum=WGS84 +no_defs';

  function projected(pt, def){ return proj4(wgs84,def,pt); }

  function runOne(name, fn, referenceAreaForPct){
    const ring=DA.map(fn);
    const inter=clipArea(ring);
    const pct=inter/referenceAreaForPct*100;
    return {name, daArea:referenceAreaForPct, interArea:inter, pct, err:pct-TRUE_REF_PCT};
  }

  function fmt(n,d=6){return Number(n).toFixed(d)}

  document.getElementById('run').addEventListener('click',()=>{
    if(typeof proj4!=='function'){
      status.textContent='proj4 failed to load.'; return;
    }
    status.textContent='Running #549 projections...';
    setTimeout(()=>{
      try{
        const current = runOne('Current local model', currentLocal, DA_AREA_REF);
        const aeqd = runOne('WGS84 Azimuthal Equidistant', p=>projected(p,aeqdDef), DA_AREA_REF);
        const laea = runOne('WGS84 Lambert Azimuthal Equal-Area', p=>projected(p,laeaDef), DA_AREA_REF);
        const rows=[current,aeqd,laea].map(r=>`<tr><td>${r.name}</td><td>${fmt(r.daArea,6)} m²</td><td>${fmt(r.interArea,6)} m²</td><td>${fmt(r.pct,6)}%</td><td>${r.err>=0?'+':''}${fmt(r.err,6)} pp</td></tr>`).join('');
        out.innerHTML=`<table><thead><tr><th>Model</th><th>DA area used</th><th>Intersection area</th><th>Overlap</th><th>Error vs independent ref</th></tr></thead><tbody>${rows}</tbody></table><div class="note"><b>Independent reference:</b> ${fmt(TRUE_REF_PCT,6)}%. <b>Current model:</b> ${fmt(current.pct,6)}%. <b>AEQD:</b> ${fmt(aeqd.pct,6)}%. <b>LAEA:</b> ${fmt(laea.pct,6)}%.</div><pre>DA #10800 vertices:\n${DA.map(p=>p.map(v=>v.toFixed(8)).join(', ')).join('\n')}\n\nCircle center: ${CENTER.join(', ')}\nRadius: ${RADIUS} m</pre>`;
        status.textContent='Complete.';
      }catch(err){
        status.textContent='Error: '+err.message;
        console.error(err);
      }
    },0);
  });
})();

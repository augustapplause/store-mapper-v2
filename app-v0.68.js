/* Canadian Store EBIT Explorer - v0.68
   Financial workbook processing is entirely client-side. Workbook data is never uploaded.
   Census catchment logic follows the supplied Streamlit methodology as closely as possible in-browser:
   province -> provincial DA GeoJSON -> radius buffer -> intersecting DAs -> >=5% overlap or subject DA -> sum population / 65+.
*/
(() => {
  'use strict';

  const CONFIG = {
    canadaBounds: [[41.6, -141.2], [83.2, -52.3]],
    statcanBase: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer',
    provinceLayer: 0,
    csdLayer: 9,
    geocodeUrl: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
    daSources: [
      'data/da/{file}',
      'https://raw.githubusercontent.com/augustapplause/python-project-v1/v1/{file}',
      'https://github.com/augustapplause/python-project-v1/releases/download/v1/{file}'
    ],
    daReleaseApi: 'https://api.github.com/repos/augustapplause/python-project-v1/releases/tags/v1',
    daFiles: {
      AB:'AB_da_census_13vars_30m.geojson', BC:'BC_da_census_13vars_30m.geojson', MB:'MB_da_census_13vars_30m.geojson',
      NB:'NB_da_census_13vars_30m.geojson', NL:'NL_da_census_13vars_30m.geojson', NS:'NS_da_census_13vars_30m.geojson',
      NT:'NT_da_census_13vars_30m.geojson', NU:'NU_da_census_13vars_30m.geojson', ON:'ON_da_census_13vars_30m.geojson',
      PE:'PE_da_census_13vars_30m.geojson', QC:'QC_da_census_13vars_30m.geojson', SK:'SK_da_census_13vars_30m.geojson',
      YT:'YT_da_census_13vars_30m.geojson'
    },
    prCodeByUid: {'10':'NL','11':'PE','12':'NS','13':'NB','24':'QC','35':'ON','46':'MB','47':'SK','48':'AB','59':'BC','60':'YT','61':'NT','62':'NU'},
    csdMinZoom: 6,
    cityCensusRadiusKm: 10,
    minDaOverlapPct: 5
  };

  const state = {
    rows: [], headers: [], types: {}, columns: {}, fileName: null,
    subjects: [], groups: [], distributionSubject: null, distributionBinKey: null, distributionSubject2: null, distributionBinKey2: null, distributionDialogTarget: 1, filters: [], selectedStoreColumns: [],
    selection: {type:'national', name:'Canada', feature:null, provinceCode:null, radius:null},
    markerColor: '#d34c4c',
    selectedRows: [],
    selectedGroupKey: null,
    selectedStoreRow: null,
    provinceGeo: null, csdGeo: null, csdLayer: null, provinceLayer: null,
    daCache: new Map(), currentDaProvince: null, daLayer: null,
    csdLookupGeo: null, csdLookupLoading: false, csdLookupPromise: null, csdLookupIndex: new Map(), csdLookupCellSize: 0.5, lastHeaderCsdKey: null, headerLookupReady: false, headerLookupPointKey: null,
    markerCluster: null, markers: [], radiusLayer: null, selectionOutline: null, spiderfyGroup: null, spiderfyOriginalPositions: new Map(),
    radiusPickMode: false, csdRequestKey: null, moveTimer:null,
    mapReadyForViewport: false, initialNationalView: true,
    programmaticMoveDepth: 0,
    programmaticMoveUntil: 0,
    userMapInteraction: false,
    censusRequestId:0, searchToken:0, headerGeoRequestId:0, headerGeoTimer:null
  };

  const el = id => document.getElementById(id);
  const fmtInt = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
  const fmtPct = v => Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : '—';
  const fmtMoney = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:0}).format(v) : '—';
  const fmtNum = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{maximumFractionDigits:1}).format(v) : '—';
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

  const map = L.map('map', {zoomControl:true, preferCanvas:true, minZoom:3}).fitBounds(CONFIG.canadaBounds, {padding:[8,8]});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  L.control.scale({position:'bottomleft', metric:true, imperial:false, maxWidth:120}).addTo(map);
  state.markerCluster = L.layerGroup().addTo(map);

  const provinceStyle = {color:'#47677d',weight:1.2,fillColor:'#dce8ef',fillOpacity:.10};
  const provinceSelectedStyle = {color:'#086fb4',weight:3,fillColor:'#58a9d8',fillOpacity:.13};
  const csdStyle = {color:'#5e8399',weight:1,fillColor:'#64a3c5',fillOpacity:.035};
  const csdHoverStyle = {color:'#0877bd',weight:2,fillOpacity:.08};
  const daStyle = {color:'#298ac2',weight:.6,fillColor:'#45a3d4',fillOpacity:.08};

  async function fetchJson(url, options={}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 120000);
    try {
      const r = await fetch(url, {signal:controller.signal, cache:'no-store'});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function arcgisGeoJSON(layer, params={}) {
    const q = new URLSearchParams({where:'1=1',outFields:'*',returnGeometry:'true',f:'geojson',outSR:'4326',...params});
    return fetchJson(`${CONFIG.statcanBase}/${layer}/query?${q.toString()}`, {timeout:120000});
  }

  function provinceCodeFromFeature(feature) {
    const uid = String(feature?.properties?.PRUID || feature?.properties?.PRUID3 || '');
    return CONFIG.prCodeByUid[uid] || null;
  }

  function provinceCodeFromText(text) {
    const t = norm(text);
    const map = {
      ab:['alberta','ab'], bc:['british columbia','bc'], mb:['manitoba','mb'], nb:['new brunswick','nb'],
      nl:['newfoundland','newfoundland and labrador','labrador','nl'], ns:['nova scotia','ns'], nt:['northwest territories','nt'],
      nu:['nunavut','nu'], on:['ontario','on'], pe:['prince edward island','pei','pe'], qc:['quebec','québec','qc'],
      sk:['saskatchewan','sk'], yt:['yukon','yt']
    };
    for (const [code, vals] of Object.entries(map)) if (vals.some(v => t === v || t.includes(` ${v} `) || t.includes(v))) return code.toUpperCase();
    return null;
  }

  function provinceCodeFromAddress(query, candidate) {
    const attr = candidate?.attributes || {};
    const byAttr = provinceCodeFromText(`${attr.Region || ''} ${attr.Province || ''} ${attr.Postal || ''}`);
    if (byAttr) return byAttr;
    return provinceCodeFromText(`${query} ${candidate?.address || ''}`);
  }

  async function queryProvinceAt(lat,lng) {
    try {
      const geom = JSON.stringify({x:lng,y:lat,spatialReference:{wkid:4326}});
      const geo = await arcgisGeoJSON(CONFIG.provinceLayer,{geometry:geom,geometryType:'esriGeometryPoint',inSR:'4326',spatialRel:'esriSpatialRelIntersects'});
      return geo.features?.[0] ? provinceCodeFromFeature(geo.features[0]) : null;
    } catch { return null; }
  }

  // ---------- Local CSD header lookup ----------
  // The header is intentionally self-contained: it does not depend on the visible
  // CSD/province layers or on updateSelection(). It loads the local CSD lookup once,
  // builds a lightweight grid index, and resolves the CURRENT map centre locally.
  const HEADER_CSD_URL = 'csd_lookup_light.geojson';
  const HEADER_PROVINCE_NAMES = {AB:'AB',BC:'BC',MB:'MB',NB:'NB',NL:'NL',NS:'NS',NT:'NT',NU:'NU',ON:'ON',PE:'PE',QC:'QC',SK:'SK',YT:'YT'};

  function setHeaderGeographyLabel(city, province) {
    const p = HEADER_PROVINCE_NAMES[String(province || '').toUpperCase()] || String(province || '');
    const label = city ? `${city}${p ? `, ${p}` : ''}` : (p || 'Canada');
    const node = el('headerGeography');
    if (node) node.textContent = label;
  }

  function headerGridKey(lat, lng) {
    const size = state.csdLookupCellSize;
    return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
  }

  function indexCsdLookup(features) {
    state.csdLookupIndex.clear();
    const size = state.csdLookupCellSize;
    for (const feature of features || []) {
      try {
        const bb = feature.__headerBBox || (feature.__headerBBox = turf.bbox(feature));
        const minLat = Math.floor(bb[1] / size), maxLat = Math.floor(bb[3] / size);
        const minLng = Math.floor(bb[0] / size), maxLng = Math.floor(bb[2] / size);
        for (let gy = minLat; gy <= maxLat; gy++) {
          for (let gx = minLng; gx <= maxLng; gx++) {
            const key = `${gy}:${gx}`;
            let bucket = state.csdLookupIndex.get(key);
            if (!bucket) { bucket = []; state.csdLookupIndex.set(key, bucket); }
            bucket.push(feature);
          }
        }
      } catch (err) {
        console.warn('[HEADER] Could not index CSD feature:', err);
      }
    }
  }

  function getCsdAtPoint(lat, lng) {
    if (!state.csdLookupGeo?.features?.length) return null;
    const point = turf.point([lng, lat]);
    const bucket = state.csdLookupIndex.get(headerGridKey(lat, lng)) || [];
    const candidates = bucket.length ? bucket : state.csdLookupGeo.features;
    for (const feature of candidates) {
      try {
        const bb = feature.__headerBBox || (feature.__headerBBox = turf.bbox(feature));
        if (bb[0] > lng || bb[2] < lng || bb[1] > lat || bb[3] < lat) continue;
        if (turf.booleanPointInPolygon(point, feature)) return feature;
      } catch {}
    }
    return null;
  }

  function updateHeaderGeographyAt(lat, lng) {
    if (!state.headerLookupReady) return;
    const pointKey = `${lat.toFixed(5)}:${lng.toFixed(5)}`;
    if (pointKey === state.headerLookupPointKey) return;
    state.headerLookupPointKey = pointKey;
    const feature = getCsdAtPoint(lat, lng);
    if (feature) {
      const p = feature.properties || {};
      const city = p.CSDNAME || p.CSDNAMEE || null;
      const province = p.province || p.Province || null;
      state.lastHeaderCsdKey = String(p.CSDUID || p.OBJECTID || city || '');
      setHeaderGeographyLabel(city, province);
      return;
    }
    // If no CSD contains the centre, leave the last city in place rather than
    // flashing back to Canada while the user is moving through a boundary gap.
  }

  function updateHeaderGeography() {
    const center = map.getCenter();
    updateHeaderGeographyAt(center.lat, center.lng);
  }

  async function loadHeaderCsdLookup() {
    if (state.headerLookupReady) return state.csdLookupGeo;
    if (state.csdLookupPromise) return state.csdLookupPromise;
    state.csdLookupLoading = true;
    state.csdLookupPromise = (async () => {
      try {
        console.info('[HEADER] Loading local CSD lookup once:', HEADER_CSD_URL);
        const response = await fetch(HEADER_CSD_URL, { cache: 'force-cache' });
        console.info('[HEADER] Local CSD HTTP:', response.status, response.statusText);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const geo = await response.json();
        console.info('[HEADER] Local CSD parsed features:', geo?.features?.length || 0);
        if (!geo?.features?.length) throw new Error('CSD lookup contains no features.');
        state.csdLookupGeo = geo;
        indexCsdLookup(geo.features);
        state.headerLookupReady = true;
        console.info('[HEADER] Local CSD index ready. Cells:', state.csdLookupIndex.size);
        // Resolve the CURRENT map centre, not a stale startup coordinate.
        updateHeaderGeography();
        return geo;
      } catch (err) {
        console.warn('[HEADER] Local CSD lookup failed:', err);
        return null;
      } finally {
        state.csdLookupLoading = false;
        state.csdLookupPromise = null;
      }
    })();
    return state.csdLookupPromise;
  }



  async function loadProvinces() {
    setMapLoading(true);
    try {
      state.provinceGeo = await arcgisGeoJSON(CONFIG.provinceLayer);
      if (state.provinceLayer) map.removeLayer(state.provinceLayer);
      state.provinceLayer = L.geoJSON(state.provinceGeo, {
        style:provinceStyle,
        onEachFeature:(feature,layer)=>{
          const name=feature.properties.PRNAME||feature.properties.PRENAME||feature.properties.PRUID||'Province';
          layer.bindTooltip(name,{sticky:true});
          layer.on('click',e=>{L.DomEvent.stopPropagation(e);selectProvince(feature,layer);});
        }
      }).addTo(map);
    } catch(err) { el('geoStatus').textContent=`Province boundaries unavailable: ${err.message}`; }
    finally { setMapLoading(false); setTimeout(()=>{map.invalidateSize(false);refreshCsdLayer();},100); }
  }

  async function refreshCsdLayer() {
    if (map.getZoom() < CONFIG.csdMinZoom) {
      if (state.csdLayer) { map.removeLayer(state.csdLayer); state.csdLayer=null; }
      return;
    }
    const b=map.getBounds();
    const key=[b.getWest().toFixed(2),b.getSouth().toFixed(2),b.getEast().toFixed(2),b.getNorth().toFixed(2),map.getZoom()].join('|');
    if(key===state.csdRequestKey)return;
    state.csdRequestKey=key;
    const geom=`${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    try{
      const geo=await arcgisGeoJSON(CONFIG.csdLayer,{geometry:geom,geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects',maxAllowableOffset:map.getZoom()<8?'0.004':'0.001'});
      state.csdGeo=geo;
      if(state.csdLayer)map.removeLayer(state.csdLayer);
      state.csdLayer=L.geoJSON(geo,{style:csdStyle,onEachFeature:(feature,layer)=>{
        const p=feature.properties||{};
        layer.bindTooltip(`${p.CSDNAME||'Municipality'}${p.CSDTYPE?` (${p.CSDTYPE})`:''}`,{sticky:true});
        layer.on('mouseover',()=>layer.setStyle(csdHoverStyle));
        layer.on('mouseout',()=>state.csdLayer?.resetStyle(layer));
        layer.on('click',e=>{if(state.radiusPickMode)return;L.DomEvent.stopPropagation(e);selectCity(feature,layer);});
      }}).addTo(map);
      state.csdLayer.bringToFront();
      // Header lookup is independent of visible CSD layer.
    }catch(err){console.warn('CSD layer:',err);
      // Header lookup is independent of visible CSD layer.
    }
  }

  function fitMapProgrammatically(bounds, options){
    state.programmaticMoveDepth += 1;
    state.programmaticMoveUntil = Date.now() + 3000;
    state.userMapInteraction = false;
    map.fitBounds(bounds, options);
    setTimeout(()=>{ if(Date.now() >= state.programmaticMoveUntil) state.programmaticMoveDepth = 0; }, 3200);
  }

  function selectProvince(feature,layer){
    clearRadius();clearOutline();clearDaOverlay();state.censusRequestId++;
    if(state.provinceLayer)state.provinceLayer.resetStyle();layer.setStyle(provinceSelectedStyle);
    const name=feature.properties.PRNAME||feature.properties.PRENAME||'Province';
    const code=provinceCodeFromFeature(feature);
    state.selection={type:'viewport',name:`${name} — map view`,feature:null,provinceCode:code,radius:null};
    state.initialNationalView=false;state.mapReadyForViewport=true;
    el('censusPopulation').textContent='—';el('censusSeniors').textContent='—';el('censusDaCount').textContent='—';
    el('censusNote').textContent='Province selected. Search a city/address for the 10 km DA census catchment.';
    fitMapProgrammatically(layer.getBounds(),{padding:[18,18]});
    updateSelection();
  }

  function selectCity(feature,layer){
    clearRadius();clearOutline();clearDaOverlay();state.censusRequestId++;
    const p=feature.properties||{};const name=p.CSDNAME||'Municipality';const code=CONFIG.prCodeByUid[String(p.PRUID||'')]||null;
    state.selection={type:'viewport',name:`${name} — map view`,feature:null,provinceCode:code,radius:null};
    state.initialNationalView=false;state.mapReadyForViewport=true;
    state.selectionOutline=L.geoJSON(feature,{style:{color:'#005a91',weight:4,fillColor:'#40a3d8',fillOpacity:.10}}).addTo(map);
    fitMapProgrammatically(layer.getBounds(),{padding:[18,18]});
    updateSelection();
    const center=layer.getBounds().getCenter();
    if(code) loadCityCensusForGeo(center.lat,center.lng,name,code);
  }

  async function geocodeAndRadius(query){
    if(!query.trim())return;
    const token=++state.searchToken;setMapLoading(true);
    try{
      const qs=new URLSearchParams({SingleLine:query,maxLocations:'5',countryCode:'CAN',outFields:'Match_addr,Addr_type,City,Region,Province',f:'json'});
      const data=await fetchJson(`${CONFIG.geocodeUrl}?${qs.toString()}`,{timeout:30000});
      if(token!==state.searchToken)return;
      const c=data.candidates?.[0];if(!c)throw new Error('No Canadian match found.');
      const lat=c.location.y,lng=c.location.x;
      const km=clamp(Number(el('radiusKm').value)||10,1,200);el('radiusKm').value=km;
      const provinceCode=provinceCodeFromAddress(query,c)||await queryProvinceAt(lat,lng);
      const immediateCity=c.attributes?.City || c.address?.split(',')[0] || query.trim();
      void immediateCity; void provinceCode;
      setVisualRadius(lat,lng,km,c.address||query);
      clearOutline();clearDaOverlay();state.censusRequestId++;
      state.storeJumpTarget=null;
      state.selection={type:'viewport',name:`${c.address||query} — ${km} km view`,feature:null,provinceCode,radius:{lat,lng,km}};
      state.initialNationalView=false;state.mapReadyForViewport=true;
      const targetBounds=L.latLngBounds([[lat-km/110.5,lng-km/(111*Math.cos(lat*Math.PI/180))],[lat+km/110.5,lng+km/(111*Math.cos(lat*Math.PI/180))]]);
      map.once('moveend',()=>{if(token===state.searchToken)updateSelection();});
      fitMapProgrammatically(targetBounds,{padding:[25,25]});
      // Fallback for the rare case where Leaflet does not emit moveend because the bounds did not change.
      setTimeout(()=>{if(token===state.searchToken){updateSelection();loadCityCensusForGeo(lat,lng,c.address||query,provinceCode);}},250);
    }catch(err){el('geoStatus').textContent=`Search failed: ${err.message}`;el('censusNote').textContent='Census not loaded.';}
    finally{if(token===state.searchToken)setMapLoading(false);}
  }

  function setVisualRadius(lat,lng,km){
    clearRadius();
    const ll=L.latLng(lat,lng);
    const circle=L.circle(ll,{radius:km*1000,color:'#d33e46',weight:3,fillColor:'#d33e46',fillOpacity:.06});
    const centreMarker=L.marker(ll,{interactive:false,icon:L.divIcon({className:'',html:'<div style="width:10px;height:10px;background:#1f78b4;border:2px solid white;border-radius:50%;box-shadow:0 0 0 1px #3334"></div>',iconSize:[10,10],iconAnchor:[5,5]})});
    state.radiusLayer=L.featureGroup([circle,centreMarker]).addTo(map);
  }

  function setRadiusSelection(lat,lng,km,name='Radius reference') {
    clearOutline();clearDaOverlay();state.censusRequestId++;
    state.storeJumpTarget=null;
    setVisualRadius(lat,lng,km);
    state.selection={type:'viewport',name:`${name} — ${km} km view`,feature:null,provinceCode:null,radius:{lat,lng,km}};
    state.initialNationalView=false;state.mapReadyForViewport=true;
    updateSelection();
    const targetBounds=L.latLngBounds([[lat-km/110.5,lng-km/(111*Math.cos(lat*Math.PI/180))],[lat+km/110.5,lng+km/(111*Math.cos(lat*Math.PI/180))]]);
    map.once('moveend',()=>updateSelection());
    fitMapProgrammatically(targetBounds,{padding:[25,25]});
    setTimeout(()=>updateSelection(),250);
  }

  function resetCanada(){
    clearRadius();clearOutline();clearDaOverlay();state.censusRequestId++;
    if(state.provinceLayer)state.provinceLayer.resetStyle();
    state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};
    state.mapReadyForViewport=false;state.initialNationalView=true;
    el('censusPopulation').textContent='—';el('censusSeniors').textContent='—';el('censusDaCount').textContent='—';el('censusNote').textContent='Search or click a city to load the 10 km DA census catchment.';
    fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});updateSelection();
  }

  function clearRadius(){if(state.radiusLayer){map.removeLayer(state.radiusLayer);state.radiusLayer=null;}}
  function clearOutline(){if(state.selectionOutline){map.removeLayer(state.selectionOutline);state.selectionOutline=null;}}
  function clearDaOverlay(){if(state.daLayer){map.removeLayer(state.daLayer);state.daLayer=null;}state.currentDaProvince=null;}
  function clamp(v,a,b){return Math.min(Math.max(v,a),b);}
  function setMapLoading(on){el('mapLoading').classList.toggle('hidden',!on);}

  // ---------- Workbook ----------
  async function readFinancialFile(file){
    if(typeof XLSX==='undefined')throw new Error('Excel reader library did not load. Refresh the page and try again.');
    const ext=file.name.toLowerCase().split('.').pop();
    if(ext==='csv')return workbookRows(XLSX.read(await file.text(),{type:'string'}));
    return workbookRows(XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true}));
  }
  function workbookRows(wb){
    const ws=wb.Sheets[wb.SheetNames[0]];if(!ws)throw new Error('The first worksheet is empty.');
    const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null});if(!matrix.length)throw new Error('The first worksheet is empty.');
    const headerIndex=detectHeaderRow(matrix);const rawHeaders=(matrix[headerIndex]||[]).map((v,i)=>String(v??'').trim()||`Unnamed ${i+1}`);const headers=dedupeHeaders(rawHeaders);const rows=[];
    for(let r=headerIndex+1;r<matrix.length;r++){const arr=matrix[r]||[];if(arr.every(v=>v===null||v===''))continue;const obj={};headers.forEach((h,i)=>obj[h]=arr[i]??null);rows.push(obj);}
    return {headers,rows,headerIndex};
  }
  function detectHeaderRow(matrix){
    const tokens=['province','city','location','store concept','location type','gross area','total sales','store 4 wall profit','ebit','latitude','longitude'];let best={i:0,score:-1};
    matrix.slice(0,30).forEach((row,i)=>{const cells=(row||[]).map(v=>norm(v));const nonempty=cells.filter(Boolean).length;const hits=tokens.filter(t=>cells.some(c=>c.includes(t))).length;const score=hits*100+nonempty;if(score>best.score)best={i,score};});return best.i;
  }
  function dedupeHeaders(headers){const seen={};return headers.map(h=>{seen[h]=(seen[h]||0)+1;return seen[h]===1?h:`${h} (${seen[h]})`;});}
  function detectColumns(headers,rows){
    const lookup=headers.map(h=>({h,n:norm(h)}));const findExact=terms=>lookup.find(x=>terms.includes(x.n))?.h||null;const findContains=terms=>lookup.find(x=>terms.some(t=>x.n===t||x.n.includes(t)))?.h||null;
    const columns={
      lat:findExact(['latitude','lat'])||findContains(['latitude']),lon:findExact(['longitude','lon','long'])||findContains(['longitude']),
      province:findContains(['province']),city:findContains(['city']),storeId:findContains(['store profile number','store number','store no','store id']),
      location:findContains(['location']),concept:findContains(['store concept','concept']),locationType:findContains(['location type']),grossArea:findContains(['gross area sq ft','gross area']),
      sales:findContains(['total sales']),wages:findContains(['total labour expense','labour expense']),occupancy:findContains(['total occupancy expense','occupancy expense']),
      ebit:findExact(['store 4 wall profit ebit','store 4 wall profit']) || lookup.find(x=>x.n.includes('store 4 wall profit') && !x.n.includes('debit'))?.h || null
    };
    const types={};for(const h of headers){const vals=rows.slice(0,400).map(r=>r[h]).filter(v=>v!==null&&v!==''&&v!==undefined);const nums=vals.filter(v=>toNumber(v)!==null).length;types[h]=(vals.length&&nums/vals.length>.8)?'numeric':'text';}return {columns,types};
  }
  function toNumber(v){if(typeof v==='number'&&Number.isFinite(v))return v;if(v===null||v===undefined||v==='')return null;const s=String(v).trim().replace(/[$,%]/g,'').replace(/,/g,'');if(!s||!/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null;}
  function isStoreRecord(row){
    const idCol=state.columns.storeId;if(!idCol)return true;const v=row[idCol];if(v===null||v===undefined||String(v).trim()==='')return false;const s=norm(v);
    if(['total','average','excludingsdm 940 sdm 1027','excluding sdm 940 sdm 1027'].includes(s))return false;return toNumber(v)!==null;
  }
  function afterWorkbookLoaded(file,parsed){
    state.fileName=file.name;state.headers=parsed.headers;state.rows=parsed.rows;const d=detectColumns(state.headers,state.rows);state.columns=d.columns;state.types=d.types;state.rows=state.rows.filter(isStoreRecord);
    const c=state.columns;
    const exactDefaultNames=['total sales','gross profit','total labour expense','total occupancy expense','store 4 wall profit ebit'];
    const exactDefaultGroupNames=['location type'];
    const exactHeaders=new Map(state.headers.map(h=>[norm(h),h]));
    state.subjects=[...new Set(exactDefaultNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.groups=[...new Set(exactDefaultGroupNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];
    el('fileStatus').textContent=`${file.name} • ${state.rows.length.toLocaleString()} stores • header row ${parsed.headerIndex+1}`;el('clearFileBtn').disabled=false;el('subjectsBtn').disabled=false;el('groupsBtn').disabled=false;el('distributionBtn').disabled=false;el('distributionBtn2').disabled=false;el('filterBtn').disabled=false;el('selectedStoresBtn').disabled=false;el('exportSelectedBtn').disabled=false;
    refreshConfigUI();rebuildMarkers();state.initialNationalView=true;state.mapReadyForViewport=false;state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});setTimeout(()=>updateSelection(),0);
    const mapped=state.rows.filter(hasCoords).length;el('geoStatus').textContent=`Workbook loaded. ${mapped.toLocaleString()} of ${state.rows.length.toLocaleString()} stores have valid coordinates and are mapped.`;
  }
  function clearFinancial(){state.rows=[];state.headers=[];state.types={};state.columns={};state.subjects=[];state.groups=[];state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];state.fileName=null;state.selectedRows=[];state.selectedStoreRow=null;state.markerCluster.clearLayers();state.markers=[];el('fileInput').value='';el('fileStatus').textContent='No financial file selected.';el('clearFileBtn').disabled=true;el('subjectsBtn').disabled=true;el('groupsBtn').disabled=true;el('distributionBtn').disabled=true;el('distributionBtn2').disabled=true;el('filterBtn').disabled=true;el('selectedStoresBtn').disabled=true;el('exportSelectedBtn').disabled=true;refreshConfigUI();updateFilterUI();updateSelection();}
  function hasCoords(row){const c=state.columns;const lat=toNumber(row[c.lat]),lon=toNumber(row[c.lon]);return lat!==null&&lon!==null&&lat>=40&&lat<=90&&lon>=-150&&lon<=-40;}

  // ---------- Store markers ----------
  // Every store is a separate marker.  Overlapping markers are only spread apart
  // temporarily when the user clicks an overlapping location (spiderfy behavior).
  function rebuildMarkers(){
    unspiderfyMarkers();
    state.markerCluster.clearLayers();
    state.markers=[];
    if(!state.rows.length||!state.columns.lat||!state.columns.lon)return;
    for(const row of state.rows){
      if(!hasCoords(row))continue;
      if(!rowPassesFilters(row))continue;
      const lat=toNumber(row[state.columns.lat]),lng=toNumber(row[state.columns.lon]);
      const marker=L.marker([lat,lng],{icon:storeIcon(row,true)});
      marker.bindPopup(()=>storePopup(row),{maxWidth:350});
      const profile=state.columns.storeId?String(row[state.columns.storeId]??'').trim():'';
      if(profile) marker.bindTooltip(profile,{direction:'top',sticky:true,opacity:.95,offset:[0,-8]});
      marker.__row=row;
      marker.__trueLatLng=L.latLng(lat,lng);
      marker.on('click',()=>handleMarkerClick(marker));
      state.markers.push(marker);
      state.markerCluster.addLayer(marker);
    }
  }
  function storeIcon(row,inSelection){
    const focusActive = (state.selectedGroupKey!==null && rowMatchesSelectedGroup(row)) || (state.distributionBinKey!==null && rowMatchesSelectedDistribution(row,1)) || (state.distributionBinKey2!==null && rowMatchesSelectedDistribution(row,2)) || state.selectedStoreRow===row;
    const cls=focusActive ? 'group-highlight' : (inSelection ? 'default' : 'out');
    return L.divIcon({className:'',html:`<div class="store-marker ${cls}" style="--store-marker-color:${state.markerColor}"></div>`,iconSize:[14,14],iconAnchor:[7,7]});
  }
  function rowMatchesSelectedGroup(row){
    if(state.selectedGroupKey===null||!state.groups.length)return false;
    const parts=state.groups.map(g=>String(row[g]??'(blank)'));
    return JSON.stringify(parts)===state.selectedGroupKey;
  }
  function rowMatchesSelectedDistribution(row){
    if(!state.distributionSubject||state.distributionBinKey===null)return false;
    const h=state.distributionSubject;
    const bins=buildDistributionBins();
    const b=bins.find(x=>x.key===state.distributionBinKey);
    if(!b)return false;
    if(state.types[h]==='numeric'){
      const v=toNumber(row[h]);
      return v!==null && v>=b.min && (b.last ? v<=b.max : v<b.max);
    }
    return String(row[h]??'')===String(b.value??'');
  }
  function storePopup(row){
    const c=state.columns;
    const fields=[c.storeId,c.location,...state.subjects].filter(Boolean);
    const uniq=[...new Set(fields)];
    const title=row[c.location]||row[c.storeId]||'Store';
    const lat=toNumber(row[c.lat]),lng=toNumber(row[c.lon]);
    const mapsLink=(lat!==null&&lng!==null)?`<a class="store-popup-map-link" href="https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps" aria-label="Open in Google Maps">↗</a>`:'';
    let html=`<div class="store-popup"><div class="store-popup-head"><h3>${esc(title)}</h3>${mapsLink}</div><table>`;
    if(c.storeId)html+=`<tr><td>${esc(c.storeId)}</td><td>${esc(formatValue(c.storeId,row[c.storeId]))}</td></tr>`;
    if(c.location)html+=`<tr><td>${esc(c.location)}</td><td>${esc(formatValue(c.location,row[c.location]))}</td></tr>`;
    if(c.city||c.province){const city=String(row[c.city]??'').trim();const prov=String(row[c.province]??'').trim();if(city||prov)html+=`<tr><td>City, Pr</td><td>${esc([city,prov].filter(Boolean).join(', ')||'—')}</td></tr>`;}
    for(const h of uniq){if(h===c.storeId||h===c.location)continue;html+=`<tr><td>${esc(h)}</td><td>${esc(formatValue(h,row[h]))}</td></tr>`;}
    return html+'</table></div>';
  }

  function handleMarkerClick(marker){
    const nearby=getNearbyMarkers(marker,18);
    if(nearby.length>1){
      if(state.spiderfyGroup && state.spiderfyGroup.includes(marker)){
        unspiderfyMarkers();
        marker.openPopup();
        return;
      }
      unspiderfyMarkers();
      spiderfyMarkers(nearby);
    }
  }
  function getNearbyMarkers(centerMarker,thresholdPx){
    const center=map.latLngToLayerPoint(centerMarker.getLatLng());
    return state.markers.filter(m=>{
      if(!rowPassesFilters(m.__row)) return false;
      const p=map.latLngToLayerPoint(m.getLatLng());
      return p.distanceTo(center)<=thresholdPx;
    });
  }
  function spiderfyMarkers(markers){
    if(markers.length<=1)return;
    state.spiderfyGroup=[...markers];
    state.spiderfyOriginalPositions.clear();
    const center=map.latLngToLayerPoint(markers[0].getLatLng());
    const radius=Math.max(24,Math.min(48,18+markers.length*3));
    const n=markers.length;
    markers.forEach((m,i)=>{
      state.spiderfyOriginalPositions.set(m,m.getLatLng());
      const angle=(-Math.PI/2)+(i*(2*Math.PI/n));
      const p=L.point(center.x+Math.cos(angle)*radius,center.y+Math.sin(angle)*radius);
      m.setLatLng(map.layerPointToLatLng(p));
      m.setZIndexOffset(1000+i);
    });
    setTimeout(()=>{
      const first=state.spiderfyGroup?.[0];
      if(first && !first.isPopupOpen()) first.openPopup();
    },0);
  }
  function unspiderfyMarkers(){
    if(!state.spiderfyGroup || !state.spiderfyGroup.length)return;
    for(const m of state.spiderfyGroup){
      const original=state.spiderfyOriginalPositions.get(m);
      if(original)m.setLatLng(original);
      m.setZIndexOffset(0);
    }
    state.spiderfyGroup=null;
    state.spiderfyOriginalPositions.clear();
  }
  function refreshMarkerStyles(){if(!state.markers.length)return;const selectedSet=new Set(state.selectedRows);state.markers.forEach(m=>{const passes=rowPassesFilters(m.__row);m.setOpacity(passes?1:0);m.setZIndexOffset(passes?(selectedSet.has(m.__row)||state.selection.type==='national'?10:0):-1000);m.setIcon(storeIcon(m.__row,selectedSet.has(m.__row)||state.selection.type==='national'));});}

  // ---------- Store selection follows the map viewport only ----------
  // The radius is navigation/visual-reference only. It never constrains analysis.
  function rowPassesFilters(row){
    if(!state.filters || !state.filters.length) return true;
    const byColumn=new Map();
    for(const f of state.filters){
      if(!byColumn.has(f.column))byColumn.set(f.column,[]);
      byColumn.get(f.column).push(f);
    }
    for(const [column,filters] of byColumn.entries()) {
      const numericFilters=filters.filter(f=>f.type==='numeric');
      const textFilters=filters.filter(f=>f.type==='text');
      const rawValue=row[column];
      if(numericFilters.length){
        const n=toNumber(rawValue);
        if(n===null)return false;
        for(const f of numericFilters){
          const target=Number(f.value);
          if(!Number.isFinite(target))return false;
          let pass=false;
          if(f.operator==='<=')pass=n<=target;
          else if(f.operator==='=')pass=n===target;
          else if(f.operator==='>=')pass=n>=target;
          else if(f.operator==='<')pass=n<target;
          else if(f.operator==='>')pass=n>target;
          else pass=false;
          if(!pass)return false;
        }
      }
      if(textFilters.length){
        const s=String(rawValue??'');
        const pass=textFilters.some(f=>{
          if(Array.isArray(f.values)&&f.values.length)return f.values.some(v=>String(v)===s);
          if(f.wildcard)return wildcardMatch(s,f.wildcard);
          return false;
        });
        if(!pass)return false;
      }
    }
    return true;
  }

  function getSelectedRows(){
    if(!state.rows.length)return[];
    const eligible=state.rows.filter(rowPassesFilters);
    const c=state.columns;
    if(!c.lat||!c.lon) return eligible;
    // The map viewport is the only geographic selection criterion.
    const b=map.getBounds();
    return eligible.filter(r=>hasCoords(r)&&b.contains([toNumber(r[c.lat]),toNumber(r[c.lon])]));
  }
  function getFilteredRows(){return state.rows.filter(rowPassesFilters);}
  function updateSelection(){
    state.selectedRows=getSelectedRows();
    if(state.selectedStoreRow!==null && !state.selectedRows.includes(state.selectedStoreRow)) state.selectedStoreRow=null;
    // Header lookup is independent of visible CSD layer.
    const filtered=getFilteredRows();
    const filterNote=state.filters.length?` • ${filtered.length.toLocaleString()} pass active filter${filtered.length===1?'':'s'}`:'';
    el('geoStatus').textContent=state.rows.length?`${state.selectedRows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} stores in current map view${filterNote}.`:'Load a workbook to calculate store results.';
    el('filterCount').textContent=state.filters.length;
    el('filterStatus').textContent=state.filters.length?state.filters.map(describeFilter).join(' • '):'No filters applied.';
    updateKpis();updateSubjects();updateGroups();updateDistribution();updateSelectedStoresList();refreshMarkerStyles();
  }
  function fmtThousands(v){return Number.isFinite(v)?Math.round(v/1000).toLocaleString('en-CA'):'—';}
  function updateKpis(){
    const rows=state.selectedRows,c=state.columns,e=c.ebit,s=c.sales;
    el('kpiStores').textContent=rows.length.toLocaleString();
    const salesVals=s?rows.map(r=>toNumber(r[s])).filter(v=>v!==null):[];
    const ebitVals=e?rows.map(r=>toNumber(r[e])).filter(v=>v!==null):[];
    const totalSales=salesVals.length?salesVals.reduce((a,b)=>a+b,0):NaN;
    const totalEbit=ebitVals.length?ebitVals.reduce((a,b)=>a+b,0):NaN;
    el('kpiTotalSales').textContent=fmtThousands(totalSales);
    el('kpiTotalEbit').textContent=fmtThousands(totalEbit);
    el('kpiTotalEbitMargin').textContent=Number.isFinite(totalEbit)&&Number.isFinite(totalSales)&&totalSales!==0?`${(totalEbit/totalSales*100).toFixed(1)}%`:'—';
    if(!e){el('kpiSuccess').textContent='—';el('kpiAvgEbit').textContent='—';el('kpiMedianEbit').textContent='—';return;}
    if(!ebitVals.length){el('kpiSuccess').textContent='—';el('kpiAvgEbit').textContent='—';el('kpiMedianEbit').textContent='—';return;}
    el('kpiSuccess').textContent=fmtPct(ebitVals.filter(v=>v>0).length/ebitVals.length);
    el('kpiAvgEbit').textContent=fmtMoney(avg(ebitVals));
    el('kpiMedianEbit').textContent=fmtMoney(median(ebitVals));
  }
  function avg(vals){return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:NaN;}
  function median(vals){if(!vals.length)return NaN;const a=[...vals].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}

  // ---------- Subjects / Groups ----------
  function updateSubjects(){
    const box=el('subjectsSummary');
    if(!state.rows.length){box.innerHTML='<div class="empty-message">Select a workbook, then configure Subjects.</div>';return;}
    if(!state.subjects.length){box.innerHTML='<div class="empty-message">No Subjects selected.</div>';return;}
    const salesCol=state.columns.sales;
    const salesTotal=salesCol?state.selectedRows.map(r=>toNumber(r[salesCol])).filter(v=>v!==null).reduce((a,b)=>a+b,0):NaN;
    let html='<table class="subject-table">';
    for(const h of state.subjects){
      const vals=state.selectedRows.map(r=>toNumber(r[h])).filter(v=>v!==null);
      let valueText='—';
      let shareText='';
      if(state.types[h]==='numeric'){
        const mean=avg(vals);
        valueText=formatValue(h,mean);
        if(Number.isFinite(salesTotal)&&salesTotal!==0&&vals.length){
          const subjectTotal=vals.reduce((a,b)=>a+b,0);
          const share=subjectTotal/salesTotal*100;
          shareText=` (${share.toFixed(1)}%)`;
        }
      } else {
        const raw=state.selectedRows.map(r=>r[h]).filter(v=>v!==null&&v!==''&&v!==undefined);
        valueText=mode(raw)||'—';
      }
      html+=`<tr><td><span class="subject-name">${esc(h)}</span>${shareText?`<span class="subject-share">${shareText}</span>`:''}</td><td>${esc(valueText)}</td></tr>`;
    }
    el('subjectsSummary').innerHTML=html+'</table>';
  }

  function mode(vals){const m=new Map();for(const v of vals){const s=String(v);m.set(s,(m.get(s)||0)+1);}return [...m.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;}
  function updateSelectedStoresList(){
    const box=el('selectedStoresList');if(!box)return;
    const c=state.columns;
    const extra=state.selectedStoreColumns.filter(h=>h&&h!==c.storeId&&h!==c.location&&state.headers.includes(h));
    if(!state.selectedRows.length){box.innerHTML='<div class="empty-message">No stores in current map view.</div>';return;}
    let html='<div class="selected-store-count small muted">'+state.selectedRows.length.toLocaleString()+' selected store'+(state.selectedRows.length===1?'':'s')+'</div><div class="selected-stores-scroll"><table class="group-table"><thead><tr><th>Store Profile Number</th><th>Location</th>'+extra.map(h=>`<th>${esc(shortHeader(h))}</th>`).join('')+'</tr></thead><tbody>';
    for(const row of state.selectedRows){
      const profile=c.storeId?String(row[c.storeId]??''):'—';
      const loc=c.location?String(row[c.location]??'')||[c.city,c.province].filter(Boolean).map(x=>String(row[x]??'').trim()).filter(Boolean).join(', '):[c.city,c.province].filter(Boolean).map(x=>String(row[x]??'').trim()).filter(Boolean).join(', ');
      const active=state.selectedStoreRow===row;
      html+='<tr class="selected-store-select-row'+(active?' active-store-selection':'')+'"><td>'+esc(profile||'—')+'</td><td>'+esc(loc||'—')+'</td>'+extra.map(h=>`<td>${esc(formatValue(h,row[h]))}</td>`).join('')+'</tr>';
    }
    box.innerHTML=html+'</tbody></table></div>';
    box.querySelectorAll('.selected-store-select-row').forEach((rowEl,idx)=>rowEl.addEventListener('click',()=>{
      const row=state.selectedRows[idx];
      state.selectedStoreRow=state.selectedStoreRow===row?null:row;
      if(state.selectedStoreRow!==null){state.selectedGroupKey=null;state.distributionBinKey=null;state.distributionBinKey2=null;}
      updateGroups();updateDistribution();updateSelectedStoresList();refreshMarkerStyles();
    }));
  }
  function renderSelectedStoresConfig(filter=''){
    const cont=el('selectedStoresListConfig');if(!cont)return;
    const f=norm(filter);cont.innerHTML='';
    const fixed=new Set([state.columns.storeId,state.columns.location].filter(Boolean));
    state.headers.filter(h=>!fixed.has(h)&&(!f||norm(h).includes(f))).forEach((h,i)=>{
      const id=`selected-store-${i}-${Math.random().toString(36).slice(2,6)}`;
      const row=document.createElement('label');row.className='check-row';
      row.innerHTML=`<input type="checkbox" id="${id}" value="${esc(h)}" ${state.selectedStoreColumns.includes(h)?'checked':''}><span>${esc(h)}</span><small>${state.types[h]||''}</small>`;
      cont.appendChild(row);
    });
  }
  function selectedStoreCheckedValues(){return [...el('selectedStoresListConfig').querySelectorAll('input[type=checkbox]:checked')].map(x=>x.value);}
  async function exportSelectedStores(){
    if(!state.selectedRows.length){alert('No stores are currently selected.');return;}
    if(typeof XLSX==='undefined'){alert('Excel export library did not load.');return;}
    const c=state.columns;
    const extra=state.selectedStoreColumns.filter(h=>h&&h!==c.storeId&&h!==c.location&&state.headers.includes(h));
    const exportHeaders=[c.storeId||'Store Profile Number',c.location||'Location',...extra].filter((v,i,a)=>v&&a.indexOf(v)===i);
    const data=state.selectedRows.map(row=>{
      const out={};
      for(const h of exportHeaders){
        if(h==='Store Profile Number'&&!c.storeId) out[h]='';
        else if(h==='Location'&&!c.location) out[h]=[c.city,c.province].filter(Boolean).map(x=>String(row[x]??'').trim()).filter(Boolean).join(', ');
        else {
          const src=(h===c.storeId?c.storeId:h===c.location?c.location:h);out[h]=row[src]??'';
        }
      }
      return out;
    });
    const wb=XLSX.utils.book_new();const ws=XLSX.utils.json_to_sheet(data);XLSX.utils.book_append_sheet(wb,ws,'Selected Stores');
    const filename='selected_stores.xls';
    if(typeof window.showSaveFilePicker==='function'){
      try{
        const handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'Excel 97-2003 workbook',accept:{'application/vnd.ms-excel':['.xls']}}]});
        const bytes=XLSX.write(wb,{bookType:'biff8',type:'array'});
        const writable=await handle.createWritable();await writable.write(bytes);await writable.close();return;
      }catch(err){if(err?.name==='AbortError')return;}
    }
    XLSX.writeFile(wb,filename,{bookType:'biff8'});
  }
  function updateGroups(){
    const box=el('groupsSummary');
    if(!state.rows.length||!state.groups.length){box.innerHTML='<div class="empty-message">Choose one or more Groups to compare store segments.</div>';return;}
    const groups=new Map();
    for(const row of state.selectedRows){
      const parts=state.groups.map(g=>String(row[g]??'(blank)'));
      const key=JSON.stringify(parts);
      if(!groups.has(key))groups.set(key,{parts,rows:[]});
      groups.get(key).rows.push(row);
    }
    const list=[...groups.entries()].sort((a,b)=>b[1].rows.length-a[1].rows.length).slice(0,100);
    const e=state.columns.ebit;
    let html='<div class="group-wrap"><table class="group-table"><thead><tr><th>Group</th><th>n</th>'+(e?'<th>EBIT +%</th>':'')+state.subjects.map(h=>`<th>${esc(shortHeader(h))}</th>`).join('')+'</tr></thead><tbody>';
    for(const [key,g] of list){
      let success='';
      if(e){const ev=g.rows.map(r=>toNumber(r[e])).filter(v=>v!==null);success=`<td>${ev.length?fmtPct(ev.filter(v=>v>0).length/ev.length):'—'}</td>`;}
      const subj=state.subjects.map(h=>{const vals=g.rows.map(r=>r[h]).filter(v=>v!==null&&v!==''&&v!==undefined);const v=state.types[h]==='numeric'?formatValue(h,avg(vals.map(toNumber).filter(x=>x!==null))):(mode(vals)||'—');return `<td>${esc(v)}</td>`;}).join('');
      const active=state.selectedGroupKey===key;
      html+=`<tr class="group-select-row${active?' active-group':''}" data-group-key="${esc(key)}"><td><strong>${g.parts.map(esc).join(' / ')}</strong></td><td>${g.rows.length}</td>${success}${subj}</tr>`;
    }
    box.innerHTML=html+'</tbody></table></div><div class="small muted group-hint">Click a group row to highlight its stores on the map.</div>';
    box.querySelectorAll('.group-select-row').forEach(row=>row.addEventListener('click',()=>{
      const key=row.dataset.groupKey;
      state.selectedGroupKey=state.selectedGroupKey===key?null:key;
      if(state.selectedGroupKey!==null){state.distributionBinKey=null;state.distributionBinKey2=null;state.selectedStoreRow=null;}
      updateGroups();updateDistribution();
      refreshMarkerStyles();
    }));
  }
  function niceStep(range,target=7){
    const raw=range/Math.max(target,1);if(!Number.isFinite(raw)||raw<=0)return 1;
    const p=Math.pow(10,Math.floor(Math.log10(raw)));const n=raw/p;const m=n<=1?1:n<=2?2:n<=5?5:10;return m*p;
  }
  function formatBinValue(v,h){
    if(h&&norm(h).includes('pct')) return `${v.toFixed(0)}%`;
    if(Math.abs(v)>=100000) return fmtMoney(v);
    if(Math.abs(v)>=1000) return `${(v/1000).toFixed(v%1000===0?0:1)}K`;
    return v.toLocaleString('en-CA',{maximumFractionDigits:0});
  }
  function getDistributionSubject(slot){return slot===2?state.distributionSubject2:state.distributionSubject;}
  function getDistributionBinKey(slot){return slot===2?state.distributionBinKey2:state.distributionBinKey;}
  function setDistributionBinKey(slot,key){if(slot===2)state.distributionBinKey2=key;else state.distributionBinKey=key;}
  function buildDistributionBins(slot=1){
    const h=getDistributionSubject(slot);
    if(!h||!state.selectedRows.length)return [];
    if(state.types[h]==='numeric'){
      const vals=state.selectedRows.map(r=>toNumber(r[h])).filter(v=>v!==null);
      if(!vals.length)return [];
      const min=Math.min(...vals),max=Math.max(...vals);
      if(min===max)return [{key:'0',min,max:min+1,count:vals.length,label:formatBinValue(min,h),last:true}];
      const step=niceStep(max-min,7),start=Math.floor(min/step)*step,end=Math.ceil(max/step)*step,bins=[];
      for(let a=start,i=0;a<end-1e-9&&i<30;i++,a+=step){const b=Math.min(a+step,end);bins.push({key:String(i),min:a,max:b,count:0,label:`${formatBinValue(a,h)} – ${formatBinValue(b,h)}`,last:b>=end-1e-9});}
      vals.forEach(v=>{const i=Math.min(bins.length-1,Math.max(0,Math.floor((v-start)/step)));if(bins[i])bins[i].count++;});
      return bins;
    }
    const counts=new Map();
    for(const row of state.selectedRows){const value=String(row[h]??'');counts.set(value,(counts.get(value)||0)+1);}
    return [...counts.entries()]
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],undefined,{numeric:true,sensitivity:'base'}))
      .slice(0,40)
      .map(([value,count],i)=>({key:String(i),value,count,label:value||'(blank)'}));
  }
  function rowMatchesSelectedDistribution(row,slot=1){
    const h=getDistributionSubject(slot), key=getDistributionBinKey(slot);
    if(!h||key===null)return false;
    const bins=buildDistributionBins(slot), b=bins.find(x=>x.key===key);
    if(!b)return false;
    if(state.types[h]==='numeric'){
      const v=toNumber(row[h]);
      return v!==null && v>=b.min && (b.last ? v<=b.max : v<b.max);
    }
    return String(row[h]??'')===String(b.value??'');
  }
  function updateDistributionSlot(slot,boxId){
    const box=el(boxId);if(!box)return;
    const h=getDistributionSubject(slot);
    if(!state.rows.length){box.innerHTML='<div class="empty-message">Select a workbook, then configure Distribution.</div>';return;}
    if(!h){box.innerHTML='';return;}
    const bins=buildDistributionBins(slot);if(!bins.length){box.innerHTML='<div class="empty-message">No values in the current map view.</div>';return;}
    const currentKey=getDistributionBinKey(slot);
    if(currentKey!==null&&!bins.some(b=>b.key===currentKey))setDistributionBinKey(slot,null);
    const activeKey=getDistributionBinKey(slot), maxCount=Math.max(...bins.map(b=>b.count),1);
    const label=slot===2?'Distribution 2':'Distribution';
    let html=`<div class="distribution-title">${esc(h)} <span class="small muted">${state.selectedRows.length.toLocaleString()} stores</span></div><div class="distribution-chart" role="list" aria-label="${label} of selected column">`;
    for(const b of bins){const active=activeKey===b.key;const width=Math.max(2,(b.count/maxCount)*100);html+=`<button type="button" class="distribution-bar${active?' active-distribution':''}" data-bin-key="${esc(b.key)}" title="${esc(b.label)}: ${b.count} stores"><span class="distribution-label">${esc(b.label)}</span><span class="distribution-track"><span class="distribution-fill" style="width:${width}%"></span></span><strong>${b.count}</strong></button>`;}
    html+='</div><div class="small muted distribution-hint">Click a bar to highlight those stores on the map. Selecting a bar in either distribution clears Group highlighting and the other distribution highlight.</div>';box.innerHTML=html;
    box.querySelectorAll('.distribution-bar').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.binKey;setDistributionBinKey(slot,getDistributionBinKey(slot)===key?null:key);if(getDistributionBinKey(slot)!==null){state.selectedGroupKey=null;state.selectedStoreRow=null;if(slot===1)state.distributionBinKey2=null;else state.distributionBinKey=null;}updateGroups();updateDistribution();refreshMarkerStyles();}));
  }
  function updateDistribution(){updateDistributionSlot(1,'distributionSummary');updateDistributionSlot(2,'distributionSummary2');}

  function shortHeader(h){return h.length>18?h.slice(0,17)+'…':h;}
  function formatValue(header,v){if(v===null||v===undefined||v===''||Number.isNaN(v))return '—';const n=toNumber(v),hn=norm(header);if(n!==null){if(hn.includes('sales')||hn.includes('wage')||hn.includes('expense')||hn.includes('margin $')||hn.includes('profit')||hn.includes('ebit')||hn.includes('income')||hn.includes('cogs')||hn.includes('sga'))return fmtMoney(n);if(hn.includes('sq ft')||hn.includes('area'))return `${fmtInt(n)} sq.ft.`;if(hn.includes('pct')||hn.includes('percent')||hn.endsWith('%'))return `${n.toFixed(1)}%`;return fmtNum(n);}return String(v);}
  function refreshConfigUI(){
    el('subjectCount').textContent=state.subjects.length;
    el('groupCount').textContent=state.groups.length;
    el('distributionCount').textContent=state.distributionSubject?1:0;
    el('distributionCount2').textContent=state.distributionSubject2?1:0; el('selectedStoresCount').textContent=2+state.selectedStoreColumns.length;
    renderChecklist('subjectsList',state.subjects,'subject');
    renderChecklist('groupsList',state.groups,'group');
    renderDistributionList(el('distributionSearch')?.value||''); renderSelectedStoresConfig(el('selectedStoresSearch')?.value||'');
  }
  function renderChecklist(containerId,selected,kind,filter=''){
    const cont=el(containerId);const f=norm(filter);cont.innerHTML='';
    state.headers.filter(h=>!f||norm(h).includes(f)).forEach((h,i)=>{
      const id=`${kind}-${i}-${Math.random().toString(36).slice(2,6)}`;
      const row=document.createElement('label');row.className='check-row';
      row.innerHTML=`<input type="checkbox" id="${id}" value="${esc(h)}" ${selected.includes(h)?'checked':''}><span>${esc(h)}</span><small>${state.types[h]||''}</small>`;
      cont.appendChild(row);
    });
  }
  function renderDistributionList(filter=''){
    const cont=el('distributionList');const f=norm(filter);if(!cont)return;cont.innerHTML='';
    state.headers.filter(h=>!f||norm(h).includes(f)).forEach((h,i)=>{
      const id=`dist-${i}-${Math.random().toString(36).slice(2,6)}`;
      const row=document.createElement('label');row.className='check-row distribution-select-row';
      row.innerHTML=`<input type="radio" name="distributionColumn" id="${id}" value="${esc(h)}" ${(state.distributionDialogTarget===2?state.distributionSubject2:state.distributionSubject)===h?'checked':''}><span>${esc(h)}</span><small>${state.types[h]||''}</small>`;
      cont.appendChild(row);
    });
  }
  function checkedValues(containerId){return [...el(containerId).querySelectorAll('input[type=checkbox]:checked:not(.distribution-check)')].map(x=>x.value);}

  // ---------- Filters ----------
  const FILTER_OPERATORS=['<=','=','>=','<','>'];
  function wildcardRegex(pattern){
    const escaped=String(pattern??'').replace(/[.+^${}()|[\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
    return new RegExp(`^${escaped}$`,'i');
  }
  function wildcardMatch(value,pattern){
    if(!pattern)return true;
    try{return wildcardRegex(pattern).test(String(value??''));}catch{return false;}
  }
  function describeFilter(f){
    if(f.type==='numeric')return `${f.column} ${f.operator} ${formatValue(f.column,f.value)}`;
    if(Array.isArray(f.values)&&f.values.length)return `${f.column} = ${f.values.join(', ')}`;
    if(f.wildcard)return `${f.column} matches ${f.wildcard}`;
    return f.column;
  }
  function uniqueColumnValues(column){
    return [...new Set(state.rows.map(r=>String(r[column]??'')).filter(v=>v!==''))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  }
  function renderFilterValueArea(){
    const area=el('filterValueArea'); if(!area)return;
    const h=el('filterColumn').value; if(!h){area.innerHTML='';return;}
    if(state.types[h]==='numeric'){
      area.innerHTML=`<div class="filter-row"><label>Condition</label><div class="filter-numeric"><select id="filterOperator">${FILTER_OPERATORS.map(o=>`<option value="${o}">${o}</option>`).join('')}</select><input id="filterNumericValue" type="number" step="any" placeholder="Enter value"></div></div>`;
    }else{
      const values=uniqueColumnValues(h);
      area.innerHTML=`<div class="filter-row"><label>Values</label><div class="filter-values">${values.slice(0,500).map((v,i)=>`<label class="filter-value"><input type="checkbox" class="filter-value-check" value="${esc(v)}"><span>${esc(v||'(blank)')}</span></label>`).join('')}</div></div><div class="filter-row"><label>Wildcard</label><input id="filterWildcard" type="text" placeholder="e.g. Ontario* or *Plaza*"></div>`;
    }
  }
  function renderActiveFilters(){
    const box=el('activeFilterList');if(!box)return;
    if(!state.filters.length){box.innerHTML='<div class="empty-message">No filters configured.</div>';return;}
    box.innerHTML=state.filters.map((f,i)=>`<div class="active-filter"><span>${esc(describeFilter(f))}</span><button type="button" class="filter-remove" data-filter-index="${i}" aria-label="Remove filter">×</button></div>`).join('');
    box.querySelectorAll('.filter-remove').forEach(btn=>btn.addEventListener('click',()=>{state.filters.splice(Number(btn.dataset.filterIndex),1);renderActiveFilters();}));
  }
  function addCurrentFilter(){
    const h=el('filterColumn').value;if(!h)return;
    if(state.types[h]==='numeric'){
      const op=el('filterOperator')?.value;const value=toNumber(el('filterNumericValue')?.value);if(value===null){alert('Enter a numeric value for this filter.');return;}
      state.filters.push({column:h,type:'numeric',operator:op,value});
    }else{
      const vals=[...document.querySelectorAll('.filter-value-check:checked')].map(x=>x.value);
      const wildcard=String(el('filterWildcard')?.value??'').trim();
      if(!vals.length&&!wildcard){alert('Select one or more values or enter a wildcard pattern.');return;}
      state.filters.push({column:h,type:'text',values:vals,wildcard});
    }
    renderActiveFilters();
    renderFilterValueArea();
  }
  function populateFilterColumns(){
    const sel=el('filterColumn');if(!sel)return;sel.innerHTML=state.headers.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');renderFilterValueArea();
  }
  function updateFilterUI(){
    const btn=el('filterBtn');if(btn)btn.disabled=!state.rows.length;
    const clearBtn=el('clearFiltersBtn');if(clearBtn)clearBtn.disabled=!state.rows.length;
    populateFilterColumns();renderActiveFilters();
  }
  function redrawAfterFilterChange(){
    // Filters change the eligible store population itself. Force a full marker
    // layer rebuild immediately so stores excluded by the new filter cannot
    // remain visible until a later map interaction.
    unspiderfyMarkers();
    if(state.markerCluster){
      state.markerCluster.clearLayers();
    }
    state.markers=[];
    rebuildMarkers();
    refreshMarkerStyles();
  }

  function applyFilters(){
    renderActiveFilters();
    if(state.storeJumpTarget && !rowPassesFilters(state.storeJumpTarget)){
      clearRadius();
      state.storeJumpTarget=null;
    }
    redrawAfterFilterChange();
    updateSelection();
  }

  // ---------- Census: translated from supplied Streamlit DA methodology ----------
  async function loadDaGeoJSON(provinceCode){
    if(!provinceCode)throw new Error('Province could not be identified for this census request.');
    if(state.daCache.has(provinceCode))return state.daCache.get(provinceCode);
    const file=CONFIG.daFiles[provinceCode];
    if(!file)throw new Error(`No DA file configured for ${provinceCode}.`);
    const errors=[];

    // 1) Local GitHub Pages data/da/ copy, if supplied.
    for(const template of [CONFIG.daSources[0]]){
      const url=template.replace('{file}',encodeURIComponent(file));
      try{const geo=await fetchJson(url,{timeout:180000});if(!geo?.features)throw new Error('GeoJSON contained no features.');state.daCache.set(provinceCode,geo);return geo;}
      catch(err){errors.push(`local: ${err.message}`);}
    }

    // 2) Original GitHub branch path.
    try{
      const url=CONFIG.daSources[1].replace('{file}',encodeURIComponent(file));
      const geo=await fetchJson(url,{timeout:180000});if(!geo?.features)throw new Error('GeoJSON contained no features.');state.daCache.set(provinceCode,geo);return geo;
    }catch(err){errors.push(`branch: ${err.message}`);}

    // 3) Resolve the actual release asset URL from GitHub, then download it.
    try{
      const rel=await fetchJson(CONFIG.daReleaseApi,{timeout:30000});
      const asset=(rel.assets||[]).find(a=>a.name===file);
      if(!asset?.browser_download_url)throw new Error(`Release asset ${file} not found.`);
      const geo=await fetchJson(asset.browser_download_url,{timeout:180000});
      if(!geo?.features)throw new Error('Release asset contained no GeoJSON features.');
      state.daCache.set(provinceCode,geo);return geo;
    }catch(err){errors.push(`release: ${err.message}`);}

    // 4) Original direct release URL as final compatibility fallback.
    try{
      const url=CONFIG.daSources[2].replace('{file}',encodeURIComponent(file));
      const geo=await fetchJson(url,{timeout:180000});if(!geo?.features)throw new Error('GeoJSON contained no features.');state.daCache.set(provinceCode,geo);return geo;
    }catch(err){errors.push(`direct-release: ${err.message}`);}

    throw new Error(`Could not load ${provinceCode} DA census file ${file}. ${errors.join(' | ')}`);
  }

  function featureBBoxIntersects(a,b){
    const aa=a.bbox||turf.bbox(a),bb=b.bbox||turf.bbox(b);
    return !(aa[2]<bb[0]||aa[0]>bb[2]||aa[3]<bb[1]||aa[1]>bb[3]);
  }

  async function buildDaCatchment(lat,lng,radiusKm,provinceCode){
    const daGeo=await loadDaGeoJSON(provinceCode);
    const point=turf.point([lng,lat]);
    const circle=turf.buffer(point,radiusKm,{units:'kilometers',steps:64});
    let subject=null;
    for(const f of daGeo.features||[]){
      try{if(turf.booleanPointInPolygon(point,f)){subject=f;break;}}catch{}
    }
    const selected=[];
    const cb=turf.bbox(circle);
    for(const f of daGeo.features||[]){
      if(!f.geometry)continue;
      try{
        if(f===subject){selected.push(f);continue;}
        const fb=f.bbox||turf.bbox(f);if(fb[2]<cb[0]||fb[0]>cb[2]||fb[3]<cb[1]||fb[1]>cb[3])continue;
        if(!turf.booleanIntersects(f,circle))continue;
        const inter=turf.intersect(turf.featureCollection([f,circle]));
        if(!inter)continue;
        const interArea=turf.area(inter), daArea=turf.area(f);if(daArea>0&&(interArea/daArea*100)>=CONFIG.minDaOverlapPct)selected.push(f);
      }catch{}
    }
    return {selected,subject,daGeo,circle};
  }

  function sumDaField(features,field){return features.reduce((s,f)=>s+(toNumber(f.properties?.[field])||0),0);}

  async function loadCityCensusForGeo(lat,lng,label,provinceCode){
    const requestId=++state.censusRequestId;
    el('censusPopulation').textContent='…';el('censusSeniors').textContent='…';el('censusDaCount').textContent='…';el('censusNote').textContent=`Loading ${provinceCode||''} DA census data for a ${CONFIG.cityCensusRadiusKm} km catchment…`;
    clearDaOverlay();
    try{
      if(!provinceCode)provinceCode=await queryProvinceAt(lat,lng);
      if(!provinceCode)throw new Error('Could not identify the province at the searched location.');
      const result=await buildDaCatchment(lat,lng,CONFIG.cityCensusRadiusKm,provinceCode);
      if(requestId!==state.censusRequestId)return;
      const selected=result.selected;
      const pop=sumDaField(selected,'total_population');
      const seniors=sumDaField(selected,'population_65_plus');
      el('censusPopulation').textContent=fmtInt(pop);el('censusSeniors').textContent=fmtInt(seniors);el('censusDaCount').textContent=fmtInt(selected.length);el('censusNote').textContent=`2021 DA catchment: ${CONFIG.minDaOverlapPct}% minimum overlap, plus containing DA. ${provinceCode}.`;
      state.currentDaProvince=provinceCode;
      state.daLayer=L.geoJSON(turf.featureCollection(selected),{style:daStyle,onEachFeature:(feature,layer)=>{const p=feature.properties||{};layer.bindTooltip(`DA ${p.DA_ID||''} • Population ${fmtInt(toNumber(p.total_population)||0)} • Seniors 65+ ${fmtInt(toNumber(p.population_65_plus)||0)}`,{sticky:true});}}).addTo(map);
      state.daLayer.bringToBack();
    }catch(err){
      if(requestId!==state.censusRequestId)return;
      el('censusPopulation').textContent='—';el('censusSeniors').textContent='—';el('censusDaCount').textContent='—';el('censusNote').textContent=`Census DA load failed: ${err.message}`;
    }
  }

  function goToStoreNumber(){
    const query=String(el('storeNumberInput').value??'').trim();
    if(!query){el('storeJumpStatus').textContent='Enter a Store Profile Number.';return;}
    const idCol=state.columns.storeId;
    if(!idCol){el('storeJumpStatus').textContent='Store Profile Number column not found in workbook.';return;}
    const target=state.rows.find(r=>norm(r[idCol])===norm(query));
    if(!target){el('storeJumpStatus').textContent='Store Profile Number not found.';return;}
    if(!hasCoords(target)){
      el('storeJumpStatus').textContent='Store found, but it has no valid Latitude / Longitude.';return;
    }
    if(!rowPassesFilters(target)){
      alert('Not in filter, check filters');
      el('storeJumpStatus').textContent='Not in filter, check filters';
      return;
    }
    const lat=toNumber(target[state.columns.lat]), lng=toNumber(target[state.columns.lon]);
    const storeCity=state.columns.city?String(target[state.columns.city]??'').trim():'';
    const storeProvince=state.columns.province?provinceCodeFromText(target[state.columns.province]||''):null;
    // Header resolves from the current map position via the local CSD lookup.
    const km=clamp(Number(el('radiusKm').value)||10,1,200); el('radiusKm').value=km;
    clearRadius(); clearOutline(); clearDaOverlay(); state.censusRequestId++;
    state.storeJumpTarget=target;
    setVisualRadius(lat,lng,km);
    state.selection={type:'viewport',name:`Store ${query} — ${km} km view`,feature:null,provinceCode:provinceCodeFromText(target[state.columns.province]||''),radius:{lat,lng,km}};
    state.initialNationalView=false; state.mapReadyForViewport=true;
    const dLat=km/110.5, dLon=km/(111*Math.cos(lat*Math.PI/180));
    const targetBounds=L.latLngBounds([[lat-dLat,lng-dLon],[lat+dLat,lng+dLon]]);
    fitMapProgrammatically(targetBounds,{padding:[25,25]});
    el('storeJumpStatus').textContent=`Showing store ${query}.`;
    updateSelection();
  }

  // ---------- Marker colour palette ----------
  const MARKER_COLORS = [
    {name:'Red', value:'#d34c4c'},
    {name:'Royal Blue', value:'#4169e1'},
    {name:'Purple', value:'#7a3db8'},
    {name:'Black', value:'#1f2933'}
  ];

  function updateMarkerColorUI(){
    document.querySelectorAll('.marker-color-swatch').forEach(btn=>{
      const active=btn.dataset.color===state.markerColor;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-pressed',active?'true':'false');
    });
    const dot=el('defaultMarkerDot');
    if(dot)dot.style.background=state.markerColor;
  }

  function setMarkerColor(color){
    if(!MARKER_COLORS.some(x=>x.value===color))return;
    state.markerColor=color;
    updateMarkerColorUI();
    refreshMarkerStyles();
  }

  document.querySelectorAll('.marker-color-swatch').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
      setMarkerColor(btn.dataset.color);
    });
  });

  // ---------- UI wiring ----------
  el('fileInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;el('fileStatus').textContent='Reading workbook locally…';try{afterWorkbookLoaded(file,await readFinancialFile(file));}catch(err){el('fileStatus').textContent=`Could not read file: ${err.message}`;}});
  el('clearFileBtn').addEventListener('click',clearFinancial);
  el('storeNumberBtn').addEventListener('click',goToStoreNumber);
  el('storeNumberInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();goToStoreNumber();}});
  el('searchForm').addEventListener('submit',e=>{e.preventDefault();geocodeAndRadius(el('searchInput').value);});
  el('radiusModeBtn').addEventListener('click',()=>{state.radiusPickMode=!state.radiusPickMode;el('radiusModeBtn').textContent=state.radiusPickMode?'Click map to set radius centre':'Pick radius centre on map';map.getContainer().style.cursor=state.radiusPickMode?'crosshair':'';});
  map.on('click',e=>{if(!state.radiusPickMode){unspiderfyMarkers();return;}state.radiusPickMode=false;map.getContainer().style.cursor='';el('radiusModeBtn').textContent='Pick radius centre on map';const km=clamp(Number(el('radiusKm').value)||10,1,200);queryProvinceAt(e.latlng.lat,e.latlng.lng).then(code=>{setRadiusSelection(e.latlng.lat,e.latlng.lng,km,'Map point',code);loadCityCensusForGeo(e.latlng.lat,e.latlng.lng,'Map point',code);});});
  map.on('dragstart',()=>{
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  map.on('zoomstart',()=>{
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  map.on('moveend',()=>{
    const programmatic = state.programmaticMoveDepth > 0 || Date.now() < state.programmaticMoveUntil;
    if(programmatic){
      state.programmaticMoveDepth=Math.max(0,state.programmaticMoveDepth-1);
    } else if(state.rows.length && state.columns.lat && state.columns.lon){
      state.initialNationalView=false;
      state.mapReadyForViewport=true;
    }
    state.userMapInteraction=false;
    updateHeaderGeography();
    updateSelection();
    if(state.moveTimer)clearTimeout(state.moveTimer);
    state.moveTimer=setTimeout(async()=>{
      state.csdRequestKey=null;
      await refreshCsdLayer();
      updateHeaderGeography();
    },150);
  });
  window.addEventListener('resize',()=>{map.invalidateSize(false);updateSelection();});
  el('subjectsBtn').addEventListener('click',()=>{renderChecklist('subjectsList',state.subjects,'subject',el('subjectSearch').value);el('subjectsDialog').showModal();});
  el('selectedStoresBtn').addEventListener('click',()=>{renderSelectedStoresConfig(el('selectedStoresSearch').value);el('selectedStoresDialog').showModal();});
  el('selectedStoresSearch').addEventListener('input',e=>renderSelectedStoresConfig(e.target.value));
  el('selectedStoresClear').addEventListener('click',()=>{renderSelectedStoresConfig('');});
  el('selectedStoresApply').addEventListener('click',()=>{state.selectedStoreColumns=selectedStoreCheckedValues();refreshConfigUI();updateSelectedStoresList();});
  el('exportSelectedBtn').addEventListener('click',exportSelectedStores);
  el('groupsBtn').addEventListener('click',()=>{renderChecklist('groupsList',state.groups,'group',el('groupSearch').value);el('groupsDialog').showModal();});
  el('subjectSearch').addEventListener('input',e=>renderChecklist('subjectsList',checkedValues('subjectsList'),'subject',e.target.value));
  el('groupSearch').addEventListener('input',e=>renderChecklist('groupsList',checkedValues('groupsList'),'group',e.target.value));
  el('subjectsClear').addEventListener('click',()=>renderChecklist('subjectsList',[],'subject',el('subjectSearch').value));
  el('groupsClear').addEventListener('click',()=>renderChecklist('groupsList',[],'group',el('groupSearch').value));
  el('subjectsApply').addEventListener('click',()=>{state.subjects=checkedValues('subjectsList');refreshConfigUI();updateSubjects();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('groupsApply').addEventListener('click',()=>{state.groups=checkedValues('groupsList');state.distributionBinKey=null;state.distributionBinKey2=null;state.selectedGroupKey=null;state.selectedStoreRow=null;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('distributionBtn').addEventListener('click',()=>{state.distributionDialogTarget=1;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionBtn2').addEventListener('click',()=>{state.distributionDialogTarget=2;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionSearch').addEventListener('input',e=>renderDistributionList(e.target.value));
  el('distributionClear').addEventListener('click',()=>{if(state.distributionDialogTarget===2){state.distributionSubject2=null;state.distributionBinKey2=null;}else{state.distributionSubject=null;state.distributionBinKey=null;}renderDistributionList(el('distributionSearch').value);updateDistribution();refreshConfigUI();refreshMarkerStyles();});
  el('distributionApply').addEventListener('click',()=>{const checked=el('distributionList').querySelector('input[type=radio]:checked');if(state.distributionDialogTarget===2){state.distributionSubject2=checked?checked.value:null;state.distributionBinKey2=null;}else{state.distributionSubject=checked?checked.value:null;state.distributionBinKey=null;}state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionBinKey=state.distributionDialogTarget===2?null:state.distributionBinKey;state.distributionBinKey2=state.distributionDialogTarget===1?null:state.distributionBinKey2;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('filterBtn').addEventListener('click',()=>{updateFilterUI();el('filterDialog').showModal();});
  el('clearFiltersBtn').addEventListener('click',()=>{state.filters=[];renderActiveFilters();redrawAfterFilterChange();updateSelection();updateFilterUI();});
  el('filterColumn').addEventListener('change',renderFilterValueArea);
  el('addFilterBtn').addEventListener('click',addCurrentFilter);
  el('clearAllFilters').addEventListener('click',()=>{state.filters=[];renderActiveFilters();redrawAfterFilterChange();updateSelection();});
  el('applyFiltersBtn').addEventListener('click',()=>{applyFilters();});

  if(typeof L==='undefined')el('geoStatus').textContent='Mapping library did not load. Refresh the page and try again.';
  if(typeof XLSX==='undefined')el('fileStatus').textContent='Excel reader library did not load. Refresh the page and try again.';
  if(typeof turf==='undefined')el('censusNote').textContent='Geospatial calculation library did not load. Refresh the page and try again.';
  loadHeaderCsdLookup();
  loadProvinces();
  updateSelection();
  updateHeaderGeography();
})();

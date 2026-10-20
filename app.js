/* Store Explorer - v0.94
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
    subjects: [], groups: [], distributionSubject: null, distributionBinKey: null, distributionSubject2: null, distributionBinKey2: null, distributionDialogTarget: 1, filters: [], filterDraft: [], filterValuePickerIndex: null, selectedStoreColumns: [],
    selection: {type:'national', name:'Canada', feature:null, provinceCode:null, radius:null},
    markerColor: '#d34c4c',
    markerAnimation: {enabled:false,type:'pulse',column:'',formula:'',operator:'=',value:'',values:[],typeMode:'numeric'},
    markerAnimationPassCache: new WeakMap(),
    filterPassCache: new WeakMap(),
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
    censusRequestId:0, searchToken:0, headerGeoRequestId:0, headerGeoTimer:null, tickerMetrics:[], tickerPlaying:true, tickerOffset:0, tickerDragStart:null, tickerPointerId:null, tickerLoopWidth:0, tickerAnimationFrame:null, tickerLastTime:null, tickerSpeed:70, tickerConfigDraft:[], tickerConfigDraftSpeed:70
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
    const tickerReady=state.tickerMetrics.length>0 && state.tickerMetrics.every(m=>m.formula && tickerFormulaValid(m.formula));
    if(!tickerReady){
      state.tickerMetrics=tickerDefaultMetrics();
      saveTickerConfig();
    }
    const exactDefaultNames=['total sales','gross profit','total labour expense','total occupancy expense','store 4 wall profit ebit'];
    const exactDefaultGroupNames=['location type'];
    const exactHeaders=new Map(state.headers.map(h=>[norm(h),h]));
    state.subjects=[...new Set(exactDefaultNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.groups=[...new Set(exactDefaultGroupNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];
    el('fileStatus').textContent=`Workbook loaded • ${file.name} • ${state.rows.length.toLocaleString()} stores • header row ${parsed.headerIndex+1}`;el('clearFileBtn').disabled=false;el('tickerConfigBtn').disabled=false;el('subjectsBtn').disabled=false;el('groupsBtn').disabled=false;el('distributionBtn').disabled=false;el('distributionBtn2').disabled=false;el('filterBtn').disabled=false;el('selectedStoresBtn').disabled=false;el('exportSelectedBtn').disabled=false;
    refreshConfigUI();rebuildFilterPassCache();rebuildMarkerAnimationCache();populateMarkerAnimationControls();rebuildMarkers();state.initialNationalView=true;state.mapReadyForViewport=false;state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});setTimeout(()=>updateSelection(),0);
    const mapped=state.rows.filter(hasCoords).length;el('geoStatus').textContent=`Workbook loaded. ${mapped.toLocaleString()} of ${state.rows.length.toLocaleString()} stores have valid coordinates and are mapped.`;
  }
  function clearFinancial(){state.rows=[];state.headers=[];state.types={};state.columns={};state.subjects=[];state.groups=[];state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];state.fileName=null;state.selectedRows=[];state.selectedStoreRow=null;state.markerCluster.clearLayers();state.markers=[];el('fileInput').value='';el('fileStatus').textContent='No financial file selected.';el('clearFileBtn').disabled=true;el('tickerConfigBtn').disabled=true;el('subjectsBtn').disabled=true;el('groupsBtn').disabled=true;el('distributionBtn').disabled=true;el('distributionBtn2').disabled=true;el('filterBtn').disabled=true;el('selectedStoresBtn').disabled=true;el('exportSelectedBtn').disabled=true;refreshConfigUI();updateFilterUI();updateSelection();}
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
      const marker=L.marker([lat,lng],{icon:storeIcon(row,true,false)});
      marker.bindPopup(()=>storePopup(row),{maxWidth:350});
      const profile=state.columns.storeId?String(row[state.columns.storeId]??'').trim():'';
      if(profile) marker.bindTooltip(profile,{direction:'top',sticky:true,opacity:.95,offset:[0,-8]});
      marker.__row=row;
      marker.__trueLatLng=L.latLng(lat,lng);
      marker.__visualKey='';
      marker.__filterPass=true;
      marker.__selected=false;
      marker.on('click',()=>handleMarkerClick(marker));
      state.markers.push(marker);
      state.markerCluster.addLayer(marker);
    }
  }
  function storeIcon(row,inSelection,animateVisible=false){
    const focusActive = (state.selectedGroupKey!==null && rowMatchesSelectedGroup(row)) || (state.distributionBinKey!==null && rowMatchesSelectedDistribution(row,1)) || (state.distributionBinKey2!==null && rowMatchesSelectedDistribution(row,2)) || state.selectedStoreRow===row;
    const cls=focusActive ? 'group-highlight' : (inSelection ? 'default' : 'out');
    const animating = animateVisible && markerRowAnimationPasses(row);
    const anim=animating ? ` marker-animation marker-animation-${state.markerAnimation.type}` : '';
    const duration=2800;
    const phase=Math.round(performance.now()%duration);
    const delay=animating ? `--marker-animation-delay:-${phase}ms;` : '';
    return L.divIcon({className:'',html:`<div class="store-marker-wrap${anim}" style="${delay}"><div class="store-marker ${cls}" style="--store-marker-color:${state.markerColor}"></div></div>`,iconSize:[14,14],iconAnchor:[7,7]});
  }
  function markerFocusActive(row,dist1=null,dist2=null){
    if(state.selectedGroupKey!==null && rowMatchesSelectedGroup(row))return true;
    if(state.selectedStoreRow===row)return true;
    if(dist1 && state.distributionSubject){
      const h=state.distributionSubject,v=state.types[h]==='numeric'?toNumber(row[h]):String(row[h]??'');
      if(state.types[h]==='numeric'){if(v!==null && v>=dist1.min && (dist1.last?v<=dist1.max:v<dist1.max))return true;}
      else if(String(v)===String(dist1.value??''))return true;
    }
    if(dist2 && state.distributionSubject2){
      const h=state.distributionSubject2,v=state.types[h]==='numeric'?toNumber(row[h]):String(row[h]??'');
      if(state.types[h]==='numeric'){if(v!==null && v>=dist2.min && (dist2.last?v<=dist2.max:v<dist2.max))return true;}
      else if(String(v)===String(dist2.value??''))return true;
    }
    return false;
  }
  function markerVisualKey(row,inSelection,dist1=null,dist2=null){
    const focusActive=markerFocusActive(row,dist1,dist2);
    return `${focusActive?'focus':'normal'}|${inSelection?'in':'out'}|${markerRowAnimationPasses(row)?state.markerAnimation.type:'none'}|${state.markerColor}`;
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
  // ---------- Store marker animation ----------
  const MARKER_ANIMATION_STORAGE_KEY='cse_marker_animation_v093';
  function normalizeMarkerAnimation(config){
    let type=['ripple','fade'].includes(config?.type)?config.type:'ripple';
    if(config?.type==='rotation' || config?.type==='squish' || config?.type==='pulse') type='ripple';
    const typeMode=config?.typeMode==='text'?'text':'numeric';
    const operator=['<=','=','>=','<','>'].includes(config?.operator)?config.operator:'=';
    return {
      enabled:!!config?.enabled, type, column:String(config?.column??''), formula:String(config?.formula??''),
      operator, value:String(config?.value??''), values:Array.isArray(config?.values)?config.values.map(String):[], typeMode
    };
  }
  function loadMarkerAnimationConfig(){
    try{
      const raw=localStorage.getItem(MARKER_ANIMATION_STORAGE_KEY);
      state.markerAnimation=normalizeMarkerAnimation(raw?JSON.parse(raw):null);
    }catch(_){state.markerAnimation=normalizeMarkerAnimation(null);}
  }
  function saveMarkerAnimationConfig(){
    try{localStorage.setItem(MARKER_ANIMATION_STORAGE_KEY,JSON.stringify(state.markerAnimation));}catch(_){}
  }
  function markerAnimationFormulaIsValid(){
    const f=String(state.markerAnimation.formula||'').trim();
    if(!f)return false;
    const tokens=exactFormulaTokens(f);
    if(!tokens)return false;
    const headers=tokens.filter(t=>t.type==='header').map(t=>t.value);
    if(!headers.length)return false;
    return headers.every(h=>state.types[h]==='numeric');
  }
  function markerRowMatchesAnimation(row){
    const a=state.markerAnimation;
    if(!a.enabled)return false;
    const formula=String(a.formula||'').trim();
    if(!formula)return false;
    if(a.typeMode==='text'){
      if(!a.column||!Array.isArray(a.values)||!a.values.length)return false;
      const actual=String(row[a.column]??'');
      return a.values.some(v=>String(v)===actual);
    }
    const calc=evaluateRowFormula(formula,row);
    const target=Number(a.value);
    if(!Number.isFinite(calc)||!Number.isFinite(target))return false;
    if(a.operator==='<=')return calc<=target;
    if(a.operator==='=')return calc===target;
    if(a.operator==='>=')return calc>=target;
    if(a.operator==='<')return calc<target;
    if(a.operator==='>')return calc>target;
    return false;
  }
  function rebuildMarkerAnimationCache(){
    state.markerAnimationPassCache=new WeakMap();
    if(!state.markerAnimation.enabled||!state.rows.length)return;
    for(const row of state.rows) state.markerAnimationPassCache.set(row,markerRowMatchesAnimation(row));
  }
  function markerRowAnimationPasses(row){
    if(!state.markerAnimation.enabled)return false;
    return !!state.markerAnimationPassCache.get(row);
  }
  function markerAnimationConditionSummary(){
    const a=state.markerAnimation;
    if(!a.formula)return 'Choose one condition to animate matching stores.';
    if(a.typeMode==='text')return a.values.length?`${a.formula} = ${a.values.join(', ')}`:'Choose one or more values.';
    return `${a.formula} ${a.operator} ${a.value||'Value'}`;
  }
  function markerAnimationPassCount(){return state.rows.reduce((n,row)=>n+(markerRowAnimationPasses(row)?1:0),0);}
  function refreshMarkerStyles(){
    if(!state.markers.length)return;
    const selectedSet=new Set(state.selectedRows);
    const bounds=map.getBounds();
    let dist1=null,dist2=null;
    if(state.distributionBinKey!==null && state.distributionSubject){
      const bins=buildDistributionBins();
      dist1=bins.find(x=>x.key===state.distributionBinKey)||null;
    }
    if(state.distributionBinKey2!==null && state.distributionSubject2){
      const bins2=buildDistributionBins(2);
      dist2=bins2.find(x=>x.key===state.distributionBinKey2)||null;
    }
    state.markers.forEach(m=>{
      const passes=filterRowPasses(m.__row);
      const inSelection=selectedSet.has(m.__row)||state.selection.type==='national';
      const animateVisible=passes && bounds.contains(m.__trueLatLng||m.getLatLng());
      if(m.__filterPass!==passes){m.__filterPass=passes;m.setOpacity(passes?1:0);}
      const z=passes?(inSelection?10:0):-1000;
      if(m.__zIndex!==z){m.__zIndex=z;m.setZIndexOffset(z);}
      const key=markerVisualKey(m.__row,inSelection,dist1,dist2)+`|${animateVisible?'visible':'off'}`;
      if(m.__visualKey!==key){m.__visualKey=key;m.setIcon(storeIcon(m.__row,inSelection,animateVisible));}
    });
  }


  // ---------- Store selection follows the map viewport only ----------
  // The radius is navigation/visual-reference only. It never constrains analysis.
  function rowPassesFiltersWithFilters(row,filters){
    const list=filters||[];
    if(!list.length)return true;
    let result=rowMatchesFilter(list[0],row);
    for(let i=1;i<list.length;i++){
      const current=rowMatchesFilter(list[i],row);
      result=(list[i].connector||'AND')==='OR' ? (result||current) : (result&&current);
    }
    return result;
  }
  function rebuildFilterPassCache(filters=state.filters||[]){
    const cache=new WeakMap();
    let count=0;
    for(const row of state.rows){
      const pass=filters.length?rowPassesFiltersWithFilters(row,filters):true;
      cache.set(row,pass);
      if(pass)count++;
    }
    state.filterPassCache=cache;
    return count;
  }
  function filterRowPasses(row){
    if(!state.rows.length)return false;
    const cached=state.filterPassCache.get(row);
    return cached===undefined ? (!state.filters.length) : cached;
  }
  function rowPassesFilters(row){
    return filterRowPasses(row);
  }

  function getSelectedRows(){
    if(!state.rows.length)return[];
    const c=state.columns;
    if(!c.lat||!c.lon) return state.rows.filter(filterRowPasses);
    const b=map.getBounds();
    return state.rows.filter(r=>filterRowPasses(r)&&hasCoords(r)&&b.contains([toNumber(r[c.lat]),toNumber(r[c.lon])]));
  }
  function getFilteredRows(){return state.rows.filter(filterRowPasses);}
  function updateSelection(){
    state.selectedRows=getSelectedRows();
    if(state.selectedStoreRow!==null && !state.selectedRows.includes(state.selectedStoreRow)) state.selectedStoreRow=null;
    // Header lookup is independent of visible CSD layer.
    const filtered=getFilteredRows();
    const filterNote=state.filters.length?` • ${filtered.length.toLocaleString()} pass active filter${filtered.length===1?'':'s'}`:'';
    el('geoStatus').textContent=state.rows.length?`${state.selectedRows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} stores in current map view${filterNote}.`:'Load a workbook to calculate store results.';
    el('filterCount').textContent=state.filters.length;
    el('filterStatus').textContent=state.filters.length?state.filters.map((f,i)=>describeFilter(f,i)).join(' • '):'No filters applied.';
    updateKpis();updateSubjects();updateGroups();updateDistribution();updateSelectedStoresList();refreshMarkerStyles();renderTicker();
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
    const groupedSubjectColumns=state.subjects;
    let html='<div class="group-wrap"><table class="group-table"><thead><tr><th>Group</th><th>n</th>'+(e?'<th>EBIT +%</th>':'')+groupedSubjectColumns.map(h=>`<th>${esc(shortHeader(h))}</th>`).join('')+'</tr></thead><tbody>';
    for(const [key,g] of list){
      let success='';
      if(e){const ev=g.rows.map(r=>toNumber(r[e])).filter(v=>v!==null);success=`<td>${ev.length?fmtPct(ev.filter(v=>v>0).length/ev.length):'—'}</td>`;}
      const subj=groupedSubjectColumns.map(h=>{const vals=g.rows.map(r=>r[h]).filter(v=>v!==null&&v!==''&&v!==undefined);const v=state.types[h]==='numeric'?formatValue(h,avg(vals.map(toNumber).filter(x=>x!==null))):(mode(vals)||'—');return `<td>${esc(v)}</td>`;}).join('');
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
  const FILTER_CONNECTORS=['AND','OR'];

  function wildcardRegex(pattern){
    const escaped=String(pattern??'').replace(/[.+^${}()|[\\]/g,'\\$&').replace(/\\*/g,'.*').replace(/\\?/g,'.');
    return new RegExp(`^${escaped}$`,'i');
  }
  function wildcardMatch(value,pattern){
    if(!pattern)return true;
    try{return wildcardRegex(pattern).test(String(value??''));}catch{return false;}
  }
  function describeFilter(f,index=0){
    const prefix=index>0?`${f.connector||'AND'} `:'';
    if(f.type==='numeric')return `${prefix}${f.formula||f.column} ${f.operator} ${String(f.value??'')}`;
    if(Array.isArray(f.values)&&f.values.length)return `${prefix}${f.formula||f.column} = ${f.values.join(', ')}`;
    if(f.wildcard)return `${prefix}${f.formula||f.column} matches ${f.wildcard}`;
    return `${prefix}${f.formula||f.column||''}`;
  }
  function uniqueColumnValues(column){
    return [...new Set(state.rows.map(r=>String(r[column]??'')).filter(v=>v!==''))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  }
  function exactFormulaTokens(formula){
    const tokens=tokenizeTicker(String(formula??'').trim());
    if(!tokens||!tokens.length)return null;
    return tokens.map(t=>t.type==='operand'
      ? (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value)?{type:'number',value:Number(t.value)}:{type:'header',value:t.value})
      : {type:'op',value:t.value});
  }
  function expressionLooksNumeric(formula){
    const tokens=exactFormulaTokens(formula);
    if(!tokens)return false;
    const headerTokens=[...new Set(tokens.filter(t=>t.type==='header').map(t=>t.value))];
    if(!headerTokens.length)return true;
    const sample=state.rows.slice(0,400);
    return headerTokens.every(h=>sample.some(row=>toNumber(row[h])!==null));
  }
  function evaluateRowFormula(formula,row){
    const tokens=tokenizeTicker(String(formula??'').trim());
    if(!tokens||!tokens.length)return null;
    const operandValues=new Map();
    for(const t of tokens){
      if(t.type!=='operand'||/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))continue;
      const value=toNumber(row[t.value]);
      if(value===null)return null;
      operandValues.set(t.value,value);
    }
    const value=evaluateTickerExpression(formula,operandValues);
    return Number.isFinite(value)?value:null;
  }
  function filterDraftBlank(){return {connector:'AND',column:'',formula:'',operator:'=',value:'',values:[],wildcard:'',type:'numeric'};}
  function cloneFilterDrafts(filters){
    return (filters||[]).map((f,i)=>({
      connector:i===0?'AND':(f.connector||'AND'),
      column:f.column||'', formula:f.formula||f.column||'', operator:f.operator||'=', value:f.value??'', values:Array.isArray(f.values)?[...f.values]:[], wildcard:f.wildcard||'', type:f.type||'numeric'
    }));
  }
  function ensureThreeDrafts(){
    if(state.filterDraft.length)return;
    state.filterDraft=[filterDraftBlank(),filterDraftBlank(),filterDraftBlank()];
  }
  function detectFilterDraftType(draft){
    const selectedColumn=String(draft.column??'');
    const formula=String(draft.formula??'').trim();
    if(selectedColumn && state.types[selectedColumn]==='text' && (!formula || formula===selectedColumn)) return 'text';
    if(!formula) return state.types[selectedColumn]==='text'?'text':'numeric';
    const tokens=exactFormulaTokens(formula);
    if(!tokens) return 'numeric';
    const headers=tokens.filter(t=>t.type==='header').map(t=>t.value);
    const hasMath=tokens.some(t=>t.type==='op' && ['+','-','*','/','(',')'].includes(t.value));
    if(!hasMath && headers.length===1 && headers[0]===selectedColumn && state.types[selectedColumn]==='text') return 'text';
    if(headers.length && headers.every(h=>state.types[h]==='numeric')) return 'numeric';
    return 'text';
  }
  function formatDiagnosticNumber(v){return Number.isFinite(v)?Number(v).toLocaleString(undefined,{maximumFractionDigits:8}):'ERR';}
  function diagnosticRowLabel(row,index){
    const c=state.columns||{};
    const idHeader=c.store||c.profile||c.storeNumber||state.headers.find(h=>/store.*profile|profile.*number/i.test(h))||'';
    const id=idHeader?row[idHeader]:'';
    return id!==''&&id!==null&&id!==undefined?String(id):String(index+1);
  }
  function describeFilterRow(filter,row,index){
    if(filter.type==='text'){
      const actual=String(row[filter.column]??'');
      const pass=filter.values.some(v=>String(v)===actual);
      return `Line ${index+1}: ${filter.column}=${JSON.stringify(actual)} | selected=${filter.values.map(v=>JSON.stringify(v)).join(', ')} | result=${pass?'TRUE':'FALSE'}`;
    }
    const tokens=exactFormulaTokens(filter.formula||filter.column);
    const parts=[];
    for(const t of (tokens||[])){
      if(t.type==='header'&&!parts.some(p=>p[0]===t.value)) parts.push([t.value,toNumber(row[t.value])]);
    }
    const operands=parts.map(([h,v])=>`${h}=${formatDiagnosticNumber(v)}`).join(' ; ');
    const calc=evaluateRowFormula(filter.formula||filter.column,row);
    const target=Number(filter.value);
    const pass=Number.isFinite(calc)&&Number.isFinite(target)&&({ '<=':calc<=target, '=':calc===target, '>=':calc>=target, '<':calc<target, '>':calc>target }[filter.operator]??false);
    return `Line ${index+1}: ${filter.formula||filter.column} | ${operands} | calculation=${formatDiagnosticNumber(calc)} ${filter.operator} ${formatDiagnosticNumber(target)} | result=${pass?'TRUE':'FALSE'}`;
  }
  function toggleFilterDiagnostic(){
    const box=el('filterDiagnostic');
    const btn=el('filterDiagnosticToggle');
    if(!box||!btn)return;
    const show=box.classList.contains('hidden');
    box.classList.toggle('hidden',!show);
    btn.textContent=show?'Hide diagnostic':'Show diagnostic';
    if(show)updateFilterDiagnostic();
  }
  function updateFilterDiagnostic(){
    const box=el('filterDiagnostic'); if(!box)return;
    if(!state.rows.length){box.textContent='No loaded rows.';return;}
    const parsed=[];
    for(let i=0;i<(state.filterDraft||[]).length;i++){
      const d=state.filterDraft[i]; if(!String(d.formula??'').trim())continue;
      const p=validateFilterDraft(d,i); if(typeof p==='string'){box.textContent=`${p}\n\nLoaded rows: ${state.rows.length.toLocaleString()}`;return;}
      parsed.push(p);
    }
    if(!parsed.length){box.textContent=`Loaded rows: ${state.rows.length.toLocaleString()}\nNo completed filters yet.`;return;}
    let passCount=0;
    const lines=[`Loaded rows: ${state.rows.length.toLocaleString()}`,'',"FORMAT: row label | each filter actual inputs/calculation | final decision",''];
    state.rows.forEach((row,rowIndex)=>{
      let combined=rowMatchesFilter(parsed[0],row);
      const details=[diagnosticRowLabel(row,rowIndex),describeFilterRow(parsed[0],row,0)];
      for(let i=1;i<parsed.length;i++){
        const cur=rowMatchesFilter(parsed[i],row);
        combined=(parsed[i].connector||'AND')==='OR'?(combined||cur):(combined&&cur);
        details.push(`${parsed[i].connector||'AND'} ${describeFilterRow(parsed[i],row,i)}`);
      }
      if(combined)passCount++;
      details.push(`DECISION: ${combined?'INCLUDE':'EXCLUDE'}`);
      lines.push(details.join('\n')); lines.push('----------------------------------------');
    });
    lines.unshift(`Combined decision: ${passCount.toLocaleString()} INCLUDE / ${(state.rows.length-passCount).toLocaleString()} EXCLUDE`,'');
    box.textContent=lines.join('\n'); box.scrollTop=0;
  }
  function renderFilterRows(){
    const box=el('filterRows');if(!box)return;
    const rows=state.filterDraft||[];
    if(!rows.length){box.innerHTML='<div class="empty-message">No filter lines. Use Add filter to create one.</div>';return;}
    const numericCols=state.headers.filter(h=>state.types[h]==='numeric');
    const allCols=state.headers;
    box.innerHTML=rows.map((f,i)=>{
      const type=detectFilterDraftType(f);
      const formula=f.formula||'';
      const textValues=type==='text'?uniqueColumnValues(f.column||''):[];
      const selectedTextValues=Array.isArray(f.values)?f.values:[];
      const allTextValuesSelected=textValues.length>0 && textValues.every(v=>selectedTextValues.includes(v));
      const valuePicker=type==='text'
        ? `<button type="button" class="filter-value-select-button" data-index="${i}">${selectedTextValues.length?esc(selectedTextValues.join(', ')):'Select values...'}</button>`
        : `<input class="filter-value-input" data-index="${i}" type="number" step="any" placeholder="Enter value" value="${esc(f.value??'')}">`;
      const condition=`<select class="filter-condition" data-index="${i}">${FILTER_OPERATORS.map(op=>`<option value="${op}" ${f.operator===op?'selected':''}>${op}</option>`).join('')}</select>`;
      const connector=`<select class="filter-connector" data-index="${i}">${FILTER_CONNECTORS.map(op=>`<option value="${op}" ${f.connector===op?'selected':''}>${op}</option>`).join('')}</select>`;
      return `<div class="filter-line" data-index="${i}">
        <div class="filter-line-main">
          <select class="filter-column" data-index="${i}"><option value="">Choose column</option>${allCols.map(h=>`<option value="${esc(h)}" ${f.column===h?'selected':''}>${esc(h)}</option>`).join('')}</select>
          <input class="filter-formula" data-index="${i}" type="text" placeholder="Variable or Formula" value="${esc(formula)}" autocomplete="off">
          ${condition}
          <div class="filter-value-cell">${valuePicker}</div>
          ${connector}
          <button type="button" class="filter-delete" data-index="${i}">Delete</button>
        </div>
        <div class="filter-line-help">
          <select class="filter-operand-insert" data-index="${i}"><option value="">Insert numeric column...</option>${numericCols.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select>
          <span>Formula: (), +, -, *, /</span>
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('.filter-column').forEach(sel=>sel.addEventListener('change',e=>{
      const i=Number(e.target.dataset.index),f=state.filterDraft[i],h=e.target.value;f.column=h;f.formula=h;f.type=state.types[h]==='text'?'text':'numeric';f.value='';f.values=[];f.wildcard='';renderFilterRows();
    }));
    box.querySelectorAll('.filter-formula').forEach(inp=>inp.addEventListener('input',e=>{
      const i=Number(e.target.dataset.index);state.filterDraft[i].formula=e.target.value;state.filterDraft[i].type=detectFilterDraftType(state.filterDraft[i]);updateFilterDiagnostic();
    }));
    box.querySelectorAll('.filter-condition').forEach(sel=>sel.addEventListener('change',e=>{state.filterDraft[Number(e.target.dataset.index)].operator=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-value-input').forEach(inp=>inp.addEventListener('input',e=>{state.filterDraft[Number(e.target.dataset.index)].value=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-value-select-button').forEach(btn=>btn.addEventListener('click',e=>openFilterValuePicker(Number(e.target.dataset.index))));
    box.querySelectorAll('.filter-connector').forEach(sel=>sel.addEventListener('change',e=>{state.filterDraft[Number(e.target.dataset.index)].connector=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-delete').forEach(btn=>btn.addEventListener('click',e=>{state.filterDraft.splice(Number(e.target.dataset.index),1);renderFilterRows();}));
    box.querySelectorAll('.filter-operand-insert').forEach(sel=>sel.addEventListener('change',e=>{
      const i=Number(e.target.dataset.index),h=e.target.value;if(!h)return;const input=box.querySelector(`.filter-formula[data-index="${i}"]`);const current=String(state.filterDraft[i].formula||'').trim();const next=current?`${current}${h}`:h;state.filterDraft[i].formula=next;state.filterDraft[i].column=state.filterDraft[i].column||h;state.filterDraft[i].type='numeric';if(input)input.value=next;e.target.value='';
      updateFilterDiagnostic();
  }));
  }
  function openFilterValuePicker(index){
    const dialog=el('filterValueDialog'); if(!dialog)return;
    state.filterValuePickerIndex=index;
    const draft=state.filterDraft[index]||{};
    const title=el('filterValueDialogTitle'); if(title)title.textContent=draft.column||'Select values';
    const list=el('filterValuePickerList'); if(!list)return;
    const values=uniqueColumnValues(draft.column||'');
    const selected=new Set(Array.isArray(draft.values)?draft.values:[]);
    list.innerHTML=values.map(v=>`<label><input type="checkbox" class="filter-picker-check" value="${esc(v)}" ${selected.has(v)?'checked':''}><span>${esc(v||'(blank)')}</span></label>`).join('');
    const all=el('filterPickerSelectAll'); if(all)all.textContent=values.length&&values.every(v=>selected.has(v))?'Clear all':'Select all';
    dialog.showModal();
  }
  function applyFilterValuePicker(){
    const index=state.filterValuePickerIndex; if(index==null)return;
    const list=el('filterValuePickerList');
    state.filterDraft[index].values=[...list.querySelectorAll('.filter-picker-check:checked')].map(x=>x.value);
    state.filterValuePickerIndex=null;
    renderFilterRows(); updateFilterDiagnostic();
  }
  function validateFilterDraft(draft,index){
    const formula=String(draft.formula??'').trim();
    if(!formula)return null;
    const type=detectFilterDraftType(draft);
    if(type==='numeric'){
      const tokens=exactFormulaTokens(formula);
      if(!tokens)return `Filter ${index+1} has an invalid formula. Use exact workbook numeric column names, numbers, +, -, *, / and parentheses.`;
      const headersInFormula=[...new Set(tokens.filter(t=>t.type==='header').map(t=>t.value))];
      if(!headersInFormula.every(h=>state.types[h]==='numeric'))return `Filter ${index+1} can only use numeric workbook columns in a formula.`;
      const value=toNumber(draft.value);if(value===null)return `Filter ${index+1} needs a numeric value.`;
      return {connector:index===0?'AND':(draft.connector||'AND'),type:'numeric',column:draft.column||formula,formula,operator:draft.operator||'=',value};
    }
    const values=Array.isArray(draft.values)?draft.values:[];
    if(!values.length)return `Filter ${index+1} needs at least one selected value.`;
    return {connector:index===0?'AND':(draft.connector||'AND'),type:'text',column:draft.column,formula,operator:draft.operator||'=',values,wildcard:''};
  }
  function rowMatchesFilter(filter,row){
    if(filter.type==='numeric'){
      const n=evaluateRowFormula(filter.formula||filter.column,row);if(n===null)return false;
      const target=Number(filter.value);if(!Number.isFinite(target))return false;
      if(filter.operator==='<=')return n<=target;
      if(filter.operator==='=')return n===target;
      if(filter.operator==='>=')return n>=target;
      if(filter.operator==='<')return n<target;
      if(filter.operator==='>')return n>target;
      return false;
    }
    const s=String(row[filter.column]??'');
    return Array.isArray(filter.values) && filter.values.some(v=>String(v)===s);
  }
  function redrawAfterFilterChange(){
    // Rebuild the marker layer from the newly applied filters so filtered stores
    // are excluded from both the map and all viewport-based calculations.
    unspiderfyMarkers();
    rebuildMarkers();
  }
  function updateFilterUI(){
    const btn=el('filterBtn');if(btn)btn.disabled=!state.rows.length;
    const clearBtn=el('clearFiltersBtn');if(clearBtn)clearBtn.disabled=!state.rows.length;
  }
  function openFilterDialog(){
    const diag=el('filterDiagnostic');
    const toggle=el('filterDiagnosticToggle');
    if(diag)diag.classList.add('hidden');
    if(toggle)toggle.textContent='Show diagnostic';
    state.filterDraft=cloneFilterDrafts(state.filters);
    ensureThreeDrafts();
    renderFilterRows();
    el('filterDialog').showModal();
  }
  function applyFilters(){
    const errorBox=el('filterError');
    const diag=el('filterDiagnostic');
    if(errorBox)errorBox.textContent='';
    if(diag)diag.textContent='';
    const next=[];
    for(let i=0;i<state.filterDraft.length;i++){
      const draft=state.filterDraft[i];
      if(!String(draft.formula??'').trim())continue;
      const parsed=validateFilterDraft(draft,i);
      if(typeof parsed==='string'){
        if(errorBox)errorBox.textContent=parsed;
        const target=el(`filterDialog [data-index="${i}"]`);
        if(target&&typeof target.focus==='function')target.focus();
        return;
      }
      next.push(parsed);
    }
    const candidateCache=new WeakMap();
    let passingCount=0;
    for(const row of state.rows){
      const pass=next.length?rowPassesFiltersWithFilters(row,next):true;
      candidateCache.set(row,pass);
      if(pass)passingCount++;
    }
    if(next.length && passingCount===0){
      if(errorBox)errorBox.textContent='No loaded store rows meet these filters. Check the formula, exact column headings, condition, and value.';
      if(diag)diag.textContent=`Diagnostic: 0 of ${state.rows.length.toLocaleString()} loaded stores meet all filter lines.`;
      return;
    }
    if(diag)diag.textContent=next.length?`Diagnostic: ${passingCount.toLocaleString()} of ${state.rows.length.toLocaleString()} loaded stores meet all filter lines.`:'';
    state.filters=next;
    state.filterPassCache=candidateCache;
    if(state.storeJumpTarget && !rowPassesFilters(state.storeJumpTarget)){
      clearRadius();state.storeJumpTarget=null;
    }
    redrawAfterFilterChange();
    updateSelection();
    updateFilterUI();
    el('filterDialog').close();
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

  function populateMarkerAnimationControls(){
    const col=el('markerAnimationColumn'),ins=el('markerAnimationOperandInsert');
    if(!col||!ins)return;
    const a=state.markerAnimation;
    col.innerHTML='<option value="">Choose column</option>'+state.headers.map(h=>`<option value="${esc(h)}" ${a.column===h?'selected':''}>${esc(h)}</option>`).join('');
    const nums=state.headers.filter(h=>state.types[h]==='numeric');
    ins.innerHTML='<option value="">Insert numeric column...</option>'+nums.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');
    const type=state.types[a.column]==='text'&&!markerAnimationFormulaIsValid()?'text':'numeric';
    a.typeMode=type;
    if(type==='text'&&a.formula===a.column){
      el('markerAnimationValueCell')?.classList.add('hidden');
      el('markerAnimationValueButton')?.classList.remove('hidden');
      el('markerAnimationValueButton').textContent=a.values.length?`${a.values.length} value${a.values.length===1?'':'s'} selected`:'Select values...';
    }else{
      el('markerAnimationValueCell')?.classList.remove('hidden');
      el('markerAnimationValueButton')?.classList.add('hidden');
      el('markerAnimationValue').value=a.value||'';
    }
    el('markerAnimationEnabled').checked=!!a.enabled;
    el('markerAnimationType').value=a.type;
    const typeSummary=el('markerAnimationTypeSummary'); if(typeSummary) typeSummary.textContent=a.type==='fade'?'Fade':'Ripple';
    el('markerAnimationFormula').value=a.formula||'';
    el('markerAnimationCondition').value=a.operator||'=';
    el('markerAnimationStatus').textContent=markerAnimationConditionSummary();
  }
  function openMarkerAnimationValuePicker(){
    const dialog=el('markerAnimationValueDialog'), a=state.markerAnimation;
    if(!dialog||!a.column)return;
    el('markerAnimationValueDialogTitle').textContent=a.column;
    const vals=uniqueColumnValues(a.column), selected=new Set(a.values||[]);
    el('markerAnimationValuePickerList').innerHTML=vals.map(v=>`<label><input type="checkbox" class="marker-animation-picker-check" value="${esc(v)}" ${selected.has(v)?'checked':''}><span>${esc(v||'(blank)')}</span></label>`).join('');
    const all=el('markerAnimationSelectAll');
    all.textContent=vals.length&&vals.every(v=>selected.has(v))?'Clear all':'Select all';
    dialog.showModal();
  }
  function refreshMarkerAnimationUI(){rebuildMarkerAnimationCache();populateMarkerAnimationControls();refreshMarkerStyles();}
  function wireMarkerAnimationControls(){
    el('markerAnimationEnabled').addEventListener('change',e=>{state.markerAnimation.enabled=!!e.target.checked;saveMarkerAnimationConfig();rebuildMarkerAnimationCache();refreshMarkerAnimationUI();});
    el('markerAnimationType').addEventListener('change',e=>{state.markerAnimation.type=e.target.value;saveMarkerAnimationConfig();refreshMarkerStyles();populateMarkerAnimationControls();});
    el('markerAnimationColumn').addEventListener('change',e=>{const h=e.target.value;state.markerAnimation.column=h;state.markerAnimation.formula=h;state.markerAnimation.value='';state.markerAnimation.values=[];state.markerAnimation.typeMode=state.types[h]==='text'?'text':'numeric';saveMarkerAnimationConfig();refreshMarkerAnimationUI();});
    el('markerAnimationFormula').addEventListener('input',e=>{state.markerAnimation.formula=e.target.value;state.markerAnimation.typeMode=detectFilterDraftType({column:state.markerAnimation.column,formula:e.target.value})==='text'?'text':'numeric';populateMarkerAnimationControls();});
    el('markerAnimationCondition').addEventListener('change',e=>{state.markerAnimation.operator=e.target.value;saveMarkerAnimationConfig();refreshMarkerAnimationUI();});
    el('markerAnimationValue').addEventListener('input',e=>{state.markerAnimation.value=e.target.value;el('markerAnimationStatus').textContent=markerAnimationConditionSummary();});
    el('markerAnimationOperandInsert').addEventListener('change',e=>{const h=e.target.value;if(!h)return;const current=String(state.markerAnimation.formula||'').trim();const next=current?`${current}${h}`:h;state.markerAnimation.formula=next;state.markerAnimation.typeMode='numeric';e.target.value='';refreshMarkerAnimationUI();});
    el('markerAnimationValueButton').addEventListener('click',e=>{e.preventDefault();openMarkerAnimationValuePicker();});
    el('markerAnimationConfigureBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();populateMarkerAnimationControls();el('markerAnimationDialog').showModal();});
    el('markerAnimationApply').addEventListener('click',e=>{e.preventDefault();const a=state.markerAnimation;const formula=String(a.formula||'').trim();if(!formula){el('markerAnimationDialogStatus').textContent='Choose a column or enter a formula.';return;}if(a.typeMode==='numeric'&&!tickerFormulaValid(formula)){el('markerAnimationDialogStatus').textContent='Invalid formula. Use exact workbook column headings and (), +, -, *, /. ';return;}if(a.typeMode==='numeric'&&!Number.isFinite(Number(a.value))){el('markerAnimationDialogStatus').textContent='Enter a numeric comparison value.';return;}if(a.typeMode==='text'&&(!a.column||!a.values.length)){el('markerAnimationDialogStatus').textContent='Choose one or more values.';return;}saveMarkerAnimationConfig();rebuildMarkerAnimationCache();populateMarkerAnimationControls();refreshMarkerStyles();el('markerAnimationDialog').close();});
    el('markerAnimationSelectAll').addEventListener('click',e=>{const checks=[...document.querySelectorAll('.marker-animation-picker-check')];const all=checks.length&&checks.every(c=>c.checked);checks.forEach(c=>c.checked=!all);e.currentTarget.textContent=all?'Select all':'Clear all';});
    el('markerAnimationValueApply').addEventListener('click',e=>{e.preventDefault();state.markerAnimation.values=[...document.querySelectorAll('.marker-animation-picker-check:checked')].map(x=>x.value);state.markerAnimation.typeMode='text';saveMarkerAnimationConfig();el('markerAnimationValueDialog').close();refreshMarkerAnimationUI();});
    el('markerAnimationValueCancel').addEventListener('click',e=>{e.preventDefault();el('markerAnimationValueDialog').close();});
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

  // ---------- Ticker ----------
  const TICKER_STORAGE_KEY='cse_ticker_config_v075_exact';
  const TICKER_OLD_STORAGE_KEYS=['cse_ticker_config_v074_exact','cse_ticker_config_v075_exact','cse_ticker_config_v075_exact'];
  const TICKER_DEFAULT_SPEED=70;
  const TICKER_DEFAULTS=[
    {titleMode:'column',title:'',formula:'',aggregation:'sum',numberFormat:'auto',decimalPlaces:0},
    {titleMode:'column',title:'',formula:'',aggregation:'average',numberFormat:'auto',decimalPlaces:0},
    {titleMode:'manual',title:'Stores',formula:'1',aggregation:'sum',numberFormat:'number',decimalPlaces:0}
  ];
  function loadTickerConfig(){
    try{
      let raw=localStorage.getItem(TICKER_STORAGE_KEY);
      if(!raw){for(const key of TICKER_OLD_STORAGE_KEYS){raw=localStorage.getItem(key);if(raw)break;}}
      const parsed=raw?JSON.parse(raw):null;
      const metrics=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.metrics)?parsed.metrics:null);
      state.tickerMetrics=metrics&&metrics.length?metrics.map(normalizeTickerMetric):TICKER_DEFAULTS.map(normalizeTickerMetric);
      const speed=Array.isArray(parsed)?TICKER_DEFAULT_SPEED:Number(parsed?.speed);
      state.tickerSpeed=Number.isFinite(speed)?Math.min(120,Math.max(50,speed)):TICKER_DEFAULT_SPEED;
      state.tickerConfigDraftSpeed=state.tickerSpeed;
    }catch(_){state.tickerMetrics=TICKER_DEFAULTS.map(normalizeTickerMetric);state.tickerSpeed=TICKER_DEFAULT_SPEED;state.tickerConfigDraftSpeed=TICKER_DEFAULT_SPEED;}
  }
  function saveTickerConfig(){localStorage.setItem(TICKER_STORAGE_KEY,JSON.stringify({metrics:state.tickerMetrics,speed:state.tickerSpeed}));}
  function defaultTickerDecimals(format){
    if(format==='percentage')return 1;
    return 0;
  }
  function normalizeTickerMetric(m){
    const aggregation=['sum','average','median'].includes(m?.aggregation)?m.aggregation:'sum';
    const numberFormat=['auto','number','currency','percentage'].includes(m?.numberFormat)?m.numberFormat:'auto';
    const rawDecimals=Number(m?.decimalPlaces);
    const decimalPlaces=Number.isInteger(rawDecimals)&&rawDecimals>=0&&rawDecimals<=4?rawDecimals:defaultTickerDecimals(numberFormat);
    return {titleMode:m?.titleMode==='manual'?'manual':'column',title:String(m?.title??''),formula:m?.formula===null?'':String(m?.formula??''),aggregation,numberFormat,decimalPlaces};
  }
  function tickerColumns(){return state.headers.filter(h=>state.types[h]==='numeric');}
  function tickerDefaultMetrics(){
    const sales=state.columns.sales||'';
    const ebit=state.columns.ebit||'';
    return [
      {titleMode:'column',title:'',formula:sales,aggregation:'sum',numberFormat:'auto',decimalPlaces:0},
      {titleMode:'column',title:'',formula:ebit,aggregation:'average',numberFormat:'auto',decimalPlaces:0},
      {titleMode:'manual',title:'Stores',formula:'1',aggregation:'sum',numberFormat:'number',decimalPlaces:0}
    ];
  }
  function tickerDefaultFormula(){return tickerColumns()[0]||'';}
  // Shared exact-header formula tokenizer used by both ticker and filters.
  // A workbook header is accepted only as a complete operand: the characters
  // immediately before/after it must be expression boundaries. This prevents
  // partial or wildcard header matching and avoids prefix collisions such as
  // `Sales` vs `Sales Growth`.
  function exactTickerHeaderAt(expr,index){
    const text=String(expr??'');
    const rest=text.slice(index);
    let best=null;
    for(const h of state.headers){
      if(!h)continue;
      if(!rest.startsWith(h))continue;
      const before=index>0?text[index-1]:'';
      const after=index+h.length<text.length?text[index+h.length]:'';
      const isBoundaryBefore=!before||/[\s()+\-*/×÷]/.test(before);
      const isBoundaryAfter=!after||/[\s()+\-*/×÷]/.test(after);
      if(!isBoundaryBefore||!isBoundaryAfter)continue;
      if(!best||h.length>best.length)best=h;
    }
    return best;
  }
  function tokenizeTicker(expr){
    const tokens=[];let i=0;
    while(i<expr.length){
      while(i<expr.length&&/\s/.test(expr[i]))i++;
      if(i>=expr.length)break;
      const ch=expr[i];
      if(/[()+*/×÷]/.test(ch)){tokens.push({type:'op',value:ch==='×'?'*':ch==='÷'?'/':ch});i++;continue;}
      if(ch==='-'){
        tokens.push({type:'op',value:'-'});i++;continue;
      }
      const header=exactTickerHeaderAt(expr,i);
      if(header){tokens.push({type:'operand',value:header});i+=header.length;continue;}
      const num=expr.slice(i).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
      if(num){tokens.push({type:'operand',value:num[0]});i+=num[0].length;continue;}
      return null;
    }
    return tokens;
  }
  function tickerFormulaValid(expr){
    if(!expr||!expr.trim())return false;
    const tokens=tokenizeTicker(expr);if(!tokens||!tokens.length)return false;
    const cols=new Set(state.headers);let depth=0,expectOperand=true,seen=false;
    for(const t of tokens){
      if(t.type==='operand'){
        if(!cols.has(t.value)&&!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))return false;
        if(!expectOperand)return false;
        expectOperand=false;seen=true;continue;
      }
      if(t.value==='('){if(!expectOperand)return false;depth++;continue;}
      if(t.value===')'){if(expectOperand||depth===0)return false;depth--;expectOperand=false;continue;}
      if(expectOperand&&t.value!=='-')return false;
      expectOperand=true;
    }
    return seen&&depth===0&&!expectOperand;
  }
  function evaluateTickerExpression(expr,operandValues){
    const tokens=tokenizeTicker(expr),values=[],ops=[];
    if(!tokens)return NaN;
    const prec=o=>(o==='+'||o==='-')?1:2;
    const apply=()=>{
      const op=ops.pop(),b=values.pop(),a=values.pop();
      if(!Number.isFinite(a)||!Number.isFinite(b)){values.push(NaN);return;}
      if(op==='+')values.push(a+b);
      else if(op==='-')values.push(a-b);
      else if(op==='*')values.push(a*b);
      else if(op==='/')values.push(b===0?NaN:a/b);
    };
    try{
      for(const t of tokens){
        if(t.type==='operand'){
          if(/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))values.push(Number(t.value));
          else values.push(operandValues.has(t.value)?operandValues.get(t.value):NaN);
          continue;
        }
        if(t.value==='-' && (values.length===0 || ops.at(-1)==='(' || ['+','-','*','/'].includes(ops.at(-1)))){
          // Unary minus: encode as 0 - operand through a low-complexity sentinel.
          values.push(0);
          ops.push('-');
          continue;
        }
        if(t.value==='('){ops.push(t.value);continue;}
        if(t.value===')'){
          while(ops.length&&ops.at(-1)!=='(')apply();
          if(ops.at(-1)!=='(')return NaN;
          ops.pop();
          continue;
        }
        while(ops.length&&ops.at(-1)!=='('&&prec(ops.at(-1))>=prec(t.value))apply();
        ops.push(t.value);
      }
      while(ops.length){if(ops.at(-1)==='(')return NaN;apply();}
      return values.length===1?values[0]:NaN;
    }catch(_){return NaN;}
  }
  function aggregateTickerOperand(header,rows,aggregation){
    const vals=rows.map(r=>toNumber(r[header])).filter(v=>Number.isFinite(v));
    if(!vals.length)return NaN;
    if(aggregation==='average')return avg(vals);
    if(aggregation==='median')return median(vals);
    return vals.reduce((a,b)=>a+b,0);
  }
  function evaluateTickerFormula(expr,rows,aggregation='sum'){
    const tokens=tokenizeTicker(expr);if(!tokens)return NaN;
    const operandValues=new Map();
    for(const t of tokens){
      if(t.type!=='operand'||/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))continue;
      if(!operandValues.has(t.value))operandValues.set(t.value,aggregateTickerOperand(t.value,rows,aggregation));
    }
    return evaluateTickerExpression(expr,operandValues);
  }
  function formatTickerValue(value,format='auto',formula='',decimalPlaces=0){
    if(!Number.isFinite(value))return '—';
    const decimals=Number.isInteger(decimalPlaces)?Math.min(4,Math.max(0,decimalPlaces)):defaultTickerDecimals(format);
    if(format==='percentage')return `${(value*100).toFixed(decimals)}%`;
    if(format==='currency')return new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:decimals,minimumFractionDigits:decimals}).format(value);
    if(format==='number')return new Intl.NumberFormat('en-CA',{maximumFractionDigits:decimals,minimumFractionDigits:decimals}).format(value);
    const f=norm(formula||'');
    if(f.includes('%')||f.includes('margin')||f.includes('rate'))return `${Math.abs(value)<=1.5?(value*100).toFixed(Math.max(1,decimals)):value.toFixed(Math.max(1,decimals))}%`;
    if(f.includes('sales')||f.includes('profit')||f.includes('ebit')||f.includes('expense')||f.includes('wage')||f.includes('income')||f.includes('cogs')||f.includes('sga'))return new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:decimals,minimumFractionDigits:decimals}).format(value);
    if(Math.abs(value)>=1000000)return new Intl.NumberFormat('en-CA',{notation:'compact',maximumFractionDigits:decimals,minimumFractionDigits:Math.min(1,decimals)}).format(value);
    return new Intl.NumberFormat('en-CA',{maximumFractionDigits:decimals,minimumFractionDigits:decimals}).format(value);
  }
  function tickerMetricTitle(m){
    if(m.titleMode==='manual'&&m.title.trim())return m.title.trim();
    const tokens=tokenizeTicker(m.formula||'')||[];
    const first=tokens.find(t=>t.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value));
    return first?.value||'Metric';
  }
  function tickerItems(){return (state.tickerMetrics||[]).filter(m=>m.formula);}
  function buildTickerTrack(){
    const track=el('tickerTrack');if(!track)return;
    const items=tickerItems();
    if(!items.length||!state.rows.length){track.innerHTML='<div class="ticker-empty">Load a financial workbook to see ticker metrics.</div>';state.tickerLoopWidth=0;state.tickerOffset=0;return;}
    const cards=items.map((m,idx)=>{const valueClass=idx%2===0?'ticker-value-red':'ticker-value-yellow';return `<div class="ticker-metric" data-ticker-index="${idx}"><div class="ticker-value ${valueClass}" data-ticker-value="1"></div><div class="ticker-title">${esc(tickerMetricTitle(m))}</div></div>`;}).join('');
    track.innerHTML=cards+cards;
    requestAnimationFrame(()=>{state.tickerLoopWidth=track.scrollWidth/2;state.tickerOffset=state.tickerLoopWidth?((state.tickerOffset%state.tickerLoopWidth)+state.tickerLoopWidth)%state.tickerLoopWidth:0;track.style.transform=`translate3d(${-state.tickerOffset}px,0,0)`;updateTickerValues();});
  }
  function updateTickerValues(){
    const track=el('tickerTrack');if(!track)return;
    const items=tickerItems();
    if(!items.length||!state.rows.length){if(!track.querySelector('.ticker-empty'))buildTickerTrack();return;}
    const rows=state.selectedRows;
    track.querySelectorAll('.ticker-metric').forEach(card=>{
      const idx=Number(card.dataset.tickerIndex);
      const m=items[idx]; if(!m)return;
      const value=evaluateTickerFormula(m.formula,rows,m.aggregation);
      const node=card.querySelector('[data-ticker-value]');
      if(node)node.textContent=formatTickerValue(value,m.numberFormat,m.formula,m.decimalPlaces);
    });
  }
  function renderTicker(options={rebuild:false}){
    const track=el('tickerTrack');if(!track)return;
    const items=tickerItems();
    if(options.rebuild || !track.querySelector('.ticker-metric') || track.children.length !== items.length*2){buildTickerTrack();return;}
    updateTickerValues();
  }
  function tickerAnimate(ts){
    const track=el('tickerTrack');if(!track)return;
    if(state.tickerLastTime===null)state.tickerLastTime=ts;
    const dt=Math.min(64,ts-state.tickerLastTime);state.tickerLastTime=ts;
    if(state.tickerPlaying&&state.tickerLoopWidth){state.tickerOffset=(state.tickerOffset+(dt*(state.tickerSpeed/1000)))%state.tickerLoopWidth;track.style.transform=`translate3d(${-state.tickerOffset}px,0,0)`;}
    state.tickerAnimationFrame=requestAnimationFrame(tickerAnimate);
  }
  function openTickerConfig(){
    if(!state.headers.length||!state.rows.length){alert('Load a financial workbook before configuring the ticker.');return;}
    state.tickerConfigDraft=state.tickerMetrics.map(normalizeTickerMetric);
    state.tickerConfigDraftSpeed=state.tickerSpeed;
    renderTickerConfig();
    el('tickerDialog').showModal();
  }
  function renderTickerConfig(){
    const wrap=el('tickerMetricList');if(!wrap)return;const cols=state.headers.length?state.headers:[];
    wrap.replaceChildren();
    if(!cols.length){wrap.innerHTML='<div class="empty-message">Load a financial workbook first. The ticker uses workbook columns as operands.</div>';return;}
    state.tickerConfigDraft.forEach((m,idx)=>{
      const row=document.createElement('div');row.className='ticker-config-row';row.draggable=true;row.dataset.index=idx;
      row.innerHTML=`<div class="ticker-row-head"><strong>Metric ${idx+1}</strong><span class="ticker-drag-handle" title="Drag to reorder" aria-hidden="true">↕</span><button type="button" class="icon-btn ticker-remove" data-index="${idx}" aria-label="Remove metric">×</button></div>
        <div class="ticker-row-grid"><label>Title mode<select class="ticker-title-mode" data-index="${idx}"><option value="column" ${m.titleMode!=='manual'?'selected':''}>Use operand column title</option><option value="manual" ${m.titleMode==='manual'?'selected':''}>Enter custom title</option></select></label><label>Title<input class="ticker-title-input" data-index="${idx}" value="${esc(m.title)}" placeholder="Optional custom title"></label></div>
        <label>Formula<input class="ticker-formula-input" data-index="${idx}" value="${esc(m.formula)}" placeholder="Choose a numeric column or combine columns with + - × / ( )"></label>
        <div class="ticker-operand-help"><span>Numeric columns:</span><select class="ticker-operand-select" data-index="${idx}"><option value="">Insert column…</option>${cols.filter(h=>state.types[h]==='numeric').map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select><span>Use +, -, ×, / and parentheses.</span></div>
        <div class="ticker-row-grid ticker-aggregation-row"><label>Aggregation<select class="ticker-aggregation-select" data-index="${idx}"><option value="sum" ${m.aggregation==='sum'?'selected':''}>Sum</option><option value="average" ${m.aggregation==='average'?'selected':''}>Average</option><option value="median" ${m.aggregation==='median'?'selected':''}>Median</option></select></label><label>Number format<select class="ticker-number-format-select" data-index="${idx}"><option value="auto" ${m.numberFormat==='auto'?'selected':''}>Auto</option><option value="number" ${m.numberFormat==='number'?'selected':''}>Number</option><option value="currency" ${m.numberFormat==='currency'?'selected':''}>Currency</option><option value="percentage" ${m.numberFormat==='percentage'?'selected':''}>Percentage</option></select></label><label>Decimals<select class="ticker-decimal-select" data-index="${idx}">${[0,1,2,3,4].map(n=>`<option value="${n}" ${m.decimalPlaces===n?'selected':''}>${n}</option>`).join('')}</select></label></div>`;
      wrap.appendChild(row);
    });
    const speedInput=el('tickerSpeed');const speedValue=el('tickerSpeedValue');if(speedInput){speedInput.value=String(state.tickerConfigDraftSpeed);if(speedValue)speedValue.textContent=String(state.tickerConfigDraftSpeed);}
    wrap.querySelectorAll('.ticker-title-mode').forEach(s=>s.addEventListener('change',e=>{state.tickerConfigDraft[+e.target.dataset.index].titleMode=e.target.value;}));
    wrap.querySelectorAll('.ticker-title-input').forEach(s=>s.addEventListener('input',e=>{state.tickerConfigDraft[+e.target.dataset.index].title=e.target.value;}));
    wrap.querySelectorAll('.ticker-formula-input').forEach(s=>s.addEventListener('input',e=>{state.tickerConfigDraft[+e.target.dataset.index].formula=e.target.value;}));
    wrap.querySelectorAll('.ticker-aggregation-select').forEach(s=>s.addEventListener('change',e=>{state.tickerConfigDraft[+e.target.dataset.index].aggregation=e.target.value;}));
    wrap.querySelectorAll('.ticker-number-format-select').forEach(s=>s.addEventListener('change',e=>{const i=+e.target.dataset.index;const m=state.tickerConfigDraft[i];m.numberFormat=e.target.value;m.decimalPlaces=defaultTickerDecimals(m.numberFormat);}));
    wrap.querySelectorAll('.ticker-decimal-select').forEach(s=>s.addEventListener('change',e=>{state.tickerConfigDraft[+e.target.dataset.index].decimalPlaces=Number(e.target.value);}));
    wrap.querySelectorAll('.ticker-operand-select').forEach(s=>s.addEventListener('change',e=>{const i=+e.target.dataset.index;if(e.target.value){const input=wrap.querySelector(`.ticker-formula-input[data-index="${i}"]`);const current=input.value.trim();input.value=current?`${current}${e.target.value}`:e.target.value;state.tickerConfigDraft[i].formula=input.value;}e.target.value='';}));
    wrap.querySelectorAll('.ticker-remove').forEach(b=>b.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
      const i=Number(b.dataset.index);
      if(!Number.isInteger(i)||i<0||i>=state.tickerConfigDraft.length)return;
      state.tickerConfigDraft.splice(i,1);
      renderTickerConfig();
    }));
    let dragFrom=-1;
    wrap.querySelectorAll('.ticker-config-row').forEach(row=>{
      row.addEventListener('dragstart',e=>{dragFrom=Number(row.dataset.index);row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.index);});
      row.addEventListener('dragend',()=>{dragFrom=-1;row.classList.remove('dragging');});
      row.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('drag-over');});
      row.addEventListener('dragleave',()=>row.classList.remove('drag-over'));
      row.addEventListener('drop',e=>{
        e.preventDefault();row.classList.remove('drag-over');
        const from=dragFrom>=0?dragFrom:Number(e.dataTransfer.getData('text/plain'));
        const to=Number(row.dataset.index);
        if(!Number.isInteger(from)||!Number.isInteger(to)||from===to||from<0||to<0||from>=state.tickerConfigDraft.length||to>=state.tickerConfigDraft.length)return;
        const [moved]=state.tickerConfigDraft.splice(from,1);
        state.tickerConfigDraft.splice(to,0,moved);
        renderTickerConfig();
      });
    });
  }
  function validateTickerDraft(){
    if(!state.headers.length)return 'Load a financial workbook before saving the ticker.';
    if(!state.tickerConfigDraft.length)return 'Add at least one ticker metric.';
    const exactHeaders=new Set(state.headers);
    for(const [i,m] of state.tickerConfigDraft.entries()){
      const formula=String(m.formula||'').trim();
      if(!formula)return `Metric ${i+1} needs a formula.`;
      if(!tickerFormulaValid(formula))return `Metric ${i+1} has an invalid formula. Choose operands from the exact workbook column headings and use +, -, ×, ÷ and parentheses.`;
      const tokens=tokenizeTicker(formula)||[];
      for(const t of tokens){
        if(t.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value)&&!exactHeaders.has(t.value)){
          return `Metric ${i+1} uses a column that is not present in the workbook: ${t.value}`;
        }
      }
    }
    return '';
  }
  function applyTickerConfig(){
    const error=validateTickerDraft();
    if(error){alert(error);return;}
    state.tickerMetrics=state.tickerConfigDraft.map(normalizeTickerMetric);
    state.tickerSpeed=Math.min(120,Math.max(50,Number(state.tickerConfigDraftSpeed)||TICKER_DEFAULT_SPEED));
    saveTickerConfig();
    state.tickerOffset=0;
    renderTicker({rebuild:true});
    el('tickerDialog').close();
  }
  function resetTickerDefaults(){
    state.tickerConfigDraft=(state.headers.length?tickerDefaultMetrics():TICKER_DEFAULTS).map(normalizeTickerMetric);
    state.tickerConfigDraftSpeed=TICKER_DEFAULT_SPEED;
    renderTickerConfig();
  }
  function tickerToggle(){
    state.tickerPlaying=!state.tickerPlaying;
    state.tickerLastTime=null;
    const vp=el('tickerViewport');
    if(vp)vp.classList.toggle('paused',!state.tickerPlaying);
    if(vp)vp.setAttribute('aria-label',state.tickerPlaying?'Ticker metrics — click to pause':'Ticker metrics — click to resume; drag while paused');
  }
  function setupTicker(){
    loadTickerConfig();
    renderTicker();
    state.tickerAnimationFrame=requestAnimationFrame(tickerAnimate);
    const vp=el('tickerViewport');
    if(!vp)return;
    vp.setAttribute('aria-label','Ticker metrics — click to pause');
    let suppressNextClick=false;
    vp.addEventListener('pointerdown',e=>{
      if(state.tickerPlaying)return;
      state.tickerPointerId=e.pointerId;
      state.tickerDragStart={x:e.clientX,offset:state.tickerOffset,moved:false};
      try{vp.setPointerCapture(e.pointerId);}catch(_){ }
    });
    vp.addEventListener('pointermove',e=>{
      if(state.tickerPointerId!==e.pointerId||!state.tickerDragStart)return;
      const dx=e.clientX-state.tickerDragStart.x;
      if(Math.abs(dx)>3)state.tickerDragStart.moved=true;
      if(!state.tickerDragStart.moved)return;
      const width=state.tickerLoopWidth;
      state.tickerOffset=width?((state.tickerDragStart.offset-dx)%width+width)%width:state.tickerDragStart.offset-dx;
      el('tickerTrack').style.transform=`translate3d(${-state.tickerOffset}px,0,0)`;
    });
    vp.addEventListener('pointerup',e=>{
      if(state.tickerPointerId!==e.pointerId)return;
      const moved=!!state.tickerDragStart.moved;
      state.tickerPointerId=null;
      state.tickerDragStart=null;
      if(moved)suppressNextClick=true;
      try{vp.releasePointerCapture(e.pointerId);}catch(_){ }
      if(moved)setTimeout(()=>{suppressNextClick=false;},250);
    });
    vp.addEventListener('pointercancel',e=>{
      if(state.tickerPointerId===e.pointerId){state.tickerPointerId=null;state.tickerDragStart=null;}
    });
    vp.addEventListener('click',e=>{
      if(suppressNextClick){e.preventDefault();e.stopPropagation();return;}
      tickerToggle();
    });
    el('tickerConfigBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openTickerConfig();});
    el('tickerAddMetric').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();state.tickerConfigDraft.push({titleMode:'column',title:'',formula:tickerDefaultFormula(),aggregation:'sum',numberFormat:'auto',decimalPlaces:0});renderTickerConfig();});
    el('tickerSpeed').addEventListener('input',e=>{state.tickerConfigDraftSpeed=Number(e.target.value)||TICKER_DEFAULT_SPEED;el('tickerSpeedValue').textContent=`${state.tickerConfigDraftSpeed}`;});
    el('tickerReset').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();resetTickerDefaults();});
    el('tickerApply').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applyTickerConfig();});
  }
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
  el('groupsApply').addEventListener('click',()=>{state.groups=[...new Set(checkedValues('groupsList'))];state.distributionBinKey=null;state.distributionBinKey2=null;state.selectedGroupKey=null;state.selectedStoreRow=null;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('distributionBtn').addEventListener('click',()=>{state.distributionDialogTarget=1;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionBtn2').addEventListener('click',()=>{state.distributionDialogTarget=2;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionSearch').addEventListener('input',e=>renderDistributionList(e.target.value));
  el('distributionClear').addEventListener('click',()=>{if(state.distributionDialogTarget===2){state.distributionSubject2=null;state.distributionBinKey2=null;}else{state.distributionSubject=null;state.distributionBinKey=null;}renderDistributionList(el('distributionSearch').value);updateDistribution();refreshConfigUI();refreshMarkerStyles();});
  el('distributionApply').addEventListener('click',()=>{const checked=el('distributionList').querySelector('input[type=radio]:checked');if(state.distributionDialogTarget===2){state.distributionSubject2=checked?checked.value:null;state.distributionBinKey2=null;}else{state.distributionSubject=checked?checked.value:null;state.distributionBinKey=null;}state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionBinKey=state.distributionDialogTarget===2?null:state.distributionBinKey;state.distributionBinKey2=state.distributionDialogTarget===1?null:state.distributionBinKey2;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('filterBtn').addEventListener('click',()=>openFilterDialog());
  el('filterDiagnosticToggle').addEventListener('click',toggleFilterDiagnostic);
  el('clearFiltersBtn').addEventListener('click',()=>{state.filters=[];state.filterDraft=[];rebuildFilterPassCache();redrawAfterFilterChange();updateSelection();updateFilterUI();});
  el('addFilterBtn').addEventListener('click',()=>{state.filterDraft.push(filterDraftBlank());renderFilterRows();});
  el('clearAllFilters').addEventListener('click',()=>{state.filterDraft=[filterDraftBlank(),filterDraftBlank(),filterDraftBlank()];const errorBox=el('filterError');if(errorBox)errorBox.textContent='';renderFilterRows();});
  el('applyFiltersBtn').addEventListener('click',()=>{applyFilters();});
  el('filterPickerSelectAll').addEventListener('click',()=>{const list=el('filterValuePickerList');const checks=[...list.querySelectorAll('.filter-picker-check')];const all=checks.length&&checks.every(c=>c.checked);checks.forEach(c=>c.checked=!all);el('filterPickerSelectAll').textContent=all?'Select all':'Clear all';});
  el('filterPickerApply').addEventListener('click',e=>{e.preventDefault();applyFilterValuePicker();el('filterValueDialog').close();});
  el('filterPickerCancel').addEventListener('click',e=>{e.preventDefault();state.filterValuePickerIndex=null;el('filterValueDialog').close();});

  if(typeof L==='undefined')el('geoStatus').textContent='Mapping library did not load. Refresh the page and try again.';
  if(typeof XLSX==='undefined')el('fileStatus').textContent='Excel reader library did not load. Refresh the page and try again.';
  if(typeof turf==='undefined')el('censusNote').textContent='Geospatial calculation library did not load. Refresh the page and try again.';
  loadMarkerAnimationConfig();
  populateMarkerAnimationControls();
  wireMarkerAnimationControls();
  setupTicker();
  loadHeaderCsdLookup();
  loadProvinces();
  updateSelection();
  updateHeaderGeography();
})();

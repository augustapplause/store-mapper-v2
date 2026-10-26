/* Store Explorer - v1.85
   Financial workbook processing is entirely client-side. Workbook data is never uploaded.
   DA spatial selection remains independent of store/KPI selection; Census attributes are read only after DA selection:
   province -> provincial DA GeoJSON -> browser spatial index -> active boundary intersections -> >=50% overlap -> selected DA geometries.
*/
(() => {
  'use strict';

  const CONFIG = {
    canadaBounds: [[41.6, -141.2], [83.2, -52.3]],
    statcanBase: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer',
    provinceLayer: 0,
    csdLayer: 9,
    geocodeUrl: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
    daReleaseBase: 'https://github.com/augustapplause/store-mapper-v2/releases/download/DA-data-v1',
    daFiles: {
      AB:'AB_da_census_13vars_30m.geojson', BC:'BC_da_census_13vars_30m.geojson', MB:'MB_da_census_13vars_30m.geojson',
      NB:'NB_da_census_13vars_30m.geojson', NL:'NL_da_census_13vars_30m.geojson', NS:'NS_da_census_13vars_30m.geojson',
      NT:'NT_da_census_13vars_30m.geojson', NU:'NU_da_census_13vars_30m.geojson', ON:'ON_da_census_13vars_30m.geojson',
      PE:'PE_da_census_13vars_30m.geojson', QC:'QC_da_census_13vars_30m.geojson', SK:'SK_da_census_13vars_30m.geojson',
      YT:'YT_da_census_13vars_30m.geojson'
    },
    prCodeByUid: {'10':'NL','11':'PE','12':'NS','13':'NB','24':'QC','35':'ON','46':'MB','47':'SK','48':'AB','59':'BC','60':'YT','61':'NT','62':'NU'},
    csdMinZoom: 6
  };

  const state = {
    rows: [], headers: [], types: {}, columns: {}, fileName: null,
    subjects: [], groups: [], distributionSubject: null, distributionBinKey: null, distributionSubject2: null, distributionBinKey2: null, distributionDialogTarget: 1, filters: [], filterDraft: [], filterValuePickerIndex: null, selectedStoreColumns: [], popupConfig: [], popupConfigDraft: [], popupHeader: null, popupHeaderDraft: null, popupCensusCache: new Map(), popupRenderToken: 0,
    selection: {type:'national', name:'Canada', feature:null, provinceCode:null, radius:null},
    markerColor: '#d34c4c',
    markerAnimation: {enabled:false,type:'ripple',fadeObject:'smiley',column:'',formula:'',operator:'=',value:'',values:[],typeMode:'numeric'},
    markerAnimationPassCache: new WeakMap(),
    filterPassCache: new WeakMap(),
    selectedRows: [],
    selectedGroupKey: null,
    selectedStoreRow: null,
    provinceGeo: null, csdGeo: null, csdLayer: null, provinceLayer: null,
    daCache: new Map(), currentDaProvince: null, daLayer: null, daSelectionResult: null, showDaOverlay: true,
    csdLookupGeo: null, csdLookupLoading: false, csdLookupPromise: null, csdLookupIndex: new Map(), csdLookupCellSize: 0.5, lastHeaderCsdKey: null, headerLookupReady: false, headerLookupPointKey: null,
    markerCluster: null, markers: [], spiderfyGroup: null, spiderfyOriginalPositions: new Map(), navigationResultLayer:null, navigationResultAnimation:null, navigationResultLatLng:null, navigationResultKind:null, navigationResultStoreRow:null, navigationResultStoreColor:null,
    circleSelection: null, circleDrawMode: false, leftPanelCollapsed: false, circleDrawing: null, circleEditHandles: [], markerClickSuppressed: false, csdRequestKey: null, moveTimer:null, selectionUpdateFrame:null,
    mapReadyForViewport: false, initialNationalView: true,
    programmaticMoveDepth: 0,
    programmaticMoveUntil: 0,
    userMapInteraction: false,
    daActivationTrigger: null,
    daRefreshTimer:null, daProvinceCacheKey:null, daProvinceCache:null, daSelectionCache:new Map(), daRenderedSignature:null, analysisReactionTimer:null, analysisReactionMs:500,
    censusRequestId:0, censusTotalPopulation:null, searchToken:0, headerGeoRequestId:0, headerGeoTimer:null, tickerMetrics:[], tickerPlaying:true, tickerOffset:0, tickerDragStart:null, tickerPointerId:null, tickerLoopWidth:0, tickerAnimationFrame:null, tickerLastTime:null, tickerSpeed:70, tickerConfigDraft:[], tickerConfigDraftSpeed:70
  };

  const el = id => document.getElementById(id);
  const fmtInt = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
  const fmtPct = v => Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : '—';
  const fmtMoney = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:0}).format(v) : '—';
  const fmtNum = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{maximumFractionDigits:1}).format(v) : '—';
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const ANALYSIS_REACTION_STORAGE_KEY='storeExplorer.analysisReactionMs';
  const DEFAULT_ANALYSIS_REACTION_MS=500;
  function clampAnalysisReactionMs(value){
    const n=Number(value);
    if(!Number.isFinite(n)) return DEFAULT_ANALYSIS_REACTION_MS;
    return Math.max(0,Math.min(5000,Math.round(n/50)*50));
  }
  function loadAnalysisReactionSetting(){
    let value=DEFAULT_ANALYSIS_REACTION_MS;
    try{ value=clampAnalysisReactionMs(localStorage.getItem(ANALYSIS_REACTION_STORAGE_KEY)); }catch(_){}
    state.analysisReactionMs=value;
    const input=el('analysisReactionMs');
    if(input) input.value=String(value);
  }
  function saveAnalysisReactionSetting(){
    const input=el('analysisReactionMs');
    const value=clampAnalysisReactionMs(input?.value);
    state.analysisReactionMs=value;
    if(input) input.value=String(value);
    try{localStorage.setItem(ANALYSIS_REACTION_STORAGE_KEY,String(value));}catch(_){}
  }

  const map = L.map('map', {zoomControl:true, preferCanvas:true, minZoom:3}).fitBounds(CONFIG.canadaBounds, {padding:[8,8]});
  const daSelectionPane = map.createPane('daSelectionPane');
  daSelectionPane.style.zIndex = '450';
  daSelectionPane.style.pointerEvents = 'none';
  const selectionCirclePane = map.createPane('selectionCirclePane');
  selectionCirclePane.style.zIndex = '550';
  selectionCirclePane.style.pointerEvents = 'auto';
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  L.control.scale({position:'bottomleft', metric:true, imperial:false, maxWidth:120}).addTo(map);
  state.markerCluster = L.layerGroup().addTo(map);
  state.navigationResultLayer = L.layerGroup().addTo(map);
  map.on('move zoom resize',requestStorePopupLayout);
  map.on('click',e=>{ if(e?.originalEvent?.target===map.getContainer() && state.openPopupMarker) closeStorePopup(); });

  const provinceStyle = {color:'#47677d',weight:1.2,fillColor:'#dce8ef',fillOpacity:.10};
  const provinceSelectedStyle = {color:'#086fb4',weight:3,fillColor:'#58a9d8',fillOpacity:.13};
  const csdStyle = {color:'#5e8399',weight:1,fillColor:'#64a3c5',fillOpacity:.035};
  const csdHoverStyle = {color:'#0877bd',weight:2,fillOpacity:.08};
  const daStyle = {color:'#298ac2',weight:.7,fillColor:'#45a3d4',fillOpacity:.12,interactive:false};

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

  function provinceCodeFromCsdFeature(feature) {
    const p = feature?.properties || {};
    const abbr = String(p.province || p.Province || '').trim();
    const map = {
      'N.L.':'NL','P.E.I.':'PE','N.S.':'NS','N.B.':'NB','Que.':'QC','Ont.':'ON',
      'Man.':'MB','Sask.':'SK','Alta.':'AB','B.C.':'BC','Y.T.':'YT','N.W.T.':'NT','Nun.':'NU'
    };
    if (map[abbr]) return map[abbr];
    const csduid = String(p.CSDUID || '');
    return csduid.length >= 2 ? CONFIG.prCodeByUid[csduid.slice(0,2)] || null : null;
  }

  function provinceCodeFromText(text) {
    const t = norm(text);
    if (!t) return null;
    const map = {
      AB:['alberta','ab'], BC:['british columbia','bc'], MB:['manitoba','mb'], NB:['new brunswick','nb'],
      NL:['newfoundland and labrador','newfoundland','labrador','nl'], NS:['nova scotia','ns'], NT:['northwest territories','nt'],
      NU:['nunavut','nu'], ON:['ontario','on'], PE:['prince edward island','pei','pe'], QC:['quebec','qc'],
      SK:['saskatchewan','sk'], YT:['yukon','yt']
    };
    const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entries = Object.entries(map).flatMap(([code, vals]) => vals.map(value => ({code, value})))
      .sort((a,b) => b.value.length - a.value.length);
    for (const {code, value} of entries) {
      const re = new RegExp(`(^|\\s)${escapeRe(value)}($|\\s)`, 'i');
      if (re.test(t)) return code;
    }
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
    finally {
      setMapLoading(false);
      setTimeout(()=>{
        map.invalidateSize(false);
        refreshCsdLayer();
        if (!state.initialNationalView) refreshDaSelection();
      },100);
    }
  }

  function csdFeaturesForViewport() {
    if (!state.csdLookupGeo?.features?.length || !state.csdLookupIndex?.size) return [];
    const b = map.getBounds();
    const bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const size = state.csdLookupCellSize;
    const minLat = Math.floor(bb[1] / size), maxLat = Math.floor(bb[3] / size);
    const minLng = Math.floor(bb[0] / size), maxLng = Math.floor(bb[2] / size);
    const candidates = new Set();
    for (let gy=minLat; gy<=maxLat; gy++) for (let gx=minLng; gx<=maxLng; gx++) {
      const bucket=state.csdLookupIndex.get(`${gy}:${gx}`)||[];
      for(const feature of bucket)candidates.add(feature);
    }
    const viewport=turf.bboxPolygon(bb), hits=[];
    for(const feature of candidates){
      try{
        const fbb=feature.__headerBBox||(feature.__headerBBox=turf.bbox(feature));
        if(fbb[2]<bb[0]||fbb[0]>bb[2]||fbb[3]<bb[1]||fbb[1]>bb[3]) continue;
        if(turf.booleanIntersects(feature,viewport)) hits.push(feature);
      }catch{}
    }
    return hits;
  }

  function refreshCsdLayerLocal() {
    if (map.getZoom() < CONFIG.csdMinZoom) {
      if (state.csdLayer) { map.removeLayer(state.csdLayer); state.csdLayer=null; }
      return;
    }
    if (!state.headerLookupReady) return;
    const geo={type:'FeatureCollection',features:csdFeaturesForViewport()};
    if(state.csdLayer)map.removeLayer(state.csdLayer);
    state.csdLayer=L.geoJSON(geo,{style:csdStyle,interactive:false,onEachFeature:(feature,layer)=>{
      const q=feature.properties||{};
      layer.bindTooltip(`${q.CSDNAME||'Municipality'}${q.CSDTYPE?` (${q.CSDTYPE})`:''}`,{sticky:true});
    }}).addTo(map);
  }

  async function refreshCsdLayer() {
    await loadHeaderCsdLookup();
    refreshCsdLayerLocal();
  }

  function fitMapProgrammatically(bounds, options){
    state.programmaticMoveDepth += 1;
    state.programmaticMoveUntil = Date.now() + 3000;
    state.userMapInteraction = false;
    map.fitBounds(bounds, options);
    setTimeout(()=>{ if(Date.now() >= state.programmaticMoveUntil) state.programmaticMoveDepth = 0; }, 3200);
  }

  function selectProvince(feature,layer){
    clearCircle();clearDaOverlay();state.censusRequestId++;
    if(state.provinceLayer)state.provinceLayer.resetStyle();layer.setStyle(provinceSelectedStyle);
    const name=feature.properties.PRNAME||feature.properties.PRENAME||'Province';
    const code=provinceCodeFromFeature(feature);
    state.selection={type:'viewport',name:`${name} — map view`,feature:null,provinceCode:code,radius:null};
    state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger='province selection';
    resetCensusPopulationSummary();
    el('censusNote').textContent='Province selected. The visible map will be used for DA selection after the map settles.';
    fitMapProgrammatically(layer.getBounds(),{padding:[18,18]});
    updateSelection();
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
      const provinceCode=provinceCodeFromAddress(query,c)||await queryProvinceAt(lat,lng);
      closeStorePopup();clearCircle();clearDaOverlay();clearNavigationResult();state.censusRequestId++;
      state.storeJumpTarget=null;
      state.selection={type:'viewport',name:`${c.address||query} — map view`,feature:null,provinceCode,radius:null};
      state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger='address search';
      
      const km=2.5;
      const dLat=km/110.5,dLon=km/(111*Math.cos(lat*Math.PI/180));
      const targetBounds=L.latLngBounds([[lat-dLat,lng-dLon],[lat+dLat,lng+dLon]]);
      let completed=false;
      const finish=()=>{
        if(completed || token!==state.searchToken)return;
        completed=true;
        updateSelection();
        showNavigationResult(lat,lng,'address',null,()=>{
          if(token!==state.searchToken)return;
          createOrReplaceCircle(L.latLng(lat,lng),1000,'address navigation');
        });
      };
      map.once('moveend',finish);
      fitMapProgrammatically(targetBounds,{padding:[25,25]});
      setTimeout(finish,900);
    }catch(err){el('geoStatus').textContent=`Search failed: ${err.message}`;el('censusNote').textContent='Census not loaded.';}
    finally{if(token===state.searchToken)setMapLoading(false);}
  }

  function resetCanada(){
    closeStorePopup();clearCircle();clearDaOverlay();clearNavigationResult();state.censusRequestId++;
    if(state.provinceLayer)state.provinceLayer.resetStyle();
    state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};
    state.mapReadyForViewport=false;state.initialNationalView=true;
    resetCensusPopulationSummary();el('censusNote').textContent='DA selection is dormant on the initial Canada view. Make a geographic move to activate it.';
    fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});updateSelection();
  }

  function clearDaOverlay(){if(state.daLayer){map.removeLayer(state.daLayer);state.daLayer=null;}state.currentDaProvince=null;state.daRenderedSignature=null;}
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
    state.subjects=subjectDefaultMetrics(exactDefaultNames.map(n=>exactHeaders.get(n)).filter(Boolean));
    state.groups=[...new Set(exactDefaultGroupNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.popupCensusCache.clear();state.popupRenderToken++;state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];state.subjectConfigDraft=state.subjects.map(normalizeSubjectMetric);loadPopupHeaderConfig();state.popupHeaderDraft=normalizePopupHeader(state.popupHeader);loadPopupConfig();state.popupConfigDraft=state.popupConfig.map(normalizePopupField);
    el('fileStatus').textContent=`Workbook loaded • ${file.name} • ${state.rows.length.toLocaleString()} stores • header row ${parsed.headerIndex+1}`;el('clearFileBtn').disabled=false;el('tickerConfigBtn').disabled=false;el('subjectsBtn').disabled=false;el('groupsBtn').disabled=false;el('distributionBtn').disabled=false;el('distributionBtn2').disabled=false;el('filterBtn').disabled=false;el('selectedStoresBtn').disabled=false;el('exportSelectedBtn').disabled=false;
    refreshConfigUI();rebuildFilterPassCache();rebuildMarkerAnimationCache();populateMarkerAnimationControls();rebuildMarkers();state.initialNationalView=true;state.mapReadyForViewport=false;state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});setTimeout(()=>updateSelection(),0);
    const mapped=state.rows.filter(hasCoords).length;el('geoStatus').textContent=`Workbook loaded. ${mapped.toLocaleString()} of ${state.rows.length.toLocaleString()} stores have valid coordinates and are mapped.`;
  }
  function clearFinancial(){closeStorePopup();clearCircle();clearNavigationResult();state.rows=[];state.headers=[];state.types={};state.columns={};state.subjects=[];state.groups=[];state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];state.subjectConfigDraft=[];state.popupHeader=null;state.popupHeaderDraft=null;state.popupConfig=[];state.popupConfigDraft=[];state.popupCensusCache.clear();state.popupRenderToken++;state.fileName=null;state.selectedRows=[];state.selectedStoreRow=null;state.markerCluster.clearLayers();state.markers=[];el('fileInput').value='';el('fileStatus').textContent='No financial file selected.';el('clearFileBtn').disabled=true;el('tickerConfigBtn').disabled=true;el('subjectsBtn').disabled=true;el('groupsBtn').disabled=true;el('distributionBtn').disabled=true;el('distributionBtn2').disabled=true;el('filterBtn').disabled=true;el('selectedStoresBtn').disabled=true;el('exportSelectedBtn').disabled=true;refreshConfigUI();updateFilterUI();updateSelection();}
  function hasCoords(row){const c=state.columns;const lat=toNumber(row[c.lat]),lon=toNumber(row[c.lon]);return lat!==null&&lon!==null&&lat>=40&&lat<=90&&lon>=-150&&lon<=-40;}

  // ---------- Navigation result markers / one-shot basketball animation ----------
  const NAV_MARKER_COLORS = ['#d34c4c','#4169e1','#7a3db8','#1f2933'];
  const NAV_BASKETBALL_ASSET = './search-result-basketball.png';
  const NAV_FLAG_ASSET = './search-result-flag.png';

  function clearNavigationResult(){
    if(state.navigationResultLayer) state.navigationResultLayer.clearLayers();
    if(state.navigationResultAnimation){
      try{ state.navigationResultAnimation.cancel?.(); }catch(_){ }
      try{ state.navigationResultAnimation.remove?.(); }catch(_){ }
      state.navigationResultAnimation=null;
    }
    state.navigationResultStoreRow=null;
    state.navigationResultStoreColor=null;
    state.navigationResultLatLng=null;
    state.navigationResultKind=null;
    refreshMarkerStyles();
  }

  function colorRgb(hex){
    const m=String(hex||'').match(/^#([0-9a-f]{6})$/i);
    return m?[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)]:[0,0,0];
  }
  function colorDistance(a,b){
    const x=colorRgb(a),y=colorRgb(b);
    return Math.hypot(x[0]-y[0],x[1]-y[1],x[2]-y[2]);
  }
  function contrastingNavigationColor(){
    const visible=[...new Set(state.markers
      .filter(m=>m.__filterPass!==false && (m.getOpacity?.()??1)>0)
      .map(m=>String(m.__row===state.navigationResultStoreRow ? (m.__navigationResultColor||state.markerColor) : state.markerColor).toLowerCase()))];
    return NAV_MARKER_COLORS
      .map(c=>({c,score:visible.reduce((n,v)=>n+colorDistance(c,v),0)}))
      .sort((a,b)=>b.score-a.score)[0]?.c || '#4169e1';
  }

  function addressFlagIcon(){
    return L.icon({
      iconUrl:NAV_FLAG_ASSET,
      iconSize:[34,34],
      iconAnchor:[10,20],
      className:'navigation-result-flag'
    });
  }

  function findCurrentMarkerForRow(row){
    return state.markers.find(m=>m.__row===row) || null;
  }

  function navigationResultMarker(latlng,kind,row=null){
    clearNavigationResult();
    state.navigationResultLatLng=L.latLng(latlng);
    state.navigationResultKind=kind;
    if(kind==='address'){
      L.marker(state.navigationResultLatLng,{
        icon:addressFlagIcon(),
        interactive:false,
        zIndexOffset:5000,
        pane:'markerPane'
      }).addTo(state.navigationResultLayer);
      return null;
    }
    const marker=findCurrentMarkerForRow(row);
    if(marker){
      state.navigationResultStoreRow=row;
      state.navigationResultStoreColor=contrastingNavigationColor();
      refreshMarkerStyles();
      return marker;
    }
    return null;
  }

  function drawBasketball(ctx,img,x,y,size,rotation=0){
    const r=size/2;
    ctx.save();
    ctx.translate(x,y);
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.arc(0,0,r,0,Math.PI*2);
    ctx.clip();
    ctx.drawImage(img,-r,-r,size,size);
    ctx.restore();
  }

  function runNavigationResultAnimation(latlng,onComplete=null){
    if(!latlng)return;
    if(state.navigationResultAnimation){
      try{state.navigationResultAnimation.cancel?.();}catch(_){ }
      try{state.navigationResultAnimation.remove?.();}catch(_){ }
    }
    const canvas=document.createElement('canvas');
    canvas.className='nav-result-animation-canvas';
    canvas.setAttribute('aria-hidden','true');
    const container=map.getContainer();
    container.appendChild(canvas);
    const ctx=canvas.getContext('2d');
    const dpr=Math.max(1,window.devicePixelRatio||1);
    let rect=container.getBoundingClientRect();
    const ctl={id:0,cancel:()=>cancelAnimationFrame(ctl.id),remove:()=>{if(canvas.parentNode)canvas.parentNode.removeChild(canvas);}};
    ctl.onComplete=typeof onComplete==='function'?onComplete:null;
    state.navigationResultAnimation=ctl;

    function size(){
      rect=container.getBoundingClientRect();
      canvas.width=Math.max(1,Math.round(rect.width*dpr));
      canvas.height=Math.max(1,Math.round(rect.height*dpr));
      canvas.style.width=`${rect.width}px`;
      canvas.style.height=`${rect.height}px`;
    }
    size();

    const img=new Image();
    img.onload=()=>start();
    img.onerror=()=>start(true);
    img.src=NAV_BASKETBALL_ASSET;

    const fromRight=Math.random()<0.5;
    const startTimeRef={value:0};
    const duration=1800;

    function start(assetMissing=false){
      startTimeRef.value=performance.now();
      function frame(now){
        size();
        ctx.setTransform(dpr,0,0,dpr,0,0);
        ctx.clearRect(0,0,rect.width,rect.height);
        const target=map.latLngToContainerPoint(latlng);
        const t=Math.min(1,(now-startTimeRef.value)/duration);
        const sx=fromRight?rect.width+70:-70;
        const sy=Math.max(45,target.y-115);
        const u=Math.min(1,t/0.78);
        const e=1-Math.pow(1-u,3);
        const arc=Math.sin(u*Math.PI)*90;
        const x=sx+(target.x-sx)*e;
        const y=sy+(target.y-sy)*e-arc;
        const landQ=t<0.78?0:Math.min(1,(t-0.78)/0.22);
        const landScale=landQ?0.92+0.08*Math.cos(landQ*Math.PI):1;
        const sizePx=38*landScale;
        const rot=now/180;
        if(!assetMissing) drawBasketball(ctx,img,x,y,sizePx,rot);
        else {
          ctx.save();
          ctx.translate(x,y);ctx.rotate(rot);
          ctx.fillStyle='#e67817';ctx.beginPath();ctx.arc(0,0,sizePx/2,0,Math.PI*2);ctx.fill();
          ctx.strokeStyle='#111';ctx.lineWidth=2;ctx.stroke();
          ctx.restore();
        }
        if(t>=0.78){
          const q=Math.min(1,(t-0.78)/0.22);
          ctx.save();
          ctx.globalAlpha=(1-q)*0.65;
          ctx.strokeStyle='#111820';ctx.lineWidth=2;
          ctx.beginPath();
          ctx.ellipse(target.x,target.y+10,18+14*q,4+2*q,0,0,Math.PI*2);
          ctx.stroke();
          ctx.restore();
        }
        if(t<1){
          ctl.id=requestAnimationFrame(frame);
        }else{
          ctl.remove();
          if(state.navigationResultAnimation===ctl)state.navigationResultAnimation=null;
          if(typeof ctl.onComplete==='function'){
            const done=ctl.onComplete;
            ctl.onComplete=null;
            try{done();}catch(err){console.error('Navigation completion callback failed:',err);}
          }
        }
      }
      ctl.id=requestAnimationFrame(frame);
    }
  }

  function showNavigationResult(lat,lng,kind,row=null,onComplete=null){
    const ll=L.latLng(lat,lng);
    navigationResultMarker(ll,kind,row);
    requestAnimationFrame(()=>runNavigationResultAnimation(ll,onComplete));
  }

  // ---------- Store markers ----------
  // Every store is a separate marker.  Overlapping markers are only spread apart
  // temporarily when the user clicks an overlapping location (spiderfy behavior).
  function rebuildMarkers(){
    closeStorePopup();
    unspiderfyMarkers();
    state.markerCluster.clearLayers();
    state.markers=[];
    if(!state.rows.length||!state.columns.lat||!state.columns.lon)return;
    let dist1=null,dist2=null;
    if(state.distributionBinKey!==null && state.distributionSubject){
      const bins=buildDistributionBins(1);
      dist1=bins.find(x=>x.key===state.distributionBinKey)||null;
    }
    if(state.distributionBinKey2!==null && state.distributionSubject2){
      const bins=buildDistributionBins(2);
      dist2=bins.find(x=>x.key===state.distributionBinKey2)||null;
    }
    for(const row of state.rows){
      if(!hasCoords(row))continue;
      if(!rowPassesFilters(row))continue;
      const lat=toNumber(row[state.columns.lat]),lng=toNumber(row[state.columns.lon]);
      const marker=L.marker([lat,lng],{icon:storeIcon(row,true,false,null,dist1,dist2)});
      // Store info is rendered by the custom Store Explorer popup overlay.
      const profile=state.columns.storeId?String(row[state.columns.storeId]??'').trim():'';
      if(profile) marker.bindTooltip(profile,{direction:'top',sticky:true,opacity:.95,offset:[0,-8]});
      marker.__row=row;
      marker.__trueLatLng=L.latLng(lat,lng);
      marker.__visualKey='';
      marker.__navigationResultColor=null;
      marker.__filterPass=true;
      marker.__selected=false;
      marker.on('click',e=>{ if(e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent); handleMarkerClick(marker); });
      state.markers.push(marker);
      state.markerCluster.addLayer(marker);
    }
    refreshMarkerStyles();
  }
  function storeIcon(row,inSelection,animateVisible=false,overrideColor=null,dist1=null,dist2=null){
    const focusActive = markerFocusActive(row,dist1,dist2);
    const cls=focusActive ? 'group-highlight' : (inSelection ? 'default' : 'out');
    const animating = animateVisible && markerRowAnimationPasses(row);
    const anim=animating ? ` marker-animation marker-animation-${state.markerAnimation.type}` : '';
    const duration=2800;
    const phase=Math.round(performance.now()%duration);
    const delay=animating ? `--marker-animation-delay:-${phase}ms;` : '';
    const fadeKey=state.markerAnimation.fadeObject||'smiley';
    const fadeContent={smiley:'🙂',starburst:'✦',lightning:'⚡'}[fadeKey]||'';
    const fadeObject = animating && state.markerAnimation.type==='fade' ? `<span class="marker-fade-object marker-fade-${fadeKey}" aria-hidden="true">${fadeContent}</span>` : '';
    const staticActive = animating && state.markerAnimation.type==='static';
    const staticObject = staticActive ? `<span class="marker-static-object" aria-hidden="true"><svg class="marker-static-svg" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="15" r="7" fill="#fff" stroke="#c90000" stroke-width="2"/><circle cx="11" cy="15" r="4.3" fill="#c90000" stroke="#fff" stroke-width="1.5"/><circle cx="11" cy="15" r="2" fill="#c90000"/><path d="M24 4 L12.2 15.8" stroke="#111" stroke-width="1.8" stroke-linecap="round"/><path d="M24 4 L20.2 4.7 L21.2 8.2 Z" fill="#111"/></svg></span>` : '';
    const navActive=!!overrideColor; const markerClass = `store-marker ${cls}${staticActive&&!focusActive?' static-cover-hidden':''}${navActive?' navigation-result-store':''}`;
    const markerColor=overrideColor||state.markerColor;
    return L.divIcon({className:'',html:`<div class="store-marker-wrap${anim}" style="${delay}"><div class="${markerClass}" style="--store-marker-color:${markerColor}"></div>${staticObject}${fadeObject}</div>`,iconSize:[14,14],iconAnchor:[7,7]});
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
    return `${focusActive?'focus':'normal'}|${inSelection?'in':'out'}|${markerRowAnimationPasses(row)?state.markerAnimation.type:'none'}|${state.markerAnimation.fadeObject||''}|${state.markerColor}`;
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
  // ---------- Custom store popup overlay ----------
  let storePopupLayer = null;
  let storePopupCard = null;
  let storePopupSvg = null;
  let storePopupFrame = null;
  let storePopupLayoutQueued = false;

  function ensureStorePopupOverlay(){
    if(storePopupLayer && storePopupCard && storePopupSvg) return;
    const container=map.getContainer();
    storePopupLayer=document.createElement('div');
    storePopupLayer.className='store-popup-layer';
    storePopupLayer.setAttribute('aria-hidden','true');
    storePopupSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    storePopupSvg.classList.add('store-popup-leader');
    storePopupSvg.setAttribute('aria-hidden','true');
    storePopupCard=document.createElement('div');
    storePopupCard.className='store-popup-card';
    storePopupCard.setAttribute('role','dialog');
    storePopupCard.setAttribute('aria-modal','false');
    storePopupCard.addEventListener('click',e=>e.stopPropagation());
    storePopupLayer.addEventListener('click',e=>{ if(e.target===storePopupLayer) closeStorePopup(); });
    storePopupLayer.appendChild(storePopupSvg);
    storePopupLayer.appendChild(storePopupCard);
    container.appendChild(storePopupLayer);
  }

  const POPUP_HEADER_STORAGE_KEY='cse_popup_header_config_v176';
  const POPUP_HEADER_WEIGHT_OPTIONS=[600,400];
  const POPUP_HEADER_DEFAULT_SIZES={titleA:14,titleB:14,subtitle:11};
  function popupHeaderDefaultConfig(){
    return {
      titleA: state.columns.location || state.headers.find(h=>norm(h)==='location') || '',
      titleB: state.columns.storeId || state.headers.find(h=>['store profile number','store number','store no','store id'].includes(norm(h))) || '',
      subtitle: '__CITY_PROVINCE__',
      titleASize:14, titleBSize:14, subtitleSize:11, titleAWeight:600, titleBWeight:600, subtitleWeight:600
    };
  }
  function normalizePopupHeader(h){
    const fallback=popupHeaderDefaultConfig();
    const validColumn=v=>state.headers.includes(String(v||''))?String(v):'';
    const validSize=v=>{const n=Number(v);return [10,11,12,13,14,15,16,18,20].includes(n)?n:null;};
    const validWeight=v=>{const n=Number(v);return [400,600].includes(n)?n:null;};
    return {
      titleA: validColumn(h?.titleA) || fallback.titleA,
      titleB: validColumn(h?.titleB) || fallback.titleB,
      subtitle: (h?.subtitle==='__CITY_PROVINCE__' || validColumn(h?.subtitle)) ? String(h.subtitle) : fallback.subtitle,
      titleASize: validSize(h?.titleASize) || POPUP_HEADER_DEFAULT_SIZES.titleA,
      titleBSize: validSize(h?.titleBSize) || POPUP_HEADER_DEFAULT_SIZES.titleB,
      subtitleSize: validSize(h?.subtitleSize) || POPUP_HEADER_DEFAULT_SIZES.subtitle,
      titleAWeight: validWeight(h?.titleAWeight) || fallback.titleAWeight,
      titleBWeight: validWeight(h?.titleBWeight) || fallback.titleBWeight,
      subtitleWeight: validWeight(h?.subtitleWeight) || fallback.subtitleWeight
    };
  }
  function loadPopupHeaderConfig(){
    const fallback=popupHeaderDefaultConfig();
    try{
      const raw=localStorage.getItem(POPUP_HEADER_STORAGE_KEY);
      if(!raw){state.popupHeader=fallback;return;}
      state.popupHeader=normalizePopupHeader(JSON.parse(raw));
    }catch(_){state.popupHeader=fallback;}
  }
  function savePopupHeaderConfig(){try{localStorage.setItem(POPUP_HEADER_STORAGE_KEY,JSON.stringify(state.popupHeader));}catch(_){}}
  function popupHeaderOptions(){
    const cols=state.headers.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');
    return `${cols}<option value="__CITY_PROVINCE__">City, Province</option>`;
  }
  function popupHeaderSizeOptions(selected){
    return [10,11,12,13,14,15,16,18,20].map(n=>`<option value="${n}" ${Number(selected)===n?'selected':''}>${n} px</option>`).join('');
  }
  function popupHeaderWeightOptions(selected){
    return POPUP_HEADER_WEIGHT_OPTIONS.map(n=>`<option value="${n}" ${Number(selected)===n?'selected':''}>${n===600?'Bold':'Not bold'}</option>`).join('');
  }
  function renderPopupHeaderConfig(){
    const header=state.popupHeaderDraft=normalizePopupHeader(state.popupHeaderDraft||state.popupHeader||popupHeaderDefaultConfig());
    const a=el('popupHeaderTitleA'),b=el('popupHeaderTitleB'),sub=el('popupHeaderSubtitle'),as=el('popupHeaderTitleASize'),bs=el('popupHeaderTitleBSize'),ss=el('popupHeaderSubtitleSize'),aw=el('popupHeaderTitleAWeight'),bw=el('popupHeaderTitleBWeight'),sw=el('popupHeaderSubtitleWeight');
    if(!a||!b||!sub||!as||!bs||!ss||!aw||!bw||!sw)return;
    const opts=popupHeaderOptions();
    a.innerHTML=opts;b.innerHTML=opts;sub.innerHTML=opts;
    a.value=header.titleA;b.value=header.titleB;sub.value=header.subtitle;
    as.innerHTML=popupHeaderSizeOptions(header.titleASize);bs.innerHTML=popupHeaderSizeOptions(header.titleBSize);ss.innerHTML=popupHeaderSizeOptions(header.subtitleSize);
    as.value=String(header.titleASize);bs.value=String(header.titleBSize);ss.value=String(header.subtitleSize);
    aw.innerHTML=popupHeaderWeightOptions(header.titleAWeight);bw.innerHTML=popupHeaderWeightOptions(header.titleBWeight);sw.innerHTML=popupHeaderWeightOptions(header.subtitleWeight);
    aw.value=String(header.titleAWeight);bw.value=String(header.titleBWeight);sw.value=String(header.subtitleWeight);
  }
  function bindPopupHeaderConfig(){
    const bind=(id,key,coerce=false)=>{const node=el(id);if(!node)return;node.onchange=e=>{if(!state.popupHeaderDraft)state.popupHeaderDraft=normalizePopupHeader(state.popupHeader);state.popupHeaderDraft[key]=coerce?Number(e.target.value):e.target.value;};};
    bind('popupHeaderTitleA','titleA');bind('popupHeaderTitleB','titleB');bind('popupHeaderSubtitle','subtitle');
    bind('popupHeaderTitleASize','titleASize',true);bind('popupHeaderTitleBSize','titleBSize',true);bind('popupHeaderSubtitleSize','subtitleSize',true);
    bind('popupHeaderTitleAWeight','titleAWeight',true);bind('popupHeaderTitleBWeight','titleBWeight',true);bind('popupHeaderSubtitleWeight','subtitleWeight',true);
  }
  function popupHeaderValue(row,key){
    const h=state.popupHeader||popupHeaderDefaultConfig();
    if(key==='subtitle' && h.subtitle==='__CITY_PROVINCE__'){
      const city=String(row[state.columns.city]??'').trim();const prov=String(row[state.columns.province]??'').trim();return [city,prov].filter(Boolean).join(', ');
    }
    const col=h[key];return col?String(row[col]??'').trim():'';
  }

  const POPUP_VIRTUAL_FIELDS = {
    'Population 1 km': {radiusKm:1,metric:'population'},
    'Population 2 km': {radiusKm:2,metric:'population'},
    'Population 65+ 1 km': {radiusKm:1,metric:'population65Plus'},
    'Population 65+ 2 km': {radiusKm:2,metric:'population65Plus'}
  };
  function popupVirtualNames(){return Object.keys(POPUP_VIRTUAL_FIELDS);}
  function isPopupVirtualOperand(name){return Object.prototype.hasOwnProperty.call(POPUP_VIRTUAL_FIELDS,String(name||''));}
  function exactPopupOperandAt(expr,index){
    const text=String(expr??'');
    const rest=text.slice(index);
    const candidates=[...state.headers,...popupVirtualNames()].filter(Boolean).sort((a,b)=>b.length-a.length);
    let best=null;
    for(const h of candidates){
      if(!rest.startsWith(h))continue;
      const before=index>0?text[index-1]:'';
      const after=index+h.length<text.length?text[index+h.length]:'';
      const beforeOk=!before||/[\s()+\-*/×÷]/.test(before);
      const afterOk=!after||/[\s()+\-*/×÷]/.test(after);
      if(beforeOk&&afterOk){best=h;break;}
    }
    return best;
  }
  function tokenizePopup(expr){
    const tokens=[];let i=0;
    while(i<String(expr??'').length){
      while(i<expr.length&&/\s/.test(expr[i]))i++;
      if(i>=expr.length)break;
      const ch=expr[i];
      if(/[()+*/×÷]/.test(ch)){tokens.push({type:'op',value:ch==='×'?'*':ch==='÷'?'/':ch});i++;continue;}
      if(ch==='-'){tokens.push({type:'op',value:'-'});i++;continue;}
      const operand=exactPopupOperandAt(expr,i);
      if(operand){tokens.push({type:'operand',value:operand});i+=operand.length;continue;}
      const num=expr.slice(i).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
      if(num){tokens.push({type:'operand',value:num[0]});i+=num[0].length;continue;}
      return null;
    }
    return tokens;
  }
  function popupFormulaIssue(formula){
    const text=String(formula??'').trim();
    if(!text)return 'Invalid formula';
    if(state.headers.includes(text)||isPopupVirtualOperand(text))return '';
    const tokens=tokenizePopup(text);
    if(!tokens||!tokens.length)return 'Invalid formula';
    const operands=tokens.filter(t=>t.type==='operand'&&!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value));
    const textOnly=operands.filter(t=>state.types[t.value]!=='numeric'&&!isPopupVirtualOperand(t.value));
    if(textOnly.length){
      return operands.length===1&&state.headers.includes(textOnly[0].value)
        ? 'Invalid formula'
        : 'Invalid formula: non-numeric columns cannot be combined with numeric fields.';
    }
    let depth=0,expectOperand=true,seen=false;
    for(const t of tokens){
      if(t.type==='operand'){if(!expectOperand)return 'Invalid formula';expectOperand=false;seen=true;continue;}
      if(t.value==='('){if(!expectOperand)return 'Invalid formula';depth++;continue;}
      if(t.value===')'){if(expectOperand||depth===0)return 'Invalid formula';depth--;expectOperand=false;continue;}
      if(expectOperand&&t.value!=='-')return 'Invalid formula';
      expectOperand=true;
    }
    return seen&&depth===0&&!expectOperand?'':'Invalid formula';
  }
  function popupVirtualOptions(selected){
    return popupVirtualNames().map(name=>`<option value="${esc(name)}" ${selected===name?'selected':''}>${esc(name)}</option>`).join('');
  }

  async function calculatePopupCensusForStore(row){
    const required=new Set();
    for(const field of popupItems()){
      const tokens=tokenizePopup(field.formula)||[];
      for(const t of tokens){
        if(t.type==='operand'&&isPopupVirtualOperand(t.value))required.add(t.value);
      }
    }
    if(!required.size)return {};
    const threshold=Number(el('censusThreshold')?.value??15);
    const lat=toNumber(row[state.columns.lat]),lng=toNumber(row[state.columns.lon]);
    if(lat===null||lng===null)return {};
    const storeId=state.columns.storeId?String(row[state.columns.storeId]??''):'';
    const cacheBase=`${storeId}|${lat.toFixed(6)}|${lng.toFixed(6)}|${threshold}`;
    const neededRadii=[...new Set([...required].map(n=>POPUP_VIRTUAL_FIELDS[n].radiusKm))].sort((a,b)=>a-b);
    const out={};
    await loadHeaderCsdLookup();
    for(const radiusKm of neededRadii){
      const cacheKey=`${cacheBase}|${radiusKm}`;
      if(state.popupCensusCache.has(cacheKey)){Object.assign(out,state.popupCensusCache.get(cacheKey));continue;}
      const boundary=turf.circle([lng,lat],radiusKm,{units:'kilometers',steps:96});
      const provinces=provincesForBoundaryFromCsd(boundary);
      const result=await DA_ENGINE.select(boundary,provinces,threshold);
      const totals=result.selected.reduce((acc,item)=>{const a=censusAttributes(item.feature);acc.population+=a.totalPopulation;acc.population65Plus+=a.population65Plus;return acc;},{population:0,population65Plus:0});
      const radiusValues={[`Population ${radiusKm} km`]:totals.population,[`Population 65+ ${radiusKm} km`]:totals.population65Plus};
      state.popupCensusCache.set(cacheKey,radiusValues);
      Object.assign(out,radiusValues);
    }
    return out;
  }

  function normalizePopupField(f){
    const numberFormat=['auto','number','currency','percentage'].includes(f?.numberFormat)?f.numberFormat:'auto';
    const rawDecimals=Number(f?.decimalPlaces);
    const decimalPlaces=Number.isInteger(rawDecimals)&&rawDecimals>=0&&rawDecimals<=4?rawDecimals:defaultTickerDecimals(numberFormat);
    let formula=f?.formula===null?'':String(f?.formula??'').trim();
    let column=state.headers.includes(String(f?.column??''))?String(f.column):'';
    if(!formula&&column) formula=column;
    if(formula&&state.headers.includes(formula)) column=formula;
    const type=state.headers.includes(formula)?'column':(isPopupVirtualOperand(formula)?'virtual':'formula');
    const title=String(f?.title??'').trim() || (type!=='formula'?formula:firstTickerOperand(formula));
    return {type,column:type==='column'?formula:'',formula,title,numberFormat,decimalPlaces};
  }
  function popupDirectColumn(field){
    const formula=String(field?.formula??'').trim();
    return state.headers.includes(formula)?formula:'';
  }
  function popupDefaultFieldsFromSubjects(){
    const totalSales=state.headers.includes('Total Sales')?'Total Sales':(state.headers.find(h=>norm(h)==='total sales')||'');
    if(!totalSales) return [];
    return [{type:'column',column:totalSales,formula:totalSales,title:totalSales,numberFormat:'auto',decimalPlaces:0}];
  }
  function loadPopupConfig(){
    const fallback=popupDefaultFieldsFromSubjects();
    try{
      const raw=localStorage.getItem(POPUP_STORAGE_KEY);
      if(!raw){state.popupConfig=fallback.map(normalizePopupField);return;}
      const parsed=JSON.parse(raw);
      state.popupConfig=Array.isArray(parsed)&&parsed.length?parsed.map(normalizePopupField):fallback.map(normalizePopupField);
    }catch(_){state.popupConfig=fallback.map(normalizePopupField);}
  }
  function savePopupConfig(){
    try{localStorage.setItem(POPUP_STORAGE_KEY,JSON.stringify(state.popupConfig));}catch(_){}
  }
  function popupItems(){return (state.popupConfig||[]).map(normalizePopupField).filter(f=>f.formula);}
  function evaluatePopupFormula(formula,row,censusValues){
    const tokens=tokenizePopup(formula);if(!tokens)return NaN;
    const operandValues=new Map();
    for(const t of tokens){
      if(t.type!=='operand'||/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))continue;
      if(operandValues.has(t.value))continue;
      if(isPopupVirtualOperand(t.value)){operandValues.set(t.value,Number(censusValues?.[t.value]));continue;}
      operandValues.set(t.value,toNumber(row[t.value]));
    }
    return evaluateTickerExpressionWithTokens(tokens,operandValues);
  }
  function evaluateTickerExpressionWithTokens(tokens,operandValues){
    const values=[],ops=[];
    const prec=o=>(o==='+'||o==='-')?1:2;
    const apply=()=>{const op=ops.pop(),b=values.pop(),a=values.pop();if(!Number.isFinite(a)||!Number.isFinite(b)){values.push(NaN);return;}if(op==='+')values.push(a+b);else if(op==='-')values.push(a-b);else if(op==='*')values.push(a*b);else if(op==='/')values.push(b===0?NaN:a/b);};
    try{for(const t of tokens){if(t.type==='operand'){if(/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value))values.push(Number(t.value));else values.push(operandValues.has(t.value)?operandValues.get(t.value):NaN);continue;}if(t.value==='-'&&(values.length===0||ops.at(-1)==='('||['+','-','*','/'].includes(ops.at(-1)))){values.push(0);ops.push('-');continue;}if(t.value==='('){ops.push(t.value);continue;}if(t.value===')'){while(ops.length&&ops.at(-1)!=='(')apply();if(ops.at(-1)!=='(')return NaN;ops.pop();continue;}while(ops.length&&ops.at(-1)!=='('&&prec(ops.at(-1))>=prec(t.value))apply();ops.push(t.value);}while(ops.length){if(ops.at(-1)==='(')return NaN;apply();}return values.length===1?values[0]:NaN;}catch(_){return NaN;}
  }
  function popupFieldValue(field,row,censusValues){
    const direct=popupDirectColumn(field);
    if(direct){
      const raw=row[direct];
      const n=toNumber(raw);
      return n===null?String(raw??''):formatTickerValue(n,field.numberFormat,direct,field.decimalPlaces);
    }
    const value=isPopupVirtualOperand(field.formula)?Number(censusValues?.[field.formula]):evaluatePopupFormula(field.formula,row,censusValues);
    return formatTickerValue(value,field.numberFormat,field.formula,field.decimalPlaces);
  }
  async function popupCardContent(row,censusValues={}){
    const c=state.columns;
    const popupFields=popupItems();
    const needsCensus=popupFields.some(f=>(tokenizePopup(f.formula)||[]).some(t=>t.type==='operand'&&isPopupVirtualOperand(t.value)));
    const values=needsCensus&&!Object.keys(censusValues).length?await calculatePopupCensusForStore(row):censusValues;
    const header=normalizePopupHeader(state.popupHeader||popupHeaderDefaultConfig());
    const titleA=popupHeaderValue(row,'titleA') || 'Location';
    const titleB=popupHeaderValue(row,'titleB') || '—';
    const subtitle=popupHeaderValue(row,'subtitle');
    const lat=toNumber(row[c.lat]),lng=toNumber(row[c.lon]);
    const mapsLink=(lat!==null&&lng!==null)?`<a class="store-popup-map-link" href="https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps" aria-label="Open in Google Maps">G</a>`:'';
    let html=`<div class="store-popup-head"><div class="store-popup-head-main"><div class="store-popup-head-row"><h3 style="font-size:${header.titleASize}px;font-weight:${header.titleAWeight}">${esc(titleA)}</h3><span class="store-popup-store-id" style="font-size:${header.titleBSize}px;font-weight:${header.titleBWeight}">${esc(titleB)}</span></div>${subtitle?`<div class="store-popup-subtitle" style="font-size:${header.subtitleSize}px;font-weight:${header.subtitleWeight}">${esc(subtitle)}</div>`:''}</div><div class="store-popup-head-actions">${mapsLink}<button type="button" class="store-popup-close" aria-label="Close store information">×</button></div></div><table>`;
    for(const field of popupFields){html+=`<tr><td>${esc(tickerMetricTitle(field))}</td><td>${esc(popupFieldValue(field,row,values))}</td></tr>`;}
    return `<div class="store-popup">${html}</table></div>`;
  }

  function hasPopupVirtualFields(){return popupItems().some(f=>(tokenizePopup(f.formula)||[]).some(t=>t.type==='operand'&&isPopupVirtualOperand(t.value)));}

  function closeStorePopup(){
    state.popupRenderToken++;
    if(!storePopupLayer)return;
    if(storePopupFrame)cancelAnimationFrame(storePopupFrame);
    storePopupFrame=null;
    storePopupLayoutQueued=false;
    state.openPopupMarker=null;
    storePopupLayer.classList.remove('open');
    storePopupLayer.setAttribute('aria-hidden','true');
    if(storePopupSvg)storePopupSvg.replaceChildren();
    if(storePopupCard)storePopupCard.innerHTML='';
  }

  function requestStorePopupLayout(){
    if(!state.openPopupMarker || !storePopupLayer?.classList.contains('open'))return;
    if(storePopupLayoutQueued)return;
    storePopupLayoutQueued=true;
    storePopupFrame=requestAnimationFrame(()=>{
      storePopupFrame=null;
      storePopupLayoutQueued=false;
      layoutStorePopup(state.openPopupMarker);
    });
  }

  function rectOverlapsMarker(left,top,w,h,px,py,radius,extra=0){
    const nearestX=clamp(px,left,left+w);
    const nearestY=clamp(py,top,top+h);
    const d=Math.hypot(px-nearestX,py-nearestY);
    return d < radius+extra;
  }

  function candidatePopupPosition(markerPoint,w,h,mapSize,markerRadius){
    const margin=12;
    const popupClearance=12;
    const baseGap=markerRadius+popupClearance;
    const maxRadius=Math.hypot(mapSize.x,mapSize.y)+Math.max(w,h);
    let best=null;
    // Search radially for the closest valid rectangle. Each direction uses the
    // exact support distance of the popup rectangle so it starts just outside
    // the marker, then expands only when viewport clearance requires it.
    for(let i=0;i<360;i++){
      const angle=(Math.PI*2*i)/360;
      const ux=Math.cos(angle),uy=Math.sin(angle);
      const halfW=w/2,halfH=h/2;
      const support=Math.abs(ux)*halfW+Math.abs(uy)*halfH;
      let centerDistance=baseGap+support;
      let accepted=null;
      while(centerDistance<=maxRadius){
        const cx=markerPoint.x+ux*centerDistance;
        const cy=markerPoint.y+uy*centerDistance;
        const left=cx-halfW,top=cy-halfH;
        const right=left+w,bottom=top+h;
        const inside=left>=margin&&top>=margin&&right<=mapSize.x-margin&&bottom<=mapSize.y-margin;
        if(inside&&!rectOverlapsMarker(left,top,w,h,markerPoint.x,markerPoint.y,markerRadius,0)){
          const edgeX=clamp(markerPoint.x,left,right);
          const edgeY=clamp(markerPoint.y,top,bottom);
          const edgeDistance=Math.hypot(markerPoint.x-edgeX,markerPoint.y-edgeY);
          accepted={left,top,w,h,edgeDistance,centerDistance,angle};
          break;
        }
        centerDistance+=4;
      }
      if(accepted){
        if(!best || accepted.edgeDistance<best.edgeDistance || (Math.abs(accepted.edgeDistance-best.edgeDistance)<0.01&&accepted.centerDistance<best.centerDistance)){
          best=accepted;
        }
      }
    }
    return best;
  }

  function leaderGeometry(markerPoint,popupRect,markerRadius){
    const {left,top,w,h}=popupRect;
    const px=clamp(markerPoint.x,left,left+w);
    const py=clamp(markerPoint.y,top,top+h);
    const dx=markerPoint.x-px,dy=markerPoint.y-py;
    const len=Math.hypot(dx,dy);
    if(!Number.isFinite(len)||len<0.5)return null;
    const ux=dx/len,uy=dy/len;
    const tipGap=Math.max(2,Math.min(4,3));
    const tipDistance=Math.max(0,len-(markerRadius+tipGap));
    if(tipDistance<0.5)return null;
    const tipX=markerPoint.x-ux*(markerRadius+tipGap);
    const tipY=markerPoint.y-uy*(markerRadius+tipGap);
    const halfBase=5;
    const bx=px,by=py;
    const nx=-uy,ny=ux;
    return {
      points:`${bx-halfBase*nx},${by-halfBase*ny} ${bx+halfBase*nx},${by+halfBase*ny} ${tipX},${tipY}`
    };
  }

  function layoutStorePopup(marker){
    if(!marker||!storePopupLayer||!storePopupCard||!storePopupSvg)return;
    if(marker!==state.openPopupMarker)return;
    const mapSize=map.getSize();
    const markerPoint=map.latLngToContainerPoint(marker.getLatLng());
    const markerEl=marker.getElement?.()?.querySelector('.store-marker');
    const markerRect=markerEl?.getBoundingClientRect();
    const markerRadius=Math.max(7,(markerRect?.width||14)/2,(markerRect?.height||14)/2);
    const cardRect=storePopupCard.getBoundingClientRect();
    const w=cardRect.width||350;
    const h=cardRect.height||180;
    const candidate=candidatePopupPosition(markerPoint,w,h,mapSize,markerRadius);
    if(!candidate){
      // The popup remains visible inside the viewport even in pathological
      // edge cases. Place it at the closest safe quadrant, never over the marker.
      const margin=12;
      const safeX=markerPoint.x<mapSize.x/2?mapSize.x-margin-w:margin;
      const safeY=markerPoint.y<mapSize.y/2?mapSize.y-margin-h:margin;
      candidate={left:clamp(safeX,margin,Math.max(margin,mapSize.x-margin-w)),top:clamp(safeY,margin,Math.max(margin,mapSize.y-margin-h)),w,h};
    }
    storePopupCard.style.left=`${candidate.left}px`;
    storePopupCard.style.top=`${candidate.top}px`;
    const leader=leaderGeometry(markerPoint,candidate,markerRadius);
    storePopupSvg.setAttribute('width',String(mapSize.x));
    storePopupSvg.setAttribute('height',String(mapSize.y));
    storePopupSvg.setAttribute('viewBox',`0 0 ${mapSize.x} ${mapSize.y}`);
    storePopupSvg.style.width=`${mapSize.x}px`;
    storePopupSvg.style.height=`${mapSize.y}px`;
    storePopupSvg.replaceChildren();
    if(leader){
      const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');
      polygon.setAttribute('points',leader.points);
      polygon.setAttribute('class','store-popup-leader-arrow');
      storePopupSvg.appendChild(polygon);
    }
  }

  async function openStorePopup(marker){
    ensureStorePopupOverlay();
    if(state.openPopupMarker===marker && storePopupLayer.classList.contains('open')){ closeStorePopup(); return; }
    const token=++state.popupRenderToken;
    state.openPopupMarker=marker;
    const needsCensus=hasPopupVirtualFields();
    storePopupCard.innerHTML=needsCensus?'<div class="store-popup-loading">Calculating…</div>':'<div class="store-popup-loading">Loading…</div>';
    storePopupLayer.classList.add('open');
    storePopupLayer.setAttribute('aria-hidden','false');
    requestStorePopupLayout();
    const censusValues=needsCensus?await calculatePopupCensusForStore(marker.__row):{};
    if(token!==state.popupRenderToken||state.openPopupMarker!==marker)return;
    storePopupCard.innerHTML=await popupCardContent(marker.__row,censusValues);
    const closeBtn=storePopupCard.querySelector('.store-popup-close');
    closeBtn?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();closeStorePopup();});
    requestStorePopupLayout();
  }

  function positionStorePopup(marker){
    // Compatibility wrapper for older call sites; all positioning is custom now.
    if(state.openPopupMarker===marker) requestStorePopupLayout();
  }

  async function storePopup(row){
    return `<div class="store-popup">${await popupCardContent(row)}</div>`;
  }

  function handleMarkerClick(marker){
    if(state.markerClickSuppressed)return;
    const nearby=getNearbyMarkers(marker,18);
    if(nearby.length>1){
      if(state.spiderfyGroup && state.spiderfyGroup.includes(marker)){
        unspiderfyMarkers();
        openStorePopup(marker);
        return;
      }
      unspiderfyMarkers();
      spiderfyMarkers(nearby);
      return;
    }
    openStorePopup(marker);
  }
  function getNearbyMarkers(centerMarker,thresholdPx){
    const center=map.latLngToLayerPoint(centerMarker.getLatLng());
    return state.markers.filter(m=>{
      if(!filterRowPasses(m.__row)) return false;
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
      if(first && state.openPopupMarker!==first) openStorePopup(first);
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
  const MARKER_ANIMATION_STORAGE_KEY='cse_marker_animation_v102';
  function normalizeMarkerAnimation(config){
    let type=['ripple','fade','static'].includes(config?.type)?config.type:'ripple';
    if(config?.type==='rotation' || config?.type==='squish' || config?.type==='pulse') type='ripple';
    const typeMode=config?.typeMode==='text'?'text':'numeric';
    const fadeObject=['smiley','starburst','lightning'].includes(config?.fadeObject)?config.fadeObject:'smiley';
    const operator=['<=','=','>=','<','>'].includes(config?.operator)?config.operator:'=';
    return {
      enabled:!!config?.enabled, type, fadeObject, column:String(config?.column??''), formula:String(config?.formula??''),
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
  function refreshMarkerStyles(dist1=null,dist2=null){
    if(!state.markers.length)return;
    const selectedSet=new Set(state.selectedRows);
    const bounds=map.getBounds();
    if(dist1===null && state.distributionBinKey!==null && state.distributionSubject){
      const bins=buildDistributionBins();
      dist1=bins.find(x=>x.key===state.distributionBinKey)||null;
    }
    if(dist2===null && state.distributionBinKey2!==null && state.distributionSubject2){
      const bins2=buildDistributionBins(2);
      dist2=bins2.find(x=>x.key===state.distributionBinKey2)||null;
    }
    state.markers.forEach(m=>{
      const passes=filterRowPasses(m.__row);
      const inSelection=selectedSet.has(m.__row)||state.selection.type==='national';
      const animateVisible=passes && selectedSet.has(m.__row) && bounds.contains(m.__trueLatLng||m.getLatLng());
      if(m.__filterPass!==passes){m.__filterPass=passes;m.setOpacity(passes?1:0);}
      const z=passes?(inSelection?10:0):-1000;
      if(m.__zIndex!==z){m.__zIndex=z;m.setZIndexOffset(z);}
      const navColor=(state.navigationResultKind==='store' && m.__row===state.navigationResultStoreRow) ? state.navigationResultStoreColor : null; const key=markerVisualKey(m.__row,inSelection,dist1,dist2)+`|${animateVisible?'visible':'off'}|${navColor||''}`;
      if(m.__visualKey!==key){m.__visualKey=key;m.setIcon(storeIcon(m.__row,inSelection,animateVisible,navColor));}
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
    const bounds=map.getBounds();
    const circle=state.circleSelection;
    const circleVisible=!!(circle && circle.circle && circle.circle.getBounds().intersects(bounds));
    const centre=circleVisible?circle.circle.getLatLng():null;
    const radiusMeters=circleVisible?circle.circle.getRadius():0;
    return state.rows.filter(r=>{
      if(!filterRowPasses(r)||!hasCoords(r))return false;
      const ll=L.latLng(toNumber(r[c.lat]),toNumber(r[c.lon]));
      if(!bounds.contains(ll))return false;
      if(!circleVisible)return true;
      return map.distance(centre,ll)<=radiusMeters+0.0001;
    });
  }
  function getFilteredRows(){return state.rows.filter(filterRowPasses);}
  function updateSelectionState(){
    state.selectedRows=getSelectedRows();
    if(state.selectedStoreRow!==null && !state.selectedRows.includes(state.selectedStoreRow)) state.selectedStoreRow=null;
    const filtered=getFilteredRows();
    const filterNote=state.filters.length?` • ${filtered.length.toLocaleString()} pass active filter${filtered.length===1?'':'s'}`:'';
    el('geoStatus').textContent=state.rows.length?(state.circleSelection && state.circleSelection.circle && state.circleSelection.circle.getBounds().intersects(map.getBounds()) ? `${state.selectedRows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} stores in current selection circle and viewport${filterNote}.` : `${state.selectedRows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} stores in current map view${filterNote}.`):'Load a workbook to calculate store results.';
    el('filterCount').textContent=state.filters.length;
    el('filterStatus').textContent=state.filters.length?state.filters.map((f,i)=>describeFilter(f,i)).join(' • '):'No filters applied.';
  }
  function getRefreshDistributionBins(){
    let bins1=null,bins2=null,dist1=null,dist2=null;
    if(state.distributionSubject){bins1=buildDistributionBins(1);if(state.distributionBinKey!==null)dist1=bins1.find(x=>x.key===state.distributionBinKey)||null;}
    if(state.distributionSubject2){bins2=buildDistributionBins(2);if(state.distributionBinKey2!==null)dist2=bins2.find(x=>x.key===state.distributionBinKey2)||null;}
    return {bins1,bins2,dist1,dist2};
  }
  function updateSelectionPanels(){
    const {bins1,bins2,dist1,dist2}=getRefreshDistributionBins();
    updateKpis();updateSubjects();updateGroups();updateDistribution(bins1,bins2);updateSelectedStoresList();refreshMarkerStyles(dist1,dist2);renderTicker();
  }
  function updateSelection(){
    updateSelectionState();
    updateSelectionPanels();
  }
  function scheduleSelectionUpdate(){
    if(state.selectionUpdateFrame!==null)return;
    state.selectionUpdateFrame=requestAnimationFrame(()=>{state.selectionUpdateFrame=null;updateSelection();});
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
    if(!e){el('kpiSuccess').textContent='—';el('kpiAvgEbit').textContent='—';}
    else if(!ebitVals.length){el('kpiSuccess').textContent='—';el('kpiAvgEbit').textContent='—';}
    else {
      el('kpiSuccess').textContent=fmtPct(ebitVals.filter(v=>v>0).length/ebitVals.length);
      el('kpiAvgEbit').textContent=fmtMoney(avg(ebitVals));
    }
    const censusTotal = state.censusTotalPopulation;
    el('kpiSalesPerPopulation').textContent = Number.isFinite(totalSales) && Number.isFinite(censusTotal) && censusTotal > 0
      ? `$${fmtInt(Math.round(totalSales / censusTotal))}`
      : '—';
  }
  function avg(vals){return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:NaN;}
  function median(vals){if(!vals.length)return NaN;const a=[...vals].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}

  // ---------- Subjects / Groups ----------
  function normalizeSubjectMetric(m){
    const base=normalizeTickerMetric(m||{});
    return {title:base.title,formula:base.formula,aggregation:['sum','average','median'].includes(base.aggregation)?base.aggregation:'average',numberFormat:base.numberFormat,decimalPlaces:base.decimalPlaces};
  }
  function subjectDefaultMetrics(names=[]){
    return names.filter(Boolean).map(h=>normalizeSubjectMetric({title:h,formula:h,aggregation:'average',numberFormat:'auto',decimalPlaces:0}));
  }
  function subjectItems(){return (state.subjects||[]).map(normalizeSubjectMetric).filter(m=>m.formula);}
  function updateSubjects(){
    const box=el('subjectsSummary');
    if(!state.rows.length){box.innerHTML='<div class="empty-message">Select a workbook, then configure Subjects.</div>';return;}
    const items=subjectItems();
    if(!items.length){box.innerHTML='<div class="empty-message">No Subjects configured.</div>';return;}
    let html='<table class="subject-table">';
    for(const m of items){
      const value=evaluateTickerFormula(m.formula,state.selectedRows,m.aggregation||'average');
      const valueText=formatTickerValue(value,m.numberFormat,m.formula,m.decimalPlaces);
      html+=`<tr><td><span class="subject-name">${esc(tickerMetricTitle(m))}</span></td><td>${esc(valueText)}</td></tr>`;
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
    const groupedSubjectMetrics=subjectItems();
    let html='<div class="group-wrap"><table class="group-table"><thead><tr><th>Group</th><th>n</th>'+(e?'<th>EBIT +%</th>':'')+groupedSubjectMetrics.map(m=>`<th>${esc(tickerMetricTitle(m))}</th>`).join('')+'</tr></thead><tbody>';
    for(const [key,g] of list){
      let success='';
      if(e){const ev=g.rows.map(r=>toNumber(r[e])).filter(v=>v!==null);success=`<td>${ev.length?fmtPct(ev.filter(v=>v>0).length/ev.length):'—'}</td>`;}
      const subj=groupedSubjectMetrics.map(m=>{const v=evaluateTickerFormula(m.formula,g.rows,m.aggregation||'average');return `<td>${esc(formatTickerValue(v,m.numberFormat,m.formula,m.decimalPlaces))}</td>`;}).join('');
      const active=state.selectedGroupKey===key;
      html+=`<tr class="group-select-row${active?' active-group':''}" data-group-key="${esc(key)}"><td><strong>${g.parts.map(esc).join(' / ')}</strong></td><td>${g.rows.length}</td>${success}${subj}</tr>`;
    }
    box.innerHTML=html+'</tbody></table></div><div class="small muted group-hint">Click a group row to highlight its stores on the map.</div>';
    box.querySelectorAll('.group-select-row').forEach(row=>row.addEventListener('click',()=>{
      const key=row.dataset.groupKey;
      state.selectedGroupKey=state.selectedGroupKey===key?null:key;
      if(state.selectedGroupKey!==null){state.distributionBinKey=null;state.distributionBinKey2=null;state.selectedStoreRow=null;}
      updateGroups();updateDistribution();updateSelectedStoresList();
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
  function updateDistributionSlot(slot,boxId,binsOverride=null){
    const box=el(boxId);if(!box)return;
    const h=getDistributionSubject(slot);
    if(!state.rows.length){box.innerHTML='<div class="empty-message">Select a workbook, then configure Distribution.</div>';return;}
    if(!h){box.innerHTML='';return;}
    const bins=binsOverride||buildDistributionBins(slot);if(!bins.length){box.innerHTML='<div class="empty-message">No values in the current map view.</div>';return;}
    const currentKey=getDistributionBinKey(slot);
    if(currentKey!==null&&!bins.some(b=>b.key===currentKey))setDistributionBinKey(slot,null);
    const activeKey=getDistributionBinKey(slot), maxCount=Math.max(...bins.map(b=>b.count),1);
    const label=slot===2?'Distribution 2':'Distribution';
    let html=`<div class="distribution-title">${esc(h)} <span class="small muted">${state.selectedRows.length.toLocaleString()} stores</span></div><div class="distribution-chart" role="list" aria-label="${label} of selected column">`;
    for(const b of bins){const active=activeKey===b.key;const width=Math.max(2,(b.count/maxCount)*100);html+=`<button type="button" class="distribution-bar${active?' active-distribution':''}" data-bin-key="${esc(b.key)}" title="${esc(b.label)}: ${b.count} stores"><span class="distribution-label">${esc(b.label)}</span><span class="distribution-track"><span class="distribution-fill" style="width:${width}%"></span></span><strong>${b.count}</strong></button>`;}
    html+='</div><div class="small muted distribution-hint">Click a bar to highlight those stores on the map. Selecting a bar in either distribution clears Group highlighting and the other distribution highlight.</div>';box.innerHTML=html;
    box.querySelectorAll('.distribution-bar').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.binKey;setDistributionBinKey(slot,getDistributionBinKey(slot)===key?null:key);if(getDistributionBinKey(slot)!==null){state.selectedGroupKey=null;state.selectedStoreRow=null;if(slot===1)state.distributionBinKey2=null;else state.distributionBinKey=null;}updateGroups();updateDistribution();updateSelectedStoresList();refreshMarkerStyles();}));
  }
  function updateDistribution(bins1=null,bins2=null){
    updateDistributionSlot(1,'distributionSummary',bins1);
    updateDistributionSlot(2,'distributionSummary2',bins2);
  }

  function shortHeader(h){return h.length>18?h.slice(0,17)+'…':h;}
  function formatValue(header,v){if(v===null||v===undefined||v===''||Number.isNaN(v))return '—';const n=toNumber(v),hn=norm(header);if(n!==null){if(hn.includes('sales')||hn.includes('wage')||hn.includes('expense')||hn.includes('margin $')||hn.includes('profit')||hn.includes('ebit')||hn.includes('income')||hn.includes('cogs')||hn.includes('sga'))return fmtMoney(n);if(hn.includes('sq ft')||hn.includes('area'))return `${fmtInt(n)} sq.ft.`;if(hn.includes('pct')||hn.includes('percent')||hn.endsWith('%'))return `${n.toFixed(1)}%`;return fmtNum(n);}return String(v);}
  function refreshConfigUI(){
    if(!Array.isArray(state.subjectConfigDraft)) state.subjectConfigDraft=(state.subjects||[]).map(normalizeSubjectMetric);
    if(!Array.isArray(state.popupConfigDraft)) state.popupConfigDraft=(state.popupConfig||[]).map(normalizePopupField);
    el('subjectCount').textContent=state.subjects.length;
    el('popupCount').textContent=(state.popupConfig||[]).length;
    el('popupConfigBtn').disabled=!state.headers.length;
    el('groupCount').textContent=state.groups.length;
    el('distributionCount').textContent=state.distributionSubject?1:0;
    el('distributionCount2').textContent=state.distributionSubject2?1:0; el('selectedStoresCount').textContent=2+state.selectedStoreColumns.length;
    renderChecklist('groupsList',state.groups,'group');
    renderSubjectConfig();
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
  function getFilterTextColumn(draft){
    const formula=String(draft.formula??'').trim();
    if(formula){
      const tokens=exactFormulaTokens(formula);
      if(tokens){
        for(const t of tokens){
          if(t.type==='header' && state.types[t.value]==='text') return t.value;
        }
      }
    }
    const selectedColumn=String(draft.column??'');
    return selectedColumn && state.types[selectedColumn]==='text' ? selectedColumn : '';
  }
  function detectFilterDraftType(draft){
    const formula=String(draft.formula??'').trim();
    if(getFilterTextColumn(draft)) return 'text';
    if(!formula) return state.types[String(draft.column??'')]==='text'?'text':'numeric';
    const tokens=exactFormulaTokens(formula);
    if(!tokens) return 'numeric';
    const headers=tokens.filter(t=>t.type==='header').map(t=>t.value);
    if(headers.length && headers.every(h=>state.types[h]==='numeric')) return 'numeric';
    return 'numeric';
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
    const allCols=state.headers;
    box.innerHTML=rows.map((f,i)=>{
      const type=detectFilterDraftType(f);
      const formula=f.formula||'';
      const selectedTextValues=Array.isArray(f.values)?f.values:[];
      const valuePicker=type==='text'
        ? `<button type="button" class="filter-value-select-button" data-index="${i}">${selectedTextValues.length?esc(selectedTextValues.join(', ')):'Select values...'}</button>`
        : `<input class="filter-value-input" data-index="${i}" type="number" step="any" placeholder="Enter value" value="${esc(f.value??'')}">`;
      const condition=`<select class="filter-condition" data-index="${i}">${FILTER_OPERATORS.map(op=>`<option value="${op}" ${f.operator===op?'selected':''}>${op}</option>`).join('')}</select>`;
      const connector=`<select class="filter-connector" data-index="${i}">${FILTER_CONNECTORS.map(op=>`<option value="${op}" ${f.connector===op?'selected':''}>${op}</option>`).join('')}</select>`;
      return `<div class="filter-line" data-index="${i}">
        <div class="filter-line-main">
          <select class="filter-column" data-index="${i}"><option value="">Choose column</option>${allCols.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select>
          <input class="filter-formula" data-index="${i}" type="text" placeholder="Variable or Formula" value="${esc(formula)}" autocomplete="off">
          ${condition}
          <div class="filter-value-cell">${valuePicker}</div>
          ${connector}
          <button type="button" class="filter-delete" data-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('.filter-column').forEach(sel=>sel.addEventListener('change',e=>{
      const i=Number(e.target.dataset.index),f=state.filterDraft[i],h=e.target.value;if(!h)return;
      const current=String(f.formula||'').trim();
      const chosenType=state.types[h]==='text'?'text':'numeric';
      if(!current){
        f.column=h;f.formula=h;f.type=chosenType;f.value='';f.values=[];f.wildcard='';
      }else{
        f.formula=`${current}${h}`;
        f.type=detectFilterDraftType(f);
        if(f.type==='text'){f.value='';}
      }
      renderFilterRows();
      const input=box.querySelector(`.filter-formula[data-index="${i}"]`);
      if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}
      updateFilterDiagnostic();
    }));
    box.querySelectorAll('.filter-formula').forEach(inp=>inp.addEventListener('input',e=>{
      const i=Number(e.target.dataset.index);
      const draft=state.filterDraft[i];
      const before=detectFilterDraftType(draft);
      draft.formula=e.target.value;
      const after=detectFilterDraftType(draft);
      draft.type=after;
      if(before!==after){
        const caret=e.target.selectionStart??draft.formula.length;
        renderFilterRows();
        const replacement=box.querySelector(`.filter-formula[data-index="${i}"]`);
        if(replacement){replacement.focus();const pos=Math.min(caret,replacement.value.length);replacement.setSelectionRange(pos,pos);}
      }
      updateFilterDiagnostic();
    }));
    box.querySelectorAll('.filter-condition').forEach(sel=>sel.addEventListener('change',e=>{state.filterDraft[Number(e.target.dataset.index)].operator=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-value-input').forEach(inp=>inp.addEventListener('input',e=>{state.filterDraft[Number(e.target.dataset.index)].value=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-value-select-button').forEach(btn=>btn.addEventListener('click',e=>openFilterValuePicker(Number(e.target.dataset.index))));
    box.querySelectorAll('.filter-connector').forEach(sel=>sel.addEventListener('change',e=>{state.filterDraft[Number(e.target.dataset.index)].connector=e.target.value;updateFilterDiagnostic();}));
    box.querySelectorAll('.filter-delete').forEach(btn=>btn.addEventListener('click',e=>{state.filterDraft.splice(Number(e.target.dataset.index),1);renderFilterRows();}));
  }
  function openFilterValuePicker(index){
    const dialog=el('filterValueDialog'); if(!dialog)return;
    state.filterValuePickerIndex=index;
    const draft=state.filterDraft[index]||{};
    const textColumn=getFilterTextColumn(draft);
    const title=el('filterValueDialogTitle'); if(title)title.textContent=textColumn||'Select values';
    const list=el('filterValuePickerList'); if(!list)return;
    const values=uniqueColumnValues(textColumn||'');
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
    if(type==='text'){
      const textColumn=getFilterTextColumn(draft);
      const values=Array.isArray(draft.values)?draft.values:[];
      if(!textColumn)return {connector:index===0?'AND':(draft.connector||'AND'),type:'numeric',column:draft.column||formula,formula,operator:draft.operator||'=',value:toNumber(draft.value)};
      if(!values.length)return `Filter ${index+1} needs at least one selected value.`;
      return {connector:index===0?'AND':(draft.connector||'AND'),type:'text',column:textColumn,formula,operator:draft.operator||'=',values,wildcard:''};
    }
    const value=toNumber(draft.value);
    if(value===null)return `Filter ${index+1} needs a numeric value.`;
    // Broken formulas are intentionally allowed through. The row evaluator returns null
    // for an invalid expression, causing those rows to fail the numeric filter rather than
    // closing/resetting the dialog.
    return {connector:index===0?'AND':(draft.connector||'AND'),type:'numeric',column:draft.column||formula,formula,operator:draft.operator||'=',value};
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
      clearCircle();state.storeJumpTarget=null;
    }
    redrawAfterFilterChange();
    updateSelection();
    updateFilterUI();
    el('filterDialog').close();
  }

  function classifyProvincesForBoundary(boundary){
    const features=state.provinceGeo?.features||[];
    if(!boundary?.geometry || !features.length) return [];
    const boundaryBbox=turf.bbox(boundary);
    const result=[];
    for(const feature of features){
      const code=provinceCodeFromFeature(feature);
      if(!code || !CONFIG.daFiles[code]) continue;
      try{
        const fb=turf.bbox(feature);
        if(fb[2] < boundaryBbox[0] || fb[0] > boundaryBbox[2] || fb[3] < boundaryBbox[1] || fb[1] > boundaryBbox[3]){
          result.push({code,status:'outside'});
          continue;
        }
        const provinceBbox=turf.bboxPolygon(fb);
        if(turf.booleanContains(boundary,feature)){
          result.push({code,status:'inside'});
        }else if(turf.booleanDisjoint(feature,boundary)){
          result.push({code,status:'outside'});
        }else{
          result.push({code,status:'partial'});
        }
      }catch(_){
        result.push({code,status:'partial'});
      }
    }
    return result;
  }

  function provincesForBoundaryFromCsd(boundary) {
    if (!boundary?.geometry || !state.csdLookupGeo?.features?.length || !state.csdLookupIndex?.size) return [];
    const bb = turf.bbox(boundary);
    const size = state.csdLookupCellSize;
    const minLat = Math.floor(bb[1] / size), maxLat = Math.floor(bb[3] / size);
    const minLng = Math.floor(bb[0] / size), maxLng = Math.floor(bb[2] / size);
    const candidates = new Set();
    for (let gy = minLat; gy <= maxLat; gy++) {
      for (let gx = minLng; gx <= maxLng; gx++) {
        const bucket = state.csdLookupIndex.get(`${gy}:${gx}`) || [];
        for (const feature of bucket) candidates.add(feature);
      }
    }
    const found = new Set();
    for (const feature of candidates) {
      try {
        const fbb = feature.__headerBBox || (feature.__headerBBox = turf.bbox(feature));
        if (fbb[2] < bb[0] || fbb[0] > bb[2] || fbb[3] < bb[1] || fbb[1] > bb[3]) continue;
        if (turf.booleanIntersects(feature, boundary)) {
          const code = provinceCodeFromCsdFeature(feature);
          if (code) found.add(code);
        }
      } catch {}
    }
    return [...found];
  }

  // ---------- DA spatial selection engine (isolated) ----------
  // This component intentionally knows nothing about stores, KPIs, workbook data,
  // or Census population attributes. Its only job is:
  //   DA GeoJSON -> spatial index -> boundary intersections -> threshold -> DA features.
  const DA_OVERLAY_MIN_ZOOM = 6;
  const DA_LIST_DISPLAY_LIMIT = 500;

  const DA_ENGINE = (() => {
    const cache = new Map();
    const geoCache = new Map();
    const selectionCache = new Map();
    const defaultThresholdPct = 50;

    function getId(feature) {
      const p = feature?.properties || {};
      return String(p.DA_ID ?? p.DAUID ?? p.DAUID_2021 ?? p.DAUID2021 ?? p.GEOUID ?? p.UID ?? '').trim();
    }

    function featureBBox(feature) {
      if (Array.isArray(feature?.bbox) && feature.bbox.length >= 4) return feature.bbox.slice(0, 4);
      return turf.bbox(feature);
    }

    function buildIndex(geo, provinceCode) {
      if (cache.has(provinceCode)) return cache.get(provinceCode);
      const index = new RBush();
      let valid = 0;
      for (const feature of geo?.features || []) {
        if (!feature?.geometry) continue;
        try {
          const bbox = featureBBox(feature);
          if (bbox.some(v => !Number.isFinite(v))) continue;
          index.insert({ minX:bbox[0], minY:bbox[1], maxX:bbox[2], maxY:bbox[3], feature });
          valid++;
        } catch {}
      }
      const entry = { geo, index, featureCount: geo?.features?.length || 0, indexedCount: valid };
      cache.set(provinceCode, entry);
      return entry;
    }

    async function loadProvinceGeo(provinceCode) {
      if (!provinceCode) throw new Error('Province code is required.');
      if (geoCache.has(provinceCode)) return geoCache.get(provinceCode);
      const cached = cache.get(provinceCode);
      if (cached?.geo) {
        geoCache.set(provinceCode, cached.geo);
        return cached.geo;
      }
      const file = CONFIG.daFiles[provinceCode];
      if (!file) throw new Error(`No DA file configured for ${provinceCode}.`);
      const errors = [];
      const sources = [
        `${CONFIG.daReleaseBase}/${encodeURIComponent(file)}`,
        `./${encodeURIComponent(file)}`
      ];
      for (const url of sources) {
        try {
          const geo = await fetchJson(url, {timeout:180000});
          if (!geo?.features) throw new Error('GeoJSON contained no features.');
          geoCache.set(provinceCode, geo);
          return geo;
        } catch (err) {
          errors.push(`${url}: ${err.message}`);
        }
      }
      throw new Error(`Could not load ${provinceCode} DA file ${file}. ${errors.join(' | ')}`);
    }

    async function loadProvinceIndex(provinceCode) {
      if (!provinceCode) throw new Error('Province code is required.');
      if (cache.has(provinceCode)) return cache.get(provinceCode);
      const geo = await loadProvinceGeo(provinceCode);
      return buildIndex(geo, provinceCode);
    }

    async function select(boundary, provinces, thresholdPct, provinceMeta=[]) {
      if (!boundary?.geometry) throw new Error('Active boundary geometry is missing.');
      const threshold = Number.isFinite(Number(thresholdPct)) ? Math.min(100, Math.max(0, Number(thresholdPct))) : defaultThresholdPct;
      const boundaryBbox = turf.bbox(boundary);
      const metaMap=new Map((provinceMeta||[]).map(x=>[x.code,x.status]));
      const resolvedProvinces = [...new Set((provinces || []).filter(code => CONFIG.daFiles[code]))];
      if (!resolvedProvinces.length) throw new Error('Could not determine a Canadian province or territory for the active map boundary.');
      const allInside = resolvedProvinces.every(code => metaMap.get(code) === 'inside');
      const fastCacheKey = allInside
        ? `inside:${resolvedProvinces.slice().sort().join(',')}:threshold:${threshold}`
        : null;
      if (fastCacheKey && selectionCache.has(fastCacheKey)) {
        const cached = selectionCache.get(fastCacheKey);
        return {...cached, boundary, cacheKey:fastCacheKey, cacheHit:true};
      }
      const allCandidates = [];
      const selected = [];
      let actualIntersectionCount = 0;
      let indexedFeatures = 0;
      let fullyContainedProvinceCount = 0;

      for (const provinceCode of resolvedProvinces) {
        const status=metaMap.get(provinceCode)||'partial';
        if(status==='outside') continue;

        // A fully contained province needs its raw DA features, but NOT a spatial index.
        // This is the critical fast path for province-wide and Canada-wide viewports.
        if(status==='inside'){
          const geo = await loadProvinceGeo(provinceCode);
          fullyContainedProvinceCount += 1;
          for(const feature of geo?.features||[]){
            if(!feature?.geometry) continue;
            selected.push({feature,provinceCode,overlapPct:100});
          }
          continue;
        }

        // Partial province: use the existing indexed/exact-intersection path.
        const entry = await loadProvinceIndex(provinceCode);
        indexedFeatures += entry.indexedCount;
        const candidates = entry.index.search({minX:boundaryBbox[0], minY:boundaryBbox[1], maxX:boundaryBbox[2], maxY:boundaryBbox[3]});
        for (const item of candidates) allCandidates.push({provinceCode, feature:item.feature});
      }

      for (const {provinceCode, feature} of allCandidates) {
        try {
          if (!turf.booleanIntersects(feature, boundary)) continue;
          actualIntersectionCount += 1;
          const daArea = turf.area(feature);
          if (!(daArea > 0)) continue;
          const inter = turf.intersect(turf.featureCollection([feature, boundary]));
          if (!inter) continue;
          const overlapPct = turf.area(inter) / daArea * 100;
          if (overlapPct >= threshold) selected.push({feature, provinceCode, overlapPct});
        } catch {}
      }

      selected.sort((a,b) => getId(a.feature).localeCompare(getId(b.feature), undefined, {numeric:true}));
      const result = {
        threshold,
        boundary,
        provinces: resolvedProvinces,
        indexedFeatures,
        candidateCount: allCandidates.length + selected.filter(x=>x.overlapPct===100).length,
        actualIntersectionCount:actualIntersectionCount + selected.filter(x=>x.overlapPct===100).length,
        fullyContainedProvinceCount,
        selected,
        selectedCount: selected.length
      };
      if (fastCacheKey) {
        const cached = {...result};
        delete cached.boundary;
        selectionCache.set(fastCacheKey, cached);
        result.cacheKey = fastCacheKey;
      }
      return result;
    }

    function clearCache() {
      cache.clear();
      geoCache.clear();
      selectionCache.clear();
    }

    return { select, clearCache, getId };
  })();

  function viewportBoundary() {
    const b = map.getBounds();
    return turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  }

  function circleBoundary() {
    const circle = state.circleSelection?.circle;
    if (!circle) return null;
    return turf.circle([circle.getLngLat ? circle.getLngLat().lng : circle.getLatLng().lng, circle.getLatLng().lat], circle.getRadius() / 1000, {units:'kilometers', steps:96});
  }

  function activeDaBoundary() {
    return circleBoundary() || viewportBoundary();
  }

  function setDaTestStatus(text) {
    const note = el('censusNote');
    if (note) note.textContent = text;
  }


  function censusAttributes(feature) {
    const p = feature?.properties || {};
    const total = Number(p.total_population);
    const senior = Number(p.population_65_plus);
    const age40to64 = Number(p.population_40_64);
    const visibleMinority = Number(p.visible_minority_population);
    const households = Number(p.total_households);
    const avgHouseholdIncome = Number(p.average_household_income);
    const totalPopulation = Number.isFinite(total) ? total : 0;
    const population65Plus = Number.isFinite(senior) ? senior : 0;
    const population40Plus = population65Plus + (Number.isFinite(age40to64) ? age40to64 : 0);
    const visibleMinorityPopulation = Number.isFinite(visibleMinority) ? visibleMinority : 0;
    const totalHouseholds = Number.isFinite(households) ? households : 0;
    const householdIncome = Number.isFinite(avgHouseholdIncome) ? avgHouseholdIncome : 0;
    return { totalPopulation, population65Plus, population40Plus, visibleMinorityPopulation, totalHouseholds, householdIncome };
  }

  function censusValueWithShare(value, total) {
    const pct = total > 0 ? Math.round(value / total * 100) : 0;
    return `<span class="census-metric-value">${esc(fmtInt(value))}</span><span class="census-share">(${pct}%)</span>`;
  }

  function updateCensusPopulationSummary(selected) {
    const totals = selected.reduce((acc, item) => {
      const a = censusAttributes(item.feature);
      acc.total += a.totalPopulation;
      acc.senior += a.population65Plus;
      acc.forty += a.population40Plus;
      acc.visibleMinority += a.visibleMinorityPopulation;
      acc.households += a.totalHouseholds;
      acc.incomeWeighted += a.householdIncome * a.totalHouseholds;
      return acc;
    }, {total:0, senior:0, forty:0, visibleMinority:0, households:0, incomeWeighted:0});
    state.censusTotalPopulation = Number.isFinite(totals.total) ? totals.total : null;
    el('censusPopulation').textContent = fmtInt(totals.total);
    el('censusSeniors').innerHTML = censusValueWithShare(totals.senior, totals.total);
    el('censusForty').innerHTML = censusValueWithShare(totals.forty, totals.total);
    el('censusVisibleMinority').innerHTML = censusValueWithShare(totals.visibleMinority, totals.total);
    const storeCount = Number(el('kpiStores')?.textContent?.replace(/,/g,'').trim()) || 0;
    el('censusPopPerStore').textContent = storeCount > 0 ? fmtInt(Math.round(totals.total / storeCount)) : '—';
    el('censusHouseholdIncome').textContent = totals.households > 0 ? `$${fmtInt(Math.round(totals.incomeWeighted / totals.households))}` : '—';
    updateKpis();
  }
  function resetCensusPopulationSummary() {
    state.censusTotalPopulation = null;
    el('censusPopulation').textContent = '—';
    el('censusSeniors').textContent = '—';
    el('censusForty').textContent = '—';
    el('censusVisibleMinority').textContent = '—';
    el('censusPopPerStore').textContent = '—';
    el('censusHouseholdIncome').textContent = '—';
    el('kpiSalesPerPopulation').textContent = '—';
  }

  function renderDaSelection(result) {
    const features = result.selected.map(item => item.feature);
    const canRenderOverlay = state.showDaOverlay && map.getZoom() >= DA_OVERLAY_MIN_ZOOM;
    const renderSignature = `${result.cacheKey || `boundary:${result.selectedCount}:${result.threshold}:${result.provinces.join(',')}`}:overlay:${canRenderOverlay}`;

    if (state.daRenderedSignature === renderSignature) {
      state.daSelectionResult = result;
      return;
    }

    clearDaOverlay();
    state.daSelectionResult = result;
    if (!features.length) {
      setDaTestStatus(`No DAs meet the ${result.threshold}% inclusion threshold. Boundary: ${result.provinces.join(', ') || 'none'}.`);
      resetCensusPopulationSummary();
      const list = el('censusDaList');
      if (list) list.innerHTML = '<div class="empty-message">No qualifying DAs in the active boundary.</div>';
      return;
    }

    state.currentDaProvince = result.provinces.join(',');
    if (canRenderOverlay) {
      state.daLayer = L.geoJSON(turf.featureCollection(features), {
        pane: 'daSelectionPane',
        interactive: false,
        style: daStyle
      }).addTo(map);
    }
    state.daRenderedSignature = renderSignature;

    updateCensusPopulationSummary(result.selected);
    const overlayNote = state.showDaOverlay && !canRenderOverlay
      ? ` DA polygons are hidden below zoom ${DA_OVERLAY_MIN_ZOOM} to keep the Canada-wide view responsive.`
      : '';
    setDaTestStatus(`${features.length.toLocaleString()} DAs selected at >= ${result.threshold}% overlap. ${result.provinces.join(', ') || 'No province'}. Spatial-index candidates: ${result.candidateCount.toLocaleString()}.${overlayNote}`);
    const list = el('censusDaList');
    if (list) {
      const display = result.selected.slice(0, DA_LIST_DISPLAY_LIMIT);
      const rows = display.map(item => {
        const a = censusAttributes(item.feature);
        return `<div class="census-da-row"><span>${esc(DA_ENGINE.getId(item.feature) || '—')}</span><span>${fmtInt(a.totalPopulation)}</span><span>${fmtInt(a.population65Plus)}</span><span>${fmtInt(a.population40Plus)}</span><span>${item.overlapPct.toFixed(1)}%</span></div>`;
      }).join('');
      const remainder = result.selected.length > DA_LIST_DISPLAY_LIMIT
        ? `<div class="empty-message">Showing the first ${DA_LIST_DISPLAY_LIMIT.toLocaleString()} of ${result.selected.length.toLocaleString()} selected DAs. Population totals include all selected DAs.</div>`
        : '';
      list.innerHTML = rows + remainder;
    }
  }

  function scheduleDaRefresh(delay=300, reason='map change') {
    if(state.daRefreshTimer)clearTimeout(state.daRefreshTimer);
    if(reason)state.daActivationTrigger=reason;
    state.daRefreshTimer=setTimeout(()=>{state.daRefreshTimer=null;refreshDaSelection();},Math.max(0,delay));
  }

  async function refreshDaSelection() {
    const trigger = state.daActivationTrigger || 'map change';
    const hasCircle = !!state.circleSelection?.circle;
    const boundaryType = hasCircle ? 'circle' : 'viewport';
    const provinceLabel = state.selection?.provinceCode || '—';
    if (state.initialNationalView) {
      clearDaOverlay();
      resetCensusPopulationSummary();
      const list = el('censusDaList'); if (list) list.innerHTML = '<div class="empty-message">Make a geographic move to activate DA selection.</div>';
      
      setDaTestStatus('DA selection is dormant on the initial Canada view. Pan, zoom, search, draw a circle, or go to a store to activate it.');
      return;
    }
    if (typeof turf === 'undefined' || typeof RBush === 'undefined') {
      
      setDaTestStatus('DA spatial engine could not start because Turf or the spatial-index library did not load.');
      return;
    }
    const threshold = Number(el('censusThreshold')?.value ?? 15);
    const requestId = ++state.censusRequestId;
    state.daSelectionResult = null;
    setDaTestStatus(`Finding DAs using the spatial index (${boundaryType})…`);
    try {
      const boundary = activeDaBoundary();
      await loadHeaderCsdLookup();
      const c = hasCircle ? state.circleSelection.circle.getLatLng() : null;
      const boundaryKey = hasCircle
        ? `circle:${c.lat.toFixed(5)}:${c.lng.toFixed(5)}:${state.circleSelection.circle.getRadius().toFixed(1)}`
        : `viewport:${map.getBounds().toBBoxString()}`;
      let provinceMeta=classifyProvincesForBoundary(boundary);
      let provinces=provinceMeta.filter(x=>x.status!=='outside').map(x=>x.code);
      if(!provinceMeta.length){
        if (boundaryKey === state.daProvinceCacheKey && Array.isArray(state.daProvinceCache)) provinces = state.daProvinceCache;
        else {
          provinces = provincesForBoundaryFromCsd(boundary);
          state.daProvinceCacheKey = boundaryKey;
          state.daProvinceCache = provinces;
        }
      }
      const result = await DA_ENGINE.select(boundary, provinces, threshold, provinceMeta);
      if (requestId !== state.censusRequestId) return;
      
      renderDaSelection(result);
    } catch (err) {
      if (requestId !== state.censusRequestId) return;
      clearDaOverlay();
      
      setDaTestStatus(`DA selection failed: ${err.message}`);
    }
  }

  function goToStoreNumber(){
    const query=String(el('storeNumberInput').value??'').trim();
    const token=++state.searchToken;
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
    const km=2.5;
    closeStorePopup(); clearCircle(); clearDaOverlay(); clearNavigationResult(); state.censusRequestId++;
    state.storeJumpTarget=target;
    state.selection={type:'viewport',name:`Store ${query} — map view`,feature:null,provinceCode:provinceCodeFromText(target[state.columns.province]||''),radius:null};
    state.initialNationalView=false; state.mapReadyForViewport=true; state.daActivationTrigger='store jump';
    const dLat=km/110.5, dLon=km/(111*Math.cos(lat*Math.PI/180));
    const targetBounds=L.latLngBounds([[lat-dLat,lng-dLon],[lat+dLat,lng+dLon]]);
    fitMapProgrammatically(targetBounds,{padding:[25,25]});
    el('storeJumpStatus').textContent=`Showing store ${query}.`;
    let completed=false;
    const finish=()=>{
      if(completed || token!==state.searchToken)return;
      completed=true;
      showNavigationResult(lat,lng,'store',target);
    };
    map.once('moveend',finish);
    setTimeout(finish,900);
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
    const fadeRow=el('markerFadeObjectRow'); if(fadeRow) fadeRow.style.display=a.type==='fade'?'flex':'none';
    const fadeObject=el('markerFadeObject'); if(fadeObject) fadeObject.value=a.fadeObject||'smiley';
    const typeSummary=el('markerAnimationTypeSummary'); if(typeSummary) typeSummary.textContent=a.type==='fade'?'Fade':(a.type==='static'?'Static':'Ripple');
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
    el('markerAnimationType').addEventListener('change',e=>{state.markerAnimation.type=e.target.value;saveMarkerAnimationConfig();rebuildMarkerAnimationCache();refreshMarkerAnimationUI();});
    el('markerFadeObject').addEventListener('change',e=>{state.markerAnimation.fadeObject=e.target.value;saveMarkerAnimationConfig();refreshMarkerStyles();populateMarkerAnimationControls();});
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

  const POPUP_STORAGE_KEY='cse_popup_config_v171';

  // ---------- Ticker ----------
  const TICKER_STORAGE_KEY='cse_ticker_config_v075_exact';
  const TICKER_OLD_STORAGE_KEYS=['cse_ticker_config_v074_exact','cse_ticker_config_v075_exact','cse_ticker_config_v075_exact'];
  const TICKER_DEFAULT_SPEED=70;
  const TICKER_DEFAULTS=[
    {title:'',formula:'',aggregation:'sum',numberFormat:'auto',decimalPlaces:0},
    {title:'',formula:'',aggregation:'average',numberFormat:'auto',decimalPlaces:0},
    {title:'Stores',formula:'1',aggregation:'sum',numberFormat:'number',decimalPlaces:0}
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
  function firstTickerOperand(formula){
    const tokens=tokenizeTicker(String(formula??'').trim())||[];
    const operand=tokens.find(t=>t.type==='operand'&&String(t.value||'').trim());
    return operand?String(operand.value).trim():'';
  }
  function normalizeTickerMetric(m){
    const aggregation=['sum','average','median'].includes(m?.aggregation)?m.aggregation:'sum';
    const numberFormat=['auto','number','currency','percentage'].includes(m?.numberFormat)?m.numberFormat:'auto';
    const rawDecimals=Number(m?.decimalPlaces);
    const decimalPlaces=Number.isInteger(rawDecimals)&&rawDecimals>=0&&rawDecimals<=4?rawDecimals:defaultTickerDecimals(numberFormat);
    const formula=m?.formula===null?'':String(m?.formula??'');
    const suppliedTitle=String(m?.title??'');
    const title=suppliedTitle||firstTickerOperand(formula);
    return {title,formula,aggregation,numberFormat,decimalPlaces};
  }
  function tickerColumns(){return state.headers.filter(h=>state.types[h]==='numeric');}
  function tickerDefaultMetrics(){
    const sales=state.columns.sales||'';
    const ebit=state.columns.ebit||'';
    return [
      {title:firstTickerOperand(sales),formula:sales,aggregation:'sum',numberFormat:'auto',decimalPlaces:0},
      {title:firstTickerOperand(ebit),formula:ebit,aggregation:'average',numberFormat:'auto',decimalPlaces:0},
      {title:'Stores',formula:'1',aggregation:'sum',numberFormat:'number',decimalPlaces:0}
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
    const title=String(m?.title??'').trim();
    if(title)return title;
    return firstTickerOperand(m?.formula)||'Metric';
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
  function formulaIssue(formula){
    const text=String(formula??'').trim();
    if(!text)return 'Invalid formula';
    const tokens=tokenizeTicker(text);
    if(!tokens)return 'Invalid formula';
    const workbookOperands=tokens.filter(t=>t.type==='operand'&&!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value));
    const nonNumeric=workbookOperands.filter(t=>state.types[t.value]!=='numeric');
    if(nonNumeric.length){
      return nonNumeric.length===workbookOperands.length
        ? 'Invalid formula: choose numeric columns for calculations.'
        : 'Invalid formula: non-numeric columns cannot be combined with numeric columns.';
    }
    return tickerFormulaValid(text)?'':'Invalid formula';
  }
  function updateFormulaValidation(input,warning,validator=formulaIssue){
    const issue=validator(input.value);
    input.classList.toggle('formula-invalid',!!issue);
    input.setAttribute('aria-invalid',issue?'true':'false');
    if(warning){warning.textContent=issue||'';warning.hidden=!issue;}
    return !issue;
  }
  function metricConfigHeaderHTML({kind, idx, title, extraControls=''}){
    const titleClass = kind==='popup' ? 'popup-title-input' : (kind==='subject' ? 'subject-title-input' : 'ticker-title-input');
    const titlePlaceholder = kind==='popup' ? 'Popup title' : (kind==='subject' ? 'Subject title' : 'Ticker title');
    const dragClass='ticker-drag-handle';
    const removeClass=kind==='popup'?'popup-remove':(kind==='subject'?'subject-remove':'ticker-remove');
    return `<div class="metric-row-head ${kind}-row-head"><strong>${kind==='popup'?'Field':'Metric'} ${idx+1}</strong><label class="metric-title-field"><span>Title</span><input class="${titleClass}" data-index="${idx}" value="${esc(title||'')}" placeholder="${titlePlaceholder}"></label>${extraControls}<span class="${dragClass}" draggable="true" title="Drag to reorder" aria-label="Drag to reorder">↕</span><button type="button" class="icon-btn ${removeClass}" data-index="${idx}" aria-label="Remove ${kind==='popup'?'field':'metric'}">×</button></div>`;
  }
  function metricConfigSettingsHTML({kind, idx, headers, formula, numberFormat, decimalPlaces, aggregation, directSelected=''}){
    const prefix = kind==='popup'?'popup':(kind==='subject'?'subject':'ticker');
    const formulaClass = `${prefix}-formula-input`;
    const columnClass = kind==='popup'?'popup-column-select':`${prefix}-operand-select`;
    const numberClass = `${prefix}-number-format-select`;
    const decimalClass = `${prefix}-decimal-select`;
    const aggregationClass = `${prefix}-aggregation-select`;
    const isPopup=kind==='popup';
    const aggregationMarkup = isPopup ? '' : `<label>Aggregation<select class="${aggregationClass}" data-index="${idx}"><option value="sum" ${aggregation==='sum'?'selected':''}>Sum</option><option value="average" ${aggregation==='average'?'selected':''}>Average</option><option value="median" ${aggregation==='median'?'selected':''}>Median</option></select></label>`;
    const popupVirtualMarkup = isPopup ? `<optgroup label="Census virtual fields">${popupVirtualNames().map(name=>`<option value="${esc(name)}" ${directSelected===name?'selected':''}>${esc(name)}</option>`).join('')}</optgroup>` : '';
    const headerMarkup=headers.map(h=>`<option value="${esc(h)}" ${directSelected===h?'selected':''}>${esc(h)}</option>`).join('');
    return `<div class="metric-settings-row ${isPopup?'metric-settings-popup':'metric-settings-standard'}"><label>Choose column<select class="${columnClass}" data-index="${idx}"><option value="">Choose column</option>${isPopup?`<optgroup label="Workbook columns">${headerMarkup}</optgroup>${popupVirtualMarkup}`:headerMarkup}</select></label><label class="metric-formula-field">Formula<input class="${formulaClass}" data-index="${idx}" value="${esc(formula||'')}" placeholder="Choose a column or combine columns with + - × / ( )" autocomplete="off"><span class="formula-warning" hidden></span></label><label>Number format<select class="${numberClass}" data-index="${idx}"><option value="auto" ${numberFormat==='auto'?'selected':''}>Auto</option><option value="number" ${numberFormat==='number'?'selected':''}>Number</option><option value="currency" ${numberFormat==='currency'?'selected':''}>Currency</option><option value="percentage" ${numberFormat==='percentage'?'selected':''}>Percentage</option></select></label><label>Decimals<select class="${decimalClass}" data-index="${idx}">${[0,1,2,3,4].map(n=>`<option value="${n}" ${decimalPlaces===n?'selected':''}>${n}</option>`).join('')}</select></label>${aggregationMarkup}</div>`;
  }
  function attachMetricDragHandlers(wrap,stateArray,rerender){
    let dragFrom=-1;
    wrap.querySelectorAll('.metric-config-row').forEach(row=>{
      const handle=row.querySelector('.ticker-drag-handle');
      handle?.addEventListener('dragstart',e=>{dragFrom=Number(row.dataset.index);row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.index);});
      handle?.addEventListener('dragend',()=>{dragFrom=-1;row.classList.remove('dragging');});
      row.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';row.classList.add('drag-over');});
      row.addEventListener('dragleave',()=>row.classList.remove('drag-over'));
      row.addEventListener('drop',e=>{e.preventDefault();row.classList.remove('drag-over');const from=dragFrom>=0?dragFrom:Number(e.dataTransfer.getData('text/plain'));const to=Number(row.dataset.index);if(!Number.isInteger(from)||!Number.isInteger(to)||from===to||from<0||to<0||from>=stateArray.length||to>=stateArray.length)return;const [moved]=stateArray.splice(from,1);stateArray.splice(to,0,moved);rerender();});
    });
  }
  function renderTickerConfig(){
    const wrap=el('tickerMetricList');if(!wrap)return;const cols=state.headers.length?state.headers:[];
    wrap.replaceChildren();
    if(!cols.length){wrap.innerHTML='<div class="empty-message">Load a financial workbook first. The ticker uses workbook columns as operands.</div>';return;}
    state.tickerConfigDraft.forEach((m,idx)=>{
      const derivedTitle=m.title||firstTickerOperand(m.formula)||'';
      if(!m.title&&derivedTitle)m.title=derivedTitle;
      const row=document.createElement('div');row.className='metric-config-row ticker-config-row';row.draggable=false;row.dataset.index=idx;
      row.innerHTML=metricConfigHeaderHTML({kind:'ticker',idx,title:m.title})+metricConfigSettingsHTML({kind:'ticker',idx,headers:cols,formula:m.formula,numberFormat:m.numberFormat,decimalPlaces:m.decimalPlaces,aggregation:m.aggregation});
      wrap.appendChild(row);
    });
    const speedInput=el('tickerSpeed');const speedValue=el('tickerSpeedValue');if(speedInput){speedInput.value=String(state.tickerConfigDraftSpeed);if(speedValue)speedValue.textContent=String(state.tickerConfigDraftSpeed);}
    wrap.querySelectorAll('.ticker-title-input').forEach(s=>s.addEventListener('input',e=>{state.tickerConfigDraft[+e.target.dataset.index].title=e.target.value;}));
    wrap.querySelectorAll('.ticker-formula-input').forEach(s=>{const warning=s.parentElement.querySelector('.formula-warning');updateFormulaValidation(s,warning);s.addEventListener('input',e=>{const i=+e.target.dataset.index;const m=state.tickerConfigDraft[i];m.formula=e.target.value;if(!m.title.trim()){const derived=firstTickerOperand(m.formula);if(derived)m.title=derived;}updateFormulaValidation(e.target,warning);});});
    wrap.querySelectorAll('.ticker-aggregation-select').forEach(s=>s.addEventListener('change',e=>{state.tickerConfigDraft[+e.target.dataset.index].aggregation=e.target.value;}));
    wrap.querySelectorAll('.ticker-number-format-select').forEach(s=>s.addEventListener('change',e=>{const i=+e.target.dataset.index;const m=state.tickerConfigDraft[i];m.numberFormat=e.target.value;m.decimalPlaces=defaultTickerDecimals(m.numberFormat);renderTickerConfig();}));
    wrap.querySelectorAll('.ticker-decimal-select').forEach(s=>s.addEventListener('change',e=>{state.tickerConfigDraft[+e.target.dataset.index].decimalPlaces=Number(e.target.value);}));
    wrap.querySelectorAll('.ticker-operand-select').forEach(s=>s.addEventListener('change',e=>{const i=+e.target.dataset.index;const chosen=e.target.value;if(chosen){const m=state.tickerConfigDraft[i];const input=wrap.querySelector(`.ticker-formula-input[data-index="${i}"]`);const current=input.value.trim();input.value=current?`${current}${chosen}`:chosen;m.formula=input.value;if(!m.title.trim()){m.title=firstTickerOperand(m.formula)||chosen;const titleInput=wrap.querySelector(`.ticker-title-input[data-index="${i}"]`);if(titleInput)titleInput.value=m.title;}updateFormulaValidation(input,input.parentElement.querySelector('.formula-warning'),popupFormulaIssue);}e.target.value='';}));
    wrap.querySelectorAll('.ticker-remove').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const i=Number(b.dataset.index);if(!Number.isInteger(i)||i<0||i>=state.tickerConfigDraft.length)return;state.tickerConfigDraft.splice(i,1);renderTickerConfig();}));
    attachMetricDragHandlers(wrap,state.tickerConfigDraft,renderTickerConfig);
  }
  function validateTickerDraft(){
    if(!state.headers.length)return 'Load a financial workbook before saving the ticker.';
    if(!state.tickerConfigDraft.length)return 'Add at least one ticker metric.';
    const exactHeaders=new Set(state.headers);
    for(const [i,m] of state.tickerConfigDraft.entries()){
      const formula=String(m.formula||'').trim();
      if(!formula)return `Metric ${i+1} needs a formula.`;
      const issue=formulaIssue(formula);
      if(issue)return `Metric ${i+1}: ${issue}.`;
      const tokens=tokenizeTicker(formula)||[];
      for(const t of tokens){
        if(t.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value)&&!exactHeaders.has(t.value))return `Metric ${i+1} uses a column that is not present in the workbook: ${t.value}`;
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
    el('tickerAddMetric').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();state.tickerConfigDraft.push({title:'',formula:tickerDefaultFormula(),aggregation:'sum',numberFormat:'auto',decimalPlaces:0});renderTickerConfig();});
    el('tickerSpeed').addEventListener('input',e=>{state.tickerConfigDraftSpeed=Number(e.target.value)||TICKER_DEFAULT_SPEED;el('tickerSpeedValue').textContent=`${state.tickerConfigDraftSpeed}`;});
    el('tickerReset').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();resetTickerDefaults();});
    el('tickerApply').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applyTickerConfig();});
  }
  el('popupConfigBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openPopupConfig();});
  el('popupAddField').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const column=state.headers[0]||'';state.popupConfigDraft.push({type:'column',column,formula:'',title:column,numberFormat:'auto',decimalPlaces:0});renderPopupConfig();});
  el('popupReset').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();resetPopupDefaults();});
  el('popupApply').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applyPopupConfig();});
  el('subjectAddMetric').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();state.subjectConfigDraft.push({title:'',formula:tickerDefaultFormula(),aggregation:'average',numberFormat:'auto',decimalPlaces:0});renderSubjectConfig();});
  el('subjectReset').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();resetSubjectDefaults();});
  el('subjectApply').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applySubjectConfig();});
  // ---------- Subjects configuration ----------
  function openSubjectConfig(){
    if(!state.headers.length||!state.rows.length){alert('Load a financial workbook before configuring Subjects.');return;}
    state.subjectConfigDraft=state.subjects.length?state.subjects.map(normalizeSubjectMetric):subjectDefaultMetrics();
    renderSubjectConfig();
    el('subjectsDialog').showModal();
  }
  function renderSubjectConfig(){
    const wrap=el('subjectMetricList');if(!wrap)return;
    const cols=state.headers.length?state.headers:[];
    wrap.replaceChildren();
    if(!cols.length){wrap.innerHTML='<div class="empty-message">Load a financial workbook first. Subjects use workbook columns as operands.</div>';return;}
    (state.subjectConfigDraft||[]).forEach((m,idx)=>{
      const derivedTitle=m.title||firstTickerOperand(m.formula)||'';
      if(!m.title&&derivedTitle)m.title=derivedTitle;
      const row=document.createElement('div');row.className='metric-config-row subject-config-row';row.draggable=false;row.dataset.index=idx;
      row.innerHTML=metricConfigHeaderHTML({kind:'subject',idx,title:tickerMetricTitle(m)})+metricConfigSettingsHTML({kind:'subject',idx,headers:cols,formula:m.formula,numberFormat:m.numberFormat,decimalPlaces:m.decimalPlaces,aggregation:m.aggregation});
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('.subject-title-input').forEach(input=>input.addEventListener('input',e=>{state.subjectConfigDraft[+e.target.dataset.index].title=e.target.value;}));
    wrap.querySelectorAll('.subject-formula-input').forEach(input=>{const warning=input.parentElement.querySelector('.formula-warning');updateFormulaValidation(input,warning);input.addEventListener('input',e=>{const i=+e.target.dataset.index;const m=state.subjectConfigDraft[i];m.formula=e.target.value;if(!m.title.trim()){const derived=firstTickerOperand(m.formula);if(derived)m.title=derived;}updateFormulaValidation(e.target,warning);});});
    wrap.querySelectorAll('.subject-operand-select').forEach(select=>select.addEventListener('change',e=>{const i=+e.target.dataset.index;const chosen=e.target.value;if(!chosen)return;const m=state.subjectConfigDraft[i];const formulaInput=wrap.querySelector(`.subject-formula-input[data-index="${i}"]`);const current=formulaInput.value.trim();formulaInput.value=current?`${current}${chosen}`:chosen;m.formula=formulaInput.value;if(!String(m.title||'').trim()){m.title=firstTickerOperand(m.formula)||chosen;const titleInput=wrap.querySelector(`.subject-title-input[data-index="${i}"]`);if(titleInput)titleInput.value=m.title;}updateFormulaValidation(formulaInput,formulaInput.parentElement.querySelector('.formula-warning'));select.value='';}));
    wrap.querySelectorAll('.subject-number-format-select').forEach(select=>select.addEventListener('change',e=>{const i=+e.target.dataset.index;const m=state.subjectConfigDraft[i];m.numberFormat=e.target.value;m.decimalPlaces=defaultTickerDecimals(m.numberFormat);renderSubjectConfig();}));
    wrap.querySelectorAll('.subject-decimal-select').forEach(select=>select.addEventListener('change',e=>{state.subjectConfigDraft[+e.target.dataset.index].decimalPlaces=Number(e.target.value);}));
    wrap.querySelectorAll('.subject-aggregation-select').forEach(select=>select.addEventListener('change',e=>{state.subjectConfigDraft[+e.target.dataset.index].aggregation=e.target.value;}));
    wrap.querySelectorAll('.subject-remove').forEach(btn=>btn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const i=Number(btn.dataset.index);if(i>=0&&i<state.subjectConfigDraft.length){state.subjectConfigDraft.splice(i,1);renderSubjectConfig();}}));
    attachMetricDragHandlers(wrap,state.subjectConfigDraft,renderSubjectConfig);
  }
  function validateSubjectDraft(){
    if(!state.headers.length)return 'Load a financial workbook before saving Subjects.';
    const exactHeaders=new Set(state.headers);
    for(const [i,m] of state.subjectConfigDraft.entries()){
      const formula=String(m.formula||'').trim();
      if(!formula)return `Metric ${i+1} needs a formula.`;
      const issue=formulaIssue(formula);
      if(issue)return `Metric ${i+1}: ${issue}.`;
      for(const t of tokenizeTicker(formula)||[]){
        if(t.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value)&&!exactHeaders.has(t.value))return `Metric ${i+1} uses a column that is not present in the workbook: ${t.value}`;
      }
    }
    return '';
  }
  function applySubjectConfig(){
    const error=validateSubjectDraft();if(error){alert(error);return;}
    state.subjects=state.subjectConfigDraft.map(normalizeSubjectMetric);
    refreshConfigUI();updateSubjects();updateGroups();updateDistribution();refreshMarkerStyles();el('subjectsDialog').close();
  }
  function resetSubjectDefaults(){
    const names=['total sales','gross profit','total labour expense','total occupancy expense','store 4 wall profit ebit'];
    const exactHeaders=new Map(state.headers.map(h=>[norm(h),h]));
    state.subjectConfigDraft=subjectDefaultMetrics(names.map(n=>exactHeaders.get(n)).filter(Boolean));
    renderSubjectConfig();
  }

  // ---------- Popup configuration ----------
  function openPopupConfig(){
    if(!state.headers.length||!state.rows.length){alert('Load a financial workbook before configuring popups.');return;}
    if(!state.popupHeader)loadPopupHeaderConfig();
    state.popupHeaderDraft=normalizePopupHeader(state.popupHeader);
    if(!Array.isArray(state.popupConfig)||!state.popupConfig.length) loadPopupConfig(); state.popupConfigDraft=state.popupConfig.map(normalizePopupField);
    renderPopupHeaderConfig();bindPopupHeaderConfig();
    renderPopupConfig();
    el('popupDialog').showModal();
  }
  function renderPopupConfig(){
    const wrap=el('popupFieldList');if(!wrap)return;
    const cols=state.headers.length?state.headers:[];
    wrap.replaceChildren();
    if(!cols.length){wrap.innerHTML='<div class="empty-message">Load a financial workbook first.</div>';return;}
    (state.popupConfigDraft||[]).forEach((raw,idx)=>{
      const field=normalizePopupField(raw);state.popupConfigDraft[idx]=field;
      const row=document.createElement('div');row.className='metric-config-row popup-config-row';row.draggable=false;row.dataset.index=idx;
      row.innerHTML=metricConfigHeaderHTML({kind:'popup',idx,title:field.title,extraControls:'<select class="popup-placeholder-select" data-index="'+idx+'" aria-label="Popup placeholder one"><option value="">Placeholder</option></select><select class="popup-placeholder-select" data-index="'+idx+'" aria-label="Popup placeholder two"><option value="">Placeholder</option></select>'})+metricConfigSettingsHTML({kind:'popup',idx,headers:cols,formula:field.formula,numberFormat:field.numberFormat,decimalPlaces:field.decimalPlaces,directSelected:popupDirectColumn(field)});
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('.popup-title-input').forEach(input=>input.addEventListener('input',e=>{state.popupConfigDraft[+e.target.dataset.index].title=e.target.value;}));
    wrap.querySelectorAll('.popup-placeholder-select').forEach(select=>select.addEventListener('change',()=>{}));
    wrap.querySelectorAll('.popup-column-select').forEach(select=>select.addEventListener('change',e=>{
      const i=+e.target.dataset.index;const f=state.popupConfigDraft[i];const chosen=e.target.value;if(!chosen)return;
      const input=wrap.querySelector(`.popup-formula-input[data-index="${i}"]`);const current=input.value.trim();
      input.value=current?`${current}${chosen}`:chosen;f.formula=input.value.trim();f.column=state.headers.includes(f.formula)?f.formula:'';f.type=state.headers.includes(f.formula)?'column':(isPopupVirtualOperand(f.formula)?'virtual':'formula');
      if(!f.title.trim()){f.title=chosen;const t=wrap.querySelector(`.popup-title-input[data-index="${i}"]`);if(t)t.value=chosen;}
      updateFormulaValidation(input,input.parentElement.querySelector('.formula-warning'),popupFormulaIssue);
    }));
    wrap.querySelectorAll('.popup-formula-input').forEach(input=>{
      const warning=input.parentElement.querySelector('.formula-warning');
      updateFormulaValidation(input,warning,popupFormulaIssue);
      input.addEventListener('input',e=>{
        const i=+e.target.dataset.index;const f=state.popupConfigDraft[i];f.formula=e.target.value.trim();f.column=state.headers.includes(f.formula)?f.formula:'';f.type=state.headers.includes(f.formula)?'column':(isPopupVirtualOperand(f.formula)?'virtual':'formula');
        if(!f.title.trim()){const derived=firstTickerOperand(f.formula)||popupDirectColumn(f);if(derived){f.title=derived;const t=wrap.querySelector(`.popup-title-input[data-index="${i}"]`);if(t)t.value=derived;}}
        updateFormulaValidation(e.target,warning,popupFormulaIssue);
      });
    });
    wrap.querySelectorAll('.popup-number-format-select').forEach(select=>select.addEventListener('change',e=>{const i=+e.target.dataset.index;const f=state.popupConfigDraft[i];f.numberFormat=e.target.value;f.decimalPlaces=defaultTickerDecimals(f.numberFormat);renderPopupConfig();}));
    wrap.querySelectorAll('.popup-decimal-select').forEach(select=>select.addEventListener('change',e=>{state.popupConfigDraft[+e.target.dataset.index].decimalPlaces=Number(e.target.value);}));
    wrap.querySelectorAll('.popup-remove').forEach(btn=>btn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const i=Number(btn.dataset.index);if(i>=0&&i<state.popupConfigDraft.length){state.popupConfigDraft.splice(i,1);renderPopupConfig();}}));
    attachMetricDragHandlers(wrap,state.popupConfigDraft,renderPopupConfig);
  }
  function validatePopupDraft(){
    if(!state.headers.length)return 'Load a financial workbook before saving the popup.';
    const exactHeaders=new Set(state.headers);
    for(const [i,raw] of state.popupConfigDraft.entries()){
      const f=normalizePopupField(raw);
      if(!f.formula)return `Field ${i+1}: choose a column or enter a formula.`;
      if(exactHeaders.has(f.formula)||isPopupVirtualOperand(f.formula))continue;
      const issue=popupFormulaIssue(f.formula);if(issue)return `Field ${i+1}: ${issue}.`;
      for(const t of tokenizePopup(f.formula)||[]){if(t.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(t.value)&&!exactHeaders.has(t.value)&&!isPopupVirtualOperand(t.value))return `Field ${i+1} uses a column that is not present in the workbook: ${t.value}`;}
    }
    return '';
  }
  async function applyPopupConfig(){
    const error=validatePopupDraft();if(error){alert(error);return;}
    state.popupConfig=state.popupConfigDraft.map(normalizePopupField);
    state.popupHeader=normalizePopupHeader(state.popupHeaderDraft||state.popupHeader);
    savePopupConfig();
    savePopupHeaderConfig();
    refreshConfigUI();
    if(state.openPopupMarker){const marker=state.openPopupMarker;storePopupCard.innerHTML=await popupCardContent(marker.__row);if(state.openPopupMarker===marker){const closeBtn=storePopupCard.querySelector('.store-popup-close');closeBtn?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();closeStorePopup();});requestStorePopupLayout();}}
    el('popupDialog').close();
  }
  function resetPopupDefaults(){state.popupConfigDraft=popupDefaultFieldsFromSubjects();renderPopupConfig();}

  // ---------- UI wiring ----------
  el('fileInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;el('fileStatus').textContent='Reading workbook locally…';try{afterWorkbookLoaded(file,await readFinancialFile(file));}catch(err){el('fileStatus').textContent=`Could not read file: ${err.message}`;}});
  el('clearFileBtn').addEventListener('click',clearFinancial);
  el('storeJumpForm').addEventListener('submit',e=>{e.preventDefault();goToStoreNumber();});
  el('storeNumberInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();goToStoreNumber();}});
  el('searchForm').addEventListener('submit',e=>{e.preventDefault();geocodeAndRadius(el('searchInput').value);});
  function circleRadiusLabelText(radiusMeters){
    const km=radiusMeters/1000;
    return `${km.toFixed(km<1?2:1)} km`;
  }
  function makeCircleRadiusLabel(latlng,radiusMeters){
    return L.marker(latlng,{interactive:false,zIndexOffset:1700,icon:L.divIcon({className:'circle-radius-label',html:`<span>${circleRadiusLabelText(radiusMeters)}</span>`,iconSize:[54,24],iconAnchor:[27,-14]})});
  }
  // Keep the resize handle / radius label on the east side of the circle.
  // This is intentionally a lightweight local approximation because the visible
  // selection circle itself is rendered by Leaflet's native L.Circle.
  function circleEdgeLatLng(center,meters){
    const latRad=center.lat*Math.PI/180;
    const cosLat=Math.max(Math.cos(latRad),1e-6);
    return L.latLng(center.lat,center.lng + meters/(111320*cosLat));
  }
  function updateCircleLabel(){
    const circle=state.circleSelection?.circle;
    const label=state.circleSelection?.label;
    if(!circle||!label)return;
    label.setLatLng(circleEdgeLatLng(circle.getLatLng(),circle.getRadius()));
    const node=label.getElement()?.querySelector('span');
    if(node)node.textContent=circleRadiusLabelText(circle.getRadius());
  }

  // ---------- Selection circle interaction ----------
  function updateHeaderCircleIndicator(){
    const wrap=el('headerCircleStatus');
    const value=el('headerCircleRadius');
    if(!wrap||!value)return;
    const circle=state.circleSelection?.circle;
    if(circle){
      const km=circle.getRadius()/1000;
      value.textContent=`${km.toFixed(km<1?2:1)} km`;
      wrap.classList.remove('hidden');
    }else{
      value.textContent='— km';
      wrap.classList.add('hidden');
    }
  }

  function setLeftPanelCollapsed(collapsed){
    state.leftPanelCollapsed=!!collapsed;
    document.body.classList.toggle('left-panel-collapsed',state.leftPanelCollapsed);
    const btn=el('leftPanelToggle');
    if(btn){
      btn.setAttribute('aria-expanded',String(!state.leftPanelCollapsed));
      btn.setAttribute('aria-label',state.leftPanelCollapsed?'Expand controls':'Collapse controls');
      const icon=btn.querySelector('span');
      if(icon)icon.textContent=state.leftPanelCollapsed?'›':'‹';
    }
    requestAnimationFrame(()=>{
      map.invalidateSize(false);
      updateSelection();
      if(state.openPopupMarker)positionStorePopup(true);
    });
  }

  function setCircleIndicator(active){
    const dot=el('circleIndicator');
    if(!dot)return;
    dot.className=active?'circle-indicator-on':'circle-indicator-off';
    dot.setAttribute('aria-label',active?'Selection circle active':'No selection circle active');
    el('clearCircleBtn').disabled=!active;
  }
  function updateCircleRadiusCounter(){
    const km=state.circleSelection?.circle?state.circleSelection.circle.getRadius()/1000:NaN;
    el('circleRadiusCounter').textContent=Number.isFinite(km)?km.toFixed(km<1?2:1):'—';
    updateHeaderCircleIndicator();
  }
  function removeCircleHandles(){
    state.circleEditHandles.forEach(h=>map.removeLayer(h));
    state.circleEditHandles=[];
  }
  function showCircleHandles(){
    removeCircleHandles();
    const circle=state.circleSelection?.circle;if(!circle)return;
    const center=circle.getLatLng();
    const edge=circleEdgeLatLng(center,circle.getRadius());
    const centerHandle=L.marker(center,{draggable:true,interactive:true,zIndexOffset:1800,icon:L.divIcon({className:'circle-edit-handle circle-center-handle',html:'<span aria-hidden="true"></span>',iconSize:[20,20],iconAnchor:[10,10]})}).addTo(map);
    const radiusHandle=L.marker(edge,{draggable:true,interactive:true,zIndexOffset:1801,icon:L.divIcon({className:'circle-edit-handle circle-radius-handle',html:'<span aria-hidden="true"></span>',iconSize:[20,20],iconAnchor:[10,10]})}).addTo(map);
    centerHandle.on('drag',e=>{
      if(!state.circleSelection)return;
      const ll=e.target.getLatLng();
      circle.setLatLng(ll);
      radiusHandle.setLatLng(circleEdgeLatLng(ll,circle.getRadius()));
      updateCircleRadiusCounter();updateCircleLabel();scheduleSelectionUpdate();state.daProvinceCacheKey=null;state.daProvinceCache=null;scheduleDaRefresh(120,'circle moved');
    });
    radiusHandle.on('drag',e=>{
      if(!state.circleSelection)return;
      const ll=e.target.getLatLng();
      const center=circle.getLatLng();
      const radius=Math.max(10,map.distance(center,ll));
      circle.setRadius(radius);
      radiusHandle.setLatLng(circleEdgeLatLng(center,radius));
      updateCircleRadiusCounter();updateCircleLabel();scheduleSelectionUpdate();state.daProvinceCacheKey=null;state.daProvinceCache=null;scheduleDaRefresh(120,'circle moved');
    });
    state.circleEditHandles=[centerHandle,radiusHandle];
  }
  function enterCircleDrawMode(){
    state.circleDrawMode=true;state.markerClickSuppressed=true;
    map.getContainer().style.cursor='crosshair';
    el('drawCircleBtn').querySelector('span:last-child').textContent='Drawing… drag on map';
    removeCircleHandles();
  }
  function exitCircleDrawMode(){
    state.circleDrawMode=false;state.circleDrawing=null;state.markerClickSuppressed=false;
    map.getContainer().style.cursor='';
    el('drawCircleBtn').querySelector('span:last-child').textContent='Draw';
  }
  function createOrReplaceCircle(center,radiusMeters,reason='circle draw'){
    state.initialNationalView=false;
    state.mapReadyForViewport=true;
    state.daActivationTrigger=reason;
    clearCircle();
    state.daProvinceCacheKey=null; state.daProvinceCache=null;
    const radius=Math.max(10,radiusMeters);
    const circle=L.circle(center,{pane:'selectionCirclePane',radius,color:'#d33e46',weight:3,opacity:1,fillOpacity:0,interactive:true,lineCap:'round',lineJoin:'round'}).addTo(map);
    circle.on('click',e=>{L.DomEvent.stopPropagation(e);showCircleHandles();});
    const label=makeCircleRadiusLabel(circleEdgeLatLng(center,radius),radius).addTo(map);
    state.circleSelection={circle,label};
    setCircleIndicator(true);updateCircleRadiusCounter();updateCircleLabel();showCircleHandles();
    updateSelection();
    refreshDaSelection();
    if(!map.getBounds().contains(circle.getBounds().getNorthEast()) || !map.getBounds().contains(circle.getBounds().getSouthWest())){
      fitMapProgrammatically(circle.getBounds(),{padding:[30,30],maxZoom:map.getZoom()});
    }
  }
  function clearCircle(){
    removeCircleHandles();state.markerClickSuppressed=false;
    if(state.daRefreshTimer){clearTimeout(state.daRefreshTimer);state.daRefreshTimer=null;}
    state.censusRequestId++;
    if(state.circleSelection?.label)map.removeLayer(state.circleSelection.label);
    if(state.circleSelection?.circle)map.removeLayer(state.circleSelection.circle);
    state.circleSelection=null;
    state.circleDrawing=null;
    state.daProvinceCacheKey=null; state.daProvinceCache=null;
    setCircleIndicator(false);
    if(state.circleDrawMode)exitCircleDrawMode();
    updateCircleRadiusCounter();
  }
  el('drawCircleBtn').addEventListener('click',()=>{
    if(state.circleDrawMode){exitCircleDrawMode();return;}
    enterCircleDrawMode();
  });
  el('clearCircleBtn').addEventListener('click',()=>{state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger=state.daActivationTrigger||'circle clear';clearCircle();updateSelection();scheduleDaRefresh(0,'circle clear');});
  map.on('mousedown',e=>{
    if(!state.circleDrawMode || state.circleDrawing || !e.originalEvent)return;
    state.circleDrawing={center:e.latlng};
    map.dragging.disable();
    const temp=L.circle(e.latlng,{pane:'selectionCirclePane',radius:1,color:'#d33e46',weight:3,opacity:1,fillOpacity:0,interactive:false,lineCap:'round',lineJoin:'round'}).addTo(map);
    const label=makeCircleRadiusLabel(circleEdgeLatLng(e.latlng,1),1).addTo(map);
    state.circleDrawing.temp=temp;
    state.circleDrawing.label=label;
    map.getContainer().style.cursor='crosshair';
  });
  map.on('mousemove',e=>{
    if(!state.circleDrawing?.temp)return;
    const r=map.distance(state.circleDrawing.center,e.latlng);
    const rr=Math.max(1,r);
    state.circleDrawing.temp.setRadius(rr);
    state.circleDrawing.label.setLatLng(circleEdgeLatLng(state.circleDrawing.center,rr));
    const node=state.circleDrawing.label.getElement()?.querySelector('span');
    if(node)node.textContent=circleRadiusLabelText(r);
    el('circleRadiusCounter').textContent=(r/1000).toFixed(r<1000?2:1);
  });
  map.on('mouseup',e=>{
    if(!state.circleDrawing?.temp)return;
    const draw=state.circleDrawing;
    try{
      const r=map.distance(draw.center,e.latlng);
      if(draw.temp)map.removeLayer(draw.temp);
      if(draw.label)map.removeLayer(draw.label);
      state.circleDrawing=null;
      createOrReplaceCircle(draw.center,Math.max(10,r));
      exitCircleDrawMode();
    }catch(err){
      console.error('Circle draw completion failed:',err);
      if(draw.temp)map.removeLayer(draw.temp);
      if(draw.label)map.removeLayer(draw.label);
      state.circleDrawing=null;
      exitCircleDrawMode();
    }finally{
      // Never leave Leaflet's normal map-drag state disabled after a failed draw.
      map.dragging.enable();
      setTimeout(()=>{state.markerClickSuppressed=false;},100);
    }
  });
  map.on('click',e=>{
    if(state.circleDrawMode)return;
    if(state.circleSelection && e.originalEvent?.target===state.circleSelection.circle?._path)return;
    unspiderfyMarkers();
    if(state.openPopupMarker)closeStorePopup();
  });
  map.on('dragstart',()=>{
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  map.on('zoomstart',()=>{
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  map.on('moveend',()=>{
    if(state.circleSelection?.circle && state.circleEditHandles.length){
      const center=state.circleSelection.circle.getLatLng();
      const edge=circleEdgeLatLng(center,state.circleSelection.circle.getRadius());
      state.circleEditHandles[0].setLatLng(center);
      state.circleEditHandles[1].setLatLng(edge);
      updateCircleLabel();
    }
    const programmatic = state.programmaticMoveDepth > 0 || Date.now() < state.programmaticMoveUntil;
    if(programmatic){
      if(state.userMapInteraction){state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger='map pan/zoom';}
      state.programmaticMoveDepth=Math.max(0,state.programmaticMoveDepth-1);
    } else {
      state.initialNationalView=false;
      state.mapReadyForViewport=true;
      state.daActivationTrigger=state.daActivationTrigger||'map pan/zoom';
    }
    state.userMapInteraction=false;
    if(state.circleSelection?.circle) return;
    updateHeaderGeography();
    if(state.moveTimer)clearTimeout(state.moveTimer);
    state.moveTimer=setTimeout(async()=>{
      state.moveTimer=null;
      state.csdRequestKey=null;
      await loadHeaderCsdLookup();
      refreshCsdLayerLocal();
      updateHeaderGeography();
      if (state.circleSelection?.circle) return;
      updateSelection();
      scheduleDaRefresh(0,'map pan/zoom');
    },clampAnalysisReactionMs(state.analysisReactionMs));
  });
  window.addEventListener('resize',()=>{map.invalidateSize(false);updateSelection();});
  el('analysisReactionMs')?.addEventListener('change',()=>{saveAnalysisReactionSetting();});
  el('analysisReactionMs')?.addEventListener('blur',()=>{saveAnalysisReactionSetting();});
  el('subjectsBtn').addEventListener('click',()=>{openSubjectConfig();});
  el('selectedStoresBtn').addEventListener('click',()=>{renderSelectedStoresConfig(el('selectedStoresSearch').value);el('selectedStoresDialog').showModal();});
  el('selectedStoresSearch').addEventListener('input',e=>renderSelectedStoresConfig(e.target.value));
  el('selectedStoresClear').addEventListener('click',()=>{renderSelectedStoresConfig('');});
  el('selectedStoresApply').addEventListener('click',()=>{state.selectedStoreColumns=selectedStoreCheckedValues();refreshConfigUI();updateSelectedStoresList();});
  el('exportSelectedBtn').addEventListener('click',exportSelectedStores);
  el('groupsBtn').addEventListener('click',()=>{renderChecklist('groupsList',state.groups,'group',el('groupSearch').value);el('groupsDialog').showModal();});

  el('groupSearch').addEventListener('input',e=>renderChecklist('groupsList',checkedValues('groupsList'),'group',e.target.value));

  el('groupsClear').addEventListener('click',()=>renderChecklist('groupsList',[],'group',el('groupSearch').value));

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

  el('leftPanelToggle').addEventListener('click',()=>setLeftPanelCollapsed(!state.leftPanelCollapsed));
  el('censusThreshold').addEventListener('change',()=>scheduleDaRefresh(0,'threshold change'));
  el('censusThreshold').addEventListener('input',()=>{ clearTimeout(state.daThresholdTimer); state.daThresholdTimer=setTimeout(()=>scheduleDaRefresh(0,'threshold change'),250); });
  el('showSelectedDAs')?.addEventListener('change',(event)=>{
    state.showDaOverlay = !!event.target.checked;
    if (state.daSelectionResult?.selected?.length) {
      const result = state.daSelectionResult;
      const canRenderOverlay = state.showDaOverlay && map.getZoom() >= DA_OVERLAY_MIN_ZOOM;
      clearDaOverlay();
      if (canRenderOverlay) {
        const features = result.selected.map(item => item.feature);
        state.daLayer = L.geoJSON(turf.featureCollection(features), {pane:'daSelectionPane', interactive:false, style:daStyle}).addTo(map);
        state.daRenderedSignature = `${result.cacheKey || `boundary:${result.selectedCount}:${result.threshold}:${result.provinces.join(',')}`}:overlay:true`;
      } else {
        state.daRenderedSignature = `${result.cacheKey || `boundary:${result.selectedCount}:${result.threshold}:${result.provinces.join(',')}`}:overlay:false`;
      }
    } else {
      clearDaOverlay();
    }
  });

  loadAnalysisReactionSetting();
  if(typeof L==='undefined')el('geoStatus').textContent='Mapping library did not load. Refresh the page and try again.';
  if(typeof XLSX==='undefined')el('fileStatus').textContent='Excel reader library did not load. Refresh the page and try again.';
  if(typeof turf==='undefined')el('censusNote').textContent='Geospatial calculation library did not load. Refresh the page and try again.';
  if(typeof RBush==='undefined')el('censusNote').textContent='DA spatial-index library did not load. Refresh the page and try again.';
  loadMarkerAnimationConfig();
  populateMarkerAnimationControls();
  wireMarkerAnimationControls();
  setupTicker();
  loadHeaderCsdLookup();
  loadProvinces();
  updateSelection();
  updateHeaderGeography();
})();

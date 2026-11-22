/* Store Explorer - v1.278
   Financial workbook processing is entirely client-side. Workbook data is never uploaded.
   DA spatial selection is activated only by an explicit Census Query circle or rectangle; province/Canada Census population scopes use precomputed totals; the map viewport governs marker visibility and fallback metric selection:
   Census Query shape -> provincial DA GeoJSON -> browser spatial index -> active shape intersections -> threshold -> selected DA geometries.
*/
(() => {
  'use strict';

  const CONFIG = {
    canadaBounds: [[41.6, -141.2], [83.2, -52.3]],
    canadaView: {center:[56.5, -99.5], zoom:4},
    csdLayer: 9,
    geocodeUrl: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
    daAssetBase: '.',
    daFiles: {
      AB:'AB_da_spatial_asset_v1.json', BC:'BC_da_spatial_asset_v1.json', MB:'MB_da_spatial_asset_v1.json',
      NB:'NB_da_spatial_asset_v1.json', NL:'NL_da_spatial_asset_v1.json', NS:'NS_da_spatial_asset_v1.json',
      NT:'NT_da_spatial_asset_v1.json', NU:'NU_da_spatial_asset_v1.json', ON:'ON_da_spatial_asset_v1.json',
      PE:'PE_da_spatial_asset_v1.json', QC:'QC_da_spatial_asset_v1.json', SK:'SK_da_spatial_asset_v1.json',
      YT:'YT_da_spatial_asset_v1.json'
    },
    prCodeByUid: {'10':'NL','11':'PE','12':'NS','13':'NB','24':'QC','35':'ON','46':'MB','47':'SK','48':'AB','59':'BC','60':'YT','61':'NT','62':'NU'},
    daMinRenderZoom: 8,
    // Precomputed province totals used when a candidate province is fully contained
    // in the active viewport/circle. This avoids loading the province DA asset for totals.
    provinceAggregates: {
      AB:{total_population:4262635,population_65_plus:628920,population_40_64:1387155,visible_minority_population:1156960,total_households:1632615,incomeWeighted:681797100,da_count:6216},
      BC:{total_population:5000879,population_65_plus:1015980,population_40_64:1668985,visible_minority_population:1686695,total_households:2040715,incomeWeighted:807433700,da_count:7873},
      MB:{total_population:1342153,population_65_plus:228925,population_40_64:415175,visible_minority_population:288905,total_households:517860,incomeWeighted:198230800,da_count:2225},
      NB:{total_population:775610,population_65_plus:177005,population_40_64:274480,visible_minority_population:41860,total_households:337530,incomeWeighted:116248600,da_count:1470},
      NL:{total_population:510550,population_65_plus:120595,population_40_64:187685,visible_minority_population:15145,total_households:223065,incomeWeighted:79260700,da_count:1084},
      NS:{total_population:969383,population_65_plus:215220,population_40_64:333110,visible_minority_population:91140,total_households:428195,incomeWeighted:139549500,da_count:1672},
      NT:{total_population:41070,population_65_plus:4090,population_40_64:13550,visible_minority_population:4900,total_households:15145,incomeWeighted:10533300,da_count:98},
      NU:{total_population:36858,population_65_plus:1615,population_40_64:8825,visible_minority_population:1370,total_households:9915,incomeWeighted:4821300,da_count:50},
      ON:{total_population:14223942,population_65_plus:2637090,population_40_64:4732200,visible_minority_population:4805055,total_households:5490200,incomeWeighted:2364264460,da_count:20520},
      PE:{total_population:154331,population_65_plus:32665,population_40_64:51655,visible_minority_population:13740,total_households:64555,incomeWeighted:23376100,da_count:319},
      QC:{total_population:8501833,population_65_plus:1753955,population_40_64:2852340,visible_minority_population:1325005,total_households:3748525,incomeWeighted:1237514200,da_count:13827},
      SK:{total_population:1132505,population_65_plus:197445,population_40_64:347290,visible_minority_population:156565,total_households:448210,incomeWeighted:182436700,da_count:2628},
      YT:{total_population:40232,population_65_plus:6010,population_40_64:13615,visible_minority_population:5060,total_households:17065,incomeWeighted:5282700,da_count:74}
    }
  };

  const CENSUS_PROVINCE_NAMES = {AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',NL:'Newfoundland and Labrador',NS:'Nova Scotia',NT:'Northwest Territories',NU:'Nunavut',ON:'Ontario',PE:'Prince Edward Island',QC:'Quebec',SK:'Saskatchewan',YT:'Yukon'};

  const HELP_STORAGE_KEY='storeExplorer.help.v1';
  const SUBJECT_STORAGE_KEY='storeExplorer.subjects.v1';
  const HELP_DEFAULTS={
    'financial-file':'Start here: load Excel / CSV to populate store data.  Only first tab is read, header s/b one row, will be autodetected, must have at least "latitude", "longitude", "store profile number", "province", columns',
    'secondary-file':'Load a separate set of locations that remain independent of the primary store data and analysis.',
    'clear-financial':'Remove current workbook and reset store data. Census map tools remain available.',
    'circle':'Draw circular Census catchment. Click on map to place its centre.',
    'box':'Draw rectangular Census catchment. Click on map to place its centre.',
    'clear-census':'Remove active Census catchment & its calculated DA results.',
    'go-search':'Jump to a city, postal code, or address.',
    'store-jump':'Jump to a Store Profile number.',
    'filter-config':'Build filters to isolate workbook data.',
    'filter-clear':'Remove all workbook filters.',
    'animate-when':'Choose single data file column filter that controls marker animation.',
    'popup-config':'Choose data file columns to be shown in a map marker popup.',
    'subjects-config':'Configure table of average values below',
    'groups-config':'Choose data file column on which to group stores for comparison.',
    'distribution-config':'Build distribution bar chart for chosen data file column (all data file rows incl)',
    'distribution2-config':'Build distribution bar chart for chosen data file column (all data file rows incl)',
    'selected-config':'Choose data file columns shown for the Selected Stores list.',
    'selected-export':'Export currently selected stores to XLS',
    'selected-da-export':'Export the currently selected Census DAs to XLS',
    'ticker-config':'Configure metrics streamed in header ticker.',
    'marker-red':'Set map marker colour to red.',
    'marker-blue':'Set map marker colour to royal blue.',
    'marker-purple':'Set map marker colour to purple.',
    'marker-black':'Set map marker colour to black.',
    'help-config':'Customize hover help shown for the main controls in this app.',
    'secondaryPopupConfigBtn':'',
    'secondaryHoverConfigBtn':'',
    'clearSecondaryBtn':'',
    'markerConfigBtn':'Set size of map markers',
    'button-retail':'',
    'button-food-leisure':'',
    'button-health-services':'',
    'button-community-recreation':'',
    'exportSubjectsBtn':'Export Subject table to xls',
    'button-total-sales':'',
    'button-gross-profit':'',
    'button-total-labour-expense':'',
    'button-total-occupancy-expense':'',
    'button-store-4-wall-profit-ebit':'',
    'button-shrink':'',
    'button-prescription-count':'',
    'button-fs-sales':'',
    'button-cosmetics-sales':'',
    'button-prescription-sales':''
  };

  const state = {
    rows: [], headers: [], types: {}, columns: {}, fileName: null,
    primaryTabs: [], popupTabConfigs: [], popupTabDrafts: [], popupTabSelected: {tab:0,r:0,c:0}, popupTabSelectionAnchor: {tab:0,r:0,c:0},
    subjects: [], groups: [], distributionSubject: null, distributionBinKey: null, distributionSubject2: null, distributionBinKey2: null, distributionDialogTarget: 1, filters: [], filterDraft: [], filterValuePickerIndex: null, selectedStoreColumns: [], popupConfig: [], popupConfigDraft: [], popupHeader: null, popupHeaderDraft: null, popupCensusCache: new Map(), filterCensusCache: new WeakMap(), popupQuartileDistributionCache: new Map(), populationCalcStatusDepth: 0, populationCalcStatusFrame: 0, popupRenderToken: 0, popupTickerMetrics: [], popupTickerDraft: [], popupTickerPlaying:true, popupTickerIndex:0, popupTickerTimer:null, popupQuartileValues:{}, popupAmenityRadius:1, subjectVirtualCache:new WeakMap(), subjectDistributionPopup:null, subjectDistributionAnchor:null, subjectDistributionBuckets:6, subjectDistributionIndex:null,
    selection: {type:'national', name:'Canada', feature:null, provinceCode:null, radius:null},
    censusScope: {type:'viewport', code:null, name:null, generation:0, reason:'initial'},
    markerColor: '#d34c4c',
    markerConfig: {primarySize:22, secondarySize:11, secondaryIconSizes:{}},
    markerAnimation: {enabled:false,type:'ripple',fadeObject:'smiley',column:'',formula:'',operator:'=',value:'',values:[],typeMode:'numeric'},
    markerAnimationPassCache: new WeakMap(),
    filterPassCache: new WeakMap(),
    selectedRows: [], filteredRows: [], viewportSelectedRows: [],
    selectedGroupKey: null,
    selectedStoreRow: null,
    csdGeo: null,
    daCache: new Map(), currentDaProvince: null, daLayer: null, daSelectionResult: null, showDaOverlay: true,
    csdLookupGeo: null, csdLookupLoading: false, csdLookupPromise: null, csdLookupIndex: new Map(), csdLookupCellSize: 0.5, csdProvinceBBoxes: new Map(), lastHeaderCsdKey: null, headerLookupReady: false, headerLookupPointKey: null,
    markerCluster: null, markers: [], secondaryLocationLayer: null, secondaryCanvasLayer: null, secondaryLocations: [], secondaryHeaders: [], secondaryLatColumn: null, secondaryLonColumn: null, secondaryCompetitorColumn: null, secondaryFileName: null, secondaryPopupConfig: null, secondaryHoverColumn: null, secondarySpatialIndex: null, secondarySpatialItems: [], secondaryVisible: false, secondaryHoverRow: null, secondaryEdits: {}, secondaryHitRadiusPx: 10, secondaryPopupItem: null, secondaryPopupLayer: null, secondaryPopupSvg: null, secondaryPopupCard: null, secondaryPopupResizeObserver: null, amenityAssetState: {status:'idle', promise:null, buffer:null, meta:null, gridIndex:null}, amenityNamesAssetState: {status:'idle', promise:null, buffer:null, meta:null}, amenityPopupCache: new Map(), spiderfyGroup: null, spiderfyOriginalPositions: new Map(), navigationResultLayer:null, navigationResultAnimation:null, navigationResultLatLng:null, navigationResultKind:null, navigationResultStoreRow:null, navigationResultStoreColor:null, navigationResultStoreRippleTimer:null,
    municipalityLabelLayer:null, municipalityLabelIndex:new Map(), municipalityLabels:[], municipalityLabelCellSize:1,
    circleSelection: null, rectangleSelection: null, censusGeoSelection: null, censusGeoLayer: null, circleDrawMode: false, rectangleDrawMode: false, censusShapeDrawing: null, circleDrawing: null, circleEditHandles: [], rectangleEditHandles: [], markerClickSuppressed: false, csdRequestKey: null, moveTimer:null, selectionUpdateFrame:null,
    mapReadyForViewport: false, initialNationalView: true,
    programmaticMoveDepth: 0,
    programmaticMoveUntil: 0,
    userMapInteraction: false,
    daActivationTrigger: null,
    daRefreshTimer:null, daProvinceCacheKey:null, daProvinceCache:null, daDelayMs:500, navigationDaSuppressed:false, censusShapeHandleDragActive:false, censusShapeHandlePendingReason:null,
    censusRequestId:0, censusScopeGeneration:0, censusTotalPopulation:null, searchToken:0, headerGeoRequestId:0, headerGeoTimer:null, popupQuartileDraftChanged:false, tickerMetrics:[], tickerPlaying:true, tickerOffset:0, tickerDragStart:null, tickerPointerId:null, tickerLoopWidth:0, tickerAnimationFrame:null, tickerLastTime:null, tickerSpeed:70, tickerConfigDraft:[], tickerConfigDraftSpeed:70,
    rxSiteAnalysis:{enabled:false,modelReady:false,modelPromise:null,model:null,subject:null,archetypes:null} 
  };

  const el = id => document.getElementById(id);
  const fmtInt = v => Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
  const fmtPct = v => Number.isFinite(v) ? `${(v*100).toFixed(1)}%` : '—';
  const fmtMoney = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:0}).format(v) : '—';
  const fmtNum = v => Number.isFinite(v) ? new Intl.NumberFormat('en-CA',{maximumFractionDigits:1}).format(v) : '—';
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  function normalizeMarkerSize(value,min,max,fallback){
    const n=Number(value);
    if(!Number.isFinite(n))return fallback;
    return Math.max(min,Math.min(max,Math.round(n)));
  }

  const map = L.map('map', {zoomControl:true, preferCanvas:true, minZoom:2}).setView(CONFIG.canadaView.center, CONFIG.canadaView.zoom);
  const daSelectionPane = map.createPane('daSelectionPane');
  daSelectionPane.style.zIndex = '450';
  daSelectionPane.style.pointerEvents = 'none';
  const municipalityLabelPane = map.createPane('municipalityLabelPane');
  municipalityLabelPane.style.zIndex = '420';
  municipalityLabelPane.style.pointerEvents = 'none';
  state.municipalityLabelLayer = L.layerGroup().addTo(map);
  const secondaryMarkerPane = map.createPane('secondaryMarkerPane');
  const SECONDARY_MARKER_ASSET='Red-Ball-Transparent.png';
  let SECONDARY_MARKER_ICONS = [
    {key:'calgary coop',label:'Calgary Coop',asset:'calgary coop.png'},
    {key:'calgary co-op',label:'Calgary Co-op',asset:'calgary co-op.png'},
    {key:'freshco',label:'FreshCo',asset:'freshco.png'},
    {key:'brunet',label:'Brunet',asset:'brunet.png'},
    {key:'metro',label:'Metro',asset:'metro.png'},
    {key:'safeway (sobeys)',label:'SAFEWAY (SOBEYS)',asset:'safeway.png'},
    {key:'sobeys',label:'Sobeys',asset:'sobeys.png'},
    {key:'pharmacie jean coutu',label:'Pharmacie Jean Coutu',asset:'pharmacie jean coutu.png'},
    {key:'wal-mart',label:'Wal-Mart',asset:'wal-mart.png'},
    {key:'sav-on foods',label:'Sav-On Foods',asset:'sav-on foods.png'}
  ];

  const SECONDARY_MARKER_ICON_MANIFEST='secondary-marker-icons.json';
  const secondaryMarkerImageCache = new Map();

  async function loadSecondaryMarkerIconManifest(){
    try{
      const response=await fetch(SECONDARY_MARKER_ICON_MANIFEST,{cache:'no-store'});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const payload=await response.json();
      if(!Array.isArray(payload))throw new Error('Manifest must be an array.');
      const next=payload
        .filter(item=>item&&typeof item.key==='string'&&typeof item.label==='string'&&typeof item.asset==='string')
        .map(item=>({key:item.key.toLowerCase(),label:item.label,asset:item.asset,defaultSize:normalizeMarkerSize(item.defaultSize,6,48,17)}));
      if(!next.length)throw new Error('Manifest contains no valid icons.');
      SECONDARY_MARKER_ICONS=next;

      // Preserve a user's prior Safeway size when migrating the old hard-coded key.
      const saved=state.markerConfig?.secondaryIconSizes;
      if(saved&&saved.safeway!==undefined&&saved['safeway (sobeys)']===undefined){
        saved['safeway (sobeys)']=saved.safeway;
      }
      if(state.markerConfig){
        const existing=state.markerConfig.secondaryIconSizes||{};
        const nextSizes=Object.fromEntries(SECONDARY_MARKER_ICONS.map(icon=>[
          icon.key,
          normalizeMarkerSize(existing[icon.key]??icon.defaultSize??17,6,48,icon.defaultSize??17)
        ]));
        state.markerConfig.secondaryIconSizes=nextSizes;
        saveMarkerConfig();
      }
      secondaryMarkerImageCache.clear();
      if(typeof renderSecondaryIconConfig==='function')renderSecondaryIconConfig();
      if(typeof refreshMarkerConfigUI==='function')refreshMarkerConfigUI();
      if(typeof bindMarkerConfigInputs==='function')bindMarkerConfigInputs();
      state.secondaryCanvasLayer?.redraw();
    }catch(err){
      console.warn('Secondary marker icon manifest unavailable; using built-in fallback list.',err);
    }
    return SECONDARY_MARKER_ICONS;
  }
  function secondaryIconKey(value){ return String(value ?? '').toLowerCase(); }
  function secondaryIconForRow(row){
    const col=state.secondaryCompetitorColumn;
    if(!col)return null;
    const key=secondaryIconKey(row?.[col]);
    return SECONDARY_MARKER_ICONS.find(icon=>icon.key===key)||null;
  }
  function loadSecondaryMarkerImage(icon){
    if(!icon)return secondaryMarkerImage;
    if(secondaryMarkerImageCache.has(icon.asset))return secondaryMarkerImageCache.get(icon.asset);
    const image=new Image();
    image.src=icon.asset;
    image.onload=()=>state.secondaryCanvasLayer?.redraw();
    secondaryMarkerImageCache.set(icon.asset,image);
    return image;
  }
  function drawSecondaryIconContained(ctx,image,x,y,maxSize){
    const sourceWidth=Number(image?.naturalWidth||image?.width||0);
    const sourceHeight=Number(image?.naturalHeight||image?.height||0);
    if(!(sourceWidth>0&&sourceHeight>0&&maxSize>0))return false;
    const scale=Math.min(maxSize/sourceWidth,maxSize/sourceHeight);
    const drawWidth=Math.max(1,sourceWidth*scale);
    const drawHeight=Math.max(1,sourceHeight*scale);
    ctx.drawImage(image,x-drawWidth/2,y-drawHeight/2,drawWidth,drawHeight);
    return true;
  }
  const secondaryMarkerImage = new Image();
  secondaryMarkerImage.src = SECONDARY_MARKER_ASSET;
  secondaryMarkerImage.onload = ()=>state.secondaryCanvasLayer?.redraw();
  secondaryMarkerPane.style.zIndex = '580';
  secondaryMarkerPane.style.pointerEvents = 'none';

  class SecondaryCanvasLayer extends L.Layer {
    onAdd(mapInstance){
      this._map=mapInstance;
      this._canvas=L.DomUtil.create('canvas','secondary-canvas-layer');
      this._pane=mapInstance.getPane('secondaryMarkerPane');
      this._pane.appendChild(this._canvas);
      mapInstance.on('moveend zoomend resize',this._reset,this);
      this._reset();
    }
    onRemove(mapInstance){
      mapInstance.off('moveend zoomend resize',this._reset,this);
      if(this._canvas?.parentNode)this._canvas.parentNode.removeChild(this._canvas);
      this._canvas=null;
      this._map=null;
    }
    _reset(){
      if(!this._map||!this._canvas)return;
      const mapSize=this._map.getSize();
      const topLeft=this._map.containerPointToLayerPoint([0,0]);
      this._layerOrigin=topLeft;
      const dpr=Math.max(1,window.devicePixelRatio||1);
      this._canvas.width=Math.max(1,Math.round(mapSize.x*dpr));
      this._canvas.height=Math.max(1,Math.round(mapSize.y*dpr));
      this._canvas.style.width=`${mapSize.x}px`;
      this._canvas.style.height=`${mapSize.y}px`;
      L.DomUtil.setPosition(this._canvas,topLeft);
      this.redraw();
    }
    redraw(){
      if(!this._canvas||!this._map)return;
      const ctx=this._canvas.getContext('2d');
      const dpr=Math.max(1,window.devicePixelRatio||1);
      const size=this._map.getSize();
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,size.x,size.y);
      if(!state.secondaryVisible||!state.secondarySpatialIndex)return;
      const b=this._map.getBounds();
      const q={minX:b.getWest(),minY:b.getSouth(),maxX:b.getEast(),maxY:b.getNorth()};
      const items=state.secondarySpatialIndex.search(q);
      const fallbackSize=Math.max(6,Math.min(48,Number(state.markerConfig?.secondarySize)||11));
      const origin=this._layerOrigin||this._map.containerPointToLayerPoint([0,0]);
      for(const item of items){
        const p=this._map.latLngToLayerPoint([item.lat,item.lng]);
        const x=p.x-origin.x;
        const y=p.y-origin.y;
        const icon=secondaryIconForRow(item.row);
        const configuredSize=icon ? Number(state.markerConfig?.secondaryIconSizes?.[icon.key]) : fallbackSize;
        const markerSize=Math.max(6,Math.min(48,Number.isFinite(configuredSize)&&configuredSize>0?configuredSize:fallbackSize));
        const image=icon?loadSecondaryMarkerImage(icon):secondaryMarkerImage;
        ctx.save();
        if(icon && image.complete && image.naturalWidth>0){
          drawSecondaryIconContained(ctx,image,x,y,markerSize);
        }else if(!icon && image.complete && image.naturalWidth>0){
          drawSecondaryIconContained(ctx,image,x,y,markerSize);
        }else{
          ctx.fillStyle='#c90000';
          ctx.beginPath();
          ctx.arc(x,y,markerSize/2,0,Math.PI*2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }
  state.secondaryCanvasLayer=new SecondaryCanvasLayer().addTo(map);
  const hoverTooltip = L.tooltip({direction:'top', opacity:0.95, offset:[0,-8], className:'unified-hover-tooltip'});
  const secondaryHoverOwner = {secondary:true};
  let hoverTooltipOwner = null;
  function showUnifiedHover(owner, latlng, html){
    if (!html) return;
    hoverTooltipOwner = owner;
    hoverTooltip.setContent(html).setLatLng(latlng);
    if (!map.hasLayer(hoverTooltip)) hoverTooltip.addTo(map);
  }
  function hideUnifiedHover(owner=null){
    if (owner && hoverTooltipOwner !== owner) return;
    hoverTooltipOwner = null;
    if (map.hasLayer(hoverTooltip)) map.removeLayer(hoverTooltip);
  }
  const selectionCirclePane = map.createPane('selectionCirclePane');
  selectionCirclePane.style.zIndex = '550';
  selectionCirclePane.style.pointerEvents = 'auto';
  const censusCenterPane = map.createPane('censusCenterPane');
  censusCenterPane.style.zIndex = '590';
  censusCenterPane.style.pointerEvents = 'none';
  const censusHandlePane = map.createPane('censusHandlePane');
  censusHandlePane.style.zIndex = '680';
  censusHandlePane.style.pointerEvents = 'auto';
  const CENSUS_DEBUG_ENABLED = new URLSearchParams(location.search).get('debug') === '1';
  const CENSUS_DEBUG = {
    events: [],
    log(event, detail={}) {
      const row = {time:new Date().toISOString(), event, detail};
      this.events.push(row);
      if (this.events.length > 120) this.events.shift();
      if (CENSUS_DEBUG_ENABLED) {
        console.debug('[CENSUS STATE]', event, detail);
        this.render();
      }
    },
    render() {
      if (!CENSUS_DEBUG_ENABLED) return;
      let panel = document.getElementById('censusDebugPanel');
      if (!panel) {
        panel = document.createElement('pre');
        panel.id = 'censusDebugPanel';
        Object.assign(panel.style,{position:'fixed',left:'10px',bottom:'10px',zIndex:99998,background:'rgba(0,0,0,.9)',color:'#fff',padding:'10px',margin:0,font:'11px/1.4 monospace',whiteSpace:'pre-wrap',maxWidth:'520px',maxHeight:'70vh',overflow:'auto'});
        document.body.appendChild(panel);
      }
      const shape=censusShapeType?.()||null;
      const geo=censusGeoScopeType?.()||null;
      const scope=censusScopeType();
      const last=this.events.slice(-12).map(x=>`${new Date(x.time).toLocaleTimeString()} ${x.event} ${JSON.stringify(x.detail)}`).join('\n');
      panel.textContent=[
        'CENSUS STATE DEBUG v1.165',
        `scope: ${scope}`,
        `shape: ${shape||'none'} | geo: ${geo||'none'}`,
        `geoCode: ${state.censusGeoSelection?.code||'none'}`,
        `selectedRows: ${(state.selectedRows||[]).length}`,
        `DA result: ${state.daSelectionResult?.selectedCount ?? 0}`,
        `circle handles: ${state.circleEditHandles.length} | box handles: ${state.rectangleEditHandles.length}`,
        '--- events ---',
        last || '(none)'
      ].join('\n');
    }
  };
  CENSUS_DEBUG.log('initialized');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  L.control.scale({position:'bottomleft', metric:true, imperial:false, maxWidth:120}).addTo(map);
  state.markerCluster = L.layerGroup().addTo(map);
  state.navigationResultLayer = L.layerGroup().addTo(map);
  map.on('move zoom resize',()=>{requestStorePopupLayout();requestSecondaryPopupLayout();});
  map.on('click',e=>{ if(e?.originalEvent?.target===map.getContainer() && state.openPopupMarker) closeStorePopup(); });

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
    const p = feature?.properties || {};
    const raw = [
      p.code, p.province_code, p.PROV_CODE, p.PROV, p.pruid,
      p.PRUID, p.PRUID3, p.province, p.Province, p.name, p.NAME,
      p.PRNAME, p.PRENAME
    ].map(v => String(v ?? '').trim()).find(Boolean) || '';
    const v = raw.toUpperCase();
    const direct = {
      'AB':'AB','ALBERTA':'AB', 'BC':'BC','BRITISH COLUMBIA':'BC',
      'MB':'MB','MANITOBA':'MB', 'NB':'NB','NEW BRUNSWICK':'NB',
      'NL':'NL','NEWFOUNDLAND AND LABRADOR':'NL',
      'NS':'NS','NOVA SCOTIA':'NS', 'NT':'NT','NORTHWEST TERRITORIES':'NT',
      'NU':'NU','NUNAVUT':'NU', 'ON':'ON','ONTARIO':'ON',
      'PE':'PE','PRINCE EDWARD ISLAND':'PE', 'QC':'QC','QUEBEC':'QC',
      'SK':'SK','SASKATCHEWAN':'SK', 'YT':'YT','YUKON':'YT', 'CA':'CA','CANADA':'CA'
    };
    if (direct[v]) return direct[v];
    if (CONFIG.prCodeByUid[v]) return CONFIG.prCodeByUid[v];
    const uid = String(p.PRUID || p.PRUID3 || p.province_uid || '').trim();
    if (CONFIG.prCodeByUid[uid]) return CONFIG.prCodeByUid[uid];
    if (/^\d{2}$/.test(uid) && CONFIG.prCodeByUid[uid]) return CONFIG.prCodeByUid[uid];
    return null;
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

  function buildLocalProvinceBBoxes(features) {
    state.csdProvinceBBoxes = new Map();
    for (const feature of features || []) {
      const code = provinceCodeFromCsdFeature(feature);
      if (!code) continue;
      try {
        const bbox = feature.__headerBBox || (feature.__headerBBox = turf.bbox(feature));
        if (!Array.isArray(bbox) || bbox.length < 4 || bbox.some(v => !Number.isFinite(v))) continue;
        const prior = state.csdProvinceBBoxes.get(code);
        if (!prior) state.csdProvinceBBoxes.set(code, bbox.slice(0,4));
        else {
          prior[0] = Math.min(prior[0], bbox[0]);
          prior[1] = Math.min(prior[1], bbox[1]);
          prior[2] = Math.max(prior[2], bbox[2]);
          prior[3] = Math.max(prior[3], bbox[3]);
        }
      } catch {}
    }
  }

  function municipalityGridKey(lat,lng){
    const size=state.municipalityLabelCellSize;
    return `${Math.floor(lat/size)}:${Math.floor(lng/size)}`;
  }

  function buildMunicipalityLabelIndex(features){
    state.municipalityLabelIndex.clear();
    state.municipalityLabels=[];
    for(const feature of features||[]){
      try{
        const p=feature?.properties||{};
        const name=String(p.CSDNAME||p.CSDNAMEE||p.name||p.NAME||'').trim();
        if(!name)continue;
        const point=turf.pointOnFeature(feature);
        const lat=point.geometry.coordinates[1],lng=point.geometry.coordinates[0];
        const bbox=feature.__headerBBox || (feature.__headerBBox=turf.bbox(feature));
        const width=Math.max(0,bbox[2]-bbox[0]),height=Math.max(0,bbox[3]-bbox[1]);
        const type=String(p.CSDTYPE||p.CSDTYPEE||'').toLowerCase();
        const priority=(width*height)+(type.includes('city')?5:0);
        const label={name,lat,lng,priority,key:String(p.CSDUID||p.OBJECTID||name)};
        state.municipalityLabels.push(label);
        const key=municipalityGridKey(lat,lng);let bucket=state.municipalityLabelIndex.get(key);
        if(!bucket){bucket=[];state.municipalityLabelIndex.set(key,bucket);} bucket.push(label);
      }catch(_){ }
    }
  }

  function refreshMunicipalityLabels(){
    if(!state.municipalityLabelLayer)return;
    state.municipalityLabelLayer.clearLayers();
    if(!state.municipalityLabels.length)return;
    const zoom=map.getZoom(), bounds=map.getBounds(), size=state.municipalityLabelCellSize;
    const minY=Math.floor(bounds.getSouth()/size)-1,maxY=Math.floor(bounds.getNorth()/size)+1;
    const minX=Math.floor(bounds.getWest()/size)-1,maxX=Math.floor(bounds.getEast()/size)+1;
    const seen=new Set(),candidates=[];
    for(let gy=minY;gy<=maxY;gy++)for(let gx=minX;gx<=maxX;gx++){
      for(const label of state.municipalityLabelIndex.get(`${gy}:${gx}`)||[]){
        if(seen.has(label.key))continue;seen.add(label.key);
        if(!bounds.contains([label.lat,label.lng]))continue;candidates.push(label);
      }
    }
    const maxLabels=zoom<=4?10:(zoom<=6?16:(zoom<=8?26:40));
    const storeCities=new Set(),c=state.columns||{};
    for(const row of state.rows||[]){
      if(!rowPassesFilters(row)||!hasCoords(row))continue;
      const lat=toNumber(row[c.lat]),lng=toNumber(row[c.lon]);
      if(lat===null||lng===null||!bounds.contains([lat,lng]))continue;
      const city=String(row[c.city]||'').trim();if(city)storeCities.add(norm(city));
    }
    candidates.sort((a,b)=>{
      const ap=(storeCities.has(norm(a.name))?1000:0)+a.priority;
      const bp=(storeCities.has(norm(b.name))?1000:0)+b.priority;
      return bp-ap;
    });
    const placed=[];
    for(const label of candidates){
      if(placed.length>=maxLabels)break;
      const p=map.latLngToContainerPoint([label.lat,label.lng]);
      if(p.x<18||p.y<18||p.x>map.getSize().x-18||p.y>map.getSize().y-18)continue;
      if(placed.some(prev=>p.distanceTo(prev)<70))continue;
      const marker=L.marker([label.lat,label.lng],{interactive:false,keyboard:false,pane:'municipalityLabelPane',icon:L.divIcon({className:'municipality-label-wrap',html:`<div class="municipality-label">${esc(label.name)}</div>`,iconSize:[1,1],iconAnchor:[0,0]})});
      state.municipalityLabelLayer.addLayer(marker);placed.push(p);
    }
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
        buildLocalProvinceBBoxes(geo.features);
        buildMunicipalityLabelIndex(geo.features);
        state.headerLookupReady = true;
        console.info('[HEADER] Local CSD index ready. Cells:', state.csdLookupIndex.size);
        // Resolve the CURRENT map centre, not a stale startup coordinate.
        updateHeaderGeography();
        setTimeout(refreshMunicipalityLabels,0);
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




  function fitMapProgrammatically(bounds, options){
    state.programmaticMoveDepth += 1;
    state.programmaticMoveUntil = Date.now() + 3000;
    state.userMapInteraction = false;
    map.fitBounds(bounds, options);
    setTimeout(()=>{ if(Date.now() >= state.programmaticMoveUntil) state.programmaticMoveDepth = 0; }, 3200);
  }

  async function geocodeAndRadius(query){
    clearRightPanelHighlights();
    if(!query.trim())return;
    const token=++state.searchToken;
    try{
      const qs=new URLSearchParams({SingleLine:query,maxLocations:'5',countryCode:'CAN',outFields:'Match_addr,Addr_type,City,Region,Province',f:'json'});
      const data=await fetchJson(`${CONFIG.geocodeUrl}?${qs.toString()}`,{timeout:30000});
      if(token!==state.searchToken)return;
      const c=data.candidates?.[0];if(!c)throw new Error('No Canadian match found.');
      const lat=c.location.y,lng=c.location.x;
      let provinceCode=provinceCodeFromAddress(query,c);
      if(!provinceCode){
        if(!state.headerLookupReady) await loadHeaderCsdLookup();
        const csd=getCsdAtPoint(lat,lng);
        provinceCode=csd ? provinceCodeFromCsdFeature(csd) : null;
      }
      if(!provinceCode) throw new Error('Could not determine province for this address.');
      closeStorePopup();clearCensusShape();clearDaOverlay();clearNavigationResult();state.censusRequestId++;
      state.navigationDaSuppressed=true;
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
          state.navigationDaSuppressed=false;
          createOrReplaceCircle(L.latLng(lat,lng),1000,'address navigation');
        });
      };
      map.once('moveend',finish);
      fitMapProgrammatically(targetBounds,{padding:[25,25]});
      setTimeout(finish,900);
    }catch(err){el('geoStatus').textContent=`Search failed: ${err.message}`;el('censusNote').textContent='Census not loaded.';}
  }

  function resetCanada(){
    closeStorePopup();clearCensusShape();clearDaOverlay();clearNavigationResult();state.censusRequestId++;
    state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};
    state.mapReadyForViewport=false;state.initialNationalView=true;
    resetCensusPopulationSummary();el('censusNote').textContent='Census Query is dormant until a circle or rectangle is drawn.';
    fitMapProgrammatically(CONFIG.canadaBounds,{padding:[8,8]});setDaTestStatus('Census Query is dormant until a circle or rectangle is drawn.');updateSelection();
  }

  function clearDaOverlay(){if(state.daLayer){map.removeLayer(state.daLayer);state.daLayer=null;}state.currentDaProvince=null;}
  function clamp(v,a,b){return Math.min(Math.max(v,a),b);}
  function setMapLoading(on){el('mapLoading').classList.toggle('hidden',!on);}

  // ---------- Workbook ----------
  async function readFinancialFile(file){
    if(typeof XLSX==='undefined')throw new Error('Excel reader library did not load. Refresh the page and try again.');
    const ext=file.name.toLowerCase().split('.').pop();
    if(ext==='csv')return {tabs:[workbookRows(XLSX.read(await file.text(),{type:'string'}),'CSV')]};
    return workbookTabs(XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true}));
  }
  function workbookRows(wb, sheetName){
    const ws=wb.Sheets[sheetName];if(!ws)throw new Error(`Worksheet ${sheetName||'first'} is empty.`);
    const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null});if(!matrix.length)throw new Error(`Worksheet ${sheetName||'first'} is empty.`);
    const headerIndex=detectHeaderRow(matrix);
    const rawHeaders=(matrix[headerIndex]||[]).map((v,i)=>String(v??'').trim()||`Unnamed ${i+1}`);
    const headers=dedupeHeaders(rawHeaders);const rows=[];
    for(let r=headerIndex+1;r<matrix.length;r++){const arr=matrix[r]||[];if(arr.every(v=>v===null||v===''))continue;const obj={};headers.forEach((h,i)=>obj[h]=arr[i]??null);rows.push(obj);}
    return {name:sheetName||'Sheet 1',headers,rows,headerIndex,storeProfileHeader:headers.find(h=>norm(h)==='store profile number')||null};
  }
  function workbookTabs(wb){
    const tabs=[];for(const name of wb.SheetNames||[]){const parsed=workbookRows(wb,name);if(parsed.headers.length)tabs.push(parsed);}if(!tabs.length)throw new Error('No worksheets with data were found.');return {tabs};
  }
  function detectHeaderRow(matrix){
    const keyIndex=matrix.slice(0,40).findIndex(row=>(row||[]).some(v=>norm(v)==='store profile number'));
    if(keyIndex>=0)return keyIndex;
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
  // ---------- Secondary Locations (isolated, canvas-rendered layer) ----------
  const SECONDARY_POPUP_STORAGE_KEY='storeExplorer.secondaryPopup.v1';
  const SECONDARY_HOVER_STORAGE_KEY='storeExplorer.secondaryHover.v1';
  function secondaryColumnCandidates(headers, terms){
    const lower=headers.map(h=>({raw:h,key:norm(h)}));
    for(const term of terms){const hit=lower.find(x=>x.key===norm(term));if(hit)return hit.raw;}
    for(const term of terms){const t=norm(term);const hit=lower.find(x=>x.key.includes(t));if(hit)return hit.raw;}
    return '';
  }
  function secondaryDefaultPopup(headers){
    const title=secondaryColumnCandidates(headers,['pharmacy name','name','account name']) || headers[0] || '';
    const subtitle=secondaryColumnCandidates(headers,['competitor banner','competitor chain','banner','chain','city']) || headers.find(h=>h!==title) || '';
    const fields=headers.filter(h=>h&&h!==title&&h!==subtitle).slice(0,4);
    return {title,subtitle,fields};
  }
  function loadSecondaryConfigs(){
    const headers=state.secondaryHeaders||[]; const fallback=secondaryDefaultPopup(headers);
    try{const raw=localStorage.getItem(SECONDARY_POPUP_STORAGE_KEY);state.secondaryPopupConfig=raw?{...fallback,...JSON.parse(raw)}:fallback;}catch(_){state.secondaryPopupConfig=fallback;}
    try{const raw=localStorage.getItem(SECONDARY_HOVER_STORAGE_KEY);state.secondaryHoverColumn=raw||secondaryColumnCandidates(headers,['pharmacy name','name','account name'])||headers[0]||'';}catch(_){state.secondaryHoverColumn=secondaryColumnCandidates(headers,['pharmacy name','name','account name'])||headers[0]||'';}
  }
  function saveSecondaryConfigs(){try{localStorage.setItem(SECONDARY_POPUP_STORAGE_KEY,JSON.stringify(state.secondaryPopupConfig||{}));localStorage.setItem(SECONDARY_HOVER_STORAGE_KEY,state.secondaryHoverColumn||'');}catch(_){}
  }
  function renderSecondaryPopupConfig(){
    const headers=state.secondaryHeaders||[], cfg=state.secondaryPopupConfig||secondaryDefaultPopup(headers), opts=(selected='',placeholder='Choose field')=>`<option value="">${placeholder}</option>`+headers.map(h=>`<option value="${esc(h)}" ${selected===h?'selected':''}>${esc(h)}</option>`).join('');
    const title=el('secondaryPopupTitle'),sub=el('secondaryPopupSubtitle'),list=el('secondaryPopupFields'); if(!title||!sub||!list)return;
    title.innerHTML=opts(cfg.title,'Choose title column'); sub.innerHTML=opts(cfg.subtitle,'Choose subtitle column');
    list.innerHTML=(cfg.fields||[]).map((h,i)=>`<div class="secondary-popup-field-row"><span class="field-index">${i+1}</span><select data-secondary-popup-field="1">${opts(h,'Choose field')}</select><button type="button" class="secondary" data-secondary-popup-remove="${i}">×</button></div>`).join('');
  }
  function openSecondaryPopupConfig(){renderSecondaryPopupConfig();el('secondaryPopupDialog').showModal();}
  function applySecondaryPopupConfig(){
    const title=el('secondaryPopupTitle')?.value||'', subtitle=el('secondaryPopupSubtitle')?.value||'';
    const fields=[...document.querySelectorAll('#secondaryPopupFields select[data-secondary-popup-field]')].map(n=>n.value).filter(Boolean);
    state.secondaryPopupConfig={title,subtitle,fields:[...new Set(fields.filter(h=>h!==title&&h!==subtitle))]}; saveSecondaryConfigs(); el('secondaryPopupDialog').close();
  }
  function resetSecondaryPopupConfig(){state.secondaryPopupConfig=secondaryDefaultPopup(state.secondaryHeaders||[]);renderSecondaryPopupConfig();}
  function renderSecondaryHoverConfig(){
    const select=el('secondaryHoverColumn');if(!select)return;
    select.innerHTML=(state.secondaryHeaders||[]).map(h=>`<option value="${esc(h)}" ${state.secondaryHoverColumn===h?'selected':''}>${esc(h)}</option>`).join('');
  }
  function openSecondaryHoverConfig(){renderSecondaryHoverConfig();el('secondaryHoverDialog').showModal();}
  function applySecondaryHoverConfig(){state.secondaryHoverColumn=el('secondaryHoverColumn')?.value||'';saveSecondaryConfigs();el('secondaryHoverDialog').close();}
  function resetSecondaryHoverConfig(){state.secondaryHoverColumn=secondaryColumnCandidates(state.secondaryHeaders||[],['pharmacy name','name','account name'])||(state.secondaryHeaders||[])[0]||'';renderSecondaryHoverConfig();}
  function secondaryPopupHtml(item){
    const row=item?.row||{};
    const cfg=state.secondaryPopupConfig||secondaryDefaultPopup(state.secondaryHeaders||[]);
    const title=cfg.title?String(row[cfg.title]??'').trim():'';
    const subtitle=cfg.subtitle?String(row[cfg.subtitle]??'').trim():'';
    const editValues=state.secondaryEdits?.[item.index]||{};
    const lat=Number.isFinite(item.lat)?item.lat:null,lng=Number.isFinite(item.lng)?item.lng:null;
    const mapsLink=(lat!==null&&lng!==null)?`<a class="store-popup-map-link" href="https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps" aria-label="Open in Google Maps">G</a>`:'';
    const fields=(cfg.fields||[]).filter(h=>h&&h!==cfg.title&&h!==cfg.subtitle).map(h=>{
      const value=editValues[h]??row[h]??'';
      return `<label class="secondary-popup-edit-field"><span>${esc(h)}</span><input type="text" data-secondary-edit-field="${esc(h)}" value="${esc(String(value))}"></label>`;
    }).join('');
    return `<div class="secondary-location-popup" data-secondary-popup-index="${item.index}"><div class="secondary-popup-head"><div class="secondary-popup-head-main"><div class="secondary-popup-title">${esc(title||'Secondary location')}</div>${subtitle?`<div class="secondary-popup-subtitle">${esc(subtitle)}</div>`:''}</div><div class="secondary-popup-head-actions">${mapsLink}<button type="button" class="secondary-popup-overlay-close" aria-label="Close">×</button></div></div><div class="secondary-popup-body">${fields||`<div class="secondary-popup-empty">No editable fields configured.</div>`}</div></div>`;
  }
  function secondaryHoverHtml(row){const col=state.secondaryHoverColumn;if(!col)return '';return esc(String(row[col]??'').trim()||'Secondary location');}
  function secondarySaveEditsFromPopup(root){
    const idx=Number(root?.dataset?.secondaryPopupIndex); if(!Number.isInteger(idx))return;
    const edits={...(state.secondaryEdits?.[idx]||{})};
    root.querySelectorAll('[data-secondary-edit-field]').forEach(input=>{edits[input.dataset.secondaryEditField]=input.value;});
    state.secondaryEdits=state.secondaryEdits||{}; state.secondaryEdits[idx]=edits;
  }
  function buildSecondarySpatialIndex(){
    if(typeof RBush==='undefined')throw new Error('Spatial-index library did not load. Refresh the page and try again.');
    const items=[];
    for(let i=0;i<state.secondaryLocations.length;i++){
      const row=state.secondaryLocations[i]; const lat=toNumber(row[state.secondaryLatColumn]),lng=toNumber(row[state.secondaryLonColumn]);
      if(lat===null||lng===null)continue;
      items.push({minX:lng,minY:lat,maxX:lng,maxY:lat,lat,lng,index:i,row});
    }
    const indexed=new RBush(); indexed.load(items); state.secondarySpatialIndex=indexed; state.secondarySpatialItems=items;
  }
  function setSecondaryVisible(visible){
    state.secondaryVisible=!!visible; const ctl=el('secondaryVisibilityToggle'); if(ctl&&ctl.checked!==state.secondaryVisible)ctl.checked=state.secondaryVisible;
    state.secondaryCanvasLayer?.redraw(); if(!state.secondaryVisible){hideUnifiedHover();state.secondaryHoverRow=null;}
  }
  function secondaryHitTest(latlng,pixelRadius=10){
    if(!state.secondaryVisible||!state.secondarySpatialIndex)return null;
    const p=map.latLngToContainerPoint(latlng); const sw=map.containerPointToLatLng(L.point(p.x-pixelRadius,p.y+pixelRadius)); const ne=map.containerPointToLatLng(L.point(p.x+pixelRadius,p.y-pixelRadius));
    const candidates=state.secondarySpatialIndex.search({minX:sw.lng,maxX:ne.lng,minY:sw.lat,maxY:ne.lat});
    let best=null,bestPx=Infinity;
    for(const item of candidates){const cp=map.latLngToContainerPoint([item.lat,item.lng]);const dx=cp.x-p.x,dy=cp.y-p.y;const dist=Math.hypot(dx,dy);if(dist<=pixelRadius&&dist<bestPx){best=item;bestPx=dist;}}
    return best;
  }
  function ensureSecondaryPopupOverlay(){
    if(state.secondaryPopupLayer&&state.secondaryPopupCard&&state.secondaryPopupSvg)return;
    const container=map.getContainer();
    const layer=document.createElement('div');
    layer.className='store-popup-layer secondary-popup-layer';
    layer.setAttribute('aria-hidden','true');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.classList.add('store-popup-leader');
    svg.setAttribute('aria-hidden','true');
    const card=document.createElement('div');
    card.className='secondary-popup-overlay-card';
    card.setAttribute('role','dialog');
    card.setAttribute('aria-modal','false');
    ['click','dblclick','mousedown','mouseup','pointermove','touchstart','touchmove','contextmenu','wheel'].forEach(type=>card.addEventListener(type,e=>e.stopPropagation(),{passive:false}));
    card.addEventListener('click',e=>e.stopPropagation());
    layer.addEventListener('click',e=>{if(e.target===layer)closeSecondaryPopup();});
    layer.appendChild(svg);
    layer.appendChild(card);
    container.appendChild(layer);
    state.secondaryPopupLayer=layer;state.secondaryPopupSvg=svg;state.secondaryPopupCard=card;
    if(typeof ResizeObserver==='function'){
      state.secondaryPopupResizeObserver=new ResizeObserver(()=>requestSecondaryPopupLayout());
      state.secondaryPopupResizeObserver.observe(card);
    }
  }
  function closeSecondaryPopup(){
    state.secondaryPopupItem=null;
    if(state.secondaryPopupLayer)state.secondaryPopupLayer.classList.remove('open');
    if(state.secondaryPopupLayer)state.secondaryPopupLayer.setAttribute('aria-hidden','true');
    if(state.secondaryPopupSvg)state.secondaryPopupSvg.replaceChildren();
    if(state.secondaryPopupCard)state.secondaryPopupCard.innerHTML='';
  }
  function requestSecondaryPopupLayout(){
    if(!state.secondaryPopupItem||!state.secondaryPopupCard||!state.secondaryPopupLayer?.classList.contains('open'))return;
    requestAnimationFrame(()=>layoutSecondaryPopup(state.secondaryPopupItem));
  }
  function layoutSecondaryPopup(item){
    if(!item||!state.secondaryPopupCard||!state.secondaryPopupSvg)return;
    const container=map.getContainer();
    const cssWidth=Number(container?.clientWidth||0),cssHeight=Number(container?.clientHeight||0);
    const mapSize={x:Math.max(1,Math.round(cssWidth||map.getSize().x)),y:Math.max(1,Math.round(cssHeight||map.getSize().y))};
    const margin=12;
    const maxW=Math.max(220,mapSize.x-margin*2),maxH=Math.max(160,mapSize.y-margin*2);
    state.secondaryPopupCard.style.maxWidth=`${maxW}px`;state.secondaryPopupCard.style.maxHeight=`${maxH}px`;
    const markerPoint=map.latLngToContainerPoint([item.lat,item.lng]);
    const secondaryIcon=secondaryIconForRow(item.row);
    const configuredSecondarySize=secondaryIcon ? Number(state.markerConfig?.secondaryIconSizes?.[secondaryIcon.key]) : Number(state.markerConfig?.secondarySize);
    const secondaryMarkerSize=Math.max(6,Math.min(48,Number.isFinite(configuredSecondarySize)&&configuredSecondarySize>0?configuredSecondarySize:11));
    const markerRadius=secondaryMarkerSize/2;
    const cardRect=state.secondaryPopupCard.getBoundingClientRect();
    const w=Math.min(cardRect.width||410,maxW),h=Math.min(cardRect.height||220,maxH);
    let candidate=candidatePopupPosition(markerPoint,w,h,mapSize,markerRadius);
    if(!candidate){
      const corners=[{left:margin,top:margin},{left:mapSize.x-margin-w,top:margin},{left:margin,top:mapSize.y-margin-h},{left:mapSize.x-margin-w,top:mapSize.y-margin-h}];
      corners.sort((a,b)=>{const da=Math.hypot(markerPoint.x-(a.left+w/2),markerPoint.y-(a.top+h/2));const db=Math.hypot(markerPoint.x-(b.left+w/2),markerPoint.y-(b.top+h/2));return db-da;});
      const chosen=corners[0];candidate={left:clamp(chosen.left,margin,Math.max(margin,mapSize.x-margin-w)),top:clamp(chosen.top,margin,Math.max(margin,mapSize.y-margin-h)),w,h};
    }
    state.secondaryPopupCard.style.left=`${candidate.left}px`;state.secondaryPopupCard.style.top=`${candidate.top}px`;
    const leader=leaderGeometry(markerPoint,candidate,markerRadius);
    state.secondaryPopupSvg.setAttribute('width',String(mapSize.x));state.secondaryPopupSvg.setAttribute('height',String(mapSize.y));state.secondaryPopupSvg.setAttribute('viewBox',`0 0 ${mapSize.x} ${mapSize.y}`);state.secondaryPopupSvg.style.width=`${mapSize.x}px`;state.secondaryPopupSvg.style.height=`${mapSize.y}px`;state.secondaryPopupSvg.replaceChildren();
    if(leader){const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');polygon.setAttribute('points',leader.points);polygon.setAttribute('class','store-popup-leader-arrow secondary-popup-leader-arrow');state.secondaryPopupSvg.appendChild(polygon);}
  }
  function showSecondaryPopup(item){
    if(!item)return;
    if(state.secondaryPopupLayer?.classList.contains('open') && state.secondaryPopupItem && state.secondaryPopupItem.index===item.index){
      closeSecondaryPopup();
      return;
    }
    ensureSecondaryPopupOverlay();
    state.secondaryPopupItem=item;
    const html=secondaryPopupHtml(item);
    state.secondaryPopupCard.innerHTML=html;
    state.secondaryPopupLayer.classList.add('open');state.secondaryPopupLayer.setAttribute('aria-hidden','false');
    state.secondaryPopupCard.querySelector('.secondary-popup-overlay-close')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();closeSecondaryPopup();});
    requestSecondaryPopupLayout();
  }
  function renderSecondaryCanvas(){state.secondaryCanvasLayer?.redraw();}
  // ---------- TRADE AREA SITE ANALYSIS (isolated add-on) ----------
  // Uses existing Census / amenity / secondary spatial engines. New standalone logic:
  // 1) amenity-per-capita benchmark + local/destination inference
  // 2) non-community activity hub detection
  // 3) user-configurable archetype matching + deterministic dayparts
  const RX_SITE_AMENITY_RADIUS_KM=0.75;
  const RX_SITE_HUB_RADIUS_KM=0.30;
  const RX_SITE_HUB_MIN_NEIGHBORS=5;
  const RX_SITE_HUB_SEARCH_RADIUS_KM=1.50;
  const RX_SITE_ARCHETYPE_KEY='storeExplorer.tradeAreaArchetypes.v1';
  const RX_SITE_ARCHETYPE_FIELDS=['pop1','pop2','retail','food','health','community','competition'];
  const RX_SITE_ARCHETYPE_OPTIONS=['ANY','Q1','Q2','Q3','Q4','Q1-Q2','Q2-Q3','Q3-Q4','Q1-Q3','Q2-Q4','Q1-Q4'];
  const RX_SITE_ARCHETYPE_DEFAULTS=[
    {name:'Residential',pop1:'Q3-Q4',pop2:'Q3-Q4',retail:'Q1-Q2',food:'Q1-Q2',health:'Q1-Q2',community:'Q3-Q4',competition:'Q1-Q2'},
    {name:'Residential > Commercial',pop1:'Q2-Q4',pop2:'Q2-Q4',retail:'Q1-Q2',food:'Q1-Q2',health:'Q2-Q4',community:'Q3-Q4',competition:'Q1-Q2'},
    {name:'Commercial > Residential',pop1:'Q2-Q3',pop2:'Q2-Q4',retail:'Q2-Q4',food:'Q2-Q4',health:'Q2-Q4',community:'Q2-Q4',competition:'Q2-Q3'},
    {name:'Commercial',pop1:'Q2-Q3',pop2:'Q2-Q4',retail:'Q3-Q4',food:'Q3-Q4',health:'Q2-Q3',community:'Q1-Q2',competition:'Q2-Q4'},
    {name:'Destination Market',pop1:'Q1-Q2',pop2:'Q2-Q4',retail:'Q3-Q4',food:'Q3-Q4',health:'Q2-Q4',community:'Q1-Q2',competition:'Q2-Q4'},
    {name:'Low-Competition Local Market',pop1:'Q1-Q2',pop2:'Q1-Q2',retail:'Q1-Q2',food:'Q1-Q2',health:'Q1-Q2',community:'Q1-Q2',competition:'Q1'}
  ];

  function rxSiteProvinceGroup(code){ return String(code||'').toUpperCase()==='QC'?'QC':'NONQC'; }
  function rxSiteStateReady(){
    const ready=!!(state.rows?.length && state.secondaryLocations?.length && state.secondarySpatialIndex);
    state.rxSiteAnalysis.enabled=ready;
    const card=el('rxSiteAnalysisCard'),go=el('rxSiteAnalysisGo');
    if(card)card.classList.toggle('rx-site-analysis-disabled',!ready);
    if(go)go.disabled=!ready;
    const status=el('rxSiteAnalysisStatus');
    if(status && !state.rxSiteAnalysis.modelReady) status.textContent=ready?'Ready • first analysis builds the benchmark once.':'Load both Primary Store Data and Secondary Locations to enable analysis.';
    return ready;
  }
  function rxSiteNumeric(row,names){
    for(const name of names){ const key=state.headers.find(h=>norm(h)===norm(name)); if(key){const n=toNumber(row[key]); if(n!==null)return n;} }
    return null;
  }
  function rxSiteProvinceFromRow(row){
    const key=state.columns?.province || state.headers.find(h=>['province','prov','state','province code'].includes(norm(h)));
    return provinceCodeFromText(key?row[key]:'') || provinceCodeFromAddress(String(row?.Address||''),null) || '';
  }
  function rxSiteLatLng(row){ const lat=toNumber(row[state.columns.lat]),lng=toNumber(row[state.columns.lon]); return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null; }
  function rxSiteDistanceKm(a,b){ return amenityDistanceKm(a.lat,a.lng,b.lat,b.lng); }
  function rxSiteMedian(values){ const a=values.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  function rxSiteQuartileThresholds(values){
    const a=values.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return [null,null,null];
    const pct=p=>{const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo);};
    return [pct(.25),pct(.50),pct(.75)];
  }
  function rxSiteQuartile(value,thresholds){
    if(!Number.isFinite(value)||!thresholds||thresholds.some(v=>!Number.isFinite(v)))return null;
    if(value>=thresholds[2])return 4; if(value>=thresholds[1])return 3; if(value>=thresholds[0])return 2; return 1;
  }
  function rxSitePercentile(values,value){
    const finite=values.filter(Number.isFinite).sort((a,b)=>a-b); if(!finite.length||!Number.isFinite(value))return null;
    let lo=0,hi=finite.length; while(lo<hi){const m=(lo+hi)>>1;if(finite[m]<=value)lo=m+1;else hi=m;}
    return finite.length===1?50:Math.max(0,Math.min(100,((lo-0.5)/finite.length)*100));
  }
  async function rxSitePopulationRadius(row,lat,lng,radiusKm,provinceOverride=null){
    const preName=radiusKm===1?'pop_1km':radiusKm===2?'pop_2km':null;
    if(preName){const pre=rxSiteNumeric(row,[preName,radiusKm===1?'Population 1 km':'Population 2 km',radiusKm===1?'1 km population':'2 km population']);if(Number.isFinite(pre))return pre;}
    const province=provinceOverride||rxSiteProvinceFromRow(row); if(!province)return null;
    try{
      const boundary=turf.circle([lng,lat],radiusKm,{units:'kilometers',steps:180});
      const result=await selectCensusBoundary(boundary,[province],10,{boundaryType:'circle',targetCircle:{lat,lng,radiusMeters:radiusKm*1000},shouldRender:false,provinceModes:[{provinceCode:province,mode:'partial'}]});
      return Number(result?.aggregate?.totalPopulation)||0;
    }catch(_){return null;}
  }
  async function rxSiteAmenities(lat,lng){ return calculateAmenityProfile(lat,lng,RX_SITE_AMENITY_RADIUS_KM); }
  function rxSiteCountSecondary(lat,lng,radiusKm=1){
    if(!state.secondarySpatialIndex)return 0;
    const candidates=secondaryProximityCandidates(lat,lng,radiusKm),maxMeters=radiusKm*1000,origin=L.latLng(lat,lng);
    let count=0; for(const item of candidates){if(map.distance(origin,L.latLng(item.lat,item.lng))<=maxMeters+0.001)count++;} return count;
  }
  function rxSiteLoadArchetypes(){
    try{
      const raw=localStorage.getItem(RX_SITE_ARCHETYPE_KEY); if(!raw)return RX_SITE_ARCHETYPE_DEFAULTS.map(x=>({...x}));
      const parsed=JSON.parse(raw); if(!Array.isArray(parsed)||parsed.length!==RX_SITE_ARCHETYPE_DEFAULTS.length)return RX_SITE_ARCHETYPE_DEFAULTS.map(x=>({...x}));
      return parsed.map((row,i)=>({...RX_SITE_ARCHETYPE_DEFAULTS[i],...row}));
    }catch(_){return RX_SITE_ARCHETYPE_DEFAULTS.map(x=>({...x}));}
  }
  function rxSiteSaveArchetypes(rows){ localStorage.setItem(RX_SITE_ARCHETYPE_KEY,JSON.stringify(rows)); state.rxSiteAnalysis.archetypes=rows.map(x=>({...x})); }
  function rxSiteArchetypeRows(){ if(!Array.isArray(state.rxSiteAnalysis.archetypes)||state.rxSiteAnalysis.archetypes.length!==RX_SITE_ARCHETYPE_DEFAULTS.length) state.rxSiteAnalysis.archetypes=rxSiteArchetypeDefaults(); return state.rxSiteAnalysis.archetypes; }
  function rxSiteArchetypeDefaults(){ return RX_SITE_ARCHETYPE_DEFAULTS.map(x=>({...x})); }
  function rxSiteRangeMatches(q,rule){
    if(rule==='ANY'||rule==null||rule==='')return true;
    if(!Number.isFinite(q))return false;
    if(/^Q[1-4]$/.test(rule))return q===Number(rule.slice(1));
    const m=String(rule).match(/^Q([1-4])-Q([1-4])$/); if(!m)return false; const a=Number(m[1]),b=Number(m[2]); return q>=Math.min(a,b)&&q<=Math.max(a,b);
  }
  function rxSiteMatchArchetype(metrics){
    for(const row of rxSiteArchetypeRows()){
      if(RX_SITE_ARCHETYPE_FIELDS.every(f=>rxSiteRangeMatches(metrics[f],row[f])))return row.name||'Unclassified';
    }
    return 'Unclassified';
  }
  function rxSiteDayparts(q){
    const morning=Number.isFinite(q.health)&&q.health>=2;
    const afternoon=(Number.isFinite(q.health)&&q.health>=2)||(Number.isFinite(q.retail)&&q.retail>=2)||(Number.isFinite(q.food)&&q.food>=3);
    const evening=Number.isFinite(q.food)&&q.food>=2;
    const weekend=(Number.isFinite(q.retail)&&q.retail>=2&&Number.isFinite(q.food)&&q.food>=2)&&(!(Number.isFinite(q.community)&&q.community===4));
    return {morning,afternoon,evening,weekend};
  }
  function rxSiteLocalDestinationIndex(q){
    const dest=(Number(q.retail)||0)+(Number(q.food)||0),local=(Number(q.health)||0)+(Number(q.community)||0),tot=dest+local; return tot?dest/tot:0.5;
  }
  function rxSiteHubPointsForSubject(subject){
    const pts=[]; const seen=new Set(), add=(p,type)=>{if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lng))return;const key=`${p.lat.toFixed(6)}|${p.lng.toFixed(6)}|${type}`;if(seen.has(key))return;seen.add(key);pts.push({lat:p.lat,lng:p.lng,type});};
    for(const id of amenityIndicesWithinRadius(subject.lat,subject.lng,RX_SITE_HUB_SEARCH_RADIUS_KM)){const r=amenityReadRecord(id,new DataView(state.amenityAssetState.buffer));if((r.mask&7)!==0)add(r,'amenity');}
    const origin=L.latLng(subject.lat,subject.lng); for(const row of state.rows){const ll=rxSiteLatLng(row);if(!ll)continue;if(map.distance(origin,L.latLng(ll.lat,ll.lng))<=RX_SITE_HUB_SEARCH_RADIUS_KM*1000+0.001)add(ll,'primary');}
    for(const item of secondaryProximityCandidates(subject.lat,subject.lng,RX_SITE_HUB_SEARCH_RADIUS_KM)){if(map.distance(origin,L.latLng(item.lat,item.lng))<=RX_SITE_HUB_SEARCH_RADIUS_KM*1000+0.001)add({lat:item.lat,lng:item.lng},'secondary');}
    return pts;
  }
  function rxSiteDetectHubs(subject){
    const pts=rxSiteHubPointsForSubject(subject); if(pts.length===0)return {hubs:[],subjectHub:null};
    const step=0.15,grid=new Map(),keyFor=(p)=>`${Math.floor(p.lat/step)},${Math.floor(p.lng/step)}`;
    pts.forEach((p,i)=>{const k=keyFor(p);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(i);});
    const neighbours=[];
    for(let i=0;i<pts.length;i++){
      const p=pts[i],baseLat=Math.floor(p.lat/step),baseLng=Math.floor(p.lng/step),near=[];
      for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++){const arr=grid.get(`${baseLat+a},${baseLng+b}`);if(!arr)continue;for(const j of arr){if(j===i)continue;if(rxSiteDistanceKm(p,pts[j])<=RX_SITE_HUB_RADIUS_KM+1e-9)near.push(j);}}
      neighbours.push(near);
    }
    const candidates=neighbours.map((n,i)=>({i,count:n.length+1})).filter(x=>x.count>=RX_SITE_HUB_MIN_NEIGHBORS+1).sort((a,b)=>b.count-a.count||a.i-b.i);
    const hubs=[];
    for(const cand of candidates){const p=pts[cand.i];if(hubs.some(h=>rxSiteDistanceKm(p,h.center)<=RX_SITE_HUB_RADIUS_KM))continue;const members=[];for(let j=0;j<pts.length;j++)if(rxSiteDistanceKm(p,pts[j])<=RX_SITE_HUB_RADIUS_KM+1e-9)members.push(j);hubs.push({center:p,count:members.length,members});}
    hubs.sort((a,b)=>b.count-a.count);
    let subjectHub=null,subjectDist=Infinity; for(const hub of hubs){const d=rxSiteDistanceKm(subject,hub.center);if(d<=RX_SITE_HUB_RADIUS_KM+1e-9&&(d<subjectDist)){subjectHub=hub;subjectDist=d;}}
    if(subjectHub)subjectHub.rank=hubs.indexOf(subjectHub)+1;
    return {hubs,subjectHub,points:pts.length};
  }
  async function rxSiteBuildNetworkBenchmark(){
    if(!rxSiteStateReady())return null;
    if(state.rxSiteAnalysis.modelPromise)return state.rxSiteAnalysis.modelPromise;
    state.rxSiteAnalysis.modelPromise=(async()=>{
      const rows=state.rows.slice();const base=[];const total=rows.length;let done=0;const status=el('rxSiteAnalysisStatus');
      const concurrency=8;
      for(let i=0;i<rows.length;i+=concurrency){
        const batch=rows.slice(i,i+concurrency);
        const vals=await Promise.all(batch.map(async row=>{
          const ll=rxSiteLatLng(row);if(!ll)return null;const province=rxSiteProvinceFromRow(row);
          const [pop1,pop2,amenity]=await Promise.all([rxSitePopulationRadius(row,ll.lat,ll.lng,1,province),rxSitePopulationRadius(row,ll.lat,ll.lng,2,province),rxSiteAmenities(ll.lat,ll.lng)]);
          const comp=rxSiteCountSecondary(ll.lat,ll.lng,1),denom=Number(pop1)>0?Number(pop1):null;
          return {row,ll,pop1,pop2,comp,amenity,amenityPC:denom?{retail:amenity.retail/denom*10000,food:amenity.food/denom*10000,health:amenity.health/denom*10000,community:amenity.community/denom*10000,total:amenity.total/denom*10000}:null};
        }));
        vals.forEach(v=>{if(v)base.push(v);});done+=batch.length;
        if(status)status.textContent=`Preparing trade-area benchmark… ${Math.min(done,total).toLocaleString()} / ${total.toLocaleString()}`;
        await new Promise(r=>setTimeout(r,0));
      }
      const fieldMap={pop1:'pop1',pop2:'pop2',competition:'comp','retail':'amenityPC.retail','food':'amenityPC.food','health':'amenityPC.health','community':'amenityPC.community','totalAmenityPC':'amenityPC.total'};
      const get=(r,path)=>path.split('.').reduce((o,k)=>o?.[k],r);const quartiles={};
      for(const [key,path] of Object.entries(fieldMap))quartiles[key]=rxSiteQuartileThresholds(base.map(r=>get(r,path)));
      const rowsWithTraits=base.map(r=>({
        ...r,
        q:{pop1:rxSiteQuartile(r.pop1,quartiles.pop1),pop2:rxSiteQuartile(r.pop2,quartiles.pop2),retail:rxSiteQuartile(r.amenityPC?.retail,quartiles.retail),food:rxSiteQuartile(r.amenityPC?.food,quartiles.food),health:rxSiteQuartile(r.amenityPC?.health,quartiles.health),community:rxSiteQuartile(r.amenityPC?.community,quartiles.community),competition:rxSiteQuartile(r.comp,quartiles.competition)},
        rx:rxSiteNumeric(r.row,['Prescription Count','Rx Count','PrescriptionCount'])
      }));
      const archetypes=rxSiteLoadArchetypes();state.rxSiteAnalysis.archetypes=archetypes;state.rxSiteAnalysis.model={rows:rowsWithTraits,quartiles};state.rxSiteAnalysis.modelReady=true;
      if(status)status.textContent=`Ready • trade-area benchmark calibrated across ${rowsWithTraits.length.toLocaleString()} primary stores`;
      rxSiteStateReady();return state.rxSiteAnalysis.model;
    })().catch(err=>{state.rxSiteAnalysis.modelPromise=null;state.rxSiteAnalysis.modelReady=false;const status=el('rxSiteAnalysisStatus');if(status)status.textContent=`Trade-area benchmark failed: ${err.message}`;throw err;});
    return state.rxSiteAnalysis.modelPromise;
  }
  function rxSiteFormatBar(q){return Number.isFinite(q)?q:0;}
  function rxSiteMetricRows(subject){
    const q=subject.q;return [
      ['Retail',q.retail],['Food & Leisure',q.food],['Health & Services',q.health],['Community & Recreation',q.community],['Total amenities / 1 km population',q.totalAmenityPC],['Population — 1 km',q.pop1],['Population — 2 km',q.pop2]
    ];
  }
  function rxSiteRenderDensity(subject){
    const wrap=el('rxSiteDensityChart');if(!wrap)return;wrap.innerHTML='';for(const [label,q] of rxSiteMetricRows(subject)){const row=document.createElement('div');row.className='rx-density-row';row.innerHTML=`<div class="rx-density-label">${esc(label)}</div><div class="rx-density-track"><div class="rx-density-fill q${q}" style="width:${q*25}%"></div></div><div class="rx-density-q">${Number.isFinite(q)?'Q'+q:'—'}</div>`;wrap.appendChild(row);}
    const idx=rxSiteLocalDestinationIndex(subject.q);const line=el('rxSiteLocalDestinationMarker');if(line)line.style.left=`${Math.max(3,Math.min(97,idx*100))}%`;
    const note=el('rxSiteLocalDestinationValue');if(note)note.textContent=`${Math.round(idx*100)}% destination-oriented`; 
  }
  function rxSiteRenderHub(subject){
    const hub=subject.hubs,wrap=el('rxSiteHubSummary'),marker=el('rxSiteHubMarker');if(!wrap||!marker)return;
    const total=hub.hubs.length, rank=hub.subjectHub?.rank||null, density=hub.subjectHub?.count||0;const pos=rank&&total>1?((total-rank)/(total-1))*100:50; marker.style.left=`${Math.max(4,Math.min(96,pos))}%`; marker.title=rank?`Subject hub #${rank} of ${total} • ${density} points`:'No qualifying subject hub';
    wrap.textContent=rank?`${total} hubs • subject #${rank} • ${density} points`:`${total} hubs • subject not in a qualifying hub`;
  }
  function rxSiteRenderDayparts(subject){
    const d=subject.dayparts;const wrap=el('rxSiteDaypartBar');if(!wrap)return;wrap.querySelector('[data-part="morning"]').classList.toggle('on',d.morning);wrap.querySelector('[data-part="afternoon"]').classList.toggle('on',d.afternoon);wrap.querySelector('[data-part="evening"]').classList.toggle('on',d.evening);el('rxSiteWeekendBox')?.classList.toggle('on',d.weekend);
  }
  function rxSiteArchetypeBlurb(subject){
    const q=subject.q,name=subject.archetype;
    const clauses=[];const popHigh=q.pop1>=3;const destHigh=(q.retail>=3&&q.food>=3);const localHigh=(q.health>=3||q.community>=3);const compHigh=q.competition>=3;
    if(popHigh)clauses.push('high residential population'); else if(q.pop1<=2)clauses.push('smaller residential base');
    if(destHigh)clauses.push('high commercial amenity density per capita'); else if(localHigh)clauses.push('strong local-serving amenity density'); else clauses.push('balanced amenity mix');
    if(compHigh)clauses.push('meaningful competition'); else if(q.competition===1)clauses.push('limited competition');
    return `${name}. ${clauses.slice(0,3).join(', ')}.`;
  }
  function rxSiteRenderArchetypeConfig(){
    const table=el('rxSiteArchetypeTable');if(!table)return;const rows=rxSiteArchetypeRows();const opts=RX_SITE_ARCHETYPE_OPTIONS.map(v=>`<option value="${v}">${v==='ANY'?'Any':v}</option>`).join('');table.innerHTML=`<div class="rx-archetype-config-head"><div>Archetype</div><div>1 km pop</div><div>2 km pop</div><div>Retail</div><div>Food</div><div>Health</div><div>Community</div><div>Competition</div></div>${rows.map((r,i)=>`<div class="rx-archetype-config-row" data-r="${i}"><input class="rx-arch-name" value="${esc(r.name||'')}">${RX_SITE_ARCHETYPE_FIELDS.map(f=>`<select data-f="${f}">${opts}</select>`).join('')}</div>`).join('')}`;
    rows.forEach((r,i)=>RX_SITE_ARCHETYPE_FIELDS.forEach(f=>{const s=table.querySelector(`.rx-archetype-config-row[data-r="${i}"] select[data-f="${f}"]`);if(s)s.value=r[f]||'ANY';}));
    table.querySelectorAll('.rx-arch-name').forEach((inp)=>inp.addEventListener('input',e=>{const i=Number(e.target.closest('.rx-archetype-config-row').dataset.r);state.rxSiteAnalysis.archetypes[i].name=e.target.value;}));
    table.querySelectorAll('select[data-f]').forEach(sel=>sel.addEventListener('change',e=>{const i=Number(e.target.closest('.rx-archetype-config-row').dataset.r);state.rxSiteAnalysis.archetypes[i][e.target.dataset.f]=e.target.value;}));
  }
  function rxSiteRender(subject){
    const q=subject.q;const dialog=el('rxSiteAnalysisDialog');if(dialog&&!dialog.open)dialog.showModal();
    const addr=el('rxSiteAnalysisHero');if(addr)addr.innerHTML=`<div class="rx-site-hero-title">${esc(subject.address||'Trade Area Analysis')}</div><div class="rx-site-hero-sub">Objective local-area profile • population, amenity intensity, hub structure and estimated activity timing</div>`;
    rxSiteRenderDensity(subject);rxSiteRenderHub(subject);rxSiteRenderDayparts(subject);
    const arch=el('rxSiteAnalysisConclusion');if(arch)arch.innerHTML=`<div class="rx-conclusion-name">${esc(subject.archetype)}</div><div class="rx-conclusion-blurb">${esc(rxSiteArchetypeBlurb(subject))}</div>`;
    const status=el('rxSiteAnalysisStatus');if(status)status.textContent='Analysis ready.';
  }
  function rxSiteBuildSubjectMetrics(subject){
    const model=state.rxSiteAnalysis.model,qb=model.quartiles,denom=Number(subject.pop1)>0?Number(subject.pop1):null;const ap=denom?{retail:subject.amenity.retail/denom*10000,food:subject.amenity.food/denom*10000,health:subject.amenity.health/denom*10000,community:subject.amenity.community/denom*10000,total:subject.amenity.total/denom*10000}:null;
    const q={pop1:rxSiteQuartile(subject.pop1,qb.pop1),pop2:rxSiteQuartile(subject.pop2,qb.pop2),retail:rxSiteQuartile(ap?.retail,qb.retail),food:rxSiteQuartile(ap?.food,qb.food),health:rxSiteQuartile(ap?.health,qb.health),community:rxSiteQuartile(ap?.community,qb.community),totalAmenityPC:rxSiteQuartile(ap?.total,qb.totalAmenityPC),competition:rxSiteQuartile(subject.comp,qb.competition)};
    return {...subject,amenityPC:ap,q,dayparts:rxSiteDayparts(q),archetype:rxSiteMatchArchetype(q),hubs:rxSiteDetectHubs(subject)};
  }
  async function rxSiteAnalyzeAddress(address){
    if(!state.rxSiteAnalysis.modelReady)await rxSiteBuildNetworkBenchmark();
    const status=el('rxSiteAnalysisStatus');if(status)status.textContent='Finding address…';
    try{
      const g=await geocodeAddress(address);const c=g?.[0]||g?.results?.[0];const lat=Number(c?.lat??c?.geometry?.lat??c?.geometry?.location?.lat),lng=Number(c?.lon??c?.geometry?.lng??c?.geometry?.location?.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))throw new Error('Address could not be located.');
      let province=provinceCodeFromAddress(c?.address||c?.display_name||address,null);if(!province){const point=turf.point([lng,lat]);const csd=await lookupCensusDistrict(point);province=csd?provinceCodeFromCsdFeature(csd):null;}if(!province)throw new Error('Could not determine province for this address.');
      const [pop1,pop2,amenity]=await Promise.all([rxSitePopulationRadius({},lat,lng,1,province),rxSitePopulationRadius({},lat,lng,2,province),rxSiteAmenities(lat,lng)]);const comp=rxSiteCountSecondary(lat,lng,1);const subject={address:c?.address||c?.display_name||address,lat,lng,pop1,pop2,comp,amenity,province};
      state.rxSiteAnalysis.subject=rxSiteBuildSubjectMetrics(subject);rxSiteRender(state.rxSiteAnalysis.subject);
    }catch(err){if(status)status.textContent=`Analysis failed: ${err.message}`;throw err;}
  }
  function rxSiteOpen(){ if(!state.rxSiteAnalysis.enabled)return; const dialog=el('rxSiteAnalysisDialog'); if(dialog&&!dialog.open){dialog.showModal(); if(!state.rxSiteAnalysis.modelReady){const s=el('rxSiteAnalysisStatus');if(s)s.textContent='Preparing trade-area benchmark… this happens once per loaded data set.';rxSiteBuildNetworkBenchmark().catch(()=>{});} } }
  function rxSiteWire(){
    const form=el('rxSiteAnalysisForm');
    if(form&&!form.dataset.bound){form.dataset.bound='1';form.addEventListener('submit',async e=>{e.preventDefault();const address=el('rxSiteAnalysisAddress')?.value.trim();if(!address||!state.rxSiteAnalysis.enabled)return;const btn=el('rxSiteAnalysisGo');if(btn)btn.disabled=true;try{await rxSiteAnalyzeAddress(address);}catch(_){ }finally{if(btn)btn.disabled=!state.rxSiteAnalysis.enabled;}});}
    if(el('rxSiteAnalysisConfigure')&&!el('rxSiteAnalysisConfigure').dataset.bound){el('rxSiteAnalysisConfigure').dataset.bound='1';el('rxSiteAnalysisConfigure').addEventListener('click',()=>{const panel=el('rxSiteArchetypeConfigPanel');panel?.classList.toggle('open');if(panel?.classList.contains('open'))rxSiteRenderArchetypeConfig();});}
    if(el('rxSiteArchetypeSave')&&!el('rxSiteArchetypeSave').dataset.bound){el('rxSiteArchetypeSave').dataset.bound='1';el('rxSiteArchetypeSave').addEventListener('click',()=>{rxSiteSaveArchetypes(state.rxSiteAnalysis.archetypes);if(state.rxSiteAnalysis.subject){state.rxSiteAnalysis.subject.archetype=rxSiteMatchArchetype(state.rxSiteAnalysis.subject.q);rxSiteRender(state.rxSiteAnalysis.subject);}});}
    if(el('rxSiteArchetypeReset')&&!el('rxSiteArchetypeReset').dataset.bound){el('rxSiteArchetypeReset').dataset.bound='1';el('rxSiteArchetypeReset').addEventListener('click',()=>{state.rxSiteAnalysis.archetypes=rxSiteArchetypeDefaults();rxSiteRenderArchetypeConfig();});}
    if(el('rxSiteAnalysisClose')&&!el('rxSiteAnalysisClose').dataset.bound){el('rxSiteAnalysisClose').dataset.bound='1';el('rxSiteAnalysisClose').addEventListener('click',()=>el('rxSiteAnalysisDialog')?.close());}
    rxSiteStateReady();
  }
  async function rxSiteMaybeBuild(){ if(!rxSiteStateReady())return; rxSiteWire(); }
  // ---------- Subjects configuration ----------
  function ensureDraftTable(){if(!state.subjectConfigDraftTable)state.subjectConfigDraftTable=normalizeSubjectTable(state.subjectTable||loadSubjectTableForHeaders(state.headers||[]));return state.subjectConfigDraftTable;}
  function selectedSubjectCell(){const t=ensureDraftTable();state.subjectSelectedCell=state.subjectSelectedCell||{r:0,c:0};const r=Math.max(0,Math.min(t.rows-1,Number(state.subjectSelectedCell.r)||0));const c=Math.max(0,Math.min(t.cols-1,Number(state.subjectSelectedCell.c)||0));state.subjectSelectedCell={r,c};return {t,r,c,cell:t.cells[r][c]};}
  function subjectCellLabel(r,c){let n=c+1,s='';while(n){const rem=(n-1)%26;s=String.fromCharCode(65+rem)+s;n=Math.floor((n-1)/26);}return `${s}${r+1}`;}
  function syncSubjectCellEditor(){const {cell,r,c}=selectedSubjectCell();el('subjectSelectedCellLabel').textContent=subjectCellLabel(r,c);el('subjectCellType').value=cell.type;const select=el('subjectCellColumn');select.innerHTML='<option value="">Choose column</option><optgroup label="Workbook columns">'+(state.headers||[]).map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')+'</optgroup><optgroup label="Census virtual fields">'+subjectVirtualNames().map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')+'</optgroup>';if(cell.type==='value'&&cell.content)select.value=cell.content;else if(cell.type==='formula'){const first=firstSubjectOperand(cell.content);if(first)select.value=first;}el('subjectCellExpression').value=cell.content;el('subjectCellNumberFormat').value=cell.numberFormat;el('subjectCellDecimals').value=String(cell.decimalPlaces);el('subjectCellAggregation').value=cell.aggregation;const show=cell.type!=='text';el('subjectChooseColumnWrap').style.display=show?'grid':'none';['subjectCellNumberFormat','subjectCellDecimals','subjectCellAggregation'].forEach(id=>{const node=el(id);if(node)node.closest('label').style.display=show?'grid':'none';});const warning=el('subjectCellFormulaWarning');const issue=cell.type==='text'?'':subjectFormulaIssue(String(cell.content||''));warning.textContent=issue||'';warning.hidden=!issue;}
  function bindSubjectEditor(){el('subjectCellType').addEventListener('change',()=>{const {cell}=selectedSubjectCell();cell.type=el('subjectCellType').value;syncSubjectCellEditor();});el('subjectCellExpression').addEventListener('input',e=>{const {cell}=selectedSubjectCell();cell.content=e.target.value;const warning=el('subjectCellFormulaWarning');const issue=cell.type==='text'?'':subjectFormulaIssue(cell.content);warning.textContent=issue||'';warning.hidden=!issue;});el('subjectCellColumn').addEventListener('change',e=>{const chosen=e.target.value;if(!chosen)return;const {cell}=selectedSubjectCell();const current=String(cell.content||'').trim();if(cell.type==='value')cell.content=chosen;else if(cell.type==='formula')cell.content=current?`${current}${chosen}`:chosen;else{cell.type='value';cell.content=chosen;}syncSubjectCellEditor();});el('subjectCellNumberFormat').addEventListener('change',e=>{const {cell}=selectedSubjectCell();cell.numberFormat=e.target.value;cell.decimalPlaces=defaultTickerDecimals(cell.numberFormat);syncSubjectCellEditor();});el('subjectCellDecimals').addEventListener('change',e=>{selectedSubjectCell().cell.decimalPlaces=Number(e.target.value)||0;});el('subjectCellAggregation').addEventListener('change',e=>{selectedSubjectCell().cell.aggregation=e.target.value;});}
  function focusSubjectCell(r,c,{scroll=true}={}){const t=ensureDraftTable();if(t.rows<1||t.cols<1)return;const nextR=Math.max(0,Math.min(t.rows-1,r));const nextC=Math.max(0,Math.min(t.cols-1,c));state.subjectSelectedCell={r:nextR,c:nextC};syncSubjectCellEditor();renderSubjectCanvas();const canvas=el('subjectCanvas');const cell=canvas?.querySelector(`.subject-canvas-cell[data-row="${nextR}"][data-col="${nextC}"]`);if(scroll)cell?.scrollIntoView({block:'nearest',inline:'nearest'});cell?.focus({preventScroll:true});}
  function handleSubjectCanvasKeydown(e){const {r,c}=selectedSubjectCell();const t=ensureDraftTable();let nr=r,nc=c,moved=false;if(e.key==='ArrowUp'){nr=Math.max(0,r-1);moved=nr!==r;}else if(e.key==='ArrowDown'){nr=Math.min(t.rows-1,r+1);moved=nr!==r;}else if(e.key==='ArrowLeft'){nc=Math.max(0,c-1);moved=nc!==c;}else if(e.key==='ArrowRight'){nc=Math.min(t.cols-1,c+1);moved=nc!==c;}else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();syncSubjectCellEditor();const input=el('subjectCellExpression');if(input){input.focus();const pos=input.value.length;try{input.setSelectionRange(pos,pos);}catch(_){}}return;}else{return;}e.preventDefault();e.stopPropagation();if(moved)focusSubjectCell(nr,nc);}
  function renderSubjectCanvas(){const canvas=el('subjectCanvas');if(!canvas)return;const t=ensureDraftTable();canvas.style.setProperty('--subject-cols',t.cols);canvas.innerHTML='';for(let r=0;r<t.rows;r++){const row=document.createElement('div');row.className='subject-canvas-row';for(let c=0;c<t.cols;c++){const cell=normalizeSubjectCell(t.cells[r][c]);const div=document.createElement('button');div.type='button';div.className='subject-canvas-cell';div.dataset.row=r;div.dataset.col=c;div.setAttribute('role','gridcell');div.tabIndex=state.subjectSelectedCell?.r===r&&state.subjectSelectedCell?.c===c?0:-1;div.classList.toggle('selected',state.subjectSelectedCell?.r===r&&state.subjectSelectedCell?.c===c);const text=String(cell.content||'').trim();div.innerHTML=cell.type==='formula'&&text?`<span class="subject-canvas-formula-fragment">${esc(subjectCellFormulaFragment(cell))}</span>`:esc(text);if(cell.type==='formula'&&text)div.title=text;div.addEventListener('click',()=>{focusSubjectCell(r,c);});div.addEventListener('focus',()=>{if(state.subjectSelectedCell?.r!==r||state.subjectSelectedCell?.c!==c){state.subjectSelectedCell={r,c};syncSubjectCellEditor();}});row.appendChild(div);}canvas.appendChild(row);}}
  function addSubjectRow(){const t=ensureDraftTable();t.cells.push(Array.from({length:t.cols},()=>blankSubjectCell()));t.rows++;state.subjectSelectedCell={r:t.rows-1,c:0};renderSubjectCanvas();syncSubjectCellEditor();}
  function addSubjectColumn(){const t=ensureDraftTable();for(const row of t.cells)row.push(blankSubjectCell());t.cols++;state.subjectSelectedCell={r:0,c:t.cols-1};renderSubjectCanvas();syncSubjectCellEditor();}
  function openSubjectConfig(){if(!state.headers.length||!state.rows.length){alert('Load a financial workbook before configuring Subjects.');return;}state.subjectConfigDraftTable=normalizeSubjectTable(state.subjectTable||loadSubjectTableForHeaders(state.headers||[]));state.subjectSelectedCell={r:0,c:0};renderSubjectCanvas();syncSubjectCellEditor();el('subjectsDialog').showModal();}
  function validateSubjectTableDraft(){const t=ensureDraftTable();const exactHeaders=new Set(state.headers);for(let r=0;r<t.rows;r++)for(let c=0;c<t.cols;c++){const cell=normalizeSubjectCell(t.cells[r][c]);const formula=String(cell.content||'').trim();if(!formula||cell.type==='text')continue;const issue=subjectFormulaIssue(formula);if(issue)return `Cell ${subjectCellLabel(r,c)}: ${issue}.`;for(const tok of subjectFormulaTokens(formula)||[]){if(tok.type==='operand'&&!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(tok.value)&&!exactHeaders.has(tok.value)&&!isSubjectVirtualOperand(tok.value))return `Cell ${subjectCellLabel(r,c)} uses a column that is not present in the workbook: ${tok.value}`;}}return '';}
  function applySubjectConfig(){state.subjectTable=sanitizeSubjectTableForHeaders(ensureDraftTable(),state.headers||[]);state.subjects=subjectTableToMetrics(state.subjectTable);saveSubjectConfig();refreshConfigUI();updateSubjects();updateGroups();updateDistribution();refreshMarkerStyles();renderSubjectCanvas();syncSubjectCellEditor();}
  function resetSubjectDefaults(){state.subjectConfigDraftTable=canonicalSubjectDefaultTable();state.subjectSelectedCell={r:0,c:0};renderSubjectCanvas();syncSubjectCellEditor();}
  async function exportSubjectsTable(){
    if(typeof XLSX==='undefined'){alert('Excel export library did not load.');return;}
    const t=normalizeSubjectTable(state.subjectTable||loadSubjectTableForHeaders(state.headers||[]));const rows=state.selectedRows||[];
    const data=t.cells.map(row=>row.map(cell=>subjectTableCellDisplay(cell,rows)));
    if(!data.some(row=>row.some(v=>String(v||'').trim()!==''))){alert('There is no Subject table content to export.');return;}
    const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet(data);XLSX.utils.book_append_sheet(wb,ws,'Subjects');const filename='subjects.xls';
    if(typeof window.showSaveFilePicker==='function'){
      try{const handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'Excel 97-2003 workbook',accept:{'application/vnd.ms-excel':['.xls']}}]});const bytes=XLSX.write(wb,{bookType:'biff8',type:'array'});const writable=await handle.createWritable();await writable.write(bytes);await writable.close();return;}catch(err){if(err?.name==='AbortError')return;}
    }
    XLSX.writeFile(wb,filename,{bookType:'biff8'});
  }
  bindSubjectEditor();
  el('subjectCommit').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applySubjectConfig();});
  el('subjectClose').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();el('subjectsDialog').close();});
  el('subjectAddColumnZone').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();addSubjectColumn();});
  el('subjectAddRowZone').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();addSubjectRow();});
  el('subjectCanvas').addEventListener('keydown',handleSubjectCanvasKeydown);
  el('exportSubjectsBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();exportSubjectsTable();});
  el('subjectsBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openSubjectConfig();});
  // ---------- Popup configuration ----------
  const POPUP_TABS_STORAGE_KEY='storeExplorer.popupTabs.v1';
  const POPUP_TAB_ROWS_DEFAULT=5, POPUP_TAB_COLS_DEFAULT=3;
  let popupGridRowSeq=0;
  function makePopupGridRowId(){popupGridRowSeq+=1;return `popup-row-${Date.now().toString(36)}-${popupGridRowSeq}`;}
  function blankPopupGridCell(){return {type:'text',content:'',numberFormat:'auto',decimalPlaces:0,aggregation:'sum',quartile:false};}
  function makePopupGrid(rows=POPUP_TAB_ROWS_DEFAULT,cols=POPUP_TAB_COLS_DEFAULT){return {rows,cols,cells:Array.from({length:rows},()=>Array.from({length:cols},()=>blankPopupGridCell())),rowIds:Array.from({length:rows},()=>makePopupGridRowId()),quartileRows:Array.from({length:rows},()=>false)};}
  function normalizePopupGridCell(c){const type=['text','value','formula'].includes(c?.type)?c.type:'text';const nf=['auto','number','currency','percentage'].includes(c?.numberFormat)?c.numberFormat:'auto';const d=Number(c?.decimalPlaces);return {type,content:String(c?.content??''),numberFormat:nf,decimalPlaces:Number.isInteger(d)&&d>=0&&d<=4?d:defaultTickerDecimals(nf),aggregation:['sum','average','median','count'].includes(c?.aggregation)?c.aggregation:'sum',quartile:!!c?.quartile};}
  function normalizePopupGrid(g){const rows=Math.max(1,Math.min(30,Number(g?.rows)||POPUP_TAB_ROWS_DEFAULT)),cols=Math.max(1,Math.min(20,Number(g?.cols)||POPUP_TAB_COLS_DEFAULT));const hasRowFlags=Array.isArray(g?.quartileRows);const rowIds=Array.from({length:rows},(_,r)=>String(g?.rowIds?.[r]||makePopupGridRowId()));const quartileRows=Array.from({length:rows},(_,r)=>hasRowFlags?!!g.quartileRows[r]:Array.isArray(g?.cells?.[r])&&g.cells[r].some(c=>!!c?.quartile));return {rows,cols,cells:Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>normalizePopupGridCell(g?.cells?.[r]?.[c]))),rowIds,quartileRows};}
  function popupTabDefaultConfig(i){
    const grid=makePopupGrid();
    if(i===0){
      const fields=(state.popupConfig||[]).map(normalizePopupField);
      const wanted=Math.max(grid.rows,fields.length+popupVirtualNames().length);
      while(grid.rows<wanted){grid.cells.push(Array.from({length:grid.cols},()=>blankPopupGridCell()));grid.rowIds.push(makePopupGridRowId());grid.quartileRows.push(false);grid.rows++;}
      fields.forEach((f,r)=>{
        grid.cells[r][0]={type:'text',content:f.title||f.formula};
        grid.cells[r][1]={type:'value',content:f.formula,numberFormat:f.numberFormat,decimalPlaces:f.decimalPlaces,aggregation:'sum',quartile:false};
        grid.quartileRows[r]=!!f.quartile;
      });
      popupVirtualNames().forEach((v,j)=>{
        const r=fields.length+j;
        grid.cells[r][0]={type:'text',content:v};
        grid.cells[r][1]={type:'value',content:v,numberFormat:'number',decimalPlaces:0,aggregation:'sum',quartile:false};
      });
    }
    return {name:state.primaryTabs?.[i]?.name||`Tab ${i+1}`,filterOnProfile:true,grid};
  }
  function loadPopupTabConfigs(){
    let raw=null;try{raw=JSON.parse(localStorage.getItem(POPUP_TABS_STORAGE_KEY)||'null');}catch(_){}
    const tabs=state.primaryTabs||[];
    state.popupTabConfigs=tabs.map((t,i)=>{
      const fallback=popupTabDefaultConfig(i),saved=Array.isArray(raw)?raw[i]:null;
      return {name:t.name||`Tab ${i+1}`,filterOnProfile:typeof saved?.filterOnProfile==='boolean'?saved.filterOnProfile:fallback.filterOnProfile,filters:Array.isArray(saved?.filters)?saved.filters.filter(x=>x&&x.column).map(x=>({column:x.column,value:String(x.value??''),operator:['=','<','<=','>','>='].includes(x.operator)?x.operator:'=',scope:x.scope==='row'&&normalizePopupGrid(saved?.grid||fallback.grid).rowIds.includes(x.rowId)?'row':'all',rowId:x.scope==='row'?x.rowId:''})):[],grid:normalizePopupGrid(saved?.grid||fallback.grid)};
    });
    state.popupTabDrafts=state.popupTabConfigs.map(x=>({name:x.name,filterOnProfile:x.filterOnProfile,filters:x.filters.map(f=>({...f})),grid:normalizePopupGrid(x.grid)}));
  }
  function savePopupTabConfigs(){try{localStorage.setItem(POPUP_TABS_STORAGE_KEY,JSON.stringify(state.popupTabConfigs||[]));}catch(_){} }
  function addPopupTabFilter(i){const d=state.popupTabDrafts?.[i];if(!d)return;d.filters.push({column:'',value:'',operator:'=',scope:'all',rowId:''});renderPopupTabConfigSections();}
  function removePopupTabFilter(i,idx){const d=state.popupTabDrafts?.[i];if(!d)return;d.filters.splice(idx,1);renderPopupTabConfigSections();}
  function popupTabSelectedCell(i){const d=state.popupTabDrafts?.[i];if(!d)return null;const r=Math.max(0,Math.min(d.grid.rows-1,state.popupTabSelected?.tab===i?state.popupTabSelected.r:0)),c=Math.max(0,Math.min(d.grid.cols-1,state.popupTabSelected?.tab===i?state.popupTabSelected.c:0));state.popupTabSelected={tab:i,r,c};return {draft:d,cell:d.grid.cells[r][c],r,c};}
  function popupCellLabel(r,c){let n=c+1,s='';while(n){const rem=(n-1)%26;s=String.fromCharCode(65+rem)+s;n=Math.floor((n-1)/26);}return `${s}${r+1}`;}
  function popupTabSourceOptions(i){const t=state.primaryTabs?.[i],hs=t?.headers||[];let html='<option value="">Choose column</option><optgroup label="Worksheet">';html+=hs.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')+'</optgroup>';if(i===0)html+=`<optgroup label="Census virtual fields">${popupVirtualNames().map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')}</optgroup>`;return html;}
  function popupTabRenderEditor(section,i){const sel=popupTabSelectedCell(i);if(!sel)return;const {cell,r,c}=sel;section.querySelector('[data-role="cell-label"]').textContent=popupCellLabel(r,c);section.querySelector('[data-role="cell-type"]').value=cell.type;const col=section.querySelector('[data-role="cell-column"]');const colWrap=section.querySelector('[data-role="cell-column-wrap"]');const fmt=section.querySelector('[data-role="cell-format"]');const dec=section.querySelector('[data-role="cell-decimals"]');const agg=section.querySelector('[data-role="cell-aggregation"]');col.innerHTML=popupTabSourceOptions(i);col.value=cell.type!=='text'?cell.content:'';section.querySelector('[data-role="cell-expression"]').value=cell.content;fmt.value=cell.numberFormat;dec.value=String(cell.decimalPlaces);agg.value=cell.aggregation;const locked=cell.type==='text';[col,fmt,dec,agg].forEach(el=>{el.disabled=locked;el.closest('label')?.classList.toggle('is-disabled',locked);});colWrap.style.display='flex';}
  function popupTabRenderGrid(section,i){
    const d=state.popupTabDrafts?.[i];if(!d)return;const canvas=section.querySelector('.popup-tab-canvas');const rail=section.querySelector('.popup-tab-quartile-rail');canvas.style.setProperty('--popup-cols',d.grid.cols);canvas.replaceChildren();if(rail)rail.replaceChildren();
    const anchor=state.popupTabSelectionAnchor?.tab===i?state.popupTabSelectionAnchor:{tab:i,r:0,c:0};const selected=state.popupTabSelected?.tab===i?state.popupTabSelected:{tab:i,r:0,c:0};const minR=Math.min(anchor.r,selected.r),maxR=Math.max(anchor.r,selected.r),minC=Math.min(anchor.c,selected.c),maxC=Math.max(anchor.c,selected.c);
    if(i===0&&rail){const head=document.createElement('div');head.className='popup-tab-quartile-head';head.textContent='Quartile';rail.appendChild(head);for(let r=0;r<d.grid.rows;r++){const qLabel=document.createElement('label');qLabel.className='popup-row-quartile-toggle';qLabel.title='Use column 2 as a quartile basis';const q=document.createElement('input');q.type='checkbox';q.checked=!!d.grid.quartileRows?.[r];q.setAttribute('aria-label',`Include row ${r+1} in quartiles`);q.addEventListener('click',e=>e.stopPropagation());q.addEventListener('change',()=>{if(!Array.isArray(d.grid.quartileRows))d.grid.quartileRows=Array.from({length:d.grid.rows},()=>false);d.grid.quartileRows[r]=!!q.checked;});qLabel.appendChild(q);rail.appendChild(qLabel);}}
    for(let r=0;r<d.grid.rows;r++){const row=document.createElement('div');row.className='subject-canvas-row';for(let c=0;c<d.grid.cols;c++){const cell=normalizePopupGridCell(d.grid.cells[r][c]),b=document.createElement('button');b.type='button';b.className='subject-canvas-cell';b.dataset.row=r;b.dataset.col=c;b.tabIndex=(selected.r===r&&selected.c===c)?0:-1;b.classList.toggle('selected',selected.r===r&&selected.c===c);b.classList.toggle('range-selected',r>=minR&&r<=maxR&&c>=minC&&c<=maxC);b.textContent=cell.content||'';b.title=cell.type==='formula'?cell.content:'';
      b.addEventListener('click',e=>{if(e.shiftKey&&state.popupTabSelectionAnchor?.tab===i){state.popupTabSelected={tab:i,r,c};}else{state.popupTabSelected={tab:i,r,c};state.popupTabSelectionAnchor={tab:i,r,c};}popupTabRenderGrid(section,i);popupTabRenderEditor(section,i);b.focus({preventScroll:true});});
      b.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'||e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();let nr=r,nc=c;if(e.key==='ArrowUp')nr=Math.max(0,r-1);if(e.key==='ArrowDown')nr=Math.min(d.grid.rows-1,r+1);if(e.key==='ArrowLeft')nc=Math.max(0,c-1);if(e.key==='ArrowRight')nc=Math.min(d.grid.cols-1,c+1);if(e.shiftKey&&state.popupTabSelectionAnchor?.tab===i)state.popupTabSelected={tab:i,r:nr,c:nc};else{state.popupTabSelected={tab:i,r:nr,c:nc};state.popupTabSelectionAnchor={tab:i,r:nr,c:nc};}popupTabRenderGrid(section,i);popupTabRenderEditor(section,i);requestAnimationFrame(()=>section.querySelector(`.subject-canvas-cell[data-row="${nr}"][data-col="${nc}"]`)?.focus({preventScroll:true}));}else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();for(let rr=minR;rr<=maxR;rr++)for(let cc=minC;cc<=maxC;cc++)d.grid.cells[rr][cc]=blankPopupGridCell();state.popupTabSelected={tab:i,r:minR,c:minC};state.popupTabSelectionAnchor={tab:i,r:minR,c:minC};popupTabRenderGrid(section,i);popupTabRenderEditor(section,i);}});
      row.appendChild(b);}canvas.appendChild(row);}popupTabRenderEditor(section,i);
  }
  function popupTabGridToLegacyFields(){const d=state.popupTabDrafts?.[0];if(!d)return [];const out=[];for(let r=0;r<d.grid.rows;r++){const row=d.grid.cells[r]||[];const basis=normalizePopupGridCell(row[1]);const useQuartile=!!d.grid.quartileRows?.[r];for(let c=0;c<row.length;c++){const cell=normalizePopupGridCell(row[c]),f=String(cell.content||'').trim();if(!f||cell.type==='text')continue;const prev=row[c-1];const title=prev&&normalizePopupGridCell(prev).type==='text'&&String(prev.content||'').trim()?String(prev.content).trim():f;out.push(normalizePopupField({formula:f,title,numberFormat:cell.numberFormat,decimalPlaces:cell.decimalPlaces,quartile:c===1&&useQuartile&&basis.type!=='text'}));}}return out;}
  function renderPopupTabConfigSections(){
    const host=el('popupTabConfigSections');if(!host)return;host.replaceChildren();
    (state.popupTabDrafts||[]).forEach((tab,i)=>{
      const section=document.createElement('section');section.className=`popup-tab-config-box ${i%2?'odd':'even'}`;section.dataset.tab=i;
      const gridRows=normalizePopupGrid(tab.grid).rows,gridRowIds=normalizePopupGrid(tab.grid).rowIds||[];const filterRows=(tab.filters||[]).map((f,idx)=>{const scope=f.scope==='row'&&gridRowIds.includes(f.rowId)?'row':'all';const scopeOptions=[`<option value="all" ${scope==='all'?'selected':''}>All rows</option>`,...gridRowIds.map((id,r)=>`<option value="${esc(id)}" ${scope==='row'&&f.rowId===id?'selected':''}>Row ${r+1}</option>`)];const operator=['=','<','<=','>','>='].includes(f.operator)?f.operator:'=';return `<div class="popup-tab-filter-row"><select class="popup-tab-filter-scope" data-filter-scope="${idx}">${scopeOptions.join('')}</select><select data-filter-column="${idx}"><option value="">Choose column</option>${(state.primaryTabs?.[i]?.headers||[]).map(h=>`<option value="${esc(h)}" ${f.column===h?'selected':''}>${esc(h)}</option>`).join('')}</select><select class="popup-tab-filter-operator" data-filter-operator="${idx}">${['=','<','<=','>','>='].map(op=>`<option value="${op}" ${operator===op?'selected':''}>${op}</option>`).join('')}</select><input type="text" data-filter-value="${idx}" value="${esc(f.value||'')}" placeholder="Filter value"><button type="button" class="secondary" data-filter-remove="${idx}">×</button></div>`;}).join('');
      section.innerHTML=`<div class="popup-tab-config-head"><div><strong>Tab: ${esc(tab.name)}</strong><span class="small muted">${i===0?'Primary store data':'Additional worksheet'}</span></div><label class="popup-marker-filter"><input type="checkbox" data-profile-filter="1" ${tab.filterOnProfile?'checked':''}> Filter on marker store profile#</label></div>${i>0?`<div class="popup-tab-filters"><div class="popup-tab-subtitle">Additional filters — AND together</div><div class="popup-tab-filter-head"><span>Apply to</span><span>Column</span><span>Operator</span><span>Value</span><span aria-hidden="true"></span></div>${filterRows}<button type="button" class="secondary" data-filter-add="1">+ Add filter</button></div>`:''}<div class="subject-cell-editor popup-grid-editor"><div class="subject-cell-editor-title-row"><div><strong>Edit cell</strong> <span data-role="cell-label" class="small muted">A1</span></div>${i===0?'<div class="small muted">Tab 1 only: value/formula cells may be included in quartiles.</div>':''}</div><div class="subject-cell-editor-grid"><label>Type<select data-role="cell-type"><option value="text">Text</option><option value="value">Value</option><option value="formula">Formula</option></select></label><label data-role="cell-column-wrap">Choose column<select data-role="cell-column"></select></label><label class="subject-cell-expression-field">Value / Formula<input data-role="cell-expression" type="text" autocomplete="off" placeholder="Enter text, value, or formula"></label><label>Number format<select data-role="cell-format"><option value="auto">Auto</option><option value="number">Number</option><option value="currency">Currency</option><option value="percentage">Percentage</option></select></label><label>Decimals<select data-role="cell-decimals"><option>0</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label><label>Aggregation<select data-role="cell-aggregation"><option value="sum">Sum</option><option value="average">Average</option><option value="median">Median</option><option value="count">Count</option></select></label></div><div class="subject-table-edit-actions"><button type="button" class="subject-canvas-add-zone" data-add-row="1">＋ Add row</button><button type="button" class="subject-canvas-add-zone" data-add-col="1">＋ Add column</button><button type="button" class="subject-canvas-add-zone popup-grid-clear-btn" data-clear-selection="1">Clear</button></div></div><div class="subject-canvas-wrap"><div class="subject-canvas-title">Configured output grid</div><div class="subject-canvas-scroll"><div class="popup-tab-grid-surface"><div class="popup-tab-quartile-rail${i===0?'':' is-hidden'}" aria-hidden="${i===0?'false':'true'}"></div><div class="subject-canvas popup-tab-canvas" role="grid"></div></div></div></div>`;
      host.appendChild(section);popupTabRenderGrid(section,i);
      section.querySelector('[data-profile-filter]').addEventListener('change',e=>state.popupTabDrafts[i].filterOnProfile=!!e.target.checked);
      section.querySelector('[data-filter-add]')?.addEventListener('click',()=>{state.popupTabDrafts[i].filters.push({column:'',value:'',operator:'=',scope:'all',rowId:''});renderPopupTabConfigSections();});
      section.querySelectorAll('[data-filter-scope]').forEach(n=>n.addEventListener('change',e=>{const f=state.popupTabDrafts[i].filters[Number(e.target.dataset.filterScope)];if(!f)return;const value=e.target.value;f.scope=value==='all'?'all':'row';f.rowId=value==='all'?'':value;}));
      section.querySelectorAll('[data-filter-column]').forEach(n=>n.addEventListener('change',e=>state.popupTabDrafts[i].filters[Number(e.target.dataset.filterColumn)].column=e.target.value));
      section.querySelectorAll('[data-filter-operator]').forEach(n=>n.addEventListener('change',e=>state.popupTabDrafts[i].filters[Number(e.target.dataset.filterOperator)].operator=e.target.value));
      section.querySelectorAll('[data-filter-value]').forEach(n=>n.addEventListener('input',e=>state.popupTabDrafts[i].filters[Number(e.target.dataset.filterValue)].value=e.target.value));
      section.querySelectorAll('[data-filter-remove]').forEach(n=>n.addEventListener('click',()=>removePopupTabFilter(i,Number(n.dataset.filterRemove))));
      section.querySelector('[data-add-row]').addEventListener('click',()=>{const d=state.popupTabDrafts[i];d.grid.rows++;d.grid.cells.push(Array.from({length:d.grid.cols},()=>blankPopupGridCell()));d.grid.rowIds=Array.isArray(d.grid.rowIds)?d.grid.rowIds:[];d.grid.rowIds.push(makePopupGridRowId());if(!Array.isArray(d.grid.quartileRows))d.grid.quartileRows=[];d.grid.quartileRows.push(false);renderPopupTabConfigSections();});
      section.querySelector('[data-add-col]').addEventListener('click',()=>{const d=state.popupTabDrafts[i];d.grid.cols++;d.grid.cells.forEach(r=>r.push(blankPopupGridCell()));popupTabRenderGrid(section,i);});
      section.querySelector('[data-clear-selection]').addEventListener('click',()=>{const d=state.popupTabDrafts[i],anchor=state.popupTabSelectionAnchor?.tab===i?state.popupTabSelectionAnchor:{tab:i,r:0,c:0},selected=state.popupTabSelected?.tab===i?state.popupTabSelected:{tab:i,r:0,c:0},minR=Math.min(anchor.r,selected.r),maxR=Math.max(anchor.r,selected.r),minC=Math.min(anchor.c,selected.c),maxC=Math.max(anchor.c,selected.c);for(let rr=minR;rr<=maxR;rr++)for(let cc=minC;cc<=maxC;cc++)d.grid.cells[rr][cc]=blankPopupGridCell();popupTabRenderGrid(section,i);});
      section.querySelector('[data-role="cell-type"]').addEventListener('change',e=>{const z=popupTabSelectedCell(i);z.cell.type=e.target.value;if(z.cell.type==='text')z.cell.quartile=false;popupTabRenderGrid(section,i);});
      section.querySelector('[data-role="cell-column"]').addEventListener('change',e=>{const z=popupTabSelectedCell(i),chosen=e.target.value;if(!chosen)return;if(z.cell.type==='formula'){const cur=String(z.cell.content||'').trim();z.cell.content=cur?`${cur}${chosen}`:chosen;}else{z.cell.type='value';z.cell.content=chosen;}popupTabRenderGrid(section,i);});
      section.querySelector('[data-role="cell-expression"]').addEventListener('input',e=>{const z=popupTabSelectedCell(i);z.cell.content=e.target.value;});
      section.querySelector('[data-role="cell-format"]').addEventListener('change',e=>{const z=popupTabSelectedCell(i);z.cell.numberFormat=e.target.value;z.cell.decimalPlaces=defaultTickerDecimals(z.cell.numberFormat);popupTabRenderEditor(section,i);});
      section.querySelector('[data-role="cell-decimals"]').addEventListener('change',e=>{const z=popupTabSelectedCell(i);z.cell.decimalPlaces=Number(e.target.value)||0;});
      section.querySelector('[data-role="cell-aggregation"]').addEventListener('change',e=>{const z=popupTabSelectedCell(i);z.cell.aggregation=e.target.value;});
    });
  }

  function openPopupConfig(){
    if(!state.headers.length||!state.rows.length){alert('Load a financial workbook before configuring popups.');return;}
    if(!state.popupHeader)loadPopupHeaderConfig();state.popupHeaderDraft=normalizePopupHeader(state.popupHeader);if(!Array.isArray(state.popupConfig)||!state.popupConfig.length)loadPopupConfig();state.popupConfigDraft=state.popupConfig.map(normalizePopupField);loadPopupTabConfigs();state.popupTabSelected={tab:0,r:0,c:0};state.popupTabSelectionAnchor={tab:0,r:0,c:0};renderPopupHeaderConfig();bindPopupHeaderConfig();const ar=el('popupAmenityRadius');if(ar)ar.value=Number(state.popupAmenityRadius||AMENITY_RADIUS_KM).toFixed(1);state.popupTickerDraft=(state.popupTickerMetrics||[]).map(m=>({...m}));renderPopupTabConfigSections();el('popupDialog').showModal();
  }
  function applyPopupConfig(){
    const next=popupTabGridToLegacyFields();if(!next.length){alert('Tab 1 needs at least one Value or Formula cell.');return;}
    state.popupConfig=next;state.popupConfigDraft=next.map(normalizePopupField);state.popupQuartileDraftChanged=true;state.popupQuartileDistributionCache.clear();state.popupHeader=normalizePopupHeader(state.popupHeaderDraft||state.popupHeader);savePopupConfig();savePopupHeaderConfig();state.popupTabConfigs=(state.popupTabDrafts||[]).map(t=>({name:t.name,filterOnProfile:!!t.filterOnProfile,filters:(t.filters||[]).filter(f=>f&&f.column&&((f.scope||'all')==='all'||normalizePopupGrid(t.grid).rowIds.includes(f.rowId))).map(f=>({column:f.column,value:String(f.value??''),operator:['=','<','<=','>','>='].includes(f.operator)?f.operator:'=',scope:f.scope==='row'?'row':'all',rowId:f.scope==='row'?f.rowId:''})),grid:normalizePopupGrid(t.grid)}));savePopupTabConfigs();refreshConfigUI();if(state.openPopupMarker){refreshOpenPopupCard().catch(err=>console.error('Popup refresh failed after save',err));}el('popupDialog').close();
  }
  function resetPopupDefaults(){loadPopupConfig();loadPopupTabConfigs();state.popupTabSelected={tab:0,r:0,c:0};state.popupTabSelectionAnchor={tab:0,r:0,c:0};renderPopupTabConfigSections();}

  function popupTickerSelectedSet(){return new Set((state.popupTickerDraft||[]).map(m=>String(m.formula||'').trim()).filter(Boolean));}
  function renderPopupTickerConfig(){
    const wrap=el('popupTickerFieldList');
    if(!wrap)return;
    const headers=state.headers||[];
    const options=[...headers,...popupVirtualNames()];
    const selected=popupTickerSelectedSet();
    wrap.replaceChildren();
    if(!options.length){wrap.innerHTML='<div class="empty-message">Load a financial workbook first.</div>';return;}
    const head=document.createElement('div');
    head.className='popup-ticker-config-head';
    head.innerHTML='<span>Column / field</span><span>Use</span>';
    wrap.appendChild(head);
    options.forEach(name=>{
      const row=document.createElement('label');
      row.className='popup-ticker-option-row';
      const type=isPopupVirtualOperand(name)?'Census virtual':(state.types[name]==='numeric'?'Numeric':'Text');
      row.innerHTML=`<span class="popup-ticker-option-title">${esc(name)} <small>${esc(type)}</small></span><input type="checkbox" class="popup-ticker-option-check" data-formula="${esc(name)}" ${selected.has(name)?'checked':''}>`;
      wrap.appendChild(row);
    });
  }

  function openPopupTickerConfig(){
    state.popupTickerDraft=(state.popupTickerMetrics||[]).map(m=>({...m}));
    renderPopupTickerConfig();el('popupTickerDialog').showModal();
  }
  function applyPopupTickerConfig(){
    const next=(state.popupTickerDraft||[]).filter(m=>String(m.formula||'').trim()).map(m=>({formula:String(m.formula).trim(),title:String(m.title||m.formula).trim()||String(m.formula).trim()}));
    state.popupTickerMetrics=next;state.popupTickerIndex=0;savePopupTickerConfig();el('popupTickerDialog').close();startPopupTicker();if(state.openPopupMarker)refreshOpenPopupCard();
  }

  async function readSecondaryLocationsFile(file){
    if(typeof XLSX==='undefined')throw new Error('Excel reader library did not load. Refresh the page and try again.');
    const ext=file.name.toLowerCase().split('.').pop(); const wb=ext==='csv'?XLSX.read(await file.text(),{type:'string'}):XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
    const ws=wb.Sheets[wb.SheetNames[0]]; if(!ws)throw new Error('The first worksheet is empty.');
    const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null}); if(!matrix.length)throw new Error('The first worksheet is empty.');
    const headers=dedupeHeaders((matrix[0]||[]).map((v,i)=>String(v??'').trim()||`Unnamed ${i+1}`)); const rows=[];
    for(let r=1;r<matrix.length;r++){const arr=matrix[r]||[];if(arr.every(v=>v===null||v===''))continue;const obj={};headers.forEach((h,i)=>obj[h]=arr[i]??null);rows.push(obj);}
    const lat=secondaryColumnCandidates(headers,['geo latitude','latitude','lat','geo lat']); const lon=secondaryColumnCandidates(headers,['geo longitude','longitude','lon','long','geo lon']);
    if(!lat||!lon)throw new Error('Could not find latitude and longitude columns.');
    const valid=rows.filter(row=>{const a=toNumber(row[lat]),b=toNumber(row[lon]);return a!==null&&b!==null&&a>=40&&a<=90&&b>=-150&&b<=-40;});
    return {headers,rows:valid,lat,lon};
  }
  function clearSecondaryLocations(){
    state.secondaryLocations=[]; state.secondaryHeaders=[];state.secondaryLatColumn=null;state.secondaryLonColumn=null;state.secondaryCompetitorColumn=null;state.secondaryFileName=null;state.secondaryPopupConfig=null;state.secondaryHoverColumn=null;state.secondarySpatialIndex=null;state.secondarySpatialItems=[];state.secondaryEdits={};
    state.rxSiteAnalysis.model=null;state.rxSiteAnalysis.modelReady=false;state.rxSiteAnalysis.modelPromise=null;state.rxSiteAnalysis.subject=null;rxSiteStateReady(); setSecondaryVisible(false); if(el('secondaryFileInput'))el('secondaryFileInput').value=''; if(el('secondaryFileStatus'))el('secondaryFileStatus').textContent='No secondary locations loaded.';
    if(el('secondaryPopupConfigBtn'))el('secondaryPopupConfigBtn').disabled=true; if(el('secondaryHoverConfigBtn'))el('secondaryHoverConfigBtn').disabled=true; if(el('clearSecondaryBtn'))el('clearSecondaryBtn').disabled=true; if(el('secondaryVisibilityToggle')){el('secondaryVisibilityToggle').checked=false;el('secondaryVisibilityToggle').disabled=true;}
  }
  function afterSecondaryLoaded(file,parsed){
    state.secondaryFileName=file.name;state.secondaryHeaders=parsed.headers;state.secondaryLocations=parsed.rows;state.secondaryLatColumn=parsed.lat;state.secondaryLonColumn=parsed.lon;state.secondaryCompetitorColumn=secondaryColumnCandidates(parsed.headers,['competitor banner']);loadSecondaryConfigs();buildSecondarySpatialIndex();
    el('secondaryFileStatus').textContent=`Loaded • ${file.name} • ${state.secondaryLocations.length.toLocaleString()} locations`;
    el('secondaryPopupConfigBtn').disabled=false;el('secondaryHoverConfigBtn').disabled=false;el('clearSecondaryBtn').disabled=false;
    if(el('secondaryVisibilityToggle')){el('secondaryVisibilityToggle').disabled=false;el('secondaryVisibilityToggle').checked=true;state.secondaryVisible=true;}
    renderSecondaryCanvas();
    rxSiteMaybeBuild();
  }

  function afterWorkbookLoaded(file,parsed){
    
    state.fileName=file.name;state.primaryTabs=parsed.tabs||[{name:'Sheet 1',headers:parsed.headers,rows:parsed.rows,headerIndex:parsed.headerIndex}];const first=state.primaryTabs[0];state.headers=first.headers;state.rows=first.rows;const d=detectColumns(state.headers,state.rows);state.columns=d.columns;state.types=d.types;state.rows=state.rows.filter(isStoreRecord);first.rows=state.rows;state.filteredRows=[...state.rows];state.viewportSelectedRows=[];
    const c=state.columns;
    const hasSavedTickerConfig=(()=>{
      try{
        if(localStorage.getItem(TICKER_STORAGE_KEY))return true;
        return TICKER_OLD_STORAGE_KEYS.some(key=>!!localStorage.getItem(key));
      }catch(_){return false;}
    })();
    const tickerHasAnyConfiguredFormula=(state.tickerMetrics||[]).some(m=>String(m?.formula||'').trim());
    if(!hasSavedTickerConfig && !tickerHasAnyConfiguredFormula){
      state.tickerMetrics=tickerDefaultMetrics();
      saveTickerConfig();
    }
    const exactDefaultGroupNames=DEFAULT_GROUP_FIELDS;
    const exactHeaders=new Map(state.headers.map(h=>[norm(h),h]));
    state.groups=[...new Set(exactDefaultGroupNames.map(n=>exactHeaders.get(n)).filter(Boolean))];
    state.popupCensusCache.clear();state.filterCensusCache=new WeakMap();state.popupRenderToken++;state.popupTickerMetrics=[];state.popupTickerDraft=[];state.popupTickerPlaying=true;state.popupTickerIndex=0;clearInterval(state.popupTickerTimer);state.popupTickerTimer=null;state.popupQuartileValues={};state.popupQuartileDistributionCache.clear();state.subjectVirtualCache=new WeakMap();state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=defaultSelectedStoreFields();state.subjectTable=loadSubjectTableForHeaders(state.headers);state.subjects=subjectTableToMetrics(state.subjectTable);state.subjectConfigDraftTable=normalizeSubjectTable(state.subjectTable);loadPopupHeaderConfig();state.popupHeaderDraft=normalizePopupHeader(state.popupHeader);loadPopupConfig();loadPopupTickerConfig();state.popupConfigDraft=state.popupConfig.map(normalizePopupField);loadPopupTabConfigs();
    el('fileStatus').textContent=`Workbook loaded • ${file.name} • ${state.rows.length.toLocaleString()} stores • header row ${((parsed.tabs?.[0]?.headerIndex??parsed.headerIndex??0)+1)}`;el('clearFileBtn').disabled=false;el('tickerConfigBtn').disabled=false;el('subjectsBtn').disabled=false;el('groupsBtn').disabled=false;el('filterBtn').disabled=false;el('selectedStoresBtn').disabled=false;el('exportSelectedBtn').disabled=false;
    refreshConfigUI();rebuildFilterPassCache();rebuildMarkerAnimationCache();populateMarkerAnimationControls();rebuildMarkers();state.initialNationalView=true;state.mapReadyForViewport=false;state.selection={type:'national',name:'Canada',feature:null,provinceCode:null,radius:null};state.userMapInteraction=false;map.setView(CONFIG.canadaView.center, CONFIG.canadaView.zoom,{animate:false});setTimeout(()=>updateSelection(),0);
    const mapped=state.rows.filter(hasCoords).length;el('geoStatus').textContent=`Workbook loaded. ${mapped.toLocaleString()} of ${state.rows.length.toLocaleString()} stores have valid coordinates and are mapped.`;
    state.rxSiteAnalysis.model=null;state.rxSiteAnalysis.modelReady=false;state.rxSiteAnalysis.modelPromise=null;state.rxSiteAnalysis.subject=null;rxSiteMaybeBuild();
  }
  function clearFinancial(){state.rxSiteAnalysis.model=null;state.rxSiteAnalysis.modelReady=false;state.rxSiteAnalysis.modelPromise=null;state.rxSiteAnalysis.subject=null;rxSiteStateReady();closeStorePopup();closeSubjectDistribution();clearCensusShape();clearNavigationResult();state.rows=[];state.headers=[];state.types={};state.columns={};state.primaryTabs=[];state.popupTabConfigs=[];state.popupTabDrafts=[];state.popupTabSelected={tab:0,r:0,c:0};state.popupTabSelectionAnchor={tab:0,r:0,c:0};state.subjects=[];state.subjectTable=null;state.subjectConfigDraftTable=null;state.groups=[];state.distributionSubject=null;state.distributionBinKey=null;state.distributionSubject2=null;state.distributionBinKey2=null;state.distributionDialogTarget=1;state.selectedStoreColumns=[];state.subjectConfigDraftTable=null;state.popupHeader=null;state.popupHeaderDraft=null;state.popupConfig=[];state.popupConfigDraft=[];state.popupQuartileDraftChanged=false;state.popupTickerMetrics=[];state.popupTickerDraft=[];state.popupTickerPlaying=true;state.popupTickerIndex=0;clearInterval(state.popupTickerTimer);state.popupTickerTimer=null;state.popupQuartileValues={};state.popupQuartileDistributionCache.clear();state.popupCensusCache.clear();state.filterCensusCache=new WeakMap();state.popupRenderToken++;state.fileName=null;state.filteredRows=[];state.viewportSelectedRows=[];state.selectedRows=[];state.selectedStoreRow=null;state.markerCluster.clearLayers();state.markers=[];el('fileInput').value='';el('fileStatus').textContent='No financial file selected.';el('clearFileBtn').disabled=true;el('tickerConfigBtn').disabled=true;el('popupTickerConfigBtn').disabled=true;el('subjectsBtn').disabled=true;el('groupsBtn').disabled=true;el('filterBtn').disabled=true;el('selectedStoresBtn').disabled=true;el('exportSelectedBtn').disabled=true; if(el('exportSelectedDABtn'))el('exportSelectedDABtn').disabled=true; refreshConfigUI();updateFilterUI();updateSelection();}

  // ---------- UI wiring ----------
  el('secondaryFileInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;el('secondaryFileStatus').textContent='Reading secondary locations locally…';try{afterSecondaryLoaded(file,await readSecondaryLocationsFile(file));}catch(err){el('secondaryFileStatus').textContent=`Could not read secondary file: ${err.message}`;}});
  el('secondaryVisibilityToggle').addEventListener('change',e=>setSecondaryVisible(e.target.checked));
  el('secondaryPopupConfigBtn').addEventListener('click',openSecondaryPopupConfig);
  el('secondaryHoverConfigBtn').addEventListener('click',openSecondaryHoverConfig);
  el('clearSecondaryBtn').addEventListener('click',clearSecondaryLocations);
  el('secondaryPopupFields').addEventListener('click',e=>{const btn=e.target.closest('[data-secondary-popup-remove]');if(!btn)return;btn.parentElement?.remove();});
  document.addEventListener('input',e=>{const input=e.target.closest('[data-secondary-edit-field]');if(!input)return;const root=input.closest('[data-secondary-popup-index]');if(!root)return;secondarySaveEditsFromPopup(root);});

  el('secondaryPopupAddField').addEventListener('click',()=>{const list=el('secondaryPopupFields');const row=document.createElement('div');row.className='secondary-popup-field-row';const i=list.children.length+1;const opts=(state.secondaryHeaders||[]).map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');row.innerHTML=`<span class="field-index">${i}</span><select data-secondary-popup-field="1"><option value="">Choose field</option>${opts}</select><button type="button" class="secondary" data-secondary-popup-remove="${i-1}">×</button>`;list.appendChild(row);});
  el('secondaryPopupApply').addEventListener('click',e=>{e.preventDefault();applySecondaryPopupConfig();});
  el('secondaryPopupReset').addEventListener('click',e=>{e.preventDefault();resetSecondaryPopupConfig();});
  el('secondaryHoverApply').addEventListener('click',e=>{e.preventDefault();applySecondaryHoverConfig();});
  el('secondaryHoverReset').addEventListener('click',e=>{e.preventDefault();resetSecondaryHoverConfig();});
  el('fileInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;el('fileStatus').textContent='Reading workbook locally…';try{afterWorkbookLoaded(file,await readFinancialFile(file));}catch(err){el('fileStatus').textContent=`Could not read file: ${err.message}`;}});
  el('clearFileBtn').addEventListener('click',clearFinancial);
  el('storeJumpForm').addEventListener('submit',e=>{e.preventDefault();goToStoreNumber();});
  el('storeNumberInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();goToStoreNumber();}});
  el('searchForm').addEventListener('submit',e=>{e.preventDefault();geocodeAndRadius(el('searchInput').value);});
  rxSiteWire();
  function getLeafletScaleKm(){
    const node=document.querySelector('.leaflet-control-scale-line');
    const text=String(node?.textContent||'').trim().replace(/\s+/g,' ');
    const m=text.match(/([0-9]+(?:\.[0-9]+)?)\s*(km|m)\b/i);
    if(m){
      const value=Number(m[1]);
      if(Number.isFinite(value)) return m[2].toLowerCase()==='m' ? value/1000 : value;
    }
    // Fallback: estimate the km represented by a 100px span at the map centre.
    try{
      const center=map.getCenter();
      const p1=map.latLngToContainerPoint(center);
      const p2=L.point(p1.x+100,p1.y);
      const a=map.containerPointToLatLng(p1);
      const b=map.containerPointToLatLng(p2);
      const km=map.distance(a,b)/1000;
      return Number.isFinite(km)&&km>0 ? km : 1;
    }catch(_){ return 1; }
  }
  function defaultCircleRadiusMeters(){ return Math.max(10,getLeafletScaleKm()*1000); }
  function destinationAtDistance(start, bearingDeg, distanceKm){
    const radiusKm=6371.0088;
    const delta=distanceKm/radiusKm;
    const bearing=bearingDeg*Math.PI/180;
    const lat1=start.lat*Math.PI/180;
    const lon1=start.lng*Math.PI/180;
    const sinLat2=Math.sin(lat1)*Math.cos(delta)+Math.cos(lat1)*Math.sin(delta)*Math.cos(bearing);
    const lat2=Math.asin(Math.max(-1,Math.min(1,sinLat2)));
    const lon2=lon1+Math.atan2(Math.sin(bearing)*Math.sin(delta)*Math.cos(lat1),Math.cos(delta)-Math.sin(lat1)*Math.sin(lat2));
    return L.latLng(lat2*180/Math.PI,((lon2*180/Math.PI+540)%360)-180);
  }
  function defaultBoxBounds(center){
    const km=Math.max(0.01,getLeafletScaleKm());
    const halfKm=km/2;
    const north=destinationAtDistance(center,0,halfKm);
    const south=destinationAtDistance(center,180,halfKm);
    const east=destinationAtDistance(center,90,halfKm);
    const west=destinationAtDistance(center,270,halfKm);
    return L.latLngBounds(
      [south.lat,west.lng],
      [north.lat,east.lng]
    );
  }
  function circleRadiusLabelText(radiusMeters){
    const km=radiusMeters/1000;
    return `${km.toFixed(2)} km`;
  }
  function makeCircleRadiusLabel(latlng,radiusMeters){
    return L.marker(latlng,{interactive:false,zIndexOffset:1700,icon:L.divIcon({className:'circle-radius-label',html:`<span>${circleRadiusLabelText(radiusMeters)}</span>`,iconSize:[54,24],iconAnchor:[27,31]})});
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

  function rectangleDimensionsLabelText(bounds){
    const dims=getRectangleDimensionsKm(bounds);
    return `${dims.length.toFixed(2)} × ${dims.width.toFixed(2)} km`;
  }
  function makeRectangleDimensionsLabel(bounds){
    return L.marker(bounds.getSouthEast(),{interactive:false,zIndexOffset:1700,icon:L.divIcon({className:'rectangle-dimensions-label',html:`<span>${rectangleDimensionsLabelText(bounds)}</span>`,iconSize:[94,24],iconAnchor:[47,-14]})});
  }
  function updateRectangleLabel(){
    const rectangle=state.rectangleSelection?.rectangle;
    const label=state.rectangleSelection?.label;
    if(!rectangle||!label)return;
    const bounds=rectangle.getBounds();
    label.setLatLng(bounds.getSouthEast());
    const node=label.getElement()?.querySelector('span');
    if(node)node.textContent=rectangleDimensionsLabelText(bounds);
  }

  // ---------- Selection circle interaction ----------
  function updateHeaderCensusIndicator(){
    const wrap=el('headerCensusStatus');
    const icon=el('headerCensusIcon');
    const value=el('headerCensusShapeValue');
    if(!wrap||!icon||!value)return;
    const type=censusShapeType();
    if(type==='circle'){
      const km=state.circleSelection.circle.getRadius()/1000;
      icon.className='header-census-icon circle';
      value.textContent=`Circle ${km.toFixed(km<1?2:1)} km`;
      wrap.classList.remove('hidden');
      return;
    }
    if(type==='rectangle'){
      const dims=getRectangleDimensionsKm(state.rectangleSelection.rectangle.getBounds());
      icon.className='header-census-icon rectangle';
      value.textContent=`Box ${dims.length.toFixed(dims.length<10?2:1)} × ${dims.width.toFixed(dims.width<10?2:1)} km`;
      wrap.classList.remove('hidden');
      return;
    }
    if(censusGeoScopeType()){
      icon.className='header-census-icon rectangle';
      value.textContent=state.censusGeoSelection.code==='CA'?'Canada':state.censusGeoSelection.name;
      wrap.classList.remove('hidden');
      return;
    }
    icon.className='header-census-icon';
    value.textContent='—';
    wrap.classList.add('hidden');
  }

  function getRectangleDimensionsKm(bounds){
    const north=bounds.getNorth(),south=bounds.getSouth(),east=bounds.getEast(),west=bounds.getWest();
    const centerLat=(north+south)/2;
    const widthMeters=map.distance(L.latLng(centerLat,west),L.latLng(centerLat,east));
    const lengthMeters=map.distance(L.latLng(south,west),L.latLng(north,west));
    return {width:widthMeters/1000,length:lengthMeters/1000};
  }
  function formatCircleRadiusInputValue(radiusMeters){
    const km=radiusMeters/1000;
    return km.toFixed(2);
  }
  function applyCircleRadiusInput(){
    const input=el('censusShapeStatusValue');
    const circle=state.circleSelection?.circle;
    if(!input||!circle||censusShapeType()!=='circle')return;
    const km=Number(input.value);
    if(!Number.isFinite(km)||km<=0){
      input.value=formatCircleRadiusInputValue(circle.getRadius());
      return;
    }
    const radius=Math.max(10,km*1000);
    circle.setRadius(radius);
    updateCircleHandlePositions();
    updateCensusShapeStatus();
    invalidateCensusShapeCache();
    scheduleCensusQuery(null,'circle resized by input');
  }
  function circleMoveHandleLatLng(circle){
    const center=circle.getLatLng();
    const westEdge=circleEdgeLatLng(center,-circle.getRadius());
    try{
      const edgePoint=map.latLngToContainerPoint(westEdge);
      // Keep the crossed-arrows move handle clearly outside the circle stroke.
      // The 14px screen-space offset remains visually consistent at every zoom.
      return map.containerPointToLatLng(L.point(edgePoint.x-14,edgePoint.y));
    }catch(_){
      return circleEdgeLatLng(center,-(circle.getRadius()+18));
    }
  }
  function updateCircleHandlePositions(){
    const circle=state.circleSelection?.circle;
    if(!circle||state.circleEditHandles.length<3)return;
    const center=circle.getLatLng();
    const eastEdge=circleEdgeLatLng(center,circle.getRadius());
    const westMoveHandle=circleMoveHandleLatLng(circle);
    state.circleEditHandles[0].setLatLng(center);
    state.circleEditHandles[1].setLatLng(westMoveHandle);
    state.circleEditHandles[2].setLatLng(eastEdge);
    updateCircleLabel();
  }
  function updateCensusShapeStatus(){
    const indicator=el('censusShapeIndicator');
    const label=el('censusShapeStatusLabel');
    const sizeControl=el('censusShapeSizeControl');
    const value=el('censusShapeStatusValue');
    const unit=el('censusShapeStatusUnit');
    const clearBtn=el('clearCensusShapeBtn');
    const type=censusShapeType();
    if(!indicator||!label||!sizeControl||!value||!unit||!clearBtn)return;
    if(type==='circle'){
      sizeControl.classList.remove('hidden');
      const km=state.circleSelection.circle.getRadius()/1000;
      indicator.className='census-shape-indicator-circle';
      indicator.setAttribute('aria-label','Circle Census Query active');
      label.textContent='Circle';
      value.disabled=false;
      value.readOnly=false;
      value.value=formatCircleRadiusInputValue(state.circleSelection.circle.getRadius());
      value.setAttribute('aria-label','Circle radius in kilometres');
      value.title='Set circle radius in kilometres';
      unit.textContent='km radius';
      clearBtn.disabled=false;
    }else if(type==='rectangle'){
      sizeControl.classList.remove('hidden');
      const dims=getRectangleDimensionsKm(state.rectangleSelection.rectangle.getBounds());
      indicator.className='census-shape-indicator-rectangle';
      indicator.setAttribute('aria-label','Box Census Query active');
      label.textContent='Box';
      value.disabled=true;
      value.readOnly=true;
      value.value=`${dims.length.toFixed(2)} × ${dims.width.toFixed(2)}`;
      value.setAttribute('aria-label','Box dimensions in kilometres');
      value.title='Box dimensions';
      unit.textContent='km';
      clearBtn.disabled=false;
    }else if(censusGeoScopeType()){
      sizeControl.classList.add('hidden');
      indicator.className='census-shape-indicator-rectangle';
      indicator.setAttribute('aria-label','Census population geography active');
      label.textContent=state.censusGeoSelection.code==='CA'?'Canada':state.censusGeoSelection.name;
      value.disabled=true;
      value.readOnly=true;
      value.value='';
      value.title='';
      unit.textContent='';
      clearBtn.disabled=false;
    }else{
      sizeControl.classList.add('hidden');
      indicator.className='census-shape-indicator-off';
      indicator.setAttribute('aria-label','No Census Query shape active');
      label.textContent='No shape';
      value.disabled=true;
      value.readOnly=true;
      value.value='';
      value.title='';
      unit.textContent='';
      clearBtn.disabled=true;
    }
    updateHeaderCensusIndicator();
  }
  function createCensusEditHandle(latlng,{className,zIndexOffset,draggable=true,interactive=true}={}){
    return L.marker(latlng,{
      pane:draggable?'censusHandlePane':'censusCenterPane',
      draggable,
      interactive,
      zIndexOffset,
      icon:L.divIcon({className,html:'<span aria-hidden="true"></span>',iconSize:[20,20],iconAnchor:[10,10]})
    }).addTo(map);
  }
  function invalidateCensusShapeCache(){
    state.daProvinceCacheKey=null;
    state.daProvinceCache=null;
  }
  function removeCircleHandles(){ state.circleEditHandles.forEach(h=>map.removeLayer(h)); state.circleEditHandles=[]; }
  function removeRectangleHandles(){ state.rectangleEditHandles.forEach(h=>map.removeLayer(h)); state.rectangleEditHandles=[]; }
  function removeAllCensusHandles(){removeCircleHandles();removeRectangleHandles();}

  function updateRectangleHandles(){
    const rectangle=state.rectangleSelection?.rectangle;
    if(!rectangle||state.rectangleEditHandles.length<2)return;
    const b=rectangle.getBounds();
    state.rectangleEditHandles[0].setLatLng(b.getCenter());
    if(state.rectangleEditHandles[1]) state.rectangleEditHandles[1].setLatLng(b.getNorthEast());
    if(state.rectangleEditHandles[2]) state.rectangleEditHandles[2].setLatLng(b.getSouthEast());
    updateRectangleLabel();
  }
  function showCircleHandles(){
    removeCircleHandles();
    const circle=state.circleSelection?.circle;if(!circle)return;
    const center=circle.getLatLng();
    const radius=circle.getRadius();
    const westMoveHandle=circleMoveHandleLatLng(circle);
    const eastEdge=circleEdgeLatLng(center,radius);
    const centerHandle=createCensusEditHandle(center,{className:'circle-edit-handle circle-center-handle',zIndexOffset:0,draggable:false,interactive:false});
    const moveHandle=createCensusEditHandle(westMoveHandle,{className:'circle-edit-handle circle-move-handle rectangle-move-handle',zIndexOffset:1801});
    const sizeHandle=createCensusEditHandle(eastEdge,{className:'circle-edit-handle circle-size-handle',zIndexOffset:1802});
    let circleMoveDragStartCenter=null;
    let circleMoveDragStartHandle=null;
    moveHandle.on('dragstart',()=>{
      if(!state.circleSelection)return;
      beginCensusShapeHandleDrag('circle moved');
      circleMoveDragStartCenter=circle.getLatLng();
      circleMoveDragStartHandle=moveHandle.getLatLng();
    });
    moveHandle.on('drag',e=>{
      if(!state.circleSelection||!circleMoveDragStartCenter||!circleMoveDragStartHandle)return;
      const startHandlePoint=map.latLngToContainerPoint(circleMoveDragStartHandle);
      const nextPoint=map.latLngToContainerPoint(e.target.getLatLng());
      const nextCenterPoint=map.latLngToContainerPoint(circleMoveDragStartCenter);
      const dx=nextPoint.x-startHandlePoint.x;
      const dy=nextPoint.y-startHandlePoint.y;
      const nextCenter=map.containerPointToLatLng(L.point(nextCenterPoint.x+dx,nextCenterPoint.y+dy));
      circle.setLatLng(nextCenter);
      updateCircleHandlePositions();
      updateCensusShapeStatus();
      invalidateCensusShapeCache();
    });
    moveHandle.on('dragend',()=>{
      circleMoveDragStartCenter=null;
      circleMoveDragStartHandle=null;
      endCensusShapeHandleDrag('circle moved');
    });
    sizeHandle.on('dragstart',()=>{
      if(!state.circleSelection)return;
      beginCensusShapeHandleDrag('circle resized by handle');
    });
    sizeHandle.on('drag',e=>{
      if(!state.circleSelection)return;
      const centerNow=circle.getLatLng();
      const nextRadius=Math.max(10,map.distance(centerNow,e.target.getLatLng()));
      circle.setRadius(nextRadius);
      updateCircleHandlePositions();
      updateCensusShapeStatus();
      invalidateCensusShapeCache();
    });
    sizeHandle.on('dragend',()=>{
      endCensusShapeHandleDrag('circle resized by handle');
    });
    state.circleEditHandles=[centerHandle,moveHandle,sizeHandle];
  }
  function showRectangleHandles(){
    removeRectangleHandles();
    const rectangle=state.rectangleSelection?.rectangle;if(!rectangle)return;
    const b0=rectangle.getBounds();
    const centerHandle=createCensusEditHandle(b0.getCenter(),{className:'rectangle-edit-handle rectangle-center-handle',zIndexOffset:0,draggable:false,interactive:false});
    const moveStart=b0.getNorthEast();
    const moveHandle=createCensusEditHandle(moveStart,{className:'rectangle-edit-handle rectangle-move-handle',zIndexOffset:1801});
    const cornerHandle=createCensusEditHandle(b0.getSouthEast(),{className:'rectangle-edit-handle rectangle-corner-handle',zIndexOffset:1802});
    moveHandle.on('dragstart',()=>{
      if(!state.rectangleSelection)return;
      beginCensusShapeHandleDrag('rectangle moved');
    });
    moveHandle.on('drag',e=>{
      if(!state.rectangleSelection)return;
      const current=rectangle.getBounds();
      const currentPoint=map.latLngToContainerPoint(current.getNorthEast());
      const nextPoint=map.latLngToContainerPoint(e.target.getLatLng());
      const dLatLng=map.containerPointToLatLng(L.point(currentPoint.x+(nextPoint.x-currentPoint.x),currentPoint.y+(nextPoint.y-currentPoint.y)));
      const dLat=dLatLng.lat-current.getNorthEast().lat;
      const dLng=dLatLng.lng-current.getNorthEast().lng;
      const nb=L.latLngBounds(
        [current.getSouth()+dLat,current.getWest()+dLng],
        [current.getNorth()+dLat,current.getEast()+dLng]
      );
      rectangle.setBounds(nb);
      centerHandle.setLatLng(nb.getCenter());
      moveHandle.setLatLng(nb.getNorthEast());
      cornerHandle.setLatLng(nb.getSouthEast());
      updateCensusShapeStatus();
      invalidateCensusShapeCache();
    });
    moveHandle.on('dragend',()=>{
      endCensusShapeHandleDrag('rectangle moved');
    });
    cornerHandle.on('dragstart',()=>{ beginCensusShapeHandleDrag('rectangle resized'); });
    cornerHandle.on('drag',e=>{
      if(!state.rectangleSelection)return;
      const current=rectangle.getBounds();
      const fixedNW=current.getNorthWest();
      const pointer=e.target.getLatLng();
      const minLatDelta=Math.max(0.0001, Math.abs(current.getNorth()-current.getSouth())*0.001);
      const minLngDelta=Math.max(0.0001, Math.abs(current.getEast()-current.getWest())*0.001);
      const south=Math.min(fixedNW.lat-minLatDelta,pointer.lat);
      const east=Math.max(fixedNW.lng+minLngDelta,pointer.lng);
      const nb=L.latLngBounds(fixedNW,L.latLng(south,east));
      rectangle.setBounds(nb);
      moveHandle.setLatLng(nb.getNorthEast());
      cornerHandle.setLatLng(nb.getSouthEast());
      centerHandle.setLatLng(nb.getCenter());
      updateCensusShapeStatus();
      updateRectangleLabel();
    });
    cornerHandle.on('dragend',()=>{
      if(!state.rectangleSelection)return;
      const nb=rectangle.getBounds();
      cornerHandle.setLatLng(nb.getSouthEast());
      centerHandle.setLatLng(nb.getCenter());
      updateCensusShapeStatus();
      updateRectangleLabel();
      invalidateCensusShapeCache();
      endCensusShapeHandleDrag('rectangle resized');
    });
    state.rectangleEditHandles=[centerHandle,moveHandle,cornerHandle];
  }
  function showActiveCensusShapeHandles(){ if(censusShapeType()==='circle')showCircleHandles(); else if(censusShapeType()==='rectangle')showRectangleHandles(); }
  function exitCensusDrawMode(){
    state.circleDrawMode=false;state.rectangleDrawMode=false;state.censusShapeDrawing=null;state.circleDrawing=null;
    state.markerClickSuppressed=false;map.getContainer().style.cursor='';removeAllCensusHandles();
    el('drawCircleBtn').querySelector('span:last-child').textContent='Circle';
    el('drawRectangleBtn').querySelector('span:last-child').textContent='Box';
  }
  function clearCensusShape({keepDrawingMode=false}={}){
    CENSUS_DEBUG.log('scope:clear',{hadShape:!!censusShapeType(),hadGeo:!!censusGeoScopeType()});
    removeAllCensusHandles();
    if(state.daRefreshTimer){clearTimeout(state.daRefreshTimer);state.daRefreshTimer=null;}
    state.censusRequestId++;
    if(state.circleSelection?.label)map.removeLayer(state.circleSelection.label);
    if(state.circleSelection?.circle)map.removeLayer(state.circleSelection.circle);
    if(state.rectangleSelection?.label)map.removeLayer(state.rectangleSelection.label);
    if(state.rectangleSelection?.rectangle)map.removeLayer(state.rectangleSelection.rectangle);
    state.circleSelection=null;state.rectangleSelection=null;state.circleDrawing=null;state.censusShapeDrawing=null;
    state.daProvinceCacheKey=null;state.daProvinceCache=null;
    clearCensusGeoSelection();
    // The shape is only the spatial metric scope. Filters and viewport-driven
    // highlights remain active when the shape is removed.
    clearDaOverlay();
    updateCensusShapeStatus();
    if(!keepDrawingMode)exitCensusDrawMode();
    resetCensusPopulationSummary();
    state.daSelectionResult=null;
    setCensusScope('viewport',{reason:'Census shape cleared',generation:state.censusScopeGeneration});
    if(el('censusDaList'))el('censusDaList').innerHTML='<div class="empty-message">Draw a Census Query circle or rectangle to see qualifying DAs.</div>';
    setDaTestStatus('Draw a Census Query circle or rectangle to calculate Census data.');
    if(state.rows.length) updateSelection();
  }
  function clearCensusShapeOnly({keepGeoScope=false}={}){
    CENSUS_DEBUG.log('shape:clearOnly',{hadShape:!!censusShapeType(),keepGeoScope});
    removeAllCensusHandles();
    if(state.daRefreshTimer){clearTimeout(state.daRefreshTimer);state.daRefreshTimer=null;}
    state.censusRequestId++;
    if(state.circleSelection?.label)map.removeLayer(state.circleSelection.label);
    if(state.circleSelection?.circle)map.removeLayer(state.circleSelection.circle);
    if(state.rectangleSelection?.label)map.removeLayer(state.rectangleSelection.label);
    if(state.rectangleSelection?.rectangle)map.removeLayer(state.rectangleSelection.rectangle);
    state.circleSelection=null;state.rectangleSelection=null;state.circleDrawing=null;state.censusShapeDrawing=null;
    state.daProvinceCacheKey=null;state.daProvinceCache=null;
    clearDaOverlay();
    state.daSelectionResult=null;
    updateCensusShapeStatus();
    if(el('censusDaList'))el('censusDaList').innerHTML='<div class="empty-message">Draw a Census Query circle or rectangle to see qualifying DAs.</div>';
    if(!keepGeoScope) clearCensusGeoSelection();
  }

  function clearCircle(){clearCensusShape();}
  function createOrReplaceCircle(center,radiusMeters,reason='circle draw'){
    CENSUS_DEBUG.log('circle:create:start',{lat:center.lat,lng:center.lng,radiusMeters,reason});
    clearCensusShape();
    state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger=reason;
    const radius=Math.max(10,radiusMeters);
    const circle=L.circle(center,{pane:'selectionCirclePane',radius,color:'#d33e46',weight:3,opacity:1,fillOpacity:0,interactive:true,lineCap:'round',lineJoin:'round'}).addTo(map);
    circle.on('click',e=>{
      const secondaryHit=state.secondaryVisible?secondaryHitTest(e.latlng,11):null;
      if(secondaryHit){
        L.DomEvent.stopPropagation(e);
        showSecondaryPopup(secondaryHit);
        return;
      }
      L.DomEvent.stopPropagation(e);showCircleHandles();
    });
    const label=makeCircleRadiusLabel(circleEdgeLatLng(center,radius),radius).addTo(map);
    state.circleSelection={circle,label};
    setCensusScope('circle',{reason, generation:state.censusScopeGeneration});
    updateCensusShapeStatus();showCircleHandles();
    requestAnimationFrame(()=>{ if(state.circleSelection?.circle===circle) showCircleHandles(); });
    CENSUS_DEBUG.log('circle:create:handles',{count:state.circleEditHandles.length});
    scheduleCensusQuery(null,reason);
  }
  function createOrReplaceRectangle(bounds,reason='rectangle draw'){
    clearCensusShape();
    state.initialNationalView=false;state.mapReadyForViewport=true;state.daActivationTrigger=reason;
    const rectangle=L.rectangle(bounds,{pane:'selectionCirclePane',color:'#d33e46',weight:3,opacity:1,fillOpacity:0,interactive:true,lineJoin:'round'}).addTo(map);
    rectangle.on('click',e=>{
      const secondaryHit=state.secondaryVisible?secondaryHitTest(e.latlng,11):null;
      if(secondaryHit){
        L.DomEvent.stopPropagation(e);
        showSecondaryPopup(secondaryHit);
        return;
      }
      L.DomEvent.stopPropagation(e);showRectangleHandles();
    });
    const label=makeRectangleDimensionsLabel(bounds).addTo(map);
    state.rectangleSelection={rectangle,label};
    setCensusScope('box',{reason, generation:state.censusScopeGeneration});
    updateCensusShapeStatus();showRectangleHandles();
    scheduleCensusQuery(null,reason);
  }
  function enterCircleDrawMode(){
    if(censusShapeType()||censusGeoScopeType()) clearCensusShape();
    exitCensusDrawMode();state.circleDrawMode=true;state.markerClickSuppressed=true;map.getContainer().style.cursor='crosshair';
    el('drawCircleBtn').querySelector('span:last-child').textContent='Click map';removeAllCensusHandles();
  }
  function enterRectangleDrawMode(){
    if(censusShapeType()||censusGeoScopeType()) clearCensusShape();
    exitCensusDrawMode();state.rectangleDrawMode=true;state.markerClickSuppressed=true;map.getContainer().style.cursor='crosshair';
    el('drawRectangleBtn').querySelector('span:last-child').textContent='Click map';removeAllCensusHandles();
  }
  el('drawCircleBtn').addEventListener('click',()=>{if(state.circleDrawMode){exitCensusDrawMode();return;}enterCircleDrawMode();});
  el('drawRectangleBtn').addEventListener('click',()=>{if(state.rectangleDrawMode){exitCensusDrawMode();return;}enterRectangleDrawMode();});
  el('clearCensusShapeBtn').addEventListener('click',()=>{clearCensusShape();});
  el('censusShapeStatusValue')?.addEventListener('change',applyCircleRadiusInput);
  el('censusShapeStatusValue')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applyCircleRadiusInput();e.target.blur();}});
  el('censusGeoSelect')?.addEventListener('change',e=>{
    const scope=String(e.target.value||'');
    CENSUS_DEBUG.log('geoScope:change',{scope});
    Promise.resolve(setCensusGeoScope(scope)).catch(err=>{
      console.error('[CENSUS GEO] scope selection failed',err);
      setDaTestStatus(`Census geography selection failed: ${err.message||err}`);
    });
  });

  map.on('mousemove',e=>{
    if(!state.secondaryVisible){
      if(state.secondaryHoverRow){hideUnifiedHover(secondaryHoverOwner);state.secondaryHoverRow=null;}
      if(!state.circleDrawMode&&!state.rectangleDrawMode)map.getContainer().style.cursor='';
      return;
    }
    const hit=secondaryHitTest(e.latlng,10);
    if(hit){
      showUnifiedHover(secondaryHoverOwner,L.latLng(hit.lat,hit.lng),secondaryHoverHtml(hit.row));
      state.secondaryHoverRow=hit;
      if(!state.circleDrawMode&&!state.rectangleDrawMode)map.getContainer().style.cursor='pointer';
    }else{
      if(state.secondaryHoverRow){hideUnifiedHover(secondaryHoverOwner);state.secondaryHoverRow=null;}
      if(!state.circleDrawMode&&!state.rectangleDrawMode)map.getContainer().style.cursor='';
    }
  });
  map.on('click',e=>{
    const hit=secondaryHitTest(e.latlng,11);
    if(hit){
      if((state.circleDrawMode||state.rectangleDrawMode)&&!state.censusShapeDrawing){
        const mode=state.circleDrawMode?'circle':'rectangle';
        exitCensusDrawMode();
        if(mode==='circle') createOrReplaceCircle(L.latLng(hit.lat,hit.lng),defaultCircleRadiusMeters(),'circle centered on secondary location');
        else createOrReplaceRectangle(defaultBoxBounds(L.latLng(hit.lat,hit.lng)),'box centered on secondary location');
        if(e.originalEvent)L.DomEvent.stopPropagation(e.originalEvent);
        return;
      }
      showSecondaryPopup(hit);
      if(e.originalEvent)L.DomEvent.stopPropagation(e.originalEvent);
      return;
    }
  });
  map.on('click',e=>{
    if((!state.circleDrawMode&&!state.rectangleDrawMode)||state.censusShapeDrawing)return;
    try{
      const center=e.latlng;
      const mode=state.circleDrawMode?'circle':'rectangle';
      exitCensusDrawMode();
      if(mode==='circle'){
        createOrReplaceCircle(center,defaultCircleRadiusMeters(),'circle default from map scale');
      }else{
        createOrReplaceRectangle(defaultBoxBounds(center),'box default from map scale');
      }
    }catch(err){
      console.error('Census Query default-shape creation failed:',err);
      exitCensusDrawMode();
    }
  });

  map.on('click',e=>{
    if(state.circleDrawMode)return;
    if(state.circleSelection && e.originalEvent?.target===state.circleSelection.circle?._path)return;
    unspiderfyMarkers();
    if(state.openPopupMarker)closeStorePopup();
  });
  map.on('dragstart',()=>{
    hideUnifiedHover();
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  map.on('zoomstart',()=>{
    hideUnifiedHover();
    unspiderfyMarkers();
    if(state.programmaticMoveDepth===0) state.userMapInteraction = true;
  });
  function clearOffscreenTransientVisuals(){
    const bounds=map.getBounds();
    // Navigation/result highlights are viewport-bound and should not linger once
    // the user pans/zooms them completely off-screen. Census shape DA overlays
    // are intentionally excluded: an active Census shape owns those results.
    if(state.navigationResultLatLng && !bounds.contains(state.navigationResultLatLng)){
      clearNavigationResult();
    }
    if(!censusShapeType() && state.daLayer){
      clearDaOverlay();
      state.daSelectionResult=null;
    }
  }

  map.on('moveend',()=>{
    if(state.circleSelection?.circle && state.circleEditHandles.length){
      updateCircleHandlePositions();
    }
    if(state.rectangleSelection?.rectangle){
      updateRectangleHandles();
      updateRectangleLabel();
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
    clearOffscreenTransientVisuals();
    requestAnimationFrame(()=>showActiveCensusShapeHandles());
    updateHeaderGeography();
    state.viewportSelectedRows=getViewportSelectedRows();
    if(censusScopeType()==='viewport') updateSelection();
    else { updateGroups(); updateDistribution(); updateSelectionState(); refreshMarkerStyles(); }
    refreshMunicipalityLabels();
    // Viewport movement is navigation-only for Census DA selection; ordinary store selection
    // can still follow the viewport when no Census shape is active.
  });
  map.on('zoomend',()=>{ refreshMunicipalityLabels(); hideUnifiedHover(); });
  window.addEventListener('resize',()=>{map.invalidateSize(false);updateSelection();refreshMunicipalityLabels();});
  window.addEventListener('resize',()=>{if(state.subjectDistributionPopup?.layer.classList.contains('open'))positionSubjectDistributionPopup(state.subjectDistributionPopup.card);});
  window.addEventListener('scroll',()=>{if(state.subjectDistributionPopup?.layer.classList.contains('open'))positionSubjectDistributionPopup(state.subjectDistributionPopup.card);},true);

  el('selectedStoresBtn').addEventListener('click',()=>{renderSelectedStoresConfig(el('selectedStoresSearch').value);el('selectedStoresDialog').showModal();});
  el('selectedStoresSearch').addEventListener('input',e=>renderSelectedStoresConfig(e.target.value));
  el('selectedStoresClear').addEventListener('click',()=>{renderSelectedStoresConfig('');});
  el('selectedStoresApply').addEventListener('click',()=>{state.selectedStoreColumns=selectedStoreCheckedValues();refreshConfigUI();updateSelectedStoresList();});
  el('exportSelectedBtn').addEventListener('click',exportSelectedStores);
  el('exportSelectedDABtn').addEventListener('click',exportSelectedDAs);
  el('groupsBtn').addEventListener('click',()=>{renderChecklist('groupsList',state.groups,'group',el('groupSearch').value);el('groupsDialog').showModal();});

  el('groupSearch').addEventListener('input',e=>renderChecklist('groupsList',checkedValues('groupsList'),'group',e.target.value));

  el('groupsClear').addEventListener('click',()=>renderChecklist('groupsList',[],'group',el('groupSearch').value));

  el('groupsApply').addEventListener('click',()=>{state.groups=[...new Set(checkedValues('groupsList'))];state.distributionBinKey=null;state.distributionBinKey2=null;state.selectedGroupKey=null;state.selectedStoreRow=null;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('distributionBtn')?.addEventListener('click',()=>{state.distributionDialogTarget=1;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionBtn2')?.addEventListener('click',()=>{state.distributionDialogTarget=2;renderDistributionList(el('distributionSearch').value);el('distributionDialog').showModal();});
  el('distributionSearch').addEventListener('input',e=>renderDistributionList(e.target.value));
  el('distributionClear').addEventListener('click',()=>{if(state.distributionDialogTarget===2){state.distributionSubject2=null;state.distributionBinKey2=null;}else{state.distributionSubject=null;state.distributionBinKey=null;}renderDistributionList(el('distributionSearch').value);updateDistribution();refreshConfigUI();refreshMarkerStyles();});
  el('distributionApply').addEventListener('click',()=>{const checked=el('distributionList').querySelector('input[type=radio]:checked');if(state.distributionDialogTarget===2){state.distributionSubject2=checked?checked.value:null;state.distributionBinKey2=null;}else{state.distributionSubject=checked?checked.value:null;state.distributionBinKey=null;}state.selectedGroupKey=null;state.selectedStoreRow=null;state.distributionBinKey=state.distributionDialogTarget===2?null:state.distributionBinKey;state.distributionBinKey2=state.distributionDialogTarget===1?null:state.distributionBinKey2;refreshConfigUI();updateGroups();updateDistribution();refreshMarkerStyles();});
  el('filterBtn').addEventListener('click',()=>openFilterDialog());
  el('filterDiagnosticToggle').addEventListener('click',toggleFilterDiagnostic);
  el('clearFiltersBtn').addEventListener('click',()=>{state.filters=[];state.filterDraft=[];rebuildFilterPassCache();state.filteredRows=[...state.rows];redrawAfterFilterChange();updateSelection();updateFilterUI();});
  el('addFilterBtn').addEventListener('click',()=>{state.filterDraft.push(filterDraftBlank());renderFilterRows();});
  el('clearAllFilters').addEventListener('click',()=>{state.filterDraft=[filterDraftBlank(),filterDraftBlank(),filterDraftBlank()];const errorBox=el('filterError');if(errorBox)errorBox.textContent='';renderFilterRows();});
  el('applyFiltersBtn').addEventListener('click',async e=>{e.preventDefault();await applyFilters();});
  el('filterPickerSelectAll').addEventListener('click',()=>{const list=el('filterValuePickerList');const checks=[...list.querySelectorAll('.filter-picker-check')];const all=checks.length&&checks.every(c=>c.checked);checks.forEach(c=>c.checked=!all);el('filterPickerSelectAll').textContent=all?'Select all':'Clear all';});
  el('filterPickerApply').addEventListener('click',e=>{e.preventDefault();applyFilterValuePicker();el('filterValueDialog').close();});
  el('filterPickerCancel').addEventListener('click',e=>{e.preventDefault();state.filterValuePickerIndex=null;el('filterValueDialog').close();});

  function setLeftPanelCollapsed(collapsed){
    state.leftPanelCollapsed=!!collapsed;
    document.body.classList.toggle('left-panel-collapsed',state.leftPanelCollapsed);
    const toggle=el('leftPanelToggle');
    if(toggle){
      toggle.setAttribute('aria-expanded',String(!state.leftPanelCollapsed));
      toggle.setAttribute('aria-label',state.leftPanelCollapsed?'Expand controls':'Collapse controls');
      const icon=toggle.querySelector('span');
      if(icon)icon.textContent=state.leftPanelCollapsed?'›':'‹';
    }
    requestAnimationFrame(()=>map.invalidateSize(false));
  }

  el('leftPanelToggle').addEventListener('click',()=>setLeftPanelCollapsed(!state.leftPanelCollapsed));
  wireCensusAmenityCategoryButtons();
  el('censusThreshold').addEventListener('change',()=>{state.filterCensusCache=new WeakMap();state.popupQuartileDistributionCache.clear();state.popupCensusCache.clear();scheduleCensusQuery(null,'threshold change');});
  el('censusDelay')?.addEventListener('change',()=>{ state.daDelayMs=getDaDelayMs(); });
  el('censusDelay')?.addEventListener('input',()=>{ state.daDelayMs=getDaDelayMs(); });
  el('censusThreshold').addEventListener('input',()=>{ state.filterCensusCache=new WeakMap(); state.popupQuartileDistributionCache.clear(); state.popupCensusCache.clear(); clearTimeout(state.daThresholdTimer); state.daThresholdTimer=setTimeout(()=>scheduleCensusQuery(0,'threshold change'),250); });
  el('showSelectedDAs')?.addEventListener('change',(event)=>{
    state.showDaOverlay = !!event.target.checked;
    clearDaOverlay();
    const canRender = map.getZoom() >= CONFIG.daMinRenderZoom;
    if (state.showDaOverlay && canRender && state.daSelectionResult?.selected?.length) {
      const features = state.daSelectionResult.selected.map(item => item.feature);
      state.daLayer = L.geoJSON(turf.featureCollection(features), {pane:'daSelectionPane', interactive:false, style:daStyle}).addTo(map);
    }
  });

  if(typeof L==='undefined')el('geoStatus').textContent='Mapping library did not load. Refresh the page and try again.';
  if(typeof XLSX==='undefined')el('fileStatus').textContent='Excel reader library did not load. Refresh the page and try again.';
  if(typeof turf==='undefined')el('censusNote').textContent='Geospatial calculation library did not load. Refresh the page and try again.';
  if(typeof RBush==='undefined')el('censusNote').textContent='DA spatial-index library did not load. Refresh the page and try again.';
  state.popupAmenityRadius=loadPopupAmenityRadius();
  loadMarkerAnimationConfig();
  populateMarkerAnimationControls();
  wireMarkerAnimationControls();
  setupTicker();
  loadHelpConfig();
  el('helpConfigBtn').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openHelpConfig();});
  el('helpApply').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();applyHelpConfig();});
  el('helpReset').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();state.helpConfig={...HELP_DEFAULTS};renderHelpConfig();});
  applyAllHelpTooltips();
  loadHeaderCsdLookup();
  // Load the user's saved marker sizes BEFORE the icon manifest is allowed to merge/save.
  // The manifest may add new icon types, but must never overwrite existing user settings.
  loadMarkerConfig();
  loadSecondaryMarkerIconManifest().finally(()=>{
    initMarkerConfig(true);
    updateSelection();
    updateHeaderGeography();
  });
})();

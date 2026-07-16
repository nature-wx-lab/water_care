#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
const targetUrl = process.argv.find(value => value.startsWith('http')) || 'http://127.0.0.1:8787/';
const allowStale = process.argv.includes('--allow-stale');
const requireStale = process.argv.includes('--require-stale');
const launchOptions = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (requireStale) {
  await page.addInitScript(fixedNow => { Date.now = () => fixedNow; }, Date.parse('2100-01-01T00:00:00Z'));
}
const consoleProblems = [];
const failedResponses = [];
const dataRequests = [];
const allRequests = [];
page.on('request', request => allRequests.push(request.url()));
page.on('console', message => {
  const text = message.text();
  // Leaflet may request GSI tiles that intentionally return 404 outside the
  // layer's coverage. Response handling below still catches missing app/data
  // assets, so suppress only the browser's URL-less resource-load message.
  if (['error', 'warning'].includes(message.type()) && !text.startsWith('Failed to load resource:')) {
    consoleProblems.push(`${message.type()}: ${text}`);
  }
});
page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));
page.on('response', response => {
  const url = response.url();
  if (url.includes('/data/hourly/') || url.includes('/data/overview/') || url.includes('/data/daily/')) dataRequests.push(url);
  const allowedEmptyGsiTile = response.status() === 404
    && new URL(url).hostname === 'cyberjapandata.gsi.go.jp'
    && /\/xyz\/(?:blank|pale|hillshademap)\//.test(url);
  if (response.status() >= 400 && !url.endsWith('/favicon.ico') && !allowedEmptyGsiTile) {
    failedResponses.push(`${response.status()} ${url}`);
  }
});

const result = { url: targetUrl, checks: {} };
const rootrotLabels = ['心配なし', '湿り気味', '湿りが続いている', '根腐れ注意'];
const controlOptions = {
  plant_type: ['moist_lover', 'foliage', 'dry'],
  root_zone: ['small', 'standard', 'large'],
  watering_policy: ['moist', 'standard', 'dry'],
  rain_exposure: ['full', 'eaves', 'inside'],
  sun_exposure: ['sun', 'half', 'shade', 'dark'],
  soil_drying: ['fast', 'standard', 'slow'],
};
const controlElements = {
  plant_type: 'mapPlant',
  root_zone: 'mapSize',
  watering_policy: 'mapDrying',
  rain_exposure: 'mapRain',
  sun_exposure: 'mapSun',
  soil_drying: 'mapSpeed',
};
const observedOptions = ['', 'rain1h', 'rain3h', 'rain6h', 'rain12h', 'rain24h', 'rain48h', 'rain72h', 'rain24hDiff', 'weather'];
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameMembers = (left, right) => sameJson([...left].sort(), [...right].sort());

async function canvasState(selector) {
  return page.$eval(selector, canvas => {
    const reader = document.createElement('canvas');
    reader.width = canvas.width;
    reader.height = canvas.height;
    const context = reader.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, reader.width, reader.height).data;
    const stride = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4);
    let colored = 0;
    let maxAlpha = 0;
    for (let index = 3; index < pixels.length; index += stride) {
      maxAlpha = Math.max(maxAlpha, pixels[index]);
      if (pixels[index] > 0) colored += 1;
    }
    return { width: canvas.width, height: canvas.height, colored, maxAlpha };
  });
}

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.datasetId), null, { timeout: 120000 });
  await page.waitForFunction(expectStale => document.querySelector('#mapContextLayer')?.textContent === 'うるおい残量MAP'
    && ['true', 'false'].includes(document.querySelector('#mapInfoBar')?.dataset.stale)
    && (!expectStale || (document.querySelector('#mapContextHealth')?.textContent === '更新遅延'
      && document.querySelector('#mapStatus')?.textContent.includes('更新されていません'))), requireStale, { timeout: 120000 });
  await page.waitForFunction(() => referenceLandLayer && map.hasLayer(referenceLandLayer), null, { timeout: 120000 });
  result.checks.initial = await page.evaluate(() => {
    const assumption = document.querySelector('#modelAssumption');
    const assumptionRect = assumption?.getBoundingClientRect();
    const timelineRect = document.querySelector('#timeline')?.getBoundingClientRect();
    const mapStageRect = document.querySelector('.map-stage')?.getBoundingClientRect();
    const mapRect = document.querySelector('#map')?.getBoundingClientRect();
    const infoBar = document.querySelector('#mapInfoBar');
    const infoRect = infoBar?.getBoundingClientRect();
    const subjectRect = document.querySelector('.map-context-subject')?.getBoundingClientRect();
    const timeRect = document.querySelector('.map-context-time')?.getBoundingClientRect();
    const legendRect = document.querySelector('#legendBox')?.getBoundingClientRect();
    const legendScaleRect = document.querySelector('#legendScale')?.getBoundingClientRect();
    const legendBarRect = document.querySelector('#legendBar')?.getBoundingClientRect();
    const legendTopLabelRect = document.querySelector('.legend-end-label-top')?.getBoundingClientRect();
    const legendBottomLabelRect = document.querySelector('.legend-end-label-bottom')?.getBoundingClientRect();
    const subjectStyle = document.querySelector('.map-context-subject')
      ? getComputedStyle(document.querySelector('.map-context-subject')) : null;
    const controlRects = [...document.querySelectorAll('.leaflet-top.leaflet-left .leaflet-control')]
      .map(control => control.getBoundingClientRect());
    const sampleGrid = analysis.publicLandGridIds.find(gridId => map.getBounds().contains([
      analysis.points[gridId * 2], analysis.points[gridId * 2 + 1],
    ]));
    const sampleCell = Number.isInteger(sampleGrid)
      ? gridCellRect(analysis.points[sampleGrid * 2], analysis.points[sampleGrid * 2 + 1])
      : null;
    const target = selectedTarget();
    const targetDate = new Date(target?.validtime_jst);
    const expectedDate = targetDate.toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    });
    const expectedClock = targetDate.toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const layerText = document.querySelector('#mapContextLayer')?.textContent || '';
    const modeText = document.querySelector('#mapContextMode')?.textContent || '';
    const sourceText = document.querySelector('#mapContextSource')?.textContent || '';
    const visibleDate = document.querySelector('#mapContextDate')?.textContent || '';
    const visibleClock = document.querySelector('#mapContextClock')?.textContent || '';
    const homeLink = document.querySelector('.brand-home');
    const homeLinkRect = homeLink?.getBoundingClientRect();
    const homeLinkStyle = homeLink ? getComputedStyle(homeLink) : null;
    return {
      datasetId: document.documentElement.dataset.datasetId,
      layer: document.querySelector('#analysisLayer')?.value,
      info: document.querySelector('#mapInfoBar')?.textContent,
      layerText,
      modeText,
      sourceText,
      targetLabel: document.querySelector('#mapContextSlot')?.textContent || '',
      targetDate: visibleDate,
      targetClock: visibleClock,
      expectedDate,
      expectedClock,
      browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      homeLink: {
        href: homeLink?.href || '',
        ariaLabel: homeLink?.getAttribute('aria-label') || '',
        title: homeLink?.title || '',
        visible: Boolean(homeLinkRect?.width && homeLinkRect?.height),
        backgroundColor: homeLinkStyle?.backgroundColor || '',
        borderStyle: homeLinkStyle?.borderStyle || '',
      },
      stale: document.querySelector('#mapInfoBar')?.dataset.stale,
      staleReasons: [...(analysis.dataHealth?.reasons || [])],
      healthText: document.querySelector('#mapContextHealth')?.textContent || '',
      statusText: document.querySelector('#mapStatus')?.textContent || '',
      floatingHidden: document.querySelector('#floatingDetail')?.hidden,
      mydataHidden: document.querySelector('#mydataView')?.hidden,
      modalHidden: document.querySelector('#detailModal')?.hidden,
      slots: document.querySelectorAll('[data-slot-index]').length,
      modelDisclosure: document.querySelector('#modelDisclosure')?.textContent || '',
      modelDisclosureVisible: !document.querySelector('#conditionNote')?.hidden,
      modelAssumption: assumption?.textContent || '',
      modelAssumptionVisible: Boolean(assumptionRect?.width && assumptionRect?.height)
        && getComputedStyle(assumption).visibility !== 'hidden',
      modelAssumptionInsideControls: Boolean(assumption && document.querySelector('.controls')?.contains(assumption)),
      modelAssumptionInsideLegend: Boolean(assumption && document.querySelector('#legendBox')?.contains(assumption)),
      calculationMethod: document.querySelector('#calculationMethod')?.textContent || '',
      legend: {
        kind: document.querySelector('#legendBox')?.dataset.kind || '',
        width: legendRect?.width || 0,
        height: legendRect?.height || 0,
        scaleHeight: legendScaleRect?.height || 0,
        barWidth: legendBarRect?.width || 0,
        ticks: [...document.querySelectorAll('#legendTicks .legend-tick strong')].map(element => element.textContent),
        endpointWords: [...document.querySelectorAll('#legendScale .legend-end-label')].map(element => element.textContent),
        topLabelAboveBar: Boolean(legendTopLabelRect && legendBarRect)
          && legendTopLabelRect.bottom <= legendBarRect.top + 1,
        bottomLabelBelowBar: Boolean(legendBottomLabelRect && legendBarRect)
          && legendBottomLabelRect.top >= legendBarRect.bottom - 1,
      },
      subjectStyle: {
        color: subjectStyle?.color || '',
        background: subjectStyle?.backgroundColor || '',
        accentWidth: Number.parseFloat(subjectStyle?.borderLeftWidth || '0'),
      },
      mapView: {
        zoom: map.getZoom(),
        containsWakkanai: map.getBounds().contains([45.42, 141.68]),
        containsKagoshima: map.getBounds().contains([31.60, 130.55]),
      },
      landGridCount: Number(document.documentElement.dataset.landGridCount),
      landMaskSha: document.documentElement.dataset.landMaskSha || '',
      valueCountTotal: Number(document.querySelector('#mapInfoBar')?.dataset.valueCountTotal),
      stamp: document.querySelector('#mapInfoBar')?.textContent || '',
      obsoleteStampAbsent: !document.querySelector('.map-stamp') && !document.querySelector('#mapStampText'),
      removedLongCopyAbsent: !infoBar?.textContent.includes('アメダス実況を使った計算')
        && !infoBar?.textContent.includes('日本陸域'),
      infoTitleComplete: infoBar?.title === infoBar?.getAttribute('aria-label')
        && [layerText, modeText, sourceText, visibleDate, visibleClock].every(value => infoBar?.title.includes(value)),
      contextSplit: Boolean(subjectRect?.width && timeRect?.width),
      contextCardsSeparated: Boolean(subjectRect && timeRect) && subjectRect.right <= timeRect.left,
      infoClearOfMapControls: Boolean(infoRect) && controlRects.length > 0
        && infoRect.left >= Math.max(...controlRects.map(rect => rect.right)) + 4,
      landMaskNote: document.querySelector('#landMaskNote')?.textContent || '',
      activeBase,
      activeBaseButton: document.querySelector('[data-base].active')?.dataset.base || '',
      paleLayerActive: map.hasLayer(layers.pale),
      referenceLandActive: Boolean(referenceLandLayer) && map.hasLayer(referenceLandLayer),
      referenceFeatureCount: referenceLandLayer?.getLayers()?.length || 0,
      terrainLayerActive: map.hasLayer(terrainLayer),
      terrainChecked: Boolean(document.querySelector('#terrainToggle')?.checked),
      analysisOpacityControl: Number(document.querySelector('#opacityRange')?.value),
      analysisOpacityRuntime: analysis.opacity,
      mapBackground: getComputedStyle(document.querySelector('#map')).backgroundColor,
      layout: {
        timelineAboveStage: Boolean(timelineRect && mapStageRect) && timelineRect.bottom <= mapStageRect.top + 1,
        mapStartsInsideStage: Boolean(mapRect && mapStageRect)
          && mapRect.top >= mapStageRect.top - 1 && mapRect.bottom <= mapStageRect.bottom + 1,
        infoInsideStage: Boolean(infoRect && mapStageRect)
          && infoRect.left >= mapStageRect.left && infoRect.right <= mapStageRect.right
          && infoRect.top >= mapStageRect.top && infoRect.bottom <= mapStageRect.bottom,
        legendInsideStage: Boolean(legendRect && mapStageRect)
          && legendRect.left >= mapStageRect.left && legendRect.right <= mapStageRect.right
          && legendRect.top >= mapStageRect.top && legendRect.bottom <= mapStageRect.bottom,
        noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        timelineHeight: timelineRect?.height || 0,
        stageHeight: mapStageRect?.height || 0,
      },
      sampleCell,
    };
  });
  result.checks.initial.referenceBaseRequested = allRequests.some(url => url.includes('/data/static/reference_basemap.geojson'));
  result.checks.initial.gsiPaleTileRequested = allRequests.some(url => url.includes('/xyz/pale/'));
  await page.waitForFunction(() => placeLabelPayload?.label_count > 0
    && labelLayer?.getDrawStats()?.drawn > 0, null, { timeout: 120000 });
  result.checks.placeLabels = await page.evaluate(async () => {
    const auditUrl = new URL(PLACE_LABEL_URL, location.href);
    auditUrl.searchParams.set('audit', String(Date.now()));
    const response = await fetch(auditUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`place label audit ${response.status}`);
    const payload = await response.json();
    const prefectureNames = new Set(['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県']);
    const regionalNames = ['中国', '韓国', '北朝鮮', 'ロシア', '台湾'];
    const initial = labelLayer.getDrawStats();
    return {
      requestUrl: response.url,
      cacheVersioned: new URL(PLACE_LABEL_URL, location.href).searchParams.has('v'),
      schemaVersion: payload.schema_version,
      sourceId: payload.source?.id,
      sourcePath: payload.source?.logical_path,
      sourceSha: payload.source?.sha256,
      sourceRows: payload.source?.row_count,
      labelCount: payload.label_count,
      stationLabelCount: payload.station_label_count,
      regionalLabelCount: payload.regional_label_count,
      actualLabels: payload.labels?.length,
      rankCounts: payload.rank_counts,
      rankContract: payload.labels?.every(label => [0, 1, 2].includes(label.rank)
        && label.min_zoom === ({ 0: 0.9, 1: 1.9, 2: 3.8 })[label.rank]
        && Number.isFinite(label.latitude) && Number.isFinite(label.longitude)
        && Boolean(label.station_key) && ['a', 's', 'regional'].includes(label.station_kind)),
      regionalLabelsComplete: regionalNames.every(name => payload.labels?.some(label => label.name === name
        && label.station_kind === 'regional' && label.rank === 0)),
      noPrefectureLabels: payload.labels?.every(label => label.kind !== 'prefecture'
        && !prefectureNames.has(label.name)),
      renderContract: payload.render_contract,
      initialControlOpacity: Number(document.querySelector('#labelOpacity')?.value),
      runtimeLabels: placeLabelPayload?.label_count,
      initial,
      toggleChecked: document.querySelector('#labelsToggle')?.checked,
      canvasVisible: Boolean(labelLayer?._canvas?.isConnected),
    };
  });
  const initialLabelSequence = result.checks.placeLabels.initial.drawSequence;
  const initialLabelZoom = result.checks.placeLabels.initial.zoom;
  await page.evaluate(() => map.setZoom(map.getZoom() + 1, { animate: false }));
  await page.waitForFunction(({ sequence, zoom }) => labelLayer?.getDrawStats()?.drawSequence > sequence
    && labelLayer?.getDrawStats()?.zoom === zoom + 1, { sequence: initialLabelSequence, zoom: initialLabelZoom });
  result.checks.placeLabelZoom = await page.evaluate(() => labelLayer.getDrawStats());
  await page.evaluate(() => resetJapanView());
  await page.waitForFunction(() => labelLayer?.getDrawStats()?.zoom === map.getZoom());
  result.checks.contract = await page.evaluate(async () => {
    const manifestResponse = await fetch(`./data/moisture_manifest.json?audit=${Date.now()}`, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error(`manifest audit ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    const presetPath = manifest.condition_application?.preset_path;
    const presetsResponse = await fetch(`./data/${presetPath}?v=${encodeURIComponent(manifest.dataset_id)}`);
    if (!presetsResponse.ok) throw new Error(`presets audit ${presetsResponse.status}`);
    const presets = await presetsResponse.json();
    const landReference = manifest.land_mask;
    if (!landReference) throw new Error('land mask reference is missing');
    const [landManifestResponse, landBinaryResponse] = await Promise.all([
      fetch(`./data/${landReference.manifest}?v=${encodeURIComponent(manifest.dataset_id)}`),
      fetch(`./data/${landReference.file}?v=${encodeURIComponent(manifest.dataset_id)}`),
    ]);
    if (!landManifestResponse.ok) throw new Error(`land mask manifest audit ${landManifestResponse.status}`);
    if (!landBinaryResponse.ok) throw new Error(`land mask audit ${landBinaryResponse.status}`);
    const landManifest = await landManifestResponse.json();
    const landBuffer = await landBinaryResponse.arrayBuffer();
    const landClasses = new Uint8Array(landBuffer);
    const landDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', landBuffer))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const landCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let unknownLandClass = false;
    for (const value of landClasses) {
      if (!(value in landCounts)) unknownLandClass = true;
      else landCounts[value] += 1;
    }
    const rootrotCodes = new Set();
    const plantHourly = {};
    const waterBalanceStats = {};
    for (const [mode, refs] of Object.entries(manifest.hourly?.files || {})) {
      const [moistureResponse, labelResponse, rootrotResponse, waterBalanceResponse] = await Promise.all([
        fetch(`./data/${refs.moisture}?v=${encodeURIComponent(manifest.dataset_id)}`),
        fetch(`./data/${refs.labels}?v=${encodeURIComponent(manifest.dataset_id)}`),
        fetch(`./data/${refs.rootrot_labels}?v=${encodeURIComponent(manifest.dataset_id)}`),
        fetch(`./data/${refs.water_balance}?v=${encodeURIComponent(manifest.dataset_id)}`),
      ]);
      if (!moistureResponse.ok) throw new Error(`hourly moisture audit ${moistureResponse.status}`);
      if (!labelResponse.ok) throw new Error(`hourly label audit ${labelResponse.status}`);
      if (!rootrotResponse.ok) throw new Error(`rootrot audit ${rootrotResponse.status}`);
      if (!waterBalanceResponse.ok) throw new Error(`water balance audit ${waterBalanceResponse.status}`);
      const moisture = new Uint8Array(await moistureResponse.arrayBuffer());
      const labels = new Uint8Array(await labelResponse.arrayBuffer());
      const rootrot = new Uint8Array(await rootrotResponse.arrayBuffer());
      const waterBalance = new Float32Array(await waterBalanceResponse.arrayBuffer());
      let minimum = Infinity;
      let maximum = -Infinity;
      let finite = true;
      for (const value of waterBalance) {
        if (!Number.isFinite(value)) finite = false;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
      waterBalanceStats[mode] = { length: waterBalance.length, minimum, maximum, finite };
      plantHourly[mode] = { moisture, labels, rootrot, waterBalance };
      for (const value of rootrot) rootrotCodes.add(value);
    }
    const timeIndexes = new Map(manifest.hourly.times.map((value, index) => [value, index]));
    const rootrotReferences = { pointMatches: true, windowMatches: true, checked: 0 };
    const plantReferences = {
      pointMoistureMatches: true,
      pointLabelMatches: true,
      windowMoistureMatches: true,
      windowLabelArgminMatches: true,
      checked: 0,
      windowChecked: 0,
      windowMoistureMismatches: 0,
      windowLabelMismatches: 0,
      firstWindowMoistureMismatch: null,
      firstWindowLabelMismatch: null,
    };
    for (const slot of manifest.slots) {
      const validIndex = timeIndexes.get(slot.validtime_jst);
      const startIndex = timeIndexes.get(slot.window_start_jst);
      const endIndex = timeIndexes.get(slot.window_end_jst);
      for (const [mode, refs] of Object.entries(slot.layers || {})) {
        const [moistureResponse, labelResponse, rootrotResponse] = await Promise.all([
          fetch(`./data/${refs.file}?v=${encodeURIComponent(manifest.dataset_id)}`),
          fetch(`./data/${refs.label_file}?v=${encodeURIComponent(manifest.dataset_id)}`),
          fetch(`./data/${refs.rootrot_label_file}?v=${encodeURIComponent(manifest.dataset_id)}`),
        ]);
        if (!moistureResponse.ok) throw new Error(`moisture slot audit ${moistureResponse.status}`);
        if (!labelResponse.ok) throw new Error(`label slot audit ${labelResponse.status}`);
        if (!rootrotResponse.ok) throw new Error(`rootrot slot audit ${rootrotResponse.status}`);
        const actualMoisture = new Uint8Array(await moistureResponse.arrayBuffer());
        const actualLabels = new Uint8Array(await labelResponse.arrayBuffer());
        const actualRootrot = new Uint8Array(await rootrotResponse.arrayBuffer());
        const hourly = plantHourly[mode];
        const expectedHourlyLength = manifest.hourly.times.length * manifest.grid_count;
        let moistureMatches = actualMoisture.length === manifest.grid_count
          && hourly?.moisture.length === expectedHourlyLength;
        let labelMatches = actualLabels.length === manifest.grid_count
          && hourly?.labels.length === expectedHourlyLength;
        let rootrotMatches = actualRootrot.length === manifest.grid_count
          && hourly?.rootrot.length === expectedHourlyLength;
        if (slot.time_semantics === 'window') {
          const validWindow = Number.isInteger(startIndex) && Number.isInteger(endIndex) && endIndex >= startIndex;
          moistureMatches = moistureMatches && validWindow;
          labelMatches = labelMatches && validWindow;
          rootrotMatches = rootrotMatches && refs.rootrot_aggregation === 'max_stage'
            && Number.isInteger(startIndex) && Number.isInteger(endIndex) && endIndex >= startIndex;
          for (let grid = 0; validWindow && grid < manifest.grid_count; grid += 1) {
            let expectedMoisture = 255;
            let expectedLabel = 0;
            let argminIndex = startIndex;
            let expectedRootrot = 0;
            for (let hour = startIndex; hour <= endIndex; hour += 1) {
              const offset = hour * manifest.grid_count + grid;
              const hourlyMoisture = hourly.moisture[offset];
              if (hourlyMoisture < expectedMoisture) {
                expectedMoisture = hourlyMoisture;
                expectedLabel = hourly.labels[offset];
                argminIndex = hour;
              }
              expectedRootrot = Math.max(expectedRootrot, hourly.rootrot[offset]);
            }
            if (actualMoisture[grid] !== expectedMoisture) {
              moistureMatches = false;
              plantReferences.windowMoistureMismatches += 1;
              plantReferences.firstWindowMoistureMismatch ||= {
                slot: slot.id, mode, grid, expected: expectedMoisture, actual: actualMoisture[grid], argminIndex,
              };
            }
            if (actualLabels[grid] !== expectedLabel) {
              labelMatches = false;
              plantReferences.windowLabelMismatches += 1;
              plantReferences.firstWindowLabelMismatch ||= {
                slot: slot.id, mode, grid, expected: expectedLabel, actual: actualLabels[grid], argminIndex,
              };
            }
            if (actualRootrot[grid] !== expectedRootrot) rootrotMatches = false;
          }
          plantReferences.windowMoistureMatches = plantReferences.windowMoistureMatches && moistureMatches;
          plantReferences.windowLabelArgminMatches = plantReferences.windowLabelArgminMatches && labelMatches;
          plantReferences.windowChecked += 1;
          rootrotReferences.windowMatches = rootrotReferences.windowMatches && rootrotMatches;
        } else {
          moistureMatches = moistureMatches && Number.isInteger(validIndex);
          labelMatches = labelMatches && Number.isInteger(validIndex);
          rootrotMatches = rootrotMatches && Number.isInteger(validIndex);
          for (let grid = 0; Number.isInteger(validIndex) && grid < manifest.grid_count; grid += 1) {
            const offset = validIndex * manifest.grid_count + grid;
            if (actualMoisture[grid] !== hourly.moisture[offset]) moistureMatches = false;
            if (actualLabels[grid] !== hourly.labels[offset]) labelMatches = false;
            if (actualRootrot[grid] !== hourly.rootrot[offset]) rootrotMatches = false;
          }
          plantReferences.pointMoistureMatches = plantReferences.pointMoistureMatches && moistureMatches;
          plantReferences.pointLabelMatches = plantReferences.pointLabelMatches && labelMatches;
          rootrotReferences.pointMatches = rootrotReferences.pointMatches && rootrotMatches;
        }
        plantReferences.checked += 1;
        rootrotReferences.checked += 1;
      }
    }
    return {
      schemaVersion: manifest.schema_version,
      generatorVersion: manifest.generator_version,
      datasetId: manifest.dataset_id,
      distributionStatsBasis: manifest.distribution_stats_basis,
      distributionStatsScope: manifest.distribution_stats_scope,
      landMask: {
        reference: landReference,
        schemaVersion: landManifest.schema_version,
        gridCount: landManifest.grid_count,
        classesLength: landClasses.length,
        counts: landCounts,
        manifestCounts: landManifest.counts,
        publicLandClasses: landManifest.public_land_classes,
        sha256: landDigest,
        manifestSha256: landManifest.sha256,
        unknownLandClass,
        class0Example: landClasses.findIndex(value => value === 0),
        class1Example: landClasses.findIndex(value => value === 1),
        class2Example: landClasses.findIndex(value => value === 2),
        class3Example: landClasses.findIndex(value => value === 3),
      },
      manifestModelVersion: manifest.model_version,
      presetModelVersion: presets.model_version,
      manifestPresetVersion: manifest.preset_version,
      presetVersion: presets.preset_version,
      conditionApplication: manifest.condition_application,
      conditionControls: presets.condition_controls,
      wateringLines: Object.fromEntries(Object.entries(presets.operational_modes || {}).map(([mode, config]) => [
        mode,
        { preset: Number(config.watering_line), runtime: wateringLine(mode) },
      ])),
      reforecast: manifest.hourly.reforecast,
      waterBalanceStats,
      manifestRootrot: manifest.rootrot_contract,
      presetRootrot: presets.rootrot_contract,
      rootrotCodes: [...rootrotCodes].sort((a, b) => a - b),
      rootrotReferences,
      plantReferences,
      plantSlots: manifest.slots.map(slot => ({
        id: slot.id,
        label: slot.label,
        timeSemantics: slot.time_semantics,
        status: slot.status,
        availableHours: slot.available_hours || null,
        validtime: slot.validtime_jst,
        windowStart: slot.window_start_jst || null,
        windowEnd: slot.window_end_jst || null,
      })),
      medakaSlots: manifest.medaka.slots.map(slot => ({
        id: slot.id,
        timeSemantics: slot.time_semantics,
        validtime: slot.validtime_jst,
        windowStart: slot.window_start_jst || null,
        windowEnd: slot.window_end_jst || null,
      })),
      currentIndex: manifest.current_index,
      forecastStartIndex: manifest.forecast_start_index,
      historyHours: manifest.history_hours,
      hourlyCount: manifest.hourly.times.length,
    };
  });
  result.checks.locationLabel = await page.evaluate(async () => {
    const gridId = 13463;
    const fallback = gridLocationLabel(gridId);
    const resolved = await resolveGridLocationLabel(gridId);
    return {
      gridId,
      landClass: analysis.landClasses?.[gridId],
      fallback,
      resolved,
      cached: gridLocationLabel(gridId),
      latitude: analysis.points?.[gridId * 2],
      longitude: analysis.points?.[gridId * 2 + 1],
    };
  });
  result.checks.controls = await page.evaluate(ids => Object.fromEntries(Object.entries(ids).map(([name, id]) => {
    const element = document.getElementById(id);
    return [name, [...(element?.options || [])].map(option => option.value)];
  })), controlElements);
  result.checks.plantTypeOffsets = await page.evaluate(() => {
    const element = document.getElementById('mapPlant');
    const original = element.value;
    const offsets = {};
    for (const value of ['moist_lover', 'foliage', 'dry']) {
      element.value = value;
      offsets[value] = conditionOffset();
    }
    element.value = original;
    return offsets;
  });
  result.checks.conditionCombinations = await page.evaluate(ids => {
    const elements = Object.values(ids).map(id => document.getElementById(id));
    const originals = elements.map(element => element.value);
    const options = elements.map(element => [...element.options].map(option => option.value));
    let count = 0;
    const errors = [];
    const visit = index => {
      if (index < elements.length) {
        for (const value of options[index]) {
          elements[index].value = value;
          visit(index + 1);
        }
        return;
      }
      try {
        const offset = conditionOffset();
        const adjusted = [0, 50, 100].map(value => Math.max(0, Math.min(100, value + offset)));
        if (!Number.isFinite(offset) || adjusted.some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
          throw new Error(`invalid offset ${offset}`);
        }
        count += 1;
      } catch (error) {
        errors.push(String(error));
      }
    };
    visit(0);
    elements.forEach((element, index) => { element.value = originals[index]; });
    return { count, errors, restored: elements.every((element, index) => element.value === originals[index]) };
  }, controlElements);
  result.checks.observedOptions = await page.$eval('#observedLayer', element => [...element.options].map(option => option.value));
  result.checks.timelineInitial = await page.evaluate(() => {
    const range = document.querySelector('#timelineRange');
    const timeline = document.querySelector('#timeline');
    return {
      min: Number(range?.min),
      max: Number(range?.max),
      step: Number(range?.step),
      value: Number(range?.value),
      ariaValueText: range?.getAttribute('aria-valuetext'),
      viewKind: timeline?.dataset.viewKind,
      timeIndex: Number(timeline?.dataset.timeIndex),
      source: timeline?.dataset.source,
      readout: document.querySelector('#timelineReadout')?.textContent,
    };
  });
  result.checks.initialCanvas = await canvasState('.analysis-canvas');
  result.checks.analysisOpacity = await page.evaluate(() => {
    const control = document.querySelector('#opacityRange');
    const initialValue = Number(control.value);
    const gridId = analysis.publicLandGridIds.find(id => map.getBounds().contains([
      analysis.points[id * 2], analysis.points[id * 2 + 1],
    ]));
    const point = map.latLngToContainerPoint([analysis.points[gridId * 2], analysis.points[gridId * 2 + 1]]);
    const canvas = analysis.canvas;
    const rect = canvas.getBoundingClientRect();
    const pixelX = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x * canvas.width / rect.width)));
    const pixelY = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y * canvas.height / rect.height)));
    const reader = document.createElement('canvas');
    reader.width = 1;
    reader.height = 1;
    const readerContext = reader.getContext('2d', { willReadFrequently: true });
    const values = [0, 10, 25, 50, 75, 100];
    const samples = values.map(value => {
      control.value = String(value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
      readerContext.clearRect(0, 0, 1, 1);
      readerContext.drawImage(canvas, pixelX, pixelY, 1, 1, 0, 0, 1, 1);
      const alpha = readerContext.getImageData(0, 0, 1, 1).data[3] / 255;
      return { value, runtime: analysis.opacity, alpha };
    });
    control.value = String(initialValue);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      initialValue,
      restoredValue: Number(control.value),
      restoredRuntime: analysis.opacity,
      samples,
      offscreenPaintCanvas: Boolean(analysis.paintCanvas) && !analysis.paintCanvas.isConnected,
    };
  });
  result.checks.partialLabelExample = await page.evaluate(() => slotDisplayLabel({
    label: '48h内最小',
    time_semantics: 'window',
    status: 'partial',
    available_hours: 37,
  }));

  const forecastIndex = result.checks.contract.currentIndex + 1;
  await page.$eval('#timelineRange', (range, index) => {
    range.value = String(index);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }, forecastIndex);
  await page.waitForFunction(index => {
    const timeline = document.querySelector('#timeline');
    return timeline?.dataset.viewKind === 'hourly'
      && timeline?.dataset.source === '予報'
      && Number(timeline?.dataset.timeIndex) === index
      && document.querySelector('#mapContextSource')?.textContent === '予報'
      && document.querySelector('#mapContextSlot')?.textContent === '+1h';
  }, forecastIndex);
  result.checks.timelinePoint = await page.evaluate(() => ({
    viewKind: document.querySelector('#timeline')?.dataset.viewKind,
    source: document.querySelector('#timeline')?.dataset.source,
    timeIndex: Number(document.querySelector('#timeline')?.dataset.timeIndex),
    readout: document.querySelector('#timelineReadout')?.textContent,
    stamp: document.querySelector('#mapInfoBar')?.textContent,
    info: document.querySelector('#mapInfoBar')?.textContent,
    contextSource: document.querySelector('#mapContextSource')?.textContent,
    contextSlot: document.querySelector('#mapContextSlot')?.textContent,
  }));

  const partialSlotIndex = result.checks.contract.plantSlots.findIndex(slot => slot.timeSemantics === 'window' && slot.status === 'partial');
  const aggregateSlotIndex = partialSlotIndex >= 0
    ? partialSlotIndex
    : result.checks.contract.plantSlots.findIndex(slot => slot.timeSemantics === 'window');
  const aggregateSlot = result.checks.contract.plantSlots[aggregateSlotIndex];
  const aggregateDisplayLabel = aggregateSlot?.status === 'partial'
    ? `${aggregateSlot.label}（${aggregateSlot.availableHours}h分）`
    : aggregateSlot?.label;
  await page.evaluate(index => loadShortcut(index), aggregateSlotIndex);
  await page.waitForFunction(({ label }) => document.querySelector('#timeline')?.dataset.viewKind === 'aggregate'
    && document.querySelector('#timeline')?.dataset.source === '集計'
    && document.querySelector('#timelineReadout')?.textContent.includes(label)
    && document.querySelector('#mapContextSource')?.textContent === '集計'
    && document.querySelector('#mapContextSlot')?.textContent.includes(label), { label: aggregateDisplayLabel });
  result.checks.timelineAggregate = await page.evaluate(() => ({
    viewKind: document.querySelector('#timeline')?.dataset.viewKind,
    source: document.querySelector('#timeline')?.dataset.source,
    timeIndex: Number(document.querySelector('#timeline')?.dataset.timeIndex),
    activeShortcut: document.querySelector('[data-slot-index].active')?.dataset.slotIndex,
    buttonLabel: document.querySelector('[data-slot-index].active')?.textContent,
    readout: document.querySelector('#timelineReadout')?.textContent,
    stamp: document.querySelector('#mapInfoBar')?.textContent,
    info: document.querySelector('#mapInfoBar')?.textContent,
    contextSource: document.querySelector('#mapContextSource')?.textContent,
    contextSlot: document.querySelector('#mapContextSlot')?.textContent,
  }));
  await page.evaluate(() => {
    const button = document.querySelector('#saveImage');
    delete button.dataset.imageReady;
    delete button.dataset.imageError;
    delete button.dataset.imageSlotLabel;
    window.__waterCareAuditImageTexts = [];
    window.__waterCareAuditFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function auditFillText(text, ...args) {
      window.__waterCareAuditImageTexts.push(String(text));
      return window.__waterCareAuditFillText.call(this, text, ...args);
    };
    window.__waterCareAuditAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function auditAnchorClick() {
      if (this.download) return undefined;
      return window.__waterCareAuditAnchorClick.call(this);
    };
  });
  await page.click('#saveImage');
  await page.waitForFunction(() => Boolean(document.querySelector('#saveImage')?.dataset.imageReady
    || document.querySelector('#saveImage')?.dataset.imageError), null, { timeout: 30000 });
  result.checks.imageSave = await page.evaluate(() => {
    const button = document.querySelector('#saveImage');
    const value = {
      ready: button?.dataset.imageReady || '',
      error: button?.dataset.imageError || '',
      slotLabel: button?.dataset.imageSlotLabel || '',
      texts: [...(window.__waterCareAuditImageTexts || [])],
    };
    CanvasRenderingContext2D.prototype.fillText = window.__waterCareAuditFillText;
    HTMLAnchorElement.prototype.click = window.__waterCareAuditAnchorClick;
    delete window.__waterCareAuditFillText;
    delete window.__waterCareAuditAnchorClick;
    delete window.__waterCareAuditImageTexts;
    return value;
  });

  await page.click('[data-tl-current]');
  await page.waitForFunction(index => document.querySelector('#timeline')?.dataset.viewKind === 'hourly'
    && document.querySelector('#timeline')?.dataset.source === '実況'
    && Number(document.querySelector('#timeline')?.dataset.timeIndex) === index, result.checks.contract.currentIndex);

  await page.selectOption('#analysisLayer', 'watering');
  await page.waitForFunction(() => document.querySelector('#mapContextLayer')?.textContent === '水やりナビMAP');
  result.checks.watering = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    layer: document.querySelector('#mapContextLayer')?.textContent,
    modelDisclosureVisible: !document.querySelector('#conditionNote')?.hidden,
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
    calculationMethod: document.querySelector('#calculationMethod')?.textContent || '',
    legendDiscrete: document.querySelector('#legendBox')?.classList.contains('discrete'),
    legendLabels: [...document.querySelectorAll('#legendNote span')].map(element => element.textContent),
  }));

  await page.selectOption('#analysisLayer', 'rootrot');
  await page.waitForFunction(() => document.querySelector('#mapContextLayer')?.textContent === '根腐れ注意MAP');
  result.checks.rootrot = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    layer: document.querySelector('#mapContextLayer')?.textContent,
    counts: document.querySelector('#mapInfoBar')?.dataset.valueCounts,
    legendLabels: [...document.querySelectorAll('#legendNote span')].map(element => element.textContent),
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
    calculationMethod: document.querySelector('#calculationMethod')?.textContent || '',
    legendDiscrete: document.querySelector('#legendBox')?.classList.contains('discrete'),
  }));

  await page.selectOption('#analysisLayer', 'medaka');
  await page.waitForFunction(() => document.querySelectorAll('[data-slot-index]').length === 0
    && document.querySelector('#mapContextLayer')?.textContent === 'メダカあふれリスクMAP');
  result.checks.medaka = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    layer: document.querySelector('#mapContextLayer')?.textContent,
    slots: document.querySelectorAll('[data-slot-index]').length,
    timelineMin: Number(document.querySelector('#timelineRange')?.min),
    timelineMax: Number(document.querySelector('#timelineRange')?.max),
    timelineStep: Number(document.querySelector('#timelineRange')?.step),
    modelDisclosureHidden: Boolean(document.querySelector('#conditionNote')?.hidden),
    medakaDisclosure: document.querySelector('#medakaDisclosure')?.textContent || '',
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
    calculationMethod: document.querySelector('#calculationMethod')?.textContent || '',
    legendDiscrete: document.querySelector('#legendBox')?.classList.contains('discrete'),
    legendLabels: [...document.querySelectorAll('#legendNote span')].map(element => element.textContent),
  }));

  await page.evaluate(() => loadShortcut(5));
  await page.waitForFunction(() => document.querySelector('#timeline')?.dataset.viewKind === 'aggregate'
    && document.querySelector('#timeline')?.dataset.source === '集計');
  result.checks.medakaAggregate = await page.evaluate(() => ({
    viewKind: document.querySelector('#timeline')?.dataset.viewKind,
    source: document.querySelector('#timeline')?.dataset.source,
    activeShortcut: document.querySelector('[data-slot-index].active')?.dataset.slotIndex,
    readout: document.querySelector('#timelineReadout')?.textContent,
  }));

  result.checks.observedWindows = {};
  for (const kind of ['rain3h', 'rain6h', 'rain12h']) {
    await page.selectOption('#observedLayer', kind);
    await page.waitForFunction(value => document.querySelector('#observedLayer')?.value === value
      && document.querySelector('#mapContextObserved')?.textContent.includes(document.querySelector('#observedLayer')?.selectedOptions[0]?.textContent), kind);
    result.checks.observedWindows[kind] = await page.evaluate(() => ({
      info: document.querySelector('#mapInfoBar')?.textContent,
      observed: document.querySelector('#mapContextObserved')?.textContent,
      canvasVisible: !document.querySelector('.amedas-rain-canvas')?.hidden,
    }));
  }

  await page.selectOption('#observedLayer', 'rain24hDiff');
  await page.waitForFunction(() => document.querySelector('#mapContextObserved')?.textContent.includes('24時間降水 前日差'));
  result.checks.rainDifference = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    observed: document.querySelector('#mapContextObserved')?.textContent,
    canvasVisible: !document.querySelector('.amedas-rain-canvas')?.hidden,
  }));

  await page.selectOption('#analysisLayer', 'moisture');
  await page.waitForFunction(() => document.querySelector('#mapContextLayer')?.textContent === 'うるおい残量MAP');

  result.checks.landSelectionDistance = await page.evaluate(gridId => {
    const latitude = analysis.points[gridId * 2];
    const longitude = analysis.points[gridId * 2 + 1];
    return {
      exactGrid: nearestGrid({ lat: latitude, lng: longitude }),
      distantOceanGrid: nearestGrid({ lat: 0, lng: 0 }),
      hitRadiusSquared: LAND_GRID_HIT_RADIUS2,
    };
  }, result.checks.contract.landMask.class1Example);

  const mapLocator = page.locator('#map');
  const box = await mapLocator.boundingBox();
  if (!box) throw new Error('map has no bounding box');
  const clickTargets = await page.evaluate(() => {
    const mapElement = document.querySelector('#map');
    const mapRect = mapElement.getBoundingClientRect();
    const safe = analysis.publicLandGridIds.map(gridId => ({
      gridId,
      point: map.latLngToContainerPoint([analysis.points[gridId * 2], analysis.points[gridId * 2 + 1]]),
    })).filter(({ point }) => {
      if (point.x < 30 || point.y < 30 || point.x > mapRect.width - 30 || point.y > mapRect.height - 30) return false;
      const hit = document.elementFromPoint(mapRect.left + point.x, mapRect.top + point.y);
      return Boolean(hit?.closest('#map')) && !hit.closest('.leaflet-control');
    });
    const first = safe[Math.floor(safe.length * 0.35)];
    const second = safe.find(candidate => candidate.gridId !== first.gridId
      && Math.hypot(candidate.point.x - first.point.x, candidate.point.y - first.point.y) > 100);
    if (!first || !second) throw new Error('three-click map audit targets unavailable');
    const firstGrid = first.gridId, firstPoint = first.point;
    const secondGrid = second.gridId, secondPoint = second.point;
    return { firstGrid, secondGrid, firstPoint, secondPoint };
  });
  await page.mouse.click(box.x + clickTargets.firstPoint.x, box.y + clickTargets.firstPoint.y);
  await page.waitForFunction(gridId => document.querySelector('#detailModal')?.hidden === false
    && analysis.selectedGrid === gridId, clickTargets.firstGrid);
  result.checks.detail = await page.evaluate(() => ({
    grid: document.querySelector('#detailGrid')?.textContent,
    gridIdAttribute: Number(document.querySelector('#detailGrid')?.dataset.gridId),
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    floatingHidden: Boolean(document.querySelector('#floatingDetail')?.hidden),
    modalVisible: !document.querySelector('#detailModal')?.hidden,
    chartAria: document.querySelector('#detailChart')?.getAttribute('aria-label') || '',
    rainUnit: document.querySelector('#detailChart')?.dataset.rainUnit || '',
    rainDataMax: Number(document.querySelector('#detailChart')?.dataset.rainDataMax),
    rainAxisMax: Number(document.querySelector('#detailChart')?.dataset.rainAxisMax),
    rainAxisStep: Number(document.querySelector('#detailChart')?.dataset.rainAxisStep),
  }));
  await page.click('#detailModalClose');
  await page.mouse.click(box.x + clickTargets.secondPoint.x, box.y + clickTargets.secondPoint.y);
  await page.waitForFunction(gridId => document.querySelector('#detailModal')?.hidden === false
    && analysis.selectedGrid === gridId, clickTargets.secondGrid);
  result.checks.mapClickRoundTrip = await page.evaluate(({ firstGrid, secondGrid }) => ({
    clicks: 3,
    firstGrid,
    secondGrid,
    selectedGrid: analysis.selectedGrid,
    modalVisible: !document.querySelector('#detailModal')?.hidden,
  }), clickTargets);
  await page.click('#detailModalClose');

  await page.selectOption('#analysisLayer', 'moisture');
  await page.waitForFunction(() => document.querySelector('#mapContextLayer')?.textContent === 'うるおい残量MAP');
  await page.evaluate(async gridId => selectGridSafely(gridId, { showPanel: false }), result.checks.contract.landMask.class2Example);
  result.checks.unassignedLand = await page.evaluate(() => ({
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    calendarTitle: document.querySelector('#calendarTitle')?.textContent || '',
    calendarText: document.querySelector('#calendarDays')?.textContent || '',
  }));
  await page.evaluate(async gridId => selectGridSafely(gridId, { showPanel: false }), result.checks.contract.landMask.class0Example);
  result.checks.legacyOutsideGrid = await page.evaluate(async () => ({
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    detailGrid: document.querySelector('#detailGrid')?.textContent || '',
    floatingGrid: document.querySelector('#floatingGrid')?.textContent || '',
    detailLabel: document.querySelector('#detailLabel')?.textContent || '',
    detailReason: document.querySelector('#detailReason')?.textContent || '',
    itemGrid: document.querySelector('#itemGrid')?.value || '',
    status: document.querySelector('#mapStatus')?.textContent || '',
    itemStatus: await itemStatus({ grid_id: analysis.selectedGrid, mode: 'farm' }),
  }));
  await page.evaluate(async gridId => selectGridSafely(gridId, { showPanel: false }), result.checks.contract.landMask.class3Example);
  result.checks.legacyForeignGrid = await page.evaluate(() => ({
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    detailGrid: document.querySelector('#detailGrid')?.textContent || '',
    floatingGrid: document.querySelector('#floatingGrid')?.textContent || '',
  }));
  await page.evaluate(async gridId => selectGridSafely(gridId, { showPanel: false }), result.checks.contract.landMask.class1Example);
  result.checks.legacyRecovery = await page.evaluate(() => ({
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    status: document.querySelector('#mapStatus')?.textContent || '',
  }));

  const mydataRequestStart = allRequests.length;
  result.checks.mydataLazyBefore = await page.evaluate(() => {
    const refs = analysis.manifest.hourly.files.pot_outdoor;
    return !analysis.hourly[refs.water_balance];
  });
  result.checks.importSanitization = await page.evaluate(gridId => {
    const now = new Date().toISOString();
    const normalized = normalizeImportedItem({
      id: 'audit-import', name: '監査用インポート', mode: 'pot_outdoor', preset_id: 'std_foliage',
      grid_id: gridId,
      latitude: 35, longitude: 139, coordinates: [139, 35],
      location: { grid_id: gridId, label: '任意', lat: 35, lon: 139, latitude: 35, lng: 139 },
      simple_adjust: { dryness: 'std', rain_exposure: 'std', latitude: 35 },
      advanced_overrides: { geometry: { coordinates: [139, 35] } },
      observations: [{ latitude: 35 }],
      logs: [
        { ts: now, type: 'water_full', note: 'ok' },
        { ts: now, type: 'water_change', note: 'wrong mode' },
        { ts: now, type: 'rain_cover', note: 'ok' },
      ],
      created_at: now, updated_at: now,
    });
    const forbidden = [];
    const visit = (value, path = '') => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        if (/^(?:lat|latitude|lon|lng|longitude|coordinates?|geo|geometry)$/i.test(key)) forbidden.push(next);
        visit(child, next);
      }
    };
    visit(normalized);
    return {
      forbidden,
      gridId: normalized.grid_id,
      location: normalized.location,
      logTypes: normalized.logs.map(log => log.type),
      advancedKeys: Object.keys(normalized.advanced_overrides),
      observations: normalized.observations.length,
    };
  }, result.checks.contract.landMask.class1Example);
  await page.click('#openMydata');
  await page.waitForFunction(() => document.querySelector('#detailModal')?.hidden === false
    && document.querySelector('#mydataView')?.hidden === false
    && document.querySelector('#detailView')?.hidden === true);
  result.checks.mydataManagementOpen = await page.evaluate(() => ({
    modalVisible: !document.querySelector('#detailModal')?.hidden,
    managementVisible: !document.querySelector('#mydataView')?.hidden,
    detailHidden: Boolean(document.querySelector('#detailView')?.hidden),
    commonModal: document.querySelector('#detailModal .detail-modal-card')?.contains(document.querySelector('#mydataView')),
    formVisible: Boolean(document.querySelector('#itemForm')?.getBoundingClientRect().height),
  }));
  await page.fill('#itemName', '監査用マイデータ');
  await page.selectOption('#itemMode', 'pot_outdoor');
  await page.selectOption('#itemPreset', 'std_foliage');
  await page.selectOption('#itemDryness', 'std');
  await page.selectOption('#itemRain', 'std');
  await page.click('#itemForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.mydata-mini-card').length === 1
    && document.querySelector('#itemList')?.textContent.includes('監査用マイデータ'));
  result.checks.mydataSetup = await page.evaluate(async () => {
    const item = (await getItems()).find(row => row.name === '監査用マイデータ');
    if (!item) throw new Error('MyData audit registration did not persist');
    const mode = item.mode;
    const refs = analysis.manifest.hourly.files[mode];
    const n = analysis.manifest.grid_count;
    const current = analysis.manifest.current_index;
    const count = analysis.manifest.hourly.times.length;
    const gridId = item.grid_id;
    const before = await itemPlantForecast(item);
    const firstEventIndex = Math.max(0, current - 1);
    item.logs = [
      { ts: analysis.manifest.hourly.times[firstEventIndex], type: 'water_full', note: '' },
      { ts: analysis.manifest.hourly.times[current], type: 'water_light', note: '' },
    ];
    await putItem(item);
    await renderItems();
    const after = await itemPlantForecast(item);
    const balance = await buffer(refs.water_balance, Float32Array);
    const expected = Float32Array.from(before.values);
    const events = itemWaterEvents(item);
    const byIndex = new Map();
    for (const event of events) {
      if (!byIndex.has(event.index)) byIndex.set(event.index, []);
      byIndex.get(event.index).push(event);
    }
    if (events.length) {
      const first = events[0].index;
      let state = expected[first];
      for (let h = first; h < count; h += 1) {
        if (h > first) state = Math.max(0, Math.min(100, state + balance[h * n + gridId]));
        for (const event of byIndex.get(h) || []) {
          state = event.log.type === 'water_full'
            ? after.contract.water_full_target_pct
            : Math.min(100, state + after.contract.water_light_increment_pct);
        }
        expected[h] = state;
      }
    }
    let replayMaxError = 0;
    for (let h = 0; h < count; h += 1) replayMaxError = Math.max(replayMaxError, Math.abs(after.values[h] - expected[h]));
    const searchStart = Math.max(current, events.at(-1)?.index ?? 0);
    let expectedWateringIndex = -1;
    for (let h = searchStart; h < count; h += 1) {
      if (expected[h] <= wateringLine(mode)) { expectedWateringIndex = h; break; }
    }
    const expectedWateringTime = expectedWateringIndex >= 0
      ? new Date(analysis.manifest.hourly.times[expectedWateringIndex]).toLocaleString('ja-JP', { timeZone: JST_TIME_ZONE, month: 'numeric', day: 'numeric', hour: 'numeric' })
      : '提供期間内は未到達';
    const actualWateringTime = await wateringTime(item, after);
    const oldItem = { ...item, logs: [{
      ts: new Date(new Date(analysis.manifest.hourly.times[0]).getTime() - 3600000).toISOString(),
      type: 'water_full', note: '',
    }] };
    const oldForecast = await itemPlantForecast(oldItem);
    const futureItem = { ...item, logs: [{
      ts: new Date(new Date(analysis.manifest.hourly.times.at(-1)).getTime() + 3600000).toISOString(),
      type: 'water_light', note: '',
    }] };
    const futureForecast = await itemPlantForecast(futureItem);
    const displayIndex = itemDisplayIndex(after);
    return {
      itemId: item.id,
      itemName: item.name,
      gridId,
      lazyAfter: Boolean(analysis.hourly[refs.water_balance]),
      registeredGridMatches: gridId === analysis.selectedGrid,
      eventCount: events.length,
      replayMaxError,
      replayFiniteBounded: after.values.every(value => Number.isFinite(value) && value >= 0 && value <= 100),
      searchMatches: actualWateringTime === expectedWateringTime,
      actualWateringTime,
      expectedWateringTime,
      unchangedBeforeEvent: after.values.slice(0, firstEventIndex).every((value, index) => Math.abs(value - before.values[index]) < 0.001),
      oldLogIgnored: oldForecast.events.length === 0 && oldForecast.ignoredEvents.length === 1,
      oldLogUnchanged: oldForecast.values.every((value, index) => Math.abs(value - before.values[index]) < 0.001),
      futureLogIgnored: futureForecast.events.length === 0 && futureForecast.ignoredEvents.length === 1,
      futureLogUnchanged: futureForecast.values.every((value, index) => Math.abs(value - before.values[index]) < 0.001),
      expectedModalMoisture: `${Math.round(expected[displayIndex])}%`,
      miniCards: document.querySelectorAll('.mydata-mini-card').length,
      miniText: document.querySelector('#mydataMiniList')?.textContent || '',
      managementText: document.querySelector('#itemList')?.textContent || '',
      mapWetExists: Boolean(document.querySelector('#mapWet')),
    };
  });
  await page.click('.mydata-mini-card');
  await page.waitForFunction(id => document.querySelector('#detailModal')?.hidden === false
    && document.querySelector('#detailModal')?.dataset.itemId === id
    && document.querySelector('#detailView')?.hidden === false
    && document.querySelector('#mydataView')?.hidden === true
    && document.querySelector('#detailReason')?.textContent.includes('以降を再計算'), result.checks.mydataSetup.itemId);
  result.checks.mydataDetail = await page.evaluate(() => ({
    modalItemId: document.querySelector('#detailModal')?.dataset.itemId || '',
    grid: document.querySelector('#detailGrid')?.textContent || '',
    moisture: document.querySelector('#detailMoisture')?.textContent || '',
    label: document.querySelector('#detailLabel')?.textContent || '',
    reason: document.querySelector('#detailReason')?.textContent || '',
    conditions: document.querySelector('#detailConditions')?.textContent || '',
    calendar: document.querySelector('#calendarDays')?.textContent || '',
      actionsVisible: !document.querySelector('#mydataDetailActions')?.hidden,
      visibleLogTypes: [...document.querySelectorAll('[data-detail-log]')]
        .filter(button => !button.hidden).map(button => button.dataset.detailLog),
      chartVisible: !document.querySelector('#detailChart')?.hidden,
    detailVisible: !document.querySelector('#detailView')?.hidden,
    managementHidden: Boolean(document.querySelector('#mydataView')?.hidden),
  }));
  await page.click('#manageMydata');
  await page.waitForFunction(() => document.querySelector('#detailModal')?.hidden === false
    && document.querySelector('#mydataView')?.hidden === false
    && document.querySelector('#detailView')?.hidden === true);
  result.checks.mydataManagementReturn = await page.evaluate(() => ({
    modalVisible: !document.querySelector('#detailModal')?.hidden,
    managementVisible: !document.querySelector('#mydataView')?.hidden,
    detailHidden: Boolean(document.querySelector('#detailView')?.hidden),
    itemVisible: document.querySelector('#itemList')?.textContent.includes('監査用マイデータ'),
  }));
  await page.click('#itemList [data-item-detail]');
  await page.waitForFunction(id => document.querySelector('#detailModal')?.dataset.itemId === id
    && document.querySelector('#detailView')?.hidden === false
    && document.querySelector('#mydataView')?.hidden === true, result.checks.mydataSetup.itemId);
  await page.evaluate(async ({ id, gridId }) => {
    const item = (await getItems()).find(row => row.id === id);
    const medaka = { ...item, id: 'audit-medaka-item', name: '監査用メダカ', grid_id: gridId,
      location: { grid_id: gridId }, mode: 'medaka', preset_id: 'medaka_60l', logs: [] };
    await putItem(medaka);
    await renderItems();
    await Promise.all([openItemDetail(item), openItemDetail(medaka)]);
  }, { id: result.checks.mydataSetup.itemId, gridId: result.checks.contract.landMask.class1Example });
  await page.waitForFunction(() => document.querySelector('#detailModal')?.dataset.itemId === 'audit-medaka-item');
  result.checks.mydataMedakaNoStaleChart = await page.evaluate(() => {
    const canvas = document.querySelector('#detailChart');
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    return {
      chartHidden: canvas.hidden,
      titleHidden: document.querySelector('#detailChartTitle')?.hidden,
      chartCleared: canvas.toDataURL() === blank.toDataURL(),
      visibleLogTypes: [...document.querySelectorAll('[data-detail-log]')]
        .filter(button => !button.hidden).map(button => button.dataset.detailLog),
      conditions: document.querySelector('#detailConditions')?.textContent || '',
    };
  });
  await page.click('#mydataDetailActions [data-detail-log="water_change"]');
  await page.waitForFunction(async () => (await getItems()).find(row => row.id === 'audit-medaka-item')
    ?.logs?.some(log => log.type === 'water_change'));
  await page.evaluate(id => Promise.all([
    recordWater(id, 'top_up'),
    recordWater(id, 'rain_cover'),
  ]), 'audit-medaka-item');
  result.checks.mydataMedakaLog = await page.evaluate(async () => {
    const item = (await getItems()).find(row => row.id === 'audit-medaka-item');
    const log = item?.logs?.at(-1);
    return { stored: Boolean(log), type: log?.type, validTimestamp: Number.isFinite(new Date(log?.ts).getTime()),
      modalItemId: document.querySelector('#detailModal')?.dataset.itemId || '',
      logCount: item?.logs?.length || 0,
      logTypes: item?.logs?.map(row => row.type) || [] };
  });
  await page.evaluate(async ({ id, gridId }) => {
    const item = (await getItems()).find(row => row.id === id);
    await openItemDetail({ ...item, id: 'audit-outside-item', grid_id: gridId, location: { grid_id: gridId } });
  }, { id: result.checks.mydataSetup.itemId, gridId: result.checks.contract.landMask.class0Example });
  result.checks.mydataOutsideNoStaleChart = await page.evaluate(() => {
    const canvas = document.querySelector('#detailChart');
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    return {
      chartHidden: canvas.hidden,
      titleHidden: document.querySelector('#detailChartTitle')?.hidden,
      chartCleared: canvas.toDataURL() === blank.toDataURL(),
      logButtonsHidden: [...document.querySelectorAll('[data-detail-log]')].every(button => button.hidden),
      visibleLogTypes: [...document.querySelectorAll('[data-detail-log]')]
        .filter(button => !button.hidden).map(button => button.dataset.detailLog),
      label: document.querySelector('#detailLabel')?.textContent || '',
    };
  });
  await page.click('#detailModalClose');
  await page.evaluate(() => { document.querySelector('#floatingDetail').hidden = false; });
  await page.click('#openDetailModal');
  await page.waitForFunction(gridId => document.querySelector('#detailModal')?.hidden === false
    && !document.querySelector('#detailModal')?.dataset.itemId
    && Number(document.querySelector('#detailGrid')?.dataset.gridId) === gridId
    && document.querySelector('#detailGrid')?.textContent.includes('付近'), result.checks.contract.landMask.class1Example);
  result.checks.mapDetailRestoredAfterMydata = await page.evaluate(gridId => ({
    selectedGrid: analysis.selectedGrid,
    expectedGrid: gridId,
    modalItemId: document.querySelector('#detailModal')?.dataset.itemId || '',
    grid: document.querySelector('#detailGrid')?.textContent || '',
    actionsHidden: Boolean(document.querySelector('#mydataDetailActions')?.hidden),
    conditionsHidden: Boolean(document.querySelector('#detailConditions')?.hidden),
    chartVisible: !document.querySelector('#detailChart')?.hidden,
    detailVisible: !document.querySelector('#detailView')?.hidden,
    managementHidden: Boolean(document.querySelector('#mydataView')?.hidden),
  }), result.checks.contract.landMask.class1Example);
  await page.click('#detailModalClose');
  result.checks.labelOpacity = await page.evaluate(() => {
    const control = document.querySelector('#labelOpacity');
    const toggle = document.querySelector('#labelsToggle');
    const initiallyAdded = map.hasLayer(labelLayer) && Boolean(labelLayer?._canvas?.isConnected);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const removedWhenOff = !map.hasLayer(labelLayer) && !labelLayer?._canvas?.isConnected;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const restoredWhenOn = map.hasLayer(labelLayer) && Boolean(labelLayer?._canvas?.isConnected);
    control.value = '35';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      value: Number(control.value),
      runtime: labelOpacity,
      canvasOpacity: Number(labelLayer?._canvas?.style.opacity),
      statsOpacity: labelLayer?.getDrawStats()?.opacity,
      initiallyAdded,
      removedWhenOff,
      restoredWhenOn,
    };
  });
  result.checks.legacyConditions = await page.evaluate(() => {
    applySharedConditions(['flower', 'large', 'very_dry', 'cover', 'west', 'very_fast', 'weak']);
    return Object.fromEntries(SHARED_CONDITION_IDS.map(id => [id, document.getElementById(id).value]));
  });
  await page.$eval('#opacityRange', control => {
    control.value = '35';
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#copyLink');
  await page.waitForFunction(() => Boolean(document.querySelector('#copyLink')?.dataset.lastUrl));
  result.checks.sharedPrivacy = await page.evaluate(({ itemId, itemName }) => {
    const url = new URL(document.querySelector('#copyLink').dataset.lastUrl);
    return {
      url: url.toString(),
      conditions: (url.searchParams.get('c') || '').split(','),
      base: url.searchParams.get('base'),
      opacity: Number(url.searchParams.get('op')),
      runtimeOpacity: analysis.opacity,
      hasTab: url.searchParams.has('tab'),
      hasMydataId: url.toString().includes(itemId),
      hasMydataName: url.toString().includes(encodeURIComponent(itemName)),
      hasObsoleteWetValue: (url.searchParams.get('c') || '').split(',').length === 7,
    };
  }, { itemId: result.checks.mydataSetup.itemId, itemName: result.checks.mydataSetup.itemName });
  result.checks.mydataNetwork = {
    requests: allRequests.slice(mydataRequestStart),
    containsItemId: allRequests.slice(mydataRequestStart).some(url => url.includes(result.checks.mydataSetup.itemId)),
    containsItemName: allRequests.slice(mydataRequestStart).some(url => url.includes(encodeURIComponent(result.checks.mydataSetup.itemName))),
  };
  await page.evaluate(async id => { await deleteItem(id); await renderItems(); }, result.checks.mydataSetup.itemId);

  const legacyUrl = new URL(targetUrl);
  legacyUrl.searchParams.set('grid', String(result.checks.contract.landMask.class0Example));
  const legacyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await legacyPage.goto(legacyUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 120000 });
    await legacyPage.waitForFunction(() => Boolean(document.documentElement.dataset.datasetId)
      && document.querySelector('#floatingDetail')?.hidden === false, null, { timeout: 120000 });
    result.checks.legacySharedOutside = await legacyPage.evaluate(() => ({
      selectedGrid: analysis.selectedGrid,
      landClass: analysis.landClasses?.[analysis.selectedGrid],
      floatingVisible: !document.querySelector('#floatingDetail')?.hidden,
      floatingGrid: document.querySelector('#floatingGrid')?.textContent || '',
      status: document.querySelector('#mapStatus')?.textContent || '',
    }));
  } finally {
    await legacyPage.close();
  }

  const legacyTabUrl = new URL(targetUrl);
  legacyTabUrl.searchParams.set('tab', 'calendar');
  legacyTabUrl.searchParams.set('grid', String(result.checks.contract.landMask.class1Example));
  legacyTabUrl.searchParams.set('layer', 'moisture');
  const legacyTabPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await legacyTabPage.goto(legacyTabUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 120000 });
    await legacyTabPage.waitForFunction(gridId => Boolean(document.documentElement.dataset.datasetId)
      && analysis.selectedGrid === gridId
      && document.querySelector('#mapContextLayer')?.textContent === 'うるおい残量MAP', result.checks.contract.landMask.class1Example, { timeout: 120000 });
    result.checks.legacyTabIgnored = await legacyTabPage.evaluate(gridId => ({
      selectedGrid: analysis.selectedGrid,
      expectedGrid: gridId,
      modalHidden: Boolean(document.querySelector('#detailModal')?.hidden),
      managementHidden: Boolean(document.querySelector('#mydataView')?.hidden),
      mapVisible: document.querySelector('#mapView')?.classList.contains('active'),
    }), result.checks.contract.landMask.class1Example);
  } finally {
    await legacyTabPage.close();
  }

  result.checks.versionedData = {
    count: dataRequests.length,
    allVersioned: dataRequests.length > 0 && dataRequests.every(url => new URL(url).searchParams.get('v') === result.checks.initial.datasetId),
  };
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(100);
  await page.click('#openMydata');
  await page.waitForFunction(() => document.querySelector('#detailModal')?.hidden === false
    && document.querySelector('#mydataView')?.hidden === false);
  result.checks.mobileMydataManagement = await page.evaluate(() => {
    const form = document.querySelector('#itemForm');
    const modal = document.querySelector('#detailModal');
    const management = document.querySelector('#mydataView');
    const infoRect = document.querySelector('#mapInfoBar')?.getBoundingClientRect();
    const controlRects = [...document.querySelectorAll('.leaflet-top.leaflet-left .leaflet-control')]
      .map(control => control.getBoundingClientRect());
    return {
      modalVisible: !modal?.hidden && Boolean(modal?.getBoundingClientRect().height),
      managementVisible: !management?.hidden && Boolean(management?.getBoundingClientRect().height),
      formVisible: Boolean(form?.getBoundingClientRect().height),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      infoClearOfMapControls: Boolean(infoRect) && controlRects.length > 0
        && infoRect.left >= Math.max(...controlRects.map(rect => rect.right)) + 4,
    };
  });
  await page.click('#closeMydata');
  result.checks.mobileDisclosure = await page.evaluate(() => {
    const assumption = document.querySelector('#modelAssumption');
    const assumptionRect = assumption?.getBoundingClientRect();
    return {
      text: assumption?.textContent || '',
      visible: Boolean(assumptionRect?.width && assumptionRect?.height)
        && getComputedStyle(assumption).visibility !== 'hidden',
      insideControls: Boolean(assumption && document.querySelector('.controls')?.contains(assumption)),
      insideLegend: Boolean(assumption && document.querySelector('#legendBox')?.contains(assumption)),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const contract = result.checks.contract;
  const conditionApplicationOk = contract.conditionApplication?.mode === 'client_proxy'
    && contract.conditionApplication?.physical_recompute === false
    && contract.conditionApplication?.preset_path === 'presets.json';
  const wateringLinesOk = sameJson(contract.wateringLines, {
    pot_outdoor: { preset: 30, runtime: 30 },
    ground: { preset: 20, runtime: 20 },
    farm: { preset: 35, runtime: 35 },
  });
  const expectedWaterBalanceLength = contract.hourlyCount * 31296;
  const reforecastContractOk = contract.reforecast?.schema_version === 1
    && contract.reforecast?.dtype === 'float32'
    && contract.reforecast?.byte_order === 'little_endian'
    && contract.reforecast?.layout === 'row_major_hours_grid'
    && contract.reforecast?.bytes_per_value === 4
    && contract.reforecast?.unit === 'percentage_points_per_hour'
    && sameJson(contract.reforecast?.shape, [contract.hourlyCount, 31296])
    && contract.reforecast?.delta_index_semantics === 'delta_at_index_h_advances_state_from_h_minus_1_to_h'
    && contract.reforecast?.event_application === 'after_transition_at_event_index'
    && contract.reforecast?.water_full_target_pct === 95
    && contract.reforecast?.water_light_increment_pct === 40
    && contract.reforecast?.scope === 'standard_mode_water_balance_only'
    && typeof contract.reforecast?.first_index_note === 'string'
    && contract.reforecast.first_index_note.length > 0
    && typeof contract.reforecast?.privacy_note === 'string'
    && contract.reforecast.privacy_note.length > 0
    && sameMembers(Object.keys(contract.waterBalanceStats || {}), ['pot_outdoor', 'ground', 'farm'])
    && Object.values(contract.waterBalanceStats || {}).every(stats => stats.length === expectedWaterBalanceLength
      && stats.finite
      && Number.isFinite(stats.minimum) && Number.isFinite(stats.maximum)
      && stats.minimum <= stats.maximum && stats.minimum >= -500 && stats.maximum <= 500);
  const landMaskOk = contract.landMask?.schemaVersion === 1
    && contract.landMask?.gridCount === 31296
    && contract.landMask?.classesLength === 31296
    && sameJson(contract.landMask?.counts, { 0: 18887, 1: 12254, 2: 150, 3: 5 })
    && sameJson(contract.landMask?.manifestCounts, { 0: 18887, 1: 12254, 2: 150, 3: 5 })
    && sameJson(contract.landMask?.publicLandClasses, [1, 2])
    && contract.landMask?.sha256 === '2ccff1d901cf2cf8b90983aa3959f7636a64d55067167f322c2ebffc873f4394'
    && contract.landMask?.manifestSha256 === contract.landMask?.sha256
    && contract.landMask?.unknownLandClass === false
    && contract.landMask?.class0Example >= 0
    && contract.landMask?.class1Example >= 0
    && contract.landMask?.class2Example >= 0
    && contract.landMask?.class3Example >= 0
    && sameJson(contract.distributionStatsScope?.included_classes, [1, 2])
    && contract.distributionStatsScope?.grid_count === 12404;
  const controlContractOk = contract.conditionControls?.application === 'client_proxy'
    && contract.conditionControls?.physical_recompute === false
    && sameMembers(Object.keys(contract.conditionControls?.controls || {}), Object.keys(controlOptions))
    && Object.entries(controlOptions).every(([name, expected]) => {
      const options = contract.conditionControls?.controls?.[name]?.options || {};
      return sameMembers(Object.keys(options), expected)
        && Object.values(options).every(option => typeof option?.client_proxy?.moisture_offset_pct === 'number'
          && Number.isFinite(option.client_proxy.moisture_offset_pct)
          && option?.physical_target?.applied === false);
    })
    && Object.entries(controlOptions).every(([name, expected]) => sameJson(result.checks.controls[name], expected))
    && result.checks.conditionCombinations.count === 972
    && result.checks.conditionCombinations.errors.length === 0
    && result.checks.conditionCombinations.restored
    && result.checks.plantTypeOffsets.moist_lover < result.checks.plantTypeOffsets.foliage
    && result.checks.plantTypeOffsets.foliage < result.checks.plantTypeOffsets.dry
    && contract.conditionControls.controls.plant_type.options.moist_lover.client_proxy.moisture_offset_pct
      < contract.conditionControls.controls.plant_type.options.foliage.client_proxy.moisture_offset_pct
    && contract.conditionControls.controls.plant_type.options.foliage.client_proxy.moisture_offset_pct
      < contract.conditionControls.controls.plant_type.options.dry.client_proxy.moisture_offset_pct;
  const rootrotContractOk = sameJson(contract.manifestRootrot?.labels, rootrotLabels)
    && sameJson(contract.presetRootrot?.labels, rootrotLabels)
    && sameJson(contract.manifestRootrot?.wet_stress_ratio_thresholds, [0.3, 0.6, 1.0])
    && sameJson(contract.presetRootrot?.wet_stress_ratio_thresholds, [0.3, 0.6, 1.0])
    && contract.manifestRootrot?.public_values === 'stage_only'
    && contract.presetRootrot?.public_values === 'stage_only'
    && contract.rootrotCodes.length > 0
    && contract.rootrotCodes.every(value => Number.isInteger(value) && value >= 0 && value <= 3)
    && contract.rootrotReferences.checked === 24
    && contract.rootrotReferences.pointMatches
    && contract.rootrotReferences.windowMatches;
  const plantReferencesOk = contract.plantReferences.checked === 24
    && contract.plantReferences.windowChecked === 6
    && contract.plantReferences.pointMoistureMatches
    && contract.plantReferences.pointLabelMatches
    && contract.plantReferences.windowMoistureMatches
    && contract.plantReferences.windowLabelArgminMatches
    && contract.plantReferences.windowMoistureMismatches === 0
    && contract.plantReferences.windowLabelMismatches === 0;
  const expectedPlantSlots = [
    ['current', 'point'], ['plus3', 'point'], ['plus6', 'point'], ['tonight', 'point'],
    ['tomorrow_morning', 'point'], ['tomorrow_evening', 'point'], ['min48', 'window'], ['min72', 'window'],
  ];
  const expectedMedakaSlots = [
    ['current', 'point'], ['plus1', 'point'], ['plus3', 'point'],
    ['plus6', 'point'], ['plus15', 'point'], ['max24', 'window'],
  ];
  const slotContractOk = sameJson(contract.plantSlots.map(slot => [slot.id, slot.timeSemantics]), expectedPlantSlots)
    && sameJson(contract.medakaSlots.map(slot => [slot.id, slot.timeSemantics]), expectedMedakaSlots)
    && [...contract.plantSlots, ...contract.medakaSlots].every(slot => slot.timeSemantics === 'window'
      ? Boolean(slot.windowStart) && slot.windowEnd === slot.validtime
      : slot.windowStart === null && slot.windowEnd === null);
  const plantTimelineMin = Math.max(0, contract.currentIndex - contract.historyHours + 1);
  const medakaTimelineMin = Math.max(0, contract.currentIndex - 24);
  const medakaTimelineMax = Math.min(contract.hourlyCount - 1, contract.currentIndex + 15);
  const initialTimelineOk = result.checks.timelineInitial.min === plantTimelineMin
    && result.checks.timelineInitial.max === contract.hourlyCount - 1
    && result.checks.timelineInitial.step === 1
    && result.checks.timelineInitial.value === contract.currentIndex
    && result.checks.timelineInitial.timeIndex === contract.currentIndex
    && result.checks.timelineInitial.viewKind === 'hourly'
    && result.checks.timelineInitial.source === '実況'
    && result.checks.timelineInitial.readout.includes('実況')
    && result.checks.timelineInitial.readout.includes('現在');
  const selectedTimelineOk = result.checks.timelinePoint.viewKind === 'hourly'
    && result.checks.timelinePoint.source === '予報'
    && result.checks.timelinePoint.timeIndex === forecastIndex
    && result.checks.timelinePoint.readout.includes('+1h')
    && result.checks.timelinePoint.contextSource === '予報'
    && result.checks.timelinePoint.contextSlot === '+1h'
    && result.checks.timelineAggregate.viewKind === 'aggregate'
    && result.checks.timelineAggregate.source === '集計'
    && result.checks.timelineAggregate.contextSource === '集計'
    && result.checks.medaka.timelineMin === medakaTimelineMin
    && result.checks.medaka.timelineMax === medakaTimelineMax
    && result.checks.medaka.timelineStep === 1
    && result.checks.medakaAggregate.viewKind === 'aggregate'
    && result.checks.medakaAggregate.source === '集計';
  const partialDisplayOk = result.checks.partialLabelExample === '48h内最小（37h分）'
    && aggregateSlotIndex >= 0
    && result.checks.timelineAggregate.readout.includes(aggregateDisplayLabel)
    && result.checks.timelineAggregate.contextSlot.includes(aggregateDisplayLabel)
    && result.checks.imageSave.ready.length > 0
    && !result.checks.imageSave.error
    && result.checks.imageSave.slotLabel === aggregateDisplayLabel
    && ['100%', '90%', '80%', '70%', '60%', '50%', '40%', '30%', '20%', '10%', '0%']
      .every(label => result.checks.imageSave.texts.includes(label))
    && result.checks.imageSave.texts.includes('湿潤')
    && result.checks.imageSave.texts.includes('乾燥')
    && result.checks.imageSave.texts.some(text => text.includes(aggregateDisplayLabel));
  const rootrotCountKeys = Object.keys(JSON.parse(result.checks.rootrot.counts || '{}')).map(Number);
  const rootrotUiOk = sameJson(result.checks.rootrot.legendLabels, rootrotLabels)
    && rootrotCountKeys.length > 0
    && rootrotCountKeys.every(value => Number.isInteger(value) && value >= 0 && value <= 3);
  const observedWindowLabels = { rain3h: '3時間積算降水', rain6h: '6時間積算降水', rain12h: '12時間積算降水' };
  const observedWindowsOk = Object.entries(observedWindowLabels).every(([kind, label]) => result.checks.observedWindows[kind]?.canvasVisible
    && result.checks.observedWindows[kind]?.observed.includes(label));
  result.checks.contractGate = {
    landMaskOk,
    conditionApplicationOk,
    wateringLinesOk,
    reforecastContractOk,
    controlContractOk,
    rootrotContractOk,
    plantReferencesOk,
    slotContractOk,
    initialTimelineOk,
    selectedTimelineOk,
    partialDisplayOk,
    rootrotUiOk,
    observedWindowsOk,
  };
  if (process.env.WATER_CARE_AUDIT_SCREENSHOT) {
    await page.screenshot({ path: process.env.WATER_CARE_AUDIT_SCREENSHOT, fullPage: true });
  }
  result.failedResponses = failedResponses;
  result.consoleProblems = consoleProblems;
  result.ok = failedResponses.length === 0
    && consoleProblems.length === 0
    && result.checks.initial.layer === 'moisture'
    && result.checks.initial.slots === 0
    && result.checks.initial.floatingHidden
    && result.checks.initial.mydataHidden
    && result.checks.initial.modalHidden
    && result.checks.initial.modelDisclosureVisible
    && result.checks.initial.modelDisclosure.includes('簡易補正')
    && result.checks.initial.modelDisclosure.includes('物理モデル再計算ではありません')
    && result.checks.initial.modelDisclosure.includes('マイデータ')
    && result.checks.initial.modelAssumptionVisible
    && result.checks.initial.modelAssumptionInsideControls
    && !result.checks.initial.modelAssumptionInsideLegend
    && result.checks.initial.modelAssumption.includes('7日前に60%で開始')
    && result.checks.initial.modelAssumption.includes('実際の水やり未反映')
    && result.checks.initial.modelAssumption.includes('実測校正未了')
    && result.checks.initial.calculationMethod === '標準計算＋簡易条件補正'
    && result.checks.initial.legend.kind === 'moisture'
    && result.checks.initial.legend.width <= 104
    && result.checks.initial.legend.scaleHeight >= 248
    && result.checks.initial.legend.barWidth >= 20
    && result.checks.initial.legend.barWidth <= 28
    && sameJson(result.checks.initial.legend.ticks, ['100%', '90%', '80%', '70%', '60%', '50%', '40%', '30%', '20%', '10%', '0%'])
    && sameJson(result.checks.initial.legend.endpointWords, ['湿潤', '乾燥'])
    && result.checks.initial.legend.topLabelAboveBar
    && result.checks.initial.legend.bottomLabelBelowBar
    && result.checks.initial.subjectStyle.color === 'rgb(23, 53, 47)'
    && result.checks.initial.subjectStyle.background !== 'rgb(23, 53, 47)'
    && result.checks.initial.subjectStyle.accentWidth >= 3
    && result.checks.initial.mapView.zoom >= 5.5
    && result.checks.initial.mapView.containsWakkanai
    && result.checks.initial.mapView.containsKagoshima
    && result.checks.initial.landGridCount === 12404
    && result.checks.initial.landMaskSha === '2ccff1d901cf2cf8b90983aa3959f7636a64d55067167f322c2ebffc873f4394'
    && result.checks.initial.valueCountTotal === 12404
    && result.checks.initial.layerText === 'うるおい残量MAP'
    && result.checks.initial.modeText === '屋外鉢植え・標準'
    && result.checks.initial.sourceText === '実況'
    && result.checks.initial.targetLabel === '現在'
    && result.checks.initial.targetDate === result.checks.initial.expectedDate
    && result.checks.initial.targetClock === result.checks.initial.expectedClock
    && result.checks.initial.homeLink.href === 'https://naturewxlab.com/'
    && result.checks.initial.homeLink.ariaLabel === 'Nature Wx Lab公式サイトへ戻る'
    && result.checks.initial.homeLink.title === 'Nature Wx Lab公式サイトへ戻る'
    && result.checks.initial.homeLink.visible
    && result.checks.initial.homeLink.backgroundColor !== 'rgba(0, 0, 0, 0)'
    && result.checks.initial.homeLink.borderStyle === 'solid'
    && result.checks.initial.removedLongCopyAbsent
    && result.checks.initial.contextSplit
    && result.checks.initial.contextCardsSeparated
    && result.checks.initial.obsoleteStampAbsent
    && result.checks.initial.infoTitleComplete
    && result.checks.initial.infoClearOfMapControls
    && result.checks.initial.landMaskNote.includes('31,296格子')
    && result.checks.initial.landMaskNote.includes('日本陸域12,404格子')
    && result.checks.initial.activeBase === 'pale'
    && result.checks.initial.activeBaseButton === 'pale'
    && result.checks.initial.paleLayerActive
    && result.checks.initial.referenceLandActive
    && result.checks.initial.referenceFeatureCount === 14
    && result.checks.initial.referenceBaseRequested
    && !result.checks.initial.gsiPaleTileRequested
    && !result.checks.initial.terrainLayerActive
    && !result.checks.initial.terrainChecked
    && result.checks.initial.analysisOpacityControl === 50
    && Math.abs(result.checks.initial.analysisOpacityRuntime - 0.5) < 0.001
    && result.checks.initial.mapBackground === 'rgb(228, 238, 245)'
    && result.checks.initial.layout.timelineAboveStage
    && result.checks.initial.layout.mapStartsInsideStage
    && result.checks.initial.layout.infoInsideStage
    && result.checks.initial.layout.legendInsideStage
    && result.checks.initial.layout.noPageOverflow
    && result.checks.initial.layout.timelineHeight > 30
    && result.checks.initial.layout.timelineHeight < 90
    && result.checks.initial.layout.stageHeight > 500
    && result.checks.initial.sampleCell?.width > 0.8
    && result.checks.initial.sampleCell?.width < 3
    && result.checks.initial.sampleCell?.height > 0.8
    && result.checks.initial.sampleCell?.height < 3
    && (requireStale
      ? result.checks.initial.stale === 'true'
        && result.checks.initial.staleReasons.length >= 2
        && result.checks.initial.healthText === '更新遅延'
        && result.checks.initial.statusText.includes('更新されていません')
      : (allowStale || result.checks.initial.stale === 'false'))
    && result.checks.initialCanvas.width > 0
    && result.checks.initialCanvas.height > 0
    && result.checks.initialCanvas.colored > 10
    && result.checks.initialCanvas.maxAlpha >= 125
    && result.checks.initialCanvas.maxAlpha <= 130
    && result.checks.analysisOpacity.initialValue === 50
    && result.checks.analysisOpacity.restoredValue === 50
    && Math.abs(result.checks.analysisOpacity.restoredRuntime - 0.5) < 0.001
    && result.checks.analysisOpacity.offscreenPaintCanvas
    && result.checks.analysisOpacity.samples.every(sample => Math.abs(sample.runtime - sample.value / 100) < 0.001
      && Math.abs(sample.alpha - sample.value / 100) < 0.015)
    && result.checks.placeLabels.schemaVersion === 1
    && result.checks.placeLabels.sourceId === 'station_inventory_current_temperature'
    && result.checks.placeLabels.sourcePath === 'data/weather/japan_all_stations/station_inventory_current_temperature.csv'
    && result.checks.placeLabels.sourceSha === '081b3c91b1c71f63cf774788dee024e97e6dbccb962e8c3356bb4b46ba03e4dd'
    && result.checks.placeLabels.sourceRows === 918
    && result.checks.placeLabels.labelCount === 923
    && result.checks.placeLabels.stationLabelCount === 918
    && result.checks.placeLabels.regionalLabelCount === 5
    && result.checks.placeLabels.actualLabels === 923
    && result.checks.placeLabels.runtimeLabels === 923
    && sameJson(result.checks.placeLabels.rankCounts, { 0: 62, 1: 103, 2: 758 })
    && result.checks.placeLabels.cacheVersioned
    && result.checks.placeLabels.requestUrl.includes('v=station-labels-v2-291e9c72')
    && result.checks.placeLabels.rankContract
    && result.checks.placeLabels.regionalLabelsComplete
    && result.checks.placeLabels.noPrefectureLabels
    && result.checks.placeLabels.renderContract?.initial_leaflet_zoom === 5
    && sameJson(result.checks.placeLabels.renderContract?.max_labels, [
      { zoom_ratio_below: 1.6, count: 38 },
      { zoom_ratio_below: 2.8, count: 82 },
      { zoom_ratio_below: null, count: 220 },
    ])
    && sameJson(result.checks.placeLabels.renderContract?.visual_contract, {
      device_pixel_ratio_independent: true,
      font_size_css_px: [9, 10, 11],
      font_weight: 700,
      primary_dot_radius_css_px: 1.8,
      secondary_dot_radius_css_px: 1.2,
      default_css_opacity: 0.72,
      label_free_default_basemap: true,
    })
    && result.checks.placeLabels.initialControlOpacity === 72
    && result.checks.placeLabels.toggleChecked
    && result.checks.placeLabels.canvasVisible
    && result.checks.placeLabels.initial.zoom >= 5.5
    && Math.abs(result.checks.placeLabels.initial.zoomRatio
      - Math.max(1, 2 ** (result.checks.placeLabels.initial.zoom - 5))) < 0.001
    && result.checks.placeLabels.initial.maxLabels
      === (result.checks.placeLabels.initial.zoomRatio < 1.6 ? 38
        : result.checks.placeLabels.initial.zoomRatio < 2.8 ? 82 : 220)
    && result.checks.placeLabels.initial.fontSize
      === (result.checks.placeLabels.initial.zoomRatio < 1.5 ? 9
        : result.checks.placeLabels.initial.zoomRatio < 3 ? 10 : 11)
    && result.checks.placeLabels.initial.fontWeight === 700
    && Math.abs(result.checks.placeLabels.initial.opacity - 0.72) < 0.001
    && result.checks.placeLabels.initial.drawn > 0
    && result.checks.placeLabels.initial.drawn <= 38
    && result.checks.placeLabels.initial.candidates >= result.checks.placeLabels.initial.drawn
    && result.checks.placeLabels.initial.collisionSkipped > 0
    && result.checks.placeLabelZoom.zoom === result.checks.placeLabels.initial.zoom + 1
    && Math.abs(result.checks.placeLabelZoom.zoomRatio
      - Math.max(1, 2 ** (result.checks.placeLabelZoom.zoom - 5))) < 0.001
    && result.checks.placeLabelZoom.maxLabels
      === (result.checks.placeLabelZoom.zoomRatio < 1.6 ? 38
        : result.checks.placeLabelZoom.zoomRatio < 2.8 ? 82 : 220)
    && result.checks.placeLabelZoom.fontSize
      === (result.checks.placeLabelZoom.zoomRatio < 1.5 ? 9
        : result.checks.placeLabelZoom.zoomRatio < 3 ? 10 : 11)
    && result.checks.placeLabelZoom.drawSequence > result.checks.placeLabels.initial.drawSequence
    && result.checks.placeLabelZoom.drawn > result.checks.placeLabels.initial.drawn
    && contract.schemaVersion >= 4
    && contract.generatorVersion === 5
    && contract.distributionStatsBasis === 'pre_quantized_float'
    && landMaskOk
    && contract.datasetId === result.checks.initial.datasetId
    && Boolean(contract.manifestModelVersion)
    && contract.manifestModelVersion === contract.presetModelVersion
    && Boolean(contract.manifestPresetVersion)
    && contract.manifestPresetVersion === contract.presetVersion
    && conditionApplicationOk
    && wateringLinesOk
    && reforecastContractOk
    && controlContractOk
    && rootrotContractOk
    && plantReferencesOk
    && slotContractOk
    && initialTimelineOk
    && selectedTimelineOk
    && partialDisplayOk
    && sameJson(result.checks.observedOptions, observedOptions)
    && result.checks.watering.layer === '水やりナビMAP'
    && result.checks.watering.modelDisclosureVisible
    && result.checks.watering.modelAssumption === result.checks.initial.modelAssumption
    && result.checks.watering.calculationMethod === '標準計算の判定6種'
    && result.checks.watering.legendDiscrete
    && sameJson(result.checks.watering.legendLabels, ['水やり候補', '水やり不要', '雨で回復', '水やり見送り', '湿り気味', '根腐れ注意'])
    && result.checks.rootrot.layer === '根腐れ注意MAP'
    && result.checks.rootrot.modelAssumption === result.checks.initial.modelAssumption
    && result.checks.rootrot.calculationMethod === '標準条件wetStressの4段階'
    && result.checks.rootrot.legendDiscrete
    && rootrotUiOk
    && result.checks.medaka.slots === 0
    && result.checks.medaka.layer === 'メダカあふれリスクMAP'
    && result.checks.medaka.modelDisclosureHidden
    && result.checks.medaka.medakaDisclosure.includes('実測校正未了')
    && result.checks.medaka.modelAssumption !== result.checks.initial.modelAssumption
    && result.checks.medaka.modelAssumption.includes('メダカ条件')
    && result.checks.medaka.modelAssumption.includes('60Lトロ舟')
    && result.checks.medaka.modelAssumption.includes('満水まで3cm')
    && result.checks.medaka.modelAssumption.includes('2L/h')
    && result.checks.medaka.modelAssumption.includes('実測校正未了')
    && result.checks.medaka.calculationMethod === '選択した容器条件で計算'
    && result.checks.medaka.legendDiscrete
    && sameJson(result.checks.medaka.legendLabels, ['低', '中', '高', '非常に高'])
    && result.checks.mobileDisclosure.visible
    && result.checks.mobileDisclosure.insideControls
    && !result.checks.mobileDisclosure.insideLegend
    && result.checks.mobileDisclosure.noHorizontalOverflow
    && result.checks.mobileDisclosure.text === result.checks.initial.modelAssumption
    && result.checks.mobileMydataManagement.modalVisible
    && result.checks.mobileMydataManagement.managementVisible
    && result.checks.mobileMydataManagement.formVisible
    && result.checks.mobileMydataManagement.noHorizontalOverflow
    && result.checks.mobileMydataManagement.infoClearOfMapControls
    && observedWindowsOk
    && result.checks.rainDifference.observed.includes('24時間降水 前日差')
    && result.checks.rainDifference.canvasVisible
    && result.checks.landSelectionDistance.exactGrid === contract.landMask.class1Example
    && result.checks.landSelectionDistance.distantOceanGrid === -1
    && result.checks.landSelectionDistance.hitRadiusSquared === 0.004
    && result.checks.locationLabel.gridId === 13463
    && result.checks.locationLabel.landClass === 1
    && result.checks.locationLabel.resolved === '埼玉県加須市付近'
    && result.checks.locationLabel.cached === result.checks.locationLabel.resolved
    && Number.isFinite(result.checks.locationLabel.latitude)
    && Number.isFinite(result.checks.locationLabel.longitude)
    && result.checks.detail.floatingHidden
    && result.checks.detail.modalVisible
    && [1, 2].includes(result.checks.detail.landClass)
    && result.checks.detail.gridIdAttribute === result.checks.detail.selectedGrid
    && result.checks.detail.grid.includes('付近')
    && !result.checks.detail.grid.startsWith(`格子 ${result.checks.detail.selectedGrid}`)
    && result.checks.detail.chartAria.includes('右軸・mm')
    && result.checks.detail.rainUnit === 'mm'
    && Number.isFinite(result.checks.detail.rainDataMax)
    && Number.isFinite(result.checks.detail.rainAxisMax)
    && Number.isFinite(result.checks.detail.rainAxisStep)
    && result.checks.detail.rainDataMax >= 0
    && result.checks.detail.rainAxisMax >= result.checks.detail.rainDataMax
    && result.checks.detail.rainAxisStep > 0
    && result.checks.mapClickRoundTrip.clicks === 3
    && result.checks.mapClickRoundTrip.firstGrid !== result.checks.mapClickRoundTrip.secondGrid
    && result.checks.mapClickRoundTrip.selectedGrid === result.checks.mapClickRoundTrip.secondGrid
    && result.checks.mapClickRoundTrip.modalVisible
    && result.checks.unassignedLand.landClass === 2
    && result.checks.unassignedLand.calendarTitle.startsWith('管理カレンダー｜')
    && !result.checks.unassignedLand.calendarTitle.includes('格子 ')
    && result.checks.unassignedLand.calendarText.includes('週間傾向なし')
    && result.checks.unassignedLand.calendarText.includes('都道府県未割当')
    && result.checks.legacyOutsideGrid.landClass === 0
    && result.checks.legacyOutsideGrid.detailGrid.includes('陸域マスク外（旧登録）')
    && result.checks.legacyOutsideGrid.floatingGrid === result.checks.legacyOutsideGrid.detailGrid
    && result.checks.legacyOutsideGrid.detailLabel === '対象外'
    && result.checks.legacyOutsideGrid.detailReason.includes('地図上の陸域を選び直してください')
    && result.checks.legacyOutsideGrid.itemGrid.includes('陸域マスク外・再選択')
    && result.checks.legacyOutsideGrid.status.includes('地図上の陸域を選び直してください')
    && result.checks.legacyOutsideGrid.itemStatus === '陸域マスク外（旧登録）'
    && result.checks.legacyForeignGrid.landClass === 3
    && result.checks.legacyForeignGrid.detailGrid.includes('日本国外陸域・対象外')
    && result.checks.legacyForeignGrid.floatingGrid === result.checks.legacyForeignGrid.detailGrid
    && result.checks.legacyRecovery.landClass === 1
    && result.checks.legacyRecovery.status.includes('付近')
    && !result.checks.legacyRecovery.status.includes('マスク外')
    && result.checks.legacySharedOutside.landClass === 0
    && result.checks.legacySharedOutside.floatingVisible
    && result.checks.legacySharedOutside.floatingGrid.includes('陸域マスク外（旧登録）')
    && result.checks.legacySharedOutside.status.includes('共有リンクの地点')
    && result.checks.legacyTabIgnored.selectedGrid === result.checks.legacyTabIgnored.expectedGrid
    && result.checks.legacyTabIgnored.modalHidden
    && result.checks.legacyTabIgnored.managementHidden
    && result.checks.legacyTabIgnored.mapVisible
    && result.checks.mydataLazyBefore
    && result.checks.importSanitization.forbidden.length === 0
    && result.checks.importSanitization.gridId === result.checks.contract.landMask.class1Example
    && sameJson(Object.keys(result.checks.importSanitization.location).sort(), ['grid_id', 'label'])
    && sameMembers(result.checks.importSanitization.logTypes, ['water_full', 'rain_cover'])
    && result.checks.importSanitization.advancedKeys.length === 0
    && result.checks.importSanitization.observations === 0
    && result.checks.mydataManagementOpen.modalVisible
    && result.checks.mydataManagementOpen.managementVisible
    && result.checks.mydataManagementOpen.detailHidden
    && result.checks.mydataManagementOpen.commonModal
    && result.checks.mydataManagementOpen.formVisible
    && result.checks.mydataSetup.lazyAfter
    && result.checks.mydataSetup.registeredGridMatches
    && result.checks.mydataSetup.eventCount === 2
    && result.checks.mydataSetup.replayMaxError < 0.0001
    && result.checks.mydataSetup.replayFiniteBounded
    && result.checks.mydataSetup.searchMatches
    && result.checks.mydataSetup.unchangedBeforeEvent
    && result.checks.mydataSetup.oldLogIgnored
    && result.checks.mydataSetup.oldLogUnchanged
    && result.checks.mydataSetup.futureLogIgnored
    && result.checks.mydataSetup.futureLogUnchanged
    && result.checks.mydataSetup.miniCards === 1
    && result.checks.mydataSetup.miniText.includes('監査用マイデータ')
    && result.checks.mydataSetup.managementText.includes('監査用マイデータ')
    && result.checks.mydataSetup.mapWetExists === false
    && result.checks.mydataDetail.modalItemId === result.checks.mydataSetup.itemId
    && result.checks.mydataDetail.grid.includes('監査用マイデータ')
    && result.checks.mydataDetail.moisture === result.checks.mydataSetup.expectedModalMoisture
    && result.checks.mydataDetail.reason.includes('以降を再計算')
    && result.checks.mydataDetail.conditions.includes('屋外鉢植え')
    && result.checks.mydataDetail.conditions.includes('標準観葉植物')
    && result.checks.mydataDetail.conditions.includes('乾きやすさ 標準')
    && result.checks.mydataDetail.conditions.includes('雨の効きやすさ 標準')
    && result.checks.mydataDetail.conditions.includes('補正値はまだ物理再計算へ反映しません')
    && result.checks.mydataDetail.calendar.includes('水やり記録を反映')
    && result.checks.mydataDetail.actionsVisible
    && sameMembers(result.checks.mydataDetail.visibleLogTypes, ['water_full', 'water_light', 'rain_cover'])
    && result.checks.mydataDetail.chartVisible
    && result.checks.mydataDetail.detailVisible
    && result.checks.mydataDetail.managementHidden
    && result.checks.mydataManagementReturn.modalVisible
    && result.checks.mydataManagementReturn.managementVisible
    && result.checks.mydataManagementReturn.detailHidden
    && result.checks.mydataManagementReturn.itemVisible
    && result.checks.mydataMedakaNoStaleChart.chartHidden
    && result.checks.mydataMedakaNoStaleChart.titleHidden
    && result.checks.mydataMedakaNoStaleChart.chartCleared
    && sameMembers(result.checks.mydataMedakaNoStaleChart.visibleLogTypes, ['water_change', 'top_up', 'rain_cover'])
    && result.checks.mydataMedakaNoStaleChart.conditions.includes('メダカ容器')
    && result.checks.mydataMedakaLog.stored
    && result.checks.mydataMedakaLog.logCount === 3
    && sameMembers(result.checks.mydataMedakaLog.logTypes, ['water_change', 'top_up', 'rain_cover'])
    && result.checks.mydataMedakaLog.validTimestamp
    && result.checks.mydataMedakaLog.modalItemId === 'audit-medaka-item'
    && result.checks.mydataOutsideNoStaleChart.chartHidden
    && result.checks.mydataOutsideNoStaleChart.titleHidden
    && result.checks.mydataOutsideNoStaleChart.chartCleared
    && result.checks.mydataOutsideNoStaleChart.logButtonsHidden
    && result.checks.mydataOutsideNoStaleChart.visibleLogTypes.length === 0
    && result.checks.mydataOutsideNoStaleChart.label === '対象外'
    && result.checks.mapDetailRestoredAfterMydata.selectedGrid === result.checks.mapDetailRestoredAfterMydata.expectedGrid
    && result.checks.mapDetailRestoredAfterMydata.modalItemId === ''
    && result.checks.mapDetailRestoredAfterMydata.grid.includes('付近')
    && !result.checks.mapDetailRestoredAfterMydata.grid.includes(`格子 ${result.checks.mapDetailRestoredAfterMydata.expectedGrid}`)
    && result.checks.mapDetailRestoredAfterMydata.actionsHidden
    && result.checks.mapDetailRestoredAfterMydata.conditionsHidden
    && result.checks.mapDetailRestoredAfterMydata.chartVisible
    && result.checks.mapDetailRestoredAfterMydata.detailVisible
    && result.checks.mapDetailRestoredAfterMydata.managementHidden
    && result.checks.labelOpacity.value === 35
    && Math.abs(result.checks.labelOpacity.runtime - 0.35) < 0.001
    && Math.abs(result.checks.labelOpacity.canvasOpacity - 0.35) < 0.001
    && Math.abs(result.checks.labelOpacity.statsOpacity - 0.35) < 0.001
    && result.checks.labelOpacity.initiallyAdded
    && result.checks.labelOpacity.removedWhenOff
    && result.checks.labelOpacity.restoredWhenOn
    && sameJson(result.checks.legacyConditions, {
      mapPlant: 'foliage', mapSize: 'large', mapDrying: 'dry',
      mapRain: 'inside', mapSun: 'sun', mapSpeed: 'fast',
    })
    && result.checks.sharedPrivacy.conditions.length === 6
    && result.checks.sharedPrivacy.base === 'pale'
    && result.checks.sharedPrivacy.opacity === 35
    && Math.abs(result.checks.sharedPrivacy.runtimeOpacity - 0.35) < 0.001
    && !result.checks.sharedPrivacy.hasTab
    && !result.checks.sharedPrivacy.hasMydataId
    && !result.checks.sharedPrivacy.hasMydataName
    && !result.checks.sharedPrivacy.hasObsoleteWetValue
    && !result.checks.mydataNetwork.containsItemId
    && !result.checks.mydataNetwork.containsItemName
    && result.checks.versionedData.allVersioned;
} catch (error) {
  result.failure = String(error?.stack || error);
  result.failedResponses = failedResponses;
  result.consoleProblems = consoleProblems;
  result.ok = false;
} finally {
  const output = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = process.env.WATER_CARE_AUDIT_OUTPUT || '/tmp/water-care-audit.json';
  writeFileSync(outputPath, output);
  console.log(output);
  await browser.close();
}

process.exit(result.ok ? 0 : 1);

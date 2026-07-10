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
const consoleProblems = [];
const failedResponses = [];
const dataRequests = [];
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
    && /\/xyz\/(?:blank|hillshademap)\//.test(url);
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
    const context = canvas.getContext('2d');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const stride = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4);
    let colored = 0;
    for (let index = 3; index < pixels.length; index += stride) {
      if (pixels[index] > 0 && ++colored > 10) break;
    }
    return { width: canvas.width, height: canvas.height, colored };
  });
}

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.datasetId), null, { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#mapInfoBar')?.textContent.startsWith('うるおい残量MAP')
    && ['true', 'false'].includes(document.querySelector('#mapInfoBar')?.dataset.stale), null, { timeout: 120000 });
  result.checks.initial = await page.evaluate(() => {
    const assumption = document.querySelector('#modelAssumption');
    const assumptionRect = assumption?.getBoundingClientRect();
    const mapPanelRect = document.querySelector('.map-panel')?.getBoundingClientRect();
    return {
      datasetId: document.documentElement.dataset.datasetId,
      layer: document.querySelector('#analysisLayer')?.value,
      info: document.querySelector('#mapInfoBar')?.textContent,
      stale: document.querySelector('#mapInfoBar')?.dataset.stale,
      floatingHidden: document.querySelector('#floatingDetail')?.hidden,
      mydataHidden: document.querySelector('#mydataView')?.hidden,
      modalHidden: document.querySelector('#detailModal')?.hidden,
      slots: document.querySelectorAll('[data-slot-index]').length,
      modelDisclosure: document.querySelector('#modelDisclosure')?.textContent || '',
      modelDisclosureVisible: !document.querySelector('#conditionNote')?.hidden,
      modelAssumption: assumption?.textContent || '',
      modelAssumptionVisible: Boolean(assumptionRect?.width && assumptionRect?.height)
        && getComputedStyle(assumption).visibility !== 'hidden',
      modelAssumptionInsideMap: Boolean(assumptionRect && mapPanelRect)
        && assumptionRect.left >= mapPanelRect.left && assumptionRect.right <= mapPanelRect.right
        && assumptionRect.top >= mapPanelRect.top && assumptionRect.bottom <= mapPanelRect.bottom,
      landGridCount: Number(document.documentElement.dataset.landGridCount),
      landMaskSha: document.documentElement.dataset.landMaskSha || '',
      valueCountTotal: Number(document.querySelector('#mapStampText')?.dataset.valueCountTotal),
      stamp: document.querySelector('#mapStampText')?.textContent || '',
      landMaskNote: document.querySelector('#landMaskNote')?.textContent || '',
    };
  });
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
    for (const [mode, refs] of Object.entries(manifest.hourly?.files || {})) {
      const [moistureResponse, labelResponse, rootrotResponse] = await Promise.all([
        fetch(`./data/${refs.moisture}?v=${encodeURIComponent(manifest.dataset_id)}`),
        fetch(`./data/${refs.labels}?v=${encodeURIComponent(manifest.dataset_id)}`),
        fetch(`./data/${refs.rootrot_labels}?v=${encodeURIComponent(manifest.dataset_id)}`),
      ]);
      if (!moistureResponse.ok) throw new Error(`hourly moisture audit ${moistureResponse.status}`);
      if (!labelResponse.ok) throw new Error(`hourly label audit ${labelResponse.status}`);
      if (!rootrotResponse.ok) throw new Error(`rootrot audit ${rootrotResponse.status}`);
      const moisture = new Uint8Array(await moistureResponse.arrayBuffer());
      const labels = new Uint8Array(await labelResponse.arrayBuffer());
      const rootrot = new Uint8Array(await rootrotResponse.arrayBuffer());
      plantHourly[mode] = { moisture, labels, rootrot };
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
  result.checks.controls = await page.evaluate(ids => Object.fromEntries(Object.entries(ids).map(([name, id]) => {
    const element = document.getElementById(id);
    return [name, [...(element?.options || [])].map(option => option.value)];
  })), controlElements);
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
      && document.querySelector('#mapInfoBar')?.textContent.includes('+1h');
  }, forecastIndex);
  result.checks.timelinePoint = await page.evaluate(() => ({
    viewKind: document.querySelector('#timeline')?.dataset.viewKind,
    source: document.querySelector('#timeline')?.dataset.source,
    timeIndex: Number(document.querySelector('#timeline')?.dataset.timeIndex),
    readout: document.querySelector('#timelineReadout')?.textContent,
    stamp: document.querySelector('#mapStampText')?.textContent,
    info: document.querySelector('#mapInfoBar')?.textContent,
  }));

  const partialSlotIndex = result.checks.contract.plantSlots.findIndex(slot => slot.timeSemantics === 'window' && slot.status === 'partial');
  const aggregateSlotIndex = partialSlotIndex >= 0
    ? partialSlotIndex
    : result.checks.contract.plantSlots.findIndex(slot => slot.timeSemantics === 'window');
  const aggregateSlot = result.checks.contract.plantSlots[aggregateSlotIndex];
  const aggregateDisplayLabel = aggregateSlot?.status === 'partial'
    ? `${aggregateSlot.label}（${aggregateSlot.availableHours}h分）`
    : aggregateSlot?.label;
  await page.click(`[data-slot-index="${aggregateSlotIndex}"]`);
  await page.waitForFunction(({ index, label }) => document.querySelector('#timeline')?.dataset.viewKind === 'aggregate'
    && document.querySelector('#timeline')?.dataset.source === '集計'
    && document.querySelector('[data-slot-index].active')?.dataset.slotIndex === String(index)
    && document.querySelector('[data-slot-index].active')?.textContent === label
    && document.querySelector('#timelineReadout')?.textContent.includes(label)
    && document.querySelector('#mapInfoBar')?.textContent.includes(label)
    && document.querySelector('#mapStampText')?.textContent.includes(label), { index: aggregateSlotIndex, label: aggregateDisplayLabel });
  result.checks.timelineAggregate = await page.evaluate(() => ({
    viewKind: document.querySelector('#timeline')?.dataset.viewKind,
    source: document.querySelector('#timeline')?.dataset.source,
    timeIndex: Number(document.querySelector('#timeline')?.dataset.timeIndex),
    activeShortcut: document.querySelector('[data-slot-index].active')?.dataset.slotIndex,
    buttonLabel: document.querySelector('[data-slot-index].active')?.textContent,
    readout: document.querySelector('#timelineReadout')?.textContent,
    stamp: document.querySelector('#mapStampText')?.textContent,
    info: document.querySelector('#mapInfoBar')?.textContent,
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

  await page.click('[data-slot-index="0"]');
  await page.waitForFunction(index => document.querySelector('#timeline')?.dataset.viewKind === 'hourly'
    && document.querySelector('#timeline')?.dataset.source === '実況'
    && Number(document.querySelector('#timeline')?.dataset.timeIndex) === index, result.checks.contract.currentIndex);

  await page.selectOption('#analysisLayer', 'watering');
  await page.waitForFunction(() => document.querySelector('#mapInfoBar')?.textContent.startsWith('水やりナビMAP'));
  result.checks.watering = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    modelDisclosureVisible: !document.querySelector('#conditionNote')?.hidden,
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
  }));

  await page.selectOption('#analysisLayer', 'rootrot');
  await page.waitForFunction(() => document.querySelector('#mapInfoBar')?.textContent.startsWith('根腐れ注意MAP'));
  result.checks.rootrot = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    counts: document.querySelector('#mapStampText')?.dataset.valueCounts,
    legendLabels: [...document.querySelectorAll('#legendNote span')].map(element => element.textContent),
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
  }));

  await page.selectOption('#analysisLayer', 'medaka');
  await page.waitForFunction(() => document.querySelectorAll('[data-slot-index]').length === 6
    && document.querySelector('#mapInfoBar')?.textContent.startsWith('メダカあふれリスクMAP'));
  result.checks.medaka = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    slots: document.querySelectorAll('[data-slot-index]').length,
    timelineMin: Number(document.querySelector('#timelineRange')?.min),
    timelineMax: Number(document.querySelector('#timelineRange')?.max),
    timelineStep: Number(document.querySelector('#timelineRange')?.step),
    modelDisclosureHidden: Boolean(document.querySelector('#conditionNote')?.hidden),
    medakaDisclosure: document.querySelector('#medakaDisclosure')?.textContent || '',
    modelAssumption: document.querySelector('#modelAssumption')?.textContent || '',
  }));

  await page.click('[data-slot-index="5"]');
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
      && document.querySelector('#mapInfoBar')?.textContent.includes(document.querySelector('#observedLayer')?.selectedOptions[0]?.textContent), kind);
    result.checks.observedWindows[kind] = await page.evaluate(() => ({
      info: document.querySelector('#mapInfoBar')?.textContent,
      canvasVisible: !document.querySelector('.amedas-rain-canvas')?.hidden,
    }));
  }

  await page.selectOption('#observedLayer', 'rain24hDiff');
  await page.waitForFunction(() => document.querySelector('#mapInfoBar')?.textContent.includes('24時間降水 前日差'));
  result.checks.rainDifference = await page.evaluate(() => ({
    info: document.querySelector('#mapInfoBar')?.textContent,
    canvasVisible: !document.querySelector('.amedas-rain-canvas')?.hidden,
  }));

  result.checks.landSelectionDistance = await page.evaluate(gridId => {
    const latitude = analysis.points[gridId * 2];
    const longitude = analysis.points[gridId * 2 + 1];
    return {
      exactGrid: nearestGrid({ lat: latitude, lng: longitude }),
      distantOceanGrid: nearestGrid({ lat: 0, lng: 0 }),
      hitRadiusSquared: LAND_GRID_HIT_RADIUS2,
    };
  }, result.checks.contract.landMask.class1Example);

  const map = page.locator('#map');
  const box = await map.boundingBox();
  if (!box) throw new Error('map has no bounding box');
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.52);
  await page.waitForFunction(() => document.querySelector('#floatingDetail')?.hidden === false);
  await page.click('#openDetailModal');
  result.checks.detail = await page.evaluate(() => ({
    grid: document.querySelector('#floatingGrid')?.textContent,
    selectedGrid: analysis.selectedGrid,
    landClass: analysis.landClasses?.[analysis.selectedGrid],
    floatingVisible: !document.querySelector('#floatingDetail')?.hidden,
    modalVisible: !document.querySelector('#detailModal')?.hidden,
  }));
  await page.click('#detailModalClose');
  await page.click('#floatingClose');

  await page.selectOption('#analysisLayer', 'moisture');
  await page.waitForFunction(() => document.querySelector('#mapInfoBar')?.textContent.startsWith('うるおい残量MAP'));
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

  result.checks.versionedData = {
    count: dataRequests.length,
    allVersioned: dataRequests.length > 0 && dataRequests.every(url => new URL(url).searchParams.get('v') === result.checks.initial.datasetId),
  };
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(100);
  result.checks.mobileDisclosure = await page.evaluate(() => {
    const assumption = document.querySelector('#modelAssumption');
    const assumptionRect = assumption?.getBoundingClientRect();
    const mapPanelRect = document.querySelector('.map-panel')?.getBoundingClientRect();
    return {
      text: assumption?.textContent || '',
      visible: Boolean(assumptionRect?.width && assumptionRect?.height)
        && getComputedStyle(assumption).visibility !== 'hidden',
      insideMap: Boolean(assumptionRect && mapPanelRect)
        && assumptionRect.left >= mapPanelRect.left && assumptionRect.right <= mapPanelRect.right
        && assumptionRect.top >= mapPanelRect.top && assumptionRect.bottom <= mapPanelRect.bottom,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const contract = result.checks.contract;
  const conditionApplicationOk = contract.conditionApplication?.mode === 'client_proxy'
    && contract.conditionApplication?.physical_recompute === false
    && contract.conditionApplication?.preset_path === 'presets.json';
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
    && Object.entries(controlOptions).every(([name, expected]) => sameJson(result.checks.controls[name], expected));
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
    && result.checks.timelineAggregate.viewKind === 'aggregate'
    && result.checks.timelineAggregate.source === '集計'
    && result.checks.timelineAggregate.activeShortcut === String(aggregateSlotIndex)
    && result.checks.timelineAggregate.stamp.includes('集計')
    && result.checks.medaka.timelineMin === medakaTimelineMin
    && result.checks.medaka.timelineMax === medakaTimelineMax
    && result.checks.medaka.timelineStep === 1
    && result.checks.medakaAggregate.viewKind === 'aggregate'
    && result.checks.medakaAggregate.source === '集計'
    && result.checks.medakaAggregate.activeShortcut === '5';
  const partialDisplayOk = result.checks.partialLabelExample === '48h内最小（37h分）'
    && aggregateSlotIndex >= 0
    && result.checks.timelineAggregate.buttonLabel === aggregateDisplayLabel
    && result.checks.timelineAggregate.readout.includes(aggregateDisplayLabel)
    && result.checks.timelineAggregate.info.includes(aggregateDisplayLabel)
    && result.checks.imageSave.ready.length > 0
    && !result.checks.imageSave.error
    && result.checks.imageSave.slotLabel === aggregateDisplayLabel
    && result.checks.imageSave.texts.some(text => text.includes(aggregateDisplayLabel));
  const rootrotCountKeys = Object.keys(JSON.parse(result.checks.rootrot.counts || '{}')).map(Number);
  const rootrotUiOk = sameJson(result.checks.rootrot.legendLabels, rootrotLabels)
    && rootrotCountKeys.length > 0
    && rootrotCountKeys.every(value => Number.isInteger(value) && value >= 0 && value <= 3);
  const observedWindowLabels = { rain3h: '3時間積算降水', rain6h: '6時間積算降水', rain12h: '12時間積算降水' };
  const observedWindowsOk = Object.entries(observedWindowLabels).every(([kind, label]) => result.checks.observedWindows[kind]?.canvasVisible
    && result.checks.observedWindows[kind]?.info.includes(label));
  result.checks.contractGate = {
    landMaskOk,
    conditionApplicationOk,
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
    && result.checks.initial.slots === 8
    && result.checks.initial.floatingHidden
    && result.checks.initial.mydataHidden
    && result.checks.initial.modalHidden
    && result.checks.initial.modelDisclosureVisible
    && result.checks.initial.modelDisclosure.includes('7日前を60%')
    && result.checks.initial.modelDisclosure.includes('実際の水やりは反映しません')
    && result.checks.initial.modelDisclosure.includes('実測校正未了')
    && result.checks.initial.modelDisclosure.includes('物理モデル再計算ではありません')
    && result.checks.initial.modelAssumptionVisible
    && result.checks.initial.modelAssumptionInsideMap
    && result.checks.initial.modelAssumption.includes('7日前に60%で開始')
    && result.checks.initial.modelAssumption.includes('実際の水やり未反映')
    && result.checks.initial.modelAssumption.includes('実測校正未了')
    && result.checks.initial.landGridCount === 12404
    && result.checks.initial.landMaskSha === '2ccff1d901cf2cf8b90983aa3959f7636a64d55067167f322c2ebffc873f4394'
    && result.checks.initial.valueCountTotal === 12404
    && result.checks.initial.stamp.includes('日本陸域12,404格子')
    && result.checks.initial.landMaskNote.includes('31,296格子')
    && result.checks.initial.landMaskNote.includes('日本陸域12,404格子')
    && (requireStale ? result.checks.initial.stale === 'true' : (allowStale || result.checks.initial.stale === 'false'))
    && result.checks.initialCanvas.width > 0
    && result.checks.initialCanvas.height > 0
    && result.checks.initialCanvas.colored > 10
    && contract.schemaVersion >= 4
    && contract.generatorVersion >= 4
    && contract.distributionStatsBasis === 'pre_quantized_float'
    && landMaskOk
    && contract.datasetId === result.checks.initial.datasetId
    && Boolean(contract.manifestModelVersion)
    && contract.manifestModelVersion === contract.presetModelVersion
    && Boolean(contract.manifestPresetVersion)
    && contract.manifestPresetVersion === contract.presetVersion
    && conditionApplicationOk
    && controlContractOk
    && rootrotContractOk
    && plantReferencesOk
    && slotContractOk
    && initialTimelineOk
    && selectedTimelineOk
    && partialDisplayOk
    && sameJson(result.checks.observedOptions, observedOptions)
    && result.checks.watering.info.startsWith('水やりナビMAP')
    && result.checks.watering.modelDisclosureVisible
    && result.checks.watering.modelAssumption === result.checks.initial.modelAssumption
    && result.checks.rootrot.info.startsWith('根腐れ注意MAP')
    && result.checks.rootrot.modelAssumption === result.checks.initial.modelAssumption
    && rootrotUiOk
    && result.checks.medaka.slots === 6
    && result.checks.medaka.info.startsWith('メダカあふれリスクMAP')
    && result.checks.medaka.modelDisclosureHidden
    && result.checks.medaka.medakaDisclosure.includes('実測校正未了')
    && result.checks.medaka.modelAssumption === result.checks.initial.modelAssumption
    && result.checks.mobileDisclosure.visible
    && result.checks.mobileDisclosure.insideMap
    && result.checks.mobileDisclosure.noHorizontalOverflow
    && result.checks.mobileDisclosure.text === result.checks.initial.modelAssumption
    && observedWindowsOk
    && result.checks.rainDifference.info.includes('24時間降水 前日差')
    && result.checks.rainDifference.canvasVisible
    && result.checks.landSelectionDistance.exactGrid === contract.landMask.class1Example
    && result.checks.landSelectionDistance.distantOceanGrid === -1
    && result.checks.landSelectionDistance.hitRadiusSquared === 0.004
    && result.checks.detail.floatingVisible
    && result.checks.detail.modalVisible
    && [1, 2].includes(result.checks.detail.landClass)
    && result.checks.unassignedLand.landClass === 2
    && result.checks.unassignedLand.calendarTitle.includes('日本陸域・都道府県未割当')
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
    && result.checks.legacyRecovery.status.includes(`格子 ${contract.landMask.class1Example}`)
    && !result.checks.legacyRecovery.status.includes('マスク外')
    && result.checks.legacySharedOutside.landClass === 0
    && result.checks.legacySharedOutside.floatingVisible
    && result.checks.legacySharedOutside.floatingGrid.includes('陸域マスク外（旧登録）')
    && result.checks.legacySharedOutside.status.includes('共有リンクの地点')
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

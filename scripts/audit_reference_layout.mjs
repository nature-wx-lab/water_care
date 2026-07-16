#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
const targetUrl = process.argv.find(value => value.startsWith('http')) || 'http://127.0.0.1:8787/';
const launchOptions = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE;

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  viewport: { width: 2015, height: 1244 },
  deviceScaleFactor: 2,
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});
const page = await context.newPage();
const requests = [];
const failedResponses = [];
const consoleProblems = [];
page.on('request', request => requests.push(request.url()));
page.on('response', response => {
  const url = response.url();
  const allowedEmptyGsiTile = response.status() === 404
    && new URL(url).hostname === 'cyberjapandata.gsi.go.jp'
    && /\/xyz\/(?:blank|hillshademap)\//.test(url);
  if (response.status() >= 400 && !url.endsWith('/favicon.ico') && !allowedEmptyGsiTile) {
    failedResponses.push(`${response.status()} ${url}`);
  }
});
page.on('console', message => {
  if (['warning', 'error'].includes(message.type()) && !message.text().startsWith('Failed to load resource:')) {
    consoleProblems.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

function overlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function measure(name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    map.invalidateSize(false);
    resetJapanView();
  });
  await page.waitForTimeout(250);
  const state = await page.evaluate(() => {
    const rect = selector => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? {
        left: value.left, right: value.right, top: value.top, bottom: value.bottom,
        width: value.width, height: value.height,
      } : null;
    };
    const labelCanvas = document.querySelector('.place-label-canvas');
    const assumption = document.querySelector('#modelAssumption');
    const legend = document.querySelector('#legendBox');
    const subject = document.querySelector('.map-context-subject');
    const subjectStyle = subject ? getComputedStyle(subject) : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      panel: rect('.map-panel'),
      timeline: rect('#timeline'),
      stage: rect('.map-stage'),
      map: rect('#map'),
      info: rect('#mapInfoBar'),
      subject: rect('.map-context-subject'),
      time: rect('.map-context-time'),
      legend: rect('#legendBox'),
      legendKind: legend?.dataset.kind || '',
      legendScale: rect('#legendScale'),
      legendBar: rect('#legendBar'),
      legendTicks: [...document.querySelectorAll('#legendTicks .legend-tick strong')].map(element => element.textContent),
      legendEndpointWords: [...document.querySelectorAll('#legendScale .legend-end-label')].map(element => element.textContent),
      legendTopLabel: rect('.legend-end-label-top'),
      legendBottomLabel: rect('.legend-end-label-bottom'),
      calculationSummary: rect('#calculationSummary'),
      calculationMethod: document.querySelector('#calculationMethod')?.textContent || '',
      modelAssumptionVisible: Boolean(assumption?.getBoundingClientRect().width && assumption?.getBoundingClientRect().height)
        && getComputedStyle(assumption).visibility !== 'hidden',
      modelAssumptionInsideControls: Boolean(assumption && document.querySelector('.controls')?.contains(assumption)),
      modelAssumptionInsideLegend: Boolean(assumption && legend?.contains(assumption)),
      controls: rect('.controls'),
      homeLink: rect('.brand-home'),
      homeLinkLabelVisible: Boolean(document.querySelector('.brand-home-label')?.getBoundingClientRect().width),
      homeLinkHref: document.querySelector('.brand-home')?.href || '',
      saveButton: rect('#saveImage'),
      saveButtonLabel: document.querySelector('#saveImage')?.getAttribute('aria-label') || '',
      copyButton: rect('#copyLink'),
      copyButtonLabel: document.querySelector('#copyLink')?.getAttribute('aria-label') || '',
      pageScrollWidth: document.documentElement.scrollWidth,
      pageScrollHeight: document.documentElement.scrollHeight,
      labelCanvas: labelCanvas ? {
        rect: rect('.place-label-canvas'),
        width: labelCanvas.width,
        height: labelCanvas.height,
        opacity: Number(getComputedStyle(labelCanvas).opacity),
      } : null,
      labelStats: labelLayer?.getDrawStats() || null,
      subjectColor: subjectStyle?.color || '',
      subjectBackground: subjectStyle?.backgroundColor || '',
      subjectAccentWidth: subjectStyle?.borderLeftWidth || '',
      mapZoom: map.getZoom(),
      mapBounds: map.getBounds().toBBoxString(),
      mapContainsWakkanai: map.getBounds().contains([45.42, 141.68]),
      mapContainsKagoshima: map.getBounds().contains([31.60, 130.55]),
      referenceLandActive: Boolean(referenceLandLayer) && map.hasLayer(referenceLandLayer),
    };
  });
  const desktop = width > 760;
  state.ok = Boolean(
    state.timeline && state.stage && state.map && state.info && state.subject && state.time && state.legend && state.panel
    && state.homeLink && state.homeLink.width >= 28 && state.homeLink.height >= 28
    && state.homeLinkHref === 'https://naturewxlab.com/'
    && state.homeLinkLabelVisible === desktop
    && state.saveButton && state.saveButton.width >= 28 && state.saveButton.height >= 28
    && state.saveButtonLabel === '画像を保存'
    && state.copyButton && state.copyButton.width >= 28 && state.copyButton.height >= 28
    && state.copyButtonLabel === 'リンクをコピー'
    && state.timeline.bottom <= state.stage.top + 1
    && state.map.top >= state.stage.top - 1
    && state.map.bottom <= state.stage.bottom + 1
    && !overlap(state.timeline, state.map)
    && !overlap(state.timeline, state.info)
    && state.info.top >= state.stage.top + 5
    && state.info.right <= state.stage.right - 5
    && state.subject.left >= state.info.left
    && state.time.right <= state.info.right
    && !overlap(state.subject, state.time)
    && state.legend.left >= state.stage.left
    && state.legend.right <= state.stage.right
    && state.legend.top >= state.stage.top
    && state.legend.bottom <= state.stage.bottom
    && state.legend.width <= (desktop ? 104 : 96)
    && state.legendKind === 'moisture'
    && state.legendScale?.height >= (desktop ? 248 : 228)
    && state.legendBar?.width >= 20 && state.legendBar?.width <= 28
    && state.legendTicks.join(',') === '100%,90%,80%,70%,60%,50%,40%,30%,20%,10%,0%'
    && state.legendEndpointWords.join(',') === '湿潤,乾燥'
    && state.legendTopLabel?.bottom <= state.legendBar?.top + 1
    && state.legendBottomLabel?.top >= state.legendBar?.bottom - 1
    && state.calculationSummary?.width > 0 && state.calculationSummary?.height > 0
    && state.calculationMethod === '標準計算＋簡易条件補正'
    && state.modelAssumptionVisible
    && state.modelAssumptionInsideControls
    && !state.modelAssumptionInsideLegend
    && state.pageScrollWidth <= width + 1
    && state.timeline.height < 120
    && state.stage.height >= (desktop ? 600 : 400)
    && state.referenceLandActive
    && state.subjectColor === 'rgb(23, 53, 47)'
    && state.subjectBackground !== 'rgb(23, 53, 47)'
    && Number.parseFloat(state.subjectAccentWidth) >= 3
    && state.mapZoom >= (desktop ? 5.5 : 4.5)
    && state.mapContainsWakkanai
    && state.mapContainsKagoshima
    && state.labelStats?.fontSize <= 10
    && state.labelStats?.fontWeight === 700
    && Math.abs(state.labelStats?.opacity - 0.72) < 0.001
    && Math.abs(state.labelCanvas?.width / state.labelCanvas?.rect?.width - 2) < 0.02
    && Math.abs(state.labelCanvas?.height / state.labelCanvas?.rect?.height - 2) < 0.02
    && (desktop || (state.controls?.width >= width - 12 && state.panel?.width >= width - 12))
  );
  await page.screenshot({ path: `/tmp/water-care-reference-${name}.png`, fullPage: true });
  return state;
}

const result = { url: targetUrl, deviceScaleFactor: 2, checks: {} };
try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.datasetId), null, { timeout: 120000 });
  await page.waitForFunction(() => referenceLandLayer && map.hasLayer(referenceLandLayer)
    && labelLayer?.getDrawStats()?.drawn > 0
    && document.querySelector('#mapContextLayer')?.textContent === 'うるおい残量MAP', null, { timeout: 120000 });
  result.checks.userViewport = await measure('2015x1244-dpr2', 2015, 1244);
  result.checks.desktop = await measure('1440x900-dpr2', 1440, 900);
  result.checks.mobile = await measure('390x900-dpr2', 390, 900);
  result.referenceBaseRequested = requests.some(url => url.includes('/data/static/reference_basemap.geojson'));
  result.gsiPaleTileRequested = requests.some(url => url.includes('/xyz/pale/'));
  result.failedResponses = failedResponses;
  result.consoleProblems = consoleProblems;
  result.ok = Object.values(result.checks).every(check => check.ok)
    && result.referenceBaseRequested
    && !result.gsiPaleTileRequested
    && failedResponses.length === 0
    && consoleProblems.length === 0;
} catch (error) {
  result.failure = String(error?.stack || error);
  result.failedResponses = failedResponses;
  result.consoleProblems = consoleProblems;
  result.ok = false;
} finally {
  const output = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(process.env.WATER_CARE_LAYOUT_AUDIT_OUTPUT || '/tmp/water-care-reference-layout-audit.json', output);
  console.log(output.trim());
  await context.close();
  await browser.close();
}

process.exit(result.ok ? 0 : 1);

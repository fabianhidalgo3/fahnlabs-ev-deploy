// Genera las capturas de pantalla de docs/capturas/ con el navegador Edge (o Chrome) instalado.
// Requiere el servidor en marcha y, para que se vea actividad, una flota de emuladores:
//   cd server && npm start
//   cd server && npm run fleet -- --chargers 6 --connectors 2 --speed 30 --duration 30 --arrival 0.3 --prefix PRUEBA
//   cd tools/capturas && npm install && npm run capturas
//
// Variables: BASE (http://localhost:9000), EDGE (ruta del navegador), SOLO (nombre de una captura).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:9000';
const BROWSER =
  process.env.EDGE ||
  [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => fs.existsSync(p));
const OUT = fileURLToPath(new URL('../../docs/capturas/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = [
  { name: '01-operacion-oscuro', tab: 'ops', theme: 'dark' },
  { name: '02-operacion-claro', tab: 'ops', theme: 'light' },
  { name: '03-patio-oscuro', tab: 'patio', theme: 'dark', wait: '.pv.active' },
  { name: '04-patio-claro', tab: 'patio', theme: 'light', wait: '.pv.active' },
  { name: '05-motor-comandos', tab: 'motor', theme: 'dark', wait: '#mtCmds tr[data-json]' },
  {
    name: '06-motor-metervalues', tab: 'motor', theme: 'dark', wait: '#mtCmds tr[data-json]',
    async run(page) {
      await page.select('#mtAction', 'MeterValues');
      await page.waitForSelector('#mtLog tr[data-json]');
      await page.evaluate(() => document.querySelector('#mtLog').closest('section').scrollIntoView({ block: 'start' }));
      await page.evaluate(() => window.scrollBy(0, -70));
    },
  },
  {
    name: '07-calendario', tab: 'calendar', theme: 'dark', wait: '.cal-day',
    async run(page) {
      // Vista Día de hoy (Gantt con las cargas de la flota)
      await page.evaluate(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        document.querySelector(`[data-day="${d.getTime()}"]`)?.click();
      });
      await sleep(1500);
    },
  },
  { name: '08-vehiculos', tab: 'vehicles', theme: 'light', wait: '#vehBody tr, table tbody tr' },
  { name: '09-movil-patio', tab: 'patio', theme: 'light', viewport: MOBILE, wait: '.pv.active' },
  { name: '10-movil-operacion', tab: 'ops', theme: 'dark', viewport: MOBILE },
];

async function shot(browser, s) {
  const page = await browser.newPage();
  await page.setViewport(s.viewport || DESKTOP);
  await page.evaluateOnNewDocument(
    (theme, tab) => {
      try {
        localStorage.setItem('emob.theme', theme);
        localStorage.setItem('dash.tab', tab);
        sessionStorage.removeItem('as.history');
      } catch {}
    },
    s.theme,
    s.tab,
  );
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  // Espera a que llegue la primera instantánea en vivo
  await page.waitForFunction(() => document.querySelector('#kSessions')?.textContent.trim() !== '–', { timeout: 15000 });
  if (s.wait) await page.waitForSelector(s.wait, { timeout: 15000 });
  await sleep(3500); // deja correr animaciones, gráficos e historial de las minigráficas
  if (s.run) await s.run(page);
  await sleep(800);
  const file = `${OUT}${s.name}.png`;
  await page.screenshot({ path: file, fullPage: !!s.fullPage });
  await page.close();
  console.log('✔', s.name);
}

const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
try {
  for (const s of SHOTS.filter((x) => !process.env.SOLO || x.name.includes(process.env.SOLO))) {
    try {
      await shot(browser, s);
    } catch (e) {
      console.error('✖', s.name, e.message);
    }
  }
} finally {
  await browser.close();
}
console.log(`Capturas en ${OUT}`);

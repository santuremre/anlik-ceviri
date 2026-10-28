// ikon.svg'den PNG ikonlar üretir (iOS ana ekran ve Android için)
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('../ikon.svg', 'utf8');
for (const boy of [180, 192, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: boy }, font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(`../ikon-${boy}.png`, png);
}

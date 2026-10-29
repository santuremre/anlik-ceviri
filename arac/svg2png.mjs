// node svg2png.mjs girdi.svg cikti.png genislik
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const [, , girdi, cikti, boy] = process.argv;
writeFileSync(cikti, new Resvg(readFileSync(girdi, 'utf8'), { fitTo: { mode: 'width', value: +boy } }).render().asPng());

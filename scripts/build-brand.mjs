import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Original vector geometry. Two offset folds make a V without closing the seam.
export const fold = '<path d="M9 15H28C33 15 37 18 39 23L60 74L47 93L16 33Z"/><path d="M52 48L66 15H92L71 66C67 77 62 84 56 89C62 76 61 68 57 58Z"/>';
const root = resolve(import.meta.dirname, '..');
const publicDir = resolve(root, 'public');
mkdirSync(resolve(root, 'output'), { recursive: true });
for (const [file, color] of [['logo.svg','#c9e596'],['logo-light.svg','#c9e596'],['logo-mono.svg','#182a21']]) {
  writeFileSync(resolve(publicDir, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 108" fill="${color}"><title>Veyl - the open fold</title>${fold}</svg>\n`);
}
// Hand-drawn lowercase letterforms; no font installation is required to use this asset.
export const lettering = '<path d="M0 16H14L29 55L43 16H57L35 73H23Z"/><path fill-rule="evenodd" d="M117 48H75C77 59 84 65 94 65C102 65 108 62 114 57V69C107 74 101 76 92 76C73 76 61 64 61 45C61 27 73 14 90 14C108 14 118 27 117 48ZM76 38H104C102 28 98 24 90 24C82 24 78 29 76 38Z"/><path d="M125 16H140L155 54L169 16H183L159 78C155 90 147 95 135 95H129V83H135C142 83 146 80 149 73Z"/><path d="M194 16H207V54C207 61 210 64 216 64H219V76H213C200 76 194 69 194 56Z"/>';
for (const [file,color] of [['veyl-wordmark.svg','#182a21'],['veyl-wordmark-light.svg','#f4f3e9']]) {
  writeFileSync(resolve(publicDir, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 225 101" fill="${color}"><title>Veyl</title>${lettering}</svg>\n`);
}
const avatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><title>Veyl social avatar</title><rect width="800" height="800" fill="#182a21"/><g transform="translate(158 135) scale(4.8)" fill="#c9e596">${fold}</g></svg>`;
for (const [file, symbol, word] of [['veyl-lockup.svg','#c9e596','#182a21'],['veyl-lockup-light.svg','#c9e596','#f4f3e9']]) {
  writeFileSync(resolve(publicDir, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 344 108"><title>Veyl - symbol and wordmark</title><g fill="${symbol}">${fold}</g><g transform="translate(118 6.5)" fill="${word}">${lettering}</g></svg>\n`);
}
writeFileSync(resolve(publicDir, 'veyl-avatar.svg'), avatar);
// Raster exports of the native vectors, not edits of generated artwork.
const require = createRequire(import.meta.url);
const sharp = require(process.env.VEYL_SHARP_PATH || 'C:/Users/operator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
await sharp(Buffer.from(avatar)).resize(400,400).png().toFile(resolve(publicDir,'veyl-avatar.png'));
for (const [file,color] of [['veyl-logo.png','#c9e596'],['veyl-logo-light.png','#c9e596']]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1080" viewBox="0 0 100 108" fill="${color}">${fold}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(resolve(publicDir,file));
}
const reference = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500"><rect width="1500" height="500" fill="#182a21"/><g transform="translate(80 115) scale(2.5)" fill="#c9e596">${fold}</g><g transform="translate(422 137) scale(2.55)" fill="#f4f3e9">${lettering}</g></svg>`;
await sharp(Buffer.from(reference)).png().toFile(resolve(root,'output','veyl-identity-reference.png'));
console.log('Built Veyl vector marks, wordmarks, transparent PNGs, avatar and artwork reference.');

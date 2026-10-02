import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
const require = createRequire(import.meta.url);
const sharp = require(process.env.VEYL_SHARP_PATH || 'C:/Users/operator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = resolve(import.meta.dirname, '..');
// Format export of the selected, image-tool-edited 3:1 artwork.
// All creative changes to the banner are made with the image tool first.
await sharp(resolve(root,'output','veyl-x-banner-master.png')).resize(1500,500,{fit:'cover',position:'centre'}).png({compressionLevel:9}).toFile(resolve(root,'public','veyl-x-banner.png'));
for(const [file,width,height] of [['veyl-avatar.png',400,400],['veyl-x-banner.png',1500,500]]) {
  const path = resolve(root,'public',file);
  const meta = await sharp(path).metadata();
  if(meta.width !== width || meta.height !== height || meta.format !== 'png') throw Error(`Unexpected social export: ${file}`);
  if(file === 'veyl-avatar.png' && statSync(path).size >= 2_000_000) throw Error('Profile image exceeds X upload limit');
  console.log(`${file}: ${width} x ${height} PNG, ${statSync(path).size} bytes`);
}

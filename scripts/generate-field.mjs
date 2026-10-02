import { writeFileSync } from 'node:fs';
let paths = '';
// A toroidal contour sculpture: procedural vector geometry, no external image.
for (let i = 0; i < 112; i++) {
  const u = i / 112 * Math.PI * 2;
  let d = '';
  for (let j = 0; j <= 160; j++) {
    const v = j / 160 * Math.PI * 2;
    const r = 129 + 53 * Math.cos(v);
    const x = r * Math.cos(u), y = r * Math.sin(u), z = 65 * Math.sin(v);
    const a = .67, b = -.34;
    const y1 = y * Math.cos(a) - z * Math.sin(a), z1 = y * Math.sin(a) + z * Math.cos(a);
    const x2 = x * Math.cos(b) - y1 * Math.sin(b), y2 = x * Math.sin(b) + y1 * Math.cos(b);
    const scale = 560 / (560 + z1);
    const px = 300 + x2 * scale * 1.13, py = 246 + y2 * scale * 1.2;
    d += `${j ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)} `;
  }
  const opacity = .19 + .48 * (Math.sin(u) + 1) / 2;
  paths += `<path d="${d}Z" fill="none" stroke="#486e36" stroke-width=".62" opacity="${opacity.toFixed(2)}"/>`;
}
let satellites='';
for (const [x,y,r] of [[92,118,25],[490,298,20],[160,418,15]]) {
  satellites += `<circle cx="${x}" cy="${y}" r="${r+12}" fill="none" stroke="#abc295" stroke-width=".6" stroke-dasharray="2 4"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#sat)" stroke="#8ca575" stroke-width=".7"/>`;
  for(let k=-3;k<=3;k++)satellites+=`<ellipse cx="${x}" cy="${y}" rx="${r*Math.sqrt(1-(k/4)**2)}" ry="${r*.22}" transform="rotate(${k*21} ${x} ${y})" fill="none" stroke="#66844f" stroke-width=".35" opacity=".4"/>`;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 510"><defs><radialGradient id="core"><stop stop-color="#d5edaf"/><stop offset=".45" stop-color="#c0d994"/><stop offset="1" stop-color="#87a462" stop-opacity="0"/></radialGradient><radialGradient id="sat" cx="30%" cy="25%"><stop stop-color="#eef3dc"/><stop offset="1" stop-color="#b8ca9e"/></radialGradient><radialGradient id="shade"><stop stop-color="#5c7c42" stop-opacity=".15"/><stop offset="1" stop-color="#5c7c42" stop-opacity="0"/></radialGradient></defs><ellipse cx="306" cy="430" rx="173" ry="24" fill="url(#shade)"/><ellipse cx="300" cy="247" rx="269" ry="195" fill="none" stroke="#b1c599" stroke-width=".6" stroke-dasharray="2 6" transform="rotate(-26 300 247)"/><path d="M92 118L300 246L490 298M300 246L160 418" fill="none" stroke="#99b17d" stroke-width=".6" stroke-dasharray="3 5"/><circle cx="300" cy="246" r="83" fill="url(#core)"/>${paths}${satellites}<circle cx="300" cy="246" r="3" fill="#496b36"/><path d="M300 230v-9m0 41v9m-16-25h-9m41 0h9" stroke="#577c3c" stroke-width=".6"/></svg>`;
writeFileSync(new URL('../public/field.svg', import.meta.url), svg);

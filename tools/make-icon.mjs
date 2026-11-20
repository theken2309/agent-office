// Sinh icon pixel cho Agent Office.app → assets/icon.svg
// Lưới 32x32: tường + cửa sổ + biển WORK, sàn gỗ, nhân vật chibi ngồi sau bàn có màn hình sáng.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.svg')
const r = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
const INK = '#2e2622'

// sprite chibi giống trong văn phòng (12 cột), tự viền tối
const SPRITE = [
  '............',
  '....HHHH....',
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HHHHHHHH..',
  '..HSSHSSSH..',
  '..HSSSSSSH..',
  '..HSESSESH..',
  '..HBSSSSBH..',
  '...SSMMSS...',
  '....TTTT....',
  '..KTTTTTTK..',
  '...TTTTTT...',
  '............',
]
const COLORS = { H: '#4a3426', S: '#f6d2b4', K: '#f6d2b4', E: '#2b2b35', B: '#f4a3a3', M: '#c45d55', T: '#d97757' }

function sprite(ox, oy) {
  const at = (x, y) => SPRITE[y]?.[x] ?? '.'
  let out = ''
  for (let y = 0; y < SPRITE.length; y++)
    for (let x = 0; x < 12; x++) {
      const ch = at(x, y)
      if (ch !== '.') out += r(ox + x, oy + y, 1, 1, COLORS[ch])
      else if ([at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some(c => c !== '.')) out += r(ox + x, oy + y, 1, 1, INK)
    }
  return out
}

let s = ''
// khung bo góc kiểu pixel
s += r(2, 1, 28, 30, INK) + r(1, 2, 30, 28, INK)
// tường
s += r(3, 2, 26, 1, '#f1e7d3') + r(2, 3, 28, 10, '#f1e7d3') + r(2, 3, 28, 1, '#e2d3b8')
// cửa sổ
s += r(4, 4, 9, 8, INK) + r(5, 5, 7, 6, '#8a9bb0') + r(6, 6, 2, 4, '#a9d8f5') + r(9, 6, 2, 4, '#a9d8f5') + r(6, 6, 1, 2, '#d9f1ff')
// biển WORK
s += r(15, 5, 12, 5, INK) + r(16, 6, 10, 3, '#5a8dee') + r(16, 6, 10, 1, '#7aa6f2')
for (const x of [17, 19, 21, 23]) s += r(x, 7, 1, 1, '#ffffff')
// chân tường
s += r(2, 13, 28, 1, '#c9b28e')
// sàn gỗ
s += r(2, 14, 28, 15, '#e8c48e') + r(3, 29, 26, 1, '#e8c48e')
for (const y of [17, 21, 25]) s += r(2, y, 28, 1, '#d4a86c')
for (const [x, y] of [[8, 14], [20, 18], [12, 22], [26, 26], [5, 26]]) s += r(x, y, 1, 3, '#d4a86c')
// nhân vật
s += sprite(8, 6)
// màn hình sáng
s += r(19, 10, 9, 9, INK) + r(20, 11, 7, 7, '#3c4150') + r(21, 12, 5, 5, '#8fe0ff')
s += r(22, 13, 3, 1, '#2f6fa8') + r(22, 15, 2, 1, '#2f6fa8') + r(22, 19, 3, 1, '#555c6b')
// bàn
s += r(4, 19, 24, 9, INK) + r(5, 20, 22, 2, '#c68a52') + r(5, 20, 22, 1, '#daa36d') + r(5, 22, 22, 4, '#a0683a') + r(7, 24, 18, 1, '#8a5a31')
s += r(5, 26, 2, 3, INK) + r(25, 26, 2, 3, INK)
// bàn phím
s += r(10, 20, 7, 1, '#8f96a1')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 36 36" width="1024" height="1024" shape-rendering="crispEdges">${s}</svg>`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, svg)
console.log(`icon → ${OUT}`)

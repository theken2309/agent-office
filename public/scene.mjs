// Vẽ cảnh văn phòng pixel thành chuỗi SVG.
// Trái: khu làm việc (agent đang làm ngồi ở bàn). Phải: khu nghỉ (agent xong/chờ ngồi sofa).
//
// Mỗi nhân vật: { n, key, isMain, state, running: [{tool, detail}] }
//   state: 'working' | 'idle' | 'done' | 'stopped' | 'error'

const U = 2 // một "pixel" của sprite
const W = 320
const WALL_H = 58
const ROW_H = 50
const DIVIDER_X = 204
const MAX_PER_ZONE = 16

const r = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`

// ---------- nhân vật chibi ----------

const HEAD = ['............', '....HHHH....', '...HHHHHH...', '..HHHHHHHH..', '..HHHHHHHH..', '..HSSHSSSH..', '..HSSSSSSH..']
const BODY = ['....TTTT....', '..KTTTTTTK..', '...TTTTTT...', '...PP..PP...', '...ZZ..ZZ...', '............']

const FACES = {
  open: ['..HSESSESH..', '..HBSSSSBH..', '...SSMMSS...'],
  closed: ['..HLLSSLLH..', '..HBSSSSBH..', '...SSSMSS...'],
  happy: ['..HLLSSLLH..', '..HBSSSSBH..', '...SMMMMS...'],
  flat: ['..HSESSESH..', '..HSSSSSSH..', '...SSLLSS...'],
  sweat: ['..HSESSESHW.', '..HSSSSSSHW.', '...SSLLSS...'],
}

const CLASS = { H: 'h', S: 's', K: 's', E: 'e', L: 'e', Z: 'e', B: 'b', M: 'm', T: 't', P: 'p', W: 'w' }

/** Sprite → các rect gộp theo hàng, tự thêm viền tối quanh hình. */
function spriteRects(rows) {
  const at = (x, y) => rows[y]?.[x] ?? '.'
  const filled = (x, y) => at(x, y) !== '.'
  const cls = (x, y) => {
    const ch = at(x, y)
    if (ch !== '.') return CLASS[ch] ?? 'e'
    return filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1) ? 'o' : ''
  }
  let out = ''
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = cls(x, y)
      let end = x + 1
      while (end < row.length && cls(end, y) === c) end++
      if (c) out += `<rect class="${c}" x="${x * U}" y="${y * U}" width="${(end - x) * U}" height="${U}"/>`
      x = end
    }
  })
  return out
}

const HAIR = ['#3b2a20', '#6b4226', '#e0b04a', '#c2452d', '#2f3e6b', '#7a4fa0', '#e07a9a', '#1f1f1f']
const SHIRT = ['#e5534b', '#4f8de0', '#47b27a', '#f0a43a', '#9b6fd1', '#2bb3b3', '#e46aa3', '#7f8c99']
const SKIN = ['#f6d2b4', '#eebf98', '#d9a27c', '#b97f5b']

export const hash = s => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function palette(c) {
  const h = hash(c.key)
  const hair = HAIR[h % HAIR.length]
  const skin = SKIN[(h >>> 4) % SKIN.length]
  // Claude chính của mỗi session luôn mặc áo cam.
  const shirt = c.isMain ? '#d97757' : SHIRT[(h >>> 8) % SHIRT.length]
  return `--h:${hair};--s:${skin};--t:${shirt}`
}

const FACE_OF = { working: 'open', asking: 'open', idle: 'closed', done: 'happy', stopped: 'flat', error: 'sweat' }

function badge(x, y, n) {
  const w = n >= 10 ? 13 : 9
  return (
    r(x - 1, y - 1, w + 2, 11, '#2e2622') +
    r(x, y, w, 9, '#ffffff') +
    `<text x="${x + w / 2}" y="${y + 7}" text-anchor="middle" class="num">${n}</text>`
  )
}

/** Một nhân vật tại (x, y) = góc trên-trái sprite (24x32). */
function chibi(c, x, y, motion) {
  const face = FACE_OF[c.state] ?? 'open'
  const dur = motion === 'type' ? '0.35s' : motion === 'ask' ? '0.6s' : '2.4s'
  let extra = ''
  if (motion === 'think') {
    extra +=
      r(x + 18, y - 6, 20, 10, '#2e2622') +
      r(x + 19, y - 5, 18, 8, '#ffffff') +
      r(x + 16, y + 4, 3, 3, '#2e2622') +
      [0, 1, 2]
        .map(
          i =>
            `<rect x="${x + 22 + i * 5}" y="${y - 2}" width="2" height="2" fill="#2e2622"><animate attributeName="opacity" values="0.15;1;0.15" dur="1.2s" begin="${i * 0.3}s" repeatCount="indefinite"/></rect>`,
        )
        .join('')
  }
  if (motion === 'ask') {
    // bong bóng "!" vàng: đang chờ bạn
    extra +=
      r(x + 20, y - 8, 12, 14, '#2e2622') +
      r(x + 21, y - 7, 10, 12, '#ffd54a') +
      r(x + 18, y + 4, 3, 3, '#2e2622') +
      `<g><animate attributeName="opacity" values="1;0.35;1" dur="0.9s" repeatCount="indefinite"/>` +
      r(x + 25, y - 5, 2, 5, '#c0392b') +
      r(x + 25, y + 1, 2, 2, '#c0392b') +
      `</g>`
  }
  if (motion === 'sleep') {
    extra += [0, 1]
      .map(
        i =>
          `<text x="${x + 22 + i * 5}" y="${y + 6}" class="z" font-size="${7 + i * 2}">z<animate attributeName="y" values="${y + 8};${y - 4}" dur="2.4s" begin="${i * 1.2}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${i * 1.2}s" repeatCount="indefinite"/></text>`,
      )
      .join('')
  }
  return (
    `<g class="agent" data-n="${c.n}">` +
    `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="${dur}" repeatCount="indefinite"/>` +
    `<use href="#c-${face}" x="${x}" y="${y}" style="${palette(c)}"/></g>` +
    extra +
    badge(x - 4, y + 2, c.n) +
    // vùng rê chuột rộng hơn hình một chút
    r(x - 4, y - 6, 34, 40, 'transparent') +
    `</g>`
  )
}

// ---------- đồ đạc (định nghĩa 1 lần, dùng lại bằng <use>) ----------

const DESK_DEF =
  `<g id="desk">` +
  r(52, -20, 24, 19, '#2e2622') +
  r(54, -18, 20, 15, '#3c4150') +
  r(56, -16, 16, 11, '#262a33') +
  r(62, -3, 4, 3, '#555c6b') +
  r(-2, -2, 84, 22, '#2e2622') +
  r(0, 0, 80, 6, '#c68a52') +
  r(0, 0, 80, 2, '#daa36d') +
  r(0, 6, 80, 12, '#a0683a') +
  r(6, 11, 68, 1, '#8a5a31') +
  r(24, 1, 22, 3, '#8f96a1') +
  r(26, 2, 18, 1, '#c2c7cf') +
  r(0, 18, 6, 10, '#2e2622') +
  r(2, 18, 2, 8, '#7d4f2b') +
  r(74, 18, 6, 10, '#2e2622') +
  r(76, 18, 2, 8, '#7d4f2b') +
  `</g>`

const CHAIR_DEF =
  `<g id="chair">` +
  r(2, -2, 20, 2, '#2e2622') +
  r(0, 0, 24, 12, '#2e2622') +
  r(4, 0, 16, 2, '#7a3f52') +
  r(2, 2, 20, 10, '#9a4f66') +
  r(4, 3, 16, 2, '#b8667f') +
  `</g>`

const SOFA_DEF =
  `<g id="sofa">` +
  r(-2, -2, 48, 28, '#2e2622') +
  `<rect x="2" y="0" width="40" height="11" style="fill:var(--a)"/>` +
  r(4, 1, 36, 2, 'rgba(255,255,255,0.35)') +
  `<rect x="0" y="11" width="44" height="9" style="fill:var(--a)"/>` +
  r(2, 12, 40, 1, 'rgba(255,255,255,0.3)') +
  `<rect x="0" y="20" width="44" height="4" style="fill:var(--d)"/>` +
  `<rect x="0" y="4" width="6" height="18" style="fill:var(--d)"/>` +
  `<rect x="38" y="4" width="6" height="18" style="fill:var(--d)"/>` +
  `</g>`

const PLANT_DEF =
  `<g id="plant">` +
  r(3, -1, 12, 4, '#2e2622') +
  r(1, 3, 16, 12, '#2e2622') +
  r(5, 0, 8, 2, '#3d8a50') +
  r(2, 2, 14, 2, '#4fa564') +
  r(3, 4, 12, 3, '#3d8a50') +
  r(3, 9, 12, 2, '#d9844e') +
  r(4, 11, 10, 3, '#b8693a') +
  `</g>`

const SOFA_COLORS = [
  ['#ef8d7c', '#c86b5c'],
  ['#8fd1a5', '#66a87e'],
  ['#b9a3e3', '#9480c4'],
  ['#9fd6b8', '#74ad8f'],
  ['#f2c86b', '#cea246'],
  ['#c4a9e8', '#9d84c8'],
  ['#8fb8ef', '#6b93cc'],
  ['#efa3c2', '#c97d9c'],
]

// ---------- cảnh ----------

/** Chồng giấy trên quầy lễ tân: số việc/tin nhắn đang chờ. */
function paperStack(queued) {
  if (queued <= 0) return ''
  const sheets = Math.min(5, queued)
  let out = ''
  for (let i = 0; i < sheets; i++) out += r(280 - (i % 2), 32 - i * 2, 14, 3, '#2e2622') + r(281 - (i % 2), 32 - i * 2, 12, 2, i % 2 ? '#f7f3ea' : '#ffffff')
  const label = queued > 99 ? '99+' : String(queued)
  const w = 6 + label.length * 5
  return (
    out +
    r(298, 12, w + 2, 11, '#2e2622') +
    r(299, 13, w, 9, '#e5534b') +
    `<text x="${299 + w / 2}" y="20" text-anchor="middle" class="q">${label}</text>`
  )
}

function wall(working, waiting, resting, queued) {
  const win = x =>
    r(x - 2, 8, 36, 30, '#2e2622') +
    r(x, 10, 32, 26, '#8a9bb0') +
    r(x + 2, 12, 13, 22, '#a9d8f5') +
    r(x + 17, 12, 13, 22, '#a9d8f5') +
    r(x + 4, 14, 3, 8, '#d9f1ff') +
    r(x + 19, 14, 3, 8, '#d9f1ff')
  const sign = (x, w, fill, text) =>
    r(x - 2, 14, w + 4, 18, '#2e2622') +
    r(x, 16, w, 14, fill) +
    r(x, 16, w, 2, 'rgba(255,255,255,0.3)') +
    `<text x="${x + w / 2}" y="26" text-anchor="middle" class="sign">${text}</text>`
  return (
    r(0, 0, W, WALL_H, '#f1e7d3') +
    r(0, 0, W, 5, '#e2d3b8') +
    r(0, WALL_H - 5, W, 5, '#c9b28e') +
    r(0, WALL_H - 6, W, 1, '#b39a74') +
    win(8) +
    win(46) +
    sign(88, 50, '#5a8dee', `WORK ${working}`) +
    sign(144, 50, waiting ? '#e0a020' : '#b8a27a', `WAIT ${waiting}`) +
    sign(200, 48, '#3dbb8b', `REST ${resting}`) +
    r(258, 4, 20, 20, '#2e2622') +
    r(260, 6, 16, 16, '#fbfaf5') +
    r(267, 9, 2, 6, '#2e2622') +
    r(267, 14, 5, 2, '#2e2622') +
    r(254, 34, 62, 24, '#2e2622') +
    r(256, 36, 58, 6, '#c68a52') +
    r(256, 42, 58, 14, '#9a6438') +
    r(262, 26, 14, 10, '#2e2622') +
    r(264, 28, 10, 6, '#7fc9ef') +
    r(306, 28, 8, 8, '#2e2622') +
    r(307, 29, 6, 4, '#4fa564') +
    r(308, 33, 4, 3, '#b8693a') +
    paperStack(queued)
  )
}

function floors(h) {
  let out = r(0, WALL_H, DIVIDER_X, h - WALL_H, '#e8c48e')
  for (let y = WALL_H + 8, i = 0; y < h; y += 8, i++) {
    out += r(0, y, DIVIDER_X, 1, '#d4a86c')
    for (let x = i % 2 ? 16 : 0; x < DIVIDER_X; x += 40) out += r(x, y - 7, 1, 7, '#d4a86c')
  }
  out += r(DIVIDER_X + 4, WALL_H, W - DIVIDER_X - 4, h - WALL_H, '#f3ecdd')
  for (let y = WALL_H + 16; y < h; y += 16) out += r(DIVIDER_X + 4, y, W - DIVIDER_X - 4, 1, '#e6dcc7')
  for (let x = DIVIDER_X + 20; x < W; x += 16) out += r(x, WALL_H, 1, h - WALL_H, '#e6dcc7')
  out += r(DIVIDER_X - 1, WALL_H, 6, h - WALL_H, '#2e2622') + r(DIVIDER_X, WALL_H, 4, h - WALL_H, '#d8ccb3')
  return out
}

function workZone(working, rows) {
  let out = ''
  const cols = [14, 108]
  for (let i = 0; i < rows * 2; i++) {
    const dx = cols[i % 2]
    const dy = WALL_H + 34 + Math.floor(i / 2) * ROW_H
    const c = working[i]
    out += `<use href="#chair" x="${dx + 18}" y="${dy - 10}"/>`
    const typing = c && c.state === 'working' && c.running.length > 0
    if (c) out += chibi(c, dx + 18, dy - 24, c.state === 'asking' ? 'ask' : typing ? 'type' : 'think')
    out += `<use href="#desk" x="${dx}" y="${dy}"/>`
    if (typing) {
      out += r(dx + 56, dy - 16, 16, 11, '#8fe0ff')
      out += [0, 1, 2]
        .map(
          k =>
            `<rect x="${dx + 58}" y="${dy - 14 + k * 3}" width="6" height="1" fill="#2f6fa8"><animate attributeName="width" values="2;11;5;2" dur="${1 + k * 0.3}s" repeatCount="indefinite"/></rect>`,
        )
        .join('')
    } else if (c) {
      out += r(dx + 56, dy - 16, 16, 11, '#4a5a78')
    }
  }
  return out
}

function restZone(resting, rows) {
  let out = ''
  const cols = [214, 264]
  for (let i = 0; i < rows * 2; i++) {
    const sx = cols[i % 2]
    const sy = WALL_H + 22 + Math.floor(i / 2) * ROW_H
    const [a, d] = SOFA_COLORS[i % SOFA_COLORS.length]
    out += `<use href="#sofa" x="${sx}" y="${sy}" style="--a:${a};--d:${d}"/>`
    const c = resting[i]
    if (c) out += chibi(c, sx + 10, sy - 12, c.state === 'idle' ? 'sleep' : 'rest')
  }
  return out
}

/** Toàn bộ cảnh. `chars` đã đánh số khớp với danh sách bên dưới; `queued` = số việc đang chờ. */
export function officeSvg(chars, queued = 0) {
  // agent đang làm hoặc đang hỏi bạn đều ngồi bàn
  const working = chars.filter(c => c.state === 'working' || c.state === 'asking')
  const resting = chars.filter(c => c.state !== 'working' && c.state !== 'asking')
  const waiting = working.filter(c => c.state === 'asking').length
  const shownWork = working.slice(0, MAX_PER_ZONE)
  const shownRest = resting.slice(0, MAX_PER_ZONE)
  const deskRows = Math.max(3, Math.ceil(shownWork.length / 2))
  const sofaRows = Math.max(3, Math.ceil(shownRest.length / 2))
  const rows = Math.max(deskRows, sofaRows)
  const h = WALL_H + rows * ROW_H + 22
  const overflow = (x, n) => (n > 0 ? `<text x="${x}" y="${h - 8}" class="more">+${n} nữa</text>` : '')

  const style =
    `.h{fill:var(--h)}.s{fill:var(--s)}.t{fill:var(--t)}.e{fill:#2b2b35}.b{fill:#f4a3a3}.m{fill:#c45d55}` +
    `.p{fill:#3d4a66}.w{fill:#7cc8f5}.o{fill:#2e2622}` +
    `text{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700}` +
    `.num{font-size:7px;fill:#2e2622}.sign{font-size:8px;fill:#fff}.z{fill:#6c7a99}.more{font-size:8px;fill:#6b5a48}.q{font-size:7px;fill:#fff}` +
    `.agent{cursor:pointer}`

  const defs =
    Object.keys(FACES)
      .map(f => `<g id="c-${f}">${spriteRects([...HEAD, ...FACES[f], ...BODY])}</g>`)
      .join('') +
    DESK_DEF +
    CHAIR_DEF +
    SOFA_DEF +
    PLANT_DEF

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" shape-rendering="crispEdges">` +
    `<style>${style}</style><defs>${defs}</defs>` +
    wall(working.length - waiting, waiting, resting.length, queued) +
    floors(h) +
    workZone(shownWork, deskRows) +
    restZone(shownRest, sofaRows) +
    `<use href="#plant" x="6" y="${h - 20}"/>` +
    `<use href="#plant" x="${DIVIDER_X - 22}" y="${h - 20}"/>` +
    `<use href="#plant" x="${W - 22}" y="${h - 20}"/>` +
    overflow(70, working.length - shownWork.length) +
    overflow(DIVIDER_X + 40, resting.length - shownRest.length) +
    r(1, 1, W - 2, h - 2, 'none', ' stroke="#2e2622" stroke-width="3"') +
    `</svg>`
  )
}

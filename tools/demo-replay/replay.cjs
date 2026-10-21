// Replays GSI frames made by demo2gsi.py at real speed.
//   harness (default): stub manager + headless Chrome running the built-in HUD and its
//                      radar variant; screenshots of key moments, and the killfeed is
//                      checked against the demo's player_death events.
//   --gsi URL:         POST the raw frames to a running manager instead,
//                      e.g. --gsi http://localhost:23415/cs2/input
//   --quick:           no screenshots except the end of the last round (full-match checks).
//   --cams:            harness plays PrimeCam streams like the manager does (PRIMECAM_URL and
//                      PRIMECAM_VIEW_KEY) and checks the observed player's camera every second.
//   --players:         print the demo's players as `STEAM64 NAME` lines and exit (for the
//                      PrimeCam fleet simulator, which streams a test camera per player).
// Usage: node replay.cjs <frames.jsonl> [--out DIR] [--rounds 3,5,12-14] [--gsi URL] [--speed 1] [--video] [--quick] [--cams]
//
// Watch a demo in the manager's HUD (start the manager and open the HUD first):
//   node tools/demo-replay/replay.cjs .worktrees/demo/cache-full.jsonl --gsi http://localhost:23415/cs2/input
const path = require('path')
const fs = require('fs')
const http = require('http')
const readline = require('readline')
const REPO = path.resolve(__dirname, '../..')
const NM = path.join(REPO, 'node_modules') + '/'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const FRAMES = argv[0]
const OUT = path.resolve(opt('out', path.join(REPO, '.worktrees/_screens/replay')))
const GSI_URL = opt('gsi', null)
const SPEED = Number(opt('speed', 1))
const VIDEO = argv.includes('--video')
const QUICK = argv.includes('--quick')
const CAMS = argv.includes('--cams')
const meta = JSON.parse(fs.readFileSync(FRAMES + '.meta.json', 'utf8'))
const TICK = meta.tickrate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---------- frames ----------
const byRound = new Map()
let wantedRounds
async function loadFrames() {
  const only =
    opt('rounds', null) &&
    new Set(
      opt('rounds')
        .split(',')
        .flatMap((part) => {
          const [lo, hi = lo] = part.split('-').map(Number)
          return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
        })
    )
  for await (const line of readline.createInterface({ input: fs.createReadStream(FRAMES) })) {
    const m = /^\{"tick":(\d+),"round":(\d+),/.exec(line)
    if (!m || (only && !only.has(Number(m[2])))) continue
    const round = Number(m[2])
    if (!byRound.has(round)) byRound.set(round, [])
    byRound.get(round).push({ tick: Number(m[1]), line })
  }
  wantedRounds = [...byRound.keys()].sort((a, b) => a - b)
}
const frameOf = (f) => JSON.parse(f.line).gsi
const isPause = (f) => /"phase_countdowns":\{"phase":"(paused|timeout_ct|timeout_t)"/.test(f.line)

// ---------- GSI mode: feed a real manager ----------
// After skipped rounds the HUD would read the jump in deaths as a burst of kills;
// one frame with unknown steamids makes it forget the previous stats.
const forgetStats = (gsi) => ({
  ...gsi,
  allplayers: Object.fromEntries(
    Object.entries(gsi.allplayers).map(([sid, p]) => [`reset${sid}`, p])
  ),
  player: { ...gsi.player, steamid: `reset${gsi.player.steamid}` }
})

async function feedManager() {
  const interval = ((meta.step / TICK) * 1000) / SPEED
  const post = (gsi) =>
    fetch(GSI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gsi)
    }).catch((e) => log('POST failed:', e.message))
  let lastRound = null
  for (const n of wantedRounds) {
    const r = meta.rounds.find((x) => x.num === n)
    const frames = byRound.get(n).filter((f) => f.tick >= r.freeze_end - 10 * TICK)
    const first = frameOf(frames[0])
    const { team_ct: ct, team_t: t } = first.map
    log(
      `round ${n}/${meta.rounds.length}: ${ct.name} ${ct.score} - ${t.score} ${t.name}, ${((frames.length * interval) / 1000).toFixed(0)} s`
    )
    if (lastRound !== null && lastRound !== n - 1) await post(forgetStats(first))
    lastRound = n
    const t0 = performance.now()
    for (let i = 0; i < frames.length; i++) {
      const wait = t0 + i * interval - performance.now()
      if (wait > 0) await sleep(wait)
      await post(frameOf(frames[i]))
    }
  }
}

// ---------- harness mode ----------
async function harness() {
  const express = require(NM + 'express')
  const { Server } = require(NM + 'socket.io')
  const { chromium } = require(NM + 'playwright')
  const HUD_DIR = path.join(REPO, 'resources/default-hud')
  fs.mkdirSync(OUT, { recursive: true })

  // Team on observer slots 1-5 is shown on the left (that's the team that started CT).
  const first = frameOf(byRound.get(wantedRounds[0])[0])
  const leftIsCt = Object.values(first.allplayers).find((p) => p.observer_slot <= 4).team === 'CT'
  const left = first.map[leftIsCt ? 'team_ct' : 'team_t'].name
  const right = first.map[leftIsCt ? 'team_t' : 'team_ct'].name
  const teams = {
    left: {
      _id: 'left',
      name: left,
      shortName: left.slice(0, 4).toUpperCase(),
      country: '',
      logo: '',
      extra: {}
    },
    right: {
      _id: 'right',
      name: right,
      shortName: right.slice(0, 4).toUpperCase(),
      country: '',
      logo: '',
      extra: {}
    }
  }
  const match = {
    id: 'demo',
    current: true,
    matchType: 'bo5',
    left: { id: 'left', wins: 0 },
    right: { id: 'right', wins: 0 },
    vetos: [
      {
        teamId: 'right',
        mapName: meta.map,
        side: 'NO',
        type: 'pick',
        reverseSide: false,
        mapEnd: false
      }
    ]
  }
  const config = {
    display_settings: {
      tournament_name: 'ESL Pro League S24',
      tournament_stage: 'Grand Final',
      sponsor_area_height: '300'
    }
  }

  const app = express()
  // The manager's PrimeCam part (src/main/server/domains/primecam): camera API and player script.
  let lastGsi = null
  const primecam = CAMS && primecamConfig()
  app.get('/api/camera', (_, res) => {
    if (!primecam || !lastGsi)
      return res.json({ uuid: 'primecam', availablePlayers: [], primecam: null })
    const steamids = Object.keys(lastGsi.allplayers).filter((id) => /^\d{17}$/.test(id))
    const streams = {}
    for (const id of steamids) {
      const check = `${primecam.base}/stream/${id}/ws?key=${encodeURIComponent(primecam.key)}`
      streams[id] = { ws: check.replace(/^http/, 'ws'), check }
    }
    res.json({
      uuid: 'primecam',
      availablePlayers: steamids.map((steamid) => ({
        steamid,
        label: lastGsi.allplayers[steamid].name
      })),
      primecam: { player: `${primecam.base}/assets/player.js`, streams }
    })
  })
  if (primecam) {
    app.get('/primecam/hud-camera.js', (_, res) =>
      res.type('js').sendFile(path.join(REPO, 'src/main/server/domains/primecam/hud-camera.js'))
    )
    app.get(['/huds/default/', '/huds/default/index.html'], (_, res) =>
      res
        .type('html')
        .send(
          fs
            .readFileSync(path.join(HUD_DIR, 'index.html'), 'utf8')
            .replace(/<\/head>/i, '<script src="/primecam/hud-camera.js"></script></head>')
        )
    )
  }
  // Probe: record every kill the HUD emits (with the weapon it picked), logic untouched.
  app.get('/huds/default/assets/index.js', (_, res) => {
    const src = fs.readFileSync(path.join(HUD_DIR, 'assets/index.js'), 'utf8')
    const probe =
      'const __probe = (k) => ((window.__kills = window.__kills || []).push({ killer: k.killer.name, victim: k.victim.name, weapon: k.weapon, headshot: k.headshot }), Q.emit("kill", k));\n'
    if (!src.includes('Q.emit("kill", {')) throw new Error('probe anchor missing')
    res
      .type('js')
      .send(
        src
          .replace('const activeWeapon', probe + 'const activeWeapon')
          .replace('Q.emit("kill", {', '__probe({')
      )
  })
  app.use('/huds/default', express.static(HUD_DIR))
  app.get('/api/match/current', (_, res) => res.json(match))
  app.get('/api/match', (_, res) => res.json([match]))
  app.get('/api/teams/:id', (req, res) => res.json(teams[req.params.id] || null))
  app.get('/api/teams', (_, res) => res.json(Object.values(teams)))
  app.get('/api/players', (req, res) => {
    const ids = String(req.query.steamids || '')
      .split(';')
      .filter(Boolean)
    res.json(
      ids.map((s) => ({
        _id: s,
        username: '',
        firstName: '',
        lastName: '',
        steamid: s,
        country: '',
        avatar: '',
        extra: {}
      }))
    )
  })
  app.get('/api/players/avatar/steamid/:id', (_, res) => res.json({ custom: '', steam: '' }))
  app.use('/api', (_, res) => res.json(null))
  const server = http.createServer(app)
  const io = new Server(server, { cors: { origin: '*' } })
  let registered = 0
  io.on('connection', (socket) => {
    socket.on('started', () => socket.emit('readyToRegister'))
    socket.on('register', () => {
      socket.join('huds')
      socket.emit('hud_config', config)
      registered++
    })
  })

  // Same rewrites the manager applies in src/main/server/integrations/gsi.ts.
  const deadPositions = {}
  const managerTransform = (gsi) => {
    for (const [steamid, p] of Object.entries(gsi.allplayers)) {
      if (p.state && p.state.health === 0) {
        if (!deadPositions[steamid]) deadPositions[steamid] = p.position
        p.position = deadPositions[steamid]
      } else delete deadPositions[steamid]
      if (typeof p.observer_slot === 'number')
        p.observer_slot = p.observer_slot + 1 === 10 ? 0 : p.observer_slot + 1
    }
    return gsi
  }
  const send = (frame) => {
    lastGsi = managerTransform(frameOf(frame))
    io.to('huds').emit('update', lastGsi)
  }

  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const viewport = { width: 1920, height: 1080 }
  const hudCtx = await browser.newContext({
    viewport,
    ...(VIDEO
      ? { recordVideo: { dir: path.join(OUT, 'video'), size: { width: 1280, height: 720 } } }
      : {})
  })
  const radarCtx = await browser.newContext({ viewport })
  const pages = { hud: await hudCtx.newPage(), radar: await radarCtx.newPage() }
  for (const [name, page] of Object.entries(pages)) {
    page.on(
      'console',
      (m) =>
        m.type() === 'error' && !/favicon|404/.test(m.text()) && log(`[${name}] console:`, m.text())
    )
    page.on('pageerror', (e) => log(`[${name}] pageerror:`, e.message))
  }
  const url = (variant) =>
    `http://localhost:${port}/huds/default/index.html?port=${port}${variant ? `&variant=${variant}` : ''}`
  async function load(reload) {
    const before = registered
    for (const [name, page] of Object.entries(pages)) {
      if (reload) await page.reload()
      else await page.goto(url(name === 'radar' ? 'radar' : ''))
    }
    for (let i = 0; i < 100 && registered < before + 2; i++) await sleep(100)
    await sleep(500)
  }
  const shots = []
  const shot = (page, name) => {
    const p = pages[page]
      .screenshot({ path: path.join(OUT, `${name}-${page}.png`) })
      .catch((e) => log('shot failed', name, e.message))
    shots.push(p)
    return p
  }
  const readKillfeed = () =>
    pages.hud.evaluate(() =>
      [...document.querySelectorAll('.killfeed .single_kill_container .single_kill')].map((e) => ({
        killer: e.querySelector('.killer_name')?.textContent || null,
        victim: e.querySelector('.victim_name')?.textContent || null,
        assister: e.querySelector('.assister_name')?.textContent || null,
        // The headshot icon has no class; wallbang/noscope/thrusmoke are never set from GSI.
        headshot: !!e.querySelector('.way > svg:not(.weapon)')
      }))
    )

  const emittedKills = () => pages.hud.evaluate(() => window.__kills || [])

  // The HUD has a <video> per player and shows the observed player's.
  const camWatch = { observed: null, shots: 0, samples: [] }
  const checkCam = (observed) => {
    const name = lastGsi.allplayers[observed] && lastGsi.allplayers[observed].name
    return pages.hud
      .evaluate(() => {
        const v = [...document.querySelectorAll('#cameras-container video')].find(
          (e) => e.style.opacity === '1'
        )
        return v && { steamid: v.id.split('-')[2], playing: !!v.srcObject && v.videoWidth > 0 }
      })
      .then((cam) => ({ observed, name, cam: cam || null }))
      .catch(() => null)
  }
  const shotCam = async (name) => {
    const clip = await pages.hud.evaluate(() => {
      const boxes = ['.observed', '.observed .avatar_container']
        .map((s) => document.querySelector(s))
        .filter(Boolean)
        .map((e) => e.getBoundingClientRect())
      if (!boxes.length) return null
      const x = Math.min(...boxes.map((b) => b.left))
      const y = Math.min(...boxes.map((b) => b.top))
      return {
        x,
        y,
        width: Math.max(...boxes.map((b) => b.right)) - x,
        height: Math.max(...boxes.map((b) => b.bottom)) - y
      }
    })
    if (clip)
      shots.push(
        pages.hud
          .screenshot({ path: path.join(OUT, `${name}.png`), clip })
          .catch((e) => log('shot failed', name, e.message))
      )
  }

  const report = { rounds: [] }
  let lastRound = null
  await load(false)
  for (const n of wantedRounds) {
    const r = meta.rounds.find((x) => x.num === n)
    const all = byRound.get(n)
    const startTick = Math.max(r.start, r.freeze_end - 8 * TICK)
    const window = all.filter((f) => f.tick >= startTick)
    const pause = all.filter(isPause)
    // Skipping rounds would show their deaths as one burst of kills, so start the HUD fresh.
    if (lastRound !== null && lastRound !== n - 1) await load(true)
    lastRound = n
    const last = n === wantedRounds[wantedRounds.length - 1]
    if (pause.length) {
      const mid = pause.slice(Math.floor(pause.length / 2), Math.floor(pause.length / 2) + 64)
      for (const f of mid) {
        send(f)
        await sleep(((meta.step / TICK) * 1000) / SPEED)
      }
      const label = /"phase":"(\w+)"/.exec(mid[0].line.split('"phase_countdowns":')[1])[1]
      if (!QUICK) await shot('hud', `r${n}-${label}`)
    }

    const kills = meta.kills.filter((k) => k.round === n)
    const plants = meta.plants.filter((p) => p.tick >= r.start && p.tick < r.next_start)
    const defuses = meta.defuses.filter((d) => d.tick >= r.start && d.tick < r.next_start)
    let bestSmoke = { tick: null, count: 0 }
    for (const f of window) {
      if (f.tick < r.freeze_end || f.tick > r.end) continue
      const count = [...f.line.matchAll(/"effecttime":"(\d+\.\d)"/g)].filter(
        (m) => Number(m[1]) > 1
      ).length
      if (count > bestSmoke.count) bestSmoke = { tick: f.tick, count }
    }
    let burst = { tick: null, count: 0 }
    for (const k of kills) {
      const count = kills.filter((x) => x.tick >= k.tick && x.tick <= k.tick + 4 * TICK).length
      if (count > burst.count)
        burst = {
          tick: kills.filter((x) => x.tick >= k.tick && x.tick <= k.tick + 4 * TICK).pop().tick,
          count
        }
    }
    const nadeKills = kills
      .filter((k) => ['hegrenade', 'inferno'].includes(k.weapon))
      .map((k) => ({ tick: k.tick + 40, name: `kill-${k.weapon}`, pages: ['hud'] }))
    const captures = (
      QUICK
        ? (last ? [{ tick: r.end + 6 * TICK, name: 'after', pages: ['hud'] }] : []).concat(
            nadeKills
          )
        : [
            ...nadeKills,
            { tick: r.freeze_end - 4 * TICK, name: 'freeze', pages: ['hud'] },
            { tick: r.freeze_end + 20 * TICK, name: 'early', pages: ['hud', 'radar'] },
            ...(kills[0] ? [{ tick: kills[0].tick + 40, name: 'firstkill', pages: ['hud'] }] : []),
            ...(burst.count > 1
              ? [{ tick: burst.tick + 40, name: `killfeed${burst.count}`, pages: ['hud', 'radar'] }]
              : []),
            ...(bestSmoke.tick
              ? [
                  {
                    tick: bestSmoke.tick,
                    name: `smokes${bestSmoke.count}`,
                    pages: ['hud', 'radar']
                  }
                ]
              : []),
            ...plants.map((p) => ({
              tick: p.tick + 3 * TICK,
              name: 'planted',
              pages: ['hud', 'radar']
            })),
            ...defuses.map((d) => ({ tick: d.tick + 96, name: 'defusing', pages: ['hud'] })),
            { tick: r.end + 96, name: 'over', pages: ['hud'] },
            { tick: r.end + 6 * TICK, name: 'after', pages: ['hud', 'radar'] }
          ]
    ).sort((a, b) => a.tick - b.tick)

    const feedBefore = (await readKillfeed()).length
    const emittedBefore = (await emittedKills()).length
    log(
      `round ${n}: ${window.length} frames (${((window.length * meta.step) / TICK / SPEED).toFixed(0)} s), ${kills.length} kills, captures: ${captures.map((c) => c.name).join(', ')}`
    )
    const interval = ((meta.step / TICK) * 1000) / SPEED
    const t0 = performance.now()
    let ci = 0
    let nextCamCheck = 0
    for (let i = 0; i < window.length; i++) {
      const wait = t0 + i * interval - performance.now()
      if (wait > 0) await sleep(wait)
      send(window[i])
      if (primecam) {
        const observed = lastGsi.player && lastGsi.player.steamid
        if (observed !== camWatch.observed) {
          camWatch.observed = observed
          if (camWatch.shots < 16 && lastGsi.allplayers[observed])
            setTimeout(
              shotCam,
              1500,
              `cam${String(++camWatch.shots).padStart(2, '0')}-r${n}-${lastGsi.allplayers[observed].name}`
            )
        }
        if (performance.now() >= nextCamCheck) {
          nextCamCheck = performance.now() + 1000
          camWatch.samples.push(checkCam(observed))
        }
      }
      while (ci < captures.length && captures[ci].tick <= window[i].tick) {
        const c = captures[ci++]
        for (const p of c.pages) shot(p, `r${n}-${c.name}`)
      }
    }
    await Promise.all(shots)
    if (last && r.num === meta.rounds.length) {
      for (let i = 0; i < 40; i++) {
        send(window[window.length - 1])
        await sleep(250)
      }
      await shot('hud', 'gameover')
      report.scoreboard = await pages.hud.evaluate(() =>
        [...document.querySelectorAll('.eg-player-row')].map((row) =>
          [...row.children].map((c) => c.textContent)
        )
      )
    }

    const feed = (await readKillfeed()).slice(feedBefore)
    const emitted = (await emittedKills()).slice(emittedBefore)
    const rows = kills.map((k, i) => {
      const f = feed[i] || {}
      const w = emitted[i] && { weapon: emitted[i].weapon.replace('weapon_', '') }
      const expectedKiller = k.killer && k.killer !== k.victim ? k.killer : k.victim
      return {
        tick: k.tick,
        demo: `${k.killer || 'world'} [${k.weapon}${k.headshot ? ' HS' : ''}] ${k.victim}${k.assister ? ` (+${k.assister})` : ''}`,
        hud: f.victim
          ? `${f.killer} [${w ? w.weapon : '?'}${f.headshot ? ' HS' : ''}] ${f.victim}${f.assister ? ` (+${f.assister})` : ''}`
          : 'MISSING',
        killerOk: f.killer === expectedKiller,
        victimOk: f.victim === k.victim,
        headshotOk: f.headshot === k.headshot,
        assisterOk: (f.assister || null) === (k.assister || null),
        weaponOk:
          !!w &&
          (w.weapon === k.weapon ||
            w.weapon.startsWith(k.weapon) ||
            (k.weapon.startsWith('knife') && w.weapon.includes('knife')) ||
            (k.weapon === 'bayonet' && w.weapon.includes('bayonet')))
      }
    })
    report.rounds.push({
      round: n,
      kills: kills.length,
      shown: feed.length,
      extra: feed.slice(kills.length),
      rows
    })
    log(`round ${n}: killfeed ${feed.length}/${kills.length} entries`)
  }

  fs.writeFileSync(path.join(OUT, 'killfeed-report.json'), JSON.stringify(report, null, 1))
  if (primecam) {
    await Promise.all(shots)
    const samples = (await Promise.all(camWatch.samples)).filter((s) => s && s.name)
    const players = {}
    for (const s of samples) {
      const p = (players[s.name] = players[s.name] || {
        observed: 0,
        playing: 0,
        wrong: 0,
        none: 0
      })
      p.observed++
      if (!s.cam) p.none++
      else if (s.cam.steamid !== s.observed) p.wrong++
      else if (s.cam.playing) p.playing++
    }
    const total = (k) => Object.values(players).reduce((sum, p) => sum + p[k], 0)
    log(
      `cams: the observed player's camera played in ${total('playing')}/${samples.length} checks (wrong camera ${total('wrong')}, no camera element ${total('none')})`
    )
    for (const [name, p] of Object.entries(players))
      log(`  ${name}: ${p.playing}/${p.observed}${p.wrong ? `, wrong ${p.wrong}` : ''}`)
    fs.writeFileSync(
      path.join(OUT, 'cams-report.json'),
      JSON.stringify({ players, samples }, null, 1)
    )
  }
  await hudCtx.close()
  await radarCtx.close()
  await browser.close()
  io.close()
  server.close()
}

function primecamConfig() {
  const url = (process.env.PRIMECAM_URL || '').trim()
  const key = (process.env.PRIMECAM_VIEW_KEY || '').trim()
  if (!url || !key) throw new Error('--cams needs PRIMECAM_URL and PRIMECAM_VIEW_KEY')
  return { base: new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).origin, key }
}

async function printPlayers() {
  const input = fs.createReadStream(FRAMES)
  const lines = readline.createInterface({ input })
  const [first] = await new Promise((resolve) => lines.once('line', (l) => resolve([l])))
  lines.close()
  input.destroy()
  for (const [steamid, p] of Object.entries(JSON.parse(first).gsi.allplayers))
    console.log(`${steamid} ${p.name}`)
}

;(argv.includes('--players')
  ? printPlayers()
  : loadFrames().then(() => (GSI_URL ? feedManager() : harness()))
).catch((e) => {
  console.error(e)
  process.exitCode = 1
})

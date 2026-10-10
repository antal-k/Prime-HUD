// Added to every HUD page by the manager. Lexogrine-style HUDs render a
// <video id="remote-video-<steamid>-<n>"> per player listed by /api/camera and
// show only the observed player's; this plays each player's PrimeCam stream
// into those elements, in place of the Lexogrine WebRTC feed.
;(() => {
  const VIDEO_ID = /^remote-video-(\d{17})-/
  const REFRESH_MS = 10000
  const RETRY_UNKNOWN_MS = 2000
  const RETRY_PLAYER_MS = 10000

  let config = null
  let loading = null
  let loadedAt = 0
  let player = null
  const attached = new Map()

  const load = () => {
    if (!loading) {
      loading = fetch('/api/camera', { cache: 'no-store' })
        .then((res) => res.json())
        .then((body) => {
          config = body && body.primecam ? body.primecam : null
        })
        .catch(() => {})
        .finally(() => {
          loading = null
          loadedAt = Date.now()
        })
    }
    return loading
  }

  const playerFailedRecently = () =>
    player && player.url === config.player && Date.now() - player.failedAt < RETRY_PLAYER_MS

  const playerModule = () => {
    if (!player || player.url !== config.player || player.failedAt) {
      const entry = { url: config.player, failedAt: 0 }
      entry.module = import(config.player).catch((e) => {
        entry.failedAt = Date.now()
        console.warn('PrimeCam: the player did not load', e)
        throw e
      })
      player = entry
    }
    return player.module
  }

  const detach = (video) => {
    const entry = attached.get(video)
    if (!entry) return
    attached.delete(video)
    if (entry.player) entry.player.stop()
    if (entry.stream && video.srcObject === entry.stream) video.srcObject = null
  }

  const attach = async (video, steamid) => {
    const stream = config && config.streams[steamid]
    const current = attached.get(video)
    if (current && current.ws === (stream && stream.ws)) return
    detach(video)
    if (!stream || playerFailedRecently()) return
    const entry = { ws: stream.ws, player: null, stream: null }
    attached.set(video, entry)
    let module
    try {
      module = await playerModule()
    } catch {
      attached.delete(video)
      return
    }
    if (attached.get(video) !== entry) return
    const canvas = document.createElement('canvas')
    entry.stream = canvas.captureStream()
    // Without frames the element stays empty and the HUD's avatar shows.
    const show = (on) => {
      if (on && video.srcObject !== entry.stream) {
        video.srcObject = entry.stream
        video.play().catch(() => {})
      } else if (!on && video.srcObject === entry.stream) {
        video.srcObject = null
      }
    }
    entry.player = module.startPlayer(canvas, {
      wsUrl: stream.ws,
      checkUrl: stream.check,
      onStale: (stale) => show(!stale),
      onStatus: (status) => {
        if (!status.online) show(false)
      },
      onError: (text) => {
        if (text) console.warn(`PrimeCam ${steamid}: ${text}`)
      }
    })
  }

  const scan = () => {
    for (const video of attached.keys()) {
      if (!video.isConnected) detach(video)
    }
    let unknown = false
    for (const video of document.querySelectorAll('video[id^="remote-video-"]')) {
      const m = VIDEO_ID.exec(video.id)
      if (!m) continue
      if (!config || !config.streams[m[1]]) unknown = true
      attach(video, m[1])
    }
    // A player who just appeared in the HUD: the list may predate them.
    if (unknown && Date.now() - loadedAt > RETRY_UNKNOWN_MS) load().then(scan)
  }

  let scheduled = false
  const scheduleScan = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      scan()
    })
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  })
  load().then(scan)
  setInterval(() => load().then(scan), REFRESH_MS)
})()

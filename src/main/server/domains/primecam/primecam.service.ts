import { getSettings } from '../settings/settings.routes'
import { PlayerRepository } from '../players/player.repository'
import { getLastGSIState } from '../../integrations/gsi'

const playerRepo = new PlayerRepository()

export interface PrimeCamConfig {
  base: string
  key: string
}

/** A sender known to the PrimeCam server (`GET /api/cameras`). */
export interface PrimeCamCamera {
  sender_id: string
  name: string
  hostname: string
  steam64: string | null
  persona: string | null
  connected: boolean
}

export interface HudStream {
  ws: string
  check: string
}

const STEAM64 = /^\d{17}$/
const CAMERAS_CACHE_MS = 3000

/** `prime.example.com/admin` → `https://prime.example.com` */
export const normalizeBase = (input: string): string => {
  const s = input.trim()
  if (!s) return ''
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).origin
  } catch {
    return ''
  }
}

export const getPrimeCamConfig = async (): Promise<PrimeCamConfig | null> => {
  const settings = await getSettings()
  const base = normalizeBase(settings.primecamUrl)
  const key = settings.primecamKey.trim()
  return base && key ? { base, key } : null
}

let camerasCache: { at: number; config: string; cameras: PrimeCamCamera[] } | null = null

export const fetchCameras = async (config: PrimeCamConfig): Promise<PrimeCamCamera[]> => {
  const id = `${config.base}#${config.key}`
  if (
    camerasCache &&
    camerasCache.config === id &&
    Date.now() - camerasCache.at < CAMERAS_CACHE_MS
  ) {
    return camerasCache.cameras
  }
  const res = await fetch(`${config.base}/api/cameras?key=${encodeURIComponent(config.key)}`, {
    signal: AbortSignal.timeout(5000)
  })
  if (res.status === 401) throw new Error('Wrong view key')
  if (!res.ok) throw new Error(`PrimeCam server answered HTTP ${res.status}`)
  const body = await res.json()
  const cameras: PrimeCamCamera[] = Array.isArray(body?.cameras) ? body.cameras : []
  camerasCache = { at: Date.now(), config: id, cameras }
  return cameras
}

/**
 * Path under the server's `/stream/` for a player: a chosen machine, or by
 * default whichever machine the player's Steam account is logged in on.
 */
export const streamPath = (steamid: string, camera?: string | null): string | null => {
  const c = (camera || '').trim()
  if (c === 'none') return null
  if (c.startsWith('sender:') && c.length > 7) return `sender/${encodeURIComponent(c.slice(7))}`
  return STEAM64.test(steamid) ? steamid : null
}

export const hudStream = (config: PrimeCamConfig, path: string): HudStream => {
  const check = `${config.base}/stream/${path}/ws?key=${encodeURIComponent(config.key)}`
  return { ws: check.replace(/^http/, 'ws'), check }
}

/**
 * Lexogrine camera API (`GET /api/camera`): HUDs render a camera element per
 * listed player and show the observed one's. The extra `primecam` field is for
 * the script the server adds to HUD pages, which plays the streams into them.
 */
export const hudCameras = async () => {
  const uuid = 'primecam'
  const config = await getPrimeCamConfig()
  if (!config) return { uuid, availablePlayers: [], primecam: null }

  const allplayers: Record<string, { name?: string }> = getLastGSIState()?.allplayers ?? {}
  const steamids = Object.keys(allplayers).filter((id) => STEAM64.test(id))
  const dbPlayers = steamids.length ? await playerRepo.getPlayers(steamids) : []
  const bySteamId = new Map(dbPlayers.map((p) => [p.steamid, p]))

  const availablePlayers: { steamid: string; label: string }[] = []
  const streams: Record<string, HudStream> = {}
  for (const steamid of steamids) {
    const player = bySteamId.get(steamid)
    if (player?.isCoach) continue
    const path = streamPath(steamid, player?.camera)
    if (!path) continue
    availablePlayers.push({
      steamid,
      label: player?.username || allplayers[steamid]?.name || steamid
    })
    streams[steamid] = hudStream(config, path)
  }
  return {
    uuid,
    availablePlayers,
    primecam: { player: `${config.base}/assets/player.js`, streams }
  }
}

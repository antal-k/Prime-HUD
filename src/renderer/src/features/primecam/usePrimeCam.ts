import { ref, computed } from 'vue'
import type { SelectOption } from '@renderer/components/base/BaseSelect.vue'
import { API_URL } from '../../index'

/** A sender known to the PrimeCam server. */
export interface PrimeCamCamera {
  sender_id: string
  name: string
  hostname: string
  steam64: string | null
  persona: string | null
  connected: boolean
}

export type CameraState = 'live' | 'offline' | 'off'

export function usePrimeCam() {
  const configured = ref(false)
  const cameras = ref<PrimeCamCamera[]>([])
  const error = ref<string | null>(null)
  const isLoading = ref(false)

  const fetchCameras = async () => {
    isLoading.value = true
    try {
      const res = await fetch(`${API_URL}/primecam/cameras`)
      const body = await res.json()
      configured.value = !!body.configured
      cameras.value = body.cameras ?? []
      error.value = body.error ?? null
    } catch (err: any) {
      error.value = err.message
    } finally {
      isLoading.value = false
    }
  }

  /** The camera a player's setting resolves to right now. */
  const cameraFor = (steamid: string, setting?: string | null): PrimeCamCamera | null => {
    const c = setting || ''
    if (c === 'none') return null
    if (c.startsWith('sender:'))
      return cameras.value.find((cam) => cam.sender_id === c.slice(7)) ?? null
    return cameras.value.find((cam) => cam.connected && cam.steam64 === steamid) ?? null
  }

  const cameraState = (steamid: string, setting?: string | null): CameraState => {
    if (setting === 'none') return 'off'
    return cameraFor(steamid, setting)?.connected ? 'live' : 'offline'
  }

  const cameraOptions = computed((): SelectOption[] => [
    { value: '', label: 'Automatic (by Steam ID)' },
    { value: 'none', label: 'No camera' },
    ...cameras.value.map((cam) => ({
      value: `sender:${cam.sender_id}`,
      label: `${cam.name}${cam.hostname && cam.hostname !== cam.name ? ` (${cam.hostname})` : ''}${cam.connected ? '' : ' — offline'}`
    }))
  ])

  return {
    configured,
    cameras,
    error,
    isLoading,
    fetchCameras,
    cameraFor,
    cameraState,
    cameraOptions
  }
}

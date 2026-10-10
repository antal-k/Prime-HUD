import { Router, Request, Response } from 'express'
import { fetchCameras, getPrimeCamConfig, hudCameras } from './primecam.service'

// GET /api/primecam/cameras — the PrimeCam server's senders, for the manager UI
export const primecamRouter = Router()
primecamRouter.get('/cameras', async (_req: Request, res: Response) => {
  const config = await getPrimeCamConfig()
  if (!config) return res.json({ configured: false, cameras: [] })
  try {
    return res.json({ configured: true, cameras: await fetchCameras(config) })
  } catch (e: any) {
    return res.json({ configured: true, cameras: [], error: e.message })
  }
})

// GET /api/camera — the camera API lexogrine-style HUDs call
export const hudCameraRouter = Router()
hudCameraRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await hudCameras())
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

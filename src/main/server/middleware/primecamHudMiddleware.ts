import { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { getHudsDir, getBuiltinHudDir } from '../../paths'
import hudCameraScript from '../domains/primecam/hud-camera.js?raw'

export const HUD_CAMERA_SCRIPT_PATH = '/primecam/hud-camera.js'

export const serveHudCameraScript = (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.type('application/javascript').send(hudCameraScript)
}

/**
 * Serves HUD pages (`/huds/<id>/` and `/huds/<id>/index.html`) with the
 * PrimeCam camera script added, so any lexogrine-style HUD shows the
 * observed player's camera. The HUD's own (possibly signed) files stay as
 * they are.
 */
export function primecamHudMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const match = req.path.match(/^\/huds\/([^/]+)\/(index\.html)?$/)
  if (!match) return next()

  const hudId = path.basename(decodeURIComponent(match[1]))
  const hudDir = hudId === 'default' ? getBuiltinHudDir() : path.join(getHudsDir(), hudId)
  const indexPath = path.join(hudDir, 'index.html')
  if (!fs.existsSync(indexPath)) return next()

  const html = fs.readFileSync(indexPath, 'utf-8')
  const tag = `<script src="${HUD_CAMERA_SCRIPT_PATH}"></script>`
  const out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(out)
}

/**
 * Signature capture, hand-rolled (DECISIONS: no dependency — signature-pad
 * was unpublished, the React wrappers are alpha): a canvas and the pointer
 * events, that is the whole trick. Reports null until a stroke exists, the
 * PNG data URL after — what a document attachment stores. Pointer events
 * cover finger, pen and mouse alike; `touch-action: none` (CSS) stops the
 * page scrolling away mid-signature.
 */
import { useEffect, useRef, useState } from 'react'

const WIDTH = 480
const HEIGHT = 180
const STROKE = '#15181b' // --ink's literal: the pad is a signing surface, not theme chrome

export function SignaturePad({
  onChange,
  label = 'Signature',
}: {
  onChange: (png: string | null) => void
  label?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const stroked = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  // Set up once: size the backing store to the device pixels so the strokes
  // are crisp, and paint the signing surface.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = WIDTH * ratio
    canvas.height = HEIGHT * ratio
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = STROKE
  }, [])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    }
  }

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = point(e)
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    const to = point(e)
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.beginPath()
      ctx.moveTo(last.current.x, last.current.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }
    last.current = to
    if (!stroked.current) {
      stroked.current = true
      setHasInk(true)
      onChange(canvasRef.current?.toDataURL('image/png') ?? null)
    }
  }

  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    // The full signature, not the first stroke's snapshot.
    onChange(canvasRef.current?.toDataURL('image/png') ?? null)
  }

  const clear = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    stroked.current = false
    setHasInk(false)
    onChange(null)
  }

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', maxWidth: WIDTH, aspectRatio: `${WIDTH} / ${HEIGHT}`, touchAction: 'none' }}
        role="img"
        aria-label={hasInk ? `${label} — signed` : `${label} — blank, draw to sign`}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
      />
      <div className="signature-actions">
        <button type="button" className="btn btn-light" onClick={clear} disabled={!hasInk}>
          Clear
        </button>
        <small className="signature-hint">{hasInk ? 'Signed — clear to redo.' : 'Draw with a finger or stylus.'}</small>
      </div>
    </div>
  )
}

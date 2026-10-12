import { useEffect, useRef, type JSX } from 'react'

/**
 * A thirty-second side-scroller, for the break reminder.
 *
 * Deliberately tiny: run right, jump, reach the flag. It exists so that taking a
 * break is something you *do* rather than a dialog you dismiss, and so that
 * standing up for half a minute has a reward at the end of it.
 *
 * The keyboard is captured on the canvas rather than through the app's shortcut
 * table: the arrow keys and space must not reach the terminal behind the modal,
 * and holding a direction has to work.
 */

const WIDTH = 720
const HEIGHT = 260
const GROUND = HEIGHT - 36
/** Far enough that reaching it takes roughly half a minute at this speed. */
const WORLD_WIDTH = 2400
const SPEED = 2.6
const GRAVITY = 0.34
const JUMP = -7.4

interface Platform {
  x: number
  y: number
  w: number
}

const PLATFORMS: Platform[] = [
  { x: 0, y: GROUND, w: WORLD_WIDTH },
  { x: 240, y: GROUND - 54, w: 96 },
  { x: 420, y: GROUND - 96, w: 84 },
  { x: 640, y: GROUND - 58, w: 110 },
  { x: 900, y: GROUND - 104, w: 92 },
  { x: 1120, y: GROUND - 62, w: 120 },
  { x: 1400, y: GROUND - 118, w: 96 },
  { x: 1660, y: GROUND - 70, w: 130 },
  { x: 1960, y: GROUND - 96, w: 104 }
]

const FLAG_X = WORLD_WIDTH - 140
/** A patrolling obstacle: touching it sends the player back to the start. */
const ENEMY = { x: 1000, min: 940, max: 1180, speed: 1.1, y: GROUND - 18, w: 20 }

interface GameState {
  x: number
  y: number
  vx: number
  vy: number
  onGround: boolean
  enemyX: number
  enemyDir: number
  camera: number
  ticks: number
  won: boolean
}

function initialState(): GameState {
  return {
    x: 40,
    y: GROUND,
    vx: 0,
    vy: 0,
    onGround: true,
    enemyX: ENEMY.x,
    enemyDir: 1,
    camera: 0,
    ticks: 0,
    won: false
  }
}

interface BreakGameProps {
  /** Called once the flag is reached — this is what "unlocks" the break. */
  onWin: () => void
}

export function BreakGame({ onWin }: BreakGameProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<GameState>(initialState())
  const keysRef = useRef({ left: false, right: false, jump: false })
  const wonRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    let frame = 0
    const state = stateRef.current

    const draw = (): void => {
      const s = stateRef.current

      // Sky and a couple of parallax hills: enough depth to read as a place.
      const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT)
      sky.addColorStop(0, '#1b2740')
      sky.addColorStop(1, '#243352')
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, WIDTH, HEIGHT)

      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      for (let i = 0; i < 4; i++) {
        const hx = ((i * 520 - s.camera * 0.35) % (WORLD_WIDTH + 900)) - 200
        ctx.beginPath()
        ctx.arc(hx, GROUND - 10, 130, Math.PI, 0)
        ctx.fill()
      }

      ctx.save()
      ctx.translate(-s.camera, 0)

      // Platforms: dark blocks with a brighter cap, in the app's palette. The
      // body is deliberately darker than the sky so the ground reads as ground.
      for (const platform of PLATFORMS) {
        ctx.fillStyle = '#1a2233'
        ctx.fillRect(platform.x, platform.y, platform.w, HEIGHT - platform.y)
        ctx.fillStyle = '#3f7d5a'
        ctx.fillRect(platform.x, platform.y, platform.w, 6)
      }

      // The goal.
      ctx.fillStyle = '#d7dae0'
      ctx.fillRect(FLAG_X, GROUND - 90, 3, 90)
      ctx.fillStyle = '#67d38a'
      ctx.beginPath()
      ctx.moveTo(FLAG_X + 3, GROUND - 88)
      ctx.lineTo(FLAG_X + 44, GROUND - 74)
      ctx.lineTo(FLAG_X + 3, GROUND - 58)
      ctx.closePath()
      ctx.fill()

      // The obstacle.
      ctx.fillStyle = '#e0685f'
      ctx.fillRect(s.enemyX, ENEMY.y, ENEMY.w, 18)
      ctx.fillStyle = '#f2b0a8'
      ctx.fillRect(s.enemyX + 3, ENEMY.y + 5, 4, 4)
      ctx.fillRect(s.enemyX + 13, ENEMY.y + 5, 4, 4)

      // The player: a small character, not a rectangle, so it reads at a glance.
      ctx.fillStyle = '#6fa8dc'
      ctx.fillRect(s.x, s.y - 26, 18, 26)
      ctx.fillStyle = '#f4d7b5'
      ctx.fillRect(s.x + 3, s.y - 36, 12, 10)
      ctx.fillStyle = '#d94f4f'
      ctx.fillRect(s.x + 2, s.y - 39, 14, 4)
      ctx.fillStyle = '#22314d'
      ctx.fillRect(s.x + 4, s.y - 32, 2, 2)
      ctx.fillRect(s.x + 12, s.y - 32, 2, 2)

      ctx.restore()

      // HUD.
      ctx.fillStyle = 'rgba(233,238,247,0.85)'
      ctx.font = '12px "Cascadia Mono", Consolas, monospace'
      ctx.fillText(`Reach the flag — ${Math.floor(s.ticks / 60)}s`, 12, 20)
      const remaining = Math.max(0, Math.round((FLAG_X - s.x) / 10))
      ctx.fillText(`${remaining}m to go`, 12, 36)
    }

    const step = (): void => {
      const s = stateRef.current
      const keys = keysRef.current
      s.ticks += 1

      // Horizontal movement, with the player kept inside the world.
      s.vx = keys.right && !keys.left ? SPEED : keys.left && !keys.right ? -SPEED : 0
      s.x = Math.max(0, Math.min(WORLD_WIDTH - 30, s.x + s.vx))

      // Jump only from the ground: no double jumps, so a mistimed hop costs time
      // rather than being recoverable mid-air.
      if (keys.jump && s.onGround) {
        s.vy = JUMP
        s.onGround = false
      }

      s.vy += GRAVITY
      s.y += s.vy
      s.onGround = false

      // Land on the highest platform under the player's feet.
      for (const platform of PLATFORMS) {
        const withinX = s.x + 18 > platform.x && s.x < platform.x + platform.w
        if (!withinX) continue
        if (s.vy >= 0 && s.y >= platform.y && s.y - s.vy <= platform.y + 8) {
          s.y = platform.y
          s.vy = 0
          s.onGround = true
        }
      }
      if (s.y > HEIGHT + 200) {
        // Fell off the world: back to the start, no lives to lose.
        s.x = 40
        s.y = GROUND
        s.vy = 0
      }

      // The obstacle patrols; contact resets the run.
      s.enemyX += ENEMY.speed * s.enemyDir
      if (s.enemyX < ENEMY.min || s.enemyX > ENEMY.max) s.enemyDir *= -1
      if (
        s.x + 18 > s.enemyX &&
        s.x < s.enemyX + ENEMY.w &&
        s.y > ENEMY.y - 24 &&
        s.y - 30 < ENEMY.y + 18
      ) {
        s.x = 40
        s.y = GROUND
        s.vy = 0
      }

      // Camera follows, clamped to the world.
      s.camera = Math.max(0, Math.min(WORLD_WIDTH - WIDTH, s.x - WIDTH / 2))

      if (!s.won && s.x >= FLAG_X - 6) {
        s.won = true
      }

      draw()

      if (s.won) {
        if (!wonRef.current) {
          wonRef.current = true
          onWin()
        }
        return
      }
      frame = requestAnimationFrame(step)
    }

    // Test hook: the probe cannot hold a key down for thirty seconds reliably,
    // and a finished run is what the suite is about.
    if (window.localStorage.getItem('tdDebug') === '1') {
      ;(window as unknown as Record<string, unknown>)['__tdBreakGame'] = {
        state: () => ({ ...stateRef.current }),
        key: (name: 'left' | 'right' | 'jump', on: boolean) => {
          keysRef.current[name] = on
        },
        /** Stand on the flag, so the next step wins the run. */
        finish: () => {
          stateRef.current.x = FLAG_X
          stateRef.current.y = GROUND
        }
      }
    }

    frame = requestAnimationFrame(step)

    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (key === 'arrowright' || key === 'd') keysRef.current.right = true
      else if (key === 'arrowleft' || key === 'a') keysRef.current.left = true
      else if (key === ' ' || key === 'arrowup' || key === 'w') keysRef.current.jump = true
      else return
      // The pane behind the modal must not see these.
      event.preventDefault()
      event.stopPropagation()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (key === 'arrowright' || key === 'd') keysRef.current.right = false
      else if (key === 'arrowleft' || key === 'a') keysRef.current.left = false
      else if (key === ' ' || key === 'arrowup' || key === 'w') keysRef.current.jump = false
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [onWin])

  return (
    <div className="td-break-game">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        tabIndex={0}
        data-testid="break-game"
        aria-label="Break game: reach the flag"
      />
      <p className="td-hint">
        <kbd>←</kbd> <kbd>→</kbd> to run, <kbd>Space</kbd> to jump. Twenty-odd seconds to the flag.
      </p>
    </div>
  )
}

import { useEffect, useRef } from 'react'

/**
 * Slow «liquid» greys, like a dark desktop wallpaper: domain-warped noise in a fragment shader.
 * Rendered at reduced resolution (the look is soft anyway), paused while hidden, and a still
 * frame when the system asks for reduced motion. Falls back to a CSS gradient without WebGL.
 */
const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FRAGMENT = `precision mediump float;
uniform vec2 r; uniform float t;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * n(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
void main() {
  vec2 uv = gl_FragCoord.xy / r; vec2 p = (gl_FragCoord.xy - 0.5 * r) / min(r.x, r.y) * 1.6;
  float s = t * 0.035;
  vec2 q = vec2(fbm(p + s), fbm(p + vec2(5.2, 1.3) - s));
  vec2 w = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + 0.6 * s), fbm(p + 3.0 * q + vec2(8.3, 2.8) - 0.5 * s));
  float f = fbm(p + 3.5 * w);
  // Greys from near-black to graphite, with soft sheen where the folds turn.
  vec3 c = mix(vec3(0.035, 0.036, 0.042), vec3(0.20, 0.205, 0.22), smoothstep(0.15, 0.95, f));
  c += vec3(0.11, 0.115, 0.13) * pow(smoothstep(0.45, 1.0, length(w)), 3.0);
  c = mix(c, c * vec3(0.92, 0.95, 1.04), uv.y);
  c *= 1.0 - 0.35 * length(uv - 0.5);
  gl_FragColor = vec4(c, 1.0);
}`

function setup(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, powerPreference: 'low-power', preserveDrawingBuffer: false })
  if (!gl) return null
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source); gl.compileShader(shader)
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
  }
  const vertex = compile(gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vertex || !fragment) return null
  const program = gl.createProgram()!
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  return { gl, resolution: gl.getUniformLocation(program, 'r'), time: gl.getUniformLocation(program, 't') }
}

export function LiquidBackground({ className = '' }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const context = setup(element)
    if (!context) { element.parentElement?.classList.add('liquid-fallback'); return }
    const { gl, resolution, time } = context
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // A random start so every visit looks a little different.
    const offset = Math.random() * 400
    let frame = 0
    let visible = true
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2) * 0.5
      element.width = Math.max(1, Math.round(element.clientWidth * scale))
      element.height = Math.max(1, Math.round(element.clientHeight * scale))
      gl.viewport(0, 0, element.width, element.height)
      gl.uniform2f(resolution, element.width, element.height)
    }
    const draw = (now: number) => {
      gl.uniform1f(time, offset + now / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (!still && visible && !document.hidden) frame = requestAnimationFrame(draw)
    }
    const restart = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw) }
    const observer = new ResizeObserver(() => { resize(); if (still) draw(0) })
    observer.observe(element)
    const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) restart() })
    seen.observe(element)
    const onVisibility = () => { if (!document.hidden) restart() }
    document.addEventListener('visibilitychange', onVisibility)
    resize()
    restart()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  return <div className={'liquid ' + className} aria-hidden="true"><canvas ref={canvas} /></div>
}

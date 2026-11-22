import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { LiquidBackground } from './LiquidBackground'
import { Modal } from './Modal'

/** Shown when the app opens: logo over the liquid background, then into the notes. */
export function Splash({ enter }: { enter: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => { button.current?.focus() }, [])
  const go = () => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(enter, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420)
  }
  return <div className={'splash' + (leaving ? ' leaving' : '')} role="dialog" aria-modal="true" aria-label="MazmiNotas"
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); go() } }}>
    <LiquidBackground />
    <div className="splash-center">
      <img className="splash-mark" src="/mazmi.svg" alt="" width="88" height="88" />
      <h1 translate="no">MazmiNotas</h1>
      <p>Tus ideas, en su sitio.</p>
    </div>
    <button ref={button} type="button" className="splash-enter" data-testid="splash-enter" onClick={go}>
      Entrar a tus notas<Icon name="arrow" size={16} />
    </button>
  </div>
}

/** A protected note's place in the window: fixed, liquid background, password prompt. */
export function LockedNote({ title, unlock }: { title: string; unlock: (password: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(0)
  useEffect(() => { input.current?.focus() }, [])

  const submit = async () => {
    if (!password || checking) return
    setChecking(true); setError('')
    try {
      await unlock(password)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPassword('')
      setShake((value) => value + 1)
      window.requestAnimationFrame(() => input.current?.focus())
    } finally { setChecking(false) }
  }

  return <section className="locked-note" aria-label={'Nota protegida: ' + (title || 'Sin título')}>
    <LiquidBackground />
    <form key={shake} className={'lock-card' + (shake ? ' shake' : '')} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <span className="lock-badge" aria-hidden="true"><Icon name="lock" size={20} /></span>
      <h2>{title || 'Sin título'}</h2>
      <p>Esta nota está protegida con contraseña.</p>
      <label className="sr-only" htmlFor="unlock-password">Contraseña</label>
      <input ref={input} id="unlock-password" data-testid="unlock-password" type="password" autoComplete="current-password"
        placeholder="Contraseña" value={password} onChange={(event) => { setPassword(event.target.value); setError('') }}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'unlock-error' : undefined} disabled={checking} />
      {error && <p id="unlock-error" className="lock-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={!password || checking}>{checking ? 'Comprobando…' : 'Desbloquear'}</button>
    </form>
  </section>
}

/** Sets or removes a note's password. */
export function PasswordDialog({ mode, close, submit }: {
  mode: 'lock' | 'unlock'
  close: () => void
  submit: (password: string) => Promise<void>
}) {
  const first = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const locking = mode === 'lock'
  const valid = locking ? [...password].length >= 4 && password === repeat : password.length > 0

  const send = async () => {
    if (!valid || working) return
    setWorking(true); setError('')
    try { await submit(password); close() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setWorking(false) }
  }

  return <Modal title={locking ? 'Proteger con contraseña' : 'Quitar la contraseña'} close={close} initialFocus={first}>
    <form className="password-form" onSubmit={(event) => { event.preventDefault(); void send() }}>
      {locking
        ? <p className="password-note">El contenido se cifra en este equipo. <strong>Si olvidas la contraseña no hay forma de recuperarlo.</strong> El historial de versiones de esta nota se borra, porque guarda el texto sin cifrar.</p>
        : <p className="password-note">La nota volverá a guardarse sin cifrar.</p>}
      <label>Contraseña
        <input ref={first} type="password" data-testid="password-new" autoComplete={locking ? 'new-password' : 'current-password'}
          value={password} onChange={(event) => { setPassword(event.target.value); setError('') }} />
      </label>
      {locking && <label>Repetir contraseña
        <input type="password" data-testid="password-repeat" autoComplete="new-password" value={repeat} onChange={(event) => { setRepeat(event.target.value); setError('') }} />
      </label>}
      {locking && password.length > 0 && [...password].length < 4 && <p className="password-hint">Al menos 4 caracteres.</p>}
      {locking && repeat.length > 0 && password !== repeat && <p className="password-hint">Las contraseñas no coinciden.</p>}
      {error && <p className="lock-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={close}>Cancelar</button>
        <button type="submit" className="primary" data-testid="password-submit" disabled={!valid || working}>
          {working ? 'Un momento…' : locking ? 'Proteger nota' : 'Quitar contraseña'}
        </button>
      </div>
    </form>
  </Modal>
}

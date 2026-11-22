# Recordatorios

La base de datos (`reminders`, migración 0006) es la fuente de verdad. Los avisos del sistema
se reconstruyen a partir de ella de forma idempotente (se borran los pendientes de MazmiNotas y
se vuelven a programar), así que nunca hay duplicados y cualquier cambio en una nota (título,
papelera, restauración, copia de seguridad) se refleja con un único `resync`.

## Cómo funciona por plataforma

| Situación | macOS | Windows | Linux / modo navegador |
|---|---|---|---|
| Ventana cerrada, proceso vivo | Aviso del sistema | Toast programado | Aviso dentro de la app |
| Proceso terminado | Aviso del sistema (lo entrega `usernoted`) | Toast programado (lo guarda Windows) | Se marca como vencido al abrir |
| Equipo apagado o dormido | Aparece al despertar, según reglas del sistema | Ídem | Se marca como vencido al abrir |
| Clic en el aviso | Abre la nota (delegado `UNUserNotificationCenter`) | `mazminotas://note/<id>` | — |

- macOS: `UNCalendarNotificationTrigger` con `NSDateComponents` en la zona del recordatorio, así
  que los cambios de horario (DST) y los viajes conservan la hora local elegida. Repeticiones
  naturales usan el disparador repetitivo nativo; los casos que no encajan (inicio futuro, día de
  mes > 28) se expanden a 8 avisos únicos. Límite: 60 pendientes (los más próximos).
- Windows: `ScheduledToastNotification` con el AppUserModelID `com.scribedock.app`; las
  repeticiones se expanden a avisos únicos.
- En todas: un hilo Rust revisa cada 20 s los vencidos, los marca como «necesita atención»,
  avanza las repeticiones y re-sincroniza. Al reiniciar tras un apagado, los vencidos aparecen
  como banner en la nota con «10 min / 1 hora / Mañana / Hecho».
- Precisión: minuto.

## Verificado

- macOS 26.0.1 (Apple Silicon), app firmada ad hoc lanzada con LaunchServices:
  - `--reminders-selftest`: aviso entregado sin ningún proceso de MazmiNotas en ejecución
    (log de `usernoted`: «Delivering… Presenting… as banner»).
  - `--reminders-e2e <db> 2` sobre una base aislada: entregado con la app cerrada;
    `--reminders-e2e-check` → `sweep_changed true delivered_by_os true`, `needsAttention true`.
- Pruebas Rust de calendario (DST Madrid, semanales/mensuales en Nueva York, planes, posponer),
  pruebas de BD, unitarias de `reminderTime.ts` y E2E de la interfaz en modo navegador.

## No verificado

- **Windows**: el módulo `src-tauri/src/reminders/windows.rs` no se ha compilado ni ejecutado en
  Windows. Requiere que el instalador cree el acceso directo con el AppUserModelID.
- **Linux**: sin avisos con la app cerrada (no hay API estándar de avisos programados); solo
  avisos dentro de la app y recuperación de vencidos.
- Clic en un aviso real de macOS que abre la nota: implementado, pendiente de prueba manual.
- Permiso de notificaciones: macOS solo lo pide si la app se abre desde Finder/LaunchServices; si
  se ignora el diálogo queda desactivado y hay que activarlo en Ajustes del Sistema.

## Diagnóstico

```bash
MazmiNotas.app/Contents/MacOS/mazminotas --reminders-status
```

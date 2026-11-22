<p align="center"><img src="public/mazmi.svg" width="88" height="88" alt=""></p>

<h1 align="center">MazmiNotas</h1>

<p align="center">Notas locales para escribir, organizar y recuperar tus ideas. Sin cuentas, sin nube, sin telemetría.</p>

## Descargar

En [**Releases**](../../releases/latest):

| Sistema | Archivo |
|---|---|
| macOS (Apple Silicon e Intel) | `MazmiNotas_…_universal.dmg` |
| Windows 10/11 | `MazmiNotas_…_x64-setup.exe` (o el `.msi`) |
| Linux | `MazmiNotas_…_amd64.AppImage`, `.deb` o `.rpm` |

La app se instala **vacía**: la primera vez que se abre crea su propia biblioteca en el equipo de quien la usa. Ni el código ni los instaladores contienen notas ni bases de datos.

### Primera apertura

Los instaladores no están firmados con un certificado de pago, así que el sistema avisa la primera vez:

- **macOS**: si dice que no se puede verificar el desarrollador, abre *Ajustes del Sistema → Privacidad y seguridad* y pulsa *Abrir igualmente* (o clic derecho sobre la app → *Abrir*).
- **Windows**: en el aviso de SmartScreen, *Más información → Ejecutar de todas formas*.
- **Linux (AppImage)**: `chmod +x MazmiNotas_*.AppImage` y ábrelo.

## Qué hace

- **Escritura con formato**: barra al seleccionar texto (negrita, cursiva, subrayado, color, resaltado, tamaño, alineación) y menú «/» para encabezados, listas, tareas, citas, código, separadores e imágenes. Markdown como fuente, con modo Markdown y vista previa.
- **Carpetas y subcarpetas** con arrastrar y soltar.
- **Recordatorios** con fecha, hora, zona horaria y repetición. En macOS avisa el sistema aunque la app esté cerrada; en Windows y Linux, ver [docs/recordatorios.md](docs/recordatorios.md).
- **Imágenes**: pegar, arrastrar o elegir archivo. Se guardan junto a la biblioteca, no dentro de la base de datos.
- **Notas con contraseña**: el contenido se cifra en el equipo (Argon2id + XChaCha20-Poly1305). Sin la contraseña no se puede leer; si se olvida, no hay recuperación.
- **Búsqueda** por título y contenido, con el fragmento donde aparece (⌘/Ctrl + K).
- **Historial** de versiones, papelera, copias de seguridad y restauración.
- **Exportar** a Markdown, Word (.docx) o una carpeta Markdown, e importar carpetas.
- Tema claro y oscuro según el sistema.

Atajos: ⌘/Ctrl + K buscar · N nueva nota · S guardar · F buscar en la biblioteca · \ mostrar u ocultar la biblioteca.

## Dónde están los datos

Todo queda en el equipo de cada usuario:

- macOS: `~/Library/Application Support/com.scribedock.app/`
- Windows: `%APPDATA%\com.scribedock.app\`
- Linux: `~/.config/com.scribedock.app/` y `~/.local/share/com.scribedock.app/`

Ahí están `notes.db`, las imágenes (`attachments/`) y las copias (`backups/`). La app no se conecta a Internet.

## Desarrollo

Requisitos: Node.js 22 o superior, Rust estable y los [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) de tu sistema.

```sh
npm ci
npm run dev:tauri      # app de escritorio
npm run dev:web        # navegador (datos de prueba en localStorage)
npm run build:tauri    # instaladores en src-tauri/target/release/bundle
```

Verificación: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run db:check`.

Los instaladores de cada versión los genera GitHub Actions (`.github/workflows/release.yml`) en macOS, Windows y Linux al publicar una etiqueta `v*`.

Stack: React, TypeScript, Vite, TipTap, Tauri 2, Rust y SQLite. Más detalles en [`docs/`](docs) y [`SECURITY.md`](SECURITY.md).

## Licencia

Las fuentes IBM Plex incluidas se distribuyen con su licencia OFL (`public/licenses`).

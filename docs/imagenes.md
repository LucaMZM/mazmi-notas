# Imágenes en las notas

## Almacenamiento

- Las imágenes **no** van dentro de SQLite. Se guardan en `attachments/` junto a `notes.db`
  (`~/Library/Application Support/com.scribedock.app/attachments` en macOS), con permisos `0600`.
- Cada archivo se llama `<sha256>.<ext>`: la referencia es estable, la misma imagen se guarda una
  sola vez y un nombre nunca puede apuntar a otro contenido.
- La nota guarda Markdown estándar: `![descripción](attachment:<nombre>)`.
- Formatos: PNG, JPEG, GIF y WebP, detectados por su contenido (no por la extensión). SVG se
  rechaza a propósito (puede llevar scripts). Límite: 20 MB por imagen, 20 por inserción.

## Cómo llegan a la pantalla

- El frontend no tiene permisos de sistema de archivos. Rust sirve las imágenes por el esquema de
  solo lectura `mazmi-attachment://` (`http://mazmi-attachment.localhost` en Windows), que valida
  el nombre (evita rutas tipo `../`) y responde con `nosniff` y caché inmutable.
- La CSP de producción solo permite imágenes de `'self'`, `data:`, `blob:` y ese esquema. Las
  imágenes remotas nunca se cargan: en la vista previa se muestran como «[Imagen: …]».
- Insertar: pegar una captura, arrastrar archivos o «/imagen» (diálogo del sistema leído en Rust).

## Editor

- Una imagen gestionada en su propia línea (o dentro de una cita) es un bloque en «Escritura».
  Imágenes externas, dentro de un párrafo o en listas mantienen la nota en Markdown, sin perder nada.

## Copias, exportación e importación

- Copias de seguridad (formato v5): incluyen en base64 las imágenes que usan las notas y sus
  versiones, así una copia restaura en otro equipo. Al restaurar, cada imagen se verifica contra
  su hash **antes** de tocar las notas; una imagen manipulada aborta la restauración.
  Las copias v1–v4 siguen restaurándose.
- Exportar carpeta (vault): las imágenes van a `attachments/` y los enlaces a `../attachments/…`.
  Importar recupera esas imágenes (solo dentro de la carpeta importada y verificando el hash).
- Exportar nota a Markdown: las imágenes se copian a «<nombre> imágenes/» junto al archivo.
- Word: PNG, JPEG y GIF se incrustan ajustados al ancho de página; WebP se exporta como su
  descripción porque las versiones antiguas de Word no lo abren.

## Limpieza

Un hilo en segundo plano (45 s tras abrir y luego cada 6 h) borra las imágenes que ya no usa
ninguna nota, nota en la papelera ni versión del historial, si tienen más de 24 h (margen para
notas aún sin guardar). Las copias de seguridad llevan su propia copia de las imágenes.

## Modo navegador

En el modo web de desarrollo las imágenes se guardan en IndexedDB de ese navegador y no se
incluyen en sus copias JSON.

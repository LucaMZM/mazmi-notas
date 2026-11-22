# Seguridad De MazmiNotas

## Contenido Y Red

La aplicación no carga CDN, imágenes remotas, telemetría ni servicios externos. Las fuentes IBM Plex se empaquetan localmente. La vista previa usa react-markdown, remark-gfm y rehype-sanitize; solo se muestran las imágenes guardadas en el equipo (esquema de solo lectura `mazmi-attachment:`, sin SVG) y los enlaces externos no abren recursos remotos. El pegado visual acepta texto plano.

La CSP de producción en src-tauri/tauri.conf.json mantiene script-src 'self' y style-src 'self', sin unsafe-inline. Las excepciones de desarrollo pertenecen exclusivamente al servidor Vite. La app necesita IPC local para Tauri, no acceso general a Internet.

## Persistencia

SQLite es el almacenamiento principal. Las escrituras de notas, etiquetas, relaciones e historial se ejecutan juntas mediante comandos Rust transaccionales. Las consultas de lectura usan la base precargada; el frontend no recibe permiso SQL de escritura ni permisos generales de filesystem.

Las migraciones SQLx son la única autoridad de producción. El recorrido rusqlite valida el esquema y no vuelve a ejecutar los SQL históricos. Las copias previas al cambio de esquema y a las restauraciones permiten recuperar el estado anterior; sus verificaciones deben fallar antes de continuar si el respaldo no se puede crear.

Los identificadores persistentes se conservan aunque el nombre visible cambie a MazmiNotas. Los SQL históricos permanecen intactos. La migración 3 añade reparación de objetos y Markdown opcional en snapshots sin reconstruir la tabla de notas.

## Operaciones De Archivos

Exportar, importar, respaldar y restaurar pertenecen a comandos Rust. La UI pide confirmación para eliminar definitivamente y reemplazar la biblioteca desde una copia. Las rutas de restauración se restringen a las copias administradas; las operaciones deben validar el contenido antes de reemplazar datos.

Las notas eliminadas se muestran en lectura. Un fallo de guardado conserva el borrador y bloquea las acciones que requieren guardarlo antes. Al cerrar la ventana se intenta terminar el guardado; los borradores pendientes tienen recuperación local.

El navegador usa localStorage separado: sus copias están en el mismo almacén y comparten cuota. El almacenamiento corrupto produce error y no se trata silenciosamente como una biblioteca vacía.

## Límites

La base SQLite y las imágenes no están cifradas por la aplicación, salvo el contenido de las notas protegidas con contraseña (Argon2id + XChaCha20-Poly1305; ver docs/notas-protegidas.md). El resto depende del usuario y de los permisos del sistema operativo. La app no ofrece sincronización ni aislamiento frente a otros procesos del mismo usuario.

No se garantiza edición concurrente de una misma nota en varias pestañas o procesos. El historial conserva contenido previo; se requiere una política explícita de conflictos antes de añadir sincronización.

Los lockfiles de npm y Cargo forman parte del proyecto. Un build correcto no equivale a una auditoría de seguridad exhaustiva.

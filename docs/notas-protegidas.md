# Notas protegidas con contraseña

«Más acciones → Proteger con contraseña…». La nota queda bloqueada: al abrirla, la zona de
escritura muestra el fondo líquido y pide la contraseña.

## Qué se protege y cómo

- El contenido se cifra en el equipo con **XChaCha20-Poly1305**; la clave sale de la contraseña
  con **Argon2id** (19 MiB, 2 pasadas, sal aleatoria por nota). El id de la nota va autenticado:
  el contenido cifrado no se puede trasladar a otra nota.
- La nota guarda solo su **título** (visible en la lista, buscable, con carpetas y recordatorios).
  El contenido vive cifrado en `note_locks` (migración 0008).
- Al proteger: se borra el **historial de versiones** de esa nota (guardaba el texto en claro), se
  activa `secure_delete`, se compacta el índice de búsqueda y se vacía el diario WAL, para que el
  texto no quede en el archivo. Hay una prueba que lo busca en el archivo y en el WAL.
- Abierta, la clave vive solo en memoria y el autoguardado vuelve a cifrar. Al salir de la nota
  se olvida la clave. Las contraseñas incorrectas esperan cada vez más (hasta 8 s).
- No se guarda copia de recuperación en claro de sus borradores, no se exporta (Markdown, Word,
  carpeta: solo el título y un aviso) y no se puede duplicar.
- Las copias de seguridad incluyen el contenido **cifrado**: se restaura bloqueado.

## Límites

- **Sin recuperación**: si se olvida la contraseña, el contenido se pierde.
- Las **imágenes** de una nota protegida se guardan sin cifrar en `attachments/` (se conoce que
  existen, no a qué texto acompañan).
- Copias de seguridad hechas **antes** de proteger una nota la contienen en claro.
- Mientras la nota está abierta y desbloqueada, su texto está en memoria como cualquier otra.

# Comunidades que encienden su propio camino — Casa Pueblo

Sitio web para visibilizar iniciativas de energía comunitaria de Puerto Rico, América Latina y el Caribe, con un portal de administración para Casa Pueblo.

- **Frontend:** las 12 pantallas HTML originales (`*.html`, `admin/*.html`) con `css/styles.css` y `css/admin.css` sin modificar. Lo añadido vive en `css/extras.css` (funcionalidad), `css/theme.css` (tema visual: tipografía, ilustraciones y acabados, con la misma paleta), `js/main.js` (sitio público) y `js/admin.js` (portal). Las fuentes (`fonts/`, licencia SIL OFL) y las ilustraciones (`img/`) se sirven desde el propio sitio, sin servicios de terceros.
- **Backend:** un Cloudflare Worker (`src/`) que sirve los archivos estáticos y la API `/api/*` desde el mismo origen (sin CORS).
- **Base de datos:** Cloudflare D1 (SQLite), esquema en `migrations/`.
- **Mapa:** Leaflet 1.9.4 + OpenStreetMap (sin llaves de API).
- **Costo:** $0. Workers Free + D1 Free funcionan en una cuenta de Cloudflare **sin tarjeta de crédito**.

## Desarrollo local

Requiere Node.js 20 o más reciente.

```bash
npm install
npm run setup     # aplica las migraciones a la D1 local y crea el administrador de desarrollo
npm run dev       # http://localhost:8787
```

`npm run setup` crea `.dev.vars` (ignorado por git) con un `JWT_SECRET` aleatorio y el administrador local **`admin` / `admin123`**. Esa cuenta solo existe en tu base de datos local; la pantalla de login solo muestra esas credenciales cuando se abre desde `localhost`.

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Sitio + API en `http://localhost:8787` |
| `npm test` | Pruebas (Vitest dentro de workerd, con una D1 real en memoria) |
| `npm run typecheck` | Verificación de tipos de `src/` |
| `npm run db:migrate` | Aplica migraciones a la D1 local |
| `npm run seed` | Crea el administrador local y los secretos de `.dev.vars` (idempotente; `-- --reset` cambia la contraseña) |
| `npm run sync:excel` | Compara el libro de `private/` con la base de datos (simulación; `-- --apply` escribe) |

Para empezar de cero en local: borra `.wrangler/` y corre `npm run setup`.

## Despliegue en Cloudflare (sin tarjeta)

1. Crea una cuenta gratuita en Cloudflare. No añadas método de pago.
2. `npx wrangler login`
3. `npx wrangler d1 create casa-pueblo` y copia el `database_id` que imprime a `wrangler.jsonc`.
4. `npm run db:migrate:remote`
5. Define el secreto de sesión (una cadena larga y aleatoria, por ejemplo `openssl rand -hex 32`):
   `npx wrangler secret put JWT_SECRET`
6. Crea el primer administrador (la contraseña no se guarda en el repo; mínimo 12 caracteres):
   `ADMIN_USERNAME=... ADMIN_NAME="..." ADMIN_PASSWORD='...' npm run seed:remote`
7. `npm run deploy`

Opcional: `npx wrangler secret put SYNC_TOKEN` (mínimo 16 caracteres) permite que Power Query / Power Automate llamen a `/api/sync/excel` sin sesión de administrador.

**No añadas bindings `r2_buckets` ni `images` a `wrangler.jsonc`:** Cloudflare los bloquea en cuentas sin tarjeta y el despliegue fallaría.

`.assetsignore` limita lo que se publica como archivo estático a `*.html`, `admin/`, `css/`, `js/`, `fonts/` e `img/`. El código (`src/`), las migraciones y los secretos no son accesibles por URL. Si añades una carpeta pública nueva, agrégala ahí.

> Pendiente de verificar en el primer despliegue: el plan gratuito de Workers limita el tiempo de CPU por solicitud a 10 ms y el login calcula PBKDF2 con 100,000 iteraciones. En local funciona; hay que confirmar en producción que el login no excede el límite (si lo excediera, Cloudflare responde con el error 1102).

## Qué no se sube al repositorio

Este repositorio es **público**. `.gitignore` mantiene fuera de él:

- **Secretos:** `.dev.vars`, `.env*`, llaves y certificados. En producción se definen con `npx wrangler secret put`; solo se versionan las plantillas `*.example`.
- **Datos de Casa Pueblo:** el libro de Excel y cualquier exportación (`*.xlsx`, `*.csv`, …). Guárdalos en `private/` (ignorada) y cárgalos a la base de datos con `/api/sync/excel`. Contienen correos de contacto y notas internas.
- **Bases de datos y respaldos:** `.wrangler/`, `*.sqlite`, `*.dump.sql`, `backups/`.

Por la misma razón, `migrations/` solo debe contener datos que ya son públicos: nunca correos de contacto, notas internas, ubicaciones no autorizadas ni hashes de contraseñas. Antes de un commit, `git status` no debe listar ninguno de esos archivos.

## Reglas de privacidad

Estas reglas se aplican en el esquema, en la API y en los formularios.

**Ubicación opcional.** `location_text`, `latitude` y `longitude` aceptan `NULL` en todas las tablas. Las coordenadas van en pareja: las dos `NULL` o las dos válidas (WGS84), y nunca `(0, 0)`. La base de datos lo exige con un `CHECK`, la API responde `400`, y la sincronización de Excel convierte en `NULL` cualquier ubicación en blanco o inválida.

**Oculto por defecto.** La ubicación (`show_location`, `show_on_map`) y el contacto (`show_contact_email`, `show_submitter_*`) empiezan en `0`. Solo se publican si quien envía la información lo autoriza en `participar.html`, o si un administrador lo activa.

**Un interruptor por campo.** Cada campo tiene su propio `show_*`. Al aprobar una solicitud, el perfil publicado hereda las decisiones de quien la envió.

**Un único serializador público.** `publicCommunity()` en `src/lib/communities.ts` es la única forma en que una comunidad sale por los endpoints públicos. Construye la respuesta campo por campo (lista permitida), devuelve `null` en todo campo con `show_* = 0`, y nunca incluye notas internas, hashes ni identificadores administrativos. Detalles:

- Las coordenadas requieren `show_location = 1` **y** `show_on_map = 1`.
- Si el nombre está oculto, también se oculta el `slug` derivado del nombre (se usa `comunidad-<id>`).
- `region` (Puerto Rico / América Latina) se trata como categoría y siempre es pública. **Decisión a confirmar con Casa Pueblo.**
- Los comentarios de una solicitud (`submitter_comments`) y las notas internas (`private_comments`) nunca se publican.

## Autenticación

- Contraseñas con PBKDF2-SHA256 (Web Crypto, 100,000 iteraciones, sal por cuenta), formato `pbkdf2_sha256$100000$<sal>$<hash>`.
- `POST /api/auth/login` emite un JWT HS256 de 8 horas en una cookie `HttpOnly; SameSite=Lax; Secure`. Cada solicitud verifica además que la cuenta siga activa, así que desactivar un administrador corta su sesión de inmediato.
- Todo `/api/admin/*` responde `401` sin sesión. Las páginas `admin/*.html` (excepto login) redirigen a `admin/login.html` desde el servidor.
- Diez intentos fallidos en 15 minutos bloquean temporalmente ese usuario (`429`).
- Las escrituras con cookie desde otro origen se rechazan (`403`).
- Logins, cambios de estado, ediciones e importaciones quedan en `audit_logs`.

## API

Pública:

| Método | Ruta | |
| --- | --- | --- |
| GET | `/api/health` | Verifica la conexión a D1 |
| POST | `/api/auth/login` · `/api/auth/logout` | |
| GET | `/api/auth/me` | Administrador actual o `401` |
| POST | `/api/submissions` | Envío público (ubicación opcional, `show_*` por campo) |
| GET | `/api/communities` · `/api/communities/:slug` | Solo perfiles visibles, ya filtrados |
| GET | `/api/project-info` · `/api/allies` | |

Administración (requiere sesión):

| Método | Ruta |
| --- | --- |
| GET | `/api/admin/stats` |
| GET | `/api/admin/submissions` (`?status=&q=`) · `/api/admin/submissions/:id` |
| POST | `/api/admin/submissions/:id/approve` · `/reject` (`{ "comment" }`) |
| GET, POST | `/api/admin/communities` |
| GET, PUT, DELETE | `/api/admin/communities/:id` (PUT parcial; DELETE es borrado lógico) |
| PUT | `/api/admin/project-info/:section_key` |
| GET, POST | `/api/admin/administrators` · PUT `/api/admin/administrators/:id` |

Sincronización (sesión de administrador o `Authorization: Bearer <SYNC_TOKEN>`): `GET` y `POST /api/sync/excel`.

## Sincronización Excel → base de datos (una sola dirección)

Casa Pueblo mantiene su propio libro de Excel (`Mapeo Inicial_CP2.xlsx`, pestañas `Puerto Rico`, `América Latina`, `Otros`). El sistema **lee** ese libro y **nunca escribe en él**: los identificadores y hashes de seguimiento viven en nuestra base de datos.

1. Cada fila se identifica con una llave determinista derivada de la pestaña y el nombre (`pr:casa-pueblo`, `al:fundacion-kara-solar`).
2. De cada fila se calcula un SHA-256 (`incoming_excel_hash`) sobre sus campos normalizados.
3. Se compara con dos hashes guardados en `communities`: `last_synced_excel_hash` (la fila la última vez que se sincronizó) y `current_db_hash` (el registro tal como está ahora; se recalcula cada vez que un administrador lo edita).

| Resultado | Condición | Acción |
| --- | --- | --- |
| `unchanged` | Excel no cambió desde la última sincronización | Nada. Las ediciones del portal se conservan |
| `updated_in_excel` | Excel cambió y el portal no | Se aplica el cambio |
| `conflict_both_modified` | Cambiaron los dos | No se sobrescribe; queda en `audit_logs` (`excel_conflict`) para revisión |
| `new_from_excel` | No existe en la base de datos | Se inserta **oculto** (`is_visible = 0`) hasta que un administrador lo publique |

La sincronización solo cambia las columnas que vienen del libro (`trackedFields`). Nunca toca los interruptores de visibilidad ni las coordenadas del mapa: el libro no tiene columnas de latitud/longitud, así que los marcadores se administran desde el portal. Las filas que desaparecen del Excel no se borran: se reportan en `missing_in_excel`. Las seis comunidades sembradas adoptan los valores del Excel en su primera sincronización, salvo que un administrador haya editado su contenido antes (eso sería un conflicto).

### Cómo se lee el libro

| Pestaña | Columnas | Destino |
| --- | --- | --- |
| `Puerto Rico` | Junte - Transición Energética · Energías Comunitaria · Localización · Descripción · Propuestas · Proyectos · Website · Contacto · Comentarios | `communities` (región Puerto Rico; Localización es el municipio) |
| `Puerto Rico`, al final | El encabezado `Aliados` seguido de un nombre por fila | `allies` |
| `América Latina` | Las mismas columnas sin "Junte" | `communities` (región América Latina; Localización es el **país**) |
| `Otros` | Aliados · Lugar · Website | `allies` |

- **Proyectos** se guarda en `energy_initiative_details`, **Propuestas** en `proposals_tags` (los filtros de `comunidades.html` se generan a partir de estas etiquetas).
- **Contacto** y **Comentarios** se guardan como privados (`private_contact_email`, `private_comments`) y no se publican.
- Un aliado repetido en dos pestañas es un solo aliado. `UPR` y `University of Puerto Rico` se tratan como el mismo (`nameAliases`).
- Los encabezados se comparan sin distinguir mayúsculas, acentos ni espacios. Si Casa Pueblo renombra una columna, se añade el alias en `DEFAULT_SYNC_CONFIG` (`src/lib/excel-sync/normalizer.ts`).

### Cargar el libro

El libro vive en `private/` (ignorada por git y no accesible desde el sitio). `scripts/sync-excel.mjs` lo abre en modo de solo lectura, sin dependencias externas, y envía sus filas a `/api/sync/excel`.

```bash
# Local (con `npm run dev` corriendo en otra terminal)
npm run sync:excel              # simulación: muestra qué cambiaría, no escribe
npm run sync:excel -- --apply   # actualiza la base de datos local

# Producción (el token es el guardado con `npx wrangler secret put SYNC_TOKEN`)
SYNC_TOKEN=... npm run sync:excel -- --url https://<worker>.workers.dev            # simulación
SYNC_TOKEN=... npm run sync:excel -- --url https://<worker>.workers.dev --apply
```

El comando imprime solo nombres y decisiones, nunca correos ni notas. Se puede repetir cada vez que Casa Pueblo actualice el libro: las filas sin cambios se omiten.

El código de la sincronización (`src/lib/excel-sync/`):

- `normalizer.ts` — configuración del libro (`DEFAULT_SYNC_CONFIG`) y normalización de filas.
- `change-tracker.ts` — `reconcileSheetsWithBaselines()`, la comparación de hashes, sin acceso a red ni a la base de datos.
- `adapters.ts` — fuentes de solo lectura: `PushPayloadExcelAdapter` (el script anterior, Power Query o Power Automate), `HostedJsonFeedAdapter` (variable `EXCEL_FEED_URL`), `MicrosoftGraphReadOnlyWorkbookAdapter` (OneDrive/SharePoint; todavía no conectado a una ruta) y `TemplateFixtureExcelAdapter` (un libro inventado con el mismo formato, para pruebas).
- `docs/power-query-template.pq` — plantilla para enviar el libro desde Excel. **No se ha probado todavía.**

## Datos iniciales

`migrations/0002_seed.sql` siembra seis comunidades del libro de Casa Pueblo y el contenido de `proyecto.html`. El repositorio es público, así que la migración solo contiene eso; el resto de la información entra con `npm run sync:excel`.

- **Los textos sembrados son borradores.** La primera sincronización los reemplaza con los del libro y añade las demás comunidades y los aliados.
- Las comunidades nuevas que llegan del libro entran **ocultas**; un administrador las publica desde el portal.
- Siguiendo la regla de privacidad, solo Casa Pueblo aparece con ubicación y en el mapa. Las demás tienen la ubicación oculta hasta que se autorice.

## Pendiente para próximos sprints

- Imágenes de comunidades: no hay almacenamiento de archivos (R2 no está disponible sin tarjeta).
- Conectar el adaptador de Microsoft Graph cuando Casa Pueblo confirme dónde está alojado el libro.
- Pantalla para revisar los conflictos de sincronización registrados en `audit_logs`.
- El formulario público no tiene protección contra envíos automatizados (por ejemplo, Cloudflare Turnstile, que es gratuito).

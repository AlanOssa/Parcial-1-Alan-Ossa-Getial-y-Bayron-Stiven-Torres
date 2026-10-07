# Huellas del Valle · Sistema de agendamiento

Sitio estático (sin frameworks, sin build, sin backend) que sirve como sistema de información propio de la **Clínica Veterinaria Huellas del Valle S.A.S.** (Cali).

Al agendar una cita, la página dispara el webhook de un escenario de Make. Ese escenario consulta la franja en Google Sheets, calcula `libres = cupo − ocupados`, decide la ruta y le contesta a la página con un *Webhook response*. La página muestra esa respuesta con color, icono y detalle.

---

## 1. Árbol de archivos

```
.
├── index.html        Marcado semántico (sin estilos ni scripts en línea)
├── css/
│   └── styles.css    Todo el diseño
├── js/
│   ├── config.js     Configuración editable
│   └── app.js        Toda la lógica
├── netlify.toml      publish = "."
└── README.md         Este archivo
```

No hay dependencias ni `package.json`. El sitio funciona igual abriendo `index.html` con doble clic o publicado en Netlify.

---

## 2. Configurar `js/config.js`

Es el único archivo que necesitas tocar. Expone un solo objeto global:

| Clave | Para qué sirve |
|---|---|
| `WEBHOOK_URL` | URL del webhook del escenario 1 en Make. |
| `SHEET_ID` | Identificador de la Google Sheet que usa el escenario. |
| `SHEET_AGENDA` | Nombre de la pestaña con las franjas y cupos. |
| `SHEET_CITAS` | Nombre de la pestaña donde se registran las citas. |
| `HORAS` | Horas que ofrece el formulario, como texto `HH:MM`. |
| `TIMEOUT_MS` | Tiempo máximo de espera del webhook, en milisegundos. |

**Dónde sale el `SHEET_ID`.** Es la parte larga de la URL de la hoja, entre `/d/` y `/edit`:

```
https://docs.google.com/spreadsheets/d/16AQVpl9gTBV9OI9hEKf6hmz9Kp_SMZQdtKrhjOGqfkE/edit
                                       └──────────────── esto es el SHEET_ID ───────────────┘
```

> **Importante:** en este archivo no van tokens, claves ni contraseñas. `config.js` se publica tal cual y cualquiera puede leerlo desde el navegador.

---

## 3. Publicar la Google Sheet

La **Vista 2 · Agenda del día** lee los datos directamente de la hoja con el endpoint `gviz` en CSV. Eso admite CORS y no gasta operaciones de Make, pero exige que la hoja sea de lectura pública:

1. Abre la hoja en Google Sheets.
2. Pulsa **Compartir** (arriba a la derecha).
3. En **Acceso general**, cambia *Restringido* por **Cualquier persona con el enlace**.
4. Deja el rol en **Lector**.
5. Guarda y recarga la página.

Si no haces esto, la Vista 2 muestra un aviso con estas mismas instrucciones en vez de romperse.

### Estructura esperada de las pestañas

**`agenda`** — `franja | fecha | hora | cupo | ocupados`
**`citas`** — `id_cita | solicitado_en | propietario | correo | mascota | especie | servicio | franja | fecha | hora | estado | libres_despues | canal`

Las columnas se mapean **por nombre de encabezado**, no por posición, sin distinguir mayúsculas, tildes ni espacios. Además se aceptan sinónimos frecuentes, de modo que si tu hoja usa `fecha_solicitud` en lugar de `solicitado_en`, o `cupos` en lugar de `cupo`, la página igual los encuentra. Tampoco importa si sobran o faltan columnas.

También da igual que Google devuelva la fecha como `14/10/2026` o la hora como `8:00:00`: todo se normaliza a `AAAA-MM-DD` y `HH:MM` antes de filtrar. Las celdas vacías en `ocupados` cuentan como `0`.

---

## 4. Desplegar en Netlify

1. Entra en [app.netlify.com](https://app.netlify.com) con tu cuenta.
2. Ve a **Sites** y busca la zona **Deploy manually** (o *Add new site → Deploy manually*).
3. Arrastra **la carpeta completa** del proyecto (no un `.zip`, no solo el `index.html`).
4. Netlify publica y te da una URL del tipo `https://algo-aleatorio.netlify.app`.

Para actualizar, arrastra la carpeta otra vez sobre el mismo sitio. El `netlify.toml` solo dice `publish = "."`, porque no hay nada que compilar.

### Probar en local

```bash
python -m http.server 8080
# o bien
npx serve .
```

Y luego entra a `http://localhost:8080`.

> **Sobre abrir `index.html` con doble clic.** La vista **Agendar cita** funciona perfectamente así: el formulario valida, los casos de prueba rellenan y el envío al webhook se hace igual.
>
> La vista **Agenda del día**, en cambio, necesita `http://` o `https://`. Con `file://` el navegador envía el origen `null` y Google bloquea la lectura de la hoja por CORS, aunque esté compartida públicamente. No es un error del sitio ni de los permisos: es una regla de seguridad del navegador. La página lo detecta y te explica qué hacer en vez de quedarse en blanco. Para usar esa vista, levanta el servidor local de arriba o ábrela desde la URL de Netlify.

---

## 5. Cómo usar la página

### Vista 1 · Agendar cita

El formulario envía al webhook, por `POST` con cuerpo `application/x-www-form-urlencoded`, estos campos:

| Campo | Origen |
|---|---|
| `propietario`, `correo`, `mascota`, `especie`, `servicio` | Lo que escribe el usuario |
| `fecha` | Siempre texto `AAAA-MM-DD` |
| `hora` | Siempre texto `HH:MM` con cero a la izquierda |
| `franja` | Lo arma la página: `` `${fecha} ${hora}` `` |
| `solicitado_en` | Fecha-hora local de Bogotá, `AAAA-MM-DD HH:MM:SS` |
| `canal` | Siempre `"web"` |

Se usa `URLSearchParams` a propósito: así es una *petición simple*, no hay preflight CORS, y Make recibe los campos como variables sueltas. Mientras espera, el botón se deshabilita y muestra un spinner, para que un doble clic no dañe los cupos.

**Panel "Casos de prueba".** Los cinco botones **solo rellenan** el formulario; el envío lo haces tú con *Agendar cita*, porque el enunciado pide que los casos se ejecuten desde la interfaz. El correo que escribas en ese panel se recuerda mientras la página esté abierta. Después de cada envío, el caso queda marcado con ✓ si el estado obtenido coincide con el esperado, o ✗ si no.

**Panel "Traza de envíos".** Hora exacta, caso, franja, estado obtenido y tiempo de respuesta en milisegundos. Sirve para las capturas del informe. Vive solo en memoria: se borra al recargar.

### Vista 2 · Agenda del día

Pestaña aparte (`#agenda`). Muestra los indicadores del día, una tarjeta por franja con su barra de ocupación y color (verde con 2 o más libres, ámbar con 1, rojo con 0), y la tabla de citas ordenada por hora. Tras un envío exitoso, la agenda se marca para recargarse sola al abrir la pestaña.

---

## 6. Si no ves respuesta del proceso

La página nunca falla en silencio: cada problema tiene su propio mensaje. Estos son los tres que más aparecen y cómo se arreglan, todos **del lado de Make**:

### «Sin respuesta del proceso» (el webhook devolvió `Accepted`)

Make contesta `Accepted` cuando recibe los datos pero no tiene nada que responder. Pasa en dos situaciones:

- **El escenario está apagado.** Actívalo con el interruptor de la esquina inferior izquierda del editor. Ojo: mientras está apagado, las peticiones se quedan **encoladas** y se ejecutarán todas de golpe al encenderlo.
- **El escenario no termina en un módulo *Webhook response*.** Añádelo como último módulo de cada ruta.

### «La respuesta no es JSON válido»

El escenario respondió, pero el cuerpo no se puede interpretar. La causa habitual es armar un número concatenando texto. Si en el *Set variable* pones `{{cupo}}-{{ocupados}}`, Make no resta: produce la cadena `3-0`. Al inyectarla sin comillas en el body, el JSON queda como `{"libres":3-0}`, que es inválido.

La solución es envolver la resta en una expresión aritmética para que dé un número de verdad, o entrecomillar el valor en el body. La página te muestra el cuerpo crudo para que veas exactamente qué llegó.

### «No se pudo contactar el webhook»

Error de red, URL equivocada o CORS. Si el navegador bloquea la respuesta, el módulo *Webhook response* debe incluir la cabecera `Access-Control-Allow-Origin: *`.

### Nota sobre los casos C2 y C3

Para que el caso **C2** devuelva *Confirmada con alerta* y el **C3** devuelva *Rechazada*, la pestaña `agenda` tiene que tener la columna `ocupados` cargada en esas franjas. Con `ocupados` vacío, el proceso ve la franja libre y responde *Confirmada*, así que la página marcará ✗ sobre el resultado esperado. Revisa que el `2026-10-14` tenga valores coherentes en las filas de las `10:00` y las `11:00` antes de tomar las capturas.

---

## 7. Accesibilidad y diseño

- Etiquetas `<label>` reales en todos los campos y mensajes de error junto a cada uno.
- Pestañas con `role="tablist"`, `role="tab"` y `role="tabpanel"`; navegación por hash (`#agendar`, `#agenda`).
- La tarjeta de resultado es una región `aria-live="polite"`, así que un lector de pantalla anuncia la respuesta del proceso.
- Las barras de ocupación exponen su valor con `role="img"` y `aria-label`.
- Foco visible en todos los controles y enlace de *Saltar al contenido*.
- Modo oscuro automático con `prefers-color-scheme`, y animaciones anuladas con `prefers-reduced-motion`.
- Sin `alert()` ni `confirm()`. Sin `localStorage`.

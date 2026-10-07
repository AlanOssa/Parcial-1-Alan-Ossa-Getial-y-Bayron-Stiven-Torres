/* ==========================================================================
   Huellas del Valle · lógica del sistema de agendamiento
   Sin dependencias. Todo vive dentro de este IIFE.
   ========================================================================== */
(function () {
  'use strict';

  /* --------------------------- 1. Configuración --------------------------- */

  // Valores por defecto, por si config.js no se cargó o viene incompleto.
  var POR_DEFECTO = {
    WEBHOOK_URL: '',
    SHEET_ID: '',
    SHEET_AGENDA: 'agenda',
    SHEET_CITAS: 'citas',
    HORAS: ['08:00', '09:00', '10:00', '11:00'],
    TIMEOUT_MS: 30000
  };
  var CFG = Object.assign({}, POR_DEFECTO, (typeof window !== 'undefined' && window.APP_CONFIG) || {});

  var SERVICIOS = ['Consulta general', 'Vacunación', 'Baño', 'Ecografía'];
  var PROPIETARIO_SUGERIDO = 'Ana Gómez';

  // Los 5 casos del enunciado. Los botones solo rellenan: el envío lo hace el usuario.
  var CASOS = [
    { id: 'C1', mascota: 'Luna',   especie: 'perro', servicio: 'Consulta general', fecha: '2026-10-14', hora: '08:00', esperado: 'CONFIRMADA',        etiqueta: 'Confirmada' },
    { id: 'C2', mascota: 'Michi',  especie: 'gato',  servicio: 'Vacunación',       fecha: '2026-10-14', hora: '10:00', esperado: 'CONFIRMADA_ALERTA', etiqueta: 'Confirmada con alerta' },
    { id: 'C3', mascota: 'Rocky',  especie: 'perro', servicio: 'Baño',             fecha: '2026-10-14', hora: '11:00', esperado: 'RECHAZADA',         etiqueta: 'Rechazada' },
    { id: 'C4', mascota: 'Pelusa', especie: 'gato',  servicio: 'Consulta general', fecha: '2026-10-20', hora: '08:00', esperado: 'RESPALDO',          etiqueta: 'Respaldo' },
    { id: 'C5', mascota: 'Luna',   especie: 'perro', servicio: 'Baño',             fecha: '2026-10-14', hora: '09:00', esperado: 'DUPLICADA',         etiqueta: 'Duplicada' }
  ];

  /* --------------------------- 2. Estado en memoria --------------------------- */

  var correoRecordado = '';     // se recuerda para no reescribirlo en cada caso
  var casoActivo = null;        // último caso cargado en el formulario
  var enviando = false;         // candado contra dobles envíos
  var traza = [];               // solo en memoria, nunca localStorage
  var marcasCasos = {};         // id del caso -> true (coincide) / false (no coincide)
  var agendaSucia = true;       // obliga a recargar la agenda al abrir la pestaña

  /* --------------------------- 3. Utilidades --------------------------- */

  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  // Escapa texto antes de inyectarlo como HTML.
  function esc(valor) {
    var mapa = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(valor == null ? '' : valor).replace(/[&<>"']/g, function (c) { return mapa[c]; });
  }

  // Mayúsculas, sin tildes, sin espacios dobles; los espacios quedan como "_".
  function norm(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '_');
  }

  // Clave de columna: minúscula, sin tildes, sin espacios ni signos.
  function claveCol(texto) {
    return norm(texto).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // Google puede devolver 14/10/2026; aquí todo queda como AAAA-MM-DD.
  function fechaISO(valor) {
    var t = String(valor == null ? '' : valor).trim();
    if (!t) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    var m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);       // 14/10/2026
    if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
    m = t.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);           // 2026/10/14
    if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    m = t.match(/^(\d{4}-\d{2}-\d{2})[T ]/);                          // 2026-10-14 08:00
    if (m) return m[1];
    m = t.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/);                // Date(2026,9,14) de gviz
    if (m) return m[1] + '-' + pad2(Number(m[2]) + 1) + '-' + pad2(m[3]);
    return t;
  }

  // Google puede devolver 8:00:00; aquí todo queda como HH:MM.
  function horaHHMM(valor) {
    var t = String(valor == null ? '' : valor).trim();
    if (!t) return '';
    var m = t.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      var h = Number(m[1]);
      if (/p\.?\s?m/i.test(t) && h < 12) h += 12;
      if (/a\.?\s?m/i.test(t) && h === 12) h = 0;
      return pad2(h) + ':' + m[2];
    }
    if (/^\d{1,2}$/.test(t)) return pad2(t) + ':00';
    return t;
  }

  // La hoja trae celdas vacías en "ocupados": deben contar como 0, no como NaN.
  function num(valor) {
    if (valor == null) return 0;
    var t = String(valor).trim().replace(/\s/g, '').replace(',', '.');
    if (!t) return 0;
    var n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }

  // Fecha y hora locales de Bogotá, sin depender de la zona del navegador.
  function partesBogota() {
    var p = {};
    new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return p;
  }
  function selloBogota() {
    var p = partesBogota();
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
  }
  function relojBogota() {
    var p = partesBogota();
    return p.hour + ':' + p.minute + ':' + p.second;
  }

  /* --------------------------- 4. Estados del proceso --------------------------- */

  var ESTADOS = {
    CONFIRMADA:        { clase: 'es-ok',        icono: '✅', titulo: 'Cita confirmada' },
    CONFIRMADA_ALERTA: { clase: 'es-alerta',    icono: '⚠️', titulo: 'Confirmada · franja casi llena/llena, se avisó a administración' },
    RECHAZADA:         { clase: 'es-rechazo',   icono: '⛔', titulo: 'Franja sin cupo · no se registró nada' },
    DUPLICADA:         { clase: 'es-duplicada', icono: '\u{1F501}', titulo: 'La mascota ya tiene cita ese día' },
    RESPALDO:          { clase: 'es-respaldo',  icono: '\u{1F5C2}️', titulo: 'Franja no existe en la agenda · quedó registrada la incidencia' }
  };
  var ESTADO_GENERICO = { clase: 'es-info', icono: 'ℹ️', titulo: 'El proceso respondió' };

  // Acepta mayúsculas/minúsculas, espacios, tildes y "CONFIRMADA CON ALERTA".
  function normalizarEstado(valor) {
    var e = norm(valor).replace(/^ESTADO_/, '');
    if (!e) return '';
    if (e === 'CONFIRMADA_CON_ALERTA' || e === 'CONFIRMADA_ALERTA' || e === 'ALERTA') return 'CONFIRMADA_ALERTA';
    if (e === 'CONFIRMADO' || e === 'CONFIRMADA') return 'CONFIRMADA';
    if (e === 'RECHAZADO' || e === 'RECHAZADA' || e === 'SIN_CUPO') return 'RECHAZADA';
    if (e === 'DUPLICADO' || e === 'DUPLICADA') return 'DUPLICADA';
    if (e === 'BACKUP' || e === 'RESPALDO') return 'RESPALDO';
    return e;
  }
  function infoEstado(estado) { return ESTADOS[estado] || ESTADO_GENERICO; }

  /* --------------------------- 5. Lectura y validación del formulario --------------------------- */

  function valor(sel) { var el = $(sel); return el ? String(el.value || '').trim() : ''; }
  function radio(nombre) {
    var el = $('input[name="' + nombre + '"]:checked');
    return el ? el.value : '';
  }

  function leerFormulario() {
    return {
      propietario: valor('#propietario'),
      correo: valor('#correo'),
      mascota: valor('#mascota'),
      especie: radio('especie'),
      servicio: radio('servicio'),
      fecha: fechaISO(valor('#fecha')),   // siempre texto AAAA-MM-DD
      hora: horaHHMM(valor('#hora'))      // siempre texto HH:MM
    };
  }

  var RE_CORREO = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

  function validar(d) {
    var e = {};
    if (!d.propietario) e.propietario = 'Escribe el nombre del propietario.';
    if (!d.correo) e.correo = 'Escribe un correo electrónico.';
    else if (!RE_CORREO.test(d.correo)) e.correo = 'Ese correo no tiene un formato válido.';
    if (!d.mascota) e.mascota = 'Escribe el nombre de la mascota.';
    if (!d.especie) e.especie = 'Elige si es perro o gato.';
    if (!d.servicio) e.servicio = 'Elige uno de los cuatro servicios.';
    // Solo se valida el FORMATO: no se bloquean fechas que no existan en la hoja (caso C4).
    if (!d.fecha) e.fecha = 'Elige la fecha de la cita.';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha)) e.fecha = 'La fecha debe quedar como AAAA-MM-DD.';
    if (!d.hora) e.hora = 'Elige la hora de la cita.';
    else if (!/^\d{2}:\d{2}$/.test(d.hora)) e.hora = 'La hora debe quedar como HH:MM.';
    return e;
  }

  var CAMPOS = ['propietario', 'correo', 'mascota', 'especie', 'servicio', 'fecha', 'hora'];

  function pintarErrores(errores) {
    CAMPOS.forEach(function (campo) {
      var caja = $('#err-' + campo);
      var entrada = $('#' + campo);
      var msg = errores[campo] || '';
      if (caja) caja.textContent = msg;
      if (entrada) {
        if (msg) entrada.setAttribute('aria-invalid', 'true');
        else entrada.removeAttribute('aria-invalid');
      }
    });
  }

  function limpiarErrores() { pintarErrores({}); }

  function enfocarPrimerError(errores) {
    for (var i = 0; i < CAMPOS.length; i++) {
      if (!errores[CAMPOS[i]]) continue;
      var el = $('#' + CAMPOS[i]) || $('input[name="' + CAMPOS[i] + '"]');
      if (el && el.focus) { el.focus(); }
      return;
    }
  }

  /* --------------------------- 6. Tarjeta de resultado --------------------------- */

  function caja() { return $('#resultado'); }

  function barraHTML(ocupados, cupo) {
    var pct = cupo > 0 ? Math.min(100, Math.round((ocupados / cupo) * 100)) : 0;
    var etiqueta = ocupados + ' de ' + cupo + ' cupos ocupados, ' + pct + ' por ciento';
    return '<div class="barra-bloque">' +
      '<div class="barra-rotulo"><span>Ocupación de la franja</span><span>' + ocupados + ' / ' + cupo + '</span></div>' +
      '<div class="barra" role="img" aria-label="' + esc(etiqueta) + '">' +
      '<span class="barra-relleno" style="--pct:' + pct + '%"></span></div></div>';
  }

  function hayDato(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }

  function pintarResultado(json, franjaEnviada) {
    var destino = caja();
    if (!destino) return;

    var estado = normalizarEstado(json.estado);
    var info = infoEstado(estado);
    var franja = hayDato(json.franja) ? String(json.franja) : franjaEnviada;

    var datos = [];
    if (hayDato(franja)) datos.push(['Franja', franja]);
    if (hayDato(json.cupo)) datos.push(['Cupo', json.cupo]);
    if (hayDato(json.ocupados)) datos.push(['Ocupados', json.ocupados]);
    if (hayDato(json.libres)) datos.push(['Libres', json.libres]);
    if (hayDato(json.id_cita)) datos.push(['ID de la cita', json.id_cita]);

    var html = '<div class="tarjeta-resultado ' + info.clase + '">' +
      '<div class="res-cabeza">' +
        '<span class="res-icono" aria-hidden="true">' + info.icono + '</span>' +
        '<div>' +
          '<span class="res-etiqueta">' + esc(estado || 'Sin estado') + '</span>' +
          '<h3 class="res-titulo">' + esc(info.titulo) + '</h3>' +
        '</div>' +
      '</div>';

    if (hayDato(json.mensaje)) html += '<p class="res-mensaje">' + esc(json.mensaje) + '</p>';

    if (datos.length) {
      html += '<dl class="res-datos">' + datos.map(function (par) {
        return '<div><dt>' + esc(par[0]) + '</dt><dd>' + esc(par[1]) + '</dd></div>';
      }).join('') + '</dl>';
    }

    if (hayDato(json.cupo) && num(json.cupo) > 0) html += barraHTML(num(json.ocupados), num(json.cupo));

    destino.innerHTML = html + '</div>';
  }

  function pintarAviso(clase, icono, titulo, mensaje, crudo) {
    var destino = caja();
    if (!destino) return;
    var html = '<div class="tarjeta-resultado ' + clase + '">' +
      '<div class="res-cabeza">' +
        '<span class="res-icono" aria-hidden="true">' + icono + '</span>' +
        '<div><h3 class="res-titulo">' + esc(titulo) + '</h3></div>' +
      '</div>' +
      '<p class="res-mensaje">' + esc(mensaje) + '</p>';
    if (crudo) html += '<pre class="res-crudo">' + esc(crudo) + '</pre>';
    destino.innerHTML = html + '</div>';
  }

  function pintarCargando(franja) {
    var destino = caja();
    if (!destino) return;
    destino.innerHTML = '<div class="tarjeta-resultado es-info">' +
      '<div class="res-cabeza"><span class="res-icono" aria-hidden="true">⏳</span>' +
      '<div><h3 class="res-titulo">Consultando el proceso…</h3></div></div>' +
      '<p class="res-mensaje">Revisando el cupo de la franja ' + esc(franja) + '.</p></div>';
  }

  /* --------------------------- 7. Envío al webhook --------------------------- */

  function cargando(btn, activo, textoCargando) {
    if (!btn) return;
    btn.disabled = !!activo;
    btn.classList.toggle('cargando', !!activo);
    var texto = $('.boton-texto', btn);
    if (!texto) return;
    if (activo) {
      if (!btn.dataset.textoOriginal) btn.dataset.textoOriginal = texto.textContent;
      texto.textContent = textoCargando || 'Un momento…';
    } else if (btn.dataset.textoOriginal) {
      texto.textContent = btn.dataset.textoOriginal;
    }
  }

  function enviar(evento) {
    evento.preventDefault();
    if (enviando) return;   // blindaje contra dobles envíos: dañarían los cupos

    var datos = leerFormulario();
    var errores = validar(datos);
    pintarErrores(errores);
    if (Object.keys(errores).length) { enfocarPrimerError(errores); return; }

    var franja = datos.fecha + ' ' + datos.hora;

    // Cuerpo urlencoded: petición simple, sin preflight CORS.
    // Al pasar el URLSearchParams directo, fetch pone el Content-Type correcto.
    var cuerpo = new URLSearchParams();
    cuerpo.set('propietario', datos.propietario);
    cuerpo.set('correo', datos.correo);
    cuerpo.set('mascota', datos.mascota);
    cuerpo.set('especie', datos.especie);
    cuerpo.set('servicio', datos.servicio);
    cuerpo.set('fecha', datos.fecha);
    cuerpo.set('hora', datos.hora);
    cuerpo.set('franja', franja);
    cuerpo.set('solicitado_en', selloBogota());
    cuerpo.set('canal', 'web');

    var btn = $('#btn-enviar');
    var ctrl = new AbortController();
    var temporizador = setTimeout(function () { ctrl.abort(); }, CFG.TIMEOUT_MS);
    var inicio = Date.now();
    var caso = casoActivo;

    enviando = true;
    cargando(btn, true, 'Enviando…');
    pintarCargando(franja);

    fetch(CFG.WEBHOOK_URL, { method: 'POST', body: cuerpo, signal: ctrl.signal })
      .then(function (res) {
        return res.text().then(function (texto) {
          return interpretar(res, String(texto || '').trim(), franja);
        });
      })
      .catch(function (error) { return pintarFallo(error); })
      .then(function (estado) {
        clearTimeout(temporizador);
        enviando = false;
        cargando(btn, false);
        registrarTraza(caso, franja, estado, Date.now() - inicio);
        marcarCaso(caso, estado);
      });
  }

  // Decide qué mostrar según lo que realmente devolvió Make.
  function interpretar(res, texto, franja) {
    // a) El escenario recibió la solicitud pero no respondió nada útil.
    if (!texto || /^accepted$/i.test(texto)) {
      pintarAviso('es-alerta', '⚠️', 'Sin respuesta del proceso',
        'El escenario recibió la solicitud pero no devolvió respuesta. Revisa que el escenario esté activo y termine en un Webhook response.',
        texto ? 'Cuerpo recibido: ' + texto : 'El cuerpo de la respuesta llegó vacío.');
      return 'SIN_RESPUESTA';
    }

    var json = null;
    try { json = JSON.parse(texto); } catch (e) { json = null; }

    // c) Llegó JSON: se pinta el resultado.
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      pintarResultado(json, franja);
      agendaSucia = true;   // la agenda debe recargarse al abrir la pestaña
      return normalizarEstado(json.estado) || 'SIN_ESTADO';
    }

    if (!res.ok) {
      pintarAviso('es-rechazo', '⛔', 'El proceso respondió con error HTTP ' + res.status,
        'Make devolvió un código de error. Revisa el historial de ejecuciones del escenario para ver qué módulo falló.',
        texto);
      return 'HTTP_' + res.status;
    }

    // Respondió, pero el cuerpo no se puede leer como JSON.
    pintarAviso('es-alerta', '⚠️', 'La respuesta no es JSON válido',
      'El escenario respondió, pero el cuerpo no se puede interpretar como JSON. Suele pasar cuando un número del Webhook response se arma concatenando texto: por ejemplo, si "libres" sale como 3-0 en lugar de 3, el JSON queda roto.',
      texto);
    return 'JSON_INVALIDO';
  }

  // b) Error de red, CORS o timeout: nunca falla en silencio.
  function pintarFallo(error) {
    if (error && error.name === 'AbortError') {
      pintarAviso('es-rechazo', '⏱️', 'Se agotó el tiempo de espera',
        'El proceso no respondió en ' + Math.round(CFG.TIMEOUT_MS / 1000) + ' segundos. Puede que el escenario esté tardando o que se haya quedado detenido en un módulo. Revisa el historial de ejecuciones en Make.');
      return 'TIMEOUT';
    }
    pintarAviso('es-rechazo', '\u{1F50C}', 'No se pudo contactar el webhook',
      'La petición no llegó a su destino. Revisa tu conexión, que la URL del webhook en config.js sea correcta, y que el escenario de Make exista y esté activo. Si el navegador bloqueó la respuesta por CORS, el Webhook response debe incluir la cabecera Access-Control-Allow-Origin.',
      error && error.message ? String(error.message) : '');
    return 'ERROR_RED';
  }

  /* --------------------------- 8. Traza de envíos --------------------------- */

  function registrarTraza(caso, franja, estado, ms) {
    traza.unshift({
      hora: relojBogota(),
      caso: caso ? caso.id : '—',
      franja: franja,
      estado: estado || '—',
      ms: ms
    });
    renderTraza();
  }

  function renderTraza() {
    var lista = $('#traza');
    var vacia = $('#traza-vacia');
    if (!lista) return;
    lista.innerHTML = traza.map(function (t) {
      return '<li>' +
        '<span class="traza-hora">' + esc(t.hora) + '</span>' +
        '<span class="traza-caso">' + esc(t.caso) + '</span>' +
        '<span class="traza-franja">' + esc(t.franja) + '</span>' +
        '<span class="traza-estado">' + esc(t.estado) + '</span>' +
        '<span class="traza-ms">' + esc(t.ms) + ' ms</span>' +
        '</li>';
    }).join('');
    if (vacia) vacia.hidden = traza.length > 0;
  }

  /* --------------------------- 9. Casos de prueba --------------------------- */

  function renderCasos() {
    var cont = $('#casos');
    if (!cont) return;
    cont.innerHTML = CASOS.map(function (c) {
      var marca = marcasCasos[c.id];
      var icono = '';
      if (marca === true) icono = '<span class="caso-marca bien" title="Coincide con lo esperado">✓</span>';
      else if (marca === false) icono = '<span class="caso-marca mal" title="No coincide con lo esperado">✗</span>';
      return '<li><button type="button" class="caso-boton" data-caso="' + esc(c.id) + '">' +
        '<span class="caso-id">' + esc(c.id) + '</span>' +
        '<span class="caso-desc">' + esc(c.mascota + ' · ' + c.especie + ' · ' + c.servicio) + '</span>' +
        '<span class="caso-esperado">' + esc(c.etiqueta) + icono + '</span>' +
        '<span class="caso-meta">' + esc(c.fecha + ' · ' + c.hora) + '</span>' +
        '</button></li>';
    }).join('');
  }

  function marcarCaso(caso, estado) {
    if (!caso) return;
    marcasCasos[caso.id] = (estado === caso.esperado);
    renderCasos();
  }

  function ponerValor(sel, v) { var el = $(sel); if (el) el.value = v; }
  function marcarRadio(nombre, v) {
    $$('input[name="' + nombre + '"]').forEach(function (el) { el.checked = (el.value === v); });
  }

  function llenarCaso(caso) {
    casoActivo = caso;
    ponerValor('#propietario', PROPIETARIO_SUGERIDO);
    ponerValor('#correo', correoRecordado);
    ponerValor('#mascota', caso.mascota);
    marcarRadio('especie', caso.especie);
    marcarRadio('servicio', caso.servicio);
    ponerValor('#fecha', caso.fecha);
    ponerValor('#hora', caso.hora);
    limpiarErrores();
    actualizarFranjaPrevia();
    var form = $('#form-cita');
    if (form && form.scrollIntoView) {
      var suave = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      form.scrollIntoView({ behavior: suave ? 'smooth' : 'auto', block: 'nearest' });
    }
  }

  /* --------------------------- 10. Parser CSV propio --------------------------- */

  // Máquina de estados: comillas, "" escapadas, comas y saltos dentro de comillas, CRLF/CR/LF.
  function parseCSV(texto) {
    var filas = [], fila = [], campo = '', enComillas = false;
    var s = String(texto == null ? '' : texto);

    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);

      if (enComillas) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { campo += '"'; i++; }   // comilla escapada
          else enComillas = false;
        } else {
          campo += c;
        }
        continue;
      }

      if (c === '"') { enComillas = true; continue; }
      if (c === ',') { fila.push(campo); campo = ''; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && s.charAt(i + 1) === '\n') i++;        // CRLF cuenta como un salto
        fila.push(campo); campo = '';
        filas.push(fila); fila = [];
        continue;
      }
      campo += c;
    }

    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }

    // Descarta filas completamente vacías (la última línea del archivo, por ejemplo).
    return filas.filter(function (f) {
      return f.some(function (v) { return String(v).trim() !== ''; });
    });
  }

  // Mapea POR NOMBRE de encabezado, nunca por posición.
  function aObjetos(matriz) {
    if (!matriz.length) return [];
    var encabezados = matriz[0].map(claveCol);
    return matriz.slice(1).map(function (f) {
      var o = {};
      encabezados.forEach(function (h, i) {
        if (h) o[h] = f[i] == null ? '' : String(f[i]).trim();
      });
      return o;
    });
  }

  // La hoja real no usa exactamente los nombres del enunciado: se aceptan sinónimos.
  var ALIAS = {
    franja:         ['franja', 'franja_horaria'],
    fecha:          ['fecha', 'dia', 'fecha_cita'],
    hora:           ['hora', 'hora_cita'],
    cupo:           ['cupo', 'cupos', 'capacidad', 'cupo_total'],
    ocupados:       ['ocupados', 'ocupado', 'reservados', 'tomados'],
    id_cita:        ['id_cita', 'idcita', 'id', 'codigo'],
    solicitado_en:  ['solicitado_en', 'fecha_solicitud', 'solicitud', 'fecha_hora_solicitud', 'creado_en'],
    propietario:    ['propietario', 'dueno', 'cliente', 'nombre_propietario'],
    correo:         ['correo', 'email', 'correo_electronico'],
    mascota:        ['mascota', 'nombre_mascota', 'paciente'],
    especie:        ['especie', 'tipo', 'especie_mascota'],
    servicio:       ['servicio', 'tipo_servicio'],
    estado:         ['estado', 'resultado', 'estado_cita'],
    libres_despues: ['libres_despues', 'libres', 'cupos_libres'],
    canal:          ['canal', 'origen']
  };

  function pick(fila, campo) {
    var nombres = ALIAS[campo] || [campo];
    for (var i = 0; i < nombres.length; i++) {
      var v = fila[nombres[i]];
      if (v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /* --------------------------- 11. Lectura de la Google Sheet --------------------------- */

  function sheetSinConfigurar(id) {
    return !id || /^PEGAR/i.test(String(id)) || String(id).length < 20;
  }

  function urlHoja(nombre) {
    return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(CFG.SHEET_ID) +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(nombre) + '&t=' + Date.now();
  }

  function cargarHoja(nombre) {
    return fetch(urlHoja(nombre), { method: 'GET', cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (texto) {
          if (!res.ok || /^\s*</.test(texto)) {
            var err = new Error('No se pudo leer la pestaña "' + nombre + '" (HTTP ' + res.status + ')');
            err.codigo = /invalid|unknown|not found|no existe/i.test(texto) ? 'pestana' : 'privada';
            err.pestana = nombre;
            throw err;
          }
          return aObjetos(parseCSV(texto));
        });
      });
  }

  /* --------------------------- 12. Vista 2 · Agenda del día --------------------------- */

  function mostrarAviso(titulo, cuerpoHTML) {
    var av = $('#agenda-aviso');
    if (!av) return;
    av.innerHTML = '<h3>' + esc(titulo) + '</h3>' + cuerpoHTML;
    av.hidden = false;
    var cont = $('#agenda-contenido');
    if (cont) cont.hidden = true;
  }

  function ocultarAviso() {
    var av = $('#agenda-aviso');
    if (av) { av.hidden = true; av.innerHTML = ''; }
    var cont = $('#agenda-contenido');
    if (cont) cont.hidden = false;
  }

  function avisoConfig() {
    mostrarAviso('Falta configurar el ID de la hoja',
      '<p>Abre <code>js/config.js</code> y pon en <code>SHEET_ID</code> el identificador de tu Google Sheet. ' +
      'Es la parte larga de la URL de la hoja, entre <code>/d/</code> y <code>/edit</code>.</p>');
  }

  function avisoHoja(error) {
    var pestana = (error && error.pestana) || '';

    // Abierta con file://, el navegador manda origen "null" y Google rechaza la lectura.
    // No es culpa de los permisos de la hoja, así que conviene decir la causa real.
    if (location.protocol === 'file:') {
      mostrarAviso('Esta vista necesita un servidor web',
        '<p>Abriste la página haciendo doble clic en el archivo. En ese modo el navegador envía el origen ' +
        '<code>null</code> y Google bloquea la lectura de la hoja, por más que esté compartida. ' +
        'El formulario de <strong>Agendar cita</strong> sí funciona así; solo esta vista necesita ' +
        '<code>http://</code> o <code>https://</code>.</p>' +
        '<p>Tienes dos salidas:</p>' +
        '<ol>' +
          '<li>Publica el sitio en Netlify y ábrelo desde su URL.</li>' +
          '<li>O levanta un servidor local en la carpeta del proyecto con ' +
              '<code>python -m http.server 8080</code> y entra a <code>http://localhost:8080</code>.</li>' +
        '</ol>');
      return;
    }

    if (error && error.codigo === 'pestana') {
      mostrarAviso('No se encontró la pestaña "' + pestana + '"',
        '<p>La hoja respondió, pero no tiene una pestaña con ese nombre. Revisa que los valores de ' +
        '<code>SHEET_AGENDA</code> y <code>SHEET_CITAS</code> en <code>js/config.js</code> coincidan exactamente ' +
        'con los nombres de las pestañas, incluidas mayúsculas y tildes.</p>');
      return;
    }
    mostrarAviso('No se pudo leer la hoja de cálculo',
      '<p>Google no entregó los datos de la pestaña <code>' + esc(pestana) + '</code>. ' +
      'Casi siempre es porque la hoja no está compartida públicamente. Para arreglarlo:</p>' +
      '<ol>' +
        '<li>Abre la hoja en Google Sheets.</li>' +
        '<li>Entra en <strong>Compartir</strong> y luego en <strong>Acceso general</strong>.</li>' +
        '<li>Elige <strong>Cualquier persona con el enlace</strong> con el rol <strong>Lector</strong>.</li>' +
        '<li>Vuelve aquí y pulsa <strong>Actualizar</strong>.</li>' +
      '</ol>');
  }

  function vaciarAgenda() {
    var kpis = $('#kpis'); if (kpis) kpis.innerHTML = '';
    var fr = $('#franjas'); if (fr) fr.innerHTML = '';
    var cuerpo = $('#cuerpo-citas'); if (cuerpo) cuerpo.innerHTML = '';
  }

  function iconoEspecie(especie) {
    var e = norm(especie);
    if (e === 'PERRO') return '\u{1F436}';
    if (e === 'GATO') return '\u{1F431}';
    return '\u{1F43E}';
  }

  function refrescarAgenda() {
    var btn = $('#btn-actualizar');
    var fecha = fechaISO(valor('#agenda-fecha'));

    if (sheetSinConfigurar(CFG.SHEET_ID)) { avisoConfig(); vaciarAgenda(); return; }

    ocultarAviso();
    cargando(btn, true, 'Actualizando…');

    Promise.all([cargarHoja(CFG.SHEET_AGENDA), cargarHoja(CFG.SHEET_CITAS)])
      .then(function (hojas) {
        pintarAgenda(hojas[0], hojas[1], fecha);
        agendaSucia = false;
      })
      .catch(function (error) {
        avisoHoja(error);
        vaciarAgenda();
      })
      .then(function () { cargando(btn, false); });
  }

  function pintarAgenda(filasAgenda, filasCitas, fecha) {
    // Normaliza todo a AAAA-MM-DD y HH:MM ANTES de filtrar.
    var franjas = filasAgenda.map(function (f) {
      var franja = pick(f, 'franja');
      return {
        franja: franja,
        fecha: fechaISO(pick(f, 'fecha')) || fechaISO(franja.slice(0, 10)),
        hora: horaHHMM(pick(f, 'hora')) || horaHHMM(franja.slice(10)),
        cupo: num(pick(f, 'cupo')),
        ocupados: num(pick(f, 'ocupados'))
      };
    }).filter(function (f) { return f.fecha === fecha; })
      .sort(function (a, b) { return a.hora.localeCompare(b.hora); });

    var citas = filasCitas.map(function (f) {
      var franja = pick(f, 'franja');
      return {
        fecha: fechaISO(pick(f, 'fecha')) || fechaISO(franja.slice(0, 10)),
        hora: horaHHMM(pick(f, 'hora')) || horaHHMM(franja.slice(10)),
        mascota: pick(f, 'mascota'),
        especie: pick(f, 'especie'),
        propietario: pick(f, 'propietario'),
        servicio: pick(f, 'servicio'),
        estado: normalizarEstado(pick(f, 'estado')),
        solicitado: pick(f, 'solicitado_en')
      };
    }).filter(function (c) { return c.fecha === fecha; })
      .sort(function (a, b) { return a.hora.localeCompare(b.hora); });

    pintarKpis(franjas, citas);
    pintarFranjas(franjas);
    pintarCitas(citas);
  }

  function pintarKpis(franjas, citas) {
    var cont = $('#kpis');
    if (!cont) return;

    var confirmadas = citas.filter(function (c) { return c.estado === 'CONFIRMADA'; }).length;
    var conAlerta = citas.filter(function (c) { return c.estado === 'CONFIRMADA_ALERTA'; }).length;
    var llenas = franjas.filter(function (f) { return f.cupo - f.ocupados <= 0; }).length;

    var sumaCupo = franjas.reduce(function (a, f) { return a + f.cupo; }, 0);
    var sumaOcup = franjas.reduce(function (a, f) { return a + f.ocupados; }, 0);
    var pct = sumaCupo > 0 ? Math.round((sumaOcup / sumaCupo) * 100) : 0;

    var tarjetas = [
      [citas.length, 'Citas del día'],
      [confirmadas, 'Confirmadas'],
      [conAlerta, 'Con alerta'],
      [llenas, franjas.length ? 'Franjas llenas de ' + franjas.length : 'Franjas llenas'],
      [pct + '%', 'Ocupación del día']
    ];

    cont.innerHTML = tarjetas.map(function (t) {
      return '<li class="kpi"><p class="kpi-valor">' + esc(t[0]) + '</p><p class="kpi-rotulo">' + esc(t[1]) + '</p></li>';
    }).join('');
  }

  function pintarFranjas(franjas) {
    var cont = $('#franjas');
    var vacio = $('#franjas-vacio');
    if (!cont) return;

    if (vacio) vacio.hidden = franjas.length > 0;

    cont.innerHTML = franjas.map(function (f) {
      var libres = Math.max(0, f.cupo - f.ocupados);
      var clase = libres >= 2 ? 'libre' : (libres === 1 ? 'apretada' : 'llena');
      var pastilla = libres >= 2 ? 'Disponible' : (libres === 1 ? 'Último cupo' : 'Llena');
      var pct = f.cupo > 0 ? Math.min(100, Math.round((f.ocupados / f.cupo) * 100)) : 0;
      var etiqueta = f.ocupados + ' de ' + f.cupo + ' cupos ocupados';
      return '<article class="franja ' + clase + '">' +
        '<div class="franja-cabeza">' +
          '<span class="franja-hora">' + esc(f.hora) + '</span>' +
          '<span class="franja-pastilla">' + esc(pastilla) + '</span>' +
        '</div>' +
        '<div class="barra" role="img" aria-label="' + esc(etiqueta) + '">' +
          '<span class="barra-relleno" style="--pct:' + pct + '%"></span>' +
        '</div>' +
        '<p class="franja-pie">' + esc(f.ocupados + ' / ' + f.cupo + ' ocupados · ' + libres + ' libre' + (libres === 1 ? '' : 's')) + '</p>' +
        '</article>';
    }).join('');
  }

  function pintarCitas(citas) {
    var cuerpo = $('#cuerpo-citas');
    var vacio = $('#citas-vacio');
    if (!cuerpo) return;

    if (vacio) vacio.hidden = citas.length > 0;

    cuerpo.innerHTML = citas.map(function (c) {
      var info = infoEstado(c.estado);
      return '<tr>' +
        '<td data-etiqueta="Hora" class="tabla-hora">' + esc(c.hora || '—') + '</td>' +
        '<td data-etiqueta="Mascota"><span class="tabla-mascota">' +
          '<span aria-hidden="true">' + iconoEspecie(c.especie) + '</span>' + esc(c.mascota || '—') +
        '</span></td>' +
        '<td data-etiqueta="Propietario">' + esc(c.propietario || '—') + '</td>' +
        '<td data-etiqueta="Servicio">' + esc(c.servicio || '—') + '</td>' +
        '<td data-etiqueta="Estado"><span class="badge ' + info.clase + '">' + esc(c.estado || 'Sin estado') + '</span></td>' +
        '<td data-etiqueta="Solicitada" class="tabla-solicitada">' + esc(c.solicitado || '—') + '</td>' +
        '</tr>';
    }).join('');
  }

  /* --------------------------- 13. Navegación por hash --------------------------- */

  function rutaActual() {
    var h = String(location.hash || '').replace('#', '');
    return h === 'agenda' ? 'agenda' : 'agendar';
  }

  function aplicarRuta() {
    var ruta = rutaActual();
    // El hero solo acompaña a la vista de agendar; la agenda tiene su propio encabezado.
    var hero = $('#hero');
    if (hero) hero.hidden = (ruta !== 'agendar');
    ['agendar', 'agenda'].forEach(function (nombre) {
      var panel = document.getElementById('panel-' + nombre);
      var tab = document.getElementById('tab-' + nombre);
      var activo = (nombre === ruta);
      if (panel) panel.hidden = !activo;
      if (tab) tab.setAttribute('aria-selected', activo ? 'true' : 'false');
    });
    if (ruta === 'agenda' && agendaSucia) refrescarAgenda();
  }

  /* --------------------------- 14. Arranque --------------------------- */

  function llenarHoras() {
    var sel = $('#hora');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecciona una hora</option>' +
      (CFG.HORAS || []).map(function (h) {
        return '<option value="' + esc(h) + '">' + esc(h) + '</option>';
      }).join('');
  }

  function actualizarFranjaPrevia() {
    var destino = $('#franja-previa');
    if (!destino) return;
    var f = fechaISO(valor('#fecha'));
    var h = horaHHMM(valor('#hora'));
    destino.textContent = (f && h) ? (f + ' ' + h) : '—';
  }

  function init() {
    var form = $('#form-cita');

    llenarHoras();
    renderCasos();
    renderTraza();

    // Al corregir un campo, su error desaparece.
    function alEditar(ev) {
      var destino = ev.target;
      if (!destino) return;
      var id = destino.id;
      var nombre = destino.name;
      var cajaError = (id && $('#err-' + id)) || (nombre && $('#err-' + nombre));
      if (cajaError) {
        cajaError.textContent = '';
        if (destino.removeAttribute) destino.removeAttribute('aria-invalid');
      }
      if (id === 'correo') correoRecordado = String(destino.value || '').trim();
      actualizarFranjaPrevia();
    }

    if (form) {
      form.addEventListener('submit', enviar);
      form.addEventListener('input', alEditar);
      form.addEventListener('change', alEditar);
    }

    var correoCasos = $('#correo-casos');
    if (correoCasos) {
      correoCasos.addEventListener('input', function () {
        correoRecordado = String(correoCasos.value || '').trim();
      });
    }

    var casos = $('#casos');
    if (casos) {
      casos.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-caso]') : null;
        if (!btn) return;
        var caso = CASOS.filter(function (c) { return c.id === btn.dataset.caso; })[0];
        if (caso) llenarCaso(caso);
      });
    }

    var limpiar = $('#btn-limpiar-traza');
    if (limpiar) {
      limpiar.addEventListener('click', function () { traza = []; renderTraza(); });
    }

    var actualizar = $('#btn-actualizar');
    if (actualizar) actualizar.addEventListener('click', refrescarAgenda);

    var agendaFecha = $('#agenda-fecha');
    if (agendaFecha) agendaFecha.addEventListener('change', refrescarAgenda);

    window.addEventListener('hashchange', aplicarRuta);
    aplicarRuta();
    actualizarFranjaPrevia();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();

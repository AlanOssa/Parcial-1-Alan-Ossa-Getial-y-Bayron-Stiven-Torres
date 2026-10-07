/* Configuración editable del sistema de Huellas del Valle.
   Este archivo NO debe contener tokens, claves ni contraseñas:
   se publica tal cual y cualquiera puede leerlo desde el navegador. */
window.APP_CONFIG = {
  // Webhook del escenario 1 en Make (recibe la solicitud y responde el resultado).
  WEBHOOK_URL: "https://hook.eu1.make.com/2481338nq3o3yy5k4k3vv22avnoshhnz",

  // ID de la Google Sheet que usa el escenario (archivo "BD_VETERINARIA").
  // Es la parte larga de la URL: /spreadsheets/d/<ESTO>/edit
  SHEET_ID: "16AQVpl9gTBV9OI9hEKf6hmz9Kp_SMZQdtKrhjOGqfkE",

  // Nombres de las pestañas dentro de esa hoja.
  SHEET_AGENDA: "agenda",
  SHEET_CITAS: "citas",

  // Horas que ofrece el formulario (texto HH:MM con cero a la izquierda).
  HORAS: ["08:00", "09:00", "10:00", "11:00"],

  // Tiempo máximo de espera del webhook, en milisegundos.
  TIMEOUT_MS: 30000
};

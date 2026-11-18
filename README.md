# EriJuli — finanzas personales

Página web responsive (mobile-first) para gestionar tu dinero: ingresos por procedencia,
dinero organizado por banco, cuenta y bolsillos, presupuesto mensual o quincenal, gastos fijos,
metas de ahorro, préstamos (me deben / debo), reportes e importación desde Excel/CSV.
Incluye una bandeja de revisión preparada para leer movimientos desde Gmail.

## ✨ Funciones

| Área | Qué incluye |
|------|-------------|
| **Inicio** | Saldo total, resumen del periodo, alertas, metas y últimos movimientos |
| **Movimientos** | Gastos, ingresos y transferencias con filtros por tipo, cuenta, categoría y fechas |
| **Ingresos** | Fuentes de ingreso (ej. "Pago James"), valor esperado vs. recibido y dinero extra |
| **Gastos fijos** | Recurrentes, se generan solos cada periodo como pendientes y se marcan pagados |
| **Presupuesto** | Mensual o quincenal, sugerencia automática, arrastre (rollover) y cierre de periodo |
| **Bancos y bolsillos** | Bancos → "Cuenta" + bolsillos con propósito; mover dinero deja registro |
| **Metas** | Monto, fecha, bolsillo asociado y aporte sugerido por periodo |
| **Préstamos** | Me deben / Debo con personas, abonos y saldo pendiente |
| **Reportes** | Por categoría, por fuente, de dónde salió el dinero y comparación entre periodos |
| **Importar / exportar** | CSV en ambos sentidos + plantilla descargable |
| **Historial** | Auditoría de cambios (quién, cuándo, origen: manual, importación o correo) |
| **Bandeja (Gmail)** | Movimientos propuestos que se aceptan, editan o descartan antes de afectar saldos |
| **Tarjetas de crédito** | Cupo, día de corte y de pago, compras con tarjeta (cuentan en el presupuesto sin sacar plata de los bolsillos), cuánto pagar y antes de qué fecha, pagos desde una cuenta |
| **Topes por categoría** | Máximo por periodo para cada categoría, barra de avance y aviso al 80 % y al 100 % |
| **Gastos divididos** | Un gasto repartido en varias categorías (las partes deben sumar el total) |
| **Cuánto queda por día** | Lo libre del periodo (ya sin fijos por pagar) dividido entre los días que faltan, y lo que falta por recibir |
| **Evolución** | Patrimonio (bancos − tarjetas) mes a mes e ingresos vs. gastos en Reportes |
| **Hogar compartido** | Hogar con código de invitación, gastos en común, quién le debe a quién, saldar cuentas y presupuesto del hogar |
| **Recibos** | Foto del recibo en cada movimiento (se reduce en el celular antes de subirla) |
| **Escanear recibos** | Foto o captura de una factura o comprobante (Nequi, Bancolombia, Daviplata…): lee el texto en el propio servidor (OCR en español, sin enviar la imagen a terceros) y llena valor, fecha, descripción, tipo, cuenta, categoría y referencia para que solo revises y guardes |
| **Seguridad** | Recuperar contraseña por correo o con códigos de recuperación, cambio de contraseña, bloqueo con PIN y huella / Face ID |
| **Notificaciones** | Avisos en el celular de fijos por vencer, pagos de tarjeta, topes y saldo bajo |

### Configuración de las funciones nuevas

- **Correo para recuperar la contraseña:** pon `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM` en `.env` (con Gmail, una contraseña de aplicación). Sin SMTP el enlace se escribe en la consola del servidor; los códigos de recuperación funcionan siempre.
- **`APP_URL`:** la dirección pública (ej. `https://erijuli.up.railway.app`). La usan los enlaces de correo y la huella / Face ID.
- **Huella / Face ID y notificaciones** necesitan HTTPS (Railway ya lo da) o `localhost`. En iPhone las notificaciones funcionan con la app instalada en la pantalla de inicio (iOS 16.4 o superior).
- **Fotos de recibos:** se guardan en `uploads/` junto a la base de datos (en Railway, dentro del Volume en `/data`). El respaldo `.db` no incluye las fotos.
- **Prueba automática:** `npm run test:funcional` levanta la app con una base temporal y revisa todas las funciones.

## 🚀 Publicar: GitHub + Railway

### 1. Subir el código a GitHub

En la carpeta del proyecto (PowerShell o la terminal de VS Code):

```bash
git init -b main
git add .
git commit -m "EriJuli v1.0.0"
git remote add origin https://github.com/TU-USUARIO/erijuli.git   # crea antes el repo vacío en github.com/new (privado)
git push -u origin main
```

El `.gitignore` deja fuera `node_modules/`, `.env`, la base de datos (`data/`), las fotos de recibos y `_diseno_anterior/`: tus datos personales nunca suben al repositorio.

### 2. Crear el servicio en Railway

1. En [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → elige `erijuli`. Railway detecta Node 24 por `package.json` y usa `railway.json` (arranque con `npm start` y revisión de salud en `/salud`).
2. **Volume (obligatorio para no perder datos):** en el servicio → clic derecho / **Attach Volume** → ruta de montaje **`/data`**. La app guarda ahí la base, los respaldos y las fotos de recibos sin configurar nada más.
3. **Variables** del servicio:

   | Variable | Valor |
   |----------|-------|
   | `SESSION_SECRET` | clave aleatoria de 32+ caracteres (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) |
   | `NODE_ENV` | `production` |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | opcional: correos de "recuperar contraseña" |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | opcional: lectura de Gmail |

   Sin `SESSION_SECRET` la app no arranca a propósito (para no correr con una clave conocida).
4. **Dominio:** Settings → Networking → **Generate Domain** (queda `https://<algo>.up.railway.app`, con HTTPS). La app lo detecta sola; si usas un dominio propio, agrega `APP_URL=https://tudominio`.
5. Deja **1 réplica**: la base es SQLite en el Volume y no se comparte entre réplicas.

Cada `git push` a `main` vuelve a desplegar. Para revisar: `https://<tu-dominio>/salud` debe responder `{"ok":true}`.

> **Pasar tus datos actuales a Railway:** en tu app local ve a *Importar / exportar → Respaldo completo* y guarda el `.db`. Para restaurarlo en Railway puedes usar la CLI (`railway ssh`) y copiarlo a `/data/app.db` con el servicio detenido, o empezar de cero e importar tus movimientos por CSV.

### En local

```bash
npm install
npm run dev        # http://localhost:3000, usa ./data/app.db
npm test           # prueba funcional con una base temporal
```

## 🛠 Stack

- **Node.js 24+** con `node:sqlite` (base de datos SQLite incluida en Node, sin dependencias nativas)
- **Express + EJS** — renderizado en servidor, sin frameworks pesados
- **express-session** con almacenamiento en SQLite (las sesiones sobreviven reinicios)
- Contraseñas con hash **bcryptjs**, protección CSRF y cookies seguras

## 📧 Conexión con Gmail

La bandeja de revisión ya funciona con propuestas manuales y CSV. Para leer correos de banco:

1. Crea un proyecto en Google Cloud Console y habilita la **API de Gmail**.
2. Configura la pantalla de consentimiento y credenciales **OAuth** (tipo Web).
3. Define `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en las variables de entorno.
4. Agrega como redirect URI: `https://TU-APP.up.railway.app/gmail/callback`
5. En la app: **Bandeja → Conectar Gmail** y autoriza los remitentes de tu banco
   (ej. `alertas@bancolombia.com`). Luego pulsa **Sincronizar**.

Lo que hace la app con tu correo (privacidad primero):

- Permiso de **solo lectura** (`gmail.readonly`), revocable en cualquier momento desde la app.
- Solo lee correos de los **remitentes que tú autorices**.
- Pide los mensajes en modo *metadata*: guarda únicamente valor, fecha, comercio y enlace
  al correo; **nunca el cuerpo del correo ni números completos de cuenta**.
- Los movimientos quedan como **propuestos**: tú los aceptas, editas o descartas.
- Aprende tus decisiones ("este comercio → esta categoría y cuenta") y evita duplicados.

> Nota: si la app está abierta al público, Google exige verificación para el permiso
> restringido de Gmail; con usuarios limitados (modo prueba) no es necesario.

## 📱 Instalable en el celular (PWA)

La app se puede "instalar" como aplicación desde el navegador:
en Android: menú del navegador → *Instalar aplicación*; en iPhone: *Compartir* →
*Agregar a pantalla de inicio*. Funciona con interfaz de app nativa y acceso rápido.

## 💾 Respaldos

- **Automáticos**: cada día se genera un respaldo completo de la base de datos y se
  conservan los últimos 7.
- **Manuales**: *Importar / exportar → Respaldo completo de la cuenta* descarga un `.db`.

## 📁 Estructura

```
server.js              → servidor Express
src/
  schema.sql           → base de datos
  db.js                → conexión SQLite + sesiones
  middleware.js        → auth, CSRF, mensajes flash
  routes/              → autenticación, bancos, movimientos, ingresos, gastos fijos,
                         presupuesto, metas, préstamos, reportes, configuración,
                         importar/exportar, historial, bandeja
  services/            → periodos, saldos, alertas, auditoría, gmail
views/                 → plantillas EJS
public/                → CSS responsive + JS
```

## 🧮 Decisiones de diseño

- **El dinero se guarda en centavos** (enteros) para evitar errores de redondeo.
- **Los saldos se calculan** con base en movimientos + saldo inicial (nunca se digitan a mano):
  los gastos descuentan de su cuenta/bolsillo de origen y las transferencias mueven sin
  contarse como ingreso ni gasto.
- **Gastos extra** (pagados desde bolsillos) aparecen en "Gastos totales" pero no consumen el
  presupuesto; los fijos pueden consumirlo o no según Configuración.
- **Quincenas configurables** (días de inicio) y gastos fijos asignados al periodo de su fecha de pago.

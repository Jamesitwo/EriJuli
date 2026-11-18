'use strict';
/**
 * Migraciones de EriJuli. Se ejecutan al arrancar y son idempotentes:
 * crean las tablas nuevas y agregan columnas que falten sin tocar los datos existentes.
 */
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(db, table, name, ddl) {
  if (!columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function migrate(db) {
  // --- Usuarios: modo de color, PIN, bloqueo y notificaciones
  addColumn(db, 'users', 'theme', "TEXT NOT NULL DEFAULT 'auto'");
  addColumn(db, 'users', 'pin_hash', 'TEXT');
  addColumn(db, 'users', 'lock_minutes', 'INTEGER NOT NULL DEFAULT 5');
  addColumn(db, 'users', 'notify_push', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'users', 'motion', "TEXT NOT NULL DEFAULT 'auto'"); // animaciones: auto | si | no

  // --- Recuperar contraseña
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // --- Tarjetas de crédito
  db.exec(`CREATE TABLE IF NOT EXISTS credit_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bank_id INTEGER REFERENCES banks(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    last4 TEXT NOT NULL DEFAULT '',
    credit_limit INTEGER NOT NULL DEFAULT 0,      -- centavos
    initial_debt INTEGER NOT NULL DEFAULT 0,      -- deuda al registrarla (centavos)
    cut_day INTEGER NOT NULL DEFAULT 30,          -- día de corte
    due_day INTEGER NOT NULL DEFAULT 15,          -- día límite de pago
    color TEXT NOT NULL DEFAULT '#14231c',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // card_id en un gasto = compra con tarjeta; en una transferencia = pago de la tarjeta
  addColumn(db, 'transactions', 'card_id', 'INTEGER REFERENCES credit_cards(id) ON DELETE SET NULL');
  addColumn(db, 'proposed_movements', 'card_id', 'INTEGER');

  // --- Topes por categoría y gastos divididos
  db.exec(`CREATE TABLE IF NOT EXISTS category_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 0,             -- tope por periodo, en centavos
    UNIQUE (user_id, category_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS transaction_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits (transaction_id)');
  // Una línea por categoría: los gastos divididos aportan cada parte; los demás, su categoría
  db.exec('DROP VIEW IF EXISTS category_lines');
  db.exec(`CREATE VIEW category_lines AS
    SELECT t.id AS transaction_id, t.user_id, t.period_id, t.kind, t.expense_type, t.date,
           s.category_id AS category_id, s.amount AS amount
    FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id
    UNION ALL
    SELECT t.id, t.user_id, t.period_id, t.kind, t.expense_type, t.date, t.category_id, t.amount
    FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)`);

  // --- Hogar compartido
  db.exec(`CREATE TABLE IF NOT EXISTS households (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    monthly_budget INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS household_members (
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'miembro',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (household_id, user_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS household_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    paid_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    split TEXT NOT NULL DEFAULT 'igual',           -- igual | completo (los demás deben todo)
    transaction_id INTEGER,                         -- gasto propio de quien pagó, si lo registró
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS household_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // --- Notificaciones en el celular
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS notifications_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // --- Fotos de recibos
  db.exec(`CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // --- Huella / Face ID (WebAuthn)
  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cred_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

module.exports = { migrate };

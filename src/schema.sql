-- Esquema de la base de datos (SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'COP',
  timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  period_type TEXT NOT NULL DEFAULT 'mensual',          -- mensual | quincenal
  quincena_dia1 INTEGER NOT NULL DEFAULT 1,
  quincena_dia2 INTEGER NOT NULL DEFAULT 16,
  budget_includes_fixed INTEGER NOT NULL DEFAULT 1,     -- 1: los fijos salen del presupuesto
  rollover_enabled INTEGER NOT NULL DEFAULT 1,          -- arrastre de saldo no gastado
  alert_days_fixed INTEGER NOT NULL DEFAULT 5,
  alert_low_balance INTEGER NOT NULL DEFAULT 50000,
  theme TEXT NOT NULL DEFAULT 'auto',                   -- auto | claro | oscuro
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id INTEGER NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cuenta','bolsillo')),   -- cuenta = dinero sin propósito
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  initial_balance INTEGER NOT NULL DEFAULT 0,                 -- saldo inicial en centavos
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gasto','ingreso')),
  color TEXT NOT NULL DEFAULT '#64748b',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS income_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  expected_amount INTEGER NOT NULL DEFAULT 0,                 -- valor esperado por periodo
  frequency TEXT NOT NULL DEFAULT 'mensual',                  -- mensual | quincenal | semanal | irregular
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'abierto',                     -- abierto | cerrado
  budget_amount INTEGER NOT NULL DEFAULT 0,
  rollover_amount INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, start_date)
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  due_day INTEGER NOT NULL DEFAULT 1,
  frequency TEXT NOT NULL DEFAULT 'mensual',                  -- mensual | quincenal
  payment_method TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fixed_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fixed_expense_id INTEGER NOT NULL REFERENCES fixed_expenses(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendiente',                   -- pendiente | pagado
  paid_date TEXT,
  transaction_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fixed_expense_id, period_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ingreso','gasto','transferencia')),
  amount INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  income_source_id INTEGER REFERENCES income_sources(id) ON DELETE SET NULL,
  container_from_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  container_to_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  expense_type TEXT NOT NULL DEFAULT 'variable',              -- fijo | variable | extra
  fixed_instance_id INTEGER REFERENCES fixed_instances(id) ON DELETE SET NULL,
  loan_id INTEGER,
  period_id INTEGER REFERENCES periods(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'manual',                      -- manual | import | email
  email_link TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_amount INTEGER NOT NULL DEFAULT 0,
  target_date TEXT,
  container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  contribution_per_period INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('me_deben','debo')),
  person TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  due_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'abierto',                     -- abierto | saldado
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  transaction_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposed_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'propuesto',                   -- propuesto | sin_procesar | aceptado | descartado
  kind TEXT NOT NULL DEFAULT 'gasto',                         -- ingreso | gasto | transferencia
  amount INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  income_source_id INTEGER REFERENCES income_sources(id) ON DELETE SET NULL,
  container_from_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  container_to_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  email_sender TEXT NOT NULL DEFAULT '',
  email_subject TEXT NOT NULL DEFAULT '',
  email_date TEXT,
  email_link TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  transaction_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_pattern TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gasto',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  income_source_id INTEGER REFERENCES income_sources(id) ON DELETE SET NULL,
  container_from_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  container_to_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gmail_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  token_expiry INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id INTEGER REFERENCES banks(id) ON DELETE SET NULL,
  sender TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS processed_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  proposed_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_period ON transactions (period_id);
CREATE INDEX IF NOT EXISTS idx_containers_bank ON containers (bank_id);
CREATE INDEX IF NOT EXISTS idx_fixed_instances_period ON fixed_instances (period_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at);

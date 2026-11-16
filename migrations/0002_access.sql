-- Who can sign up (spekkr input `access`): owner/member roles, removed access, invites.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';   -- 'owner' | 'member' | 'demo'
ALTER TABLE users ADD COLUMN disabled_at TEXT;                      -- set when the owner removes access
-- Existing databases: the demo account is not a person; the earliest other account becomes the owner.
UPDATE users SET role = 'demo' WHERE email = 'sam@example.com';
UPDATE users SET role = 'owner' WHERE id = (SELECT MIN(id) FROM users WHERE role = 'member');
CREATE UNIQUE INDEX users_one_owner ON users(role) WHERE role = 'owner';
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,                   -- lower-case
  token_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hex of the link token
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX invites_email ON invites(email);

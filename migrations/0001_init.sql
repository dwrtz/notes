-- Linked notes: accounts, vaults, files and the link/tag/search index.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- stored lower-case
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256 hex of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE vaults (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,        -- bumped by every change; the sync cursor
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON, see design.md "Vault settings"
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                    -- "Folder/Note.md"; folders have no extension
  path_lc TEXT NOT NULL,
  key TEXT NOT NULL,                     -- lower-case last segment without ".md"
  kind TEXT NOT NULL CHECK (kind IN ('note','folder','attachment')),
  content TEXT,                          -- notes only
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,                             -- attachments only
  r2_key TEXT,                           -- attachments only
  version INTEGER NOT NULL DEFAULT 1,
  rev TEXT NOT NULL,                     -- random token of the last write (guards index writes)
  seq INTEGER NOT NULL,
  ctime TEXT NOT NULL,
  mtime TEXT NOT NULL,
  deleted_at TEXT                        -- set while in the trash
);
CREATE UNIQUE INDEX files_live_path ON files (vault_id, path_lc) WHERE deleted_at IS NULL;
CREATE INDEX files_key ON files (vault_id, key);
CREATE INDEX files_seq ON files (vault_id, seq);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  vault_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- link | embed
  format TEXT NOT NULL,                  -- wiki | md
  linkpath TEXT NOT NULL,
  subpath TEXT NOT NULL,
  display TEXT,
  line INTEGER NOT NULL,
  prop TEXT,                             -- property name when the link is in frontmatter
  target_key TEXT NOT NULL,
  target_id INTEGER                      -- NULL while unresolved
);
CREATE INDEX links_source ON links (source_id);
CREATE INDEX links_target ON links (vault_id, target_id);
CREATE INDEX links_key ON links (vault_id, target_key);

CREATE TABLE tags (vault_id INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, tag TEXT NOT NULL, tag_lc TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX tags_file ON tags (file_id);
CREATE INDEX tags_vault ON tags (vault_id, tag_lc);
CREATE TABLE headings (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, vault_id INTEGER NOT NULL, level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX headings_file ON headings (file_id);
CREATE TABLE blocks (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, block_id TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX blocks_file ON blocks (file_id);
CREATE TABLE aliases (vault_id INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, alias TEXT NOT NULL, alias_lc TEXT NOT NULL);
CREATE INDEX aliases_file ON aliases (file_id);
CREATE INDEX aliases_vault ON aliases (vault_id, alias_lc);
CREATE TABLE props (vault_id INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, key TEXT NOT NULL, key_lc TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX props_file ON props (file_id);
CREATE INDEX props_vault ON props (vault_id, key_lc);
CREATE TABLE prop_types (vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, key_lc TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (vault_id, key_lc));

CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY,
  vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('group','file','folder','search','heading','block','graph')),
  title TEXT,
  path TEXT,
  subpath TEXT,
  query TEXT
);
CREATE INDEX bookmarks_vault ON bookmarks (vault_id);

-- Full-text index of note names and bodies. rowid = files.id. Trigram tokens give substring matches.
CREATE VIRTUAL TABLE notes_fts USING fts5 (name, body, vault_id UNINDEXED, tokenize = 'trigram');

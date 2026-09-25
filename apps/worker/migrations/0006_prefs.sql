-- Account preferences the web app keeps in sync across browsers, as a JSON
-- object (see routes/prefs.ts for the known keys).
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';

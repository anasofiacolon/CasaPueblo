-- Sprint 1 schema: Cloudflare D1 (SQLite).
-- * Locations (location_text, latitude, longitude) are nullable everywhere and
--   hidden by default (show_location = 0). Coordinates are both NULL or both
--   valid WGS84 values, never (0, 0).
-- * Every community-submitted field has its own show_* visibility toggle.
-- * source_key / last_synced_excel_hash / current_db_hash track the client's
--   Excel workbook one-way (Excel -> DB). The workbook is never written to.
-- D1 enforces foreign keys by default.

-- 1. Administrators Table (Feature 1)
CREATE TABLE IF NOT EXISTS administrators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, -- Web Crypto PBKDF2-SHA256 (pbkdf2_sha256$100000$<salt>$<hash>)
    full_name TEXT NOT NULL,
    email TEXT UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Submissions Table (Features 2 & 3)
-- Location is OPTIONAL (NULL allowed) and hidden by default (show_location = 0).
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_name TEXT NOT NULL,
    location_text TEXT NULL, -- Nullable: user may choose not to share location
    latitude REAL NULL CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
    longitude REAL NULL CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
    description TEXT NOT NULL,
    energy_initiative_details TEXT NOT NULL,
    submitter_name TEXT NULL,
    submitter_email TEXT NOT NULL,
    submitter_phone TEXT NULL,
    submitter_comments TEXT NULL, -- Always private (admin-only)

    -- Per-field privacy / visibility toggles (1 = public allowed after approval, 0 = private/admin-only)
    show_community_name INTEGER NOT NULL DEFAULT 1 CHECK (show_community_name IN (0, 1)),
    show_location INTEGER NOT NULL DEFAULT 0 CHECK (show_location IN (0, 1)), -- Hidden by default
    show_description INTEGER NOT NULL DEFAULT 1 CHECK (show_description IN (0, 1)),
    show_energy_initiative_details INTEGER NOT NULL DEFAULT 1 CHECK (show_energy_initiative_details IN (0, 1)),
    show_submitter_name INTEGER NOT NULL DEFAULT 0 CHECK (show_submitter_name IN (0, 1)),
    show_submitter_email INTEGER NOT NULL DEFAULT 0 CHECK (show_submitter_email IN (0, 1)), -- Confidential by default
    show_submitter_phone INTEGER NOT NULL DEFAULT 0 CHECK (show_submitter_phone IN (0, 1)),

    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_comment TEXT NULL,
    reviewed_by_admin_id INTEGER NULL,
    reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL AND NOT (latitude = 0 AND longitude = 0))),
    FOREIGN KEY (reviewed_by_admin_id) REFERENCES administrators(id) ON DELETE SET NULL
);

-- 3. Communities Table / Published & Managed Profiles (Features 4, 5, 6 + One-Way Excel Tracking)
-- Location is OPTIONAL (NULL allowed) and hidden by default (show_location = 0, show_on_map = 0).
CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER UNIQUE NULL,
    source_key TEXT UNIQUE NULL,          -- Deterministic key (e.g., 'pr:casa-pueblo') for matching Excel rows without rewriting client Excel
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    region TEXT NULL,                     -- 'Puerto Rico' | 'América Latina' | NULL
    location_text TEXT NULL,              -- Nullable per client requirement
    country TEXT NULL,                    -- Nullable
    latitude REAL NULL CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
    longitude REAL NULL CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
    description TEXT NOT NULL,
    energy_initiative_details TEXT NOT NULL,
    proposals_tags TEXT NULL,             -- Semicolon-separated tags from Excel 'Propuestas'
    junte_energetico INTEGER NULL CHECK (junte_energetico IS NULL OR junte_energetico IN (0, 1)),
    website_url TEXT NULL,
    private_contact_email TEXT NULL,      -- Admin-only unless show_contact_email = 1
    private_comments TEXT NULL,           -- Admin-only notes from Excel or review

    -- Row-level & per-field public visibility toggles
    is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
    show_name INTEGER NOT NULL DEFAULT 1 CHECK (show_name IN (0, 1)),
    show_location INTEGER NOT NULL DEFAULT 0 CHECK (show_location IN (0, 1)), -- Hidden by default
    show_on_map INTEGER NOT NULL DEFAULT 0 CHECK (show_on_map IN (0, 1)),     -- Hidden by default
    show_description INTEGER NOT NULL DEFAULT 1 CHECK (show_description IN (0, 1)),
    show_energy_initiative_details INTEGER NOT NULL DEFAULT 1 CHECK (show_energy_initiative_details IN (0, 1)),
    show_website_url INTEGER NOT NULL DEFAULT 1 CHECK (show_website_url IN (0, 1)),
    show_contact_email INTEGER NOT NULL DEFAULT 0 CHECK (show_contact_email IN (0, 1)),

    -- One-way Excel -> DB change-tracking metadata (stored in our DB so we never rewrite their Excel)
    sync_source TEXT NOT NULL DEFAULT 'web' CHECK (sync_source IN ('web', 'excel', 'seed')),
    source_sheet TEXT NULL,
    last_synced_excel_hash TEXT NULL,     -- SHA-256 of the Excel row the last time we synced from Excel
    current_db_hash TEXT NULL,            -- SHA-256 of the current DB fields (detects Admin Portal edits)
    last_synced_at DATETIME NULL,

    created_by_admin_id INTEGER NULL,
    updated_by_admin_id INTEGER NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL AND NOT (latitude = 0 AND longitude = 0))),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_admin_id) REFERENCES administrators(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by_admin_id) REFERENCES administrators(id) ON DELETE SET NULL
);

-- 4. Allies Table (Synced from Excel 'Otros' tab & displayed on /proyecto.html)
CREATE TABLE IF NOT EXISTS allies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    location_text TEXT NULL,              -- Nullable
    website_url TEXT NULL,
    last_synced_excel_hash TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Project Information & Guiding Principles Table (Feature 7)
CREATE TABLE IF NOT EXISTS project_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL UNIQUE,     -- 'what_is', 'scope', 'vision', 'purpose', 'categories', 'guiding_principles'
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_by_admin_id INTEGER NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by_admin_id) REFERENCES administrators(id) ON DELETE SET NULL
);

-- 6. Audit & Excel Sync Conflict Logs (Features 3, 4 & One-Way Excel Tracking)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('submission', 'community', 'project_info', 'auth', 'excel_sync')),
    entity_id INTEGER NULL,
    action TEXT NOT NULL,                 -- 'status_change', 'create', 'update', 'delete', 'login', 'login_failed', 'excel_import', 'excel_conflict'
    previous_state TEXT NULL,
    new_state TEXT NULL,
    comment TEXT NULL,
    admin_id INTEGER NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES administrators(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_communities_public ON communities(is_visible, deleted_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);

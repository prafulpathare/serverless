-- Requires PostgreSQL 13+ (gen_random_uuid is built in)

create table if not exists clients (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    email       text unique,
    status      text not null default 'active' check (status in ('active', 'suspended')),
    created_at  timestamptz not null default now()
);

-- Only the SHA-256 hash of a key is stored; the plain key is shown once at creation.
create table if not exists api_keys (
    id           uuid primary key default gen_random_uuid(),
    client_id    uuid not null references clients(id) on delete cascade,
    label        text,
    key_prefix   text not null,
    key_hash     text not null unique,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
create index if not exists api_keys_client_idx on api_keys(client_id);

create table if not exists functions (
    id              uuid primary key,
    client_id       uuid not null references clients(id) on delete cascade,
    name            text not null,
    runtime         text not null default 'nodejs',
    current_version int  not null,
    timeout_ms      int  not null default 15000,
    memory_mb       int  not null default 128,
    env_encrypted   text,              -- AES-256-GCM encrypted JSON of env vars
    connections     text[],            -- allowlist of connection names; NULL = all of the client's
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (client_id, name)
);

create table if not exists function_versions (
    function_id uuid not null references functions(id) on delete cascade,
    version     int  not null,
    code        text not null,
    code_sha256 text not null,
    created_at  timestamptz not null default now(),
    primary key (function_id, version)
);

-- A client's own external databases (Postgres / MySQL / MongoDB ...)
create table if not exists connections (
    id               uuid primary key default gen_random_uuid(),
    client_id        uuid not null references clients(id) on delete cascade,
    name             text not null,
    type             text not null check (type in ('postgres', 'mysql', 'mongodb')),
    config_encrypted text not null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (client_id, name)
);

create table if not exists invocations (
    id            uuid primary key,
    client_id     uuid not null references clients(id) on delete cascade,
    function_id   uuid references functions(id) on delete set null,
    function_name text not null,
    version       int,
    status        text not null,       -- success | error | timeout
    duration_ms   int,
    error         text,
    logs          text,
    created_at    timestamptz not null default now()
);
create index if not exists invocations_fn_idx on invocations(function_id, created_at desc);
create index if not exists invocations_client_idx on invocations(client_id, created_at desc);

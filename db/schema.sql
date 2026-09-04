-- PostgreSQL schema for the MVP. Run through a migration tool in deployment;
-- never execute unreviewed schema changes directly against production.
create type campaign_status as enum ('draft', 'generating', 'generated', 'sending', 'completed', 'failed');
create type generation_status as enum ('pending', 'processing', 'generated', 'failed');
create type email_status as enum ('pending', 'sending', 'sent', 'failed');

create table users (
  id uuid primary key,
  email text not null unique,
  password_hash text,
  created_at timestamptz not null default now(),
  constraint users_password_or_oauth check (password_hash is not null or email is not null)
);

create table campaigns (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name varchar(120) not null,
  organization_name varchar(160) not null,
  description varchar(500),
  status campaign_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_owner_updated_idx on campaigns (user_id, updated_at desc);

create table templates (
  id uuid primary key,
  campaign_id uuid not null unique references campaigns(id) on delete cascade,
  storage_key text not null,
  mime_type varchar(20) not null check (mime_type in ('image/png', 'image/jpeg')),
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create table template_fields (
  id uuid primary key,
  template_id uuid not null references templates(id) on delete cascade,
  variable_name varchar(80) not null,
  x numeric(7,4) not null check (x between 0 and 1),
  y numeric(7,4) not null check (y between 0 and 1),
  width numeric(7,4) not null check (width > 0 and width <= 1),
  height numeric(7,4) not null check (height > 0 and height <= 1),
  font_family varchar(100) not null,
  font_size integer not null check (font_size between 6 and 300),
  font_color varchar(7) not null check (font_color ~ '^#[0-9A-Fa-f]{6}$'),
  font_weight varchar(10) not null default 'normal' check (font_weight in ('normal', 'bold')),
  font_style varchar(10) not null default 'normal' check (font_style in ('normal', 'italic')),
  text_align varchar(6) not null default 'center' check (text_align in ('left', 'center', 'right'))
);
create unique index template_fields_variable_idx on template_fields (template_id, variable_name);

create table recipients (
  id uuid primary key,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  email text not null,
  data jsonb not null default '{}',
  is_valid boolean not null default true,
  validation_error text,
  created_at timestamptz not null default now()
);
create unique index recipients_unique_email_idx on recipients (campaign_id, lower(email));
create index recipients_campaign_idx on recipients (campaign_id, created_at desc);

create table certificates (
  id uuid primary key,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  recipient_id uuid not null unique references recipients(id) on delete cascade,
  storage_key text,
  status generation_status not null default 'pending',
  failure_reason text,
  generated_at timestamptz,
  created_at timestamptz not null default now()
);
create index certificates_campaign_status_idx on certificates (campaign_id, status);

create table email_connections (
  id uuid primary key,
  user_id uuid not null unique references users(id) on delete cascade,
  gmail_address text not null,
  encrypted_refresh_token text not null,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table email_jobs (
  id uuid primary key,
  recipient_id uuid not null references recipients(id) on delete cascade,
  certificate_id uuid not null references certificates(id) on delete cascade,
  idempotency_key uuid not null unique,
  status email_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  failure_reason text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_jobs_pending_idx on email_jobs (status, created_at) where status in ('pending', 'failed');

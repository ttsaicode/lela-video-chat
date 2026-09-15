-- ============================================================
-- LELA WebRTC Video Chat - Supabase Database Schema
-- Run this in your Supabase Project's SQL Editor
-- ============================================================

-- 1. Create Admins Table
CREATE TABLE IF NOT EXISTS public.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', -- 'admin', 'superadmin', 'moderator'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create Reports Table
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id INT,
    reported_id INT,
    reporter_ip TEXT,
    reported_ip TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'reviewed', 'banned', 'dismissed'
    action_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON public.reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_ip ON public.reports(reported_ip);

-- 3. Create Bans Table
CREATE TABLE IF NOT EXISTS public.bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    banned_by TEXT DEFAULT 'admin',
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ -- NULL means permanent ban
);

CREATE INDEX IF NOT EXISTS idx_bans_ip ON public.bans(ip);

-- 4. Create System & Audit Logs Table
CREATE TABLE IF NOT EXISTS public.system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL, -- e.g. 'ADMIN_LOGIN', 'BAN_IP', 'DISMISS_REPORT', 'BROADCAST'
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON public.system_logs(created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access to tables
CREATE POLICY "Service Role Full Access Admins" ON public.admins FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Reports" ON public.reports FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Bans" ON public.bans FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Logs" ON public.system_logs FOR ALL USING (true);

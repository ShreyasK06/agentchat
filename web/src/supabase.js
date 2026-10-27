import { createClient } from '@supabase/supabase-js';

export const url = import.meta.env.VITE_SUPABASE_URL;
export const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(url && anonKey);

// Owner session persists in localStorage via supabase-js (default).
export const supabase = configured ? createClient(url, anonKey) : null;

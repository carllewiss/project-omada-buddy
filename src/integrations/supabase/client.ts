import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Same backend as the original project.
const SUPABASE_URL =
  (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ??
  "https://tyqcalkdvsmeczbbqfns.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  (import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] as string | undefined) ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5cWNhbGtkdnNtZWN6YmJxZm5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUxNTYsImV4cCI6MjA4NjMyMTE1Nn0.VTgZPClT7Te2R-9Y6zvtVyDj6pVWRvX7svvvLSx3fcw";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Disom Baha site settings. See ADMIN-SETUP.md for where each value comes from.
//
// supabaseAnonKey is the "anon public" (or "publishable") key. It is meant to be
// public: the rules in supabase/schema.sql decide what it may do. NEVER paste the
// "service_role" or "secret" key here, because this file is published.
//
// While supabaseUrl is empty, the storefront keeps using the demo catalog in
// catalog.js and the admin panel shows setup instructions.
window.DISOM_BAHA_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  // Your live website address (used for the sitemap and uptime checks).
  siteUrl: "https://www.disombaha.com/",
  // Used by the admin panel to show the uptime checks from GitHub Actions.
  githubRepo: "sukhentudu/disom-baha-storefront"
};

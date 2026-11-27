// Disom Baha customer chat. Customers sign in with Google, then chat with the
// shop; replies arrive live and by email. The database only lets each customer
// read their own conversation (see supabase/schema.sql, "Customer chat").
// Shown only when chat is switched on in the admin panel (Content).
(() => {
  "use strict";

  const config = window.DISOM_BAHA_CONFIG || {};
  const SUPABASE_URL = String(config.supabaseUrl || "").trim().replace(/\/+$/, "");
  const SUPABASE_KEY = String(config.supabaseAnonKey || "").trim();
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const LIBRARY = {
    src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js",
    integrity: "sha384-uteMfOloLDGt042uDz+xHGF3ym63/WQ6rFq7murQRG8Ih7QrXGEGNtWd8688sb4O"
  };
  const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
  const WHATSAPP = "https://wa.me/918348938263";
  const params = new URLSearchParams(window.location.search);
  const returningFromGoogle = params.has("code") || /access_token=|error_description=/.test(window.location.hash);
  const askedToOpen = params.get("chat") === "open" || returningFromGoogle;

  let db = null;
  let clientPromise = null;
  let session = null;
  let thread = null;
  let messages = [];
  let channel = null;
  let pollTimer = null;
  let isOpen = false;
  let launcher;
  let panel;

  const $ = (selector, root = document) => root.querySelector(selector);
  const time = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  function hasStoredSession() {
    try { return Boolean(localStorage.getItem(STORAGE_KEY)); } catch { return false; }
  }

  // ─── Supabase client (loaded only when needed) ───────────────────────────

  function loadClient() {
    clientPromise ||= new Promise((resolve, reject) => {
      const ready = () => {
        db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
        });
        db.auth.onAuthStateChange((event, next) => {
          // Don't call Supabase inside this callback (it can deadlock).
          setTimeout(() => {
            const changed = (session?.user?.id || null) !== (next?.user?.id || null);
            session = next;
            if (changed) refresh();
          }, 0);
        });
        resolve(db);
      };
      if (window.supabase?.createClient) { ready(); return; }
      const script = document.createElement("script");
      script.src = LIBRARY.src;
      script.integrity = LIBRARY.integrity;
      script.crossOrigin = "anonymous";
      script.onload = ready;
      script.onerror = () => { clientPromise = null; reject(new Error("Chat could not load. Check your connection.")); };
      document.head.append(script);
    });
    return clientPromise;
  }

  async function callShop(route, body) {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/shop/${route}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  async function loadConversation() {
    if (!session) { thread = null; messages = []; return; }
    const { data: threadRow } = await db.from("chat_threads").select("*").eq("user_id", session.user.id).maybeSingle();
    thread = threadRow || null;
    if (!thread) { messages = []; return; }
    const { data: rows } = await db.from("chat_messages").select("id,sender,body,created_at").eq("thread_id", thread.id).order("created_at").limit(300);
    messages = rows || [];
  }

  function addMessage(message) {
    if (!message || messages.some((m) => m.id === message.id)) return;
    messages.push(message);
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    renderMessages();
    if (message.sender === "admin") {
      if (isOpen) markRead(); else setUnread(true);
    }
  }

  function markRead() {
    setUnread(false);
    if (thread?.customer_unread) {
      thread.customer_unread = false;
      db.rpc("chat_mark_read").then(() => {}, () => {});
    }
  }

  function subscribe() {
    if (!thread || channel) return;
    channel = db.channel(`chat-${thread.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `thread_id=eq.${thread.id}` }, (payload) => addMessage(payload.new))
      .subscribe();
  }

  function unsubscribe() {
    if (channel) { db.removeChannel(channel); channel = null; }
  }

  // Live updates can be blocked by some networks, so also check every 15 seconds while open.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!session || document.hidden) return;
      const before = messages.length;
      await loadConversation().catch(() => {});
      if (messages.length !== before) renderMessages();
      if (isOpen && thread?.customer_unread) markRead();
    }, 15000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function refresh() {
    unsubscribe();
    try { await loadConversation(); } catch { /* Shown as an empty chat. */ }
    render();
    setUnread(Boolean(thread?.customer_unread) && !isOpen);
    if (session && thread) subscribe();
    if (isOpen && thread?.customer_unread) markRead();
  }

  // ─── UI ──────────────────────────────────────────────────────────────────

  function setUnread(value) {
    launcher?.classList.toggle("has-unread", value);
    launcher?.setAttribute("aria-label", value ? "Open chat (new reply)" : "Chat with Disom Baha");
  }

  function build() {
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "chat-launcher";
    launcher.setAttribute("aria-label", "Chat with Disom Baha");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "chat-panel");
    launcher.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9.5h8M8 12.5h5"/></svg><span>Chat</span><i class="chat-dot" aria-hidden="true"></i>';
    launcher.addEventListener("click", () => (isOpen ? close() : open()));

    panel = document.createElement("section");
    panel.className = "chat-panel";
    panel.id = "chat-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with Disom Baha");
    panel.innerHTML = `
      <header class="chat-head">
        <div><strong>Chat with Disom Baha</strong><small class="chat-who"></small></div>
        <button class="chat-close" type="button" aria-label="Close chat">×</button>
      </header>
      <div class="chat-body"></div>`;
    $(".chat-close", panel).addEventListener("click", close);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    document.body.append(launcher, panel);
  }

  function render() {
    if (!panel) return;
    const body = $(".chat-body", panel);
    const who = $(".chat-who", panel);
    if (!db) { body.innerHTML = '<p class="chat-note">Loading…</p>'; return; }
    if (!session) {
      who.textContent = "We usually reply within a few hours";
      body.innerHTML = `
        <div class="chat-intro">
          <p>Questions about plants, delivery or an order? Sign in with Google so we can reply and keep your conversation safe.</p>
          <button class="chat-google" type="button"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.8 6c1.9-5.6 7.2-9.7 13.6-9.7z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.4 28.8c-.5-1.4-.8-3-.8-4.8s.3-3.3.8-4.8l-7.8-6C1 16.4 0 20.1 0 24s1 7.6 2.6 10.8l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.4 0-11.7-4.1-13.6-9.7l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>Continue with Google</button>
          <p class="chat-error" role="alert"></p>
          <a class="chat-alt" href="${WHATSAPP}" target="_blank" rel="noopener noreferrer">Prefer WhatsApp? Chat there instead ↗</a>
        </div>`;
      $(".chat-google", body).addEventListener("click", signIn);
      return;
    }
    const meta = session.user.user_metadata || {};
    who.textContent = `${meta.full_name || meta.name || ""}${meta.full_name || meta.name ? " · " : ""}${session.user.email || ""}`;
    body.innerHTML = `
      <ol class="chat-messages" aria-live="polite"></ol>
      <form class="chat-form">
        <label class="sr-only" for="chat-input">Your message</label>
        <textarea id="chat-input" name="message" rows="2" maxlength="2000" placeholder="Type your message…" required></textarea>
        <button class="chat-send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z"/></svg></button>
      </form>
      <p class="chat-error" role="alert"></p>
      <button class="chat-signout" type="button">Sign out</button>`;
    const form = $(".chat-form", body);
    form.addEventListener("submit", send);
    form.elements.message.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    $(".chat-signout", body).addEventListener("click", signOut);
    renderMessages();
  }

  function renderMessages() {
    const list = panel && $(".chat-messages", panel);
    if (!list) return;
    if (!messages.length) {
      list.innerHTML = '<li class="chat-empty">Say hello! Ask us anything about plants, delivery or your order. Adding your order number helps.</li>';
      return;
    }
    list.replaceChildren(...messages.map((message) => {
      const item = document.createElement("li");
      item.className = `chat-message from-${message.sender === "admin" ? "shop" : "you"}`;
      const text = document.createElement("p");
      text.textContent = message.body;
      const stamp = document.createElement("small");
      stamp.textContent = `${message.sender === "admin" ? "Disom Baha" : "You"} · ${time(message.created_at)}`;
      item.append(text, stamp);
      return item;
    }));
    list.scrollTop = list.scrollHeight;
  }

  function showError(text) {
    const node = panel && $(".chat-error", panel);
    if (node) node.textContent = text;
  }

  async function open() {
    isOpen = true;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    document.body.classList.add("chat-open");
    render();
    try {
      if (!db) { await loadClient(); const { data } = await db.auth.getSession(); session = data.session; await refresh(); }
      else if (thread?.customer_unread) markRead();
    } catch (error) {
      $(".chat-body", panel).innerHTML = '<p class="chat-note"></p>';
      $(".chat-note", panel).textContent = error.message;
      return;
    }
    startPolling();
    (panel.querySelector("textarea, .chat-google") || panel).focus();
  }

  function close() {
    isOpen = false;
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    document.body.classList.remove("chat-open");
    stopPolling();
    launcher.focus();
  }

  async function signIn() {
    showError("");
    const back = new URL(window.location.href);
    back.hash = "";
    back.searchParams.delete("code");
    back.searchParams.set("chat", "open");
    const { error } = await db.auth.signInWithOAuth({ provider: "google", options: { redirectTo: back.href } });
    if (error) showError(`Sign-in isn't available right now (${error.message}).`);
  }

  async function signOut() {
    unsubscribe();
    await db.auth.signOut();
    session = null;
    thread = null;
    messages = [];
    render();
  }

  async function send(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.message;
    const text = field.value.trim();
    if (!text) return;
    const button = $(".chat-send", form);
    button.disabled = true;
    showError("");
    try {
      let result;
      try {
        result = await callShop("chat-send", { body: text });
      } catch (error) {
        if (error.status && error.status !== 404 && error.status < 500) throw error;
        // Server function unreachable: save the message directly (no email alert).
        const { data, error: rpcError } = await db.rpc("chat_send", { p_body: text });
        if (rpcError) throw rpcError;
        result = data;
      }
      field.value = "";
      const firstMessage = !thread;
      addMessage(result.message);
      if (firstMessage) { await loadConversation(); subscribe(); renderMessages(); }
    } catch (error) {
      showError(error.status === 401 ? "Please sign in again to send messages." : error.message || "Your message couldn't be sent.");
      if (error.status === 401) { await db.auth.signOut().catch(() => {}); }
    } finally {
      button.disabled = false;
      field.focus();
    }
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async function start(settings) {
    if (String(settings?.chat_enabled) !== "true" || launcher) return;
    build();
    if (askedToOpen) {
      await open();
      // Tidy the address bar after returning from Google.
      const clean = new URL(window.location.href);
      ["code", "chat"].forEach((key) => clean.searchParams.delete(key));
      if (/access_token=|error_description=/.test(clean.hash)) clean.hash = "";
      window.history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
    } else if (hasStoredSession()) {
      // Signed in before: check quietly for unread replies.
      loadClient().then(async () => { const { data } = await db.auth.getSession(); session = data.session; await refresh(); }).catch(() => {});
    }
  }

  if (window.DISOM_BAHA_SETTINGS) start(window.DISOM_BAHA_SETTINGS);
  else document.addEventListener("disombaha:settings", (event) => start(event.detail), { once: true });
})();

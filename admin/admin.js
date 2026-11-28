"use strict";

// Disom Baha admin panel. Every read and write goes through Supabase, where the
// rules in supabase/schema.sql allow it only for accounts listed in admin_users.

const config = window.DISOM_BAHA_CONFIG || {};
const SUPABASE_URL = String(config.supabaseUrl || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = String(config.supabaseAnonKey || "").trim();
const SITE_URL = String(config.siteUrl || new URL("../", window.location.href).href).replace(/\/?$/, "/");
const IMAGE_BUCKET = "site-images";
const ORDER_STATUSES = ["new", "confirmed", "paid", "shipped", "delivered", "cancelled"];
const SALE_STATUSES = new Set(["confirmed", "paid", "shipped", "delivered"]);
const PAYMENT_LABELS = { unpaid: ["Pay later", ""], pending: ["Not paid yet", "badge-warn"], paid: ["Paid online", "badge-ok"], failed: ["Payment failed", "badge-bad"], refunded: ["Refunded", ""] };

// Online checkouts that were started but never paid are hidden unless asked for.
const isUnfinishedCheckout = (order) => order.payment_status === "pending" || order.payment_status === "failed";
// Money actually received (online) or confirmed by the admin (WhatsApp orders).
const isSale = (order) => order.payment_status === "paid" || (order.payment_status === "unpaid" && SALE_STATUSES.has(order.status));
// Orders that need the admin to do something: new WhatsApp requests, and paid orders not yet shipped.
const needsAction = (order) => (order.payment_status === "unpaid" && order.status === "new")
  || (order.payment_status === "paid" && ["new", "confirmed", "paid"].includes(order.status));

function paymentBadge(status) {
  const [label, tone] = PAYMENT_LABELS[status] || [status, ""];
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}
const KNOWN_CATEGORIES = ["indoor", "pet-friendly", "low-maintenance", "air-purifying", "pots-planters", "low-light", "medium-light", "bright-light"];
const SEO_PAGES = [
  { path: "index.html", label: "Home page" },
  { path: "product.html", label: "Product pages" },
  { path: "policies.html", label: "Delivery & promise" },
  { path: "journal.html", label: "Journal" }
];

let db = null;
let currentUser = null;
let bootedApp = false;
// A password-reset link opens this page signed in; show the new-password form
// instead of the dashboard until a new password is saved.
let recoveryMode = /type=recovery/.test(window.location.hash);
const state = { orders: [], products: [], customers: [], messages: [], posts: [], seo: [], settings: {} };

// ─── Helpers ────────────────────────────────────────────────────────────────

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const money = (amount) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(amount) || 0);
const number = (value) => new Intl.NumberFormat("en-IN").format(Number(value) || 0);
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");
const digits = (value) => String(value || "").replace(/\D/g, "");
// Page views are counted by India date, so day ranges use the same calendar.
const istDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);

function whatsappLink(phone, text = "") {
  let d = digits(phone);
  if (d.length === 10) d = `91${d}`;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
  node.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-visible"), isError ? 6000 : 3000);
}

// Runs a Supabase call and turns its { data, error } result into a value or a thrown error.
async function run(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message || "Something went wrong");
  return data;
}

async function withBusy(button, task) {
  if (button) button.disabled = true;
  try { return await task(); }
  catch (error) { toast(error.message, true); return undefined; }
  finally { if (button) button.disabled = false; }
}

function showOnly(viewId) {
  ["setup-view", "login-view", "reset-view", "denied-view", "app-view"].forEach((id) => { $(`#${id}`).hidden = id !== viewId; });
}

function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}

function emptyRow(columns, text) {
  return `<tr><td class="empty" colspan="${columns}">${esc(text)}</td></tr>`;
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(rows) {
  return rows.map((row) => row.map((cell) => {
    let text = String(cell ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // keep spreadsheets from running formulas
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");
}

// ─── Sign in ────────────────────────────────────────────────────────────────

async function handleSession(session) {
  currentUser = session?.user || null;
  if (!currentUser) { bootedApp = false; showOnly("login-view"); return; }
  let isAdmin = false;
  try { isAdmin = await run(db.rpc("is_admin")); }
  catch (error) { toast(`Could not check admin access: ${error.message}`, true); }
  if (!isAdmin) {
    $("#denied-email").textContent = currentUser.email || "this account";
    showOnly("denied-view");
    return;
  }
  $("#signed-in-as").textContent = currentUser.email || "";
  showOnly("app-view");
  if (!bootedApp) { bootedApp = true; route(); refreshBadges(); subscribeToChat(); }
}

function setupAuthForms() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $(".form-status", form);
    status.textContent = "";
    await withBusy($("button[type=submit]", form), async () => {
      const { error } = await db.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
      if (error) status.textContent = error.message === "Invalid login credentials" ? "That email and password don't match." : error.message;
      else form.reset();
    });
  });

  $("#forgot-password").addEventListener("click", async () => {
    const form = $("#login-form");
    const status = $(".form-status", form);
    const email = form.email.value.trim();
    if (!email) { status.textContent = "Type your email first, then click “Forgot password?” again."; form.email.focus(); return; }
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split("#")[0] });
    status.textContent = error ? error.message : "If that email has an account, a reset link is on its way.";
  });

  $("#reset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $(".form-status", form);
    await withBusy($("button[type=submit]", form), async () => {
      const { error } = await db.auth.updateUser({ password: form.password.value });
      if (error) { status.textContent = error.message; return; }
      form.reset();
      recoveryMode = false;
      toast("Password saved");
      const { data } = await db.auth.getSession();
      handleSession(data.session);
    });
  });

  document.addEventListener("click", async (event) => {
    if (!event.target.closest('[data-action="sign-out"]')) return;
    await db.auth.signOut();
    window.location.hash = "";
  });
}

// ─── Navigation ─────────────────────────────────────────────────────────────

const sections = {
  dashboard: loadDashboard, orders: loadOrders, products: loadProducts, customers: loadCustomers,
  messages: loadMessages, chat: loadChat, reviews: loadReviews, content: loadContent, seo: loadSeo, analytics: loadAnalytics, uptime: loadUptime, team: loadTeam
};

function route() {
  if ($("#app-view").hidden) return;
  const name = window.location.hash.replace("#", "") || "dashboard";
  const section = sections[name] ? name : "dashboard";
  $$("[data-section]").forEach((panel) => { panel.hidden = panel.dataset.section !== section; });
  $$("[data-nav]").forEach((link) => link.classList.toggle("is-active", link.dataset.nav === section));
  $("#content").focus({ preventScroll: true });
  sections[section]().catch((error) => toast(error.message, true));
}

async function refreshBadges() {
  try {
    const [orders, messages, chats, reviews] = await Promise.all([
      db.from("orders").select("id", { count: "exact", head: true })
        .or("and(payment_status.eq.unpaid,status.eq.new),and(payment_status.eq.paid,status.in.(new,confirmed,paid))"),
      db.from("contact_messages").select("id", { count: "exact", head: true }).eq("status", "new"),
      db.from("chat_threads").select("id", { count: "exact", head: true }).eq("admin_unread", true),
      db.from("reviews").select("id", { count: "exact", head: true }).eq("status", "pending")
    ]);
    const set = (id, count) => { const node = $(id); node.textContent = count || ""; node.hidden = !count; };
    set("#badge-orders", orders.count);
    set("#badge-messages", messages.count);
    set("#badge-chat", chats.count);
    set("#badge-reviews", reviews.count);
  } catch { /* Badges are optional. */ }
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

async function loadDashboard() {
  const since = istDay(new Date(Date.now() - 6 * 86400000));
  const [orders, products, newMessages, views] = await Promise.all([
    run(db.from("orders").select("id,reference,status,payment_status,subtotal,customer_name,city,created_at,admin_note").order("created_at", { ascending: false }).limit(1000)),
    run(db.from("products").select("id,name,stock,is_active,is_demo,image,description")),
    db.from("contact_messages").select("id", { count: "exact", head: true }).eq("status", "new"),
    run(db.from("page_views_daily").select("views").gte("day", since))
  ]);
  const real = orders.filter((order) => !isUnfinishedCheckout(order));
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = real.filter((order) => new Date(order.created_at) >= monthStart);
  const sales = thisMonth.filter(isSale);
  const newCount = real.filter(needsAction).length;
  const toShip = real.filter((order) => isSale(order) && !["shipped", "delivered", "cancelled"].includes(order.status)).length;
  const viewCount = views.reduce((sum, row) => sum + row.views, 0);

  $("#dashboard-stats").innerHTML = [
    ["Needs action", number(newCount), "New requests and paid orders"],
    ["To ship", number(toShip), "Paid or confirmed, not shipped"],
    ["Sales this month", money(sales.reduce((sum, order) => sum + order.subtotal, 0)), `${sales.length} paid or confirmed orders`],
    ["Orders this month", number(thisMonth.length), "All statuses"],
    ["New messages", number(newMessages.count || 0), "From the contact form"],
    ["Page views", number(viewCount), "Last 7 days"]
  ].map(([label, value, note]) => `<div class="stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");

  $("#dashboard-orders").innerHTML = real.length
    ? `<div class="mini-list">${real.slice(0, 6).map((order) => `<a class="mini-row" href="#orders" data-open-order="${esc(order.id)}"><span class="grow"><strong>${esc(order.reference)}</strong> · ${esc(order.customer_name)}<span class="cell-sub">${dateTime(order.created_at)}</span></span><span>${money(order.subtotal)}</span>${badge(order.status)}</a>`).join("")}</div>`
    : '<p class="muted">No orders yet. They will appear here when customers check out on the website.</p>';

  const alerts = [];
  products.filter((p) => p.is_active && p.stock !== null && p.stock <= 3).forEach((p) => alerts.push([p.stock === 0 ? "bad" : "warn", `${p.name}: ${p.stock === 0 ? "out of stock" : `only ${p.stock} left`}`, "#products"]));
  const demoCount = products.filter((p) => p.is_active && p.is_demo).length;
  if (demoCount) alerts.push(["warn", `${demoCount} live product${demoCount > 1 ? "s are" : " is"} still marked as demo content`, "#products"]);
  if (!products.length) alerts.push(["warn", "No products in the database yet. Import the demo catalog or add your first product.", "#products"]);
  products.filter((p) => p.is_active && !p.image).forEach((p) => alerts.push(["warn", `${p.name} has no image`, "#products"]));
  const oldNew = real.filter((o) => needsAction(o) && Date.now() - new Date(o.created_at) > 2 * 86400000).length;
  if (oldNew) alerts.push(["bad", `${oldNew} order${oldNew > 1 ? "s have" : " has"} been waiting more than 2 days`, "#orders"]);
  real.filter((o) => o.payment_status === "paid" && /stock was short/i.test(o.admin_note || "") && o.status !== "cancelled")
    .forEach((o) => alerts.push(["bad", `${o.reference} was paid but stock was short. Restock or refund it`, "#orders"]));
  $("#dashboard-alerts").innerHTML = alerts.length
    ? `<div class="mini-list">${alerts.map(([level, text, href]) => `<a class="mini-row" href="${href}"><span class="grow">${esc(text)}</span><span class="badge badge-${level}">${level === "bad" ? "urgent" : "check"}</span></a>`).join("")}</div>`
    : '<p class="muted">All clear. Nothing needs attention right now.</p>';
}

document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-open-order]");
  if (!opener) return;
  event.preventDefault();
  window.location.hash = "orders";
  openOrder(opener.dataset.openOrder);
});

// ─── Orders ─────────────────────────────────────────────────────────────────

async function loadOrders() {
  state.orders = await run(db.from("orders").select("*").order("created_at", { ascending: false }).limit(2000));
  renderOrders();
  refreshBadges();
}

function filteredOrders() {
  const query = $("#orders-search").value.trim().toLowerCase();
  const queryDigits = digits(query);
  const status = $("#orders-status").value;
  const payment = $("#orders-payment").value;
  return state.orders.filter((order) => (status ? order.status === status : true)
    && (payment === "unfinished" ? isUnfinishedCheckout(order) : payment ? order.payment_status === payment : !isUnfinishedCheckout(order))
    && (!query
    || `${order.reference} ${order.customer_name} ${order.email || ""} ${order.city} ${order.state} ${order.pincode}`.toLowerCase().includes(query)
    || (queryDigits.length >= 4 && order.phone_digits.includes(queryDigits))));
}

function renderOrders() {
  const orders = filteredOrders();
  $("#orders-table").innerHTML = `<thead><tr><th>Order</th><th class="hide-sm">Date</th><th>Customer</th><th class="hide-sm">Items</th><th class="num">Total</th><th>Status</th><th class="hide-sm">Payment</th></tr></thead><tbody>${
    orders.length ? orders.map((order) => `<tr class="clickable" data-order="${esc(order.id)}" tabindex="0">
      <td><strong>${esc(order.reference)}</strong></td>
      <td class="hide-sm">${dateTime(order.created_at)}</td>
      <td>${esc(order.customer_name)}<span class="cell-sub">${esc(order.city)}, ${esc(order.state)}</span></td>
      <td class="hide-sm">${order.items.reduce((sum, line) => sum + line.quantity, 0)}</td>
      <td class="num">${money(order.subtotal)}</td><td>${badge(order.status)}</td><td class="hide-sm">${paymentBadge(order.payment_status)}</td></tr>`).join("")
    : emptyRow(7, state.orders.length ? "No orders match these filters." : "No orders yet.")}</tbody>`;
}

function stockHint(order) {
  if (order.stock_deducted && order.status === "new" && order.reserved_until) {
    return `Stock is on hold for this order until ${dateTime(order.reserved_until)}. Confirm it to keep the plants; otherwise they go back on sale automatically.`;
  }
  if (order.stock_deducted) return "Stock has been taken off for this order.";
  if (order.payment_status === "paid") return "Stock was short when this was paid. Restock, then set the status to Confirmed or Shipped.";
  if (order.status === "new") return "The stock hold for this order ran out, so its plants went back on sale. Confirming takes them off again if they're still in stock.";
  return "No stock is held for this order.";
}

function openOrder(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) {
    run(db.from("orders").select("*").eq("id", id).single()).then((row) => { state.orders.unshift(row); openOrder(id); }).catch((error) => toast(error.message, true));
    return;
  }
  const items = order.items.map((line) => `<tr><td>${line.quantity} × ${esc(line.name)}<span class="cell-sub">${esc(line.size)}${line.color ? ` · ${esc(line.color)}` : ""}</span></td><td class="num">${money(line.line_total)}</td></tr>`).join("");
  const greeting = `Hi ${order.customer_name}, this is Disom Baha about your order ${order.reference}.`;
  const trackUrl = `${SITE_URL}track.html?ref=${encodeURIComponent(order.reference)}`;
  const emailLink = order.email ? `mailto:${encodeURIComponent(order.email)}?subject=${encodeURIComponent(`Your Disom Baha order ${order.reference}`)}&body=${encodeURIComponent(`Hi ${order.customer_name},\n\n\n\nTrack your order: ${trackUrl}\n\nDisom Baha`)}` : "";
  const paymentInfo = order.payment_status === "unpaid"
    ? `Payment: ${esc(order.payment_preference || "—")} (arranged with the customer)`
    : `${paymentBadge(order.payment_status)}${order.paid_at ? ` on ${dateTime(order.paid_at)}` : ""}${order.razorpay_payment_id ? `<br><a href="https://dashboard.razorpay.com/app/payments/${encodeURIComponent(order.razorpay_payment_id)}" target="_blank" rel="noopener noreferrer">Open in Razorpay ↗</a> <span class="cell-sub">Refund from Razorpay; the order then updates itself.</span>` : ""}`;
  $("#order-detail").innerHTML = `
    <header class="modal-head"><h2>Order ${esc(order.reference)}</h2><button class="icon-btn" type="button" data-close aria-label="Close">×</button></header>
    <p class="muted">Placed ${dateTime(order.created_at)} · ${badge(order.status)} ${paymentBadge(order.payment_status)}</p>
    <table class="line-items"><tbody>${items}</tbody><tfoot><tr><td>Total (free delivery)</td><td class="num">${money(order.subtotal)}</td></tr></tfoot></table>
    <div class="detail-grid">
      <div><h3>Customer</h3><p>${esc(order.customer_name)}<br>${esc(order.phone)}${order.email ? `<br>${esc(order.email)}` : ""}</p>
        <div class="contact-actions"><a class="btn btn-small" href="${esc(whatsappLink(order.phone, greeting))}" target="_blank" rel="noopener noreferrer">WhatsApp</a><a class="btn btn-small" href="tel:${esc(digits(order.phone))}">Call</a>${emailLink ? `<a class="btn btn-small" href="${esc(emailLink)}">Email</a>` : ""}</div></div>
      <div><h3>Deliver to</h3><p>${esc(order.address)}<br>${esc(order.city)}, ${esc(order.state)} ${esc(order.pincode)}</p><h3>Payment</h3><p>${paymentInfo}</p></div>
    </div>
    <form class="form-grid" id="order-form">
      <label>Status<select name="status">${ORDER_STATUSES.map((s) => `<option value="${s}"${s === order.status ? " selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join("")}</select></label>
      <label>Tracking / courier<input name="tracking" maxlength="200" value="${esc(order.tracking)}"></label>
      <label class="form-wide">Private note<textarea name="admin_note" rows="3" maxlength="2000">${esc(order.admin_note)}</textarea></label>
      <p class="hint form-wide">${stockHint(order)}${order.email ? " When you change the status to Confirmed, Shipped, Delivered or Cancelled, the customer is emailed about a minute later, with the tracking number if you've added it." : ""} Customers see the status and tracking on the <a href="${esc(trackUrl)}" target="_blank" rel="noopener">tracking page</a>.</p>
      <footer class="modal-foot form-wide"><button class="btn btn-danger" type="button" id="order-delete">Delete</button><span></span><button class="btn" type="button" data-close>Close</button><button class="btn btn-primary" type="submit">Save changes</button></footer>
    </form>`;
  const dialog = $("#order-dialog");
  dialog.showModal();

  $("#order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy($("button[type=submit]", form), async () => {
      if (form.status.value !== order.status) await run(db.rpc("set_order_status", { p_order_id: order.id, p_status: form.status.value }));
      if (form.tracking.value !== order.tracking || form.admin_note.value !== order.admin_note) {
        await run(db.from("orders").update({ tracking: form.tracking.value, admin_note: form.admin_note.value }).eq("id", order.id));
      }
      dialog.close();
      toast(`Order ${order.reference} saved`);
      await loadOrders();
    });
  });
  $("#order-delete").addEventListener("click", (event) => {
    if (!window.confirm(`Delete order ${order.reference}? This cannot be undone. Cancel it instead if you want to keep a record.`)) return;
    withBusy(event.currentTarget, async () => {
      if (order.stock_deducted) await run(db.rpc("set_order_status", { p_order_id: order.id, p_status: "cancelled" }));
      await run(db.from("orders").delete().eq("id", order.id));
      dialog.close();
      toast("Order deleted");
      await loadOrders();
    });
  });
}

function setupOrders() {
  $("#orders-search").addEventListener("input", renderOrders);
  $("#orders-status").addEventListener("change", renderOrders);
  $("#orders-payment").addEventListener("change", renderOrders);
  const table = $("#orders-table");
  table.addEventListener("click", (event) => { const row = event.target.closest("[data-order]"); if (row) openOrder(row.dataset.order); });
  table.addEventListener("keydown", (event) => { const row = event.target.closest("[data-order]"); if (row && event.key === "Enter") openOrder(row.dataset.order); });
  $("#orders-export").addEventListener("click", () => {
    const rows = [["Reference", "Date", "Status", "Payment status", "Razorpay payment", "Name", "Phone", "Email", "Address", "City", "State", "PIN", "Payment", "Items", "Total", "Tracking", "Note"]];
    filteredOrders().forEach((o) => rows.push([o.reference, o.created_at, o.status, o.payment_status, o.razorpay_payment_id || "", o.customer_name, o.phone, o.email || "", o.address, o.city, o.state, o.pincode, o.payment_preference,
      o.items.map((l) => `${l.quantity} x ${l.name} (${l.size}${l.color ? `, ${l.color}` : ""})`).join("; "), o.subtotal, o.tracking, o.admin_note]));
    downloadFile(`disom-baha-orders-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), "text/csv");
  });
}

// ─── Products ───────────────────────────────────────────────────────────────

async function loadProducts() {
  state.products = await run(db.from("products").select("*").order("sort_order").order("name"));
  renderProducts();
}

function renderProducts() {
  const query = $("#products-search").value.trim().toLowerCase();
  const products = state.products.filter((p) => !query || `${p.name} ${p.botanical} ${p.id}`.toLowerCase().includes(query));
  $("#products-table").innerHTML = `<thead><tr><th></th><th>Product</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th></tr></thead><tbody>${
    products.length ? products.map((p) => `<tr class="clickable" data-product="${esc(p.id)}" tabindex="0">
      <td>${p.image ? `<img class="thumb" src="${esc(resolveImage(p.image))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}</td>
      <td><strong>${esc(p.name)}</strong><span class="cell-sub">${esc(p.botanical || p.id)}</span></td>
      <td class="num">${money(p.price)}</td>
      <td class="num">${p.stock === null ? '<span class="muted">ask</span>' : number(p.stock)}</td>
      <td>${p.is_active ? '<span class="badge badge-ok">live</span>' : '<span class="badge">hidden</span>'} ${p.is_demo ? '<span class="badge badge-warn">demo</span>' : ""}</td></tr>`).join("")
    : emptyRow(5, state.products.length ? "No products match." : "No products yet. Click “Import demo catalog” to copy the current website products, or “Add product”.")}</tbody>`;
}

// Images saved as site paths (assets/…) are relative to the website root.
function resolveImage(src) {
  if (!src) return "";
  if (/^https?:\/\//i.test(src)) return src;
  return new URL(src.replace(/^\/+/, ""), new URL("../", window.location.href)).href;
}

function sizesToText(options) {
  return (options || []).map((o) => `${o.label} : ${Number(o.extra) || 0}`).join("\n");
}
function textToSizes(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const split = line.lastIndexOf(":");
    const extra = split < 0 ? 0 : Number(line.slice(split + 1).trim());
    if (split >= 0 && !Number.isFinite(extra)) throw new Error(`The size “${line}” needs a number after the colon.`);
    return { label: (split < 0 ? line : line.slice(0, split)).trim(), extra: Math.round(extra) || 0 };
  });
}

function setPreview(form) {
  const preview = $(".image-preview", form);
  const src = form.image.value.trim();
  preview.hidden = !src;
  if (src) preview.src = resolveImage(src);
}

let editingProduct = null;
function openProduct(id) {
  editingProduct = id ? state.products.find((p) => p.id === id) : null;
  const p = editingProduct || { is_active: true, price: "", stock: null, size_options: [], pot_colors: ["Sage green", "Warm white", "Terracotta"], categories: [], sort_order: state.products.length };
  const form = $("#product-form");
  form.reset();
  $("#product-form-title").textContent = editingProduct ? `Edit ${p.name}` : "Add product";
  ["name", "id", "botanical", "tag", "price", "image", "light", "light_filter", "water", "water_filter", "humidity", "height", "pot_diameter", "includes", "description", "review", "review_by", "sort_order"]
    .forEach((field) => { form[field].value = p[field] ?? ""; });
  form.stock.value = p.stock ?? "";
  form.id.readOnly = Boolean(editingProduct);
  form.size_options.value = sizesToText(p.size_options);
  form.pot_colors.value = (p.pot_colors || []).join(", ");
  form.is_active.checked = Boolean(p.is_active);
  form.is_demo.checked = Boolean(p.is_demo);
  const categories = [...new Set([...KNOWN_CATEGORIES, ...(p.categories || [])])];
  $("#product-categories").innerHTML = `<legend>Categories</legend>${categories.map((c) => `<label class="check"><input type="checkbox" name="category" value="${esc(c)}"${(p.categories || []).includes(c) ? " checked" : ""}> ${esc(c.replaceAll("-", " "))}</label>`).join("")}`;
  $("#product-delete").hidden = !editingProduct;
  $(".form-status", form).textContent = "";
  setPreview(form);
  $("#product-dialog").showModal();
}

function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function uploadImage(file, folder) {
  if (!file) return "";
  if (file.size > 5 * 1024 * 1024) throw new Error("Please choose an image under 5 MB.");
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[file.type];
  if (!extension) throw new Error("Please choose a PNG, JPG or WebP image.");
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  await run(db.storage.from(IMAGE_BUCKET).upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false }));
  return db.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

function setupImageFields() {
  $$("[data-upload]").forEach((input) => input.addEventListener("change", async () => {
    const form = input.closest("form");
    const button = input.closest(".file-btn");
    button.classList.add("is-busy");
    try {
      form.image.value = await uploadImage(input.files[0], input.dataset.upload === "product" ? "products" : "journal");
      setPreview(form);
      toast("Image uploaded. Save to keep it.");
    } catch (error) { toast(error.message, true); }
    finally { input.value = ""; button.classList.remove("is-busy"); }
  }));
  $$("form").forEach((form) => form.image?.addEventListener("change", () => setPreview(form)));
}

function setupProducts() {
  $("#products-search").addEventListener("input", renderProducts);
  $("#products-add").addEventListener("click", () => openProduct(null));
  const table = $("#products-table");
  table.addEventListener("click", (event) => { const row = event.target.closest("[data-product]"); if (row) openProduct(row.dataset.product); });
  table.addEventListener("keydown", (event) => { const row = event.target.closest("[data-product]"); if (row && event.key === "Enter") openProduct(row.dataset.product); });

  const form = $("#product-form");
  form.name.addEventListener("input", () => { if (!editingProduct && !form.id.dataset.touched) form.id.value = slugify(form.name.value); });
  form.id.addEventListener("input", () => { form.id.dataset.touched = "1"; });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const status = $(".form-status", form);
    status.textContent = "";
    withBusy($("button[type=submit]", form), async () => {
      let sizeOptions;
      try { sizeOptions = textToSizes(form.size_options.value); } catch (error) { status.textContent = error.message; return; }
      const record = {
        name: form.name.value.trim(), botanical: form.botanical.value.trim(), tag: form.tag.value.trim(),
        price: Math.round(Number(form.price.value)), stock: form.stock.value === "" ? null : Math.round(Number(form.stock.value)),
        image: form.image.value.trim(), light: form.light.value.trim(), light_filter: form.light_filter.value,
        water: form.water.value.trim(), water_filter: form.water_filter.value, humidity: form.humidity.value.trim(),
        height: form.height.value.trim(), pot_diameter: form.pot_diameter.value.trim(), includes: form.includes.value.trim(),
        size_options: sizeOptions, pot_colors: form.pot_colors.value.split(",").map((c) => c.trim()).filter(Boolean),
        categories: $$('input[name="category"]:checked', form).map((input) => input.value),
        description: form.description.value.trim(), review: form.review.value.trim(), review_by: form.review_by.value.trim(),
        sort_order: Math.round(Number(form.sort_order.value)) || 0, is_active: form.is_active.checked, is_demo: form.is_demo.checked
      };
      if (editingProduct) await run(db.from("products").update(record).eq("id", editingProduct.id));
      else await run(db.from("products").insert({ id: form.id.value.trim(), ...record }));
      delete form.id.dataset.touched;
      $("#product-dialog").close();
      toast(`${record.name} saved`);
      await loadProducts();
    });
  });

  $("#product-delete").addEventListener("click", (event) => {
    if (!editingProduct || !window.confirm(`Delete ${editingProduct.name}? Past orders keep their copy of the item. To hide it from the website instead, untick “Show on website”.`)) return;
    withBusy(event.currentTarget, async () => {
      await run(db.from("products").delete().eq("id", editingProduct.id));
      $("#product-dialog").close();
      toast("Product deleted");
      await loadProducts();
    });
  });

  $("#products-import").addEventListener("click", (event) => {
    const demo = window.DISOM_BAHA_CATALOG || {};
    const rows = Object.entries(demo).map(([id, p], index) => ({
      id, name: p.name, botanical: p.botanical || "", price: Number(p.price) || 0, image: p.image || "", tag: p.tag || "", is_demo: Boolean(p.isDemo),
      light: p.light || "", light_filter: p.lightFilter || "", water: p.water || "", water_filter: p.waterFilter || "", humidity: p.humidity || "",
      size_options: p.sizeOptions || [], height: p.height || "", pot_diameter: p.potDiameter || "", includes: p.includes || "",
      stock: p.stock ?? null, categories: p.categories || [], description: p.description || "", review: p.review || "", review_by: p.reviewBy || "",
      is_active: true, sort_order: index
    }));
    if (!rows.length) { toast("No demo catalog found.", true); return; }
    if (!window.confirm(`Copy ${rows.length} products from catalog.js into the database? Products that already exist are left unchanged.`)) return;
    withBusy(event.currentTarget, async () => {
      await run(db.from("products").upsert(rows, { onConflict: "id", ignoreDuplicates: true }));
      toast("Demo catalog imported");
      await loadProducts();
    });
  });
}

// ─── Customers ──────────────────────────────────────────────────────────────

async function loadCustomers() {
  state.customers = await run(db.from("customer_summary").select("*").order("last_order_at", { ascending: false }).limit(5000));
  renderCustomers();
}

function filteredCustomers() {
  const query = $("#customers-search").value.trim().toLowerCase();
  const queryDigits = digits(query);
  return state.customers.filter((c) => !query || `${c.name} ${c.email || ""} ${c.city} ${c.state}`.toLowerCase().includes(query) || (queryDigits.length >= 4 && c.phone_digits.includes(queryDigits)));
}

function renderCustomers() {
  const customers = filteredCustomers();
  $("#customers-table").innerHTML = `<thead><tr><th>Customer</th><th class="hide-sm">Location</th><th class="num">Orders</th><th class="num">Spent</th><th class="hide-sm">Last order</th><th></th></tr></thead><tbody>${
    customers.length ? customers.map((c) => `<tr>
      <td><strong>${esc(c.name)}</strong><span class="cell-sub">${esc(c.phone)}${c.email ? ` · ${esc(c.email)}` : ""}</span></td>
      <td class="hide-sm">${esc(c.city)}, ${esc(c.state)}</td>
      <td class="num">${number(c.order_count)}</td><td class="num">${money(c.total_spent)}</td>
      <td class="hide-sm">${dateOnly(c.last_order_at)}</td>
      <td><div class="contact-actions"><a class="btn btn-small" href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener noreferrer">WhatsApp</a><button class="btn btn-small" type="button" data-customer-orders="${esc(c.phone_digits)}">Orders</button></div></td></tr>`).join("")
    : emptyRow(6, state.customers.length ? "No customers match." : "No customers yet. They appear after their first order.")}</tbody>`;
}

function setupCustomers() {
  $("#customers-search").addEventListener("input", renderCustomers);
  $("#customers-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-customer-orders]");
    if (!button) return;
    $("#orders-search").value = button.dataset.customerOrders;
    $("#orders-status").value = "";
    window.location.hash = "orders";
  });
  $("#customers-export").addEventListener("click", () => {
    const rows = [["Name", "Phone", "Email", "City", "State", "Orders", "Spent", "First order", "Last order"]];
    filteredCustomers().forEach((c) => rows.push([c.name, c.phone, c.email || "", c.city, c.state, c.order_count, c.total_spent, c.first_order_at, c.last_order_at]));
    downloadFile(`disom-baha-customers-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), "text/csv");
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

async function loadMessages() {
  const filter = $("#messages-status").value;
  let query = db.from("contact_messages").select("*").order("created_at", { ascending: false }).limit(500);
  if (filter === "open") query = query.neq("status", "archived");
  else if (filter) query = query.eq("status", filter);
  state.messages = await run(query);
  $("#messages-list").innerHTML = state.messages.length ? state.messages.map((m) => {
    const isEmail = /\S+@\S+\.\S+/.test(m.contact);
    const reply = isEmail ? `mailto:${encodeURIComponent(m.contact)}?subject=${encodeURIComponent("Your message to Disom Baha")}` : whatsappLink(m.contact, `Hi ${m.name}, thanks for your message to Disom Baha.`);
    return `<article class="message${m.status === "new" ? " is-new" : ""}">
      <div class="message-head"><span><strong>${esc(m.name)}</strong> · ${esc(m.contact)}</span><span class="muted">${dateTime(m.created_at)} ${badge(m.status)}</span></div>
      <p>${esc(m.message)}</p>
      <div class="message-actions">
        <a class="btn btn-small btn-primary" href="${esc(reply)}" target="_blank" rel="noopener noreferrer">${isEmail ? "Reply by email" : "Reply on WhatsApp"}</a>
        ${m.status === "new" ? `<button class="btn btn-small" type="button" data-message="${esc(m.id)}" data-set="read">Mark read</button>` : ""}
        ${m.status !== "archived" ? `<button class="btn btn-small" type="button" data-message="${esc(m.id)}" data-set="archived">Archive</button>` : `<button class="btn btn-small" type="button" data-message="${esc(m.id)}" data-set="read">Restore</button>`}
        <button class="btn btn-small btn-danger" type="button" data-message="${esc(m.id)}" data-set="delete">Delete</button>
      </div></article>`;
  }).join("") : '<div class="card muted">No messages here. Messages sent from the website contact form appear here.</div>';
  refreshBadges();
}

function setupMessages() {
  $("#messages-status").addEventListener("change", () => loadMessages().catch((error) => toast(error.message, true)));
  $("#messages-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-message]");
    if (!button) return;
    const { message: id, set } = button.dataset;
    if (set === "delete" && !window.confirm("Delete this message?")) return;
    withBusy(button, async () => {
      if (set === "delete") await run(db.from("contact_messages").delete().eq("id", id));
      else await run(db.from("contact_messages").update({ status: set }).eq("id", id));
      await loadMessages();
    });
  });
}


// ─── Reviews ────────────────────────────────────────────────────────────────

async function loadReviews() {
  const filter = $("#reviews-status").value;
  let query = db.from("reviews").select("id, product_id, author_name, city, rating, body, status, created_at, orders(reference)")
    .order("created_at", { ascending: false }).limit(500);
  if (filter) query = query.eq("status", filter);
  const reviews = await run(query);
  if (!state.products.length) state.products = await run(db.from("products").select("id, name"));
  const productName = (id) => state.products.find((p) => p.id === id)?.name || id;
  $("#reviews-list").innerHTML = reviews.length ? reviews.map((r) => `<article class="message${r.status === "pending" ? " is-new" : ""}">
      <div class="message-head"><span><strong>${esc(productName(r.product_id))}</strong> · <span aria-label="${r.rating} out of 5">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span></span><span class="muted">${dateTime(r.created_at)} ${badge(r.status)}</span></div>
      <p>${esc(r.body)}</p>
      <p class="muted">${esc(r.author_name)}${r.city ? `, ${esc(r.city)}` : ""} · order ${esc(r.orders?.reference || "")}</p>
      <div class="message-actions">
        ${r.status !== "approved" ? `<button class="btn btn-small btn-primary" type="button" data-review="${esc(r.id)}" data-set="approved">Approve</button>` : ""}
        ${r.status !== "rejected" ? `<button class="btn btn-small" type="button" data-review="${esc(r.id)}" data-set="rejected">${r.status === "approved" ? "Hide" : "Reject"}</button>` : ""}
        <button class="btn btn-small btn-danger" type="button" data-review="${esc(r.id)}" data-set="delete">Delete</button>
      </div></article>`).join("")
    : `<div class="card muted">${filter === "pending" ? "No reviews are waiting. Customers can review their plants from the tracking page once an order has shipped." : "No reviews here yet."}</div>`;
  refreshBadges();
}

function setupReviews() {
  $("#reviews-status").addEventListener("change", () => loadReviews().catch((error) => toast(error.message, true)));
  $("#reviews-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-review]");
    if (!button) return;
    const { review: id, set } = button.dataset;
    if (set === "delete" && !window.confirm("Delete this review? This can't be undone.")) return;
    withBusy(button, async () => {
      if (set === "delete") await run(db.from("reviews").delete().eq("id", id));
      else await run(db.from("reviews").update({ status: set }).eq("id", id));
      await loadReviews();
    });
  });
}

// ─── Chat ───────────────────────────────────────────────────────────────────

const chat = { threads: [], current: null, messages: [], channel: null };

async function loadChat() {
  const [threads, settings] = await Promise.all([
    run(db.from("chat_threads").select("*").order("last_message_at", { ascending: false }).limit(500)),
    run(db.from("site_settings").select("value").eq("key", "chat_enabled"))
  ]);
  chat.threads = threads;
  $("#chat-off-hint").hidden = settings?.[0]?.value === "true";
  renderThreads();
  if (chat.current) await openThread(chat.current, { keepScroll: true });
}

function renderThreads() {
  const filter = $("#chat-filter").value;
  const threads = chat.threads.filter((t) => filter === "unread" ? t.admin_unread : filter ? t.status === filter : true);
  $("#chat-threads").innerHTML = threads.length ? threads.map((t) => `
    <button class="chat-thread${t.id === chat.current ? " is-active" : ""}${t.admin_unread ? " is-unread" : ""}" type="button" data-thread="${esc(t.id)}">
      <span class="grow"><strong>${esc(t.customer_name || t.customer_email || "Customer")}</strong><span class="cell-sub">${esc(t.customer_email)}</span></span>
      <span class="chat-thread-meta">${t.admin_unread ? '<span class="badge badge-new">new</span>' : t.last_sender === "admin" ? '<span class="cell-sub">replied</span>' : ""}<span class="cell-sub">${dateTime(t.last_message_at)}</span>${t.blocked ? '<span class="badge badge-bad">blocked</span>' : ""}</span>
    </button>`).join("")
    : `<p class="muted chat-none">${chat.threads.length ? "No conversations match." : "No conversations yet. Customers start one from the chat box on the website."}</p>`;
}

async function openThread(id, { keepScroll = false } = {}) {
  const thread = chat.threads.find((t) => t.id === id);
  if (!thread) return;
  chat.current = id;
  $(".chat-admin").classList.add("has-current");
  renderThreads();
  chat.messages = await run(db.from("chat_messages").select("*").eq("thread_id", id).order("created_at").limit(500));
  const box = $("#chat-conversation");
  box.innerHTML = `
    <header class="chat-conv-head">
      <button class="btn btn-small chat-back" type="button">← All</button>
      <div class="grow"><strong>${esc(thread.customer_name || "Customer")}</strong><span class="cell-sub">${esc(thread.customer_email)} · started ${dateOnly(thread.created_at)}</span></div>
      <div class="contact-actions">
        ${thread.customer_email ? `<button class="btn btn-small" type="button" data-chat-orders="${esc(thread.customer_email)}">Orders</button>` : ""}
        <button class="btn btn-small" type="button" data-chat-status="${thread.status === "open" ? "closed" : "open"}">${thread.status === "open" ? "Close" : "Reopen"}</button>
        <button class="btn btn-small" type="button" data-chat-block="${thread.blocked ? "false" : "true"}">${thread.blocked ? "Unblock" : "Block"}</button>
        <button class="btn btn-small btn-danger" type="button" data-chat-delete>Delete</button>
      </div>
    </header>
    <ol class="admin-chat-messages"></ol>
    <form class="admin-chat-form" id="chat-reply-form">
      <textarea name="reply" rows="3" maxlength="2000" placeholder="Write a reply… (Ctrl+Enter to send)" required aria-label="Reply"></textarea>
      <div class="admin-chat-actions"><span class="cell-sub">The customer sees your reply in the chat box${thread.customer_email ? " and gets an email" : ""}.</span><button class="btn btn-primary" type="submit">Send reply</button></div>
    </form>`;
  renderChatMessages(keepScroll);
  if (thread.admin_unread) {
    thread.admin_unread = false;
    db.from("chat_threads").update({ admin_unread: false }).eq("id", id).then(() => { renderThreads(); refreshBadges(); });
  }
}

function renderChatMessages() {
  const list = $(".admin-chat-messages");
  if (!list) return;
  list.replaceChildren(...chat.messages.map((m) => {
    const item = document.createElement("li");
    item.className = `admin-chat-message from-${m.sender}`;
    const text = document.createElement("p");
    text.textContent = m.body;
    const stamp = document.createElement("small");
    stamp.textContent = `${m.sender === "admin" ? "You" : "Customer"} · ${dateTime(m.created_at)}`;
    item.append(text, stamp);
    return item;
  }));
  list.scrollTop = list.scrollHeight;
}

async function sendChatReply(form) {
  const body = form.reply.value.trim();
  if (!body) return;
  const { data } = await db.auth.getSession();
  let result;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/shop/chat-reply`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${data.session?.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: chat.current, body })
  }).catch(() => null);
  if (response?.ok) {
    result = await response.json();
  } else if (response && response.status < 500 && response.status !== 404) {
    throw new Error((await response.json().catch(() => ({}))).error || `Reply failed (${response.status})`);
  } else {
    // Server function unreachable: save the reply directly (no email to the customer).
    result = await run(db.rpc("admin_chat_reply", { p_thread_id: chat.current, p_body: body }));
    result.emailed = false;
  }
  form.reply.value = "";
  if (!chat.messages.some((m) => m.id === result.message.id)) chat.messages.push(result.message);
  renderChatMessages();
  const thread = chat.threads.find((t) => t.id === chat.current);
  if (thread) Object.assign(thread, { last_sender: "admin", last_message_at: result.message.created_at || new Date().toISOString(), admin_unread: false });
  renderThreads();
  toast(result.emailed ? "Reply sent and emailed" : "Reply sent");
}

function subscribeToChat() {
  if (chat.channel) return;
  chat.channel = db.channel("admin-chat")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, async (payload) => {
      const message = payload.new;
      if (message.sender === "customer") refreshBadges();
      if ($("[data-section=chat]").hidden) return;
      if (message.thread_id === chat.current && !chat.messages.some((m) => m.id === message.id)) {
        chat.messages.push(message);
        renderChatMessages();
      }
      chat.threads = await run(db.from("chat_threads").select("*").order("last_message_at", { ascending: false }).limit(500)).catch(() => chat.threads);
      if (message.thread_id === chat.current && message.sender === "customer") {
        db.from("chat_threads").update({ admin_unread: false }).eq("id", chat.current).then(() => refreshBadges());
        const current = chat.threads.find((t) => t.id === chat.current);
        if (current) current.admin_unread = false;
      }
      renderThreads();
    })
    .subscribe();
}

function setupChat() {
  $("#chat-filter").addEventListener("change", renderThreads);
  $("#chat-threads").addEventListener("click", (event) => {
    const button = event.target.closest("[data-thread]");
    if (button) openThread(button.dataset.thread).catch((error) => toast(error.message, true));
  });
  const box = $("#chat-conversation");
  box.addEventListener("submit", (event) => {
    if (event.target.id !== "chat-reply-form") return;
    event.preventDefault();
    withBusy($("button[type=submit]", event.target), () => sendChatReply(event.target));
  });
  box.addEventListener("keydown", (event) => {
    if (event.target.name === "reply" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.target.form.requestSubmit();
  });
  box.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !chat.current) return;
    if (button.classList.contains("chat-back")) { chat.current = null; $(".chat-admin").classList.remove("has-current"); renderThreads(); return; }
    if (button.dataset.chatOrders) { $("#orders-search").value = button.dataset.chatOrders; $("#orders-status").value = ""; $("#orders-payment").value = ""; window.location.hash = "orders"; return; }
    const update = button.dataset.chatStatus ? { status: button.dataset.chatStatus } : button.dataset.chatBlock ? { blocked: button.dataset.chatBlock === "true" } : null;
    if (update) {
      if (update.blocked && !window.confirm("Block this customer from sending more chat messages?")) return;
      withBusy(button, async () => { await run(db.from("chat_threads").update(update).eq("id", chat.current)); await loadChat(); });
      return;
    }
    if (button.hasAttribute("data-chat-delete")) {
      if (!window.confirm("Delete this whole conversation? This cannot be undone.")) return;
      withBusy(button, async () => {
        await run(db.from("chat_threads").delete().eq("id", chat.current));
        chat.current = null;
        $(".chat-admin").classList.remove("has-current");
        $("#chat-conversation").innerHTML = '<p class="muted">Choose a conversation.</p>';
        await loadChat();
        refreshBadges();
      });
    }
  });
}

// ─── Content ────────────────────────────────────────────────────────────────

async function loadContent() {
  const [settings, posts] = await Promise.all([
    run(db.from("site_settings").select("key,value")),
    run(db.from("posts").select("*").order("sort_order").order("created_at", { ascending: false }))
  ]);
  state.settings = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  state.posts = posts;
  const form = $("#settings-form");
  form.announcement.value = state.settings.announcement || "";
  form.catalog_note.value = state.settings.catalog_note || "";
  form.checkout_mode.value = state.settings.checkout_mode === "razorpay" ? "razorpay" : "whatsapp";
  form.chat_enabled.value = state.settings.chat_enabled === "true" ? "true" : "false";
  $("#posts-table").innerHTML = `<thead><tr><th>Guide</th><th class="hide-sm">Updated</th><th>Status</th></tr></thead><tbody>${
    posts.length ? posts.map((p) => `<tr class="clickable" data-post="${esc(p.id)}" tabindex="0"><td><strong>${esc(p.title)}</strong><span class="cell-sub">${esc(p.meta_line || p.slug)}</span></td><td class="hide-sm">${dateOnly(p.updated_at)}</td><td>${p.is_published ? '<span class="badge badge-ok">published</span>' : '<span class="badge">draft</span>'}</td></tr>`).join("")
    : emptyRow(3, "No guides yet. The home page keeps showing its built-in guide cards until you publish one.")}</tbody>`;
}

let editingPost = null;
function openPost(id) {
  editingPost = id ? state.posts.find((p) => p.id === id) : null;
  const p = editingPost || { sort_order: 0, is_published: false };
  const form = $("#post-form");
  form.reset();
  ["title", "slug", "meta_line", "image", "excerpt", "body", "sort_order"].forEach((field) => { form[field].value = p[field] ?? ""; });
  form.is_published.checked = Boolean(p.is_published);
  delete form.slug.dataset.touched;
  $("#post-delete").hidden = !editingPost;
  $(".form-status", form).textContent = "";
  setPreview(form);
  $("#post-dialog").showModal();
}

function setupContent() {
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy($("button[type=submit]", form), async () => {
      await run(db.from("site_settings").upsert([
        { key: "announcement", value: form.announcement.value.trim() },
        { key: "catalog_note", value: form.catalog_note.value.trim() },
        { key: "checkout_mode", value: form.checkout_mode.value },
        { key: "chat_enabled", value: form.chat_enabled.value }
      ]));
      toast("Site text saved");
    });
  });

  $("#posts-add").addEventListener("click", () => openPost(null));
  const table = $("#posts-table");
  table.addEventListener("click", (event) => { const row = event.target.closest("[data-post]"); if (row) openPost(row.dataset.post); });
  table.addEventListener("keydown", (event) => { const row = event.target.closest("[data-post]"); if (row && event.key === "Enter") openPost(row.dataset.post); });

  const form = $("#post-form");
  form.title.addEventListener("input", () => { if (!editingPost && !form.slug.dataset.touched) form.slug.value = slugify(form.title.value).slice(0, 80); });
  form.slug.addEventListener("input", () => { form.slug.dataset.touched = "1"; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy($("button[type=submit]", form), async () => {
      const record = {
        title: form.title.value.trim(), slug: form.slug.value.trim(), meta_line: form.meta_line.value.trim(), image: form.image.value.trim(),
        excerpt: form.excerpt.value.trim(), body: form.body.value, sort_order: Math.round(Number(form.sort_order.value)) || 0, is_published: form.is_published.checked
      };
      if (record.is_published && !editingPost?.published_at) record.published_at = new Date().toISOString();
      if (editingPost) await run(db.from("posts").update(record).eq("id", editingPost.id));
      else await run(db.from("posts").insert(record));
      $("#post-dialog").close();
      toast("Guide saved");
      await loadContent();
    });
  });
  $("#post-delete").addEventListener("click", (event) => {
    if (!editingPost || !window.confirm(`Delete “${editingPost.title}”?`)) return;
    withBusy(event.currentTarget, async () => {
      await run(db.from("posts").delete().eq("id", editingPost.id));
      $("#post-dialog").close();
      toast("Guide deleted");
      await loadContent();
    });
  });
}

// ─── SEO ────────────────────────────────────────────────────────────────────

async function loadSeo() {
  state.seo = await run(db.from("page_seo").select("*"));
  $("#seo-pages").innerHTML = SEO_PAGES.map(({ path, label }) => {
    const row = state.seo.find((r) => r.path === path) || { title: "", description: "" };
    return `<form class="seo-row" data-seo="${path}">
      <strong>${esc(label)}<span class="cell-sub">${esc(path)}</span></strong>
      <label>Title <span class="count" data-count="60"></span><input name="title" maxlength="120" value="${esc(row.title)}"></label>
      <label>Description <span class="count" data-count="160"></span><textarea name="description" rows="2" maxlength="320">${esc(row.description)}</textarea></label>
      <button class="btn" type="submit">Save</button></form>`;
  }).join("") + '<p class="hint">Product pages use each product’s own name and description automatically. Journal guides use their summary.</p>';
  $$("#seo-pages .seo-row").forEach(updateCounts);
}

function updateCounts(form) {
  $$("[data-count]", form).forEach((counter) => {
    const field = counter.parentElement.querySelector("input, textarea");
    const limit = Number(counter.dataset.count);
    counter.textContent = `${field.value.length}/${limit}`;
    counter.classList.toggle("over", field.value.length > limit || field.value.length === 0);
  });
}

function pageUrl(path) {
  return new URL(path, new URL("../", window.location.href)).href;
}

function checkImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(false), 15000);
    image.onload = () => { clearTimeout(timer); resolve(true); };
    image.onerror = () => { clearTimeout(timer); resolve(false); };
    image.src = src;
  });
}

async function runSeoAudit(button) {
  const report = $("#seo-report");
  report.innerHTML = '<p class="muted">Checking pages…</p>';
  const issues = [];
  const passes = [];
  const add = (level, text) => (level === "ok" ? passes : issues).push([level, text]);
  const [products, posts, seoRows] = await Promise.all([
    run(db.from("products").select("id,name,image,description,is_active").eq("is_active", true)),
    run(db.from("posts").select("slug,title,image,excerpt").eq("is_published", true)),
    run(db.from("page_seo").select("*"))
  ]);
  const seoFor = (path) => seoRows.find((r) => r.path === path) || {};
  const linkTargets = new Set();
  const images = new Set();

  for (const { path, label } of SEO_PAGES) {
    let doc;
    try {
      const response = await fetch(pageUrl(path), { cache: "no-store" });
      if (!response.ok) { add("bad", `${label}: page returned HTTP ${response.status}`); continue; }
      doc = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch { add("bad", `${label}: page could not be loaded`); continue; }
    const title = seoFor(path).title || doc.title;
    const description = seoFor(path).description || doc.querySelector('meta[name="description"]')?.content || "";
    if (!title) add("bad", `${label}: missing page title`);
    else if (title.length > 60) add("warn", `${label}: title is ${title.length} characters (aim for 60 or fewer)`);
    else add("ok", `${label}: title looks good`);
    if (!description) add("bad", `${label}: missing search description`);
    else if (description.length > 160) add("warn", `${label}: description is ${description.length} characters (aim for 160 or fewer)`);
    else if (description.length < 50) add("warn", `${label}: description is short (${description.length} characters)`);
    else add("ok", `${label}: description looks good`);
    const h1Count = doc.querySelectorAll("h1").length;
    if (h1Count !== 1 && path !== "journal.html") add("warn", `${label}: has ${h1Count} main headings (h1); one is best`);
    const noAlt = [...doc.querySelectorAll("img")].filter((img) => !img.hasAttribute("alt")).length;
    if (noAlt) add("warn", `${label}: ${noAlt} image${noAlt > 1 ? "s" : ""} missing alt text`);
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href");
      if (!href || /^(#|mailto:|tel:|javascript:|https?:)/i.test(href)) return;
      linkTargets.add(new URL(href, pageUrl(path)).href.split("#")[0]);
    });
    doc.querySelectorAll("img[src]").forEach((img) => { if (img.getAttribute("src")) images.add(new URL(img.getAttribute("src"), pageUrl(path)).href); });
  }

  products.forEach((p) => {
    if (!p.description || p.description.length < 50) add("warn", `Product “${p.name}”: description is missing or very short`);
    if (!p.image) add("warn", `Product “${p.name}”: no image`);
    else images.add(resolveImage(p.image));
  });
  posts.forEach((p) => {
    if (!p.excerpt) add("warn", `Guide “${p.title}”: add a short summary (used as its search description)`);
    if (p.image) images.add(resolveImage(p.image));
  });

  const linkResults = await Promise.all([...linkTargets].map(async (url) => {
    try { const r = await fetch(url, { method: "HEAD", cache: "no-store" }); return [url, r.ok]; } catch { return [url, false]; }
  }));
  const brokenLinks = linkResults.filter(([, ok]) => !ok);
  brokenLinks.forEach(([url]) => add("bad", `Broken link: ${url}`));
  if (!brokenLinks.length) add("ok", `All ${linkResults.length} internal links work`);

  const imageResults = await Promise.all([...images].map(async (src) => [src, await checkImage(src)]));
  const brokenImages = imageResults.filter(([, ok]) => !ok);
  brokenImages.forEach(([src]) => add("bad", `Image does not load: ${src}`));
  if (!brokenImages.length) add("ok", `All ${imageResults.length} images load`);

  const label = { bad: "fix", warn: "improve", ok: "ok" };
  const level = { bad: "bad", warn: "warn", ok: "ok" };
  report.innerHTML = `<p><strong>${issues.filter(([l]) => l === "bad").length}</strong> to fix · <strong>${issues.filter(([l]) => l === "warn").length}</strong> to improve · <strong>${passes.length}</strong> passed</p>`
    + [...issues, ...passes].map(([l, text]) => `<div class="report-item"><span class="badge badge-${level[l]}">${label[l]}</span><span>${esc(text)}</span></div>`).join("");
  button.disabled = false;
}

async function buildSitemap() {
  const [products, posts] = await Promise.all([
    run(db.from("products").select("id,updated_at").eq("is_active", true)),
    run(db.from("posts").select("slug,updated_at").eq("is_published", true))
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    [SITE_URL, today], [`${SITE_URL}policies.html`, today], [`${SITE_URL}journal.html`, today],
    ...products.map((p) => [`${SITE_URL}product.html?product=${encodeURIComponent(p.id)}`, p.updated_at.slice(0, 10)]),
    ...posts.map((p) => [`${SITE_URL}journal.html?post=${encodeURIComponent(p.slug)}`, p.updated_at.slice(0, 10)])
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    entries.map(([loc, lastmod]) => `  <url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  const output = $("#sitemap-output");
  output.value = xml;
  output.hidden = false;
  $("#sitemap-download").hidden = false;
}

function setupSeo() {
  $("#seo-pages").addEventListener("input", (event) => { const form = event.target.closest(".seo-row"); if (form) updateCounts(form); });
  $("#seo-pages").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target.closest(".seo-row");
    withBusy($("button", form), async () => {
      await run(db.from("page_seo").upsert({ path: form.dataset.seo, title: form.title.value.trim(), description: form.description.value.trim() }));
      toast("Saved");
    });
  });
  $("#seo-audit").addEventListener("click", (event) => { const button = event.currentTarget; button.disabled = true; runSeoAudit(button).catch((error) => { button.disabled = false; toast(error.message, true); }); });
  $("#sitemap-build").addEventListener("click", (event) => withBusy(event.currentTarget, buildSitemap));
  $("#sitemap-download").addEventListener("click", () => downloadFile("sitemap.xml", $("#sitemap-output").value, "application/xml"));
}

// ─── Analytics ──────────────────────────────────────────────────────────────

function rankList(entries, emptyText) {
  if (!entries.length) return `<p class="muted">${esc(emptyText)}</p>`;
  const max = entries[0][1];
  return entries.slice(0, 10).map(([name, value]) => `<div class="rank-row"><span>${esc(name)}</span><strong>${number(value)}</strong><span class="meter"><i data-width="${Math.max(2, Math.round((value / max) * 100))}"></i></span></div>`).join("");
}

function applyWidths(root) {
  $$("[data-width]", root).forEach((node) => { node.style.width = `${node.dataset.width}%`; });
  $$("[data-height]", root).forEach((node) => { node.style.height = `${node.dataset.height}%`; });
}

async function loadAnalytics() {
  const days = Number($("#analytics-range").value);
  const start = new Date(Date.now() - (days - 1) * 86400000);
  const startDay = istDay(start);
  const [rows, orders] = await Promise.all([
    run(db.from("page_views_daily").select("*").gte("day", startDay).limit(20000)),
    run(db.from("orders").select("status,payment_status,subtotal,created_at").gte("created_at", start.toISOString()).not("payment_status", "in", "(pending,failed)"))
  ]);
  const sum = (list) => list.reduce((total, row) => total + row.views, 0);
  const group = (list, key) => Object.entries(list.reduce((acc, row) => { const k = key(row); if (k) acc[k] = (acc[k] || 0) + row.views; return acc; }, {})).sort((a, b) => b[1] - a[1]);
  const total = sum(rows);
  const productViews = sum(rows.filter((r) => r.path.startsWith("product")));
  const sales = orders.filter(isSale);
  $("#analytics-stats").innerHTML = [
    ["Page views", number(total)], ["Plant page views", number(productViews)],
    ["Order requests", number(orders.length)], ["Confirmed sales", money(sales.reduce((s, o) => s + o.subtotal, 0))],
    ["Views per order", orders.length ? number(Math.round(total / orders.length)) : "—"]
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");

  const byDay = Object.fromEntries(group(rows, (r) => r.day));
  const dayList = Array.from({ length: days }, (_, i) => istDay(new Date(start.getTime() + i * 86400000)));
  const maxDay = Math.max(1, ...dayList.map((d) => byDay[d] || 0));
  $("#analytics-daily").innerHTML = dayList.map((d) => `<span class="bar" data-height="${Math.max(1, Math.round(((byDay[d] || 0) / maxDay) * 100))}" title="${dateOnly(d)}: ${number(byDay[d] || 0)} views"></span>`).join("");
  $("#analytics-axis").innerHTML = `<span>${dateOnly(dayList[0])}</span><span>${dateOnly(dayList[dayList.length - 1])}</span>`;

  const pageNames = { index: "Home page", policies: "Delivery & promise", journal: "Journal" };
  $("#analytics-pages").innerHTML = rankList(group(rows, (r) => pageNames[r.path] || (r.path.startsWith("product") ? "Plant pages" : r.path)), "No views yet.");
  const productNames = Object.fromEntries((state.products.length ? state.products : await run(db.from("products").select("id,name"))).map((p) => [p.id, p.name]));
  $("#analytics-products").innerHTML = rankList(group(rows.filter((r) => r.path.startsWith("product/")), (r) => productNames[r.path.slice(8)] || r.path.slice(8)), "No plant page views yet.");
  $("#analytics-referrers").innerHTML = rankList(group(rows, (r) => r.referrer || "Direct / unknown"), "No visits yet.");
  applyWidths($("[data-section=analytics]"));
}

// ─── Uptime ─────────────────────────────────────────────────────────────────

async function timed(task) {
  const start = performance.now();
  try { const ok = await task(); return { ok, ms: Math.round(performance.now() - start) }; }
  catch { return { ok: false, ms: Math.round(performance.now() - start) }; }
}

async function loadUptime() {
  await Promise.all([checkLive(), loadUptimeRuns()]);
}

async function checkLive() {
  $("#uptime-live").innerHTML = '<div class="stat"><span>Checking…</span><strong>…</strong></div>';
  const [site, database] = await Promise.all([
    timed(async () => { await fetch(SITE_URL, { mode: "no-cors", cache: "no-store" }); return true; }),
    timed(async () => (await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY }, cache: "no-store" })).ok)
  ]);
  const card = (label, result, note) => `<div class="stat ${result.ok ? "is-ok" : "is-bad"}"><span>${label}</span><strong>${result.ok ? "Online" : "Down"}</strong><small>${result.ok ? `${result.ms} ms · ` : ""}${esc(note)}</small></div>`;
  $("#uptime-live").innerHTML = card("Website", site, SITE_URL.replace(/^https?:\/\//, "")) + card("Database", database, "Supabase")
    + `<div class="stat"><span>Checked</span><strong>${new Date().toLocaleTimeString("en-IN", { timeStyle: "short" })}</strong><small>from this browser</small></div>`;
}

async function loadUptimeRuns() {
  const target = $("#uptime-runs");
  if (!config.githubRepo) { target.innerHTML = '<p class="muted">Add githubRepo to site-config.js to see scheduled checks.</p>'; return; }
  try {
    const response = await fetch(`https://api.github.com/repos/${config.githubRepo}/actions/workflows/uptime.yml/runs?per_page=12`, { headers: { Accept: "application/vnd.github+json" } });
    if (response.status === 404) { target.innerHTML = '<p class="muted">The hourly check starts once <code>.github/workflows/uptime.yml</code> is on the main branch.</p>'; return; }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const runs = (await response.json()).workflow_runs || [];
    if (!runs.length) { target.innerHTML = '<p class="muted">No checks have run yet. The first one starts within the hour.</p>'; return; }
    const pending = (r) => r.status !== "completed";
    target.innerHTML = `<div class="mini-list">${runs.map((r) => {
      const level = pending(r) ? "warn" : r.conclusion === "success" ? "ok" : "bad";
      const text = pending(r) ? "running" : r.conclusion === "success" ? "passed" : r.conclusion || "failed";
      return `<a class="mini-row" href="${esc(r.html_url)}" target="_blank" rel="noopener noreferrer"><span class="grow">${dateTime(r.run_started_at || r.created_at)}</span><span class="badge badge-${level}">${esc(text)}</span></a>`;
    }).join("")}</div>`;
  } catch (error) {
    target.innerHTML = `<p class="muted">Could not load scheduled checks: ${esc(error.message)}</p>`;
  }
}

// ─── Team ───────────────────────────────────────────────────────────────────

async function loadTeam() {
  const admins = await run(db.from("admin_users").select("*").order("created_at"));
  $("#team-list").innerHTML = `<div class="mini-list">${admins.map((a) => `<div class="mini-row"><span class="grow"><strong>${esc(a.email)}</strong>${a.user_id === currentUser.id ? " (you)" : ""}<span class="cell-sub">Added ${dateOnly(a.created_at)}</span></span>${admins.length > 1 ? `<button class="btn btn-small btn-danger" type="button" data-remove-admin="${esc(a.user_id)}">Remove</button>` : ""}</div>`).join("")}</div>`;
}

function setupTeam() {
  $("#team-add").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy($("button", form), async () => {
      await run(db.rpc("add_admin_by_email", { p_email: form.email.value.trim() }));
      form.reset();
      toast("Admin added");
      await loadTeam();
    });
  });
  $("#team-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-admin]");
    if (!button || !window.confirm("Remove this person's admin access?")) return;
    withBusy(button, async () => {
      await run(db.rpc("remove_admin", { p_user_id: button.dataset.removeAdmin }));
      toast("Admin removed");
      if (button.dataset.removeAdmin === currentUser.id) { await db.auth.signOut(); return; }
      await loadTeam();
    });
  });
  $("#password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy($("button", form), async () => {
      const { error } = await db.auth.updateUser({ password: form.password.value });
      if (error) throw new Error(error.message);
      form.reset();
      toast("Password updated");
    });
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

function setupDialogs() {
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) event.target.closest("dialog")?.close();
  });
}

function start() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { showOnly("setup-view"); return; }
  if (!window.supabase?.createClient) { showOnly("setup-view"); $("#setup-view p").textContent = "The Supabase library could not be loaded. Check your internet connection and reload the page."; return; }
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

  setupAuthForms();
  setupDialogs();
  setupOrders();
  setupProducts();
  setupImageFields();
  setupCustomers();
  setupMessages();
  setupChat();
  setupReviews();
  setupContent();
  setupSeo();
  setupTeam();
  $("#analytics-range").addEventListener("change", () => loadAnalytics().catch((error) => toast(error.message, true)));
  $("#uptime-check").addEventListener("click", (event) => withBusy(event.currentTarget, checkLive));
  document.addEventListener("click", (event) => { if (event.target.closest('[data-action="refresh"]')) route(); });
  window.addEventListener("hashchange", route);

  db.auth.onAuthStateChange((event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") recoveryMode = true;
      if (recoveryMode && session) { showOnly("reset-view"); return; }
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      handleSession(session);
    }, 0);
  });
}

start();

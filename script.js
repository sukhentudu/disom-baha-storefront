const WHATSAPP_NUMBER = "918348938263";
const CART_STORAGE_KEY = "disom-baha-cart-v1";
const DEFAULT_POT_COLORS = ["Sage green", "Warm white", "Terracotta"];
const SITE_CONFIG = window.DISOM_BAHA_CONFIG || {};
const SUPABASE_URL = String(SITE_CONFIG.supabaseUrl || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = String(SITE_CONFIG.supabaseAnonKey || "").trim();
const supabaseReady = Boolean(SUPABASE_URL && SUPABASE_KEY);
let catalog = window.DISOM_BAHA_CATALOG || {};
let siteSettings = {};
// "whatsapp": order requests are sent to the concierge on WhatsApp.
// "razorpay": customers pay online (chosen in the admin panel under Content).
let checkoutMode = "whatsapp";
const LAST_ORDER_KEY = "disom-baha-last-order";
let selectedCategory = "";
let pendingOrder = null;

const cart = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");
  if (Array.isArray(saved)) {
    saved.forEach(([key, line]) => {
      if (typeof line?.id === "string" && Number.isInteger(line.quantity) && line.quantity > 0) cart.set(key, line);
    });
  }
} catch { /* A fresh bag is fine when local storage is unavailable. */ }

// Public, read-only Supabase requests. The anon key can only do what the
// database rules in supabase/schema.sql allow.
async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) {
    let message = "";
    try { message = (await response.json()).message || ""; } catch { /* No JSON body. */ }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function supabaseRpc(name, body) {
  return supabaseRequest(`rpc/${name}`, { method: "POST", body: JSON.stringify(body), keepalive: true });
}

// Calls the "shop" server function (payments, contact form emails).
async function callShop(route, body) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/shop/${route}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
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

const cartDrawer = document.querySelector(".cart-drawer");
const cartScrim = document.querySelector(".drawer-scrim");
const toast = document.querySelector(".toast");
let toastTimer;

const formatPrice = (amount) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 0
}).format(amount);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function announce(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function persistCart() {
  try { localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([...cart.entries()])); }
  catch { announce("Your bag is available for this visit but could not be saved on this device."); }
}

function cartTotals() {
  const count = [...cart.values()].reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = [...cart.values()].reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  return { count, subtotal };
}

function updateCart() {
  const { count, subtotal } = cartTotals();
  const badge = document.querySelector(".cart-count");
  const drawerCount = document.querySelector(".drawer-count");
  const subtotalNode = document.querySelector(".cart-subtotal strong");
  const continueButton = document.querySelector(".checkout-button");
  const container = document.querySelector(".cart-items");
  if (badge) badge.textContent = count;
  if (drawerCount) drawerCount.textContent = `(${count})`;
  if (subtotalNode) subtotalNode.textContent = formatPrice(subtotal);
  if (continueButton) continueButton.disabled = count === 0;
  if (!container) return;

  if (count === 0) {
    container.innerHTML = '<p class="empty-cart">Your bag is waiting for a little green.</p>';
    persistCart();
    return;
  }

  container.innerHTML = [...cart.entries()].map(([key, line]) => {
    const product = catalog[line.id];
    return `<article class="cart-line">
      <img src="${escapeHtml(product.image)}" alt="${product.isDemo ? "Demo image of" : "Image of"} ${escapeHtml(product.name)}">
      <div class="cart-line-copy"><h3>${escapeHtml(product.name)}</h3><small>${escapeHtml(product.botanical)}</small>
        <small class="cart-variant">${escapeHtml(line.size)} · ${escapeHtml(line.color)}</small>
        <div class="quantity-control" aria-label="Quantity for ${escapeHtml(product.name)}">
          <button type="button" data-change="${encodeURIComponent(key)}" data-delta="-1" aria-label="Remove one ${escapeHtml(product.name)}">−</button>
          <span>${line.quantity}</span>
          <button type="button" data-change="${encodeURIComponent(key)}" data-delta="1" aria-label="Add one ${escapeHtml(product.name)}">+</button>
        </div>
      </div>
      <span class="cart-line-price">${formatPrice(line.unitPrice * line.quantity)}</span>
    </article>`;
  }).join("");
  persistCart();
}

function showCartStage(stage) {
  const stages = {
    bag: [".cart-items", ".cart-stage"],
    address: [".address-stage"],
    review: [".order-review-stage"],
    success: [".order-success-stage"]
  };
  [".cart-items", ".cart-stage", ".address-stage", ".order-review-stage", ".order-success-stage"].forEach((selector) => {
    const element = document.querySelector(selector);
    if (element) element.hidden = !stages[stage]?.includes(selector);
  });
  document.querySelector(".cart-drawer")?.scrollTo(0, 0);
}

function openCart() {
  if (!cartDrawer || !cartScrim) return;
  showCartStage("bag");
  cartScrim.hidden = false;
  requestAnimationFrame(() => cartDrawer.classList.add("is-open"));
  cartDrawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  document.querySelector(".drawer-close")?.focus();
}

function closeCart() {
  if (!cartDrawer || !cartScrim) return;
  cartDrawer.classList.remove("is-open");
  cartDrawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  setTimeout(() => { if (!cartDrawer.classList.contains("is-open")) cartScrim.hidden = true; }, 300);
}

function addProductToCart(id, size, sizeExtra, color) {
  const product = catalog[id];
  if (!product) return;
  const currentCount = [...cart.values()].filter((line) => line.id === id).reduce((sum, line) => sum + line.quantity, 0);
  if (product.stock !== null && product.stock !== "" && Number.isFinite(Number(product.stock)) && currentCount >= Number(product.stock)) {
    announce("Demo stock limit reached. Ask the concierge about availability.");
    return;
  }
  const unitPrice = Number(product.price) + sizeExtra;
  const key = `${id}|${size}|${color}`;
  const existing = cart.get(key);
  cart.set(key, { id, quantity: (existing?.quantity || 0) + 1, size, color, unitPrice });
  updateCart();
  announce(`${product.name} added to your bag`);
  openCart();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((part) => part.trim() !== "")) rows.push(row);
      row = [];
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function catalogFromCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return null;
  const headers = rows.shift().map((name) => name.trim().toLowerCase());
  const index = (name) => headers.indexOf(name);
  const value = (row, name) => row[index(name)]?.trim() || "";
  const parsed = {};
  rows.forEach((row) => {
    const id = value(row, "id");
    const name = value(row, "name");
    if (!id || !name) return;
    const sizeOptions = value(row, "sizeoptions").split("|").filter(Boolean).map((option) => {
      const split = option.lastIndexOf(":");
      return { label: split < 0 ? option : option.slice(0, split), extra: split < 0 ? 0 : Number(option.slice(split + 1)) || 0 };
    });
    parsed[id] = {
      name, botanical: value(row, "botanical"), price: Number(value(row, "price")) || 0,
      image: value(row, "image"), tag: value(row, "tag"),
      light: value(row, "light"), lightFilter: value(row, "lightfilter"), water: value(row, "water"), waterFilter: value(row, "waterfilter"), humidity: value(row, "humidity"),
      sizeOptions, height: value(row, "height"), potDiameter: value(row, "potdiameter"), includes: value(row, "includes"), stock: value(row, "stock") === "" ? null : Number(value(row, "stock")),
      categories: value(row, "categories").split(/[|;]/).map((item) => item.trim()).filter(Boolean),
      description: value(row, "description"), review: value(row, "review"), reviewBy: value(row, "reviewby"), isDemo: value(row, "isdemo").toLowerCase() === "true"
    };
  });
  return Object.keys(parsed).length ? parsed : null;
}

function catalogFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return Object.fromEntries(rows.map((row) => [row.id, {
    name: row.name, botanical: row.botanical, price: Number(row.price) || 0, image: row.image, tag: row.tag, isDemo: Boolean(row.is_demo),
    light: row.light, lightFilter: row.light_filter, water: row.water, waterFilter: row.water_filter, humidity: row.humidity,
    sizeOptions: Array.isArray(row.size_options) ? row.size_options.map((option) => ({ label: String(option?.label ?? ""), extra: Number(option?.extra) || 0 })) : [],
    potColors: Array.isArray(row.pot_colors) ? row.pot_colors : [],
    height: row.height, potDiameter: row.pot_diameter, includes: row.includes, stock: row.stock,
    categories: Array.isArray(row.categories) ? row.categories : [],
    description: row.description, review: row.review, reviewBy: row.review_by
  }]));
}

// Drop bag lines whose product no longer exists and refresh prices from the
// catalog that actually loaded.
function reconcileCart() {
  for (const [key, line] of cart.entries()) {
    const product = catalog[line.id];
    if (!product) { cart.delete(key); continue; }
    const sizeExtra = (product.sizeOptions || []).find((option) => option.label === line.size)?.extra || 0;
    cart.set(key, { ...line, unitPrice: Number(product.price) + Number(sizeExtra) });
  }
}

function setCatalogNote(text) {
  const note = document.querySelector(".catalog-note");
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

async function loadCatalogSource() {
  if (supabaseReady) {
    try {
      const liveCatalog = catalogFromRows(await supabaseRequest("products?select=*&is_active=eq.true&order=sort_order.asc,name.asc"));
      if (liveCatalog) {
        catalog = liveCatalog;
        const hasDemo = Object.values(catalog).some((product) => product.isDemo);
        setCatalogNote(siteSettings.catalog_note || (hasDemo ? "Some plants still show demo photos, prices, or stock." : ""));
        return;
      }
    } catch { /* Fall back to the sheet or the demo catalog below. */ }
  }
  const sheetUrl = window.DISOM_BAHA_SHEET_CSV_URL;
  if (!sheetUrl) return;
  try {
    const response = await fetch(sheetUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Catalog sheet could not be loaded");
    const sheetCatalog = catalogFromCsv(await response.text());
    if (!sheetCatalog) throw new Error("Catalog sheet has no product rows");
    catalog = sheetCatalog;
    setCatalogNote("Live catalog loaded from the Disom Baha product sheet.");
  } catch {
    setCatalogNote("Showing the demo catalog. The product sheet could not be loaded.");
  }
}

// ─── Content managed in the admin panel ─────────────────────────────────────

function currentPageFile() {
  const file = window.location.pathname.split("/").pop() || "index.html";
  return /^[a-z0-9-]+\.html$/.test(file) ? file : "index.html";
}

function setMetaDescription(text) {
  if (!text) return;
  let meta = document.querySelector('meta[name="description"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "description";
    document.head.append(meta);
  }
  meta.content = text;
}

async function loadSiteContent() {
  if (!supabaseReady) return;
  const page = currentPageFile();
  try {
    const [settings, seo] = await Promise.all([
      supabaseRequest("site_settings?select=key,value"),
      supabaseRequest(`page_seo?select=title,description&path=eq.${encodeURIComponent(page)}`)
    ]);
    siteSettings = Object.fromEntries((settings || []).map((row) => [row.key, row.value]));
    if (seo?.[0]?.title) document.title = seo[0].title;
    setMetaDescription(seo?.[0]?.description);
  } catch { return; }

  const parts = String(siteSettings.announcement || "").split("|").map((part) => part.trim()).filter(Boolean);
  const bar = document.querySelector(".announcement");
  if (bar && parts.length) {
    bar.replaceChildren(...parts.flatMap((part, index) => {
      const span = document.createElement("span");
      span.textContent = part;
      if (index === 0) return [span];
      const dot = document.createElement("span");
      dot.className = "announcement-dot";
      dot.textContent = "✳";
      return [dot, span];
    }));
  }
}

function postCardMarkup(post) {
  return `<a href="journal.html?post=${encodeURIComponent(post.slug)}" class="journal-card">
    ${post.image ? `<img src="${escapeHtml(post.image)}" alt="" loading="lazy">` : ""}
    <span class="journal-meta">${escapeHtml(post.meta_line || "Plant care")}</span><h3>${escapeHtml(post.title)}</h3>
    <span class="journal-arrow">Read the guide ↗</span></a>`;
}

// Turns a post's plain-text body into paragraphs. Lines starting with "## "
// become headings. Text is never parsed as HTML.
function renderPostBody(container, body) {
  container.replaceChildren(...String(body || "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
    const heading = block.startsWith("## ");
    const element = document.createElement(heading ? "h2" : "p");
    element.textContent = heading ? block.slice(3) : block;
    return element;
  }));
}

async function loadJournal() {
  const homeGrid = document.querySelector(".journal-section .journal-grid");
  const journalRoot = document.querySelector("#journal-page");
  if (!homeGrid && !journalRoot) return;
  let posts = [];
  if (supabaseReady) {
    try { posts = await supabaseRequest("posts?select=slug,title,meta_line,image,excerpt,body,published_at&is_published=eq.true&order=sort_order.asc,published_at.desc.nullslast") || []; }
    catch { posts = []; }
  }
  if (homeGrid && posts.length) {
    homeGrid.innerHTML = posts.slice(0, 3).map(postCardMarkup).join("");
    document.querySelectorAll('.journal-section a.text-link[href="#journal"]').forEach((link) => { link.href = "journal.html"; });
  }
  if (!journalRoot) return;
  const slug = new URLSearchParams(window.location.search).get("post");
  const post = slug && posts.find((item) => item.slug === slug);
  const list = document.querySelector("#journal-list");
  const article = document.querySelector("#journal-article");
  if (post) {
    article.hidden = false;
    list.hidden = true;
    const heading = document.querySelector("#journal-list-wrap");
    if (heading) heading.hidden = true;
    document.title = `${post.title} — Disom Baha`;
    setMetaDescription(post.excerpt);
    document.querySelector("#journal-article-meta").textContent = post.meta_line || "Plant care";
    document.querySelector("#journal-article-title").textContent = post.title;
    const image = document.querySelector("#journal-article-image");
    image.hidden = !post.image;
    if (post.image) image.src = post.image;
    renderPostBody(document.querySelector("#journal-article-body"), post.body);
    return;
  }
  list.innerHTML = posts.length
    ? posts.map(postCardMarkup).join("")
    : '<p class="empty-results">New plant care guides are on their way. Meanwhile, ask our concierge anything.</p>';
}

function setupContactForm() {
  const form = document.querySelector("#contact-form");
  if (!form) return;
  const section = form.closest("section");
  if (!supabaseReady) { if (section) section.hidden = true; return; }
  if (section) section.hidden = false;
  const status = form.querySelector(".contact-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const message = { name: data.get("name"), contact: data.get("contact"), message: data.get("message") };
      try {
        await callShop("contact", message);
      } catch (error) {
        if (error.status && error.status !== 404 && error.status < 500) throw error;
        // Server function unreachable: save the message directly instead.
        await supabaseRpc("submit_contact_message", { p_name: message.name, p_contact: message.contact, p_message: message.message });
      }
      form.reset();
      status.textContent = "Thank you! We’ll get back to you soon.";
    } catch (error) {
      status.textContent = error.message || "Your message could not be sent. Please message us on WhatsApp.";
    } finally {
      button.disabled = false;
    }
  });
}

// Counts page views per day. Nothing personal is sent: only the page and the
// website the visitor came from.
function trackPageView() {
  if (!supabaseReady || navigator.doNotTrack === "1") return;
  const page = currentPageFile().replace(".html", "");
  const productId = page === "product" ? new URLSearchParams(window.location.search).get("product") : "";
  let referrer = "";
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : "";
    if (host && host !== window.location.hostname) referrer = host;
  } catch { /* Ignore malformed referrers. */ }
  supabaseRpc("track_page_view", { p_path: productId && /^[a-z0-9-]{1,80}$/.test(productId) ? `product/${productId}` : page, p_referrer: referrer }).catch(() => {});
}

// Saves the order request so it appears in the admin panel. Prices are
// recalculated by the database, so the totals here cannot be tampered with.
// It must finish BEFORE WhatsApp opens: phones freeze the page as soon as the
// WhatsApp app takes over, which would drop a request still in flight.
function saveOrderRequest(order) {
  const request = supabaseRpc("place_order", {
    p_reference: order.reference,
    p_customer: { name: order.name, phone: order.phone, address: order.address, city: order.city, state: order.state, pincode: order.pincode, payment: order.payment },
    p_items: [...cart.values()].map((line) => ({ id: line.id, size: line.size, color: line.color, quantity: line.quantity }))
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("the connection timed out")), 10000));
  return Promise.race([request, timeout]);
}

// Opens WhatsApp in a new tab while the click still counts as a user action;
// otherwise (or if the browser blocks the new tab) opens it in this tab.
function openWhatsApp(url) {
  const win = navigator.userActivation?.isActive === false ? null : window.open(url, "_blank");
  if (win) {
    try { win.opener = null; } catch { /* Cross-origin already. */ }
    return;
  }
  window.location.href = url;
}

function productImageMarkup(product, productId) {
  return `<a class="product-image photo-frame" href="product.html?product=${encodeURIComponent(productId)}" aria-label="View ${escapeHtml(product.name)}">
    <img src="${escapeHtml(product.image)}" alt="${product.isDemo ? "Illustrative demo photo of" : "Photo of"} ${escapeHtml(product.name)}" loading="lazy">
    <span class="photo-needed">${product.isDemo ? "Demo photo · illustrative only" : "Product photo unavailable"}</span><span class="product-tag">${escapeHtml(product.tag || "Plant")}</span>
  </a>`;
}

function renderCatalog() {
  const grid = document.querySelector("#product-grid");
  if (!grid) return;
  const search = document.querySelector("#filter-search")?.value.trim().toLowerCase() || "";
  const light = document.querySelector("#filter-light")?.value || "";
  const water = document.querySelector("#filter-water")?.value || "";
  const size = document.querySelector("#filter-size")?.value || "";
  const price = document.querySelector("#filter-price")?.value || "";
  const products = Object.entries(catalog).filter(([id, product]) => {
    const searchMatch = !search || `${product.name} ${product.botanical}`.toLowerCase().includes(search);
    const categoryMatch = !selectedCategory || (product.categories || []).includes(selectedCategory);
    const lightMatch = !light || product.lightFilter === light || (light === "medium" && product.lightFilter === "bright");
    const waterMatch = !water || product.waterFilter === water;
    const sizeMatch = !size || (product.sizeOptions || []).some((option) => option.label.includes(`${size} inch`));
    const priceMatch = !price || (price === "under-500" && product.price < 500) || (price === "500-749" && product.price >= 500 && product.price < 750) || (price === "750-999" && product.price >= 750 && product.price < 1000) || (price === "1000-up" && product.price >= 1000);
    return searchMatch && categoryMatch && lightMatch && waterMatch && sizeMatch && priceMatch;
  });
  grid.innerHTML = products.map(([id, product]) => `<article class="product-card" data-product="${escapeHtml(id)}">
    ${productImageMarkup(product, id)}
    <button class="favorite-button" type="button" aria-label="Save ${escapeHtml(product.name)} to favourites" aria-pressed="false">♡</button>
    <div class="product-info"><div><span class="product-category">${escapeHtml(product.botanical)}</span><h3><a href="product.html?product=${encodeURIComponent(id)}">${escapeHtml(product.name)}</a></h3></div><span class="product-price">${formatPrice(product.price)}${product.isDemo ? "<small>demo</small>" : ""}</span></div>
    <p class="product-stock">${product.isDemo ? "Demo stock" : "Current stock"}: ${escapeHtml(product.stock ?? "confirm with concierge")}</p>
    <div class="product-bottom"><span class="care-note"><span aria-hidden="true">☼</span> ${escapeHtml(product.light)}</span><a class="add-button" href="product.html?product=${encodeURIComponent(id)}">View plant <span aria-hidden="true">↗</span></a></div>
  </article>`).join("");
  grid.querySelectorAll(".product-image img").forEach((image) => image.addEventListener("error", () => {
    image.hidden = true;
    image.closest(".photo-frame")?.classList.add("photo-missing");
  }, { once: true }));
  const demoWord = products.some(([, product]) => product.isDemo) ? "demo " : "";
  document.querySelector("#filter-result").textContent = `${products.length} ${demoWord}${products.length === 1 ? "plant" : "plants"}${selectedCategory ? ` in ${selectedCategory.replaceAll("-", " ")}` : ""}`;
  document.querySelector("#empty-results").hidden = products.length > 0;
}

function setupCatalogFilters() {
  const form = document.querySelector("#catalog-filters");
  if (!form) return;
  form.addEventListener("input", renderCatalog);
  form.addEventListener("change", renderCatalog);
  form.addEventListener("reset", () => { selectedCategory = ""; setTimeout(renderCatalog, 0); });
  document.querySelectorAll("[data-category-filter]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    form.reset();
    selectedCategory = link.dataset.categoryFilter;
    renderCatalog();
    document.querySelector("#shop")?.scrollIntoView({ behavior: "smooth" });
  }));
  document.querySelector("#product-grid")?.addEventListener("click", (event) => {
    const favorite = event.target.closest(".favorite-button");
    if (!favorite) return;
    const saved = favorite.getAttribute("aria-pressed") === "true";
    favorite.setAttribute("aria-pressed", String(!saved));
    announce(saved ? "Removed from your favourites" : "Saved to your favourites");
  });
}

function markPhotoFallback(image) {
  image.addEventListener("error", () => {
    image.hidden = true;
    image.closest(".detail-image-wrap")?.classList.add("photo-missing");
  }, { once: true });
}

function renderProductDetail() {
  const root = document.querySelector("#product-detail");
  if (!root) return;
  const productId = new URLSearchParams(window.location.search).get("product") || "snake";
  const product = catalog[productId];
  if (!product) {
    root.innerHTML = '<div class="product-not-found"><span class="eyebrow">A little mix-up</span><h1>We could not find that plant.</h1><a class="button button-dark" href="index.html#shop">Back to the plants</a></div>';
    return;
  }
  document.title = `${product.name} — Disom Baha`;
  setMetaDescription(String(product.description || "").slice(0, 160));
  document.querySelector("#product-name").textContent = product.name;
  document.querySelector("#product-botanical").textContent = product.botanical;
  document.querySelector("#product-description").textContent = product.description;
  document.querySelector("#product-rating").textContent = product.review ? "Demo review · sample only" : "No verified reviews yet";
  document.querySelector("#product-tag").textContent = product.tag || "Plant";
  const image = document.querySelector("#product-main-image");
  markPhotoFallback(image);
  image.src = product.image;
  image.alt = `${product.isDemo ? "Illustrative demo photo of" : "Photo of"} ${product.name}`;
  document.querySelector(".detail-image-note").textContent = product.isDemo ? "Demo product image" : "Disom Baha product photo";
  document.querySelector("#product-breadcrumb").textContent = product.name;
  document.querySelector("#care-light").textContent = product.light;
  document.querySelector("#care-water").textContent = product.water;
  document.querySelector("#care-humidity").textContent = product.humidity;
  document.querySelector("#product-height").textContent = product.height || "Confirm with concierge";
  document.querySelector("#product-pot-diameter").textContent = product.potDiameter || "Confirm with concierge";
  document.querySelector("#product-includes").textContent = product.includes || "Confirm with concierge";
  document.querySelector("#product-stock").textContent = product.stock === null || product.stock === undefined ? "Confirm with concierge" : `${product.isDemo ? "Demo stock" : "In stock"}: ${product.stock}`;
  document.querySelector("#review-title").textContent = product.review ? (product.isDemo ? "Demo review" : "Customer review") : "Customer reviews";
  document.querySelector("#review-quote").textContent = product.review || "No verified reviews have been added yet.";
  document.querySelector("#review-by").textContent = product.reviewBy || "Verified reviews will appear here.";
  const sizePicker = document.querySelector("#plant-size");
  const sizeOptions = product.sizeOptions?.length ? product.sizeOptions : [{ label: "Standard", extra: 0 }];
  sizePicker.innerHTML = sizeOptions.map((option) => `<option value="${escapeHtml(option.label)}" data-extra="${Number(option.extra) || 0}">${escapeHtml(option.label)}${option.extra ? ` · + ${formatPrice(option.extra)}` : ""}</option>`).join("");
  const potColors = Array.isArray(product.potColors) ? (product.potColors.length ? product.potColors : ["As shown"]) : DEFAULT_POT_COLORS;
  document.querySelector("#pot-color").innerHTML = potColors.map((color) => `<option>${escapeHtml(color)}</option>`).join("");
  const priceNode = document.querySelector("#detail-price");
  const updateDetailPrice = () => {
    const extra = Number(sizePicker.selectedOptions[0]?.dataset.extra || 0);
    priceNode.textContent = formatPrice(product.price + extra);
  };
  sizePicker.addEventListener("change", updateDetailPrice);
  updateDetailPrice();
  document.querySelector("#detail-price-note").textContent = product.isDemo ? "Demo price · final amount confirmed in WhatsApp" : "Current catalog price · final amount confirmed in WhatsApp";
  document.querySelector("#product-add").addEventListener("click", () => {
    const selected = sizePicker.selectedOptions[0];
    if (!selected) return;
    addProductToCart(productId, selected.value, Number(selected.dataset.extra || 0), document.querySelector("#pot-color").value);
  });
}

function createRequestReference() {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const random = new Uint32Array(1);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(random);
  else random[0] = Math.floor(Math.random() * 0xffffffff);
  return `DBH-${day}-${random[0].toString(36).slice(-5).toUpperCase()}`;
}

function renderOrderReview() {
  if (!pendingOrder) return;
  const { count, subtotal } = cartTotals();
  pendingOrder.subtotal = subtotal;
  pendingOrder.count = count;
  const hasDemoItem = [...cart.values()].some((line) => catalog[line.id]?.isDemo);
  const online = checkoutMode === "razorpay";
  document.querySelector("#review-confirmation-note").textContent = online
    ? "Your order is confirmed as soon as your payment goes through. We’ll email your receipt and order number. If we can’t deliver to your PIN code, we’ll refund you in full."
    : `${hasDemoItem ? "This is a demo order request. " : ""}It is not accepted until the concierge confirms it. Clicking opens WhatsApp with your items, address, phone, and payment preference prefilled; review and send the message there.`;
  const payButton = document.querySelector("#send-order-whatsapp");
  if (payButton) payButton.innerHTML = online ? `Pay ${formatPrice(subtotal)} securely <span aria-hidden="true">→</span>` : 'Proceed via WhatsApp <span aria-hidden="true">↗</span>';
  document.querySelector("#order-reference").textContent = pendingOrder.reference;
  document.querySelector("#order-review-items").innerHTML = [...cart.values()].map((line) => {
    const product = catalog[line.id];
    return `<div class="order-review-line"><span>${line.quantity} × ${escapeHtml(product.name)}<small>${escapeHtml(line.size)} · ${escapeHtml(line.color)}</small></span><strong>${formatPrice(line.unitPrice * line.quantity)}</strong></div>`;
  }).join("");
  document.querySelector("#order-review-address").innerHTML = `<strong>Deliver to</strong><span>${escapeHtml(pendingOrder.name)}<br>${escapeHtml(pendingOrder.address)}<br>${escapeHtml(pendingOrder.city)}, ${escapeHtml(pendingOrder.state)} ${escapeHtml(pendingOrder.pincode)}<br>${escapeHtml(pendingOrder.phone)}${pendingOrder.email ? `<br>${escapeHtml(pendingOrder.email)}` : ""}</span><small>${online ? "Payment: online via Razorpay" : `Payment preference: ${escapeHtml(pendingOrder.payment)}`}</small>`;
  document.querySelector("#review-subtotal").textContent = formatPrice(subtotal);
  document.querySelector("#review-total").textContent = formatPrice(subtotal);
}

document.querySelector(".cart-items")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-change]");
  if (!button) return;
  const key = decodeURIComponent(button.dataset.change);
  const line = cart.get(key);
  if (!line) return;
  const nextQuantity = line.quantity + Number(button.dataset.delta);
  if (nextQuantity <= 0) cart.delete(key);
  else cart.set(key, { ...line, quantity: nextQuantity });
  updateCart();
});

document.querySelectorAll(".cart-trigger").forEach((button) => button.addEventListener("click", openCart));
document.querySelectorAll(".drawer-close").forEach((button) => button.addEventListener("click", closeCart));
cartScrim?.addEventListener("click", closeCart);
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && cartDrawer?.classList.contains("is-open")) closeCart(); });
document.querySelector(".checkout-button")?.addEventListener("click", () => { if (cart.size) showCartStage("address"); });
document.querySelector(".back-to-bag")?.addEventListener("click", () => showCartStage("bag"));
document.querySelector(".back-to-address")?.addEventListener("click", () => showCartStage("address"));

document.querySelector(".checkout-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity() || cart.size === 0) return;
  const data = new FormData(form);
  pendingOrder = {
    reference: createRequestReference(),
    name: data.get("name"), phone: data.get("phone"), address: data.get("address"),
    city: data.get("city"), state: data.get("state"), pincode: data.get("pincode"),
    email: String(data.get("email") || "").trim(),
    payment: checkoutMode === "razorpay" ? "Online (Razorpay)" : data.get("payment")
  };
  renderOrderReview();
  showCartStage("review");
});

document.querySelector("#send-order-whatsapp")?.addEventListener("click", async (event) => {
  if (!pendingOrder || cart.size === 0) return;
  const button = event.currentTarget;
  if (button.disabled) return;
  if (checkoutMode === "razorpay") { payOnline(button); return; }
  const { subtotal } = cartTotals();
  const itemLines = [...cart.values()].map((line) => {
    const product = catalog[line.id];
    return `• ${line.quantity} × ${product.name} (${line.size}, ${line.color}) — ${formatPrice(line.unitPrice * line.quantity)}`;
  }).join("\n");
  const hasDemoItem = [...cart.values()].some((line) => catalog[line.id]?.isDemo);
  const message = [
    `Disom Baha ${hasDemoItem ? "demo " : ""}order request ${pendingOrder.reference}`, "", itemLines, "",
    `Subtotal: ${formatPrice(subtotal)}`, "Delivery: Free across India", `Estimated total: ${formatPrice(subtotal)}`,
    `Payment preference: ${pendingOrder.payment}`, "", "Delivery details:",
    `Name: ${pendingOrder.name}`, `Phone / WhatsApp: ${pendingOrder.phone}`,
    `Address: ${pendingOrder.address}, ${pendingOrder.city}, ${pendingOrder.state} ${pendingOrder.pincode}`,
    "", "Please confirm stock, PIN-code serviceability, final amount, insurance coverage, and official payment instructions. Please use this request reference in your confirmation."
  ].join("\n");
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

  if (supabaseReady && !pendingOrder.recorded && !pendingOrder.sendWithoutSaving) {
    const label = button.innerHTML;
    const note = document.querySelector("#review-confirmation-note");
    button.disabled = true;
    button.textContent = "Saving your order…";
    try {
      await saveOrderRequest(pendingOrder);
      pendingOrder.recorded = true;
    } catch (error) {
      // Let the customer still reach the concierge with a second tap.
      pendingOrder.sendWithoutSaving = true;
      if (note) note.textContent = `We couldn’t save this order on our website (${error.message || "network error"}). Tap the button again to send it to our concierge on WhatsApp instead.`;
      announce("Your order could not be saved online. You can still send it on WhatsApp.");
      return;
    } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
  announce(`Request ${pendingOrder.reference} is ready. Send the message in WhatsApp to submit it.`);
  openWhatsApp(url);
});

document.querySelectorAll('[data-whatsapp="concierge"]').forEach((link) => {
  link.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi Disom Baha, I would like help with a plant order.")}`;
});

const menuToggle = document.querySelector(".mobile-menu-toggle");
const primaryNav = document.querySelector(".primary-nav");
if (menuToggle && primaryNav) {
  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Open menu" : "Close menu");
    primaryNav.classList.toggle("is-open", !isOpen);
  });
  primaryNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
    primaryNav.classList.remove("is-open");
  }));
}

// ─── Online payment (Razorpay) ──────────────────────────────────────────────

function applyCheckoutMode() {
  checkoutMode = supabaseReady && siteSettings.checkout_mode === "razorpay" ? "razorpay" : "whatsapp";
  if (checkoutMode !== "razorpay") return;
  document.querySelectorAll(".checkout-form .payment-options").forEach((fieldset) => {
    fieldset.hidden = true;
    fieldset.querySelectorAll("input").forEach((input) => { input.required = false; });
  });
  document.querySelectorAll('.checkout-form input[name="email"]').forEach((input) => { input.required = true; });
  document.querySelectorAll(".checkout-form button[type=submit]").forEach((button) => { button.innerHTML = 'Review order <span aria-hidden="true">→</span>'; });
  const text = (selector, value) => document.querySelectorAll(selector).forEach((node) => { node.textContent = value; });
  text(".cart-stage .secure-note", "Secure online payment by Razorpay · UPI, cards & netbanking");
  text(".cart-stage .delivery-note", "Free delivery across India.");
  text(".address-stage .delivery-note", "Share your delivery details, then pay securely online. Your receipt is sent by email.");
  text(".checkout-form .payment-footnote", "You’ll review your order and total before paying.");
  text(".order-review-stage > .payment-footnote", "UPI · Cards · Netbanking · Wallets, secured by Razorpay");
}

let razorpayScript;
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  razorpayScript ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () => { razorpayScript = null; reject(new Error("the payment window could not load. Check your internet connection")); };
    document.head.append(script);
  });
  return razorpayScript;
}

function setPaymentNote(text) {
  const note = document.querySelector("#review-confirmation-note");
  if (note) note.textContent = text;
}

function rememberOrder(reference) {
  try { localStorage.setItem(LAST_ORDER_KEY, reference); } catch { /* Optional convenience only. */ }
}

function showOrderSuccess(reference, confirmed) {
  rememberOrder(reference);
  cart.clear();
  updateCart();
  const stage = document.querySelector(".order-success-stage");
  if (stage) {
    stage.querySelector("#order-success-reference").textContent = reference;
    stage.querySelector("#order-success-title").textContent = confirmed ? "Thank you! Your order is confirmed." : "Thank you! We’re confirming your payment.";
    stage.querySelector("#order-success-text").textContent = confirmed
      ? "We’ve emailed your receipt. Keep your order number to track your delivery."
      : "Your payment went through, and we’re still confirming it with the bank. You’ll get an email shortly. If not, contact us with your order number.";
    stage.querySelector("#order-success-track").href = `track.html?ref=${encodeURIComponent(reference)}`;
  }
  pendingOrder = null;
  showCartStage("success");
}

async function confirmPayment(response, reference) {
  setPaymentNote("Payment received. Confirming your order…");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await callShop("verify-payment", response);
      showOrderSuccess(result.reference || reference, true);
      return;
    } catch (error) {
      // A verification failure (as opposed to a network hiccup) won't change on retry.
      if (error.status === 400) { setPaymentNote(`We couldn’t verify this payment (${error.message}). Please contact us with order number ${reference}.`); return; }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  // Razorpay also tells our server directly, so the order will still be marked paid.
  showOrderSuccess(reference, false);
}

async function payOnline(button) {
  const order = pendingOrder;
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = "Opening secure payment…";
  try {
    order.checkout ||= await callShop("create-payment", {
      reference: order.reference,
      customer: { name: order.name, phone: order.phone, email: order.email, address: order.address, city: order.city, state: order.state, pincode: order.pincode },
      items: [...cart.values()].map((line) => ({ id: line.id, size: line.size, color: line.color, quantity: line.quantity }))
    });
    await loadRazorpay();
    const checkout = order.checkout;
    const razorpay = new window.Razorpay({
      key: checkout.key,
      amount: checkout.amount,
      currency: checkout.currency,
      order_id: checkout.order_id,
      name: "Disom Baha",
      description: `Order ${checkout.reference}`,
      image: new URL("assets/brand/disom-baha-logo.png", window.location.href).href,
      prefill: { name: order.name, email: order.email, contact: order.phone },
      notes: { reference: checkout.reference },
      theme: { color: "#243b31" },
      handler: (response) => confirmPayment(response, checkout.reference),
      modal: { ondismiss: () => setPaymentNote("Payment not completed. Tap the button to try again. Nothing has been charged.") }
    });
    razorpay.on("payment.failed", (failure) => setPaymentNote(`Payment failed: ${failure?.error?.description || "please try again or use another method"}.`));
    razorpay.open();
  } catch (error) {
    setPaymentNote(error.status === 503
      ? "Online payment isn’t available right now. Please message us on WhatsApp to order."
      : `We couldn’t start the payment: ${error.message}.`);
    if (error.status === 409) {
      // That order number is used up: start this checkout again under a new one.
      order.checkout = null;
      order.reference = createRequestReference();
      renderOrderReview();
      setPaymentNote("Please tap the button again to pay.");
    }
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

document.querySelector(".back-to-shop")?.addEventListener("click", () => { closeCart(); });

// ─── Order tracking page ────────────────────────────────────────────────────

const ORDER_STEPS = [
  ["placed", "Order placed"],
  ["paid", "Payment received"],
  ["shipped", "Shipped"],
  ["delivered", "Delivered"]
];

function renderTrackedOrder(order) {
  const result = document.querySelector("#track-result");
  if (!order) {
    result.innerHTML = '<p class="track-error">We couldn’t find an order with that number and phone number. Check both and try again, or ask our concierge.</p>';
    return;
  }
  const paid = order.payment_status === "paid" || ["confirmed", "paid", "shipped", "delivered"].includes(order.status);
  const reached = { placed: true, paid, shipped: ["shipped", "delivered"].includes(order.status), delivered: order.status === "delivered" };
  const stopped = order.status === "cancelled" || order.payment_status === "refunded";
  const items = (order.items || []).map((line) => `<div class="order-review-line"><span>${Number(line.quantity)} × ${escapeHtml(line.name)}<small>${escapeHtml([line.size, line.color].filter(Boolean).join(" · "))}</small></span><strong>${formatPrice(line.line_total)}</strong></div>`).join("");
  result.innerHTML = `
    <div class="track-card">
      <div class="track-head"><span class="eyebrow">Order ${escapeHtml(order.reference)}</span><span>Placed ${escapeHtml(new Date(order.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" }))}</span></div>
      ${stopped
        ? `<p class="track-stopped">${order.payment_status === "refunded" ? "This order was cancelled and refunded." : "This order was cancelled."}</p>`
        : `<ol class="track-steps">${ORDER_STEPS.map(([key, label]) => `<li class="${reached[key] ? "is-done" : ""}">${label}</li>`).join("")}</ol>`}
      ${order.tracking ? `<p class="track-courier"><strong>Courier / tracking:</strong> ${escapeHtml(order.tracking)}</p>` : ""}
      <div class="order-review-items">${items}</div>
      <div class="order-review-totals"><div><span>Delivery</span><strong>Free</strong></div><div class="review-total"><span>Total</span><strong>${formatPrice(order.subtotal)}</strong></div></div>
    </div>`;
}

function setupTrackPage() {
  const form = document.querySelector("#track-form");
  if (!form) return;
  const params = new URLSearchParams(window.location.search);
  let remembered = "";
  try { remembered = localStorage.getItem(LAST_ORDER_KEY) || ""; } catch { /* Not available. */ }
  form.reference.value = params.get("ref") || remembered;
  if (!supabaseReady) {
    document.querySelector("#track-result").innerHTML = '<p class="track-error">Order tracking isn’t available yet. Please ask our concierge.</p>';
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    document.querySelector("#track-result").innerHTML = '<p class="muted-note">Looking up your order…</p>';
    try {
      renderTrackedOrder(await supabaseRequest("rpc/track_order", { method: "POST", body: JSON.stringify({ p_reference: form.reference.value.trim(), p_phone: form.phone.value }) }));
    } catch {
      document.querySelector("#track-result").innerHTML = '<p class="track-error">We couldn’t look up your order right now. Please try again in a minute.</p>';
    } finally {
      button.disabled = false;
    }
  });
}

async function startStorefront() {
  setupContactForm();
  trackPageView();
  setupTrackPage();
  await loadSiteContent();
  applyCheckoutMode();
  await loadCatalogSource();
  reconcileCart();
  loadJournal();
  setupCatalogFilters();
  renderCatalog();
  renderProductDetail();
  updateCart();
}

startStorefront();

const WHATSAPP_NUMBER = "918348938263";
const CART_STORAGE_KEY = "disom-baha-cart-v1";
const ADMIN_CATALOG_STORAGE_KEY = "disom-baha-admin-catalog-demo-v1";
let catalog = window.DISOM_BAHA_CATALOG || {};
let catalogFromAdminDemo = false;
try {
  const localCatalog = JSON.parse(localStorage.getItem(ADMIN_CATALOG_STORAGE_KEY) || "null");
  if (localCatalog && typeof localCatalog === "object" && !Array.isArray(localCatalog)) {
    catalog = localCatalog;
    catalogFromAdminDemo = true;
  }
} catch { /* Fall back to the packaged demo catalog. */ }
let selectedCategory = "";
let pendingOrder = null;

const cart = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");
  if (Array.isArray(saved)) {
    saved.forEach(([key, line]) => {
      if (catalog[line?.id] && Number.isInteger(line.quantity) && line.quantity > 0) cart.set(key, line);
    });
  }
} catch { /* A fresh bag is fine when local storage is unavailable. */ }

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
    review: [".order-review-stage"]
  };
  [".cart-items", ".cart-stage", ".address-stage", ".order-review-stage"].forEach((selector) => {
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

async function loadCatalogSource() {
  const sheetUrl = window.DISOM_BAHA_SHEET_CSV_URL;
  if (!sheetUrl) {
    const note = document.querySelector(".catalog-note");
    if (note && catalogFromAdminDemo) note.textContent = "Demo catalog loaded from this browser’s admin panel. Changes are local to this device.";
    return;
  }
  try {
    const response = await fetch(sheetUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Catalog sheet could not be loaded");
    const sheetCatalog = catalogFromCsv(await response.text());
    if (!sheetCatalog) throw new Error("Catalog sheet has no product rows");
    catalog = sheetCatalog;
    for (const [key, line] of cart.entries()) {
      const product = catalog[line.id];
      if (!product) { cart.delete(key); continue; }
      const sizeExtra = (product.sizeOptions || []).find((option) => option.label === line.size)?.extra || 0;
      cart.set(key, { ...line, unitPrice: Number(product.price) + Number(sizeExtra) });
    }
    const note = document.querySelector(".catalog-note");
    if (note) note.textContent = "Live catalog loaded from the Disom Baha product sheet.";
  } catch {
    const note = document.querySelector(".catalog-note");
    if (note) note.textContent = catalogFromAdminDemo
      ? "Product sheet unavailable. Showing this browser’s saved demo catalog."
      : "Showing the demo catalog. The product sheet could not be loaded.";
  }
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
  document.querySelector("#filter-result").textContent = `${products.length} demo ${products.length === 1 ? "plant" : "plants"}${selectedCategory ? ` in ${selectedCategory.replaceAll("-", " ")}` : ""}`;
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
  sizePicker.innerHTML = (product.sizeOptions || []).map((option) => `<option value="${escapeHtml(option.label)}" data-extra="${Number(option.extra) || 0}">${escapeHtml(option.label)}${option.extra ? ` · + ${formatPrice(option.extra)}` : ""}</option>`).join("");
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
  document.querySelector("#review-confirmation-note").textContent = `${hasDemoItem ? "This is a demo order request. " : ""}It is not accepted until the concierge confirms it. Clicking opens WhatsApp with your items, address, phone, and payment preference prefilled; review and send the message there.`;
  document.querySelector("#order-reference").textContent = pendingOrder.reference;
  document.querySelector("#order-review-items").innerHTML = [...cart.values()].map((line) => {
    const product = catalog[line.id];
    return `<div class="order-review-line"><span>${line.quantity} × ${escapeHtml(product.name)}<small>${escapeHtml(line.size)} · ${escapeHtml(line.color)}</small></span><strong>${formatPrice(line.unitPrice * line.quantity)}</strong></div>`;
  }).join("");
  document.querySelector("#order-review-address").innerHTML = `<strong>Deliver to</strong><span>${escapeHtml(pendingOrder.name)}<br>${escapeHtml(pendingOrder.address)}<br>${escapeHtml(pendingOrder.city)}, ${escapeHtml(pendingOrder.state)} ${escapeHtml(pendingOrder.pincode)}<br>${escapeHtml(pendingOrder.phone)}</span><small>Payment preference: ${escapeHtml(pendingOrder.payment)}</small>`;
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
    city: data.get("city"), state: data.get("state"), pincode: data.get("pincode"), payment: data.get("payment")
  };
  renderOrderReview();
  showCartStage("review");
});

document.querySelector("#send-order-whatsapp")?.addEventListener("click", () => {
  if (!pendingOrder || cart.size === 0) return;
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
  window.open(url, "_blank", "noopener,noreferrer");
  announce(`Request ${pendingOrder.reference} is ready. Send the message in WhatsApp to submit it.`);
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

async function startStorefront() {
  await loadCatalogSource();
  setupCatalogFilters();
  renderCatalog();
  renderProductDetail();
  updateCart();
}

startStorefront();

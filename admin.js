const ADMIN_STORAGE_KEY = "disom-baha-admin-catalog-demo-v1";
const SHEET_COLUMNS = [
  "id", "name", "botanical", "price", "image", "tag", "isDemo", "light", "lightFilter",
  "water", "waterFilter", "humidity", "sizeOptions", "height", "potDiameter", "includes",
  "stock", "categories", "description", "review", "reviewBy"
];

let products = structuredClone(window.DISOM_BAHA_CATALOG || {});
let editingId = "";
let lastGeneratedId = "";

try {
  const saved = JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY) || "null");
  if (saved && typeof saved === "object" && !Array.isArray(saved)) products = saved;
} catch { /* Keep the packaged sample catalog. */ }

const productList = document.querySelector("#admin-product-list");
const form = document.querySelector("#product-form");
const searchInput = document.querySelector("#admin-search");
const saveStatus = document.querySelector("#save-status");
const formError = document.querySelector("#form-error");
const field = (name) => document.querySelector(`#product-${name}`);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function setStatus(message) {
  if (saveStatus) saveStatus.textContent = message;
}

function persistProducts(message = "Saved in this browser. Reload the storefront preview to see the changes.") {
  try {
    localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(products));
    setStatus(message);
    return true;
  } catch {
    setStatus("Could not save. Your browser storage may be full or unavailable.");
    return false;
  }
}

function renderStats() {
  const entries = Object.values(products);
  document.querySelector("#stat-products").textContent = entries.length;
  document.querySelector("#stat-stock").textContent = entries.reduce((sum, product) => sum + (Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0), 0);
  document.querySelector("#stat-demo").textContent = entries.filter((product) => product.isDemo).length;
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const entries = Object.entries(products).filter(([, product]) => `${product.name} ${product.botanical || ""}`.toLowerCase().includes(query)).sort((a, b) => a[1].name.localeCompare(b[1].name));
  if (!entries.length) {
    productList.innerHTML = '<p class="empty-admin-list">No plants match your search. Try another name or add a plant.</p>';
  } else {
    productList.innerHTML = entries.map(([id, product]) => `
      <article class="admin-product" data-row-id="${escapeHtml(id)}" aria-current="${id === editingId}">
        ${product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<span class="product-placeholder" aria-hidden="true">✳</span>'}
        <div class="admin-product-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.botanical || "Botanical name not added")}</small><span>₹${Number(product.price) || 0} · ${product.stock ?? "stock unknown"} in stock · ${product.isDemo ? "Demo" : "Catalog"}</span></div>
        <div class="admin-product-actions"><button type="button" data-action="edit" data-id="${escapeHtml(id)}" aria-label="Edit ${escapeHtml(product.name)}">Edit</button><button class="delete-product" type="button" data-action="delete" data-id="${escapeHtml(id)}" aria-label="Delete ${escapeHtml(product.name)}">×</button></div>
      </article>`).join("");
    productList.querySelectorAll(".admin-product img").forEach((image) => image.addEventListener("error", () => {
      const placeholder = document.createElement("span");
      placeholder.className = "product-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.textContent = "✳";
      image.replaceWith(placeholder);
    }, { once: true }));
  }
  renderStats();
}

function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function showError(message = "") {
  formError.textContent = message;
  formError.hidden = !message;
}

function resetForm() {
  form.reset();
  editingId = "";
  lastGeneratedId = "";
  field("id").value = "";
  document.querySelector("#product-original-id").value = "";
  document.querySelector("#editor-title").textContent = "Add a plant";
  document.querySelector("#editor-mode").textContent = "NEW";
  document.querySelector("#save-product").textContent = "Save product";
  showError();
  renderList();
}

function setField(name, value) {
  const element = field(name);
  if (!element) return;
  if (element.type === "checkbox") element.checked = Boolean(value);
  else element.value = value ?? "";
}

function editProduct(id) {
  const product = products[id];
  if (!product) return;
  editingId = id;
  document.querySelector("#product-original-id").value = id;
  setField("id", id);
  setField("name", product.name);
  setField("botanical", product.botanical);
  setField("price", product.price);
  setField("stock", product.stock);
  setField("image", product.image);
  setField("tag", product.tag);
  setField("height", product.height);
  setField("pot", product.potDiameter);
  setField("includes", product.includes);
  setField("light-filter", product.lightFilter || "low");
  setField("light", product.light);
  setField("water-filter", product.waterFilter || "infrequent");
  setField("water", product.water);
  setField("humidity", product.humidity);
  setField("categories", (product.categories || []).join(", "));
  setField("sizes", (product.sizeOptions || []).map((option) => `${option.label}:${Number(option.extra) || 0}`).join(" | "));
  setField("description", product.description);
  setField("review", product.review);
  setField("review-by", product.reviewBy);
  setField("is-demo", product.isDemo);
  document.querySelector("#editor-title").textContent = `Edit ${product.name}`;
  document.querySelector("#editor-mode").textContent = "EDITING";
  document.querySelector("#save-product").textContent = "Save changes";
  showError();
  renderList();
  if (window.matchMedia("(max-width: 900px)").matches) document.querySelector(".editor-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function parseSizes(value) {
  return value.split("|").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.lastIndexOf(":");
    const label = (separator < 0 ? part : part.slice(0, separator)).trim();
    const extra = separator < 0 ? 0 : Number(part.slice(separator + 1).trim());
    if (!label || !Number.isFinite(extra) || extra < 0) throw new Error("Check the size options. Use “4 inch nursery plant:0 | 6 inch fuller plant:250”.");
    return { label, extra };
  });
}

function formProduct() {
  const id = field("id").value.trim();
  const price = Number(field("price").value);
  const stockValue = field("stock").value.trim();
  const stock = stockValue === "" ? null : Number(stockValue);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Product ID must use lowercase letters, numbers, and hyphens only.");
  if (editingId !== id && products[id]) throw new Error("That product ID is already in use. Choose a different ID.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Enter a valid price of ₹0 or more.");
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) throw new Error("Stock must be a whole number of 0 or more, or blank.");
  const sizeOptions = parseSizes(field("sizes").value);
  const review = field("review").value.trim();
  return {
    id,
    name: field("name").value.trim(),
    botanical: field("botanical").value.trim(),
    price,
    image: field("image").value.trim(),
    tag: field("tag").value.trim(),
    isDemo: field("is-demo").checked,
    review,
    reviewBy: review ? field("review-by").value.trim() : "",
    light: field("light").value.trim(),
    lightFilter: field("light-filter").value,
    water: field("water").value.trim(),
    waterFilter: field("water-filter").value,
    humidity: field("humidity").value.trim(),
    sizeOptions,
    height: field("height").value.trim(),
    potDiameter: field("pot").value.trim(),
    includes: field("includes").value.trim(),
    stock,
    categories: field("categories").value.split(/[,|]/).map((category) => category.trim()).filter(Boolean),
    description: field("description").value.trim()
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const rows = [SHEET_COLUMNS];
  Object.entries(products).forEach(([id, product]) => {
    const values = {
      ...product,
      id,
      sizeOptions: (product.sizeOptions || []).map((option) => `${option.label}:${Number(option.extra) || 0}`).join("|"),
      categories: (product.categories || []).join("|"),
      stock: product.stock ?? ""
    };
    rows.push(SHEET_COLUMNS.map((column) => values[column] ?? ""));
  });
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "disom-baha-catalog-demo.csv";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("CSV downloaded. Import it into Google Sheets when you are ready.");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  showError();
  if (!form.reportValidity()) return;
  try {
    const product = formProduct();
    if (editingId && editingId !== product.id) delete products[editingId];
    products[product.id] = product;
    if (!persistProducts()) return;
    editingId = product.id;
    document.querySelector("#product-original-id").value = product.id;
    document.querySelector("#editor-title").textContent = `Edit ${product.name}`;
    document.querySelector("#editor-mode").textContent = "EDITING";
    document.querySelector("#save-product").textContent = "Save changes";
    renderList();
  } catch (error) {
    showError(error.message || "Please check the product details and try again.");
  }
});

productList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === "edit") editProduct(id);
  if (button.dataset.action === "delete") {
    const product = products[id];
    if (!product || !window.confirm(`Remove ${product.name} from this browser's demo catalog?`)) return;
    delete products[id];
    if (editingId === id) resetForm();
    persistProducts(`${product.name} removed from this browser’s demo catalog.`);
    renderList();
  }
});

searchInput.addEventListener("input", renderList);
document.querySelectorAll("#add-product-top, #add-product-mobile").forEach((button) => button.addEventListener("click", () => {
  resetForm();
  document.querySelector("#product-name").focus();
  if (window.matchMedia("(max-width: 900px)").matches) document.querySelector(".editor-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}));
document.querySelector("#cancel-edit").addEventListener("click", resetForm);
document.querySelector("#export-csv").addEventListener("click", exportCsv);
document.querySelector("#restore-demo").addEventListener("click", () => {
  if (!window.confirm("Restore the original sample plants and discard edits saved in this browser?")) return;
  products = structuredClone(window.DISOM_BAHA_CATALOG || {});
  editingId = "";
  try { localStorage.removeItem(ADMIN_STORAGE_KEY); } catch { /* Restoring in memory is still useful for this visit. */ }
  resetForm();
  setStatus("Original demo catalog restored in this browser.");
});
field("name").addEventListener("input", () => {
  if (editingId) return;
  const nextId = slugify(field("name").value);
  if (!field("id").value || field("id").value === lastGeneratedId) field("id").value = nextId;
  lastGeneratedId = nextId;
});

renderList();

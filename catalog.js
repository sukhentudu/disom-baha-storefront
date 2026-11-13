// Demo catalog. Replace these examples with verified business data before launch.
// When a Google Sheet exists, paste its published CSV URL into DISOM_BAHA_SHEET_CSV_URL.
window.DISOM_BAHA_SHEET_CSV_URL = "";
window.DISOM_BAHA_CATALOG = {
  snake: {
    name: "Snake Plant", botanical: "Sansevieria trifasciata", price: 599,
    image: "assets/products/snake-plant-demo.png", tag: "Easy care", isDemo: true,
    review: "Demo review for layout only. Replace with a verified customer review.", reviewBy: "Sample customer",
    light: "Low to bright indirect", lightFilter: "low", water: "Every 2–3 weeks", waterFilter: "infrequent", humidity: "Low to average",
    sizeOptions: [{ label: "4 inch nursery plant", extra: 0 }, { label: "6 inch fuller plant", extra: 250 }], height: "25–35 cm (demo)", potDiameter: "12 cm (demo)", includes: "Plant, nursery pot, and care card (demo)", stock: 12,
    categories: ["indoor", "low-maintenance", "low-light"],
    description: "A sculptural, resilient favourite for bedrooms, desks, and quieter corners. These measurements and stock details are demo values."
  },
  monstera: {
    name: "Monstera", botanical: "Monstera deliciosa", price: 899,
    image: "assets/products/monstera-demo.png", tag: "Leafy favourite", isDemo: true,
    review: "Demo review for layout only. Replace with a verified customer review.", reviewBy: "Sample customer",
    light: "Bright, indirect", lightFilter: "bright", water: "When top soil is dry", waterFilter: "medium", humidity: "Average to high",
    sizeOptions: [{ label: "4 inch nursery plant", extra: 0 }, { label: "6 inch fuller plant", extra: 250 }], height: "30–40 cm (demo)", potDiameter: "15 cm (demo)", includes: "Plant, nursery pot, and care card (demo)", stock: 8,
    categories: ["indoor", "bright-light"],
    description: "Big, beautifully split leaves make this tropical plant a natural centrepiece. These measurements and stock details are demo values."
  },
  zz: {
    name: "ZZ Plant", botanical: "Zamioculcas zamiifolia", price: 749,
    image: "assets/products/zz-plant-demo.png", tag: "Beginner pick", isDemo: true,
    review: "Demo review for layout only. Replace with a verified customer review.", reviewBy: "Sample customer",
    light: "Low to medium indirect", lightFilter: "low", water: "Every 2–3 weeks", waterFilter: "infrequent", humidity: "Average",
    sizeOptions: [{ label: "4 inch nursery plant", extra: 0 }, { label: "6 inch fuller plant", extra: 250 }], height: "25–35 cm (demo)", potDiameter: "12 cm (demo)", includes: "Plant, nursery pot, and care card (demo)", stock: 10,
    categories: ["indoor", "low-maintenance", "low-light"],
    description: "Glossy leaves and a relaxed watering routine make the ZZ a dependable companion. These measurements and stock details are demo values."
  },
  pothos: {
    name: "Golden Pothos", botanical: "Epipremnum aureum", price: 449,
    image: "assets/products/golden-pothos-demo.png", tag: "Under ₹500", isDemo: true,
    review: "Demo review for layout only. Replace with a verified customer review.", reviewBy: "Sample customer",
    light: "Medium to bright indirect", lightFilter: "medium", water: "When top soil is dry", waterFilter: "medium", humidity: "Average",
    sizeOptions: [{ label: "4 inch nursery plant", extra: 0 }, { label: "6 inch fuller plant", extra: 250 }], height: "20–30 cm trailing length (demo)", potDiameter: "12 cm (demo)", includes: "Plant, nursery pot, and care card (demo)", stock: 15,
    categories: ["indoor", "low-maintenance", "medium-light"],
    description: "A cheerful trailing plant for shelves and hanging planters. These measurements and stock details are demo values."
  }
};

// Keep “insured” out of customer-facing copy until the actual coverage and exclusions are confirmed.
window.DISOM_BAHA_POLICIES = {
  freeDeliveryIndia: true,
  insuranceConfirmed: false,
  plantPromiseDays: 7,
  replacementTermsConfirmed: false,
  replacementDeliveryPaidByCustomer: true
};

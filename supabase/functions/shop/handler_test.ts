// Run: deno test --allow-env --allow-net supabase/functions/shop/handler_test.ts
// Razorpay and the Supabase database are replaced with in-memory fakes.
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { handle, hmacHex, safeEqual } from "./handler.ts";

const SB = "https://test.supabase.co";
Deno.env.set("SUPABASE_URL", SB);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const state = {
  orders: [] as Row[],
  stock: 3,
  rzpOrders: [] as Row[],
  payments: {} as Record<string, Row>,
  calls: [] as { method: string; url: string; body?: string; auth?: string }[],
  chatAuth: [] as string[],
  chatCount: {} as Record<string, number>,
};
const CUSTOMER_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.sig";
const ADMIN_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig";
Deno.env.set("SUPABASE_ANON_KEY", "anon-key-test");
const SIZES: Record<string, number> = { "4 inch nursery plant": 0, "6 inch fuller plant": 250 };

function respond(data: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function rows(url: URL) {
  return state.orders.filter((o) => [...url.searchParams].every(([k, v]) => k === "select" || !v.startsWith("eq.") || String(o[k]) === v.slice(3)));
}

globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const body = typeof init.body === "string" ? init.body : undefined;
  state.calls.push({ method, url: url.pathname + url.search, body, auth: headers.get("authorization") ?? undefined });

  if (url.hostname === "api.razorpay.com") {
    if (headers.get("authorization") !== `Basic ${btoa("rzp_test_key:rzp_secret")}`) return respond({ error: { description: "bad auth" } }, 401);
    if (url.pathname === "/v1/orders" && method === "POST") {
      const order = { id: `order_${state.rzpOrders.length + 1}`, ...JSON.parse(body!) };
      state.rzpOrders.push(order);
      return respond(order);
    }
    const capture = url.pathname.match(/^\/v1\/payments\/([^/]+)\/capture$/);
    if (capture) { state.payments[capture[1]].status = "captured"; return respond(state.payments[capture[1]]); }
    const pay = url.pathname.match(/^\/v1\/payments\/([^/]+)$/);
    if (pay) return state.payments[pay[1]] ? respond(state.payments[pay[1]]) : respond({ error: { description: "not found" } }, 404);
  }

  if (url.origin === SB && url.pathname.startsWith("/rest/v1/rpc/")) {
    const fn = url.pathname.split("/").pop();
    const args = JSON.parse(body ?? "{}");
    if (fn === "place_order") {
      const lines = args.p_items.map((i: Row) => ({ product_id: i.id, name: "Snake Plant", size: i.size, color: i.color, quantity: i.quantity, unit_price: 599 + SIZES[i.size], line_total: (599 + SIZES[i.size]) * i.quantity }));
      state.orders.push({ id: crypto.randomUUID(), reference: args.p_reference, customer_name: args.p_customer.name, phone: args.p_customer.phone, email: args.p_customer.email, address: "x", city: "x", state: "x", pincode: "700001", payment_preference: args.p_customer.payment, items: lines, subtotal: lines.reduce((s: number, l: Row) => s + l.line_total, 0), payment_status: "unpaid", status: "new", razorpay_order_id: null });
      return respond(args.p_reference);
    }
    if (fn === "mark_order_paid") {
      const order = state.orders.find((o) => o.razorpay_order_id === args.p_razorpay_order_id);
      if (!order) return respond({ message: "Unknown payment order" }, 400);
      if (order.payment_status === "paid" || order.payment_status === "refunded") return respond({ reference: order.reference, newly_paid: false });
      if (args.p_amount_paise !== order.subtotal * 100) return respond({ message: "Paid amount does not match the order" }, 400);
      Object.assign(order, { payment_status: "paid", status: "paid", razorpay_payment_id: args.p_payment_id });
      state.stock -= order.items[0].quantity;
      return respond({ reference: order.reference, newly_paid: true, stock_ok: true });
    }
    if (fn === "set_order_payment_state") {
      const order = state.orders.find((o) => o.razorpay_order_id === args.p_razorpay_order_id);
      if (!order) return respond({ message: "Unknown payment order" }, 400);
      if (args.p_payment_status === "refunded") Object.assign(order, { payment_status: "refunded", status: "cancelled" });
      else if (order.payment_status === "pending") order.payment_status = "failed";
      return respond({ reference: order.reference });
    }
    if (fn === "chat_send" || fn === "admin_chat_reply") {
      const token = headers.get("authorization") ?? "";
      state.chatAuth.push(token);
      if (fn === "admin_chat_reply" && token !== `Bearer ${ADMIN_JWT}`) return respond({ message: "Not authorised" }, 400);
      if (!String(args.p_body).trim()) return respond({ message: "Please write a message (up to 2000 characters)" }, 400);
      const sender = fn === "chat_send" ? "customer" : "admin";
      state.chatCount[sender] = (state.chatCount[sender] ?? 0) + 1;
      return respond({ message: { id: crypto.randomUUID(), sender, body: args.p_body }, [sender === "customer" ? "notify_owner" : "notify_customer"]: state.chatCount[sender] === 1, customer_name: "Priya", customer_email: "priya@example.com" });
    }
    if (fn === "submit_contact_message") return args.p_message ? respond(null, 204) : respond({ message: "Please fill in your name, phone or email, and a message" }, 400);
  }

  if (url.origin === SB && url.pathname === "/rest/v1/orders") {
    const matches = rows(url);
    if (method === "PATCH") { matches.forEach((o) => Object.assign(o, JSON.parse(body!))); return respond(null, 204); }
    if ((headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
      return matches.length === 1 ? respond(matches[0]) : respond({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows" }, 406);
    }
    return respond(matches);
  }
  return respond({ message: `unmocked ${method} ${url}` }, 500);
};

const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  handle(new Request(`${SB}/functions/v1/shop/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const customer = { name: "Asha", phone: "9876543210", email: "asha@example.com", address: "12 Lake Rd", city: "Kolkata", state: "WB", pincode: "700001" };
const items = [{ id: "snake", size: "6 inch fuller plant", color: "Terracotta", quantity: 2, unit_price: 1 }];
const flush = () => new Promise((r) => setTimeout(r, 20));

Deno.test("HMAC matches the standard test vector", async () => {
  assertEquals(await hmacHex("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  assert(safeEqual("abc", "abc"));
  assert(!safeEqual("abc", "abd"));
  assert(!safeEqual("abc", "abcd"));
});

Deno.test("CORS preflight and unknown routes", async () => {
  const pre = await handle(new Request(`${SB}/functions/v1/shop/create-payment`, { method: "OPTIONS" }));
  assertEquals(pre.headers.get("access-control-allow-origin"), "*");
  assertEquals((await post("nope", {})).status, 404);
  assertEquals((await handle(new Request(`${SB}/functions/v1/shop/contact`))).status, 404);
});

Deno.test("create-payment says so when Razorpay keys are missing", async () => {
  const res = await post("create-payment", { reference: "DBH-20261128-AAAA1", customer, items });
  assertEquals(res.status, 503);
  assertEquals(state.orders.length, 0);
});

Deno.test("full payment flow", async (t) => {
  Deno.env.set("RAZORPAY_KEY_ID", "rzp_test_key");
  Deno.env.set("RAZORPAY_KEY_SECRET", "rzp_secret");
  Deno.env.set("RAZORPAY_WEBHOOK_SECRET", "whsec");

  await t.step("rejects a bad reference and a missing email", async () => {
    assertEquals((await post("create-payment", { reference: "hack", customer, items })).status, 400);
    assertEquals((await post("create-payment", { reference: "DBH-20261128-AAAA2", customer: { ...customer, email: "" }, items })).status, 400);
    assertEquals(state.orders.length, 0);
  });

  let razorpayOrder = "";
  await t.step("creates the order with the server-side price", async () => {
    const res = await post("create-payment", { reference: "DBH-20261128-AAAA3", customer, items });
    const data = await res.json();
    assertEquals(res.status, 200);
    assertEquals(data.key, "rzp_test_key");
    assertEquals(data.amount, 169800); // 2 x (599 + 250) rupees, in paise; the client's unit_price was ignored
    assertEquals(state.rzpOrders[0].amount, 169800);
    assertEquals(state.rzpOrders[0].receipt, "DBH-20261128-AAAA3");
    const order = state.orders[0];
    assertEquals(order.payment_status, "pending");
    assertEquals(order.razorpay_order_id, data.order_id);
    assertEquals(order.payment_preference, "Online (Razorpay)");
    razorpayOrder = data.order_id;
  });

  await t.step("a retry reuses the same Razorpay order", async () => {
    const data = await (await post("create-payment", { reference: "DBH-20261128-AAAA3", customer, items })).json();
    assertEquals(data.order_id, razorpayOrder);
    assertEquals(state.rzpOrders.length, 1);
    assertEquals(state.orders.length, 1);
  });

  await t.step("rejects a forged signature", async () => {
    state.payments.pay_1 = { id: "pay_1", order_id: razorpayOrder, amount: 169800, currency: "INR", status: "authorized" };
    const res = await post("verify-payment", { razorpay_order_id: razorpayOrder, razorpay_payment_id: "pay_1", razorpay_signature: "0".repeat(64) });
    assertEquals(res.status, 400);
    assertEquals(state.orders[0].payment_status, "pending");
  });

  await t.step("rejects a real payment from a different order", async () => {
    state.payments.pay_other = { id: "pay_other", order_id: "order_999", amount: 100, currency: "INR", status: "captured" };
    const signature = await hmacHex("rzp_secret", `${razorpayOrder}|pay_other`);
    const res = await post("verify-payment", { razorpay_order_id: razorpayOrder, razorpay_payment_id: "pay_other", razorpay_signature: signature });
    assertEquals(res.status, 400);
    assertEquals(state.orders[0].payment_status, "pending");
  });

  await t.step("a valid payment is captured and marked paid once", async () => {
    const signature = await hmacHex("rzp_secret", `${razorpayOrder}|pay_1`);
    const res = await post("verify-payment", { razorpay_order_id: razorpayOrder, razorpay_payment_id: "pay_1", razorpay_signature: signature });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).reference, "DBH-20261128-AAAA3");
    assert(state.calls.some((c) => c.url === "/v1/payments/pay_1/capture"));
    assertEquals(state.orders[0].payment_status, "paid");
    assertEquals(state.stock, 1);
    await post("verify-payment", { razorpay_order_id: razorpayOrder, razorpay_payment_id: "pay_1", razorpay_signature: signature });
    assertEquals(state.stock, 1); // not taken twice
    await flush();
  });

  await t.step("webhook: bad signature is refused", async () => {
    const res = await post("razorpay-webhook", "{}", { "x-razorpay-signature": "bad" });
    assertEquals(res.status, 401);
  });

  const webhook = async (event: unknown) => {
    const raw = JSON.stringify(event);
    return post("razorpay-webhook", raw, { "x-razorpay-signature": await hmacHex("whsec", raw) });
  };

  await t.step("webhook: payment.captured marks a second order paid", async () => {
    await post("create-payment", { reference: "DBH-20261128-AAAA4", customer, items: [{ ...items[0], quantity: 1 }] });
    const second = state.orders[1];
    const res = await webhook({ event: "payment.captured", payload: { payment: { entity: { id: "pay_2", order_id: second.razorpay_order_id, amount: 84900, status: "captured" } } } });
    assertEquals(res.status, 200);
    assertEquals(second.payment_status, "paid");
    await flush();
  });

  await t.step("webhook: partial refund changes nothing, full refund cancels", async () => {
    const order = state.orders[0];
    await webhook({ event: "refund.processed", payload: { payment: { entity: { id: "pay_1", order_id: order.razorpay_order_id, amount: 169800, amount_refunded: 50000 } } } });
    assertEquals(order.payment_status, "paid");
    await webhook({ event: "refund.processed", payload: { payment: { entity: { id: "pay_1", order_id: order.razorpay_order_id, amount: 169800, amount_refunded: 169800 } } } });
    assertEquals(order.payment_status, "refunded");
    assertEquals(order.status, "cancelled");
  });

  await t.step("webhook: payments for other things are acknowledged, not retried", async () => {
    const res = await webhook({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_unknown", amount: 100, status: "captured" } } } });
    assertEquals(res.status, 200);
  });
});

Deno.test("contact form saves the message", async () => {
  const ok = await post("contact", { name: "Meera", contact: "meera@example.com", message: "Do you ship to Goa?" });
  assertEquals(ok.status, 200);
  const call = state.calls.find((c) => c.url === "/rest/v1/rpc/submit_contact_message");
  assertEquals(JSON.parse(call!.body!).p_message, "Do you ship to Goa?");
  const bad = await post("contact", { name: "Meera", contact: "meera@example.com", message: "" });
  assertEquals(bad.status, 400);
  await flush();
});

Deno.test("chat: sending needs a signed-in customer and runs as them", async () => {
  assertEquals((await post("chat-send", { body: "hi" })).status, 401);
  assertEquals((await post("chat-send", { body: "hi" }, { authorization: "Bearer not-a-jwt" })).status, 401);
  const res = await post("chat-send", { body: "Is the monstera pet safe?" }, { authorization: `Bearer ${CUSTOMER_JWT}` });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).message.body, "Is the monstera pet safe?");
  assertEquals(state.chatAuth.at(-1), `Bearer ${CUSTOMER_JWT}`); // the database sees the customer, not the service role
  const empty = await post("chat-send", { body: "  " }, { authorization: `Bearer ${CUSTOMER_JWT}` });
  assertEquals(empty.status, 400);
  await flush();
});

Deno.test("chat: only an admin can reply; the customer is emailed once per burst", async () => {
  const asCustomer = await post("chat-reply", { thread_id: "t1", body: "fake reply" }, { authorization: `Bearer ${CUSTOMER_JWT}` });
  assertEquals(asCustomer.status, 403);
  const first = await (await post("chat-reply", { thread_id: "t1", body: "Yes, keep it away from cats." }, { authorization: `Bearer ${ADMIN_JWT}` })).json();
  assertEquals(first.message.sender, "admin");
  assertEquals(first.emailed, true);
  const second = await (await post("chat-reply", { thread_id: "t1", body: "Anything else?" }, { authorization: `Bearer ${ADMIN_JWT}` })).json();
  assertEquals(second.emailed, false);
  await flush();
});

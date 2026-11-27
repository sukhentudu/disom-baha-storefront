// Disom Baha "shop" server function (Supabase Edge Function).
//
// Routes (all POST):
//   /shop/create-payment    start a Razorpay payment for a new order
//   /shop/verify-payment    confirm a payment the customer's browser reports
//   /shop/razorpay-webhook  Razorpay's own confirmation (payment, failure, refund)
//   /shop/contact           save a contact-form message and email the owner
//   /shop/chat-send         a signed-in customer sends a chat message
//   /shop/chat-reply        an admin replies to a chat (emails the customer)
//
// Secrets (Supabase → Edge Functions → Secrets; never commit them):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
//   GMAIL_USER, GMAIL_APP_PASSWORD, OWNER_EMAIL (optional), SITE_URL (optional)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

const env = (name: string) => (Deno.env.get(name) ?? "").trim();
const siteUrl = () => (env("SITE_URL") || "https://disombaha.com/").replace(/\/?$/, "/");
const ownerEmail = () => env("OWNER_EMAIL") || env("GMAIL_USER");
const paymentsReady = () => Boolean(env("RAZORPAY_KEY_ID") && env("RAZORPAY_KEY_SECRET"));
const REFERENCE = /^DBH-\d{8}-[A-Z0-9]{1,8}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const fail = (message: string, status = 400) => json({ error: message }, status);

function db(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Acts as the person who is signed in, so the database's own rules decide
// what they may do (a customer's own chat; admin-only replies).
function asUser(req: Request): SupabaseClient | null {
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+\.\S+\.\S+$/.test(authorization)) return null;
  const publicKey = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
  return createClient(env("SUPABASE_URL"), publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
}

// Runs work after the response is sent when the runtime supports it.
function later(task: Promise<unknown>) {
  const safe = task.catch((error) => console.error("background task failed", error));
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(safe);
  return safe;
}

// ─── Crypto ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Razorpay ──────────────────────────────────────────────────────────────

async function razorpay(path: string, init: RequestInit = {}) {
  const auth = btoa(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`);
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.description || `Razorpay returned ${response.status}`);
  return data;
}

// ─── Email (Gmail, port 465) ───────────────────────────────────────────────

const rupees = (amount: number) => `₹${new Intl.NumberFormat("en-IN").format(amount)}`;

export async function sendMail(to: string, subject: string, text: string) {
  const user = env("GMAIL_USER");
  const password = env("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
  if (!user || !password || !to) return false;
  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user, password } },
  });
  try {
    await client.send({ from: `Disom Baha <${user}>`, to, subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), content: text });
  } finally {
    await client.close();
  }
  return true;
}

type OrderLine = { name: string; size: string; color: string; quantity: number; line_total: number };

function itemLines(items: OrderLine[]) {
  return items.map((l) => `- ${l.quantity} x ${l.name}${l.size ? ` (${l.size}${l.color ? `, ${l.color}` : ""})` : ""}: ${rupees(l.line_total)}`).join("\n");
}

async function emailPaidOrder(client: SupabaseClient, reference: string, stockOk: boolean) {
  const { data: order, error } = await client.from("orders")
    .select("reference, customer_name, phone, email, address, city, state, pincode, items, subtotal")
    .eq("reference", reference).single();
  if (error || !order) throw new Error(error?.message || "order not found for email");
  const lines = itemLines(order.items);
  const address = `${order.address}, ${order.city}, ${order.state} ${order.pincode}`;

  await sendMail(ownerEmail(), `New paid order ${order.reference} (${rupees(order.subtotal)})`, [
    `A new order has been paid online.`, "",
    `Order: ${order.reference}`, lines, `Total: ${rupees(order.subtotal)} (paid)`, "",
    `Customer: ${order.customer_name}`, `Phone: ${order.phone}`, `Email: ${order.email || "-"}`, `Deliver to: ${address}`, "",
    stockOk ? "Stock has been updated." : "WARNING: stock was short for this order. Restock or refund it.",
    "", `Open the admin panel: ${siteUrl()}admin/#orders`,
  ].join("\n"));

  if (order.email) {
    await sendMail(order.email, `Your Disom Baha order ${order.reference} is confirmed`, [
      `Hi ${order.customer_name},`, "",
      `Thank you for your order! We've received your payment of ${rupees(order.subtotal)}.`, "",
      `Order: ${order.reference}`, lines, "Delivery: Free", `Total paid: ${rupees(order.subtotal)}`, "",
      `We'll deliver to: ${address}`, "",
      `Track your order any time: ${siteUrl()}track.html?ref=${encodeURIComponent(order.reference)}`,
      "(You'll need this order number and your phone number.)", "",
      "If anything isn't right, just reply to this email.", "", "Disom Baha",
    ].join("\n"));
  }
}

// Marks a Razorpay order paid and, the first time only, sends the emails.
async function recordPaid(client: SupabaseClient, razorpayOrderId: string, paymentId: string, amount: number) {
  const { data, error } = await client.rpc("mark_order_paid", {
    p_razorpay_order_id: razorpayOrderId, p_payment_id: paymentId, p_amount_paise: amount,
  });
  if (error) throw new Error(error.message);
  if (data?.newly_paid) later(emailPaidOrder(client, data.reference, data.stock_ok !== false));
  return data as { reference: string; newly_paid: boolean };
}

// ─── Routes ────────────────────────────────────────────────────────────────

async function createPayment(req: Request) {
  if (!paymentsReady()) return fail("Online payment isn't set up yet. Please message us on WhatsApp.", 503);
  const body = await req.json().catch(() => null);
  const reference = String(body?.reference ?? "");
  if (!REFERENCE.test(reference)) return fail("Invalid order reference");
  const client = db();

  // A retry of the same checkout reuses its Razorpay order.
  const existing = await client.from("orders").select("subtotal, payment_status, razorpay_order_id").eq("reference", reference).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) {
    if (existing.data.payment_status === "pending" && existing.data.razorpay_order_id) {
      return json({ key: env("RAZORPAY_KEY_ID"), order_id: existing.data.razorpay_order_id, amount: existing.data.subtotal * 100, currency: "INR", reference });
    }
    return fail("This order was already placed. Please refresh the page to start a new checkout.", 409);
  }

  const customer = body?.customer ?? {};
  if (!String(customer.email ?? "").trim()) return fail("Please add your email address so we can send your receipt.");
  const placed = await client.rpc("place_order", {
    p_reference: reference,
    p_customer: { ...customer, payment: "Online (Razorpay)" },
    p_items: Array.isArray(body?.items) ? body.items : [],
  });
  if (placed.error) return fail(placed.error.message);

  const { data: order, error } = await client.from("orders").select("id, subtotal").eq("reference", reference).single();
  if (error || !order) throw new Error(error?.message || "order missing after insert");
  try {
    const rzp = await razorpay("orders", {
      method: "POST",
      body: JSON.stringify({ amount: order.subtotal * 100, currency: "INR", receipt: reference, notes: { reference } }),
    });
    const saved = await client.from("orders").update({ razorpay_order_id: rzp.id, payment_status: "pending" }).eq("id", order.id);
    if (saved.error) throw new Error(saved.error.message);
    return json({ key: env("RAZORPAY_KEY_ID"), order_id: rzp.id, amount: rzp.amount, currency: rzp.currency, reference });
  } catch (rzpError) {
    console.error("create-payment", rzpError);
    await client.from("orders").update({ payment_status: "failed", admin_note: `Payment could not start: ${(rzpError as Error).message}` }).eq("id", order.id);
    return fail("We couldn't start the payment. Please try again in a minute.", 502);
  }
}

async function verifyPayment(req: Request) {
  if (!paymentsReady()) return fail("Online payment isn't set up yet.", 503);
  const body = await req.json().catch(() => null);
  const orderId = String(body?.razorpay_order_id ?? "");
  const paymentId = String(body?.razorpay_payment_id ?? "");
  const signature = String(body?.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) return fail("Missing payment details");

  const expected = await hmacHex(env("RAZORPAY_KEY_SECRET"), `${orderId}|${paymentId}`);
  if (!safeEqual(expected, signature)) return fail("This payment could not be verified.", 400);

  let payment = await razorpay(`payments/${encodeURIComponent(paymentId)}`);
  if (payment.order_id !== orderId) return fail("This payment does not belong to this order.", 400);
  if (payment.status === "authorized") {
    payment = await razorpay(`payments/${encodeURIComponent(paymentId)}/capture`, {
      method: "POST", body: JSON.stringify({ amount: payment.amount, currency: payment.currency }),
    });
  }
  if (payment.status !== "captured") return fail("The payment hasn't completed yet.", 409);

  const result = await recordPaid(db(), orderId, paymentId, payment.amount);
  return json({ reference: result.reference, paid: true });
}

async function razorpayWebhook(req: Request) {
  const secret = env("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) return fail("Webhook not configured", 503);
  const raw = await req.text();
  const expected = await hmacHex(secret, raw);
  if (!safeEqual(expected, req.headers.get("x-razorpay-signature") ?? "")) return fail("Invalid signature", 401);

  const event = JSON.parse(raw);
  const payment = event?.payload?.payment?.entity;
  const client = db();
  try {
    if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.order_id && payment.status === "captured") {
      await recordPaid(client, payment.order_id, payment.id, payment.amount);
    } else if (event.event === "payment.failed" && payment?.order_id) {
      const { error } = await client.rpc("set_order_payment_state", { p_razorpay_order_id: payment.order_id, p_payment_status: "failed" });
      if (error) throw new Error(error.message);
    } else if (event.event === "refund.processed" && payment?.order_id && payment.amount_refunded >= payment.amount) {
      const { error } = await client.rpc("set_order_payment_state", { p_razorpay_order_id: payment.order_id, p_payment_status: "refunded" });
      if (error) throw new Error(error.message);
    }
  } catch (error) {
    // Payments that aren't for a website order (or don't match it) are logged, not retried.
    console.error("webhook", event?.event, (error as Error).message);
  }
  return json({ ok: true });
}

async function contact(req: Request) {
  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  const from = String(body?.contact ?? "").trim();
  const message = String(body?.message ?? "").trim();
  const { error } = await db().rpc("submit_contact_message", { p_name: name, p_contact: from, p_message: message });
  if (error) return fail(error.message);
  later(sendMail(ownerEmail(), `New message from ${name.slice(0, 60)}`, [
    `From: ${name}`, `Phone or email: ${from}`, "", message, "", `Reply from the admin panel: ${siteUrl()}admin/#messages`,
  ].join("\n")));
  return json({ ok: true });
}

async function chatSend(req: Request) {
  const client = asUser(req);
  if (!client) return fail("Please sign in to chat.", 401);
  const body = await req.json().catch(() => null);
  const { data, error } = await client.rpc("chat_send", { p_body: String(body?.body ?? "") });
  if (error) return fail(error.message, /sign in|JWT|key|token|expired/i.test(error.message) ? 401 : 400);
  if (data?.notify_owner) {
    const who = [data.customer_name, data.customer_email && `<${data.customer_email}>`].filter(Boolean).join(" ") || "a customer";
    later(sendMail(ownerEmail(), `New chat message from ${String(data.customer_name || data.customer_email || "a customer").slice(0, 60)}`, [
      `New chat message from ${who}:`, "", data.message.body, "", `Reply in the admin panel: ${siteUrl()}admin/#chat`,
      "", "(You get one email per conversation until you reply.)",
    ].join("\n")));
  }
  return json({ message: data.message });
}

async function chatReply(req: Request) {
  const client = asUser(req);
  if (!client) return fail("Please sign in.", 401);
  const body = await req.json().catch(() => null);
  const { data, error } = await client.rpc("admin_chat_reply", { p_thread_id: String(body?.thread_id ?? ""), p_body: String(body?.body ?? "") });
  if (error) return fail(error.message, /JWT|key|token|expired/i.test(error.message) ? 401 : /authori[sz]ed/i.test(error.message) ? 403 : 400);
  let emailed = false;
  if (data?.notify_customer && data.customer_email) {
    emailed = true;
    later(sendMail(data.customer_email, "You have a new reply from Disom Baha", [
      `Hi${data.customer_name ? ` ${data.customer_name}` : ""},`, "",
      "We've replied to your message:", "", data.message.body, "",
      `Continue the conversation: ${siteUrl()}?chat=open`, "", "Disom Baha",
    ].join("\n")));
  }
  return json({ message: data.message, emailed });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("Not found", 404);
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    switch (route) {
      case "create-payment": return await createPayment(req);
      case "verify-payment": return await verifyPayment(req);
      case "razorpay-webhook": return await razorpayWebhook(req);
      case "contact": return await contact(req);
      case "chat-send": return await chatSend(req);
      case "chat-reply": return await chatReply(req);
      default: return fail("Not found", 404);
    }
  } catch (error) {
    console.error(route, error);
    return fail("Something went wrong. Please try again.", 500);
  }
}

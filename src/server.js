import "dotenv/config";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4000);
const origins = (process.env.FRONTEND_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const mailConfig = {
  host: (process.env.ZEPTOMAIL_HOST || "https://cpaas.zoho.com").replace(/\/$/, ""),
  apiKey: process.env.ZEPTOMAIL_API_KEY,
  fromAddress: process.env.MAIL_FROM_ADDRESS || "contact@app.patientsflow.co.uk",
  fromName: process.env.MAIL_FROM_NAME || "Patients Flow",
  inbox: process.env.CONTACT_INBOX || "contact@app.patientsflow.co.uk",
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const e164Pattern = /^\+[1-9]\d{7,14}$/;
const callingCodePattern = /^\+[1-9]\d{0,2}$/;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validEmail(value) {
  return value.length <= 254 && emailPattern.test(value);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function mailAddress(address, name) {
  return {
    email_address: { address, ...(name ? { name } : {}) },
  };
}

function safeProviderDetails(body, sensitiveValues) {
  const allowedKeys = new Set([
    "code",
    "error_code",
    "errorCode",
    "status",
    "request_id",
    "requestId",
    "message",
    "error",
    "description",
  ]);

  const redact = (value) => {
    let safeValue = String(value);
    for (const sensitiveValue of sensitiveValues) {
      if (sensitiveValue) {
        safeValue = safeValue.replaceAll(sensitiveValue, "[redacted]");
      }
    }
    return safeValue
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
      .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted phone]")
      .slice(0, 1000);
  };

  const pickSafeFields = (value, depth = 0) => {
    if (depth > 3) return "[details omitted]";
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) {
      return value.slice(0, 5).map((item) => pickSafeFields(item, depth + 1));
    }
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => allowedKeys.has(key))
        .slice(0, 10)
        .map(([key, item]) => [key, pickSafeFields(item, depth + 1)]),
    );
  };

  try {
    return pickSafeFields(JSON.parse(body));
  } catch {
    return { responseBody: "Non-JSON response omitted", responseLength: body.length };
  }
}

async function sendZeptoMail({ to, subject, text, html, replyTo }) {
  if (!mailConfig.apiKey) {
    throw new Error("ZeptoMail API key is not configured.");
  }

  const response = await fetch(`${mailConfig.host}/v1.1/email`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-enczapikey ${mailConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { address: mailConfig.fromAddress, name: mailConfig.fromName },
      to: [mailAddress(to.address, to.name)],
      ...(replyTo ? { reply_to: [{ address: replyTo.address, name: replyTo.name }] } : {}),
      subject,
      textbody: text,
      htmlbody: html,
      track_clicks: false,
      track_opens: false,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    const error = new Error(`ZeptoMail request failed with HTTP ${response.status}.`);
    error.providerDetails = {
      status: response.status,
      statusText: response.statusText,
      response: safeProviderDetails(responseBody, [
        mailConfig.apiKey,
        to.address,
        to.name,
        replyTo?.address,
        replyTo?.name,
        subject,
        text,
        html,
      ]),
    };
    throw error;
  }
}

function createRateLimiter(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });
}

export function createApp({ sendEmail = sendZeptoMail } = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || origins.includes(origin));
    },
  }));
  app.use(express.json({ limit: "16kb" }));

  app.use((request, response, next) => {
    request.requestId = randomUUID();
    response.setHeader("X-Request-Id", request.requestId);
    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/contact", createRateLimiter(5), async (request, response, next) => {
    const name = cleanString(request.body?.name);
    const email = cleanString(request.body?.email).toLowerCase();
    const phone = cleanString(request.body?.phone);
    const countryCode = cleanString(request.body?.countryCode);
    const enquiry = cleanString(request.body?.enquiry);

    if (
      name.length < 2 ||
      name.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !validEmail(email) ||
      !e164Pattern.test(phone) ||
      !callingCodePattern.test(countryCode) ||
      enquiry.length < 10 ||
      enquiry.length > 2000
    ) {
      return response.status(400).json({ error: "Please check the form fields and try again." });
    }

    try {
      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      const safePhone = escapeHtml(phone);
      const safeEnquiry = escapeHtml(enquiry).replace(/\n/g, "<br>");

      await sendEmail({
        to: { address: mailConfig.inbox },
        replyTo: { address: email, name },
        subject: "New website enquiry",
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n\nEnquiry:\n${enquiry}`,
        html: `<h2>Website enquiry</h2><p><strong>Name:</strong> ${safeName}</p><p><strong>Email:</strong> ${safeEmail}</p><p><strong>Phone:</strong> ${safePhone}</p><p><strong>Enquiry:</strong><br>${safeEnquiry}</p>`,
      });

      await sendEmail({
        to: { address: email, name },
        replyTo: { address: mailConfig.inbox, name: mailConfig.fromName },
        subject: "We received your message | Patients Flow",
        text: `Hello ${name},\n\nThank you for contacting Patients Flow. We have received your enquiry, and our team will get back to you shortly.\n\nYour submitted enquiry:\n${enquiry}\n\nIf you need to add anything, reply to this email and your message will reach our team.\n\nKind regards,\nPatients Flow\n${mailConfig.inbox}`,
        html: `<div style="margin:0;padding:32px 16px;background-color:#f4f7fa;font-family:Arial,Helvetica,sans-serif;color:#0f1d39"><div style="max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e5eaf0;border-radius:12px;overflow:hidden"><div style="padding:24px 32px;background-color:#0f1d39;color:#ffffff"><p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#9ce1dc">Patients Flow</p><h1 style="margin:12px 0 0;font-size:24px;line-height:1.3">We received your enquiry</h1></div><div style="padding:28px 32px"><p style="margin:0 0 16px">Hello ${safeName},</p><p style="margin:0 0 20px;line-height:1.6">Thank you for contacting Patients Flow. Our team has received your message and will get back to you shortly.</p><div style="padding:18px 20px;background-color:#f4f7fa;border-radius:8px"><p style="margin:0 0 10px;font-size:14px;font-weight:bold">Your submitted enquiry</p><p style="margin:0;line-height:1.6;white-space:normal">${safeEnquiry}</p></div><p style="margin:20px 0 0;line-height:1.6">If you need to add anything, reply to this email and your message will reach our team.</p><p style="margin:24px 0 0;line-height:1.6">Kind regards,<br><strong>Patients Flow</strong><br><a href="mailto:${escapeHtml(mailConfig.inbox)}" style="color:#087f79">${escapeHtml(mailConfig.inbox)}</a></p></div></div></div>`,
      });

      return response.status(200).json({ message: "Your message has been sent." });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/newsletter", createRateLimiter(3), async (request, response, next) => {
    const email = cleanString(request.body?.email).toLowerCase();

    if (!validEmail(email) || request.body?.consent !== true) {
      return response.status(400).json({ error: "Enter a valid email and agree to receive updates." });
    }

    try {
      const safeEmail = escapeHtml(email);

      await sendEmail({
        to: { address: mailConfig.inbox },
        subject: "New newsletter subscription",
        text: `A visitor subscribed to Patients Flow updates.\n\nEmail: ${email}`,
        html: `<p>A visitor subscribed to Patients Flow updates.</p><p><strong>Email:</strong> ${safeEmail}</p>`,
        replyTo: { address: email },
      });

      await sendEmail({
        to: { address: email },
        subject: "You're subscribed to Patients Flow updates",
        text: "Thanks for subscribing to Patients Flow updates. You can unsubscribe at any time by replying to this email.",
        html: "<p>Thanks for subscribing to Patients Flow updates.</p><p>You can unsubscribe at any time by replying to this email.</p>",
      });

      return response.status(200).json({ message: "Subscription confirmed." });
    } catch (error) {
      return next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found." });
  });

  app.use((error, request, response, _next) => {
    console.error("Request failed:", {
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      ...(error.providerDetails ? { provider: error.providerDetails } : {}),
    });
    if (response.headersSent) return;
    response.status(500).json({ error: "Unable to process your request right now. Please try again later." });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  createApp().listen(PORT, () => {
    console.log(`Patients Flow mail API listening on port ${PORT}`);
  });
}

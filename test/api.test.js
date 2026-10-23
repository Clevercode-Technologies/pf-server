import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.ZEPTOMAIL_API_KEY = "test-zeptomail-key";
const { createApp } = await import("../src/server.js");

let sentEmails = [];
let server;
let baseUrl;

before(async () => {
  server = createApp({
    sendEmail: async (message) => {
      sentEmails.push(message);
    },
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("health endpoint confirms the API is running", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("contact form sends an inbox email and an acknowledgement", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "+447123456789",
      countryCode: "+44",
      enquiry: "<script>alert(1)</script>\nI would like to learn more.",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(sentEmails.length, 2);
  assert.equal(sentEmails[0].to.address, "contact@app.patientsflow.co.uk");
  assert.equal(sentEmails[0].replyTo.address, "jane@example.com");
  assert.match(sentEmails[0].html, /&lt;script&gt;/);
  assert.match(sentEmails[0].html, /\+447123456789/);
  assert.equal(sentEmails[1].to.address, "jane@example.com");
  assert.equal(sentEmails[1].replyTo.address, "contact@app.patientsflow.co.uk");
  assert.match(sentEmails[1].subject, /We received your message/);
  assert.match(sentEmails[1].html, /We received your enquiry/);
  assert.match(sentEmails[1].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(sentEmails[1].html, /<script>/);
  assert.match(sentEmails[1].text, /I would like to learn more\./);
});

test("contact form rejects header-injection characters in names", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane\r\nBcc: attacker@example.com",
      email: "jane@example.com",
      phone: "+447123456789",
      countryCode: "+44",
      enquiry: "I would like to learn more.",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("invalid contact form input is rejected without sending email", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "J", email: "invalid", enquiry: "Short" }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("contact form rejects non-E.164 phone numbers", async () => {
  sentEmails = [];
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "07123 456789",
      countryCode: "+44",
      enquiry: "I would like to learn more.",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(sentEmails.length, 0);
});

test("newsletter requires explicit consent and confirms a valid subscription", async () => {
  sentEmails = [];
  const denied = await fetch(`${baseUrl}/api/newsletter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jane@example.com", consent: false }),
  });
  assert.equal(denied.status, 400);
  assert.equal(sentEmails.length, 0);

  const accepted = await fetch(`${baseUrl}/api/newsletter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jane@example.com", consent: true }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(sentEmails.length, 2);
  assert.equal(sentEmails[0].to.address, "contact@app.patientsflow.co.uk");
  assert.equal(sentEmails[1].to.address, "jane@example.com");
});

test("ZeptoMail failures log safe provider diagnostics and keep the response generic", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const loggedErrors = [];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "INVALID_AGENT_KEY",
        message: "Request rejected for jane@example.com",
      }),
      { status: 500, statusText: "Internal Server Error" },
    );
  console.error = (...args) => loggedErrors.push(args);

  try {
    const appServer = createApp().listen(0);
    await new Promise((resolve) => appServer.once("listening", resolve));
    const appUrl = `http://127.0.0.1:${appServer.address().port}`;
    const response = await originalFetch(`${appUrl}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Jane Smith",
        email: "jane@example.com",
        phone: "+447123456789",
        countryCode: "+44",
        enquiry: "Private enquiry details should not appear in logs.",
      }),
    });
    const responseBody = await response.json();
    await new Promise((resolve, reject) => {
      appServer.close((error) => (error ? reject(error) : resolve()));
    });

    assert.equal(response.status, 500);
    assert.match(response.headers.get("x-request-id"), /^[\da-f-]{36}$/i);
    assert.deepEqual(responseBody, {
      error: "Unable to process your request right now. Please try again later.",
    });
    assert.equal(loggedErrors.length, 1);

    const logOutput = JSON.stringify(loggedErrors[0]);
    assert.match(logOutput, /INVALID_AGENT_KEY/);
    assert.match(logOutput, /HTTP 500/);
    assert.doesNotMatch(logOutput, /jane@example\.com|test-zeptomail-key|Private enquiry details/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

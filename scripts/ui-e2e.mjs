// Browser E2E (customer widget + agent console). Needs: npm i -D playwright-core, Microsoft Edge installed, agents alice/bob created.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const mk = async () => { const ctx = await browser.newContext(); const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; };
const agent = await mk(), cust = await mk();
const ok = (l, v, d = "") => { console.log(`${v ? "PASS" : "FAIL"}  ${l}${d ? "  — " + d : ""}`); if (!v) process.exitCode = 1; };

// agent signs in + goes online
await agent.goto("http://localhost:8008/agent/");
await agent.fill("input[autocomplete=username]", "agent_alice");
await agent.fill("input[type=password]", "alice-pass-123");
await agent.click("button[type=submit]");
await agent.getByText("Agent console").first().waitFor({ timeout: 30000 });
await agent.getByRole("button", { name: /Offline/ }).click();
await agent.getByRole("button", { name: /Online/ }).waitFor();
ok("agent signed in and online", true);

await agent.waitForTimeout(1500);
const before = await agent.locator('.row').count();
// customer asks for a human
await cust.goto("http://localhost:8008/");
await cust.locator("#support-chat-host >> .sc-fab").click();
await cust.locator(".sc-footer input").waitFor({ timeout: 30000 });
await cust.fill(".sc-footer input", "I want to talk to a human, my invoice is wrong.");
await cust.click(".sc-footer button[type=submit]");

// queue shows it under "My conversations"
await agent.waitForFunction((n) => document.querySelectorAll(".row").length > n, before, { timeout: 45000 });
const row = agent.locator(".row").last();
ok("conversation appears in agent queue", true, (await row.innerText()).replace(/\n/g, " | ").slice(0, 100));
await row.click();
await agent.locator(".msg.summary").waitFor({ timeout: 30000 }).catch(async (e) => { console.log("AGENT PAGE TEXT:", (await agent.locator("body").innerText()).slice(0, 800)); throw e; });
ok("AI summary highlighted for agent", true);
ok("agent sees customer's message in history", (await agent.locator(".timeline").innerText()).includes("invoice is wrong"));

// customer sees "Agent joined", agent replies
await cust.getByText(/Agent .* joined/).waitFor({ timeout: 30000 });
ok("customer widget shows 'Agent … joined'", true);
await agent.fill(".composer input", "Hi, Alice here. Looking at it now.");
await agent.click(".composer button[type=submit]");
await cust.getByText("Hi, Alice here. Looking at it now.").waitFor({ timeout: 20000 });
ok("customer receives agent reply", true);
ok("customer does NOT see the internal summary", !(await cust.locator(".sc-messages").innerText()).includes("Summary:"));

// resolve back to AI
await agent.getByRole("button", { name: /back to AI/ }).click();
await agent.locator(".queue").waitFor({ timeout: 20000 });
await cust.getByText(/chatting with our AI assistant again/).waitFor({ timeout: 20000 });
ok("resolve returns to queue; customer told AI is back", true);
console.log("page errors:", errors);
await browser.close();

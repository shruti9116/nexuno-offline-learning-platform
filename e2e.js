
"use strict";

const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTeacherCount(page, expected) {
  for (let i = 0; i < 30; i++) {
    const count = await page.evaluate(async () => {
      const response = await fetch("/api/teacher");
      const data = await response.json();
      return data.attempts.length;
    });

    if (count === expected) return count;
    await sleep(500);
  }

  throw new Error("Teacher submission count did not reach " + expected);
}

(async () => {
  let browser;

  try {
    // Confirm that the server is running.
    const health = await fetch(BASE_URL + "/api/catalog");
    assert.equal(health.status, 200, "NEXUNO server is not responding");

    // Start with clean demo data.
    const reset = await fetch(BASE_URL + "/api/demo/reset", {
      method: "POST"
    });
    assert.equal(reset.status, 200, "Could not reset demo data");

    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext();
    const page = await context.newPage();

    page.setDefaultTimeout(15000);

    console.log("1. Opening NEXUNO Learn...");
    await page.goto(BASE_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Reload once so the service worker controls the page.
    await page.reload();
    await page.locator("#catalog .dl").first().waitFor();

    console.log("2. Downloading a lesson...");
    await page.locator("#catalog .dl").first().click();
    await page.getByText(/Downloaded:/).waitFor();

    console.log("3. Going offline...");
    await context.setOffline(true);

    console.log("4. Opening the downloaded lesson...");
    await page.reload();

    await page.locator("#catalog .open").first().waitFor();
    await page.locator("#catalog .open").first().click();

    await page.locator("#takeQuiz").click();

    console.log("5. Answering all quiz questions offline...");
    await page.locator('input[name="q1"][value="1"]').check();
    await page.locator('input[name="q2"][value="2"]').check();
    await page.locator('input[name="q3"][value="0"]').check();

    await page.locator("#submit").click();

    await page.locator("#t-attempts").click();
    await page.locator("#rows tr[data-id]").first().waitFor();

    const attemptId = await page
      .locator("#rows tr[data-id]")
      .first()
      .getAttribute("data-id");

    assert.ok(attemptId, "Attempt ID was not saved");

    console.log("6. Reloading while offline...");
    await page.reload();

    await page.locator("#t-attempts").click();

    await page.locator(
      '#rows tr[data-id="' + attemptId + '"]'
    ).waitFor();

    let status = await page
      .locator('#rows tr[data-id="' + attemptId + '"] .st')
      .textContent();

    assert.match(status, /Pending/i, "Offline attempt was not restored");

    console.log("7. Preparing to interrupt the first upload...");
    await page.locator("#simDrop").check();

    console.log("8. Reconnecting...");
    await context.setOffline(false);

    // The server stores the attempt, then interrupts its response.
    await page.waitForFunction((id) => {
      const row = document.querySelector(
        '#rows tr[data-id="' + id + '"] .st'
      );
      return row && /Failed/i.test(row.textContent);
    }, attemptId);

    console.log("9. Retrying the interrupted upload...");
    await page.locator(
      '#rows tr[data-id="' + attemptId + '"] .retry'
    ).click();

    await page.waitForFunction((id) => {
      const row = document.querySelector(
        '#rows tr[data-id="' + id + '"] .st'
      );
      return row && /Synced/i.test(row.textContent);
    }, attemptId);

    console.log("10. Checking the teacher dashboard...");
    const count = await waitForTeacherCount(page, 1);

    assert.equal(count, 1, "Duplicate submission detected");

    const teacherData = await page.evaluate(async () => {
      const response = await fetch("/api/teacher");
      return response.json();
    });

    assert.equal(
      teacherData.attempts[0].id,
      attemptId,
      "Teacher received a different attempt ID"
    );

    console.log("");
    console.log("SUCCESS: NEXUNO offline-sync test passed!");
    console.log("Attempt ID:", attemptId);
    console.log("Teacher submissions:", count);
    console.log("Duplicate submissions: 0");

    await context.close();

  } catch (error) {
    console.error("TEST FAILED:", error);
    process.exitCode = 1;

  } finally {
    if (browser) await browser.close();
  }
})();

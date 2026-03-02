/**
 * WORKER.JS v6.1
 * Tất cả selectors được gán đúng từ const SELECTORS
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { simpleParser } = require("mailparser");
const imaps = require("imap-simple");

// ============================================================================
// CONFIG
// ============================================================================

const configPath = process.argv[2];
if (!configPath || !fs.existsSync(configPath)) {
  console.error("❌ Worker config not found:", configPath);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const DATA_DIR = path.isAbsolute(cfg.dataDir)
  ? cfg.dataDir
  : path.join(__dirname, cfg.dataDir);
const INPUT_FILE = path.join(DATA_DIR, "input.txt");
const OUTPUT_FILE = path.join(DATA_DIR, "success.txt");
const FAILED_FILE = path.join(DATA_DIR, "failed.txt");
const SCREENSHOT_DIR = path.join(DATA_DIR, "screenshots");
const HOTMAIL_FILE = cfg.hotmailFile
  ? path.isAbsolute(cfg.hotmailFile)
    ? cfg.hotmailFile
    : path.join(__dirname, cfg.hotmailFile)
  : path.join(DATA_DIR, "hotmail.txt");

// ============================================================================
// SELECTORS — nguồn sự thật duy nhất, dùng xuyên suốt code
// ============================================================================

const SELECTORS = {
  EMAIL_VERIFICATION: {
    CHECK_EMAIL_TEXT: "Check your email",
    INPUT: [
      'input[id^="_r_"]',
      'input[type="text"][autocomplete="off"]',
      'input[aria-invalid="false"]',
      "input.x1i10hfl",
    ],
    CONTINUE_TEXT: "Continue",
  },

  TWO_FA: {
    USERNAME_DIV:
      "div.x1qjc9v5.x9f619.x78zum5.xdl72j9.xdt5ytf.x2lah0s.x2lwn1j.xeuugli.x1n2onr6.x1ja2u2z",
    AUTH_APP_DIV: "div.x1lliihq",
    SECRET_SPAN: "span.x1lliihq",
    CONTINUE_TEXT: "Continue",
    NEXT_TEXT: "Next",
    CANNOT_CHANGE_TEXT: "You can't make this change at the moment",
    VERIFICATION_INPUT: [
      'input[name="verificationCode"]',
      'input[name="confirmationCode"]',
      'input[placeholder*="6"]',
      'input[placeholder*="code"]',
      'input[maxlength="6"]',
      'input[type="text"]',
    ],
  },

  HOTMAIL: {
    EMAIL_INPUT: [
      'input[type="text"][aria-invalid="false"]',
      'input[dir="ltr"][type="text"]',
      "input.x1i10hfl.xggy1nq",
    ],
    CHECKBOX: 'input[type="checkbox"]',
    NEXT_BUTTON_TEXT: "Next",
    CODE_INPUT: [
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"][maxlength="6"]',
      'input[type="text"][maxlength="6"]',
    ],
    SUCCESS_TEXT: "You have added your email address to the selected accounts",
  },
};

// ============================================================================
// LOGGING
// ============================================================================

function log(msg) {
  if (process.send) process.send({ type: "log", text: msg });
  console.log(msg);
}

function logProgress(data) {
  if (process.send) process.send({ type: "progress", ...data });
}

// ============================================================================
// UTILITY
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeClosePage(page) {
  if (page)
    try {
      await page.close();
    } catch (_) {}
}

async function safeCloseBrowser(browser) {
  if (browser)
    try {
      await browser.close();
    } catch (_) {}
}

async function safeScreenshot(page, filepath) {
  try {
    await page.screenshot({ path: filepath, fullPage: true });
    log(`📸 ${filepath}`);
  } catch (_) {}
}

async function gotoIG(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.browserTimeout || 30000,
    });
  } catch (e) {
    if (
      e.message.includes("ERR_ABORTED") ||
      e.message.includes("net::ERR_") ||
      e.message.includes("Navigation timeout") ||
      e.message.includes("frame was detached")
    ) {
      log(`⚠️ gotoIG ignored: ${e.message.substring(0, 80)}`);
    } else throw e;
  }
  await sleep(500);
}

async function gotoAccountsCenter(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: cfg.browserTimeout || 30000,
    });
    await sleep(1000);
    return;
  } catch (e) {
    if (
      e.message.includes("ERR_ABORTED") ||
      e.message.includes("net::ERR_") ||
      e.message.includes("Navigation timeout") ||
      e.message.includes("frame was detached")
    ) {
      log(`⚠️ networkidle fallback: ${e.message.substring(0, 60)}`);
    } else throw e;
  }
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.browserTimeout || 30000,
    });
  } catch (e) {
    if (!e.message.includes("ERR_ABORTED") && !e.message.includes("net::ERR_"))
      throw e;
  }
  await sleep(4000);
}

async function waitForText(page, text, timeout = 10000) {
  try {
    await page.waitForFunction(
      (searchText) => {
        return Array.from(document.querySelectorAll("*")).some((el) =>
          el.textContent.trim().includes(searchText),
        );
      },
      text,
      { timeout },
    );
    return true;
  } catch (_) {
    log(`⚠️ Timeout waiting for text: "${text}"`);
    return false;
  }
}

async function tryInputSelectors(page, selectors, value, clickFirst = true) {
  for (const selector of selectors) {
    try {
      const input = await page.$(selector);
      if (input) {
        if (clickFirst) {
          await input.click();
          await sleep(cfg.delayShort || 500);
        }
        await input.type(value, { delay: cfg.delayInputType || 100 });
        log(`✓ Input OK: ${selector}`);
        return true;
      }
    } catch (e) {
      log(`⚠️ Selector fail ${selector}: ${e.message}`);
    }
  }
  return false;
}

// ============================================================================
// PLAYWRIGHT
// ============================================================================

function getPlaywright() {
  try {
    return require("playwright-core");
  } catch (_) {}
  try {
    return require("playwright");
  } catch (_) {}
  throw new Error(
    "Playwright not installed!\nRun: npm install playwright-core && npx playwright install chromium",
  );
}

async function launchBrowser(proxyUrl = null) {
  const pw = getPlaywright();
  const opts = {
    headless: cfg.headless === true || cfg.headless === "true",
    executablePath: cfg.chromePath || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--lang=en-US",
      "--accept-lang=en-US",
      `--window-size=${cfg.windowSize || "1280,800"}`,
    ],
  };
  if (proxyUrl) opts.proxy = { server: proxyUrl };
  return pw.chromium.launch(opts);
}

async function newPage(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  return context.newPage();
}

// ============================================================================
// COOKIES
// ============================================================================

function normalizeSameSite(val) {
  if (!val) return "Lax";
  const v = val.toString().toLowerCase();
  if (v === "strict") return "Strict";
  if (v === "none" || v === "no_restriction") return "None";
  return "Lax";
}

async function importCookies(page, cookieString) {
  const raw = JSON.parse(cookieString);
  const cookies = raw
    .filter((c) => c.name && c.value !== undefined && c.value !== null)
    .map((c) => {
      const cookie = {
        name: c.name,
        value: String(c.value),
        domain: c.domain || ".instagram.com",
        path: c.path || "/",
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: normalizeSameSite(c.sameSite),
      };
      if (
        c.expirationDate &&
        isFinite(c.expirationDate) &&
        c.expirationDate > 0
      ) {
        cookie.expires = Math.floor(c.expirationDate);
      }
      return cookie;
    });
  await page.context().addCookies(cookies);
  log(`✓ Cookies imported: ${cookies.length}`);
}

// ============================================================================
// IMAP
// ============================================================================

function extractVerificationCode(textContent, digitCount) {
  const pattern = new RegExp(`\\b\\d{${digitCount}}\\b`);
  const match = textContent.match(pattern);
  return match ? match[0] : null;
}

async function getVerificationCodeFromEmail(email, password, digitCount) {
  const imapCfg = {
    imap: {
      user: email,
      password,
      host: cfg.gmxImapHost || "imap.gmx.net",
      port: cfg.gmxImapPort || 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };

  log(`📧 IMAP: ${email} (${digitCount}-digit)`);
  const connection = await imaps.connect(imapCfg);
  await connection.openBox("INBOX");

  const searchStartTime = new Date();
  const maxRetries = cfg.gmxMaxRetries || 10;
  const retryDelay = cfg.gmxRetryDelay || 5000;

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log(`🔍 Email attempt ${attempt}/${maxRetries}`);
      const messages = await connection.search([["FROM", "Instagram"]], {
        bodies: ["HEADER", "TEXT", ""],
        markSeen: false,
      });

      if (messages.length > 0) {
        const emailsWithTime = [];
        for (const message of messages) {
          const all = message.parts.find((p) => p.which === "");
          if (!all) continue;
          const parsed = await simpleParser(all.body);
          const emailTime = new Date(parsed.date);
          const bufferTime = new Date(searchStartTime.getTime() - 30000);
          if (emailTime >= bufferTime) {
            const code = extractVerificationCode(
              parsed.text || parsed.html || "",
              digitCount,
            );
            if (code)
              emailsWithTime.push({
                uid: message.attributes.uid,
                date: emailTime,
                code,
              });
          }
        }
        emailsWithTime.sort((a, b) => b.date - a.date);
        if (emailsWithTime.length > 0) {
          const latest = emailsWithTime[0];
          await connection.addFlags(latest.uid, "\\Seen");
          log(`✓ Code: ${latest.code}`);
          return latest.code;
        }
      }

      if (attempt < maxRetries) {
        log(`⏳ Waiting ${retryDelay / 1000}s...`);
        await sleep(retryDelay);
      }
    }
    throw new Error(`Code not found after ${maxRetries} attempts`);
  } finally {
    try {
      connection.end();
    } catch (_) {}
  }
}

// ============================================================================
// 2FA TOKEN
// ============================================================================

async function get2FAToken(secret) {
  const url = `${cfg.twoFaApiUrl || "https://2fa.live/tok"}/${secret}`;
  log(`🔑 Fetching 2FA token...`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("2FA API timeout")),
      10000,
    );
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(data).token);
          } catch (e) {
            reject(new Error(`Invalid 2FA response: ${data}`));
          }
        });
      })
      .on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
  });
}

// ============================================================================
// PROXY
// ============================================================================

async function get9ProxyList() {
  const url = `${cfg.proxyApiUrl}?t=2&num=${cfg.proxyCount}&country=${cfg.proxyCountry}`;
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const timeout = setTimeout(() => reject(new Error("Proxy timeout")), 15000);
    proto
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          clearTimeout(timeout);
          try {
            const json = JSON.parse(data);
            if (json.error !== false) throw new Error(json.message);
            resolve(json.data);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
  });
}

// ============================================================================
// HOTMAIL
// ============================================================================

function readHotmailFile() {
  if (!fs.existsSync(HOTMAIL_FILE)) {
    log("⚠️ hotmail.txt not found");
    return [];
  }
  return fs
    .readFileSync(HOTMAIL_FILE, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const p = line.split("|");
      if (p.length < 4) {
        log(`⚠️ Hotmail line ${i + 1}: invalid, skipping`);
        return null;
      }
      return {
        hotmail: p[0]?.trim() || "",
        hotmailPassword: p[1]?.trim() || "",
        refreshToken: p[2]?.trim() || "",
        clientId: p[3]?.trim() || "",
      };
    })
    .filter(Boolean);
}

/**
 * getHotmailVerificationCode
 * Dùng SELECTORS.HOTMAIL không (dongvanfb.net có selector riêng)
 * Giữ nguyên selector gốc của site đó
 */
async function getHotmailVerificationCode(page, hotmailData) {
  const url = cfg.hotmailApiUrl || "https://dongvanfb.net/read_mail_box/";
  const emailLine = `${hotmailData.hotmail}|${hotmailData.hotmailPassword}|${hotmailData.refreshToken}|${hotmailData.clientId}`;
  const maxRetries = cfg.hotmailMaxRetries || 10;

  log(`📧 Getting hotmail code: ${hotmailData.hotmail}`);
  const mailPage = await page.context().newPage();

  try {
    await mailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log(`🔍 Hotmail attempt ${attempt}/${maxRetries}`);
      try {
        await mailPage.waitForSelector("#list_email", { timeout: 10000 });
        await mailPage.evaluate(
          ({ text }) => {
            const input = document.querySelector("#list_email");
            if (!input) return;
            input.value = text;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          },
          { text: emailLine },
        );

        await mailPage.click(".btn-checked");
        await mailPage.waitForSelector("td.readmail_code span[id]", {
          timeout: 15000,
        });
        const code = await mailPage.$eval("td.readmail_code span[id]", (el) =>
          el.textContent.trim(),
        );

        if (/^\d{6}$/.test(code)) {
          log(`✓ Hotmail code: ${code}`);
          return code;
        }
      } catch (err) {
        log(`⚠️ Hotmail attempt ${attempt}: ${err.message.substring(0, 60)}`);
      }
      await sleep(5000);
      try {
        await mailPage.reload({ waitUntil: "domcontentloaded" });
      } catch (_) {}
    }
    throw new Error("Cannot get hotmail code after retries");
  } finally {
    try {
      await mailPage.close();
    } catch (_) {}
  }
}

function removeHotmailFromFile(hotmail) {
  try {
    if (!fs.existsSync(HOTMAIL_FILE)) return;
    const content = fs.readFileSync(HOTMAIL_FILE, "utf-8");
    const remaining = content
      .trim()
      .split("\n")
      .filter((line) => line.split("|")[0]?.trim() !== hotmail);
    fs.writeFileSync(
      HOTMAIL_FILE,
      remaining.join("\n") + (remaining.length ? "\n" : ""),
      "utf-8",
    );
    log(`🗑️ Removed hotmail: ${hotmail}`);
  } catch (e) {
    log(`⚠️ Remove hotmail error: ${e.message}`);
  }
}

// ============================================================================
// FILE I/O
// ============================================================================

function readInputFile() {
  return fs
    .readFileSync(INPUT_FILE, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const p = line.split("|");
      if (p.length < 7) throw new Error(`Line ${i + 1}: need 7+ fields`);
      return {
        username: p[0]?.trim() || "",
        password: p[1]?.trim() || "",
        igEmail: p[2]?.trim() || "",
        gmxMail: p[3]?.trim() || "",
        gmxPassword: p[4]?.trim() || "",
        posts: p[5]?.trim() || "",
        followers: p[6]?.trim() || "",
        following: p[7]?.trim() || "",
        cookies: p[8]?.trim() || "",
      };
    });
}

function writeSuccessAccount(account, twoFA, hotmailData) {
  const safeTwoFA = twoFA.includes(" ")
    ? twoFA
    : (twoFA.match(/.{1,4}/g) || [twoFA]).join(" ");
  const line =
    [
      account.username,
      account.password,
      safeTwoFA,
      account.igEmail,
      account.gmxMail,
      account.gmxPassword,
      account.posts,
      account.followers,
      account.following,
      hotmailData?.hotmail || "",
      hotmailData?.hotmailPassword || "",
      hotmailData?.refreshToken || "",
      hotmailData?.clientId || "",
      account.cookies || "",
    ].join("|") + "\n";
  fs.appendFileSync(OUTPUT_FILE, line, "utf-8");
}

function writeFailedAccount(account, reason) {
  const line = `${account.username}|${account.password}|${account.igEmail}|${account.gmxMail}|${account.gmxPassword}|${account.posts}|${account.followers}|${account.following}|${account.cookies}|${reason}\n`;
  fs.appendFileSync(FAILED_FILE, line, "utf-8");
  log(`📝 Failed: ${account.username} — ${reason}`);
}

function removeAccountFromInput(username) {
  try {
    const content = fs.readFileSync(INPUT_FILE, "utf-8");
    const remaining = content
      .trim()
      .split("\n")
      .filter((line) => line.split("|")[0]?.trim() !== username);
    fs.writeFileSync(
      INPUT_FILE,
      remaining.join("\n") + (remaining.length ? "\n" : ""),
      "utf-8",
    );
    log(`🗑️ Removed: ${username}`);
  } catch (e) {
    log(`⚠️ Remove error: ${e.message}`);
  }
}

// ============================================================================
// INSTAGRAM HANDLERS
// ============================================================================

async function handleEmailVerificationIfNeeded(page, account) {
  console.log("🔍 Checking email verification...");
  await sleep(cfg.delayAfterClick || 2000);

  const checkEmailExists = await page.evaluate(
    ({ checkText }) => {
      const spans = Array.from(document.querySelectorAll("span"));
      return spans.some(
        (span) =>
          span.textContent.trim() === checkText &&
          span.className.includes("x1ill7wo"),
      );
    },
    { checkText: SELECTORS.EMAIL_VERIFICATION.CHECK_EMAIL_TEXT },
  );

  if (!checkEmailExists) {
    log("✓ No email verification required");
    return true;
  }

  log("⚠️ Email verification required!");
  await sleep(cfg.delayExtraLong || 5000);

  const code8Digit = await getVerificationCodeFromEmail(
    account.igEmail,
    account.gmxPassword,
    8,
  );
  log(`✓ Code: ${code8Digit}`);

  const inputSuccess = await tryInputSelectors(
    page,
    SELECTORS.EMAIL_VERIFICATION.INPUT,
    code8Digit,
  );
  if (!inputSuccess)
    throw new Error("Could not find input for verification code");

  await sleep(cfg.delayMedium || 2000);

  await page.evaluate(
    ({ continueText }) => {
      const spans = Array.from(document.querySelectorAll("span"));
      const continueBtn = spans.find(
        (s) => s.textContent.trim() === continueText,
      );
      if (continueBtn) continueBtn.closest('div[role="none"]').click();
    },
    { continueText: SELECTORS.EMAIL_VERIFICATION.CONTINUE_TEXT },
  );

  await sleep(cfg.delayPageLoad || 3000);
  log("✓ Email verification done");
  return true;
}

async function handlePostSetupDialogs(page, account) {
  log("🔍 Post-2FA dialogs...");
  await sleep(cfg.delayPageLoad || 3000);

  const currentUrlFast = page.url();
  log(`   URL: ${currentUrlFast}`);

  if (currentUrlFast.includes("/terms/unblock/")) {
    log("📜 Terms & Conditions");
    await sleep(4000);

    const nextClicked = await page.evaluate(
      ({ nextText }) => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="button"]'),
        );
        const nextBtn = buttons.find(
          (btn) => btn.textContent.trim() === nextText,
        );
        if (nextBtn) {
          nextBtn.click();
          return true;
        }
        return false;
      },
      { nextText: SELECTORS.TWO_FA.NEXT_TEXT },
    );
    if (nextClicked) {
      log("✓ Clicked Next");
      await sleep(cfg.delayPageLoad || 3000);
    }

    await sleep(cfg.delayMedium || 2000);

    const agreeClicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('div[role="button"]'),
      );
      const agreeBtn = buttons.find(
        (btn) => btn.textContent.trim() === "Agree to Terms",
      );
      if (agreeBtn) {
        agreeBtn.click();
        return true;
      }
      return false;
    });
    if (agreeClicked) {
      log("✓ Clicked Agree");
      await sleep(cfg.delayPageLoad || 3000);
    }

    await sleep(cfg.delayMedium || 2000);
    const urlAfter = page.url();
    if (
      urlAfter.includes("/api/v1/discover/ayml/") ||
      urlAfter.includes("instagram.com")
    ) {
      await gotoIG(page, "https://www.instagram.com/");
      await sleep(cfg.delayPageLoad || 3000);
    }
    return true;
  }

  if (
    currentUrlFast.includes("instagram.com") &&
    !currentUrlFast.includes("challenge") &&
    !currentUrlFast.includes("accounts") &&
    !currentUrlFast.includes("terms")
  ) {
    log("🏠 Already at homepage");
    return true;
  }

  const isNewLook = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("span")).some((el) =>
      el.textContent.includes("The messaging tab has a new look"),
    );
  });
  if (isNewLook) {
    log("🏠 Homepage (new look)");
    return true;
  }

  const notNowClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
    const btn = buttons.find((b) => b.textContent.trim() === "Not now");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (notNowClicked) {
    log("✓ Clicked Not now");
    await sleep(cfg.delayPageLoad || 3000);
  }

  await sleep(cfg.delayShort || 500);

  const needsVerify = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("span")).some((el) =>
      el.textContent.includes("Help us confirm you own this account"),
    );
  });

  if (needsVerify) {
    log("⚠️ Account verification required");
    await safeScreenshot(
      page,
      path.join(SCREENSHOT_DIR, `${account.username}_verify_required.png`),
    );

    const sendCodeBtn = await page.$(
      'div[data-testid="primary-button"][aria-label="Send confirmation code"]',
    );
    if (sendCodeBtn) {
      await sendCodeBtn.click();
      log("📧 Confirmation code sent");
      await sleep(cfg.delayExtraLong || 5000);

      const code6Digit = await getVerificationCodeFromEmail(
        account.igEmail,
        account.gmxPassword,
        6,
      );
      log(`✓ 6-digit code: ${code6Digit}`);

      await page.waitForSelector('input[type="number"]', { timeout: 15000 });
      await page.click('input[type="number"]');
      await sleep(cfg.delayShort || 500);
      await page.type('input[type="number"]', code6Digit, {
        delay: cfg.delayInputType || 100,
      });
      await sleep(cfg.delayPageLoad || 3000);

      const yesBtn = await page.$(
        'div[data-testid="secondary-button"][aria-label="Yes, it\'s correct"]',
      );
      if (yesBtn) {
        await yesBtn.click();
        await sleep(cfg.delayPageLoad || 3000);
      }
    }
  }

  await sleep(cfg.delayExtraLong || 5000);

  const notNowClicked2 = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
    const btn = buttons.find((b) => b.textContent.trim() === "Not now");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (notNowClicked2) {
    log("✓ Clicked Not now (2nd)");
    await sleep(cfg.delayPageLoad || 3000);
  }

  log("✓ Post-setup done");
  return true;
}

// ============================================================================
// ADD HOTMAIL — dùng SELECTORS.HOTMAIL.*
// ============================================================================

async function addHotmailToAccount(page, account, hotmailData) {
  log(`\n📧 === ADDING HOTMAIL: ${hotmailData.hotmail} ===`);

  const ADD_EMAIL_URL =
    "https://accountscenter.instagram.com/personal_info/contact_points/?contact_point_type=email&dialog_type=add_contact_point";

  log("Navigating to add email page...");
  await gotoAccountsCenter(page, ADD_EMAIL_URL);
  await sleep(cfg.delayPageLoad || 3000);

  await waitForText(page, "Add an email address", 10000);
  await sleep(cfg.delayMedium || 2000);

  log("Entering hotmail address...");
  const emailInputSuccess = await tryInputSelectors(
    page,
    SELECTORS.HOTMAIL.EMAIL_INPUT,
    hotmailData.hotmail,
  );
  if (!emailInputSuccess) throw new Error("Could not find email input field");

  await sleep(cfg.delayMedium || 2000);

  log("Selecting Instagram account checkbox...");
  const checkboxClicked = await page.evaluate(
    ({ username }) => {
      const labels = Array.from(document.querySelectorAll("label"));
      for (const label of labels) {
        const usernameDiv = label.querySelector("div.x1qjc9v5.x9f619.x78zum5");
        if (usernameDiv && usernameDiv.textContent.includes(username)) {
          const checkbox = label.querySelector('input[type="checkbox"]');
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            return true;
          }
          return true; // already checked
        }
      }
      return false;
    },
    { username: account.username },
  );
  if (!checkboxClicked) log("⚠️ Checkbox not found, continuing...");

  await sleep(cfg.delayMedium || 2000);

  log("Clicking Next...");
  const nextClicked = await page.evaluate(
    ({ nextText }) => {
      const buttons = Array.from(
        document.querySelectorAll('div[role="button"]'),
      );
      const nextBtn = buttons.find((btn) => {
        const span = btn.querySelector("span");
        return span && span.textContent.trim() === nextText;
      });
      if (nextBtn) {
        nextBtn.click();
        return true;
      }
      return false;
    },
    { nextText: SELECTORS.HOTMAIL.NEXT_BUTTON_TEXT },
  );
  if (!nextClicked) throw new Error("Could not click Next button");

  await sleep(cfg.delayPageLoad || 3000);

  // GMX email verification nếu cần
  await handleEmailVerificationIfNeeded(page, account);

  log("Waiting for confirmation code dialog...");
  await waitForText(page, "Enter your confirmation code", 10000);
  await sleep(cfg.delayMedium || 2000);

  const maxCodeRetries = cfg.hotmailCodeRetries || 3;
  let codeVerified = false;

  for (let attempt = 1; attempt <= maxCodeRetries; attempt++) {
    log(`🔑 Code attempt ${attempt}/${maxCodeRetries}`);

    const verificationCode = await getHotmailVerificationCode(
      page,
      hotmailData,
    );
    log(`✓ Code: ${verificationCode}`);

    // Clear input nếu retry
    if (attempt > 1) {
      await page.evaluate(
        ({ selectors }) => {
          for (const sel of selectors) {
            const inp = document.querySelector(sel);
            if (inp) {
              inp.value = "";
              inp.dispatchEvent(new Event("input", { bubbles: true }));
              break;
            }
          }
        },
        { selectors: SELECTORS.HOTMAIL.CODE_INPUT },
      );
      await sleep(500);
    }

    const codeInputSuccess = await tryInputSelectors(
      page,
      SELECTORS.HOTMAIL.CODE_INPUT,
      verificationCode,
    );
    if (!codeInputSuccess)
      throw new Error("Could not find verification code input");

    await sleep(cfg.delayMedium || 2000);

    const finalNextClicked = await page.evaluate(
      ({ nextText }) => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="button"]'),
        );
        const nextBtns = buttons.filter((btn) => {
          const span = btn.querySelector("span");
          return span && span.textContent.trim() === nextText;
        });
        if (nextBtns.length > 0) {
          nextBtns[nextBtns.length - 1].click();
          return true;
        }
        return false;
      },
      { nextText: SELECTORS.HOTMAIL.NEXT_BUTTON_TEXT },
    );
    if (!finalNextClicked) throw new Error("Could not click final Next button");

    await sleep(cfg.delayPageLoad || 3000);

    const hasWrongCode = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      return spans.some(
        (s) =>
          s.textContent.includes("Wrong code") ||
          s.textContent.includes("That code didn't work"),
      );
    });

    if (hasWrongCode) {
      log(`❌ Wrong code, retrying...`);
      await sleep(cfg.delayMedium || 2000);
      continue;
    }

    log("✅ Code accepted!");
    codeVerified = true;
    break;
  }

  if (!codeVerified)
    throw new Error(
      `Failed to verify hotmail code after ${maxCodeRetries} attempts`,
    );

  log("Checking success...");
  try {
    await page.waitForFunction(
      ({ successText }) => {
        const spans = Array.from(document.querySelectorAll("span"));
        return spans.some((span) => {
          const t = span.textContent.trim();
          return (
            t.includes(successText) ||
            t.includes("You've added your email") ||
            t.includes("You have added your email") ||
            t.includes("added your email to the accounts")
          );
        });
      },
      { successText: SELECTORS.HOTMAIL.SUCCESS_TEXT },
      { timeout: 60000 },
    );
    log("✅ Hotmail added successfully!");
  } catch (_) {
    // Fallback check
    const hasOtherSign = await page.evaluate(
      ({ successText }) => {
        const spans = Array.from(document.querySelectorAll("span"));
        const hasText = spans.some((s) => {
          const t = s.textContent.trim().toLowerCase();
          return (
            t.includes(successText.toLowerCase()) ||
            t.includes("you've added") ||
            t.includes("you have added") ||
            t.includes("added your email")
          );
        });
        if (hasText) return true;
        const nextButtons = Array.from(
          document.querySelectorAll('div[role="button"]'),
        ).filter((btn) => {
          const span = btn.querySelector("span");
          return span && span.textContent.trim() === "Next";
        });
        return nextButtons.length === 0;
      },
      { successText: SELECTORS.HOTMAIL.SUCCESS_TEXT },
    );

    if (hasOtherSign) {
      log("✅ Success indicators detected (fallback)");
    } else {
      log("⚠️ No clear success indicator, continuing...");
    }
  }

  await sleep(cfg.delayMedium || 2000);
  await gotoIG(page, "https://www.instagram.com/");
  await sleep(cfg.delayPageLoad || 3000);
  await handlePostSetupDialogs(page, account);

  log(`✅ Hotmail ${hotmailData.hotmail} added to ${account.username}`);
  return true;
}

// ============================================================================
// ENABLE 2FA — logic từ script gốc, config/selectors từ worker
// ============================================================================

async function enable2FA(account, page, hotmailList, hotmailIndex, browser) {
  const TWO_FA_URL =
    "https://accountscenter.instagram.com/password_and_security/two_factor/";

  log(`\n=== Processing: ${account.username} ===`);

  let usedHotmail = null;

  try {
    // ── 1. Import cookies ────────────────────────────────────────────────
    log("Importing cookies...");
    await gotoIG(page, "https://www.instagram.com/");
    await sleep(cfg.delayMedium || 2000);
    await importCookies(page, account.cookies);

    // ── 2. Navigate to 2FA settings ──────────────────────────────────────
    log("Navigating to 2FA settings...");
    await gotoAccountsCenter(page, TWO_FA_URL);
    await sleep(cfg.delayAfterClick || 2000);

    // ── 3. Validate URL ───────────────────────────────────────────────────
    const currentUrl = page.url();
    log(`URL: ${currentUrl}`);

    let currentPath, expectedPath;
    try {
      currentPath = new URL(currentUrl).pathname;
      expectedPath = new URL(TWO_FA_URL).pathname;
    } catch (_) {
      currentPath = currentUrl;
      expectedPath = "/password_and_security/two_factor/";
    }

    if (currentPath !== expectedPath) {
      throw new Error(
        `Cannot access 2FA settings (wrong cookies), URL: ${currentUrl}`,
      );
    }

    await sleep(cfg.delayAfterClick || 2000);

    // ── 4. Unusual login ──────────────────────────────────────────────────
    const hasChallenge = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("h2")).some((h) =>
        h.innerText?.includes("We Detected An Unusual Login Attempt"),
      );
    });

    if (hasChallenge) {
      log("⚠️ Unusual login detected");
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="button"]'),
        );
        const closeBtn = buttons.find(
          (btn) => btn.innerText?.trim().toLowerCase() === "close",
        );
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
        return false;
      });
      if (!clicked) throw new Error("Could not close unusual login challenge");

      log("Retrying 2FA settings...");
      await gotoAccountsCenter(page, TWO_FA_URL);
      await sleep(cfg.delayAfterClick || 2000);
    }

    await sleep(cfg.delayPageLoad || 3000);

    // ── 5. Wait for username & click ──────────────────────────────────────
    console.log(`Enabling 2FA for ${account.username}...`);
    await waitForText(page, account.username, 12000);
    await sleep(cfg.delayMedium || 2000);

    await page.evaluate(
      ({ username, selector }) => {
        const divs = Array.from(document.querySelectorAll(selector));
        const targetDiv = divs.find((d) => d.textContent.trim() === username);

        if (targetDiv) {
          let clickableParent = targetDiv.closest(
            'a, button, [role="button"], [onclick]',
          );

          if (!clickableParent) {
            clickableParent = targetDiv.closest(".x9f619.x1ja2u2z.x78zum5");
          }

          if (clickableParent) {
            clickableParent.click();
          } else {
            targetDiv.parentElement.parentElement.parentElement.parentElement.parentElement.click();
          }
        }
      },
      { username: account.username, selector: SELECTORS.TWO_FA.USERNAME_DIV },
    );

    await sleep(cfg.delayPageLoad || 3000);

    // ── 6. Email mismatch check ───────────────────────────────────────────
    const emailMismatch = await page.evaluate(
      ({ expectedEmail, cannotChangeText }) => {
        const spans = Array.from(document.querySelectorAll("span"));

        const whatsappSpan = spans.find((s) => {
          const t = s.textContent.toLowerCase();
          return (
            t.includes("check your whatsapp") || t.includes("whatsapp messages")
          );
        });
        if (whatsappSpan)
          return {
            mismatch: true,
            type: "whatsapp_verification",
            displayed: "WhatsApp",
            reason: "Code sent to WhatsApp instead of email",
          };

        const cantChangeSpan = spans.find((s) => {
          const t = s.textContent.toLowerCase();
          return (
            t.includes("can't make this change") ||
            t.includes("cannot make this change") ||
            t.includes(cannotChangeText.toLowerCase())
          );
        });
        if (cantChangeSpan)
          return {
            mismatch: true,
            type: "cannot_make_change",
            displayed: "Cannot make this change",
            reason: "Instagram doesn't allow changes at this moment",
          };

        const codeSpan = spans.find((s) => {
          const t = s.textContent.toLowerCase();
          return (
            t.includes("enter the code we sent to") ||
            t.includes("enter the 6-digit code we sent to")
          );
        });
        if (!codeSpan) return { mismatch: false };

        const fullText = codeSpan.textContent;
        const emailMatch = fullText.match(/[a-zA-Z0-9*]+@[a-zA-Z0-9.*]+/);
        const phoneMatch = fullText.match(/\+?\d+[\d*]+/);

        if (emailMatch) {
          const displayedEmail = emailMatch[0];
          if (/^[A-Z]/.test(displayedEmail)) {
            return {
              mismatch: true,
              type: "uppercase_first_letter",
              displayed: displayedEmail,
              reason: "Email starts with uppercase letter",
            };
          }
          const displayedDomain = displayedEmail.split("@")[1]?.toLowerCase();
          const expectedDomain = expectedEmail.split("@")[1]?.toLowerCase();
          const gmxDomains = ["gmx.de", "gmx.net"];
          const getTLD = (d) => {
            const m = d?.match(/\.(\w+)$/);
            return m ? m[1] : null;
          };
          const displayedTLD = getTLD(displayedDomain);
          const expectedTLD = getTLD(expectedDomain);
          if (
            gmxDomains.includes(expectedDomain) &&
            ["net", "de"].includes(displayedTLD)
          )
            return { mismatch: false };
          if (expectedTLD && displayedTLD && displayedTLD !== expectedTLD) {
            return {
              mismatch: true,
              type: "domain_mismatch",
              displayed: displayedEmail,
              expected: expectedEmail,
              reason: `Domain mismatch: *.${displayedTLD} vs *.${expectedTLD}`,
            };
          }
        }

        if (phoneMatch && !emailMatch) {
          return {
            mismatch: true,
            type: "phone_number",
            displayed: phoneMatch[0],
            reason: "Code sent to phone number instead of email",
          };
        }

        return { mismatch: false };
      },
      {
        expectedEmail: account.igEmail,
        cannotChangeText: SELECTORS.TWO_FA.CANNOT_CHANGE_TEXT,
      },
    );

    if (emailMismatch.mismatch) {
      log(`⚠️ Mismatch: ${emailMismatch.type} — ${emailMismatch.reason}`);
      if (emailMismatch.displayed)
        log(`   Displayed: ${emailMismatch.displayed}`);
      if (emailMismatch.expected)
        log(`   Expected:  ${emailMismatch.expected}`);
      await safeScreenshot(
        page,
        path.join(
          SCREENSHOT_DIR,
          `${account.username}_${emailMismatch.type}.png`,
        ),
      );
      writeFailedAccount(
        account,
        `${emailMismatch.type}: ${emailMismatch.displayed} - ${emailMismatch.reason}`,
      );
      removeAccountFromInput(account.username);
      return {
        success: false,
        username: account.username,
        twoFA: "",
        hotmailData: null,
        error: `${emailMismatch.type}: ${emailMismatch.displayed}`,
      };
    }

    // ── 7. Email verification ─────────────────────────────────────────────
    await handleEmailVerificationIfNeeded(page, account);

    // ── 8. Check 2FA already on ───────────────────────────────────────────
    const twoFAIsOn = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      return spans.some(
        (s) => s.textContent.trim() === "Two-factor authentication is on",
      );
    });

    if (twoFAIsOn) {
      log("⚠️ 2FA already enabled for this account!");
      writeFailedAccount(account, "2FA already enabled");
      removeAccountFromInput(account.username);
      return {
        success: false,
        username: account.username,
        twoFA: "",
        hotmailData: null,
        error: "2FA already enabled",
      };
    }

    // ── 9. Select Duo Mobile ──────────────────────────────────────────────
    log("Selecting Authentication App...");
    await waitForText(page, "Duo Mobile", 10000);
    await sleep(cfg.delayMedium || 2000);

    await page.evaluate(
      ({ authAppDiv }) => {
        const divs = Array.from(document.querySelectorAll(authAppDiv));
        const target = divs.find(
          (d) =>
            d.textContent.includes("Duo Mobile") &&
            d.textContent.includes("Recommended"),
        );
        if (target) target.click();
      },
      { authAppDiv: SELECTORS.TWO_FA.AUTH_APP_DIV },
    );

    await sleep(cfg.delayAfterClick || 2000);

    // Click Continue
    await page.evaluate(
      ({ continueText }) => {
        const spans = Array.from(document.querySelectorAll("span"));
        const continueBtn = spans.find(
          (s) => s.textContent.trim() === continueText,
        );
        if (continueBtn) continueBtn.closest('div[role="none"]').click();
      },
      { continueText: SELECTORS.TWO_FA.CONTINUE_TEXT },
    );

    await sleep(cfg.delayPageLoad || 3000);

    // ── 10. Get 2FA Secret ────────────────────────────────────────────────
    log("Getting 2FA Secret...");
    await waitForText(page, "Set up two-factor authentication", 10000);
    await sleep(cfg.delayMedium || 2000);

    const twoFASecret = await page.evaluate(
      ({ secretSpan }) => {
        const spans = Array.from(document.querySelectorAll(secretSpan));
        const secretEl = spans.find((s) =>
          /^[A-Z2-7\s]+$/.test(s.textContent.trim()),
        );
        if (secretEl) return secretEl.textContent.trim().replace(/\s/g, "");
        return "";
      },
      { secretSpan: SELECTORS.TWO_FA.SECRET_SPAN },
    );

    if (!twoFASecret) {
      await safeScreenshot(
        page,
        path.join(SCREENSHOT_DIR, `${account.username}_no_secret.png`),
      );
      throw new Error("Could not find 2FA Secret");
    }
    log(`✓ Secret: ${twoFASecret}`);

    // Click Next
    await page.evaluate(
      ({ nextText }) => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="none"]'),
        );
        const nextBtn = buttons.find((btn) =>
          btn.textContent.includes(nextText),
        );
        if (nextBtn) nextBtn.click();
      },
      { nextText: SELECTORS.TWO_FA.NEXT_TEXT },
    );

    await sleep(cfg.delayAfterClick || 2000);

    // ── 11. Get & enter token ─────────────────────────────────────────────
    log("Getting 2FA token...");
    const verificationCode = await get2FAToken(twoFASecret);
    log(`✓ Token: ${verificationCode}`);

    await sleep(cfg.delayAfterClick || 2000);

    const inputSuccess = await tryInputSelectors(
      page,
      SELECTORS.TWO_FA.VERIFICATION_INPUT,
      verificationCode,
    );
    if (!inputSuccess) throw new Error("Could not enter verification code");

    await sleep(cfg.delayAfterClick || 2000);

    // Click Next visible cuối
    await page.evaluate(
      ({ nextText }) => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="none"]'),
        );
        const visibleNextBtns = buttons.filter((btn) => {
          if (!btn.textContent.includes(nextText)) return false;
          const rect = btn.getBoundingClientRect();
          const style = window.getComputedStyle(btn);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        });
        if (visibleNextBtns.length > 0)
          visibleNextBtns[visibleNextBtns.length - 1].click();
      },
      { nextText: SELECTORS.TWO_FA.NEXT_TEXT },
    );

    await sleep(2000);

    // Click Next lần 2
    await page.evaluate(
      ({ nextText }) => {
        const buttons = Array.from(
          document.querySelectorAll('div[role="none"]'),
        );
        const nextBtn = buttons.find((btn) =>
          btn.textContent.includes(nextText),
        );
        if (nextBtn) nextBtn.click();
      },
      { nextText: SELECTORS.TWO_FA.NEXT_TEXT },
    );

    log(`✓ 2FA submitted for ${account.username}!`);
    await sleep(10000);

    // ── 12. Homepage & post-setup dialogs ────────────────────────────────
    await gotoIG(page, "https://www.instagram.com/");
    await sleep(cfg.delayPageLoad || 3000);

    // ── 13. Add Hotmail ───────────────────────────────────────────────────
    log("\n🔄 === STARTING HOTMAIL ADDITION PROCESS ===");

    if (hotmailIndex < hotmailList.length) {
      usedHotmail = hotmailList[hotmailIndex];
      log(`📧 Using hotmail #${hotmailIndex + 1}: ${usedHotmail.hotmail}`);

      try {
        await addHotmailToAccount(page, account, usedHotmail);
        log("✅ Hotmail added successfully!");
        removeHotmailFromFile(usedHotmail.hotmail);
      } catch (hotmailErr) {
        log(`❌ Hotmail failed: ${hotmailErr.message}`);
        usedHotmail = null;
      }
    } else {
      log("⚠️ No more hotmail addresses available in list");
    }

    await handlePostSetupDialogs(page, account);
    removeAccountFromInput(account.username);

    return {
      success: true,
      username: account.username,
      twoFA: twoFASecret,
      hotmailData: usedHotmail,
      cookies: account.cookies,
    };
  } catch (error) {
    log(`✗ Error processing ${account.username}: ${error.message}`);
    await safeScreenshot(
      page,
      path.join(SCREENSHOT_DIR, `${account.username}_error.png`),
    );
    writeFailedAccount(account, error.message);
    removeAccountFromInput(account.username);

    return {
      success: false,
      username: account.username,
      twoFA: "",
      hotmailData: null,
      error: error.message,
    };
  }
}

async function checkCurrentIP(page) {
  try {
    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "networkidle0",
      timeout: 10000,
    });

    const ip = await page.evaluate(() => {
      return JSON.parse(document.body.textContent).ip;
    });

    console.log(`🌐 Current IP: ${ip}`);
    return ip;
  } catch (error) {
    console.error("⚠️ Cannot retrieve IP:", error.message);
    return null;
  }
}

async function checkBrowserLocation() {
  const result = {
    geolocation: null,
    ipLocation: null,
    mismatch: false,
    error: null,
  };

  // 1️⃣ Lấy location từ Geolocation API
  try {
    result.geolocation = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        return reject("Geolocation not supported");
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.faccuracy,
          });
        },
        (err) => reject(err.message),
        {
          enableHighAccuracy: true,
          timeout: 10000,
        },
      );
    });
  } catch (e) {
    result.error = "Geolocation error: " + e;
  }

  // 2️⃣ Lấy location theo IP
  try {
    const res = await fetch("https://ipinfo.io/json");
    const data = await res.json();

    if (data.loc) {
      const [lat, lon] = data.loc.split(",");
      result.ipLocation = {
        latitude: Number(lat),
        longitude: Number(lon),
        city: data.city,
        country: data.country,
        ip: data.ip,
      };
    }
  } catch (e) {
    result.error = "IP location error: " + e;
  }

  // 3️⃣ So sánh lệch location
  if (result.geolocation && result.ipLocation) {
    const latDiff = Math.abs(
      result.geolocation.latitude - result.ipLocation.latitude,
    );
    const lonDiff = Math.abs(
      result.geolocation.longitude - result.ipLocation.longitude,
    );

    // Lệch ~ >100km (1 độ ≈ 111km)
    if (latDiff > 1 || lonDiff > 1) {
      result.mismatch = true;
    }
  }

  return result;
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function main() {
  log(`\n${"=".repeat(50)}`);
  log(`🚀 Worker: ${cfg.name}`);
  log(`📁 Dir:    ${DATA_DIR}`);
  log(`${"=".repeat(50)}`);

  [DATA_DIR, SCREENSHOT_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  let accounts;
  try {
    accounts = readInputFile();
    log(`✓ Accounts: ${accounts.length}`);
  } catch (e) {
    log(`❌ Cannot read input: ${e.message}`);
    process.exit(1);
  }

  if (!accounts.length) {
    log("⚠️ No accounts");
    process.exit(0);
  }

  let hotmailList = [];
  try {
    hotmailList = readHotmailFile();
    log(`✓ Hotmail: ${hotmailList.length}`);
  } catch (e) {
    log(`⚠️ Hotmail error: ${e.message}`);
  }

  let proxyList = [];
  let proxyIndex = 0;
  if (!cfg.useSystemVPN && cfg.proxyEnabled) {
    try {
      proxyList = await get9ProxyList();
      log(`✓ Proxies: ${proxyList.length}`);
    } catch (e) {
      log(`❌ Proxy failed: ${e.message}`);
    }
  }

  let browser = null;
  let currentPage = null;
  const accountsPerProxy = cfg.accountsPerProxy || 5;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    log(`\n[${i + 1}/${accounts.length}] ${account.username}`);
    logProgress({
      total: accounts.length,
      current: i + 1,
      account: account.username,
    });

    const shouldRestart = i % accountsPerProxy === 0 || !browser;
    if (shouldRestart) {
      if (browser) {
        log("🔄 Restarting browser...");
        await safeClosePage(currentPage);
        currentPage = null;
        await safeCloseBrowser(browser);
        browser = null;
        await sleep(3000);
      }

      let proxyUrl = null;
      if (!cfg.useSystemVPN && cfg.proxyEnabled && proxyList.length > 0) {
        proxyUrl = `socks5://${proxyList[proxyIndex % proxyList.length]}`;
        proxyIndex++;
        log(`🔌 Proxy: ${proxyUrl}`);
      }

      browser = await launchBrowser(proxyUrl);
      log("✓ Browser launched");
    }

    if (!currentPage) {
      currentPage = await newPage(browser);
    }

    const hotmailData = i < hotmailList.length ? hotmailList[i] : null;
    if (hotmailData) log(`📧 Hotmail: ${hotmailData.hotmail}`);

    const startTime = Date.now();
    let result;

    try {
      const currentIP = await checkCurrentIP(currentPage);
      checkBrowserLocation().then((res) => {
        console.log("📍 Browser Geolocation:", res.geolocation);
        console.log("🌐 IP Location:", res.ipLocation);
        console.log("⚠️ Location mismatch:", res.mismatch);
      });
      result = await enable2FA(account, currentPage, hotmailList, i, browser);
    } catch (e) {
      log(`✗ ${e.message}`);
      await safeScreenshot(
        currentPage,
        path.join(SCREENSHOT_DIR, `${account.username}_error.png`),
      );
      result = { success: false, error: e.message };
    }

    log(`⏱️ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    if (result.success) {
      writeSuccessAccount(account, result.twoFA, result.hotmailData);
      const hm = result.hotmailData
        ? ` + hotmail: ${result.hotmailData.hotmail}`
        : " (no hotmail)";
      log(`✅ SUCCESS: ${account.username}${hm}`);
    } else {
      if (result.error && !result.username) {
        writeFailedAccount(account, result.error);
      }
      log(`✗ FAILED: ${account.username} — ${result.error || "unknown"}`);
    }

    if (!result.username) {
      removeAccountFromInput(account.username);
    }
    await safeClosePage(currentPage);
    currentPage = null;

    if (i < accounts.length - 1) {
      const wait = cfg.delayBetweenAccounts || 2000;
      log(`⏳ Waiting ${wait / 1000}s...`);
      await sleep(wait);
    }
  }

  await safeCloseBrowser(browser);
  log(`\n✓ Worker done: ${cfg.name}`);
  process.exit(0);
}

main().catch((e) => {
  log(`❌ Fatal: ${e.message}`);
  log(e.stack || "");
  process.exit(1);
});

/**
 * zznet Bot Keyword Manager — Google Apps Script Backend
 *
 * This script is attached to the master management Google Spreadsheet.
 * It provides a web app that:
 *   1. Shows a Telegram Login Widget for bot customers to authenticate
 *   2. Verifies the Telegram auth hash (HMAC-SHA256 per official spec)
 *   3. Provisions a new Google Spreadsheet for first-time users
 *   4. Shares the new sheet with the user's email address
 *   5. Lets the user edit their keyword → reply → (optional audio URL) rows
 *      directly via a browser UI, backed by their own spreadsheet
 *
 * ─── Setup ───────────────────────────────────────────────────────────────────
 * 1. Open this script in GAS editor (Extensions → Apps Script)
 * 2. Go to Project Settings → Script Properties and set:
 *      BOT_TOKEN    = your Telegram bot token
 *      BOT_USERNAME = your bot's @username (without @)
 * 3. Deploy → New deployment → Web App
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. Copy the deployment URL and set it as the Bot login domain in @BotFather:
 *      /setdomain → <your-script-url-domain>
 *    Note: For GAS web apps the domain is script.google.com, which must be
 *    registered. Alternatively, proxy via a custom domain with CNAME.
 *
 * ─── Master Spreadsheet Layout ───────────────────────────────────────────────
 * Sheet "Users" (auto-created):
 *   A: Telegram User ID | B: Username | C: Email | D: Spreadsheet ID | E: Created At
 */

// ─── Entry point ─────────────────────────────────────────────────────────────

function doGet(e) {
  const page = e.parameter.page || 'login';
  const template = HtmlService.createTemplateFromFile('index');
  template.page = page;
  template.botUsername = getBotUsername_();
  template.userId = e.parameter.id || '';
  template.authData = JSON.stringify(e.parameters); // pass all Telegram auth params
  return template.evaluate()
    .setTitle('zznet — Keyword Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── Script Properties helpers ────────────────────────────────────────────────

function getBotToken_() {
  return PropertiesService.getScriptProperties().getProperty('BOT_TOKEN') || '';
}

function getBotUsername_() {
  return PropertiesService.getScriptProperties().getProperty('BOT_USERNAME') || '';
}

// ─── Spreadsheet Menu ─────────────────────────────────────────────────────────

/**
 * Runs automatically when the spreadsheet is opened.
 * Adds the "🤖 zznet Bot" menu to the spreadsheet toolbar.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🤖 zznet Bot')
    .addItem('🔑 Set Bot Token', 'menuSetBotToken')
    .addItem('👤 Set Bot Username', 'menuSetBotUsername')
    .addSeparator()
    .addItem('🌐 Get Web App URL', 'menuShowWebAppUrl')
    .addItem('⚙️ Check Config Status', 'menuCheckConfig')
    .addSeparator()
    .addItem('📋 List All Customers', 'menuListCustomers')
    .addItem('🗑️ Delete a Customer Record', 'menuDeleteCustomer')
    .addToUi();
}

// ─── Menu action helpers ──────────────────────────────────────────────────────

function menuSetBotToken() {
  const ui = SpreadsheetApp.getUi();
  const current = getBotToken_();
  const hint = current ? '(currently set — paste new token to replace)' : '(not set yet)';
  const resp = ui.prompt(
    '🔑 Bot Token',
    'Paste the token from @BotFather ' + hint + ':\n\nFormat: 123456:ABC-DEF...',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const token = resp.getResponseText().trim();
  if (!token) { ui.alert('No token entered — nothing saved.'); return; }
  if (!token.match(/^\d+:[A-Za-z0-9_-]{35,}$/)) {
    ui.alert('⚠️ That doesn\'t look like a valid Telegram bot token.\n\nExpected format: 123456789:ABCdef...\n\nPlease check and try again.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('BOT_TOKEN', token);
  ui.alert('✅ Bot token saved successfully!');
}

function menuSetBotUsername() {
  const ui = SpreadsheetApp.getUi();
  const current = getBotUsername_();
  const hint = current ? '(currently: @' + current + ')' : '(not set yet)';
  const resp = ui.prompt(
    '👤 Bot Username',
    'Enter your bot\'s Telegram username ' + hint + ':\n\n(without the @ sign, e.g. my_bot)',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const username = resp.getResponseText().trim().replace(/^@/, '');
  if (!username) { ui.alert('No username entered — nothing saved.'); return; }
  PropertiesService.getScriptProperties().setProperty('BOT_USERNAME', username);
  ui.alert('✅ Bot username saved: @' + username);
}

function menuShowWebAppUrl() {
  const ui = SpreadsheetApp.getUi();
  try {
    const url = ScriptApp.getService().getUrl();
    if (!url) {
      ui.alert('⚠️ Web App Not Deployed',
        'This script has not been deployed as a Web App yet.\n\n' +
        'Go to: Deploy → New deployment → Web App\n' +
        'Execute as: Me | Who has access: Anyone',
        ui.ButtonSet.OK);
      return;
    }
    ui.alert('🌐 Web App URL',
      'Your login page URL is:\n\n' + url + '\n\n' +
      'Register this domain in @BotFather:\n/mybots → your bot → Bot Settings → Domain',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('⚠️ Could not read URL: ' + e.message);
  }
}

function menuCheckConfig() {
  const ui = SpreadsheetApp.getUi();
  const token = getBotToken_();
  const username = getBotUsername_();
  let webUrl = '';
  try { webUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { webUrl = '(error reading URL)'; }

  const tokenStatus = token ? '✅ Set (' + token.split(':')[0] + ':***)' : '❌ Not set';
  const usernameStatus = username ? '✅ @' + username : '❌ Not set';
  const urlStatus = webUrl ? '✅ Deployed' : '❌ Not deployed';

  let msg = '⚙️ zznet Bot Configuration\n\n';
  msg += 'Bot Token:    ' + tokenStatus + '\n';
  msg += 'Bot Username: ' + usernameStatus + '\n';
  msg += 'Web App URL:  ' + urlStatus + '\n';
  if (webUrl) msg += '\n' + webUrl;

  const allGood = token && username && webUrl;
  msg += '\n\n' + (allGood ? '✅ All settings configured! Your login page is ready.' : '⚠️ Please complete the missing settings above.');

  ui.alert('ℹ️ Config Status', msg, ui.ButtonSet.OK);
}

function menuListCustomers() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getMasterSheet_();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) { ui.alert('No customers yet.'); return; }
  const rows = data.slice(1).map((r, i) =>
    (i + 1) + '. ' + (r[2] || r[1] || 'Unknown') + ' (ID: ' + r[0] + ') — ' + (r[3] || 'no email')
  );
  const preview = rows.slice(0, 15).join('\n');
  const more = rows.length > 15 ? '\n\n... and ' + (rows.length - 15) + ' more. See the Customers sheet for the full list.' : '';
  ui.alert('📋 Customers (' + (data.length - 1) + ' total)', preview + more, ui.ButtonSet.OK);
}

function menuDeleteCustomer() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    '🗑️ Delete Customer',
    'Enter the Telegram User ID of the customer record to delete:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const telegramId = resp.getResponseText().trim();
  if (!telegramId) { ui.alert('No ID entered.'); return; }

  const found = findCustomer_(telegramId);
  if (!found) { ui.alert('❌ Customer ID ' + telegramId + ' not found in the Customers sheet.'); return; }

  const confirm = ui.alert(
    'Confirm Delete',
    'Delete record for: ' + (found.row[2] || found.row[1] || 'Unknown') + ' (ID: ' + telegramId + ')?\n\nThis does NOT delete their spreadsheet.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  getMasterSheet_().deleteRow(found.rowIndex);
  ui.alert('✅ Customer record deleted. Their spreadsheet is unaffected.');
}

// ─── Telegram auth verification ───────────────────────────────────────────────

/**
 * Verify that the data received from the Telegram Login Widget is authentic.
 *
 * Algorithm (official spec):
 *   secret_key = SHA-256(bot_token)
 *   data_check_string = sorted key=value pairs joined with \n (hash excluded)
 *   valid = HMAC-SHA256(data_check_string, secret_key) === provided hash
 *
 * @param {Object} authData - Object with Telegram Login Widget fields
 * @returns {boolean}
 */
function verifyTelegramAuth(authData) {
  const botToken = getBotToken_();
  if (!botToken) return false;

  const providedHash = authData['hash'];
  if (!providedHash) return false;

  // Build data_check_string from all fields except hash, sorted alphabetically
  const fields = Object.keys(authData)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${authData[k]}`)
    .join('\n');

  // secret_key = SHA-256(bot_token)
  const secretKeyBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    botToken,
    Utilities.Charset.UTF_8
  );

  // HMAC-SHA256(data_check_string, secret_key)
  const hmacBytes = Utilities.computeHmacSha256Signature(
    fields,
    secretKeyBytes
  );

  // Convert computed HMAC to lowercase hex
  const computedHash = hmacBytes
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');

  // Constant-time comparison not strictly possible in GAS, but check both ways
  if (computedHash !== providedHash) return false;

  // Also check that auth_date is not too old (24 hours)
  const authDate = parseInt(authData['auth_date'] || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) return false;

  return true;
}

// ─── Master sheet helpers ─────────────────────────────────────────────────────

function getMasterSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Customers');
  if (!sheet) {
    sheet = ss.insertSheet('Customers');
    sheet.appendRow(['Telegram User ID', 'Username', 'First Name', 'Email', 'Spreadsheet ID', 'Spreadsheet URL', 'Created At']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findCustomer_(telegramId) {
  const sheet = getMasterSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(telegramId)) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

// ─── Spreadsheet provisioning ─────────────────────────────────────────────────

/**
 * Create a new Keywords spreadsheet for a first-time customer and share it.
 *
 * @param {string} telegramId  - Telegram user ID
 * @param {string} username    - Telegram username
 * @param {string} firstName   - Customer first name
 * @param {string} email       - Email to share the spreadsheet with
 * @returns {Object} { spreadsheetId, spreadsheetUrl }
 */
function provisionSpreadsheet_(telegramId, username, firstName, email) {
  const title = `zznet Bot Keywords — ${firstName || username || telegramId}`;
  const ss = SpreadsheetApp.create(title);
  const ssId = ss.getId();
  const ssUrl = ss.getUrl();

  // ── Set up Keywords sheet ─────────────────────────────────────────────────
  const kwSheet = ss.getSheets()[0];
  kwSheet.setName('Keywords');
  kwSheet.appendRow(['Keywords (comma-separated)', 'Reply Text', 'Audio URL (optional)', 'Notes']);
  kwSheet.appendRow(['价格,报价,price,quote', '感谢您的询价！请描述您的项目需求，我们将为您提供详细报价。\nThank you for your inquiry! Please describe your project needs and we\'ll provide a detailed quote.', '', 'Pricing inquiry']);
  kwSheet.appendRow(['联系,contact,联络', '请通过 Telegram 直接联系我们，或在此说明您的需求。\nPlease contact us via Telegram directly, or describe your needs here.', '', 'Contact info']);
  kwSheet.appendRow(['时间,deadline,交付,时限', '交付时间视项目规模而定：小项目 3-7 天，中型 2-4 周，大型按里程碑排期。\nDelivery time depends on scope: small 3-7 days, medium 2-4 weeks, large by milestone.', '', 'Timeline']);
  kwSheet.appendRow(['优惠,折扣,discount', '我们会根据项目规模和长期合作关系提供相应的优惠。\nWe offer discounts based on project size and long-term partnerships.', '', 'Discounts']);
  kwSheet.getRange('A1:D1').setFontWeight('bold');
  kwSheet.setColumnWidth(1, 220);
  kwSheet.setColumnWidth(2, 380);
  kwSheet.setColumnWidth(3, 200);
  kwSheet.setColumnWidth(4, 150);
  kwSheet.setFrozenRows(1);

  // ── Set up Logs sheet ─────────────────────────────────────────────────────
  const logsSheet = ss.insertSheet('Logs');
  logsSheet.appendRow(['Timestamp', 'Direction', 'Customer ID', 'Customer Name', 'Message', 'Reply Type']);
  logsSheet.getRange('A1:F1').setFontWeight('bold');
  logsSheet.setFrozenRows(1);

  // ── Set up Users sheet ─────────────────────────────────────────────────────
  const usersSheet = ss.insertSheet('Users');
  usersSheet.appendRow(['Customer ID', 'Name', 'Gender', 'First Seen', 'Last Seen', 'Messages']);
  usersSheet.getRange('A1:F1').setFontWeight('bold');
  usersSheet.setFrozenRows(1);

  // ── Share with customer email ──────────────────────────────────────────────
  if (email) {
    try {
      DriveApp.getFileById(ssId).addEditor(email);
    } catch (err) {
      Logger.log('[provisionSpreadsheet_] Could not share with ' + email + ': ' + err);
    }
  }

  // ── Record in master sheet ────────────────────────────────────────────────
  getMasterSheet_().appendRow([
    telegramId,
    username || '',
    firstName || '',
    email || '',
    ssId,
    ssUrl,
    new Date().toISOString()
  ]);

  Logger.log('[provisionSpreadsheet_] Created: ' + title + ' → ' + ssUrl);
  return { spreadsheetId: ssId, spreadsheetUrl: ssUrl };
}

// ─── Public API (called via google.script.run) ────────────────────────────────

/**
 * Authenticate a Telegram Login Widget callback and return the customer's
 * spreadsheet info (creating one if this is a new user).
 *
 * @param {Object} authData  - Raw fields from Telegram Login Widget callback
 * @param {string} email     - Email the customer entered for spreadsheet sharing
 * @returns {Object} { ok, spreadsheetId, spreadsheetUrl, isNew, error }
 */
function loginAndGetSpreadsheet(authData, email) {
  try {
    if (!verifyTelegramAuth(authData)) {
      return { ok: false, error: 'Telegram auth verification failed. Please try again.' };
    }

    const telegramId = String(authData['id'] || '');
    const username = authData['username'] || '';
    const firstName = authData['first_name'] || '';
    const lastName = authData['last_name'] || '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    const existing = findCustomer_(telegramId);

    if (existing) {
      return {
        ok: true,
        isNew: false,
        spreadsheetId: existing.row[4],
        spreadsheetUrl: existing.row[5],
        firstName: fullName || username,
      };
    }

    // First-time user — provision spreadsheet
    const { spreadsheetId, spreadsheetUrl } = provisionSpreadsheet_(
      telegramId, username, fullName || firstName, email
    );

    return {
      ok: true,
      isNew: true,
      spreadsheetId,
      spreadsheetUrl,
      firstName: fullName || username,
    };
  } catch (err) {
    Logger.log('[loginAndGetSpreadsheet] Error: ' + err);
    return { ok: false, error: 'Server error: ' + err.message };
  }
}

/**
 * Read all keyword rows from the customer's spreadsheet.
 * Called after successful login to populate the keyword table in the UI.
 *
 * @param {string} spreadsheetId
 * @returns {Object} { ok, rows: Array<{keywords, reply, audioUrl, notes}> }
 */
function getKeywords(spreadsheetId) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName('Keywords');
    if (!sheet) return { ok: false, error: 'Keywords sheet not found.' };

    const data = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 4).getValues();
    const rows = data
      .filter(r => r[0] || r[1]) // skip fully empty rows
      .map(r => ({
        keywords: String(r[0] || ''),
        reply: String(r[1] || ''),
        audioUrl: String(r[2] || ''),
        notes: String(r[3] || ''),
      }));

    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: 'Could not read keywords: ' + err.message };
  }
}

/**
 * Overwrite all keyword rows in the customer's spreadsheet.
 *
 * @param {string} spreadsheetId
 * @param {Array}  rows - Array of {keywords, reply, audioUrl, notes}
 * @returns {Object} { ok, savedCount }
 */
function saveKeywords(spreadsheetId, rows) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName('Keywords');
    if (!sheet) return { ok: false, error: 'Keywords sheet not found.' };

    // Clear existing data rows (keep header)
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 4).clearContent();
    }

    // Write new rows
    if (rows.length > 0) {
      const values = rows.map(r => [
        r.keywords || '',
        r.reply || '',
        r.audioUrl || '',
        r.notes || '',
      ]);
      sheet.getRange(2, 1, values.length, 4).setValues(values);
    }

    // Force cache refresh signal (update a hidden cell with timestamp)
    sheet.getRange('F1').setValue('Cache-busted: ' + new Date().toISOString());

    return { ok: true, savedCount: rows.length };
  } catch (err) {
    return { ok: false, error: 'Could not save keywords: ' + err.message };
  }
}

/**
 * Helper to include sub-HTML files (for HtmlService template partials).
 * Usage in HTML: <?!= include('styles') ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

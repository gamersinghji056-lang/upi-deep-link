const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const service = read("android-app/app/src/main/java/org/wtron/wpayagent/BackgroundMonitorService.kt");
const receiver = read("android-app/app/src/main/java/org/wtron/wpayagent/SmsReceiver.kt");
const scanner = read("android-app/app/src/main/java/org/wtron/wpayagent/SmsInboxScanner.kt");
const worker = read("android-app/app/src/main/java/org/wtron/wpayagent/CreditRetryWorker.kt");
const manifest = read("android-app/app/src/main/AndroidManifest.xml");

test("background monitor remains sticky after normal task removal", () => {
  assert.equal(service.includes("return START_STICKY"), true);
  assert.equal(service.includes("override fun onTaskRemoved"), true);
  assert.equal(service.includes("CreditRetryScheduler.ensurePeriodic(this)"), true);
  assert.equal(service.includes("CreditRetryScheduler.enqueue(this)"), true);
});

test("manifest SMS receiver remains registered for new incoming messages", () => {
  assert.equal(manifest.includes("android.provider.Telephony.SMS_RECEIVED"), true);
  assert.equal(manifest.includes('android:name=".SmsReceiver"'), true);
  assert.equal(receiver.includes("SmsProcessor.capture"), true);
});

test("background reconciliation still scans inbox and retries pending payment events", () => {
  assert.equal(scanner.includes("Telephony.Sms.Inbox.CONTENT_URI"), true);
  assert.equal(worker.includes("SmsInboxScanner.scanRecent"), true);
  assert.equal(worker.includes("eventStore.pending(50)"), true);
  assert.equal(worker.includes("ApiClient.creditSms(store, payload)"), true);
});

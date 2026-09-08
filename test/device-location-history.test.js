const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MOVEMENT_THRESHOLD_METERS,
  CHECKPOINT_MINUTES,
  haversineMeters,
  classifyLocationEvent
} = require("../lib/device-location-history");

test("first enabled location sample is LOCATION_ON", () => {
  const event = classifyLocationEvent(null, {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090
  });
  assert.equal(event.eventType, "LOCATION_ON");
  assert.equal(event.lastKnown, false);
});

test("location off transition is recorded without inventing movement", () => {
  const previous = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090,
    capturedAt: new Date(Date.now() - 60_000).toISOString()
  };
  const event = classifyLocationEvent(previous, {
    permissionGranted: true,
    locationEnabled: false,
    latitude: null,
    longitude: null
  });
  assert.equal(event.eventType, "LOCATION_OFF");
  assert.equal(event.distanceMeters, null);
  assert.equal(event.lastKnown, true);
});

test("movement above threshold becomes MOVED", () => {
  const now = Date.now();
  const previous = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090,
    capturedAt: new Date(now - 60_000).toISOString()
  };
  const sample = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6150,
    longitude: 77.2105
  };
  const distance = haversineMeters(previous.latitude, previous.longitude, sample.latitude, sample.longitude);
  assert.ok(distance > MOVEMENT_THRESHOLD_METERS);
  const event = classifyLocationEvent(previous, sample, now);
  assert.equal(event.eventType, "MOVED");
  assert.ok(event.distanceMeters >= MOVEMENT_THRESHOLD_METERS);
});

test("small movement does not create duplicate history before checkpoint", () => {
  const now = Date.now();
  const previous = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090,
    capturedAt: new Date(now - 2 * 60_000).toISOString()
  };
  const event = classifyLocationEvent(previous, {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.61395,
    longitude: 77.20903
  }, now);
  assert.equal(event, null);
});

test("stationary device gets periodic checkpoint", () => {
  const now = Date.now();
  const previous = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090,
    capturedAt: new Date(now - (CHECKPOINT_MINUTES + 1) * 60_000).toISOString()
  };
  const event = classifyLocationEvent(previous, {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.61391,
    longitude: 77.20901
  }, now);
  assert.equal(event.eventType, "CHECKPOINT");
});

test("permission change is recorded separately", () => {
  const previous = {
    permissionGranted: true,
    locationEnabled: true,
    latitude: 28.6139,
    longitude: 77.2090,
    capturedAt: new Date(Date.now() - 60_000).toISOString()
  };
  const event = classifyLocationEvent(previous, {
    permissionGranted: false,
    locationEnabled: true,
    latitude: null,
    longitude: null
  });
  assert.equal(event.eventType, "PERMISSION_REVOKED");
});

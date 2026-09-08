const express = require("express");

const MOVEMENT_THRESHOLD_METERS = 75;
const CHECKPOINT_MINUTES = 10;

function haversineMeters(aLat, aLng, bLat, bLng) {
  const values = [aLat, aLng, bLat, bLng].map(Number);
  if (values.some(value => !Number.isFinite(value))) return null;
  const [lat1, lng1, lat2, lng2] = values;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function classifyLocationEvent(previous, sample, nowMs = Date.now()) {
  const permission = Boolean(sample.permissionGranted);
  const enabled = Boolean(sample.locationEnabled);
  const hasCoords = Number.isFinite(Number(sample.latitude)) && Number.isFinite(Number(sample.longitude));
  const previousTime = previous?.capturedAt ? new Date(previous.capturedAt).getTime() : 0;
  const checkpointDue = previousTime > 0 && nowMs - previousTime >= CHECKPOINT_MINUTES * 60 * 1000;

  if (!previous) {
    if (!permission) return { eventType: "PERMISSION_REVOKED", distanceMeters: null, lastKnown: !hasCoords };
    if (!enabled) return { eventType: "LOCATION_OFF", distanceMeters: null, lastKnown: !hasCoords };
    return { eventType: "LOCATION_ON", distanceMeters: null, lastKnown: !hasCoords };
  }

  if (Boolean(previous.permissionGranted) !== permission) {
    return { eventType: permission ? "PERMISSION_GRANTED" : "PERMISSION_REVOKED", distanceMeters: null, lastKnown: !hasCoords };
  }
  if (Boolean(previous.locationEnabled) !== enabled) {
    return { eventType: enabled ? "LOCATION_ON" : "LOCATION_OFF", distanceMeters: null, lastKnown: !hasCoords };
  }

  if (permission && enabled && hasCoords && previous.latitude != null && previous.longitude != null) {
    const distance = haversineMeters(previous.latitude, previous.longitude, sample.latitude, sample.longitude);
    if (distance != null && distance >= MOVEMENT_THRESHOLD_METERS) {
      return { eventType: "MOVED", distanceMeters: Math.round(distance * 10) / 10, lastKnown: false };
    }
  }

  if (checkpointDue) {
    return { eventType: "CHECKPOINT", distanceMeters: null, lastKnown: !hasCoords };
  }
  return null;
}

async function initDeviceLocationHistoryTables(pool) {
  if (!pool) return;
  await pool.query(`
    create table if not exists device_location_history (
      id bigserial primary key,
      device_id text not null references devices(id) on delete cascade,
      event_type text not null,
      latitude numeric(10,7),
      longitude numeric(10,7),
      accuracy numeric(10,2),
      provider text,
      location_enabled boolean not null default false,
      permission_granted boolean not null default false,
      distance_meters numeric(12,2),
      last_known boolean not null default false,
      captured_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query("create index if not exists device_location_history_device_time_idx on device_location_history(device_id,captured_at desc)");
  await pool.query("create index if not exists device_location_history_device_event_idx on device_location_history(device_id,event_type,captured_at desc)");

  await pool.query(`
    create or replace function wpay_capture_location_history()
    returns trigger
    language plpgsql
    as $$
    declare
      prev device_location_history%rowtype;
      permission_now boolean;
      enabled_now boolean;
      provider_now text;
      event_now text;
      distance_now numeric;
      lat_now numeric;
      lng_now numeric;
      accuracy_now numeric;
      last_known_now boolean := false;
      checkpoint_due boolean := false;
    begin
      permission_now := coalesce((new.raw->>'locationPermissionGranted')::boolean, new.latitude is not null);
      enabled_now := coalesce((new.raw->>'locationEnabled')::boolean, new.latitude is not null);
      provider_now := nullif(new.raw->'location'->>'provider', '');
      lat_now := new.latitude;
      lng_now := new.longitude;
      accuracy_now := new.location_accuracy;

      select * into prev
        from device_location_history
       where device_id = new.device_id
       order by captured_at desc, id desc
       limit 1;

      if found then
        checkpoint_due := new.collected_at - prev.captured_at >= interval '10 minutes';
      end if;

      if not found then
        if not permission_now then event_now := 'PERMISSION_REVOKED';
        elsif not enabled_now then event_now := 'LOCATION_OFF';
        else event_now := 'LOCATION_ON';
        end if;
      elsif prev.permission_granted is distinct from permission_now then
        event_now := case when permission_now then 'PERMISSION_GRANTED' else 'PERMISSION_REVOKED' end;
      elsif prev.location_enabled is distinct from enabled_now then
        event_now := case when enabled_now then 'LOCATION_ON' else 'LOCATION_OFF' end;
      elsif permission_now and enabled_now and lat_now is not null and lng_now is not null and prev.latitude is not null and prev.longitude is not null then
        distance_now := sqrt(
          power((lat_now - prev.latitude) * 111320.0, 2) +
          power((lng_now - prev.longitude) * 111320.0 * cos(radians((lat_now + prev.latitude) / 2.0)), 2)
        );
        if distance_now >= 75 then
          event_now := 'MOVED';
        elsif checkpoint_due then
          event_now := 'CHECKPOINT';
        else
          return new;
        end if;
      elsif checkpoint_due then
        event_now := 'CHECKPOINT';
      else
        return new;
      end if;

      if lat_now is null or lng_now is null then
        if found and prev.latitude is not null and prev.longitude is not null then
          lat_now := prev.latitude;
          lng_now := prev.longitude;
          accuracy_now := prev.accuracy;
          provider_now := coalesce(provider_now, prev.provider);
          last_known_now := true;
        end if;
      end if;

      if event_now in ('LOCATION_OFF','PERMISSION_REVOKED') and found and prev.latitude is not null and prev.longitude is not null then
        lat_now := coalesce(lat_now, prev.latitude);
        lng_now := coalesce(lng_now, prev.longitude);
        accuracy_now := coalesce(accuracy_now, prev.accuracy);
        provider_now := coalesce(provider_now, prev.provider);
        last_known_now := true;
      end if;

      insert into device_location_history(
        device_id,event_type,latitude,longitude,accuracy,provider,
        location_enabled,permission_granted,distance_meters,last_known,captured_at
      ) values (
        new.device_id,event_now,lat_now,lng_now,accuracy_now,provider_now,
        enabled_now,permission_now,distance_now,last_known_now,new.collected_at
      );
      return new;
    end;
    $$
  `);
  await pool.query("drop trigger if exists device_diagnostics_location_history_trigger on device_diagnostics");
  await pool.query(`
    create trigger device_diagnostics_location_history_trigger
    after insert on device_diagnostics
    for each row execute function wpay_capture_location_history()
  `);
}

function createDeviceLocationHistoryRouter({ pool }) {
  const router = express.Router();

  router.get("/admin/device/:deviceId/location-history", async (req, res, next) => {
    try {
      if (!pool) return res.status(503).json({ error: "Database is not configured" });
      const deviceId = String(req.params.deviceId || "");
      const limit = Math.max(20, Math.min(500, Number(req.query.limit) || 300));
      const device = await pool.query("select id from devices where id=$1 limit 1", [deviceId]);
      if (!device.rowCount) return res.status(404).json({ error: "Device not found" });
      const history = await pool.query(
        `select id,event_type,latitude,longitude,accuracy,provider,location_enabled,permission_granted,
                distance_meters,last_known,captured_at,created_at
           from device_location_history
          where device_id=$1
          order by captured_at desc,id desc
          limit $2`,
        [deviceId, limit]
      );
      res.json({ deviceId, events: history.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  MOVEMENT_THRESHOLD_METERS,
  CHECKPOINT_MINUTES,
  haversineMeters,
  classifyLocationEvent,
  initDeviceLocationHistoryTables,
  createDeviceLocationHistoryRouter
};

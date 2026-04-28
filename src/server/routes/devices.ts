import { Hono } from "hono";
import type { DeviceStore } from "../ws/auth.js";
import type { ConnectionManager } from "../ws/connection.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

export function devicesRoutes(devices: DeviceStore, connections: ConnectionManager): Hono {
  const app = new Hono();

  // GET /api/devices -- list all devices
  app.get("/", canRead, (c) => {
    const raw = devices.listDevices();
    return c.json({
      devices: raw.map((d) => ({
        id: d.id,
        name: d.name,
        approved: !!d.approved,
        lastSeen: d.last_seen,
        createdAt: d.created_at,
      })),
    });
  });

  // GET /api/devices/pending -- list pending devices only
  app.get("/pending", canRead, (c) => {
    const pending = devices.pendingDevices();
    return c.json({
      devices: pending.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.created_at,
      })),
    });
  });

  // POST /api/devices/:id/approve -- approve a device
  app.post("/:id/approve", adminOnly, (c) => {
    const deviceId = c.req.param("id");
    const approved = devices.approveDevice(deviceId);
    if (approved) {
      const allDevices = devices.listDevices();
      const device = allDevices.find((d) => d.id === deviceId);
      connections.broadcast("device:approved", {
        deviceId,
        deviceName: device?.name ?? "Unknown",
      });
    }
    return c.json({ approved });
  });

  // POST /api/devices/:id/revoke -- revoke a device
  app.post("/:id/revoke", adminOnly, (c) => {
    const deviceId = c.req.param("id");
    const revoked = devices.revokeDevice(deviceId);
    if (revoked) {
      connections.broadcast("device:revoked", { deviceId });
    }
    return c.json({ revoked });
  });

  return app;
}

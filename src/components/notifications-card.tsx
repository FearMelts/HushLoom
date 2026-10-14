"use client";

import { BellOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { deviceSubscription, isIos, isStandalone, pushSupported, subscribeThisDevice, unsubscribeThisDevice } from "@/lib/pwa";
import { Button, Toggle, useToast } from "./ui";

/** The slice of the Settings payload this card reads (pushEnabled and the preference come from settingsFor in src/server/me.ts). */
export type NotificationsSettings = { pushEnabled?: boolean; preferences?: { notifyOnFinish?: boolean } & Record<string, unknown> } & Record<string, unknown>;

type Support = "checking" | "supported" | "needs-home-screen" | "unsupported";

/**
 * Opt-in "finished" notifications (addendum §4). Turning it on asks the browser for permission,
 * subscribes this device with the server's VAPID key and stores the subscription for this session.
 * The notification says only "Your creation is ready" (or didn't finish); never a prompt or a picture.
 */
export function NotificationsCard({ data }: { data: NotificationsSettings }) {
  const router = useRouter();
  const toast = useToast();
  const configured = data.pushEnabled === true;
  const [on, setOn] = useState(data.preferences?.notifyOnFinish === true);
  const [support, setSupport] = useState<Support>("checking");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [deviceOn, setDeviceOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) {
      // iPhone and iPad offer Web Push only to Home Screen apps (iOS 16.4 and later).
      setSupport(isIos() && !isStandalone() ? "needs-home-screen" : "unsupported");
      return;
    }
    setSupport("supported");
    setPermission(Notification.permission);
    deviceSubscription()
      .then((s) => setDeviceOn(Boolean(s)))
      .catch(() => undefined);
  }, []);

  async function turnOn() {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
      const { publicKey } = await api<{ publicKey: string | null }>("/api/push/public-key");
      if (!publicKey) throw new Error("Push is not configured on this server.");
      await subscribeThisDevice(publicKey);
      setDeviceOn(true);
      if (!on) await api("/api/me/preferences", { method: "PATCH", body: { notifyOnFinish: true } });
      setOn(true);
      toast({ message: "Notifications are on for this device.", tone: "success" });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError || e instanceof Error ? e.message : "Notifications could not be turned on.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await api("/api/me/preferences", { method: "PATCH", body: { notifyOnFinish: false } });
      setOn(false);
      await unsubscribeThisDevice().catch(() => undefined);
      setDeviceOn(false);
      toast({ message: "Notifications are off.", tone: "success" });
      router.refresh();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "That did not work.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const denied = support === "supported" && permission === "denied";
  const cannotTurnOn = !configured || support !== "supported" || denied;

  let note: string | null = null;
  if (!configured) note = "Push is not configured on this server.";
  else if (support === "needs-home-screen") note = "On iPhone and iPad, add Hushloom to your Home Screen first (see above), then turn this on from the app.";
  else if (support === "unsupported") note = "This browser can't receive push notifications.";
  else if (denied) note = "Notifications are blocked for Hushloom in this browser. Allow them in the site settings, then come back here.";
  else if (on && deviceOn) note = "This device gets them.";

  return (
    <div>
      <Toggle
        label="Tell me when a creation finishes"
        description="A quiet notification when something you made is ready or didn't finish. It never shows your prompt, the picture or the template. Off stops them on every device."
        checked={on}
        onChange={(v) => void (v ? turnOn() : turnOff())}
        disabled={busy || (!on && cannotTurnOn)}
      />
      {note ? (
        <p className="flex items-start gap-2 pb-2 text-[12.5px] text-bone-400">
          {!configured || denied ? <BellOff size={14} className="mt-0.5 shrink-0 text-brass-300" aria-hidden /> : null}
          {note}
        </p>
      ) : null}
      {configured && on && !deviceOn && support === "supported" && !denied ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
          <p className="text-[12.5px] text-bone-400">On for your account, but this device isn&apos;t set up yet.</p>
          <Button size="sm" variant="ghost" busy={busy} onClick={() => void turnOn()}>
            Notify this device too
          </Button>
        </div>
      ) : null}
    </div>
  );
}

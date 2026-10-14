"use client";

import { useEffect } from "react";
import { captureInstallPrompt, registerServiceWorker, resyncThisDevice } from "@/lib/pwa";
import { useToast } from "./ui";

/**
 * Registers the service worker (public/sw.js) once the page has loaded, holds the browser's install
 * offer for Settings, and says so when a new version of the worker takes over. Renders nothing.
 */
export function ServiceWorkerRegistrar({ userId }: { userId: string | null }) {
  const toast = useToast();

  useEffect(() => {
    captureInstallPrompt();
    if (!("serviceWorker" in navigator)) return;
    // A first install also fires controllerchange (clients.claim); only a replaced worker is news.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let announced = false;
    const onControllerChange = () => {
      if (!hadController || announced) return;
      announced = true;
      toast({ message: "Hushloom just updated. Reload when you're ready for the new version." });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    const register = () => void registerServiceWorker().catch(() => undefined);
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("load", register);
    };
  }, [toast]);

  useEffect(() => {
    void resyncThisDevice(userId).catch(() => undefined);
  }, [userId]);

  return null;
}

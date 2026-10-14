"use client";

import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * Browser side of the installable web app (addendum §4): the service worker registration, the
 * install offer (shown in Settings only) and this device's push subscription.
 */

/** Under `next dev` the worker runs push only: dev chunks are not content-hashed, so caching them would serve stale code. */
export const SW_URL = process.env.NODE_ENV === "production" ? "/sw.js" : "/sw.js?mode=dev";

export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
}

// ── Install offer ──

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedThisVisit = false;
let capturing = false;
const installListeners = new Set<() => void>();
const emitInstall = () => installListeners.forEach((listener) => listener());

/**
 * Keeps the browser's install offer for Settings. preventDefault() stops Chrome's own install
 * banner: Hushloom offers install in Settings only, never as a popup. Safe to call more than once.
 */
export function captureInstallPrompt() {
  if (capturing || typeof window === "undefined") return;
  capturing = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emitInstall();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installedThisVisit = true;
    emitInstall();
  });
}

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod, and iPad (which reports a Mac user agent but has touch). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** installed: running as the app; available: the browser offered install; ios: Share → Add to Home Screen; unavailable: none of these. */
export type InstallState = "installed" | "available" | "ios" | "unavailable";

function installSnapshot(): InstallState {
  if (installedThisVisit || isStandalone()) return "installed";
  if (deferredPrompt) return "available";
  if (isIos()) return "ios";
  return "unavailable";
}

function subscribeInstall(onChange: () => void) {
  installListeners.add(onChange);
  const standalone = window.matchMedia("(display-mode: standalone)");
  standalone.addEventListener("change", onChange);
  return () => {
    installListeners.delete(onChange);
    standalone.removeEventListener("change", onChange);
  };
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, installSnapshot, () => "unavailable");
}

/** Shows the browser's install dialog. An offer can be used once. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null;
  emitInstall();
  await event.prompt();
  return (await event.userChoice).outcome;
}

// ── Push ──

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The worker's registration, registering it first if this page has not yet. */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!(await navigator.serviceWorker.getRegistration("/"))) await registerServiceWorker();
  return navigator.serviceWorker.ready;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

export async function deviceSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Subscribes this device with the server's key (replacing one made with an old key) and stores it for this session. */
export async function subscribeThisDevice(publicKey: string): Promise<void> {
  const registration = await readyRegistration();
  const key = base64UrlToBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/api/push/subscriptions", { method: "POST", body: subscription.toJSON() });
}

/** Stops pushes to this device: the server forgets the endpoint and the browser drops the subscription. */
export async function unsubscribeThisDevice(): Promise<void> {
  const subscription = await deviceSubscription();
  if (!subscription) return;
  await api("/api/push/subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } }).catch(() => undefined);
  await subscription.unsubscribe();
}

/**
 * Signing out removes this device's subscription on the server, but the browser keeps it. When
 * someone signs in again, the existing subscription is tied to the new session; the user's
 * notification preference still decides whether anything is sent.
 */
export async function resyncThisDevice(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const subscription = await deviceSubscription();
  if (subscription) await api("/api/push/subscriptions", { method: "POST", body: subscription.toJSON() });
}

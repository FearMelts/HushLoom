import { OfflineScreen } from "@/components/offline";

export const metadata = { title: "Offline" };

/** The service worker's offline fallback. The root layout renders it bare: no shell, no account data. */
export default function OfflinePage() {
  return <OfflineScreen />;
}

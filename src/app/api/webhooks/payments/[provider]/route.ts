import { route } from "@/server/http";
import { handlePaymentWebhook } from "@/server/payments/webhook";

/** Processors call this. The raw body is verified by the named provider before anything is read from it. */
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, { params }) => handlePaymentWebhook((await params).provider, req));

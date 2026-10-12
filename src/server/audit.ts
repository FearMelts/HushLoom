import { getDb, type Tx } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export async function audit(
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
  tx?: Tx,
) {
  await (tx ?? getDb()).insert(auditLogs).values({ actorId, action, targetType, targetId, metadata });
}

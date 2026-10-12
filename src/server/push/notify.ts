/**
 * Hook point for the installable-web-app track (addendum §4). Sends an opt-in push
 * notification when a generation finishes or fails. Payloads never carry prompts, media or
 * any private detail: only a neutral line and the job id to open.
 */
export async function notifyJobFinished(input: { userId: string; jobId: string; outcome: "completed" | "failed" | "cancelled" }): Promise<void> {
  void input;
}

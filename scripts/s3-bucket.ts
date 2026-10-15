/**
 * Makes sure the bucket named by S3_BUCKET exists on S3_ENDPOINT, creating it when it does not.
 * docker-compose.yml runs it as the "s3-init" one-shot of the "s3" profile, against the bundled
 * MinIO; it works against any S3-compatible service. Retries for about a minute while the service
 * starts. The bucket is created private: the app only ever hands out short-lived presigned URLs.
 *
 *   npx tsx scripts/s3-bucket.ts
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET;
const endpoint = process.env.S3_ENDPOINT;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
if (!bucket || !accessKeyId || !secretAccessKey) {
  console.error("Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (and S3_ENDPOINT for MinIO) in .env first.");
  process.exit(1);
}

// Same client settings as the app's S3 driver (src/server/storage/index.ts).
const client = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  endpoint,
  forcePathStyle: Boolean(endpoint),
  credentials: { accessKeyId, secretAccessKey },
});

const status = (err: unknown) => (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

for (let attempt = 1; ; attempt++) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket ${bucket} is ready.`);
    break;
  } catch (err) {
    if (status(err) === 404) {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`Created bucket ${bucket}.`);
      break;
    }
    // 403 means the keys are wrong (or the bucket belongs to someone else), which waiting will not fix.
    if (status(err) === 403) {
      console.error(`The S3 service refused these keys for bucket ${bucket} (HTTP 403).`);
      process.exit(1);
    }
    if (attempt >= 30) {
      console.error(`Could not reach bucket ${bucket}: ${(err as Error).name} (HTTP ${status(err) ?? "none"}).`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
client.destroy();

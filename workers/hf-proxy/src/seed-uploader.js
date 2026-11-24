// Upload endpoint for scripts/seed_model_mirror.mjs. Every call needs the
// per-run bearer token.
//
//   GET  /head?key=K                          -> {size} | 404
//   PUT  /put?key=K&type=T                    body = whole object
//   POST /mpu/create?key=K&type=T             -> {uploadId}
//   PUT  /mpu/part?key=K&uploadId=U&n=N       body = part -> {partNumber, etag}
//   POST /mpu/complete?key=K&uploadId=U       body = {parts} -> {size}
//   POST /mpu/abort?key=K&uploadId=U

export default {
  async fetch(request, env) {
    const expected = `Bearer ${env.UPLOAD_TOKEN}`;
    if (!env.UPLOAD_TOKEN || request.headers.get("authorization") !== expected) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const type = url.searchParams.get("type") || "application/octet-stream";
    const uploadId = url.searchParams.get("uploadId");
    if (!key) return new Response("missing key", { status: 400 });

    switch (`${request.method} ${url.pathname}`) {
      case "GET /head": {
        const head = await env.MODELS.head(key);
        return head ? Response.json({ size: head.size }) : new Response("missing", { status: 404 });
      }
      case "PUT /put": {
        const object = await env.MODELS.put(key, request.body, { httpMetadata: { contentType: type } });
        return Response.json({ size: object.size });
      }
      case "POST /mpu/create": {
        const upload = await env.MODELS.createMultipartUpload(key, { httpMetadata: { contentType: type } });
        return Response.json({ uploadId: upload.uploadId });
      }
      case "PUT /mpu/part": {
        const upload = env.MODELS.resumeMultipartUpload(key, uploadId);
        return Response.json(await upload.uploadPart(Number(url.searchParams.get("n")), request.body));
      }
      case "POST /mpu/complete": {
        const { parts } = await request.json();
        const object = await env.MODELS.resumeMultipartUpload(key, uploadId).complete(parts);
        return Response.json({ size: object.size });
      }
      case "POST /mpu/abort": {
        await env.MODELS.resumeMultipartUpload(key, uploadId).abort();
        return new Response(null, { status: 204 });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  },
};

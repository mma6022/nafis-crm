/**
 * leadAnnotatorMask (PM 2026-10-27 22:37, REQUIRED): for a user holding lead_annotator, every response under /api has its
 * phones masked — res.json bodies deep (lib/lead-annotator.ts maskPhonesDeep), string / text / JSON / event-stream bodies sent
 * through res.send / res.write / res.end are regex-masked. Binary bodies (files, audio, images) pass unchanged.
 * Mounted in app.ts right after requireApiAuth, so res.locals.authUser is already set.
 */
import type { NextFunction, Request, Response } from "express";
import { maskPhonesDeep, maskPhonesInText } from "./lead-annotator";

const isText = (res: Response) => /^(text\/|application\/(json|.*\+json|javascript|x-ndjson|csv))/i.test(String(res.getHeader("Content-Type") ?? "text/"));

export function leadAnnotatorMask(_req: Request, res: Response, next: NextFunction): void {
  if (!(res.locals.authUser as { leadAnnotator?: boolean } | undefined)?.leadAnnotator) { next(); return; }
  res.setHeader("X-Phone-Masked", "1");
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(maskPhonesDeep(body))) as Response["json"];
  const send = res.send.bind(res);
  res.send = ((body: unknown) => {
    if (typeof body === "string") return send(maskPhonesInText(body));
    if (Buffer.isBuffer(body) && isText(res)) return send(Buffer.from(maskPhonesInText(body.toString("utf8")), "utf8"));
    return send(body as never);
  }) as Response["send"];
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  const fix = (chunk: unknown) => {
    if (typeof chunk === "string") return maskPhonesInText(chunk);
    if (Buffer.isBuffer(chunk) && isText(res)) return Buffer.from(maskPhonesInText(chunk.toString("utf8")), "utf8");
    return chunk;
  };
  res.write = ((chunk: unknown, ...rest: unknown[]) => write(fix(chunk), ...rest)) as Response["write"];
  res.end = ((chunk?: unknown, ...rest: unknown[]) => (chunk === undefined || typeof chunk === "function" ? end(chunk, ...rest) : end(fix(chunk), ...rest))) as Response["end"];
  next();
}

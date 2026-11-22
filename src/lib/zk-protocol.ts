/**
 * Minimal ZKTeco standalone protocol (TCP/UDP port 4370).
 * Read-side only: packet codec, checksum, comm-key scramble, attendance/user record layouts.
 * Never used to encode write/clear/reboot/disable commands.
 */
export const ZK_PORT = 4370;
export const TCP_MAGIC = 0x5050827d;
export const USHRT_MAX = 65535;

export const CMD_CONNECT = 1000;
export const CMD_EXIT = 1001;
export const CMD_ACK_OK = 2000;
export const CMD_ACK_ERROR = 2001;
export const CMD_ACK_DATA = 2002;
export const CMD_ACK_UNAUTH = 2005;
export const CMD_PREPARE_DATA = 1500;
export const CMD_DATA = 1501;
export const CMD_FREE_DATA = 1502;
export const CMD_AUTH = 1102;
export const CMD_VERSION = 1100;
export const CMD_OPTIONS_RRQ = 11;
export const CMD_USERTEMP_RRQ = 9;
export const CMD_ATTLOG_RRQ = 13;
export const CMD_GET_FREE_SIZES = 50;
export const CMD_GET_TIME = 201;

export type ZkHeader = { command: number; checksum: number; sessionId: number; replyId: number; data: Buffer };

export function checksum(buf: Buffer): number {
  let sum = 0;
  let i = 0;
  while (i + 1 < buf.length) {
    sum += buf.readUInt16LE(i);
    i += 2;
  }
  if (i < buf.length) sum += buf[i];
  sum = ((sum >>> 0) % (USHRT_MAX + 1));
  let chk = (~sum) & USHRT_MAX;
  if (chk < 0) chk += USHRT_MAX + 1;
  return chk & USHRT_MAX;
}

export function encodePayload(command: number, sessionId: number, replyId: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(command, 0);
  head.writeUInt16LE(0, 2);
  head.writeUInt16LE(sessionId & USHRT_MAX, 4);
  head.writeUInt16LE(replyId & USHRT_MAX, 6);
  const raw = Buffer.concat([head, data]);
  const chk = checksum(raw);
  raw.writeUInt16LE(chk, 2);
  return raw;
}

export function decodePayload(buf: Buffer): ZkHeader {
  if (buf.length < 8) throw new Error("zk_short_payload");
  return {
    command: buf.readUInt16LE(0),
    checksum: buf.readUInt16LE(2),
    sessionId: buf.readUInt16LE(4),
    replyId: buf.readUInt16LE(6),
    data: buf.subarray(8),
  };
}

export function wrapTcp(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(TCP_MAGIC, 0);
  prefix.writeUInt32LE(payload.length, 4);
  return Buffer.concat([prefix, payload]);
}

/** Feed a TCP byte stream; yield complete payloads. */
export class TcpAssembler {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    while (this.buf.length >= 8) {
      const magic = this.buf.readUInt32LE(0);
      if (magic !== TCP_MAGIC) {
        // resync: drop a byte
        this.buf = this.buf.subarray(1);
        continue;
      }
      const len = this.buf.readUInt32LE(4);
      if (len > 10_000_000) throw new Error("zk_frame_too_large");
      if (this.buf.length < 8 + len) break;
      out.push(this.buf.subarray(8, 8 + len));
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

/** pyzk-compatible comm-key scramble (CMD_AUTH payload). */
export function makeCommKey(key: number, sessionId: number): Buffer {
  let k = 0;
  const keyNum = key >>> 0;
  for (let i = 0; i < 32; i++) {
    k = keyNum & (1 << i) ? (k << 1) | 1 : k << 1;
  }
  k = (k + (sessionId & USHRT_MAX)) >>> 0;
  const raw = Buffer.alloc(4);
  raw.writeUInt32LE(k, 0);
  const xor = Buffer.from("ZKSO", "ascii");
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) out[i] = raw[i] ^ xor[i];
  return out;
}

/** ZK packed datetime used in attendance records. */
export function encodeZkTime(d: Date): number {
  // Interpret the date's UTC fields as the device-local wall clock we want to store.
  return (
    ((d.getUTCFullYear() - 2000) * 12 * 31 +
      (d.getUTCMonth()) * 31 +
      (d.getUTCDate() - 1)) *
      24 * 60 * 60 +
    d.getUTCHours() * 60 * 60 +
    d.getUTCMinutes() * 60 +
    d.getUTCSeconds()
  );
}

export function decodeZkTime(t: number): Date {
  let v = t >>> 0;
  const second = v % 60; v = Math.floor(v / 60);
  const minute = v % 60; v = Math.floor(v / 60);
  const hour = v % 24; v = Math.floor(v / 24);
  const day = (v % 31) + 1; v = Math.floor(v / 31);
  const month = (v % 12) + 1; v = Math.floor(v / 12);
  const year = v + 2000;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

const USER_REC = 72;
const ATT_REC = 40;

export type ZkUser = { uid: number; userId: string; name: string; privilege: number };
export type ZkPunch = { userId: string; punchedAtDevice: Date; status: number; punch: number };

function cString(buf: Buffer): string {
  const z = buf.indexOf(0);
  const slice = z >= 0 ? buf.subarray(0, z) : buf;
  return slice.toString("utf8").replace(/\0/g, "").trim();
}

export function encodeUser(u: ZkUser): Buffer {
  const rec = Buffer.alloc(USER_REC);
  rec.writeUInt16LE(u.uid & 0xffff, 0);
  rec.writeUInt8(u.privilege & 0xff, 2);
  Buffer.from((u.name || "").slice(0, 23), "utf8").copy(rec, 11);
  Buffer.from((u.userId || String(u.uid)).slice(0, 24), "utf8").copy(rec, 48);
  return rec;
}

export function decodeUsers(buf: Buffer): ZkUser[] {
  const out: ZkUser[] = [];
  const recSize = buf.length % USER_REC === 0 && buf.length >= USER_REC ? USER_REC
    : buf.length % 28 === 0 ? 28 : USER_REC;
  for (let off = 0; off + recSize <= buf.length; off += recSize) {
    const rec = buf.subarray(off, off + recSize);
    const uid = rec.readUInt16LE(0);
    const privilege = rec.readUInt8(2);
    const name = recSize >= 35 ? cString(rec.subarray(11, 35)) : "";
    const userId = recSize >= 72 ? cString(rec.subarray(48, 72)) : recSize >= 28 ? String(uid) : String(uid);
    if (!uid && !userId) continue;
    out.push({ uid, userId: userId || String(uid), name, privilege });
  }
  return out;
}

export function encodePunch(p: ZkPunch): Buffer {
  const rec = Buffer.alloc(ATT_REC);
  Buffer.from((p.userId || "").slice(0, 24), "utf8").copy(rec, 0);
  rec.writeUInt32LE(encodeZkTime(p.punchedAtDevice), 24);
  rec.writeUInt8(p.status & 0xff, 28);
  rec.writeUInt8(p.punch & 0xff, 29);
  return rec;
}

export function decodePunches(buf: Buffer): ZkPunch[] {
  const out: ZkPunch[] = [];
  const recSize = buf.length % ATT_REC === 0 && buf.length >= ATT_REC ? ATT_REC
    : buf.length % 16 === 0 ? 16 : ATT_REC;
  for (let off = 0; off + recSize <= buf.length; off += recSize) {
    const rec = buf.subarray(off, off + recSize);
    if (recSize >= 40) {
      const userId = cString(rec.subarray(0, 24));
      if (!userId) continue;
      out.push({
        userId,
        punchedAtDevice: decodeZkTime(rec.readUInt32LE(24)),
        status: rec.readUInt8(28),
        punch: rec.readUInt8(29),
      });
    } else {
      const uid = rec.readUInt16LE(0);
      if (!uid) continue;
      out.push({
        userId: String(uid),
        punchedAtDevice: decodeZkTime(rec.readUInt32LE(4)),
        status: rec[8] ?? 0,
        punch: rec[9] ?? 0,
      });
    }
  }
  return out;
}

export function optionQuery(name: string): Buffer {
  return Buffer.from(`${name}\0`, "ascii");
}

export function parseOptionReply(data: Buffer, name: string): string | null {
  const text = data.toString("utf8").replace(/\0/g, "");
  const prefix = `${name}=`;
  const i = text.indexOf(prefix);
  if (i < 0) return text.trim() || null;
  return text.slice(i + prefix.length).split(/[\r\n]/)[0]?.trim() || null;
}


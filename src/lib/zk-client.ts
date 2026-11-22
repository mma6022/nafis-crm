/**
 * Read-only ZKTeco client (TCP 4370, optional UDP fallback).
 * Allowed commands: connect, auth, version/options, users, attendance, exit.
 * Never sends disable/enable, clear, set-user, reboot, or any write.
 */
import net from "node:net";
import dgram from "node:dgram";
import {
  CMD_ACK_OK, CMD_ACK_UNAUTH, CMD_ATTLOG_RRQ, CMD_AUTH, CMD_CONNECT, CMD_DATA,
  CMD_EXIT, CMD_OPTIONS_RRQ, CMD_PREPARE_DATA, CMD_USERTEMP_RRQ, CMD_VERSION,
  TcpAssembler, USHRT_MAX, ZK_PORT, decodePayload, decodePunches, decodeUsers,
  encodePayload, makeCommKey, optionQuery, parseOptionReply, wrapTcp,
  type ZkPunch, type ZkUser,
} from "./zk-protocol";

export type ZkDeviceInfo = { firmware: string | null; serial: string | null; deviceName: string | null };
export type ZkReadResult = { info: ZkDeviceInfo; users: ZkUser[]; punches: ZkPunch[] };

export type ZkClientOptions = {
  host: string;
  port?: number;
  commKey?: number;
  timeoutMs?: number;
  /** Force UDP (some firmware). Default tries TCP first. */
  udp?: boolean;
};

export class ZkError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || code);
    this.name = "ZkError";
  }
}

const safeCode = (err: unknown): string => {
  const e = err as { code?: string; message?: string };
  if (e?.code === "ECONNREFUSED") return "refused";
  if (e?.code === "ETIMEDOUT" || e?.code === "ETIME") return "timeout";
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "unresolved";
  if (e?.code === "EHOSTUNREACH" || e?.code === "ENETUNREACH") return "unreachable";
  if (err instanceof ZkError) return err.code;
  const m = String(e?.message || e || "error");
  if (/auth/i.test(m)) return "auth_failed";
  if (/timeout/i.test(m)) return "timeout";
  return "protocol";
};

export const zkErrorCode = safeCode;

function nextReply(replyId: number): number {
  const n = replyId + 1;
  return n >= USHRT_MAX ? n - USHRT_MAX : n;
}

class TcpSession {
  private sock: net.Socket;
  private asm = new TcpAssembler();
  private queue: Buffer[] = [];
  private waiters: Array<(b: Buffer) => void> = [];
  sessionId = 0;
  replyId = USHRT_MAX - 1;
  constructor(private timeoutMs: number) {
    this.sock = new net.Socket();
    this.sock.setNoDelay(true);
  }
  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.sock.destroy(); reject(new ZkError("timeout")); }, this.timeoutMs);
      this.sock.once("error", (e) => { clearTimeout(t); reject(e); });
      this.sock.connect(port, host, () => { clearTimeout(t); this.sock.on("error", () => { /* drained in recv */ }); resolve(); });
      this.sock.on("data", (chunk) => {
        try {
          for (const p of this.asm.push(chunk)) {
            const w = this.waiters.shift();
            if (w) w(p);
            else this.queue.push(p);
          }
        } catch (e) { this.sock.destroy(); }
      });
    });
  }
  private recv(): Promise<Buffer> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ZkError("timeout")), this.timeoutMs);
      this.waiters.push((b) => { clearTimeout(t); resolve(b); });
    });
  }
  async request(command: number, data: Buffer = Buffer.alloc(0)) {
    this.replyId = nextReply(this.replyId);
    const payload = encodePayload(command, this.sessionId, this.replyId, data);
    this.sock.write(wrapTcp(payload));
    const raw = await this.recv();
    const hdr = decodePayload(raw);
    if (command === CMD_CONNECT) this.sessionId = hdr.sessionId;
    return hdr;
  }
  async requestData(command: number, data: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    const first = await this.request(command, data);
    if (first.command === CMD_PREPARE_DATA) {
      const size = first.data.length >= 4 ? first.data.readUInt32LE(0) : 0;
      const chunks: Buffer[] = [];
      let got = 0;
      while (got < size) {
        const raw = await this.recv();
        const hdr = decodePayload(raw);
        if (hdr.command !== CMD_DATA && hdr.command !== CMD_ACK_OK) throw new ZkError("protocol", "unexpected_data");
        chunks.push(hdr.data);
        got += hdr.data.length;
        if (hdr.command === CMD_ACK_OK) break;
      }
      return Buffer.concat(chunks).subarray(0, size || undefined);
    }
    if (first.command === CMD_ACK_OK || first.command === CMD_DATA) return first.data;
    throw new ZkError("protocol", `cmd_${first.command}`);
  }
  close() {
    try { this.sock.end(); } catch { /* ignore */ }
    this.sock.destroy();
  }
}

class UdpSession {
  private sock = dgram.createSocket("udp4");
  private queue: Buffer[] = [];
  private waiters: Array<(b: Buffer) => void> = [];
  sessionId = 0;
  replyId = USHRT_MAX - 1;
  constructor(private host: string, private port: number, private timeoutMs: number) {
    this.sock.on("message", (msg) => {
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
  }
  async bind(): Promise<void> {
    await new Promise<void>((resolve) => this.sock.bind(0, "0.0.0.0", () => resolve()));
  }
  private recv(): Promise<Buffer> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ZkError("timeout")), this.timeoutMs);
      this.waiters.push((b) => { clearTimeout(t); resolve(b); });
    });
  }
  async request(command: number, data: Buffer = Buffer.alloc(0)) {
    this.replyId = nextReply(this.replyId);
    const payload = encodePayload(command, this.sessionId, this.replyId, data);
    await new Promise<void>((resolve, reject) => this.sock.send(payload, this.port, this.host, (e) => e ? reject(e) : resolve()));
    const raw = await this.recv();
    const hdr = decodePayload(raw);
    if (command === CMD_CONNECT) this.sessionId = hdr.sessionId;
    return hdr;
  }
  async requestData(command: number, data: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    const first = await this.request(command, data);
    if (first.command === CMD_PREPARE_DATA) {
      const size = first.data.length >= 4 ? first.data.readUInt32LE(0) : 0;
      const chunks: Buffer[] = [];
      let got = 0;
      while (got < size) {
        const raw = await this.recv();
        const hdr = decodePayload(raw);
        chunks.push(hdr.data);
        got += hdr.data.length;
        if (hdr.command === CMD_ACK_OK) break;
      }
      return Buffer.concat(chunks).subarray(0, size || undefined);
    }
    if (first.command === CMD_ACK_OK || first.command === CMD_DATA) return first.data;
    throw new ZkError("protocol", `cmd_${first.command}`);
  }
  close() { try { this.sock.close(); } catch { /* ignore */ } }
}

type Session = {
  request: (command: number, data?: Buffer) => Promise<ReturnType<typeof decodePayload>>;
  requestData: (command: number, data?: Buffer) => Promise<Buffer>;
  close: () => void;
  sessionId: number;
};

async function handshake(session: Session, commKey: number): Promise<void> {
  const hello = await session.request(CMD_CONNECT);
  if (hello.command === CMD_ACK_UNAUTH || commKey) {
    const auth = await session.request(CMD_AUTH, makeCommKey(commKey, session.sessionId));
    if (auth.command !== CMD_ACK_OK) throw new ZkError("auth_failed");
  } else if (hello.command !== CMD_ACK_OK) {
    throw new ZkError("protocol", `connect_${hello.command}`);
  }
}

async function readWith(session: Session): Promise<ZkReadResult> {
  let firmware: string | null = null;
  let serial: string | null = null;
  let deviceName: string | null = null;
  try {
    const ver = await session.request(CMD_VERSION);
    if (ver.command === CMD_ACK_OK) firmware = ver.data.toString("utf8").replace(/\0/g, "").trim() || null;
  } catch { /* optional */ }
  try {
    const sn = await session.request(CMD_OPTIONS_RRQ, optionQuery("~SerialNumber"));
    if (sn.command === CMD_ACK_OK) serial = parseOptionReply(sn.data, "~SerialNumber");
  } catch { /* optional */ }
  try {
    const dn = await session.request(CMD_OPTIONS_RRQ, optionQuery("~DeviceName"));
    if (dn.command === CMD_ACK_OK) deviceName = parseOptionReply(dn.data, "~DeviceName");
  } catch { /* optional */ }
  let users: ZkUser[] = [];
  let punches: ZkPunch[] = [];
  try { users = decodeUsers(await session.requestData(CMD_USERTEMP_RRQ)); } catch { /* empty */ }
  try { punches = decodePunches(await session.requestData(CMD_ATTLOG_RRQ)); } catch { /* empty */ }
  try { await session.request(CMD_EXIT); } catch { /* ignore */ }
  return { info: { firmware, serial, deviceName }, users, punches };
}

export async function zkRead(opts: ZkClientOptions): Promise<ZkReadResult> {
  const host = String(opts.host || "").trim();
  const port = Number(opts.port || ZK_PORT);
  const commKey = Number(opts.commKey || 0) || 0;
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs || 8000));
  if (!host) throw new ZkError("bad_host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ZkError("bad_port");
  const tryUdp = async () => {
    const s = new UdpSession(host, port, timeoutMs);
    await s.bind();
    try { await handshake(s, commKey); return await readWith(s); }
    finally { s.close(); }
  };
  const tryTcp = async () => {
    const s = new TcpSession(timeoutMs);
    await s.connect(host, port);
    try { await handshake(s, commKey); return await readWith(s); }
    finally { s.close(); }
  };
  if (opts.udp) return tryUdp();
  try {
    return await tryTcp();
  } catch (e) {
    const code = safeCode(e);
    if (code === "refused" || code === "timeout" || code === "protocol") {
      try { return await tryUdp(); } catch (e2) { throw new ZkError(safeCode(e2), e2 instanceof Error ? e2.message : undefined); }
    }
    throw new ZkError(code, e instanceof Error ? e.message : undefined);
  }
}
